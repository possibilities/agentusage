import type { Line, Span } from "../render.ts";
import { formatClock } from "../view.ts";
import { SIGNAL_GLYPHS } from "./theme.ts";

/**
 * The chromeless shell's one identity/status line: body content at the top of
 * the scroll, never a pinned masthead. Right side carries the palette
 * affordance only while it fits whole.
 */
export function buildUsageStatus(width: number, refreshing: boolean, elapsedMs: number): Line {
  const spans: Span[] = [
    { text: `${SIGNAL_GLYPHS.rail} `, tone: "accent", bold: true },
    { text: "AGENTUSAGE", tone: "plain", bold: true },
    refreshing
      ? { text: `  ${SIGNAL_GLYPHS.reset} REFRESHING`, tone: "accent" }
      : { text: `  ${SIGNAL_GLYPHS.live} LIVE`, tone: "good" },
    { text: `  ${formatClock(elapsedMs)}`, tone: "plain" },
  ];
  if (width >= 64) spans.push({ text: "  ·  AUTO / 1s", tone: "muted" });
  const hint = "⌃K commands";
  const used = spans.reduce((sum, span) => sum + span.text.length, 0);
  const gap = width - used - hint.length;
  if (width >= 48 && gap >= 2) {
    spans.push({ text: " ".repeat(gap) });
    spans.push({ text: hint, tone: "muted" });
  }
  return spans;
}
