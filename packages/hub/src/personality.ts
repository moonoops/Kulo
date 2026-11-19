import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import type {
  IdentityRead, IdentitySaved, IdentityVersion, IdentityProposal, PersonalitySettings,
  PersonalitySnapshot, RelationshipRollbackRequest, RelationshipUpdateSettings,
  RelationshipUpdateStatus, RelationshipWriteRequest,
} from "@kulo/protocol";
import { IDENTITY_AGREEMENT_FILE, IdentityFilesError, KuloIdentityFiles } from "./identity-files.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const DAY_MS = 86_400_000;
const DEFER_MS = 15 * 60_000;
export const defaultPersonalitySettings = (): PersonalitySettings => ({
  relationshipUpdate: { enabled: false, intervalDays: 1 },
  recentWorkEnabled: true,
});
const emptyStatus = (): RelationshipUpdateStatus => ({
  lastCheckedAt: null, lastUpdatedAt: null, nextRunAt: null, lastResult: "never",
});

interface PendingRelationshipUpdate {
  id: string;
  expected: IdentityVersion;
  content: string;
  summary: string;
  cursor: number;
  checkedAt: number;
  settingsRevision: number;
}
export interface PersonalityState {
  revision: number;
  settings: PersonalitySettings;
  relationshipStatus: RelationshipUpdateStatus;
  sourceCursor: number;
  identityProposal: IdentityProposal | null;
  pendingUpdate: PendingRelationshipUpdate | null;
}
export const PersonalityDoc = defineDoc<PersonalityState & JsonObject>({
  kind: "kulo.personality", version: 1, scope: "session",
  initial: () => ({
    revision: 1, settings: defaultPersonalitySettings(), relationshipStatus: emptyStatus(),
    sourceCursor: 0, identityProposal: null, pendingUpdate: null,
  }) as PersonalityState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 16,
});

export class PersonalityError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message); this.name = "PersonalityError";
  }
}
function invalid(message: string): never { throw new PersonalityError(400, "invalid_personality", message); }
function text(value: unknown, label: string, byteLimit: number): string {
  if (typeof value !== "string" || value.includes("\0") ||
    Buffer.from(value, "utf8").toString("utf8") !== value || Buffer.byteLength(value, "utf8") > byteLimit) {
    invalid(`${label}无效或超出长度限制。`);
  }
  return value;
}
function settings(value: unknown): PersonalitySettings {
  if (!value || typeof value !== "object") invalid("个性设置无效。");
  const obj = value as Record<string, unknown>;
  const raw = obj.relationshipUpdate;
  if (!raw || typeof raw !== "object" || typeof obj.recentWorkEnabled !== "boolean") invalid("个性设置无效。");
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== "boolean" || typeof r.intervalDays !== "number" ||
    !Number.isInteger(r.intervalDays) || r.intervalDays < 1 || r.intervalDays > 365) invalid("请设置有效的更新间隔。");
  return {
    relationshipUpdate: { enabled: r.enabled, intervalDays: r.intervalDays },
    recentWorkEnabled: obj.recentWorkEnabled,
  };
}

export function nextRelationshipRun(after: number, schedule: RelationshipUpdateSettings): number {
  return after + schedule.intervalDays * DAY_MS;
}

export interface KuloPersonalityOptions {
  harness: Harness;
  identityFiles: KuloIdentityFiles;
  now?: () => number;
  canReviewRelationship?: () => Promise<boolean>;
  collectRelationshipInput: (since: number) => Promise<{ cursor: number; content: string }>;
  reviewRelationship: (input: { current: string; updates: string; signal: AbortSignal }) => Promise<{ content: string | null; summary?: string; defer?: boolean }>;
  onChanged?: () => void | Promise<void>;
  onError?: (error: unknown) => void;
}

export class KuloPersonality {
  readonly #options: KuloPersonalityOptions;
  readonly #abort = new AbortController();
  #timer: ReturnType<typeof setInterval> | undefined;
  #active: Promise<PersonalitySnapshot> | undefined;
  #mutations: Promise<unknown> = Promise.resolve();
  #closed = false;
  constructor(options: KuloPersonalityOptions) { this.#options = options; }
  #now() { return this.#options.now?.() ?? Date.now(); }
  async #state(): Promise<PersonalityState> {
    const state = await this.#options.harness.snapshot(PersonalityDoc, BACKGROUND_CONTEXT);
    if (!state) return clone(PersonalityDoc.definition.initial());
    const legacy = state.settings.relationshipUpdate as unknown as Record<string, unknown>;
    if (Object.hasOwn(legacy, "time") || Object.hasOwn(legacy, "timeZone")) {
      await this.#options.harness.commit(async (tx) => {
        const current = await tx.doc(PersonalityDoc);
        const oldSchedule = current.settings.relationshipUpdate as unknown as Record<string, unknown>;
        if (!Object.hasOwn(oldSchedule, "time") && !Object.hasOwn(oldSchedule, "timeZone")) return;
        const previousRevision = current.revision;
        const next = settings(current.settings);
        const status = current.relationshipStatus;
        current.settings = next;
        current.revision++;
        if (current.pendingUpdate?.settingsRevision === previousRevision) current.pendingUpdate.settingsRevision = current.revision;
        // Unknown first-enable times start a fresh elapsed interval; overdue checks remain eligible.
        status.nextRunAt = !next.relationshipUpdate.enabled ? null
          : status.lastCheckedAt !== null ? nextRelationshipRun(status.lastCheckedAt, next.relationshipUpdate)
          : status.nextRunAt !== null && status.nextRunAt <= this.#now() ? status.nextRunAt
          : nextRelationshipRun(this.#now(), next.relationshipUpdate);
      }, BACKGROUND_CONTEXT);
      return clone((await this.#options.harness.snapshot(PersonalityDoc, BACKGROUND_CONTEXT))!);
    }
    return clone(state);
  }
  async #ready(): Promise<boolean> {
    if (this.#closed) return false;
    const ready = await this.#options.canReviewRelationship?.() ?? true;
    return !this.#closed && ready;
  }
  async snapshot(): Promise<PersonalitySnapshot> {
    let state = await this.#state();
    const proposal = state.identityProposal;
    if (proposal) {
      const canonical = await this.#options.identityFiles.read(IDENTITY_AGREEMENT_FILE);
      if (canonical.exists && canonical.content === proposal.content) {
        await this.#options.harness.commit(async (tx) => {
          const latest = await tx.doc(PersonalityDoc);
          if (latest.identityProposal?.id === proposal.id) latest.identityProposal = null;
        }, BACKGROUND_CONTEXT);
        state = await this.#state();
      }
    }
    return {
      revision: state.revision, settings: state.settings,
      relationshipStatus: state.relationshipStatus, identityProposal: state.identityProposal,
    };
  }
  async #changed(): Promise<void> { await this.#options.onChanged?.(); }
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutations.then(operation);
    this.#mutations = result.catch(() => {});
    return result;
  }

  async start(): Promise<void> {
    if (this.#closed || this.#timer) return;
    await this.#options.harness.commit(async (tx) => { await tx.doc(PersonalityDoc); }, BACKGROUND_CONTEXT);
    const tick = () => { void this.checkRelationship().catch((error) => {
      if (this.#options.onError) this.#options.onError(error);
      else console.error("Kulo 协作关系更新未完成。", error);
    }); };
    this.#timer = setInterval(tick, 30_000);
    this.#timer.unref();
    tick();
  }
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#abort.abort();
    await this.#active;
    await this.#mutations;
  }

  async updateSettings(expectedRevision: number, value: unknown): Promise<PersonalitySnapshot> {
    const next = settings(value);
    return this.#serialize(async () => {
      await this.#options.harness.commit(async (tx) => {
        const state = await tx.doc(PersonalityDoc);
        if (expectedRevision !== state.revision) throw new PersonalityError(409, "personality_conflict", "个性设置已更新，当前草稿已保留。");
        if (JSON.stringify(state.settings) === JSON.stringify(next)) return;
        const scheduleChanged = JSON.stringify(state.settings.relationshipUpdate) !== JSON.stringify(next.relationshipUpdate);
        state.settings = clone(next);
        state.revision++;
        state.pendingUpdate = null;
        if (scheduleChanged) {
          state.relationshipStatus.nextRunAt = next.relationshipUpdate.enabled ? nextRelationshipRun(this.#now(), next.relationshipUpdate) : null;
        }
      }, BACKGROUND_CONTEXT);
      await this.#changed();
      return this.snapshot();
    });
  }

  async readIdentity(): Promise<IdentityRead> {
    return this.#options.identityFiles.read(IDENTITY_AGREEMENT_FILE);
  }

  async context(): Promise<{ identityAgreement: string; relationship: string; recentWorkEnabled: boolean }> {
    const [identity, relationship, state] = await Promise.all([
      this.readIdentity(), this.#options.identityFiles.read("relationship.md"), this.#state(),
    ]);
    return { identityAgreement: identity.content, relationship: relationship.content, recentWorkEnabled: state.settings.recentWorkEnabled };
  }

  async proposeIdentity(content: string, summary: string): Promise<IdentityProposal> {
    content = text(content, "身份约定", 64 * 1024);
    summary = text(summary, "修改说明", 2_000).trim();
    if (!summary || [...summary].length > 500) invalid("修改说明不能为空且不超过 500 字。");
    const current = await this.readIdentity();
    const proposal: IdentityProposal = { id: randomUUID(), content, summary, expected: current.version };
    await this.#options.harness.commit(async (tx) => { (await tx.doc(PersonalityDoc)).identityProposal = proposal; }, BACKGROUND_CONTEXT);
    await this.#changed();
    return proposal;
  }
  async dismissIdentityProposal(id: string): Promise<PersonalitySnapshot> {
    await this.#options.harness.commit(async (tx) => {
      const state = await tx.doc(PersonalityDoc);
      if (state.identityProposal && state.identityProposal.id !== id) {
        throw new PersonalityError(409, "personality_conflict", "身份修改建议已更新，请重新加载。");
      }
      state.identityProposal = null;
    }, BACKGROUND_CONTEXT);
    await this.#changed();
    return this.snapshot();
  }

  async saveRelationship(request: RelationshipWriteRequest): Promise<IdentitySaved> {
    return this.#serialize(async () => {
      const saved = await this.#options.identityFiles.saveRelationship(request);
      if (!saved.unchanged) await this.#options.harness.commit(async (tx) => {
        const state = await tx.doc(PersonalityDoc);
        state.relationshipStatus.lastUpdatedAt = this.#now();
      }, BACKGROUND_CONTEXT);
      await this.#changed();
      return saved;
    });
  }
  async rollbackRelationship(request: RelationshipRollbackRequest): Promise<IdentitySaved> {
    return this.#serialize(async () => {
      const saved = await this.#options.identityFiles.rollbackRelationship(request);
      if (!saved.unchanged) await this.#options.harness.commit(async (tx) => {
        (await tx.doc(PersonalityDoc)).relationshipStatus.lastUpdatedAt = this.#now();
      }, BACKGROUND_CONTEXT);
      await this.#changed();
      return saved;
    });
  }

  checkRelationship(options: { force?: boolean } = {}): Promise<PersonalitySnapshot> {
    if (this.#active) return this.#active;
    this.#active = this.#check(options.force === true).finally(() => { this.#active = undefined; });
    return this.#active;
  }
  async #check(force: boolean): Promise<PersonalitySnapshot> {
    const state = await this.#state();
    if (this.#closed || (!force && !state.settings.relationshipUpdate.enabled)) return this.snapshot();
    if (!force && !state.pendingUpdate && (state.relationshipStatus.nextRunAt === null || state.relationshipStatus.nextRunAt > this.#now())) return this.snapshot();
    const checkedAt = this.#now();
    try {
      if (!await this.#ready()) return this.snapshot();
      if (state.pendingUpdate) return this.#applyPending(state.pendingUpdate);
      const current = await this.#options.identityFiles.read("relationship.md");
      const input = await this.#options.collectRelationshipInput(state.sourceCursor);
      if (!Number.isFinite(input.cursor) || input.cursor < state.sourceCursor || typeof input.content !== "string") {
        throw new PersonalityError(503, "invalid_relationship_input", "协作关系更新来源无效。");
      }
      if (!await this.#ready()) return this.#defer(state.revision);
      if (!input.content.trim()) return this.#finish(state.revision, "skipped", checkedAt, input.cursor);
      const decision = await this.#options.reviewRelationship({ current: current.content, updates: input.content, signal: this.#abort.signal });
      if (this.#closed) return this.snapshot();
      if (decision.defer || !await this.#ready()) return this.#defer(state.revision);
      if (decision.content === null || decision.content.trim() === current.content.trim()) {
        return this.#finish(state.revision, "unchanged", checkedAt, input.cursor);
      }
      const pending: PendingRelationshipUpdate = {
        id: randomUUID(), expected: current.version, content: text(decision.content, "协作关系", 64 * 1024),
        summary: text(decision.summary || "定期整理协作关系", "修改说明", 2_000).trim(),
        cursor: input.cursor, checkedAt, settingsRevision: state.revision,
      };
      let accepted = false;
      await this.#options.harness.commit(async (tx) => {
        const latest = await tx.doc(PersonalityDoc);
        if (latest.revision !== state.revision) return;
        latest.pendingUpdate = pending;
        accepted = true;
      }, BACKGROUND_CONTEXT);
      if (!accepted) return this.snapshot();
      return this.#applyPending(pending);
    } catch (error) {
      if (this.#closed) return this.snapshot();
      return this.#finish(state.revision, "error", checkedAt, undefined,
        error instanceof Error ? error.message : "协作关系更新失败。");
    }
  }
  async #applyPending(pending: PendingRelationshipUpdate): Promise<PersonalitySnapshot> {
    return this.#serialize(() => this.#commitPending(pending));
  }
  async #commitPending(pending: PendingRelationshipUpdate): Promise<PersonalitySnapshot> {
    if (this.#closed) return this.snapshot();
    const state = await this.#state();
    if (state.pendingUpdate?.id !== pending.id) return this.snapshot();
    if (state.revision !== pending.settingsRevision) {
      await this.#options.harness.commit(async (tx) => {
        const latest = await tx.doc(PersonalityDoc);
        if (latest.pendingUpdate?.id === pending.id && latest.revision !== pending.settingsRevision) latest.pendingUpdate = null;
      }, BACKGROUND_CONTEXT);
      return this.snapshot();
    }
    try {
      if (!await this.#ready()) return this.#defer(pending.settingsRevision, pending.id);
      const current = await this.#options.identityFiles.read("relationship.md");
      if (current.content === pending.content && current.exists) {
        // Recover a file commit completed before the durable status commit.
        return this.#finish(pending.settingsRevision, "updated", pending.checkedAt, pending.cursor, undefined, pending.id);
      }
      if (!await this.#ready()) return this.#defer(pending.settingsRevision, pending.id);
      await this.#options.identityFiles.saveRelationship({ expected: pending.expected, content: pending.content, summary: pending.summary });
      return this.#finish(pending.settingsRevision, "updated", pending.checkedAt, pending.cursor, undefined, pending.id);
    } catch (error) {
      const conflict = error instanceof IdentityFilesError && error.status === 409;
      return this.#finish(pending.settingsRevision, conflict ? "skipped" : "error", pending.checkedAt, undefined,
        conflict ? "用户已修改协作关系，本次自动更新已跳过。" : error instanceof Error ? error.message : "协作关系更新失败。", pending.id);
    }
  }
  async #defer(revision: number, pendingId?: string): Promise<PersonalitySnapshot> {
    if (this.#closed) return this.snapshot();
    await this.#options.harness.commit(async (tx) => {
      if (this.#closed) return;
      const state = await tx.doc(PersonalityDoc);
      if (state.revision !== revision || (pendingId && state.pendingUpdate?.id !== pendingId)) return;
      state.pendingUpdate = null;
      state.relationshipStatus.nextRunAt = state.settings.relationshipUpdate.enabled ? this.#now() + DEFER_MS : null;
    }, BACKGROUND_CONTEXT);
    await this.#changed();
    return this.snapshot();
  }
  async #finish(revision: number, result: RelationshipUpdateStatus["lastResult"], at: number,
    cursor?: number, error?: string, pendingId?: string): Promise<PersonalitySnapshot> {
    await this.#options.harness.commit(async (tx) => {
      const state = await tx.doc(PersonalityDoc);
      if (state.revision !== revision || (pendingId && state.pendingUpdate?.id !== pendingId)) return;
      state.relationshipStatus.lastCheckedAt = at;
      state.relationshipStatus.lastResult = result;
      if (error) state.relationshipStatus.lastError = error;
      else delete state.relationshipStatus.lastError;
      if (result === "updated") state.relationshipStatus.lastUpdatedAt = at;
      if (cursor !== undefined) state.sourceCursor = cursor;
      state.relationshipStatus.nextRunAt = state.settings.relationshipUpdate.enabled ? nextRelationshipRun(this.#now(), state.settings.relationshipUpdate) : null;
      state.pendingUpdate = null;
    }, BACKGROUND_CONTEXT);
    await this.#changed();
    return this.snapshot();
  }
}
