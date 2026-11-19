import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Models } from "@earendil-works/pi-ai";
import { isAndroidNotificationDecision, isProtectedAndroidNotification,
  type AndroidNotificationClassification, type AndroidNotificationClassificationResult, type AndroidNotificationDecision } from "@moco/protocol";
import { NOTIFICATION_CLASSIFIER_INSTRUCTIONS } from "./prompts.js";

const INSTRUCTIONS = NOTIFICATION_CLASSIFIER_INSTRUCTIONS;

interface CachedDecision { inputHash: string; at: number; decision: AndroidNotificationDecision }
interface NotificationClassifierHost {
  stateDir: string;
  models: Models;
  agent(): { model: { provider: string; modelId: string } };
  hubId(): string;
  redact(text: string): string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function androidNotificationDecisionId(request: Pick<AndroidNotificationClassification, "hubId" | "deviceId" | "ruleRevision" | "notificationId" | "notificationVersion">): string {
  return "notification-" + createHash("sha256").update([request.hubId, request.deviceId, String(request.ruleRevision), request.notificationId, request.notificationVersion].join("\0")).digest("hex");
}

export function parseAndroidNotificationDecision(raw: string, defaultRule: boolean): AndroidNotificationDecision {
  if (raw.length > 16_384) throw new Error("notification_model_invalid_output");
  let parsed: unknown;
  try { parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
  catch { throw new Error("notification_model_invalid_output"); }
  if (!isAndroidNotificationDecision(parsed) || defaultRule && !(parsed.action === "retain" || parsed.action === "clear" && parsed.advertisement === true)) throw new Error("notification_model_invalid_output");
  return parsed;
}

/** Uses the Hub's existing Pi provider registry and credential flow; no tools or phone-side model credentials. */
export class MocoAndroidNotifications {
  readonly #host: NotificationClassifierHost;
  readonly #file: string;
  readonly #cache = new Map<string, CachedDecision>();
  readonly #pending = new Map<string, { inputHash: string; result: Promise<AndroidNotificationDecision> }>();
  readonly #rate = new Map<string, number[]>();
  readonly #controllers = new Set<AbortController>();
  #closed = false;
  #storageError = false;

  constructor(host: NotificationClassifierHost) {
    this.#host = host;
    this.#file = path.join(host.stateDir, "android-notification-decisions.json");
    try { if (fs.existsSync(this.#file)) {
      const bytes = fs.readFileSync(this.#file); if (bytes.length > 4 * 1024 * 1024) throw new Error("notification_cache_invalid");
      const saved: unknown = JSON.parse(bytes.toString("utf8"));
      if (!saved || typeof saved !== "object" || !("version" in saved) || saved.version !== 1 || !("items" in saved) || !Array.isArray(saved.items) || saved.items.length > 1024) throw new Error("notification_cache_invalid");
      for (const item of saved.items) {
        if (!item || typeof item.id !== "string" || !/^notification-[a-f0-9]{64}$/.test(item.id) || typeof item.inputHash !== "string" || !/^[a-f0-9]{64}$/.test(item.inputHash) ||
          !Number.isSafeInteger(item.at) || !isAndroidNotificationDecision(item.decision)) throw new Error("notification_cache_invalid");
        if (Date.now() - item.at < 7 * 86400_000) this.#cache.set(item.id, { inputHash: item.inputHash, at: item.at, decision: item.decision });
      }
    } } catch { this.#cache.clear(); this.#storageError = true; }
  }

  async classify(request: AndroidNotificationClassification, signal: AbortSignal): Promise<AndroidNotificationClassificationResult> {
    const { ruleText: _rules, defaultRule: _default, notification: _item, ...identity } = request;
    const decisionId = androidNotificationDecisionId(request);
    const response = (data: Pick<AndroidNotificationClassificationResult, "decision" | "error">) => ({ ...identity, decisionId, ...data });
    if (this.#closed || request.hubId !== this.#host.hubId()) return response({ error: "notification_hub_unavailable" });
    if (isProtectedAndroidNotification(request.notification)) return response({ decision: { action: "retain" } });
    if (this.#storageError) return response({ error: "notification_storage_unavailable" });
    const inputHash = createHash("sha256").update(canonical({ ruleText: request.ruleText, defaultRule: request.defaultRule, notification: request.notification })).digest("hex");
    let cached = this.#cache.get(decisionId);
    if (cached && Date.now() - cached.at >= 7 * 86400_000) { this.#cache.delete(decisionId); cached = undefined; }
    if (cached) return cached.inputHash === inputHash ? response({ decision: cached.decision }) : response({ error: "notification_intent_conflict" });
    const now = Date.now();
    const rate = (this.#rate.get(request.deviceId) ?? []).filter(at => now - at < 60_000);
    try {
      let pending = this.#pending.get(decisionId);
      if (pending && pending.inputHash !== inputHash) return response({ error: "notification_intent_conflict" });
      if (!pending) {
        if (rate.length >= 20 || this.#controllers.size >= 4) return response({ error: "notification_rate_limited" });
        if (this.#rate.size >= 256 && !this.#rate.has(request.deviceId)) this.#rate.delete(this.#rate.keys().next().value!);
        this.#rate.set(request.deviceId, rate);
        rate.push(now);
        const result = this.#generate(request, signal).then(decision => {
          this.#cache.set(decisionId, { inputHash, at: Date.now(), decision });
          while (this.#cache.size > 1024) this.#cache.delete(this.#cache.keys().next().value!);
          try { this.#save(); } catch (failure) { this.#cache.delete(decisionId); throw failure; }
          return decision;
        }).finally(() => this.#pending.delete(decisionId));
        pending = { inputHash, result };
        this.#pending.set(decisionId, pending);
      }
      const decision = await pending.result;
      if (signal.aborted) return response({ error: "notification_cancelled" });
      return response({ decision });
    } catch (failure) {
      const code = failure instanceof Error && ["notification_model_required", "notification_model_invalid_output", "notification_model_timeout", "notification_cancelled"].includes(failure.message)
        ? failure.message : "notification_model_unavailable";
      return response({ error: code });
    }
  }

  async #generate(request: AndroidNotificationClassification, signal: AbortSignal): Promise<AndroidNotificationDecision> {
    const controller = new AbortController(); this.#controllers.add(controller);
    const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, 18_000); timer.unref();
    let physicalStarted = false;
    try {
      const selected = this.#host.agent().model;
      const model = this.#host.models.getModel(selected.provider, selected.modelId);
      if (!model) throw new Error("notification_model_required");
      const completion = this.#host.models.completeSimple(model, { messages: [
        { role: "system", content: INSTRUCTIONS, timestamp: Date.now() },
        { role: "user", content: this.#host.redact(JSON.stringify({ userRules: request.ruleText, defaultRule: request.defaultRule, untrustedNotification: request.notification })), timestamp: Date.now() },
      ] }, { signal: controller.signal, maxTokens: Math.min(1500, model.maxTokens || 1500), cacheRetention: "none" });
      physicalStarted = true;
      void completion.finally(() => this.#controllers.delete(controller)).catch(() => {});
      const aborted = new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => reject(new Error(signal.aborted ? "notification_cancelled" : "notification_model_timeout"));
        if (controller.signal.aborted) rejectAbort();
        else controller.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      const message = await Promise.race([completion, aborted]);
      if (controller.signal.aborted) throw new Error(signal.aborted ? "notification_cancelled" : "notification_model_timeout");
      if (message.stopReason !== "stop" || message.content.some(part => part.type === "toolCall")) throw new Error("notification_model_unavailable");
      return parseAndroidNotificationDecision(this.#host.redact(message.content.filter(part => part.type === "text").map(part => part.text).join("\n")), request.defaultRule);
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); if (!physicalStarted) this.#controllers.delete(controller); }
  }

  #save(): void {
    const temporary = `${this.#file}.tmp`;
    for (const [id, item] of this.#cache) if (Date.now() - item.at >= 7 * 86400_000) this.#cache.delete(id);
    let bytes = JSON.stringify({ version: 1, items: [...this.#cache].map(([id, item]) => ({ id, ...item })) });
    while (Buffer.byteLength(bytes) > 4 * 1024 * 1024) {
      this.#cache.delete(this.#cache.keys().next().value!);
      bytes = JSON.stringify({ version: 1, items: [...this.#cache].map(([id, item]) => ({ id, ...item })) });
    }
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(temporary, bytes, { mode: 0o600 });
      fs.renameSync(temporary, this.#file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  close(): void { this.#closed = true; for (const controller of this.#controllers) controller.abort(); }
}
