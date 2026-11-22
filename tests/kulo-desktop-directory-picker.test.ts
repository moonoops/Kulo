import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureDesktopDirectoryPickerHandlers,
  createDesktopDirectoryPicker,
  DESKTOP_PICK_DIRECTORY_CHANNEL,
} from "../packages/desktop/src/directory-picker.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kulo-dir-picker-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("desktop native directory picker", () => {
  it("keeps preload.cts sandbox-safe with type-only imports and matching IPC channel literal", async () => {
    const preloadSource = await fs.readFile(path.join(repoRoot, "packages/desktop/src/preload.cts"), "utf8");
    expect(preloadSource).toContain(`"${DESKTOP_PICK_DIRECTORY_CHANNEL}"`);
    expect(preloadSource).toMatch(/import\s+type\s+\{[^}]*\}\s+from\s+"\.\/directory-picker\.js"/);
    expect(preloadSource).not.toMatch(/import\s+(?!type\b)[^;\n]*from\s+"\.\/directory-picker\.js"/);
    expect(preloadSource).not.toMatch(/require\(["']\.\/directory-picker(?:\.js|\.cjs)?["']\)/);
  });

  it("omits defaultPath when none or blank is given so macOS preserves last visited folder", async () => {
    const root = await makeTempDir();
    const chooseDirectory = vi.fn(async () => root);
    const picker = createDesktopDirectoryPicker({
      homeDirectory: () => root,
      chooseDirectory,
    });

    await expect(picker.pickDirectory()).resolves.toBe(root);
    await expect(picker.pickDirectory({})).resolves.toBe(root);
    await expect(picker.pickDirectory({ defaultPath: undefined })).resolves.toBe(root);
    await expect(picker.pickDirectory({ defaultPath: "   " })).resolves.toBe(root);
    expect(chooseDirectory.mock.calls).toEqual([[undefined], [undefined], [undefined], [undefined]]);
  });

  it("resolves existing directories, expands tilde paths, and walks up missing or file subpaths", async () => {
    const root = await makeTempDir();
    const nested = path.join(root, "projects", "kulo");
    await fs.mkdir(nested, { recursive: true });
    const filePath = path.join(nested, "README.md");
    await fs.writeFile(filePath, "hi");

    const seenDefaults: Array<string | undefined> = [];
    const picker = createDesktopDirectoryPicker({
      homeDirectory: () => root,
      chooseDirectory: async (defaultPath) => {
        seenDefaults.push(defaultPath);
        return nested;
      },
    });

    await expect(picker.pickDirectory({ defaultPath: nested })).resolves.toBe(nested);
    await expect(picker.pickDirectory({ defaultPath: "~" })).resolves.toBe(nested);
    await expect(picker.pickDirectory({ defaultPath: "~/projects/kulo" })).resolves.toBe(nested);
    await expect(picker.pickDirectory({ defaultPath: path.join(nested, "missing", "child") })).resolves.toBe(nested);
    await expect(picker.pickDirectory({ defaultPath: path.join(filePath, "child") })).resolves.toBe(nested);
    await expect(picker.pickDirectory({ defaultPath: "relative/folder" })).resolves.toBe(nested);

    expect(seenDefaults).toEqual([
      path.resolve(nested),
      path.resolve(root),
      path.resolve(nested),
      path.resolve(nested),
      path.resolve(nested),
      undefined,
    ]);
  });

  it("expands Windows tilde backslash paths when platform is win32", async () => {
    const seenDefaults: Array<string | undefined> = [];
    const stat = vi.fn(async (target: string) => {
      if (target === "C:\\Users\\demo\\Code") return { isDirectory: () => true };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const picker = createDesktopDirectoryPicker({
      platform: "win32",
      homeDirectory: () => "C:\\Users\\demo",
      stat,
      chooseDirectory: async (defaultPath) => {
        seenDefaults.push(defaultPath);
        return "C:\\Users\\demo\\Code\\App";
      },
    });

    await expect(picker.pickDirectory({ defaultPath: "~\\Code\\missing" })).resolves.toBe("C:\\Users\\demo\\Code\\App");
    expect(seenDefaults).toEqual(["C:\\Users\\demo\\Code"]);
  });

  it("falls back to undefined when stat hangs on an unresponsive mount without leaking timers", async () => {
    const seenDefaults: Array<string | undefined> = [];
    const picker = createDesktopDirectoryPicker({
      homeDirectory: () => "/Users/demo",
      resolveTimeoutMs: 25,
      stat: () => new Promise(() => {}),
      chooseDirectory: async (defaultPath) => {
        seenDefaults.push(defaultPath);
        return "/Users/demo/Projects";
      },
    });

    await expect(picker.pickDirectory({ defaultPath: "/Volumes/DeadShare/repo" })).resolves.toBe("/Users/demo/Projects");
    expect(seenDefaults).toEqual([undefined]);
  });

  it("returns null on cancellation, preserves whitespace in returned folder names, and rejects invalid outputs", async () => {
    let reply: string | undefined;
    const picker = createDesktopDirectoryPicker({
      homeDirectory: () => "/Users/demo",
      chooseDirectory: async () => reply,
    });

    reply = undefined;
    await expect(picker.pickDirectory()).resolves.toBeNull();
    reply = "";
    await expect(picker.pickDirectory()).resolves.toBeNull();
    reply = "/Users/demo/ Folder With Spaces ";
    await expect(picker.pickDirectory()).resolves.toBe("/Users/demo/ Folder With Spaces ");
    reply = "relative/path";
    await expect(picker.pickDirectory()).rejects.toThrow("目录路径无效");
    reply = "/Users/demo/bad\0path";
    await expect(picker.pickDirectory()).rejects.toThrow("目录路径无效");
  });

  it("validates inputs before single-flight deduplication and deduplicates concurrent valid picks", async () => {
    const queue: Array<(value: string | undefined) => void> = [];
    const entered: Array<() => void> = [];
    const waitForChoose = () => new Promise<void>((resolve) => {
      if (queue.length) resolve();
      else entered.push(resolve);
    });
    const chooseDirectory = vi.fn(() => new Promise<string | undefined>((resolve) => {
      queue.push(resolve);
      entered.shift()?.();
    }));
    const picker = createDesktopDirectoryPicker({
      homeDirectory: () => "/Users/demo",
      chooseDirectory,
    });

    const first = picker.pickDirectory();
    const second = picker.pickDirectory({ defaultPath: undefined });
    expect(second).toBe(first);

    // Invalid calls must reject immediately rather than hitching a ride on the in-flight dialog.
    for (const invalid of [null, "str", 123, [], new Date(), { extra: true }, { defaultPath: 42 }, { defaultPath: "/bad\npath" }, { defaultPath: `/${"a".repeat(9000)}` }]) {
      await expect(picker.pickDirectory(invalid)).rejects.toThrow(/参数无效|路径无效/);
    }

    await waitForChoose();
    queue.shift()!("/Users/demo/Moco");
    await expect(first).resolves.toBe("/Users/demo/Moco");
    await expect(second).resolves.toBe("/Users/demo/Moco");
    expect(chooseDirectory).toHaveBeenCalledTimes(1);

    // Subsequent pick after completion opens cleanly again.
    const third = picker.pickDirectory();
    await waitForChoose();
    queue.shift()!(undefined);
    await expect(third).resolves.toBeNull();
    expect(chooseDirectory).toHaveBeenCalledTimes(2);
  });

  it("enforces trusted renderer sender and argument count in IPC registration", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipc = {
      handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, listener);
      },
    };
    const picker = createDesktopDirectoryPicker({
      homeDirectory: () => "/Users/demo",
      chooseDirectory: async () => "/Users/demo/Moco",
    });

    const mainFrame = { origin: "http://127.0.0.1:7799" };
    const webContents = { mainFrame, isDestroyed: () => false };
    const owner = { isDestroyed: () => false, webContents };

    configureDesktopDirectoryPickerHandlers({
      ipc: ipc as never,
      picker,
      owner: () => owner,
      rendererOrigin: () => "http://127.0.0.1:7799",
    });

    const handler = handlers.get(DESKTOP_PICK_DIRECTORY_CHANNEL);
    expect(handler).toBeTypeOf("function");

    const trustedEvent = { sender: webContents, senderFrame: mainFrame };
    const untrustedEvent = { sender: webContents, senderFrame: { origin: "https://evil.example" } };

    expect(() => handler!(untrustedEvent)).toThrow("无法从此页面选择本机目录");
    expect(() => handler!(trustedEvent, {}, "extra")).toThrow("目录选择参数无效");
    await expect(handler!(trustedEvent)).resolves.toBe("/Users/demo/Moco");
  });
});
