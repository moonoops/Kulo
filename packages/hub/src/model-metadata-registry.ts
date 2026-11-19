import fs from "node:fs";
import path from "node:path";
import type { CustomProviderApi } from "@kulo/protocol";
import { proxyFetch } from "./http-transport.js";
import {
  buildNormalizedCatalog,
  isValidModelMetadataCatalog,
  lookupModelInCatalog,
  type ModelMetadataCatalog,
  type ModelMetadataEntry,
} from "./model-metadata-parser.js";
import { BUNDLED_MODEL_METADATA_SNAPSHOT_JSON } from "./model-metadata-snapshot.js";

export const DEFAULT_MODELS_DEV_URL = "https://models.dev/api.json";
export const DEFAULT_LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const DEFAULT_REFRESH_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_REGISTRY_RESPONSE_BYTES = 16 * 1024 * 1024;
const CACHE_FILENAME = "model-registry-cache.json";

interface PersistedRegistryCache {
  version: 1;
  fetchedAt: number;
  etagModelsDev?: string;
  etagLiteLLM?: string;
  catalog: ModelMetadataCatalog;
}

export interface ModelMetadataRegistryOptions {
  stateDir?: string;
  fetcher?: typeof fetch;
  modelsDevUrl?: string;
  liteLLMUrl?: string;
  refreshTtlMs?: number;
  timeoutMs?: number;
}

export interface ModelMetadataRefreshResult {
  updated: boolean;
  fromCache: boolean;
  source: "remote" | "cache" | "bundled";
  fetchedAt?: number;
  error?: string;
}

let cachedBundledCatalog: ModelMetadataCatalog | null = null;

export function loadBundledModelMetadataCatalog(): ModelMetadataCatalog {
  if (cachedBundledCatalog) return cachedBundledCatalog;
  try {
    const parsed = JSON.parse(BUNDLED_MODEL_METADATA_SNAPSHOT_JSON) as unknown;
    if (isValidModelMetadataCatalog(parsed)) {
      cachedBundledCatalog = parsed;
      return parsed;
    }
  } catch {
    // Fallback to empty catalog if bundled snapshot is somehow malformed
  }
  cachedBundledCatalog = { version: 1, generatedAt: 0, providers: {}, models: {} };
  return cachedBundledCatalog;
}

function atomicWriteJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data), { encoding: "utf8", mode: 0o644 });
  fs.renameSync(tmpPath, filePath);
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Model metadata response exceeds size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) return response.json();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Model metadata response exceeds size limit");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
  } finally {
    reader.releaseLock();
  }
}

function carryForwardWebSearchFlags(
  next: ModelMetadataCatalog,
  previous: ModelMetadataCatalog,
): void {
  for (const [providerId, prevBucket] of Object.entries(previous.providers)) {
    const nextBucket = next.providers[providerId];
    if (!nextBucket) continue;
    for (const [id, prevEntry] of Object.entries(prevBucket)) {
      if (prevEntry.webSearch && nextBucket[id] && !nextBucket[id]!.webSearch) {
        nextBucket[id]!.webSearch = true;
      }
    }
  }
  for (const [id, prevEntry] of Object.entries(previous.models)) {
    if (prevEntry.webSearch && next.models[id] && !next.models[id]!.webSearch) {
      next.models[id]!.webSearch = true;
    }
  }
}

/**
 * Local-first, on-demand refreshable model metadata registry.
 * Combines a release-bundled slim snapshot with a disk-persisted cache updated
 * anonymously on user-triggered discovery or calibration requests.
 */
export class KuloModelMetadataRegistry {
  readonly #cachePath: string | undefined;
  readonly #fetcher: typeof fetch;
  readonly #modelsDevUrl: string;
  readonly #liteLLMUrl: string;
  readonly #refreshTtlMs: number;
  readonly #timeoutMs: number;

  #catalog: ModelMetadataCatalog | null = null;
  #source: "cache" | "bundled" = "bundled";
  #fetchedAt = 0;
  #etagModelsDev: string | undefined;
  #etagLiteLLM: string | undefined;
  #inFlight: Promise<ModelMetadataRefreshResult> | null = null;

  constructor(options: ModelMetadataRegistryOptions = {}) {
    this.#cachePath = options.stateDir ? path.join(options.stateDir, CACHE_FILENAME) : undefined;
    this.#fetcher = options.fetcher ?? proxyFetch;
    this.#modelsDevUrl = options.modelsDevUrl ?? DEFAULT_MODELS_DEV_URL;
    this.#liteLLMUrl = options.liteLLMUrl ?? DEFAULT_LITELLM_URL;
    this.#refreshTtlMs = options.refreshTtlMs ?? DEFAULT_REFRESH_TTL_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  #ensureLoaded(): ModelMetadataCatalog {
    if (this.#catalog) return this.#catalog;
    const bundled = loadBundledModelMetadataCatalog();
    if (this.#cachePath && fs.existsSync(this.#cachePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.#cachePath, "utf8")) as Partial<PersistedRegistryCache>;
        if (
          parsed &&
          parsed.version === 1 &&
          typeof parsed.fetchedAt === "number" &&
          Number.isFinite(parsed.fetchedAt) &&
          isValidModelMetadataCatalog(parsed.catalog) &&
          // If the bundled snapshot was rebuilt more recently than the old cache, prefer the newer bundled snapshot.
          parsed.catalog.generatedAt >= bundled.generatedAt
        ) {
          this.#catalog = parsed.catalog;
          this.#source = "cache";
          this.#fetchedAt = parsed.fetchedAt;
          this.#etagModelsDev = typeof parsed.etagModelsDev === "string" ? parsed.etagModelsDev : undefined;
          this.#etagLiteLLM = typeof parsed.etagLiteLLM === "string" ? parsed.etagLiteLLM : undefined;
          return this.#catalog;
        }
      } catch {
        // Discard corrupt cache silently and fall back to bundled factory snapshot.
      }
    }
    this.#catalog = bundled;
    this.#source = "bundled";
    this.#fetchedAt = 0;
    return this.#catalog;
  }

  #persist(cache: PersistedRegistryCache): void {
    if (!this.#cachePath) return;
    try {
      atomicWriteJson(this.#cachePath, cache);
    } catch {
      // Best-effort cache write; runtime still holds the refreshed catalog in memory.
    }
  }

  getCatalog(): ModelMetadataCatalog {
    return this.#ensureLoaded();
  }

  getCatalogInfo(): { source: "cache" | "bundled"; generatedAt: number; fetchedAt: number; modelCount: number } {
    const catalog = this.#ensureLoaded();
    return {
      source: this.#source,
      generatedAt: catalog.generatedAt,
      fetchedAt: this.#fetchedAt,
      modelCount: Object.keys(catalog.models).length,
    };
  }

  lookup(modelId: string, options?: { preset?: string; api?: CustomProviderApi }): ModelMetadataEntry | undefined {
    return lookupModelInCatalog(this.#ensureLoaded(), modelId, options);
  }

  async #fetchSource(
    url: string,
    etag: string | undefined,
    signal: AbortSignal,
  ): Promise<{ status: "ok"; data: unknown; etag?: string } | { status: "not_modified"; etag?: string } | { status: "error"; error: string }> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-cache",
    };
    if (etag) headers["If-None-Match"] = etag;
    try {
      const response = await this.#fetcher(url, {
        method: "GET",
        headers,
        signal,
      });
      const nextEtag = response.headers.get("etag") ?? etag;
      if (response.status === 304) {
        return { status: "not_modified", etag: nextEtag };
      }
      if (!response.ok) {
        return { status: "error", error: `HTTP ${response.status}` };
      }
      const data = await readBoundedJson(response, MAX_REGISTRY_RESPONSE_BYTES);
      return { status: "ok", data, etag: nextEtag };
    } catch (error) {
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * On-demand anonymous refresh from public model metadata registries.
   * Never sends provider credentials and never throws on network/proxy failures.
   */
  async refresh(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<ModelMetadataRefreshResult> {
    const current = this.#ensureLoaded();
    const now = Date.now();
    if (!options.force && this.#fetchedAt > 0 && now - this.#fetchedAt < this.#refreshTtlMs) {
      return {
        updated: false,
        fromCache: true,
        source: this.#source,
        fetchedAt: this.#fetchedAt,
      };
    }
    if (this.#inFlight) return this.#inFlight;

    const run = (async (): Promise<ModelMetadataRefreshResult> => {
      const timeoutSig = AbortSignal.timeout(this.#timeoutMs);
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeoutSig])
        : timeoutSig;

      const [modelsDevRes, liteLLMRes] = await Promise.all([
        this.#fetchSource(this.#modelsDevUrl, options.force ? undefined : this.#etagModelsDev, signal),
        this.#fetchSource(this.#liteLLMUrl, options.force ? undefined : this.#etagLiteLLM, signal),
      ]);

      const completedAt = Date.now();

      if (modelsDevRes.status === "not_modified" && liteLLMRes.status !== "ok") {
        this.#fetchedAt = completedAt;
        this.#etagModelsDev = modelsDevRes.etag;
        if (liteLLMRes.status === "not_modified") this.#etagLiteLLM = liteLLMRes.etag;
        if (this.#source === "cache") {
          this.#persist({
            version: 1,
            fetchedAt: this.#fetchedAt,
            ...(this.#etagModelsDev ? { etagModelsDev: this.#etagModelsDev } : {}),
            ...(this.#etagLiteLLM ? { etagLiteLLM: this.#etagLiteLLM } : {}),
            catalog: current,
          });
        }
        return { updated: false, fromCache: true, source: this.#source, fetchedAt: this.#fetchedAt };
      }

      if (modelsDevRes.status === "ok") {
        const nextCatalog = buildNormalizedCatalog(
          modelsDevRes.data,
          liteLLMRes.status === "ok" ? liteLLMRes.data : undefined,
          completedAt,
        );
        if (Object.keys(nextCatalog.providers).length === 0 && Object.keys(nextCatalog.models).length === 0) {
          return {
            updated: false,
            fromCache: true,
            source: this.#source,
            fetchedAt: this.#fetchedAt,
            error: "Empty model metadata response",
          };
        }
        if (liteLLMRes.status !== "ok") {
          carryForwardWebSearchFlags(nextCatalog, current);
        }
        this.#catalog = nextCatalog;
        this.#source = "cache";
        this.#fetchedAt = completedAt;
        this.#etagModelsDev = modelsDevRes.etag;
        if (liteLLMRes.status === "ok" || liteLLMRes.status === "not_modified") {
          this.#etagLiteLLM = liteLLMRes.etag;
        }
        this.#persist({
          version: 1,
          fetchedAt: this.#fetchedAt,
          ...(this.#etagModelsDev ? { etagModelsDev: this.#etagModelsDev } : {}),
          ...(this.#etagLiteLLM ? { etagLiteLLM: this.#etagLiteLLM } : {}),
          catalog: nextCatalog,
        });
        return { updated: true, fromCache: false, source: "remote", fetchedAt: this.#fetchedAt };
      }

      // If models.dev failed but LiteLLM succeeded, enrich current catalog with LiteLLM updates without discarding models.dev data.
      if (liteLLMRes.status === "ok") {
        const nextCatalog = buildNormalizedCatalog({}, liteLLMRes.data, completedAt);
        if (Object.keys(nextCatalog.models).length > 0) {
          // Merge existing catalog as primary so models.dev rich fields survive, adding new LiteLLM entries and webSearch flags.
          const mergedProviders: Record<string, Record<string, ModelMetadataEntry>> = {};
          for (const pid of new Set([...Object.keys(current.providers), ...Object.keys(nextCatalog.providers)])) {
            mergedProviders[pid] = {
              ...(nextCatalog.providers[pid] ?? {}),
              ...(current.providers[pid] ?? {}),
            };
            for (const [mid, nextEntry] of Object.entries(nextCatalog.providers[pid] ?? {})) {
              if (nextEntry.webSearch && mergedProviders[pid]![mid]) {
                mergedProviders[pid]![mid] = { ...mergedProviders[pid]![mid]!, webSearch: true };
              }
            }
          }
          const mergedModels: Record<string, ModelMetadataEntry> = {
            ...nextCatalog.models,
            ...current.models,
          };
          for (const [mid, nextEntry] of Object.entries(nextCatalog.models)) {
            if (nextEntry.webSearch && mergedModels[mid]) {
              mergedModels[mid] = { ...mergedModels[mid]!, webSearch: true };
            }
          }
          const updatedCatalog: ModelMetadataCatalog = {
            version: 1,
            generatedAt: completedAt,
            providers: mergedProviders,
            models: mergedModels,
          };
          this.#catalog = updatedCatalog;
          this.#source = "cache";
          this.#fetchedAt = completedAt;
          this.#etagLiteLLM = liteLLMRes.etag;
          this.#persist({
            version: 1,
            fetchedAt: this.#fetchedAt,
            ...(this.#etagModelsDev ? { etagModelsDev: this.#etagModelsDev } : {}),
            ...(this.#etagLiteLLM ? { etagLiteLLM: this.#etagLiteLLM } : {}),
            catalog: updatedCatalog,
          });
          return { updated: true, fromCache: false, source: "remote", fetchedAt: this.#fetchedAt };
        }
      }

      return {
        updated: false,
        fromCache: true,
        source: this.#source,
        fetchedAt: this.#fetchedAt,
        error: modelsDevRes.status === "error" ? modelsDevRes.error : undefined,
      };
    })().finally(() => {
      this.#inFlight = null;
    });

    this.#inFlight = run;
    return run;
  }
}
