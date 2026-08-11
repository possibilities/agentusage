import { describe, expect, test } from "bun:test";
import { buildUsageChrome } from "../src/tui/chrome.ts";

describe("Signal Room shell chrome", () => {
  test("matches AgentVoice's live-state weight and timer tone", () => {
    const chrome = buildUsageChrome(100, false, 61_000);

    expect(chrome.context).toBe(" / CAPACITY");
    expect(chrome.status).toEqual({ text: "● LIVE", tone: "good" });
    expect(chrome.status.bold).toBeUndefined();
    expect(chrome.clock).toEqual({ text: "01:01", tone: "plain" });
    expect(chrome.clock.dim).toBeUndefined();
  });

  test("uses exact key, label, and passive-mode roles without extra dimming", () => {
    const chrome = buildUsageChrome(100, false, 0);
    const keySpans = chrome.keys.filter((span) => span.text.includes("["));
    const labelSpans = chrome.keys.filter((span) => !span.text.includes("["));

    expect(keySpans.map((span) => [span.tone, span.bold, span.dim])).toEqual([
      ["accent", true, undefined],
      ["accent", true, undefined],
      ["accent", true, undefined],
      ["accent", true, undefined],
    ]);
    expect(labelSpans.every((span) => span.tone === "muted" && span.bold === undefined && span.dim === undefined)).toBe(
      true,
    );
    expect(chrome.mode).toEqual({ text: "AUTO · 1s", tone: "muted" });
    expect(chrome.mode.dim).toBeUndefined();
  });

  test("keeps every chrome value single-line at every compression state", () => {
    for (const columns of [40, 60, 100]) {
      const chrome = buildUsageChrome(columns, true, 3_661_000);
      const text = [chrome.context, chrome.status.text, chrome.clock.text, chrome.mode.text, ...chrome.keys.map((span) => span.text)];
      expect(text.every((value) => !value.includes("\n"))).toBe(true);
    }
  });
});
