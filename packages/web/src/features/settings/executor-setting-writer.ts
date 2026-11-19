import type { ExecutorSlotsConfig, MocoSettingsView } from "@moco/protocol";
import { MocoApiError } from "../../moco-api";

export type ExecutorSetting = keyof ExecutorSlotsConfig;

export function executorSettingValue<K extends ExecutorSetting>(value: ExecutorSlotsConfig, key: K): ExecutorSlotsConfig[K] {
  switch (key) {
    case "maxSubagentsPerTicket": return (value[key] ?? 4) as ExecutorSlotsConfig[K];
    case "watchdogMinutes": return (value[key] ?? 5) as ExecutorSlotsConfig[K];
    case "completedTaskDisplayHours": return (value[key] === undefined ? 3 : value[key]) as ExecutorSlotsConfig[K];
    case "autoArchiveEnabled": return (value[key] ?? true) as ExecutorSlotsConfig[K];
    case "autoArchiveDays": return (value[key] ?? 7) as ExecutorSlotsConfig[K];
    default: return value[key];
  }
}

export class ExecutorSettingConflict extends Error {
  constructor() {
    super("Runtime settings changed before this value could be saved.");
    this.name = "ExecutorSettingConflict";
  }
}

/** Each queued change merges into the saved block, never another field's unfinished input. */
export class ExecutorSettingWriter {
  #current: MocoSettingsView;
  #tail: Promise<unknown> = Promise.resolve();
  #blocked = false;

  constructor(settings: MocoSettingsView, private readonly save: (revision: number, value: ExecutorSlotsConfig) => Promise<{ settings: MocoSettingsView }>) {
    this.#current = settings;
  }

  get snapshot(): MocoSettingsView { return this.#current; }
  get blocked(): boolean { return this.#blocked; }

  accept(settings: MocoSettingsView): void {
    const revision = settings.blocks.executor.revision;
    const currentRevision = this.#current.blocks.executor.revision;
    if (revision > currentRevision || revision === currentRevision && settings.globalRevision > this.#current.globalRevision) this.#current = settings;
  }

  reload(settings: MocoSettingsView): void {
    this.accept(settings);
    this.#blocked = false;
  }

  commit<K extends ExecutorSetting>(key: K, value: ExecutorSlotsConfig[K], expected = executorSettingValue(this.#current.blocks.executor.value, key)): Promise<MocoSettingsView> {
    const run = async () => {
      if (this.#blocked) throw new ExecutorSettingConflict();
      const block = this.#current.blocks.executor;
      const saved = executorSettingValue(block.value, key);
      if (Object.is(saved, value)) return this.#current;
      if (!Object.is(saved, expected)) {
        this.#blocked = true;
        throw new ExecutorSettingConflict();
      }
      try {
        const result = await this.save(block.revision, { ...block.value, [key]: value });
        this.accept(result.settings);
        if (!Object.is(executorSettingValue(this.#current.blocks.executor.value, key), value)) {
          this.#blocked = true;
          throw new ExecutorSettingConflict();
        }
        return this.#current;
      } catch (error) {
        if (error instanceof MocoApiError && error.status === 409) this.#blocked = true;
        throw error;
      }
    };
    const result = this.#tail.then(run, run);
    // The caller receives the original rejection; later independent changes can still be queued.
    this.#tail = result;
    return result;
  }
}
