import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { computerUseSessionId, createComputerUseTools, type ComputerUseScope } from "../packages/hub/src/tools-computer-use.js";
import type { ComputerUseRequest, ComputerUseResult } from "@kulo/protocol";

function fixture(readOnly = false) {
  const scope: ComputerUseScope = { ticketId: "ticket-a", conversationId: 8, runEpoch: 1, envId: "windows-env", readOnly, assertActive: vi.fn(async () => {}) };
  const execute = vi.fn(async (_envId: string, request: ComputerUseRequest): Promise<ComputerUseResult> => ({ tool: request.tool, action: request.action, ...("sessionId" in request ? { sessionId: request.sessionId } : {}), platform: "win32", ok: true, data: { snapshot: "button" } }));
  const sessionOpened = vi.fn();
  const sessionObserved = vi.fn();
  const sessionClosed = vi.fn();
  const tools = createComputerUseTools({ scope: async () => scope, execute, sessionOpened, sessionObserved, sessionClosed });
  return { scope, execute, sessionOpened, sessionObserved, sessionClosed, browser: tools[0]!, desktop: tools[1]! };
}

describe("Kulo computer-use tools", () => {
  it("refuses management permission operations even when invoked outside the model schema", async () => {
    const f = fixture();
    for (const tool of [f.browser, f.desktop]) for (const action of ["permissions", "permission-guide"]) {
      await expect(tool.execute({ action } as never, {} as never, BACKGROUND_CONTEXT)).rejects.toThrow("系统权限须由用户");
    }
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("updates preview application metadata only after a successful scoped observation", async () => {
    const f = fixture();
    await f.desktop.execute({ action: "snapshot", app: "App A" }, {} as never, BACKGROUND_CONTEXT);
    expect(f.sessionObserved).toHaveBeenCalledWith(f.scope, "desktop", computerUseSessionId(f.scope), "App A");
    f.execute.mockResolvedValueOnce({ tool: "desktop", action: "snapshot", sessionId: computerUseSessionId(f.scope), platform: "win32", ok: false, error: { code: "APP_NOT_FOUND", message: "App B unavailable" } });
    await f.desktop.execute({ action: "snapshot", app: "App B" }, {} as never, BACKGROUND_CONTEXT);
    expect(f.sessionObserved).toHaveBeenCalledTimes(1);
    expect(f.sessionOpened).toHaveBeenCalledTimes(2);
  });

  it("binds commands to the ticket Env and an epoch-scoped private session", async () => {
    const f = fixture();
    await f.browser.execute({ action: "open", url: "https://example.com" }, {} as never, BACKGROUND_CONTEXT);
    expect(f.execute).toHaveBeenCalledWith("windows-env", { tool: "browser", action: "open", url: "https://example.com", sessionId: computerUseSessionId(f.scope) }, undefined);
    expect(f.scope.assertActive).toHaveBeenCalledTimes(2);
    expect(computerUseSessionId(f.scope)).not.toBe(computerUseSessionId({ ...f.scope, runEpoch: 2 }));
    expect(computerUseSessionId(f.scope)).not.toBe(computerUseSessionId({ ...f.scope, conversationId: 9 }));
    expect(f.browser.replay).toBe("unsafe");
  });

  it("refuses writes from a read-only role and invalid arguments before dispatch", async () => {
    const f = fixture(true);
    await expect(f.desktop.execute({ action: "click", app: "Notepad", ref: "@sabc:e2" }, {} as never, BACKGROUND_CONTEXT)).rejects.toThrow("只读");
    await expect(f.browser.execute({ action: "scroll", direction: "down", amount: 400 }, {} as never, BACKGROUND_CONTEXT)).rejects.toThrow("只读");
    await expect(f.browser.execute({ action: "open", url: "file:///etc/passwd" }, {} as never, BACKGROUND_CONTEXT)).rejects.toThrow("参数无效");
    expect(f.execute).not.toHaveBeenCalled();
    await f.desktop.execute({ action: "status" }, {} as never, BACKGROUND_CONTEXT);
    expect(f.execute).toHaveBeenCalledWith("windows-env", { tool: "desktop", action: "status" }, undefined);
  });

  it("does not dispatch stale or cancelled work", async () => {
    const f = fixture();
    vi.mocked(f.scope.assertActive).mockRejectedValueOnce(new Error("inactive"));
    await expect(f.browser.execute({ action: "snapshot" }, {} as never, BACKGROUND_CONTEXT)).rejects.toThrow("inactive");
    const controller = new AbortController(); controller.abort();
    await expect(f.browser.execute({ action: "snapshot" }, {} as never, withAbortSignal(controller.signal, BACKGROUND_CONTEXT))).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("tracks creating operations and removes confirmed explicit closes", async () => {
    const f = fixture();
    await f.browser.execute({ action: "snapshot" }, {} as never, BACKGROUND_CONTEXT);
    expect(f.sessionOpened).not.toHaveBeenCalled();
    await f.browser.execute({ action: "open", url: "https://example.com" }, {} as never, BACKGROUND_CONTEXT);
    expect(f.sessionOpened).toHaveBeenCalledTimes(1);
    await f.browser.execute({ action: "close" }, {} as never, BACKGROUND_CONTEXT);
    expect(f.sessionClosed).toHaveBeenCalledWith(f.scope, "browser", computerUseSessionId(f.scope));
  });

  it("maps browser v2 snapshot, snapshot_mode, and batch parameters cleanly", async () => {
    const f = fixture();
    const sid = computerUseSessionId(f.scope);

    await f.browser.execute(
      { action: "open", url: "https://example.com", snapshot: false, snapshot_mode: "compact" },
      {} as never,
      BACKGROUND_CONTEXT,
    );
    expect(f.execute).toHaveBeenLastCalledWith(
      "windows-env",
      {
        tool: "browser",
        action: "open",
        sessionId: sid,
        url: "https://example.com",
        returnSnapshot: false,
        snapshotMode: "compact",
      },
      undefined,
    );

    await f.browser.execute({ action: "snapshot", snapshot_mode: "compact" }, {} as never, BACKGROUND_CONTEXT);
    expect(f.execute).toHaveBeenLastCalledWith(
      "windows-env",
      {
        tool: "browser",
        action: "snapshot",
        sessionId: sid,
        mode: "compact",
      },
      undefined,
    );

    await f.browser.execute(
      {
        action: "batch",
        snapshot: true,
        snapshot_mode: "compact",
        steps: [
          { action: "fill", ref: "@e1", text: "alice" },
          { action: "click", ref: "@e2" },
          { action: "wait", text: "Welcome", timeout_ms: 2500 },
        ],
      },
      {} as never,
      BACKGROUND_CONTEXT,
    );
    expect(f.execute).toHaveBeenLastCalledWith(
      "windows-env",
      {
        tool: "browser",
        action: "batch",
        sessionId: sid,
        returnSnapshot: true,
        snapshotMode: "compact",
        steps: [
          { action: "fill", ref: "@e1", text: "alice" },
          { action: "click", ref: "@e2" },
          { action: "wait", text: "Welcome", timeoutMs: 2500 },
        ],
      },
      undefined,
    );
  });

  it("rejects mutating browser batch in readOnly mode while allowing read-only batch steps", async () => {
    const f = fixture(true);
    await expect(
      f.browser.execute(
        { action: "batch", steps: [{ action: "snapshot" }, { action: "click", ref: "@e1" }] },
        {} as never,
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow("只读");
    await expect(
      f.browser.execute(
        { action: "batch", steps: [{ action: "fill", ref: "@e1", text: "secret" }] },
        {} as never,
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow("只读");
    expect(f.execute).not.toHaveBeenCalled();

    await f.browser.execute(
      { action: "batch", steps: [{ action: "get-url" }, { action: "snapshot", mode: "compact" }] },
      {} as never,
      BACKGROUND_CONTEXT,
    );
    expect(f.execute).toHaveBeenCalledWith(
      "windows-env",
      {
        tool: "browser",
        action: "batch",
        sessionId: computerUseSessionId(f.scope),
        steps: [{ action: "get-url" }, { action: "snapshot", mode: "compact" }],
      },
      undefined,
    );
  });

  it("rejects invalid batch steps and surfaces transferred-session tombstone errors", async () => {
    const f = fixture();
    await expect(
      f.browser.execute({ action: "batch", steps: [] }, {} as never, BACKGROUND_CONTEXT),
    ).rejects.toThrow("参数无效");
    await expect(
      f.browser.execute(
        { action: "batch", steps: [{ action: "open", url: "https://example.com" }] as never },
        {} as never,
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow("参数无效");
    await expect(
      f.browser.execute(
        { action: "batch", steps: [{ action: "click", ref: "@e1", mode: "compact" }] as never },
        {} as never,
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow("参数无效");
    expect(f.execute).not.toHaveBeenCalled();

    vi.mocked(f.scope.assertActive).mockRejectedValueOnce(new Error("浏览器会话已移交后台任务，请勿继续操作旧页面。"));
    await expect(
      f.browser.execute({ action: "get-url" }, {} as never, BACKGROUND_CONTEXT),
    ).rejects.toThrow("浏览器会话已移交后台任务");
    expect(f.execute).not.toHaveBeenCalled();
  });
});
