import { describe, expect, it, vi } from "vitest";
import type { MobileInvitation } from "@moco/protocol";
import { MocoApiError } from "../../moco-api";
import { MobileInvitationCleanupError, MobileInvitationSession, validatedTailscaleLoginURL } from "./mobile-pairing-panel";

const invitation = (id: string): MobileInvitation => ({
  id, deviceId: `device-${id}`, expiresAt: 1_900_000_000_000, qrValue: `moco://pair?data=${id}`,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("mobile invitation lifecycle", () => {
  it("revokes an invitation whose create response arrives after the panel closes", async () => {
    const created = deferred<MobileInvitation>();
    const cancel = vi.fn(async () => undefined);
    const session = new MobileInvitationSession({ create: () => created.promise, cancel });
    const request = session.generate();
    await Promise.resolve();
    await session.dispose();
    created.resolve(invitation("late"));
    expect(await request).toBeUndefined();
    expect(cancel).toHaveBeenCalledExactlyOnceWith("late");
  });

  it("shares an in-flight creation and retires the old invitation before refreshing", async () => {
    const created = deferred<MobileInvitation>();
    const create = vi.fn().mockReturnValueOnce(created.promise).mockResolvedValueOnce(invitation("new"));
    const cancel = vi.fn(async () => undefined);
    const session = new MobileInvitationSession({ create, cancel });
    const first = session.generate();
    const duplicate = session.generate();
    created.resolve(invitation("old"));
    expect(await first).toEqual(invitation("old"));
    expect(await duplicate).toEqual(invitation("old"));
    expect(create).toHaveBeenCalledTimes(1);
    await session.generate();
    expect(cancel).toHaveBeenCalledExactlyOnceWith("old");
    await session.dispose();
    expect(cancel).toHaveBeenLastCalledWith("new");
  });

  it("does not create a replacement when revocation fails and retries cleanup", async () => {
    const create = vi.fn(async () => invitation("keep"));
    const cancel = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const session = new MobileInvitationSession({ create, cancel });
    await session.generate();
    await expect(session.generate()).rejects.toBeInstanceOf(MobileInvitationCleanupError);
    expect(create).toHaveBeenCalledTimes(1);
    await session.dispose();
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("treats an already expired invitation as successfully retired", async () => {
    const session = new MobileInvitationSession({
      create: async () => invitation("expired"),
      cancel: async () => { throw new MocoApiError(410, "Expired"); },
    });
    await session.generate();
    await expect(session.dispose()).resolves.toBeUndefined();
  });
});

describe("Tailscale browser authorization", () => {
  it("accepts only HTTPS Tailscale origins without user information or custom ports", () => {
    expect(validatedTailscaleLoginURL("https://login.tailscale.com/a/private")).toBe("https://login.tailscale.com/a/private");
    for (const value of ["javascript:alert(1)", "http://tailscale.com/a/private", "https://tailscale.com.evil.test/a/private", "https://user@tailscale.com/a/private", "https://tailscale.com:9443/a/private", "not a URL"]) {
      expect(() => validatedTailscaleLoginURL(value)).toThrow();
    }
  });
});
