import { createHash } from "node:crypto";
import {
  EXTERNAL_AGENT_QUOTA_CAPABILITY,
  deriveConnectedExternalClients,
  externalClientConnectionId,
  externalClientDisplayName,
  isQuotaSupportedExternalAgentKind,
  type EnvNodeDescriptor,
  type ExternalAgentBinding,
  type ExternalAgentQuotaProbeResult,
  type ExternalAgentResponse,
  type ExternalClientConnection,
  type ExternalClientQuotaItem,
  type ExternalClientQuotasView,
  type RolePreset,
} from "@kulo/protocol";
import { isValidQuotaProbeResult, mergeQuotaProbeResults, sanitizeQuotaError } from "@kulo/env";

export const QUOTA_SOFT_TTL_MS = 120_000;
export const QUOTA_MIN_FORCE_COOLDOWN_MS = 15_000;
export const QUOTA_QUICK_RETRY_COOLDOWN_MS = 3_000;
export const QUOTA_AUTO_FAILURE_BACKOFF_MS = 30_000;
export const QUOTA_MAX_GLOBAL_CONCURRENCY = 3;
export const QUOTA_PROBE_TIMEOUT_MS = 15_000;

interface CachedQuotaEntry {
  bindingFingerprint: string;
  lastOk?: ExternalAgentQuotaProbeResult;
  lastAttemptAt?: number;
  lastAttemptWasForce?: boolean;
  lastError?: { at: number; message: string };
}

export interface ExternalAgentQuotaServiceOptions {
  getClients: () => ExternalClientConnection[];
  getEnvDescriptor: (envId: string) => EnvNodeDescriptor | undefined;
  getEnvConnectionState?: (envId: string) => "online" | "reconnecting" | "offline";
  requestQuota: (envId: string, binding: ExternalAgentBinding, signal: AbortSignal) => Promise<ExternalAgentResponse>;
  redact?: (value: string) => string;
  now?: () => number;
  softTtlMs?: number;
  minForceCooldownMs?: number;
  quickRetryCooldownMs?: number;
  autoFailureBackoffMs?: number;
  maxConcurrency?: number;
  probeTimeoutMs?: number;
}

export function bindingFromClientConnection(client: ExternalClientConnection): ExternalAgentBinding {
  return {
    kind: client.kind,
    envId: client.envId,
    ...(client.executable ? { executable: client.executable } : {}),
    ...(client.kind === "acp" && client.acpArgs?.length ? { acpArgs: [...client.acpArgs] } : {}),
    ...(client.agentRef ? { agentRef: client.agentRef } : {}),
    ...(client.cdpUrl ? { cdpUrl: client.cdpUrl } : {}),
    ...(client.experimental !== undefined ? { experimental: client.experimental } : {}),
    ...(client.version ? { version: client.version } : {}),
    ...(client.verifiedAt !== undefined ? { verifiedAt: client.verifiedAt } : {}),
    ...(client.capabilities ? { capabilities: { ...client.capabilities } } : {}),
  };
}

export function computeQuotaBindingFingerprint(
  binding: Pick<ExternalAgentBinding, "kind" | "envId" | "executable" | "agentRef" | "acpArgs" | "cdpUrl">,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      kind: binding.kind,
      envId: binding.envId,
      executable: binding.executable ?? "",
      agentRef: binding.agentRef ?? "",
      acpArgs: binding.acpArgs ?? [],
      cdpUrl: binding.cdpUrl ?? "",
    }))
    .digest("hex");
}

export class ExternalAgentQuotaService {
  readonly #options: ExternalAgentQuotaServiceOptions;
  readonly #cache = new Map<string, CachedQuotaEntry>();
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #envChains = new Map<string, Promise<void>>();
  readonly #serviceAbort = new AbortController();
  #activeGlobalCount = 0;
  readonly #globalWaiters: Array<() => void> = [];

  readonly #softTtlMs: number;
  readonly #minForceCooldownMs: number;
  readonly #quickRetryCooldownMs: number;
  readonly #autoFailureBackoffMs: number;
  readonly #maxConcurrency: number;
  readonly #probeTimeoutMs: number;

  constructor(options: ExternalAgentQuotaServiceOptions) {
    this.#options = options;
    this.#softTtlMs = options.softTtlMs ?? QUOTA_SOFT_TTL_MS;
    this.#minForceCooldownMs = options.minForceCooldownMs ?? QUOTA_MIN_FORCE_COOLDOWN_MS;
    this.#quickRetryCooldownMs = options.quickRetryCooldownMs ?? QUOTA_QUICK_RETRY_COOLDOWN_MS;
    this.#autoFailureBackoffMs = options.autoFailureBackoffMs ?? QUOTA_AUTO_FAILURE_BACKOFF_MS;
    this.#maxConcurrency = Math.max(1, options.maxConcurrency ?? QUOTA_MAX_GLOBAL_CONCURRENCY);
    this.#probeTimeoutMs = options.probeTimeoutMs ?? QUOTA_PROBE_TIMEOUT_MS;
  }

  #now(): number {
    return this.#options.now ? this.#options.now() : Date.now();
  }

  #isEnvOnline(envId: string): { env?: EnvNodeDescriptor; online: boolean; capable: boolean } {
    const env = this.#options.getEnvDescriptor(envId);
    const connState = this.#options.getEnvConnectionState?.(envId);
    const online = Boolean(env?.online && connState !== "reconnecting");
    const capable = Boolean(env?.capabilities.includes(EXTERNAL_AGENT_QUOTA_CAPABILITY));
    return { env, online, capable };
  }

  reconcileClients(clients: readonly ExternalClientConnection[]): void {
    const activeIds = new Set<string>();
    for (const client of clients) {
      activeIds.add(client.id);
      const fp = computeQuotaBindingFingerprint(client);
      const existing = this.#cache.get(client.id);
      if (existing && existing.bindingFingerprint !== fp) {
        this.#cache.delete(client.id);
      }
    }
    for (const cachedId of [...this.#cache.keys()]) {
      if (!activeIds.has(cachedId)) {
        this.#cache.delete(cachedId);
      }
    }
  }

  reconcileFromSettings(
    roles: Readonly<Record<string, RolePreset>> | undefined,
    savedClients?: Readonly<Record<string, ExternalClientConnection>>,
  ): void {
    this.reconcileClients(deriveConnectedExternalClients(roles, savedClients));
  }

  invalidate(clientId: string): void {
    this.#cache.delete(clientId);
  }

  ingestPassiveQuota(binding: ExternalAgentBinding, quota: ExternalAgentQuotaProbeResult): boolean {
    if (!isQuotaSupportedExternalAgentKind(binding.kind) || !isValidQuotaProbeResult(quota) || quota.kind !== binding.kind) {
      return false;
    }
    const clients = this.#options.getClients();
    this.reconcileClients(clients);
    const directId = externalClientConnectionId(binding);
    let target = clients.find((c) => c.id === directId);
    if (!target) {
      const sameKindEnv = clients.filter((c) => c.kind === binding.kind && c.envId === binding.envId);
      if (sameKindEnv.length === 1) target = sameKindEnv[0];
    }
    if (!target) return false;
    const targetFp = computeQuotaBindingFingerprint(target);
    if (computeQuotaBindingFingerprint(binding) !== targetFp) return false;

    const existing = this.#cache.get(target.id);
    if (existing?.lastOk && quota.fetchedAt < existing.lastOk.fetchedAt) {
      return false;
    }
    const merged = mergeQuotaProbeResults(existing?.lastOk, quota);
    if (!isValidQuotaProbeResult(merged)) return false;

    this.#cache.set(target.id, {
      bindingFingerprint: targetFp,
      lastOk: merged,
      lastAttemptAt: existing?.lastAttemptAt,
      lastAttemptWasForce: existing?.lastAttemptWasForce,
      ...(existing?.lastError && existing.lastError.at > merged.fetchedAt ? { lastError: existing.lastError } : {}),
    });
    return true;
  }

  getSnapshot(): ExternalClientQuotasView {
    const clients = this.#options.getClients();
    this.reconcileClients(clients);
    const now = this.#now();
    const items: ExternalClientQuotaItem[] = clients.map((client) => {
      const label = externalClientDisplayName(client);
      const { env, online, capable } = this.#isEnvOnline(client.envId);
      const envName = env?.name ?? client.envId;
      const base = {
        clientId: client.id,
        kind: client.kind,
        label,
        envId: client.envId,
        envName,
        deviceOnline: online,
      };

      if (!isQuotaSupportedExternalAgentKind(client.kind)) {
        return {
          ...base,
          canRefresh: false,
          status: "unsupported",
          stale: false,
          windows: [],
        };
      }
      if (!online) {
        return {
          ...base,
          canRefresh: false,
          status: "device_offline",
          stale: false,
          windows: [],
        };
      }
      if (!capable) {
        return {
          ...base,
          canRefresh: false,
          status: "env_outdated",
          stale: false,
          windows: [],
        };
      }

      const entry = this.#cache.get(client.id);
      const lastOk = entry?.lastOk;
      const lastErr = entry?.lastError;
      const inFailureBackoff = Boolean(lastErr && now - lastErr.at < this.#autoFailureBackoffMs);

      if (lastOk) {
        const age = Math.max(0, now - lastOk.fetchedAt);
        const stale = age >= this.#softTtlMs && !inFailureBackoff;
        const refreshError = lastErr && lastErr.at > lastOk.fetchedAt ? lastErr.message : undefined;
        return {
          ...base,
          canRefresh: true,
          status: lastOk.status,
          source: lastOk.source,
          fetchedAt: lastOk.fetchedAt,
          stale,
          ...(refreshError ? { refreshError } : {}),
          ...(lastOk.planLabel ? { planLabel: lastOk.planLabel } : {}),
          ...(lastOk.ordinaryUsageAllowed !== undefined ? { ordinaryUsageAllowed: lastOk.ordinaryUsageAllowed } : {}),
          windows: lastOk.windows.map((w) => ({ ...w })),
          ...(lastOk.credits ? { credits: { ...lastOk.credits } } : {}),
          ...(lastOk.error ? { error: lastOk.error } : {}),
        };
      }

      if (lastErr) {
        return {
          ...base,
          canRefresh: true,
          status: "unavailable",
          fetchedAt: lastErr.at,
          stale: !inFailureBackoff,
          error: lastErr.message,
          windows: [],
        };
      }

      return {
        ...base,
        canRefresh: true,
        status: "unavailable",
        stale: true,
        windows: [],
      };
    });

    return {
      serverTime: now,
      softTtlMs: this.#softTtlMs,
      minRefreshCooldownMs: this.#minForceCooldownMs,
      items,
    };
  }

  #shouldProbeClient(clientId: string, force: boolean, now: number): boolean {
    const entry = this.#cache.get(clientId);
    if (!entry) return true;
    const lastOk = entry.lastOk;
    const lastErr = entry.lastError;

    if (!force) {
      if (lastErr && now - lastErr.at < this.#autoFailureBackoffMs) return false;
      if (!lastOk) return true;
      return now - lastOk.fetchedAt >= this.#softTtlMs;
    }

    if (entry.lastAttemptAt !== undefined) {
      const latestFailed = Boolean(lastErr && (!lastOk || lastErr.at >= lastOk.fetchedAt));
      const latestStatus = latestFailed ? "unavailable" : lastOk?.status;
      const cooldown =
        !entry.lastAttemptWasForce || latestStatus === "unauthenticated" || latestStatus === "unavailable"
          ? this.#quickRetryCooldownMs
          : this.#minForceCooldownMs;
      if (now - entry.lastAttemptAt < cooldown) return false;
    }
    return true;
  }

  async #acquireGlobalSlot(): Promise<void> {
    if (this.#activeGlobalCount < this.#maxConcurrency) {
      this.#activeGlobalCount++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#globalWaiters.push(resolve);
    });
    this.#activeGlobalCount++;
  }

  #releaseGlobalSlot(): void {
    this.#activeGlobalCount = Math.max(0, this.#activeGlobalCount - 1);
    const next = this.#globalWaiters.shift();
    if (next) next();
  }

  #enqueueOnEnv(envId: string, work: () => Promise<void>): Promise<void> {
    const prior = this.#envChains.get(envId) ?? Promise.resolve();
    const run = prior.then(work, work);
    const cleaned = run.finally(() => {
      if (this.#envChains.get(envId) === cleaned) {
        this.#envChains.delete(envId);
      }
    });
    this.#envChains.set(envId, cleaned);
    return cleaned;
  }

  #triggerSingleflightProbe(client: ExternalClientConnection, force: boolean): Promise<void> {
    const existing = this.#inFlight.get(client.id);
    if (existing) return existing;

    const binding = bindingFromClientConnection(client);
    const fingerprint = computeQuotaBindingFingerprint(binding);

    const task = this.#enqueueOnEnv(client.envId, async () => {
      if (this.#serviceAbort.signal.aborted) return;
      await this.#acquireGlobalSlot();
      const probeAbort = new AbortController();
      const onServiceAbort = () => probeAbort.abort();
      this.#serviceAbort.signal.addEventListener("abort", onServiceAbort, { once: true });
      const timer = setTimeout(() => probeAbort.abort(), this.#probeTimeoutMs);
      timer.unref();
      try {
        if (this.#serviceAbort.signal.aborted) return;
        const { online, capable } = this.#isEnvOnline(client.envId);
        if (!online || !capable) return;
        const response = await this.#options.requestQuota(
          client.envId,
          binding,
          probeAbort.signal,
        );
        if (this.#serviceAbort.signal.aborted) return;
        // Verify client binding has not been removed or reconfigured during the probe.
        const currentClient = this.#options.getClients().find((c) => c.id === client.id);
        if (!currentClient || computeQuotaBindingFingerprint(currentClient) !== fingerprint) return;

        const now = this.#now();
        if (response.type !== "quota" || response.quota.kind !== client.kind || !isValidQuotaProbeResult(response.quota)) {
          this.#recordFailure(client.id, fingerprint, now, force, "Invalid quota response from device");
          return;
        }
        const quota = response.quota;
        if (quota.status === "unavailable") {
          this.#recordFailure(
            client.id,
            fingerprint,
            now,
            force,
            quota.error ?? "Quota is currently unavailable",
          );
          return;
        }
        const prev = this.#cache.get(client.id);
        if (prev?.lastOk && quota.fetchedAt < prev.lastOk.fetchedAt) {
          this.#cache.set(client.id, {
            ...prev,
            bindingFingerprint: fingerprint,
            lastAttemptAt: now,
            lastAttemptWasForce: force,
          });
          return;
        }
        this.#cache.set(client.id, {
          bindingFingerprint: fingerprint,
          lastOk: quota,
          lastAttemptAt: now,
          lastAttemptWasForce: force,
        });
      } catch (error) {
        if (this.#serviceAbort.signal.aborted) return;
        const currentClient = this.#options.getClients().find((c) => c.id === client.id);
        if (!currentClient || computeQuotaBindingFingerprint(currentClient) !== fingerprint) return;
        const msg = sanitizeQuotaError(
          error instanceof Error ? error.message : "Failed to refresh external agent quota",
          this.#options.redact,
        ) ?? "Failed to refresh external agent quota";
        this.#recordFailure(client.id, fingerprint, this.#now(), force, msg);
      } finally {
        clearTimeout(timer);
        this.#serviceAbort.signal.removeEventListener("abort", onServiceAbort);
        this.#releaseGlobalSlot();
      }
    }).finally(() => {
      if (this.#inFlight.get(client.id) === task) {
        this.#inFlight.delete(client.id);
      }
    });

    this.#inFlight.set(client.id, task);
    return task;
  }

  #recordFailure(
    clientId: string,
    fingerprint: string,
    at: number,
    force: boolean,
    message: string,
  ): void {
    const prev = this.#cache.get(clientId);
    const keepLastOk = prev?.bindingFingerprint === fingerprint ? prev.lastOk : undefined;
    this.#cache.set(clientId, {
      bindingFingerprint: fingerprint,
      ...(keepLastOk ? { lastOk: keepLastOk } : {}),
      lastAttemptAt: at,
      lastAttemptWasForce: force,
      lastError: { at, message },
    });
  }

  async refresh(options?: {
    clientId?: string;
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<ExternalClientQuotasView> {
    const clients = this.#options.getClients();
    this.reconcileClients(clients);
    const force = Boolean(options?.force);
    const targetId = options?.clientId?.trim() || undefined;
    const now = this.#now();

    const candidates = clients.filter((client) => {
      if (targetId && client.id !== targetId) return false;
      if (!isQuotaSupportedExternalAgentKind(client.kind)) return false;
      const { online, capable } = this.#isEnvOnline(client.envId);
      if (!online || !capable) return false;
      return this.#shouldProbeClient(client.id, force, now);
    });

    const waitList = candidates.map((client) => this.#triggerSingleflightProbe(client, force));
    if (waitList.length > 0) {
      const settled = Promise.allSettled(waitList);
      if (options?.signal) {
        if (!options.signal.aborted) {
          let onAbort: (() => void) | undefined;
          const abortPromise = new Promise<void>((resolve) => {
            onAbort = () => resolve();
            options.signal!.addEventListener("abort", onAbort, { once: true });
          });
          await Promise.race([settled, abortPromise]);
          if (onAbort) options.signal.removeEventListener("abort", onAbort);
        }
      } else {
        await settled;
      }
    }

    return this.getSnapshot();
  }

  close(): void {
    this.#serviceAbort.abort();
  }
}
