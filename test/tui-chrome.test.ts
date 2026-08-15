import { describe, expect, test } from "bun:test";
import { buildUsageStatus } from "../src/tui/chrome.ts";

const text = (line: ReturnType<typeof buildUsageStatus>): string =>
  line.map((span) => span.text).join("");

describe("chromeless status line", () => {
  test("carries identity, live state, elapsed, cadence, and the palette hint", () => {
    const line = buildUsageStatus(100, false, 61_000);
    const flat = text(line);
    expect(flat).toContain("▎ AGENTUSAGE");
    expect(flat).toContain("● LIVE");
    expect(flat).toContain("01:01");
    expect(flat).toContain("AUTO / 1s");
    expect(flat).toContain("⌃K commands");
    expect(flat.length).toBe(100);
    const status = line.find((span) => span.text.includes("LIVE"));
    expect(status?.tone).toBe("good");
    expect(status?.bold).toBeUndefined();
  });

  test("swaps live state for the transient refresh without a third cluster", () => {
    const line = buildUsageStatus(100, true, 0);
    const flat = text(line);
    expect(flat).toContain("↻ REFRESHING");
    expect(flat).not.toContain("● LIVE");
    expect(line.find((span) => span.text.includes("REFRESHING"))?.tone).toBe("accent");
  });

  test("drops cadence then the hint under width pressure, never wrapping", () => {
    for (const width of [32, 40, 47, 63, 100]) {
      const line = buildUsageStatus(width, false, 3_661_000);
      const flat = text(line);
      expect(flat.includes("\n")).toBe(false);
      expect(flat.length).toBeLessThanOrEqual(width);
      expect(flat).toContain("1:01:01");
      if (width < 64) expect(flat).not.toContain("AUTO / 1s");
      if (width < 48) expect(flat).not.toContain("⌃K");
    }
    expect(text(buildUsageStatus(100, false, 0))).toContain("⌃K commands");
  });
});
