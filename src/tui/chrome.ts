import type { Line, Span } from "../render.ts";
import { formatClock } from "../view.ts";
import { SIGNAL_GLYPHS } from "./theme.ts";

export interface UsageChrome {
  context: string;
  status: Span;
  clock: Span;
  keys: Line;
  mode: Span;
}

/** Pure Signal Room shell state; every field is deliberately single-line. */
export function buildUsageChrome(columns: number, refreshing: boolean, elapsedMs: number): UsageChrome {
  const statusText = refreshing
    ? columns >= 64
      ? `${SIGNAL_GLYPHS.reset} REFRESHING`
      : SIGNAL_GLYPHS.reset
    : `${SIGNAL_GLYPHS.live} LIVE`;
  const keys: Line =
    columns < 44
      ? [
          { text: "[Q]", tone: "accent", bold: true },
          { text: "  [R]", tone: "accent", bold: true },
          { text: "  [J/K]", tone: "accent", bold: true },
        ]
      : [
          { text: "[Q]", tone: "accent", bold: true },
          { text: " quit  ", tone: "muted" },
          { text: "[R]", tone: "accent", bold: true },
          { text: " refresh  ", tone: "muted" },
          { text: "[J/K]", tone: "accent", bold: true },
          { text: " scroll", tone: "muted" },
          ...(columns >= 76
            ? ([
                { text: "  [G/⇧G]", tone: "accent", bold: true },
                { text: " edge", tone: "muted" },
              ] satisfies Line)
            : []),
        ];

  return {
    context: columns >= 58 ? " / CAPACITY" : "",
    status: { text: statusText, tone: refreshing ? "accent" : "good" },
    clock: {
      text: columns >= 48 ? formatClock(elapsedMs) : "",
      tone: columns >= 48 ? "plain" : "muted",
    },
    keys,
    mode: { text: columns >= 62 ? "AUTO · 1s" : "", tone: "muted" },
  };
}
