import type { AccountCard, ProviderSection, Tone, UsageViewModel } from "./view.ts";

export interface Span {
  text: string;
  tone?: Tone;
  bold?: boolean;
  dim?: boolean;
}

export type Line = Span[];

export const TONE_HEX: Record<Tone, string> = {
  good: "#34d399",
  warn: "#fbbf24",
  hot: "#fb923c",
  over: "#f87171",
  muted: "#7b8494",
  accent: "#a78bfa",
  spark: "#22d3ee",
  plain: "#d4d8e1",
};

const BAR_WIDTH = 22;
const LABEL_WIDTH = 16;

function bar(usedPercent: number | null): { filled: number; empty: number; overflow: boolean } {
  if (usedPercent === null) return { filled: 0, empty: BAR_WIDTH, overflow: false };
  const clamped = Math.max(0, Math.min(100, usedPercent));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  return { filled, empty: BAR_WIDTH - filled, overflow: usedPercent > 100 };
}

function pctText(usedPercent: number | null): string {
  if (usedPercent === null) return "   — ";
  const rounded = Math.round(usedPercent * 10) / 10;
  const text = Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
  return text.padStart(6);
}

function meterLine(card: AccountCard, meter: AccountCard["meters"][number]): Line {
  const label = meter.label.length > LABEL_WIDTH ? `${meter.label.slice(0, LABEL_WIDTH - 1)}…` : meter.label;
  const { filled, empty, overflow } = bar(meter.usedPercent);
  const barTone: Tone = meter.tone;
  const line: Line = [
    { text: "    " },
    { text: label.padEnd(LABEL_WIDTH + 1), tone: meter.spark ? "spark" : card.stale ? "muted" : "plain", dim: card.stale },
    { text: "▕", tone: "muted" },
    { text: "█".repeat(filled), tone: barTone },
    { text: "░".repeat(empty), tone: "muted", dim: true },
    { text: "▏", tone: "muted" },
    { text: pctText(meter.usedPercent), tone: barTone, bold: !card.stale && meter.usedPercent !== null && meter.usedPercent >= 80 },
  ];
  if (overflow) line.push({ text: "!", tone: "over", bold: true });
  if (meter.resetText !== null) {
    line.push({ text: "  ↻ ", tone: "muted", dim: true });
    line.push({ text: meter.resetText, tone: card.stale ? "muted" : "plain", dim: card.stale });
  }
  return line;
}

function cardLines(card: AccountCard): Line[] {
  const header: Line = [
    { text: "  " },
    { text: card.stale ? "○ " : "● ", tone: card.stale ? "muted" : card.provider === "codex" ? "spark" : "accent" },
    { text: card.name, bold: true, tone: card.stale ? "muted" : "plain" },
  ];
  if (card.detail !== null) {
    header.push({ text: ` · ${card.detail}`, tone: "muted" });
  }
  if (card.status !== null) {
    header.push({ text: "  [", tone: "muted" });
    header.push({ text: card.status, tone: "over", bold: true });
    header.push({ text: "]", tone: "muted" });
  }
  for (const focusBadge of card.focus) {
    header.push({ text: `  ⟨${focusBadge}⟩`, tone: "accent", bold: true });
  }
  if (card.measuredAgo !== null) {
    header.push({ text: `  measured ${card.measuredAgo} ago`, tone: "muted", dim: true });
  }
  const lines: Line[] = [header];
  if (card.meters.length === 0) {
    lines.push([{ text: "    no usage data", tone: "muted", dim: true }]);
  } else {
    for (const meter of card.meters) lines.push(meterLine(card, meter));
  }
  return lines;
}

function sectionLines(section: ProviderSection, width: number): Line[] {
  const title = ` ${section.provider} · ${section.ageText} `;
  const ruleWidth = Math.max(8, width - title.length - 4);
  const headline: Line = [
    { text: "── ", tone: "muted" },
    { text: section.provider, tone: section.provider === "codex" ? "spark" : "accent", bold: true },
    { text: ` · ${section.ageText}`, tone: section.fresh ? "muted" : "hot" },
    section.health !== "ok" ? { text: ` · ${section.health}`, tone: "over", bold: true } : { text: "" },
    { text: ` ${"─".repeat(Math.max(4, ruleWidth))}`, tone: "muted" },
  ];
  const lines: Line[] = [headline, []];
  if (section.cards.length === 0) {
    lines.push([{ text: "  no accounts observed", tone: "muted", dim: true }]);
  }
  for (const card of section.cards) {
    lines.push(...cardLines(card));
    lines.push([]);
  }
  for (const note of section.notes) {
    lines.push([{ text: `  ⚠ ${note}`, tone: "warn", dim: true }]);
  }
  return lines;
}

export function renderFrameLines(vm: UsageViewModel, width: number, options: { title?: boolean } = {}): Line[] {
  const lines: Line[] = [];
  if (options.title !== false) {
    const stamp = new Date(vm.nowMs).toISOString().replace("T", " ").slice(0, 19);
    lines.push([
      { text: " agentusage", tone: "accent", bold: true },
      { text: `  ${stamp}Z`.padStart(Math.max(0, width - 12)), tone: "muted", dim: true },
    ]);
    lines.push([]);
  }

  for (const section of [vm.claude, vm.codex]) {
    if (section === null) continue;
    lines.push(...sectionLines(section, width));
  }
  if (vm.claude === null && vm.codex === null) {
    lines.push([{ text: "  no observations yet — run `agentusage refresh` or install the daemon", tone: "muted" }]);
    lines.push([]);
  }

  lines.push([
    { text: "── ", tone: "muted" },
    { text: "focus", tone: "accent", bold: true },
    { text: ` ${"─".repeat(Math.max(4, width - 12))}`, tone: "muted" },
  ]);
  for (const focus of vm.focus) {
    const line: Line = [{ text: `  ${focus.kind.padEnd(10)}`, tone: "plain" }];
    if (focus.state === "off") {
      line.push({ text: "off", tone: "muted", dim: true });
    } else {
      line.push({
        text: focus.state,
        tone: focus.state === "active" ? "good" : focus.state === "completed" ? "spark" : "warn",
        bold: focus.state === "active",
      });
      if (focus.target !== null) line.push({ text: `  → ${focus.target}`, tone: "plain", bold: true });
      if (focus.lifetime !== null) line.push({ text: `  (${focus.lifetime})`, tone: "muted" });
    }
    lines.push(line);
  }
  return lines;
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
