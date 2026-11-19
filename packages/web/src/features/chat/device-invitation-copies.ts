import { translate as t } from "../../moco-i18n";
import { copyDeviceTextWhenReady } from "../settings/device-clipboard";

export interface IssuedInvitation { instruction: string; expiresAt: number }
type CopyState = { status: "idle" | "copying" | "copied" } | { status: "manual"; invitation: IssuedInvitation } | { status: "failed"; message: string };
interface CopyOperation {
  controller: AbortController;
  state: CopyState;
  timer?: ReturnType<typeof setTimeout>;
}
const idle: CopyState = { status: "idle" };

/** Enabling LAN access rebinds the listener and temporarily unmounts the chat card. */
export class DeviceInvitationCopies {
  readonly #operations = new Map<string, CopyOperation>();
  readonly #listeners = new Set<() => void>();
  #scope?: string;
  constructor(private readonly write = copyDeviceTextWhenReady) {}

  setScope(scope: string) {
    if (this.#scope === scope) return;
    this.#scope = scope;
    for (const operation of this.#operations.values()) {
      operation.controller.abort();
      clearTimeout(operation.timer);
    }
    this.#operations.clear();
    this.#notify();
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };
  get(scope: string | undefined, partId: string): CopyState {
    return scope && scope === this.#scope ? this.#operations.get(partId)?.state ?? idle : idle;
  }

  async copy(scope: string, partId: string, issue: (signal: AbortSignal) => Promise<IssuedInvitation>): Promise<void> {
    if (scope !== this.#scope || this.get(scope, partId).status === "copying") return;
    clearTimeout(this.#operations.get(partId)?.timer);
    const operation: CopyOperation = { controller: new AbortController(), state: { status: "copying" } };
    this.#operations.set(partId, operation);
    this.#notify();
    const { signal } = operation.controller;
    let keepFor = 30_000;
    try {
      const request = issue(signal);
      const write = this.write(request.then(({ instruction }) => { signal.throwIfAborted(); return instruction; }), signal);
      const [invitation, written] = await Promise.all([request, write.then(() => true, () => false)]);
      if (signal.aborted) return;
      if (written) operation.state = { status: "copied" };
      else {
        operation.state = { status: "manual", invitation };
        keepFor = Math.max(0, invitation.expiresAt - Date.now());
      }
    } catch (cause) {
      if (signal.aborted) return;
      operation.state = { status: "failed", message: cause instanceof Error ? cause.message : t("未能生成接入指令。", "Could not create a connection instruction.") };
    }
    operation.timer = setTimeout(() => { this.#operations.delete(partId); this.#notify(); }, keepFor);
    this.#notify();
  }

  #notify() { for (const listener of this.#listeners) listener(); }
}

export const deviceInvitationCopies = new DeviceInvitationCopies();
