import type { StatePaths } from "../paths.ts";
import { readClaudeObservation, readCodexObservation, refreshClaudeObservation, refreshCodexObservation } from "../observe.ts";
import { effectiveFableFocus, effectiveNonFableFocus, readFocusLeaf, type FableFocusPolicy, type FocusDelivery } from "../focus.ts";
import { buildViewModel } from "../view.ts";
import { renderFrameLines, TONE_HEX, type Line } from "../render.ts";
import { VERSION } from "../version.ts";

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

  const header = new core.TextRenderable(renderer, {
    id: "usage-header",
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 2,
  });
  const footer = new core.TextRenderable(renderer, {
    id: "usage-footer",
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 2,
  });
  const scroll = new core.ScrollBoxRenderable(renderer, {
    id: "usage-scroll",
    position: "absolute",
    top: 1,
    left: 0,
    right: 0,
    bottom: 1,
    viewportCulling: true,
  });
  const body = new core.TextRenderable(renderer, { id: "usage-body" });
  scroll.add(body);
  renderer.root.add(header);
  renderer.root.add(scroll);
  renderer.root.add(footer);
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
    const width = Math.min(process.stdout.columns ?? 100, 120);
    const claude = readClaudeObservation(paths);
    const codex = readCodexObservation(paths);
    const fableDelivery = readFocusLeaf(paths.fableFocusLeaf, true) as FocusDelivery<FableFocusPolicy>;
    const vm = buildViewModel({
      claude,
      codex,
      fable: effectiveFableFocus(fableDelivery, claude, nowMs),
      nonFable: effectiveNonFableFocus(readFocusLeaf(paths.nonFableFocusLeaf, false), nowMs),
      nowMs,
    });
    const stamp = new Date(nowMs).toISOString().replace("T", " ").slice(0, 19);
    header.content = linesToStyled([
      [
        { text: ` agentusage ${VERSION}`, tone: "accent", bold: true },
        { text: refreshing ? "  ⟳ refreshing…" : "", tone: "spark" },
        { text: `  ${stamp}Z `.padStart(Math.max(0, width - 20 - (refreshing ? 15 : 0))), tone: "muted", dim: true },
      ],
    ]);
    body.content = linesToStyled(renderFrameLines(vm, width, { title: false }));
    footer.content = linesToStyled([
      [
        { text: " q", tone: "accent", bold: true },
        { text: " quit  ", tone: "muted" },
        { text: "r", tone: "accent", bold: true },
        { text: " refresh  ", tone: "muted" },
        { text: "j/k", tone: "accent", bold: true },
        { text: " scroll  ", tone: "muted" },
        { text: "g/G", tone: "accent", bold: true },
        { text: " top/bottom", tone: "muted" },
      ],
    ]);
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
