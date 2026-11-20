import type {
  ConnectorCallRequest,
  ConnectorCallResult,
  EnvNodeDescriptor,
  SparkConnectorSnapshot,
} from "@kulo/protocol";

export interface SparkMailServiceHost {
  listOnlineEnvs(): EnvNodeDescriptor[];
  callConnector(envId: string, request: ConnectorCallRequest, timeoutMs?: number): Promise<ConnectorCallResult>;
  isEnabled(): Promise<boolean>;
  redact(text: string): string;
}

export class SparkMailService {
  readonly #host: SparkMailServiceHost;
  #cachedStatus: SparkConnectorSnapshot | null = null;
  #cachedAt = 0;

  constructor(host: SparkMailServiceHost) {
    this.#host = host;
  }

  #candidateMacEnvs(preferredEnvId?: string): EnvNodeDescriptor[] {
    const envs = this.#host.listOnlineEnvs().filter(
      (env) => env.online && (env.platform === "darwin" || env.platform === "win32") && env.executionKind !== "native-device",
    );
    if (preferredEnvId) {
      const exact = envs.find((env) => env.id === preferredEnvId);
      if (exact) return [exact, ...envs.filter((env) => env.id !== preferredEnvId)];
    }
    return [...envs].sort((a, b) => (a.kind === "local" ? -1 : b.kind === "local" ? 1 : a.name.localeCompare(b.name)));
  }

  async status(options: { force?: boolean; envId?: string } = {}): Promise<SparkConnectorSnapshot> {
    const enabled = await this.#host.isEnabled();
    if (!options.force && this.#cachedStatus && this.#cachedStatus.enabled === enabled && Date.now() - this.#cachedAt < 20_000) {
      return this.#cachedStatus;
    }
    const candidates = this.#candidateMacEnvs(options.envId);
    if (candidates.length === 0) {
      const snap: SparkConnectorSnapshot = {
        enabled,
        available: false,
        error: "没有在线的桌面设备可供连接 Spark Mail。",
      };
      this.#cachedStatus = snap;
      this.#cachedAt = Date.now();
      return snap;
    }

    let lastError: string | undefined;
    for (const env of candidates) {
      const res = await this.#host.callConnector(env.id, { driverId: "spark-mail", action: "status" }, 8_000);
      if (res.ok && res.data && typeof res.data === "object") {
        const data = res.data as { accessTier?: SparkConnectorSnapshot["accessTier"]; accountCount?: number };
        const snap: SparkConnectorSnapshot = {
          enabled,
          available: true,
          envId: env.id,
          envName: env.name,
          accessTier: data.accessTier ?? "read",
          accountCount: typeof data.accountCount === "number" ? data.accountCount : 0,
        };
        this.#cachedStatus = snap;
        this.#cachedAt = Date.now();
        return snap;
      }
      lastError = res.error;
    }

    const snap: SparkConnectorSnapshot = {
      enabled,
      available: false,
      envId: candidates[0]?.id,
      envName: candidates[0]?.name,
      ...(lastError ? { error: this.#host.redact(lastError).slice(0, 300) } : {}),
    };
    this.#cachedStatus = snap;
    this.#cachedAt = Date.now();
    return snap;
  }

  invalidateCache(): void {
    this.#cachedStatus = null;
    this.#cachedAt = 0;
  }

  async invokeRead(
    action: "list_emails" | "search" | "read_thread" | "list_events",
    params: Record<string, unknown> = {},
    preferredEnvId?: string,
  ): Promise<ConnectorCallResult & { envId?: string; envName?: string }> {
    const snap = await this.status({ envId: preferredEnvId });
    if (!snap.available || !snap.envId) {
      return {
        ok: false,
        code: "spark_unavailable",
        error: snap.error || "Spark CLI 未就绪，请打开 Spark Desktop 并在「设置 → AI Agents → Setup CLI」启用。",
      };
    }
    const res = await this.#host.callConnector(snap.envId, { driverId: "spark-mail", action, params }, 18_000);
    return {
      ...res,
      ...(res.error ? { error: this.#host.redact(res.error) } : {}),
      envId: snap.envId,
      envName: snap.envName,
    };
  }

  /**
   * Strictly executed ONLY after explicit L2 user confirmation (`confirm_action`).
   * Never auto-sends emails — creates a draft inside Spark Desktop for human review.
   */
  async executeConfirmedDraft(
    params: { replyToThreadId?: string; to?: string; subject?: string; body: string },
    preferredEnvId?: string,
  ): Promise<ConnectorCallResult & { envId?: string }> {
    const snap = await this.status({ force: true, envId: preferredEnvId });
    if (!snap.available || !snap.envId) {
      return {
        ok: false,
        code: "spark_unavailable",
        error: snap.error || "Spark CLI 当前不可用，未能创建草稿。",
      };
    }
    const res = await this.#host.callConnector(
      snap.envId,
      {
        driverId: "spark-mail",
        action: "create_draft",
        params,
      },
      18_000,
    );
    return {
      ...res,
      ...(res.error ? { error: this.#host.redact(res.error) } : {}),
      envId: snap.envId,
    };
  }
}
