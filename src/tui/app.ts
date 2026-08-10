import type { StatePaths } from "../paths.ts";
import { readClaudeObservation, readCodexObservation, refreshClaudeObservation, refreshCodexObservation } from "../observe.ts";
import {
  effectiveClaudeFullFocus,
  effectiveCodexFullFocus,
  effectiveFableFocus,
  effectiveNonFableFocus,
  readFocusLeaf,
  readFullFocusLeaf,
  type FableFocusPolicy,
  type FocusDelivery,
} from "../focus.ts";
import { buildViewModel } from "../view.ts";
import { renderFrameLines, TONE_HEX, type Line } from "../render.ts";
import { SIGNAL_GLYPHS, SIGNAL_ROOM } from "./theme.ts";

/**
 * Live usage viewer. Sidecar-backed and daemon-independent: it re-reads the
 * observation files at 1 Hz and repaints; `r` forces a provider refresh.
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

  const linesToStyled = (lines: readonly Line[]): InstanceType<typeof core.StyledText> => {
    const chunks: ReturnType<typeof core.bold>[] = [];
    for (const line of lines) {
      for (const span of line) {
        if (span.text.length === 0) continue;
        let chunk = span.tone !== undefined ? core.fg(TONE_HEX[span.tone])(span.text) : core.fg(TONE_HEX.plain)(span.text);
        if (span.bold === true) chunk = core.bold(chunk);
        if (span.dim === true) chunk = core.dim(chunk);
        chunks.push(chunk);
      }
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

  const header = new core.BoxRenderable(renderer, {
    id: "usage-header",
    width: "100%",
    height: 3,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: SIGNAL_ROOM.field,
    border: ["bottom"],
    borderStyle: "single",
    borderColor: SIGNAL_ROOM.line,
  });
  const headerBrand = new core.BoxRenderable(renderer, {
    id: "usage-brand",
    flexDirection: "row",
    alignItems: "center",
    gap: 1,
    backgroundColor: SIGNAL_ROOM.field,
  });
  const headerRail = new core.TextRenderable(renderer, {
    id: "usage-brand-rail",
    content: SIGNAL_GLYPHS.rail,
    fg: SIGNAL_ROOM.accent,
  });
  const headerTitle = new core.TextRenderable(renderer, {
    id: "usage-brand-title",
    content: linesToStyled([[{ text: "AGENTUSAGE", tone: "plain", bold: true }]]),
  });
  const headerContext = new core.TextRenderable(renderer, {
    id: "usage-brand-context",
    content: "/ CAPACITY",
    fg: SIGNAL_ROOM.muted,
  });
  headerBrand.add(headerRail);
  headerBrand.add(headerTitle);
  headerBrand.add(headerContext);

  const headerPhase = new core.BoxRenderable(renderer, {
    id: "usage-phase",
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    backgroundColor: SIGNAL_ROOM.field,
  });
  const headerStatus = new core.TextRenderable(renderer, { id: "usage-status" });
  const headerClock = new core.TextRenderable(renderer, {
    id: "usage-clock",
    content: "--:--:--Z",
    fg: SIGNAL_ROOM.muted,
  });
  headerPhase.add(headerStatus);
  headerPhase.add(headerClock);
  header.add(headerBrand);
  header.add(headerPhase);
  root.add(header);

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

  const footer = new core.BoxRenderable(renderer, {
    id: "usage-footer",
    width: "100%",
    height: 3,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: SIGNAL_ROOM.field,
    border: ["top"],
    borderStyle: "single",
    borderColor: SIGNAL_ROOM.line,
  });
  const footerKeys = new core.TextRenderable(renderer, { id: "usage-keys" });
  const footerMode = new core.TextRenderable(renderer, { id: "usage-mode" });
  footer.add(footerKeys);
  footer.add(footerMode);
  root.add(footer);
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
    const width = Math.max(32, Math.min(columns - 4, 116));
    const claude = readClaudeObservation(paths);
    const codex = readCodexObservation(paths);
    const fableDelivery = readFocusLeaf(paths.fableFocusLeaf, true) as FocusDelivery<FableFocusPolicy>;
    const vm = buildViewModel({
      claude,
      codex,
      fable: effectiveFableFocus(fableDelivery, claude, nowMs),
      nonFable: effectiveNonFableFocus(readFocusLeaf(paths.nonFableFocusLeaf, false), nowMs),
      claudeFull: effectiveClaudeFullFocus(readFullFocusLeaf(paths.claudeFullFocusLeaf, "claude"), claude, nowMs),
      codexFull: effectiveCodexFullFocus(readFullFocusLeaf(paths.codexFullFocusLeaf, "codex"), codex, nowMs),
      nowMs,
    });
    const stamp = new Date(nowMs).toISOString().replace("T", " ").slice(0, 19);
    headerContext.content = columns >= 58 ? "/ CAPACITY" : "";
    const headerState = refreshing
      ? columns >= 64
        ? `${SIGNAL_GLYPHS.reset} REFRESHING`
        : SIGNAL_GLYPHS.reset
      : `${SIGNAL_GLYPHS.live} LIVE`;
    headerStatus.content = linesToStyled([
      [{ text: headerState, tone: refreshing ? "accent" : "good", bold: true }],
    ]);
    headerClock.content = columns >= 48 ? `${stamp.slice(11)}Z` : "";
    body.content = linesToStyled(renderFrameLines(vm, width, { title: false }));
    footerKeys.content = linesToStyled(
      columns < 44
        ? [
            [
              { text: "[Q]", tone: "accent", bold: true },
              { text: "  [R]", tone: "accent", bold: true },
              { text: "  [J/K]", tone: "accent", bold: true },
            ],
          ]
        : [
            [
              { text: "[Q]", tone: "accent", bold: true },
              { text: " quit  ", tone: "muted" },
              { text: "[R]", tone: "accent", bold: true },
              { text: " refresh  ", tone: "muted" },
              { text: "[J/K]", tone: "accent", bold: true },
              { text: " scroll", tone: "muted" },
              { text: columns >= 76 ? "  [G/⇧G] edge" : "", tone: "muted" },
            ],
          ],
    );
    footerMode.content = linesToStyled([[{ text: columns >= 62 ? "AUTO · 1s" : "", tone: "muted", dim: true }]]);
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

  renderer.keyInput.on("keypress", (key) => {
    const name = key.name;
    if (name === "q" || (key.ctrl && name === "c")) {
      shutdown();
      return;
    }
    if (name === "r" && !refreshing) {
      refreshing = true;
      paint();
      void Promise.allSettled([
        refreshClaudeObservation(paths, { freshWithinMs: 0 }),
        refreshCodexObservation(paths, { freshWithinMs: 0 }),
      ]).then(() => {
        refreshing = false;
        paint();
      });
      return;
    }
    if (name === "j" || name === "down") scroll.scrollBy({ x: 0, y: 2 });
    else if (name === "k" || name === "up") scroll.scrollBy({ x: 0, y: -2 });
    else if (name === "g") scroll.scrollTop = 0;
    else if (name === "G" || name === "end") scroll.scrollTop = Number.MAX_SAFE_INTEGER;
    else return;
    renderer.requestRender();
  });

  paint();
  await finished;
}
