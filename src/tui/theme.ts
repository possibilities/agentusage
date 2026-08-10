import type { Tone } from "../view.ts";

/**
 * Signal Room: the shared arthack instrument-panel palette.
 *
 * Full-screen TUIs paint these surfaces deliberately. Snapshot output keeps
 * backgrounds transparent, but uses the same foreground roles.
 */
export const SIGNAL_ROOM = {
  canvas: "#090c0e",
  field: "#0d1215",
  panel: "#131a1e",
  line: "#2a343a",
  text: "#d8e2e7",
  muted: "#7d8a91",
  faint: "#4b575e",
  accent: "#67d7c9",
  local: "#e2b56f",
  remote: "#7fb9e8",
  ok: "#82cb9a",
  hot: "#e6965b",
  danger: "#ee7e89",
} as const;

export const TONE_HEX = {
  good: SIGNAL_ROOM.ok,
  warn: SIGNAL_ROOM.local,
  hot: SIGNAL_ROOM.hot,
  over: SIGNAL_ROOM.danger,
  muted: SIGNAL_ROOM.muted,
  accent: SIGNAL_ROOM.accent,
  spark: SIGNAL_ROOM.remote,
  plain: SIGNAL_ROOM.text,
} as const satisfies Record<Tone, string>;

export const SIGNAL_GLYPHS = {
  rail: "▎",
  live: "●",
  idle: "○",
  rule: "─",
  meterStart: "▕",
  meterEnd: "▏",
  meterFull: "█",
  meterEmpty: "░",
  reset: "↻",
} as const;
