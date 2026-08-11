import type { AccountCard, ProviderSection, Tone, UsageViewModel } from "./view.ts";
import { SIGNAL_GLYPHS, TONE_HEX } from "./tui/theme.ts";

export { TONE_HEX } from "./tui/theme.ts";

export interface Span {
  text: string;
  tone?: Tone;
  bold?: boolean;
  dim?: boolean;
}

export type Line = Span[];

const MAX_BAR_WIDTH = 40;
const MIN_BAR_WIDTH = 10;
const MAX_LABEL_WIDTH = 16;
const MIN_LABEL_WIDTH = 9;

function meterGeometry(width: number): { barWidth: number; labelWidth: number } {
  const barWidth = Math.max(MIN_BAR_WIDTH, Math.min(MAX_BAR_WIDTH, width - 44));
  const labelWidth = Math.max(MIN_LABEL_WIDTH, Math.min(MAX_LABEL_WIDTH, width - barWidth - 28));
  return { barWidth, labelWidth };
}

function bar(usedPercent: number | null, width: number): { filled: number; empty: number; overflow: boolean } {
  if (usedPercent === null) return { filled: 0, empty: width, overflow: false };
  const clamped = Math.max(0, Math.min(100, usedPercent));
  const filled = Math.round((clamped / 100) * width);
  return { filled, empty: width - filled, overflow: usedPercent > 100 };
}

function pctText(usedPercent: number | null): string {
  if (usedPercent === null) return "   — ";
  const rounded = Math.round(usedPercent * 10) / 10;
  const text = Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
  return text.padStart(6);
}

function meterLine(card: AccountCard, meter: AccountCard["meters"][number], width: number): Line {
  const { barWidth, labelWidth } = meterGeometry(width);
  const label = meter.label.length > labelWidth ? `${meter.label.slice(0, labelWidth - 1)}…` : meter.label;
  const { filled, empty, overflow } = bar(meter.usedPercent, barWidth);
  const barTone: Tone = meter.tone;
  const line: Line = [
    { text: "    " },
    { text: label.padEnd(labelWidth + 1), tone: meter.spark ? "spark" : card.stale ? "muted" : "plain", dim: card.stale },
    { text: SIGNAL_GLYPHS.meterStart, tone: "muted" },
    { text: SIGNAL_GLYPHS.meterFull.repeat(filled), tone: barTone },
    { text: SIGNAL_GLYPHS.meterEmpty.repeat(empty), tone: "muted", dim: true },
    { text: SIGNAL_GLYPHS.meterEnd, tone: "muted" },
    { text: pctText(meter.usedPercent), tone: barTone, bold: !card.stale && meter.usedPercent !== null && meter.usedPercent >= 80 },
  ];
  if (overflow) line.push({ text: "!", tone: "over", bold: true });
  if (meter.resetText !== null && width >= 44) {
    line.push({ text: `  ${SIGNAL_GLYPHS.reset} `, tone: "muted", dim: true });
    line.push({ text: meter.resetText, tone: card.stale ? "muted" : "plain", dim: card.stale });
  }
  return line;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return max <= 1 ? "…" : `${text.slice(0, max - 1)}…`;
}

function clipLine(line: Line, width: number): Line {
  const clipped: Line = [];
  let used = 0;
  for (const span of line) {
    const remaining = width - used;
    if (remaining <= 0) break;
    if (span.text.length <= remaining) {
      clipped.push(span);
      used += span.text.length;
      continue;
    }
    clipped.push({ ...span, text: truncate(span.text, remaining) });
    break;
  }
  return clipped;
}

function cardLines(card: AccountCard, width: number, comfortable: boolean): Line[] {
  const header: Line = [
    { text: "  " },
    { text: `${card.stale ? SIGNAL_GLYPHS.idle : SIGNAL_GLYPHS.live} `, tone: card.stale ? "muted" : "good" },
    { text: card.name, bold: true, tone: card.stale ? "muted" : "plain" },
  ];
  if (card.status !== null) {
    header.push({ text: "  ", tone: "muted" });
    header.push({ text: card.status, tone: "over", bold: true });
  }
  for (const focusBadge of card.focus) {
    header.push({ text: `  [${focusBadge.toUpperCase()}]`, tone: "accent", bold: true });
  }
  const lines: Line[] = [header];
  const metadata = [card.detail, card.measuredAgo === null ? null : `sampled ${card.measuredAgo} ago`]
    .filter((part): part is string => part !== null)
    .join(" · ");
  if (metadata.length > 0) {
    lines.push([{ text: `    ${truncate(metadata, Math.max(12, width - 4))}`, tone: "muted", dim: true }]);
  }
  if (comfortable) lines.push([]);
  if (card.meters.length === 0) {
    lines.push([{ text: "    no usage data", tone: "muted", dim: true }]);
  } else {
    for (const meter of card.meters) lines.push(meterLine(card, meter, width));
  }
  return lines;
}

function sectionLines(section: ProviderSection, width: number, comfortable: boolean): Line[] {
  const label = section.provider.toUpperCase();
  const meta = section.health === "ok" ? section.ageText.toUpperCase() : `${section.health.toUpperCase()} · ${section.ageText}`;
  const leadWidth = 2 + label.length;
  const gap = Math.max(2, width - leadWidth - meta.length);
  const headline: Line = [
    { text: `${SIGNAL_GLYPHS.rail} `, tone: "accent", bold: true },
    { text: label, tone: "plain", bold: true },
    { text: " ".repeat(gap) },
    { text: meta, tone: section.health !== "ok" ? "over" : section.fresh ? "muted" : "hot", bold: section.health !== "ok" },
  ];
  const lines: Line[] = [headline, []];
  if (section.cards.length === 0) {
    lines.push([{ text: "  no accounts observed", tone: "muted", dim: true }]);
  }
  for (const card of section.cards) {
    lines.push(...cardLines(card, width, comfortable));
    lines.push([]);
    if (comfortable) lines.push([]);
  }
  for (const note of section.notes) {
    lines.push([{ text: `  ⚠ ${note}`, tone: "warn", dim: true }]);
  }
  const desiredTrailingSpace = comfortable ? 2 : 1;
  let trailingSpace = 0;
  for (let index = lines.length - 1; index >= 0 && lines[index]?.length === 0; index -= 1) {
    trailingSpace += 1;
  }
  while (trailingSpace < desiredTrailingSpace) {
    lines.push([]);
    trailingSpace += 1;
  }
  return lines;
}

export function renderFrameLines(
  vm: UsageViewModel,
  width: number,
  options: { title?: boolean; density?: "compact" | "comfortable" } = {},
): Line[] {
  const frameWidth = Math.max(32, width);
  const comfortable = options.density === "comfortable";
  const lines: Line[] = [];
  if (options.title !== false) {
    const stamp = new Date(vm.nowMs).toISOString().replace("T", " ").slice(0, 19);
    const product = "AGENTUSAGE / CAPACITY";
    const time = `${stamp}Z`;
    if (frameWidth >= product.length + time.length + 4) {
      const gap = frameWidth - product.length - time.length - 2;
      lines.push([
        { text: `${SIGNAL_GLYPHS.rail} `, tone: "accent", bold: true },
        { text: product, tone: "plain", bold: true },
        { text: " ".repeat(gap) },
        { text: time, tone: "muted", dim: true },
      ]);
    } else {
      lines.push([
        { text: `${SIGNAL_GLYPHS.rail} `, tone: "accent", bold: true },
        { text: product, tone: "plain", bold: true },
      ]);
      lines.push([{ text: `  ${time}`, tone: "muted", dim: true }]);
    }
    lines.push([{ text: SIGNAL_GLYPHS.rule.repeat(frameWidth), tone: "muted", dim: true }]);
    lines.push([]);
  }

  for (const section of [vm.claude, vm.codex]) {
    if (section === null) continue;
    lines.push(...sectionLines(section, frameWidth, comfortable));
  }
  if (vm.claude === null && vm.codex === null) {
    lines.push([{ text: "  no observations yet — run `agentusage refresh` or install the daemon", tone: "muted" }]);
    lines.push([]);
  }

  lines.push([
    { text: `${SIGNAL_GLYPHS.rail} `, tone: "accent", bold: true },
    { text: "FOCUS", tone: "plain", bold: true },
  ]);
  lines.push([]);
  for (const focus of vm.focus) {
    const line: Line = [{ text: `  ${focus.kind.toUpperCase().padEnd(12)}`, tone: "plain" }];
    if (focus.state === "off") {
      line.push({ text: "off", tone: "muted", dim: true });
    } else {
      line.push({
        text: focus.state,
        tone: focus.state === "active" ? "good" : focus.state === "completed" ? "spark" : "warn",
        bold: focus.state === "active",
      });
      if (focus.target !== null) line.push({ text: `  → ${focus.target}`, tone: "plain", bold: true });
      if (focus.lifetime !== null) {
        const lifetime = `  (${focus.lifetime})`;
        const currentWidth = line.reduce((total, span) => total + span.text.length, 0);
        if (currentWidth + lifetime.length <= frameWidth) {
          line.push({ text: lifetime, tone: "muted" });
        } else {
          lines.push(line);
          lines.push([{ text: `    ${focus.lifetime}`, tone: "muted", dim: true }]);
          continue;
        }
      }
    }
    lines.push(line);
  }
  return lines.map((line) => clipLine(line, frameWidth));
}

const ANSI_RESET = "[0m";

function hexToAnsiFg(hex: string): string {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `[38;2;${r};${g};${b}m`;
}

export function linesToText(lines: readonly Line[], color: boolean): string {
  const rendered = lines.map((line) => {
    let text = "";
    for (const span of line) {
      if (span.text.length === 0) continue;
      if (!color) {
        text += span.text;
        continue;
      }
      let prefix = "";
      if (span.tone !== undefined) prefix += hexToAnsiFg(TONE_HEX[span.tone]);
      if (span.bold === true) prefix += "[1m";
      if (span.dim === true) prefix += "[2m";
      text += prefix.length > 0 ? `${prefix}${span.text}${ANSI_RESET}` : span.text;
    }
    return text;
  });
  return `${rendered.join("\n")}\n`;
}
