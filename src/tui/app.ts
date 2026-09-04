import type { StatePaths } from "../paths.ts";
import {
  readClaudeObservation,
  readCodexObservation,
  readGrokObservation,
  refreshClaudeObservation,
  refreshCodexObservation,
  refreshGrokObservation,
} from "../observe.ts";
import {
  effectiveClaudeFullFocus,
  effectiveCodexFullFocus,
  effectiveFableFocus,
  effectiveGrokFullFocus,
  effectiveNonFableFocus,
  readFocusLeaf,
  readFullFocusLeaf,
  type FableFocusPolicy,
  type FocusDelivery,
} from "../focus.ts";
import { buildViewModel } from "../view.ts";
import { renderFrameLines, TONE_HEX, type Line } from "../render.ts";
import { createCommandPalette } from "./palette.ts";
import { SIGNAL_GLYPHS, SIGNAL_ROOM } from "./theme.ts";

/**
 * Live usage viewer. Sidecar-backed and daemon-independent: it re-reads the
 * observation files at 1 Hz and repaints; `r` forces a provider refresh.
 *
 * Chromeless shell: no header or footer rows, and no identity row — the
 * frame is the whole surface. A transient overlay chip announces a running
 * refresh, and every action lives in the ctrl+k command palette.
 *
 * @opentui/core is imported dynamically only — its platform-native package
 * top-level-awaits and races under parallel test isolation (AGENTS.md).
 */
export async function runUsageTui(paths: StatePaths): Promise<void> {
  const core = await import("@opentui/core");
  const renderer = await core.createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    targetFps: 30,
    autoFocus: false,
    exitSignals: ["SIGTERM", "SIGHUP", "SIGQUIT"],
    backgroundColor: SIGNAL_ROOM.canvas,
  });

  const lineChunks = (line: Line): ReturnType<typeof core.bold>[] => {
    const chunks: ReturnType<typeof core.bold>[] = [];
    for (const span of line) {
      if (span.text.length === 0) continue;
      let chunk = span.tone !== undefined ? core.fg(TONE_HEX[span.tone])(span.text) : core.fg(TONE_HEX.plain)(span.text);
      if (span.bold === true) chunk = core.bold(chunk);
      if (span.dim === true) chunk = core.dim(chunk);
      chunks.push(chunk);
    }
    return chunks;
  };

  const linesToStyled = (lines: readonly Line[]): InstanceType<typeof core.StyledText> => {
    const chunks: ReturnType<typeof core.bold>[] = [];
    for (const line of lines) {
      chunks.push(...lineChunks(line));
      chunks.push(core.fg(TONE_HEX.plain)("\n"));
    }
    return new core.StyledText(chunks);
  };

  const root = new core.BoxRenderable(renderer, {
    id: "usage-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: SIGNAL_ROOM.canvas,
  });
  renderer.root.add(root);

  const scroll = new core.ScrollBoxRenderable(renderer, {
    id: "usage-scroll",
    width: "100%",
    flexGrow: 1,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: SIGNAL_ROOM.canvas,
    viewportCulling: true,
  });
  const body = new core.TextRenderable(renderer, { id: "usage-body" });
  scroll.add(body);
  root.add(scroll);

  const palette = createCommandPalette(core, renderer, "usage-palette", {
    panel: SIGNAL_ROOM.panel,
    line: SIGNAL_ROOM.line,
    accent: SIGNAL_ROOM.accent,
    muted: SIGNAL_ROOM.muted,
    text: SIGNAL_ROOM.text,
  });
  renderer.root.add(palette.root);
  // Transient feedback, not chrome: exists only while a refresh runs.
  const refreshChip = new core.BoxRenderable(renderer, {
    id: "usage-refresh-chip",
    position: "absolute",
    top: 1,
    right: 2,
    zIndex: 50,
    visible: false,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: SIGNAL_ROOM.panel,
  });
  refreshChip.add(
    new core.TextRenderable(renderer, {
      content: `${SIGNAL_GLYPHS.reset} REFRESHING`,
      fg: SIGNAL_ROOM.accent,
    }),
  );
  renderer.root.add(refreshChip);
  // Construction-time scrollbar options do not stick; the setter pins them.
  try {
    scroll.verticalScrollBar.visible = false;
    scroll.horizontalScrollBar.visible = false;
  } catch {
    // Older core builds without scrollbar accessors render fine regardless.
  }

  let refreshing = false;
  const paint = (): void => {
    const nowMs = Date.now();
    const columns = process.stdout.columns ?? 100;
    const rows = renderer.height || process.stdout.rows || 24;
    const width = Math.max(32, Math.min(columns - 4, 116));
    const claude = readClaudeObservation(paths);
    const codex = readCodexObservation(paths);
    const grok = readGrokObservation(paths);
    const fableDelivery = readFocusLeaf(paths.fableFocusLeaf, true) as FocusDelivery<FableFocusPolicy>;
    const vm = buildViewModel({
      claude,
      codex,
      grok,
      fable: effectiveFableFocus(fableDelivery, claude, nowMs),
      nonFable: effectiveNonFableFocus(readFocusLeaf(paths.nonFableFocusLeaf, false), nowMs),
      claudeFull: effectiveClaudeFullFocus(readFullFocusLeaf(paths.claudeFullFocusLeaf, "claude"), claude, nowMs),
      codexFull: effectiveCodexFullFocus(readFullFocusLeaf(paths.codexFullFocusLeaf, "codex"), codex, nowMs),
      grokFull: effectiveGrokFullFocus(readFullFocusLeaf(paths.grokFullFocusLeaf, "grok"), grok, nowMs),
      nowMs,
    });
    body.content = linesToStyled(renderFrameLines(vm, width, { title: false, density: "comfortable" }));
    refreshChip.visible = refreshing;
    palette.update({
      width: columns,
      height: rows,
      commands: [
        { id: "refresh", key: "R", label: "refresh providers", onRun: () => void refresh() },
        { id: "up", key: "K", label: "scroll up", onRun: () => scrollBy(-2) },
        { id: "down", key: "J", label: "scroll down", onRun: () => scrollBy(2) },
        { id: "top", key: "G", label: "jump to top", onRun: () => scrollTo(0) },
        { id: "bottom", key: "⇧G", label: "jump to bottom", onRun: () => scrollTo(Number.MAX_SAFE_INTEGER) },
        { id: "quit", key: "Q", label: "quit", onRun: shutdown },
      ],
    });
    renderer.requestRender();
  };

  let done!: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  const interval = setInterval(paint, 1000);
  let closed = false;
  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    renderer.destroy();
    done();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGHUP", shutdown);

  const scrollBy = (y: number): void => {
    scroll.scrollBy({ x: 0, y });
    renderer.requestRender();
  };
  const scrollTo = (y: number): void => {
    scroll.scrollTop = y;
    renderer.requestRender();
  };
  const refresh = async (): Promise<void> => {
    if (refreshing) return;
    refreshing = true;
    paint();
    await Promise.allSettled([
      refreshClaudeObservation(paths, { freshWithinMs: 0 }),
      refreshCodexObservation(paths, { freshWithinMs: 0 }),
      refreshGrokObservation(paths, { freshWithinMs: 0, providerRefresh: true }),
    ]);
    refreshing = false;
    paint();
  };

  renderer.keyInput.on("keypress", (key) => {
    if (palette.handleKey(key)) return;
    const name = key.name;
    if (name === "q" || (key.ctrl && name === "c")) {
      shutdown();
      return;
    }
    if (name === "r" && !refreshing) {
      void refresh();
      return;
    }
    if (name === "j" || name === "down") scrollBy(2);
    else if (name === "k" || name === "up") scrollBy(-2);
    else if (name === "g") scrollTo(0);
    else if (name === "G" || name === "end") scrollTo(Number.MAX_SAFE_INTEGER);
    else return;
  });

  paint();
  await finished;
}
