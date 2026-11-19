import { afterEach, describe, expect, it, vi } from "vitest";
import { copyDeviceTextWhenReady } from "./device-clipboard";

afterEach(() => vi.unstubAllGlobals());

describe("copying an asynchronously issued invitation", () => {
  it("starts the clipboard write inside the user gesture before the instruction is available", async () => {
    let deliver!: (value: string) => void;
    const instruction = new Promise<string>((resolve) => { deliver = resolve; });
    class Item { constructor(readonly types: Record<string, Promise<Blob>>) {} }
    const write = vi.fn(async ([item]: Item[]) => { expect(await (await item!.types["text/plain"]!).text()).toBe("test instruction"); });
    vi.stubGlobal("ClipboardItem", Item);
    vi.stubGlobal("navigator", { clipboard: { write } });
    const copied = copyDeviceTextWhenReady(instruction);
    expect(write).toHaveBeenCalledOnce();
    deliver("test instruction");
    await copied;
  });

  it("falls back to a text write with the same instruction when a browser rejects a promised clipboard item", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", class {});
    vi.stubGlobal("navigator", { clipboard: { write: vi.fn().mockRejectedValue(new Error("Unsupported item")), writeText } });
    await copyDeviceTextWhenReady(Promise.resolve("test instruction"));
    expect(writeText).toHaveBeenCalledWith("test instruction");
    await expect(copyDeviceTextWhenReady(Promise.reject(new Error("Expired session")))).rejects.toThrow("Expired session");
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});
