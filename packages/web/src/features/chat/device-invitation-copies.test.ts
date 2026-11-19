import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceInvitationCopies, type IssuedInvitation } from "./device-invitation-copies";

afterEach(() => vi.useRealTimers());

function pendingInvitation() {
  let resolve!: (invitation: IssuedInvitation) => void;
  const promise = new Promise<IssuedInvitation>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("chat invitation clipboard delivery", () => {
  it("finishes the original user gesture while the card is unmounted for a listener rebind", async () => {
    const clipboard: string[] = [];
    const write = vi.fn(async (value: Promise<string>) => { clipboard.push(await value); });
    const copies = new DeviceInvitationCopies(write);
    copies.setScope("original-hub/local");
    const unsubscribe = copies.subscribe(vi.fn());
    const pending = pendingInvitation();
    const issue = vi.fn(() => pending.promise);
    const done = copies.copy("original-hub/local", "card", issue);
    expect(write).toHaveBeenCalledOnce();
    unsubscribe();
    copies.setScope("original-hub/local");
    await copies.copy("original-hub/local", "card", issue);
    expect(issue).toHaveBeenCalledOnce();
    pending.resolve({ instruction: "test connection", expiresAt: Date.now() + 60_000 });
    await done;
    const remount = copies.subscribe(vi.fn());
    expect(copies.get("original-hub/local", "card")).toEqual({ status: "copied" });
    expect(clipboard).toEqual(["test connection"]);
    remount();
    copies.setScope("other-hub/local");
  });

  it("cancels pending clipboard delivery when the verified identity changes", async () => {
    const clipboard: string[] = [];
    const copies = new DeviceInvitationCopies(async (value) => { clipboard.push(await value); });
    copies.setScope("hub/local");
    const pending = pendingInvitation();
    let signal!: AbortSignal;
    const done = copies.copy("hub/local", "card", (original) => { signal = original; return pending.promise; });
    copies.setScope("hub/peer");
    pending.resolve({ instruction: "old connection", expiresAt: Date.now() + 60_000 });
    await done;
    expect(signal.aborted).toBe(true);
    expect(clipboard).toEqual([]);
    expect(copies.get("hub/peer", "card")).toEqual({ status: "idle" });
    const staleClick = vi.fn();
    await copies.copy("hub/local", "card", staleClick);
    expect(staleClick).not.toHaveBeenCalled();
  });

  it("retains manual copy only for the original identity and only until the issued invitation expires", async () => {
    vi.useFakeTimers();
    const copies = new DeviceInvitationCopies(async () => { throw new Error("Clipboard blocked"); });
    copies.setScope("hub/local");
    const issue = () => Promise.resolve({ instruction: "manual instruction", expiresAt: Date.now() + 1000 });
    await copies.copy("hub/local", "card", issue);
    expect(copies.get("hub/local", "card")).toMatchObject({ status: "manual", invitation: { instruction: "manual instruction" } });
    expect(copies.get("hub/peer", "card")).toEqual({ status: "idle" });
    vi.advanceTimersByTime(1000);
    expect(copies.get("hub/local", "card")).toEqual({ status: "idle" });
    await copies.copy("hub/local", "card", issue);
    copies.setScope("other-hub/local");
    expect(copies.get("hub/local", "card")).toEqual({ status: "idle" });
  });
});
