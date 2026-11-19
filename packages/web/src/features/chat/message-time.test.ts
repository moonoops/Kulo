import { describe, expect, it } from "vitest";
import { formatMessageTime } from "./message-time";

describe("chat message time", () => {
  const now = new Date(2026, 10, 17, 12, 0);

  it("shows local 24-hour time today and retains the complete timestamp", () => {
    const date = new Date(2026, 10, 17, 9, 5, 30);
    const formatted = formatMessageTime(date.getTime(), now);
    expect(formatted?.label).toBe("09:05");
    expect(formatted?.dateTime).toBe(date.toISOString());
    expect(formatted?.title).toMatch(/^2026-11-17 09:05:30 UTC[+-]\d{2}:\d{2}$/);
    expect(formatMessageTime(new Date(2026, 10, 17, 0, 3).getTime(), now)?.label).toBe("00:03");
  });

  it("includes the local calendar date for messages from another day", () => {
    expect(formatMessageTime(new Date(2026, 10, 16, 23, 8).getTime(), now)?.label).toBe("11-16 23:08");
    expect(formatMessageTime(new Date(2026, 0, 1, 10, 20).getTime(), now)?.label).toBe("01-01 10:20");
    expect(formatMessageTime(new Date(2025, 11, 31, 23, 59).getTime(), now)?.label).toBe("2025-12-31 23:59");
  });

  it("omits absent or invalid timestamps instead of inventing a send time", () => {
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_VALUE]) {
      expect(formatMessageTime(value, now)).toBeUndefined();
    }
    expect(formatMessageTime(0, now)?.dateTime).toBe("1970-01-01T00:00:00.000Z");
  });
});
