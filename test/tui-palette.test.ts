import { describe, expect, test } from "bun:test";
import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createCommandPalette, type PaletteCommand, paletteMatches } from "../src/tui/palette.ts";

const TOKENS = {
  panel: "#131a1e",
  line: "#333333",
  accent: "#00ffff",
  muted: "#999999",
  text: "#eeeeee",
};

const commands = (ran: string[] = []): PaletteCommand[] => [
  { id: "refresh", key: "R", label: "refresh providers", onRun: () => ran.push("refresh") },
  { id: "up", key: "K", label: "scroll up", onRun: () => ran.push("up") },
  { id: "down", key: "J", label: "scroll down", onRun: () => ran.push("down") },
  { id: "bottom", key: "⇧G", label: "jump to bottom", onRun: () => ran.push("bottom") },
  { id: "quit", key: "Q", label: "quit", onRun: () => ran.push("quit") },
];

const press = (name: string, extra: Partial<{ ctrl: boolean; sequence: string }> = {}) => ({
  name,
  ctrl: extra.ctrl ?? false,
  sequence: extra.sequence ?? name,
});

describe("palette filtering", () => {
  test("matches label and key case-insensitively, empty filter keeps all", () => {
    const all = commands();
    expect(paletteMatches(all, "")).toHaveLength(5);
    expect(paletteMatches(all, "scroll").map((command) => command.id)).toEqual(["up", "down"]);
    expect(paletteMatches(all, "⇧g").map((command) => command.id)).toEqual(["bottom"]);
    expect(paletteMatches(all, "nope")).toHaveLength(0);
  });
});

describe("command palette", () => {
  test("stays closed and transparent to app keys until ctrl+k", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const palette = createCommandPalette(core, setup.renderer, "test-palette", TOKENS);
    setup.renderer.root.add(palette.root);
    palette.update({ commands: commands(), width: 80, height: 24 });

    expect(palette.isOpen()).toBe(false);
    expect(palette.handleKey(press("q"))).toBe(false);
    expect(palette.handleKey(press("c", { ctrl: true }))).toBe(false);
    expect(palette.root.visible).toBe(false);

    expect(palette.handleKey(press("k", { ctrl: true }))).toBe(true);
    expect(palette.isOpen()).toBe(true);
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("COMMANDS");
    expect(frame).toContain("[R]");
    expect(frame).toContain("refresh providers");
    expect(frame).toContain("[⇧G]");
    setup.renderer.destroy();
  });

  test("filters with typed keys, runs the selection on enter, and closes", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const ran: string[] = [];
    const palette = createCommandPalette(core, setup.renderer, "filter-palette", TOKENS);
    setup.renderer.root.add(palette.root);
    palette.update({ commands: commands(ran), width: 80, height: 24 });

    palette.handleKey(press("k", { ctrl: true }));
    for (const letter of "quit") expect(palette.handleKey(press(letter))).toBe(true);
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("quit");
    expect(frame).not.toContain("scroll up");

    expect(palette.handleKey(press("return", { sequence: "\r" }))).toBe(true);
    expect(ran).toEqual(["quit"]);
    expect(palette.isOpen()).toBe(false);
    expect(palette.root.visible).toBe(false);
    setup.renderer.destroy();
  });

  test("arrows move the accent selection rail and escape closes without running", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const ran: string[] = [];
    const palette = createCommandPalette(core, setup.renderer, "nav-palette", TOKENS);
    setup.renderer.root.add(palette.root);
    palette.update({ commands: commands(ran), width: 80, height: 24 });

    palette.handleKey(press("k", { ctrl: true }));
    palette.handleKey(press("down", { sequence: "" }));
    await setup.flush();
    const selectedRow = setup
      .captureCharFrame()
      .split("\n")
      .find((row) => row.includes("▎"));
    expect(selectedRow).toContain("scroll up");

    expect(palette.handleKey(press("escape", { sequence: "" }))).toBe(true);
    expect(ran).toHaveLength(0);
    expect(palette.isOpen()).toBe(false);
    setup.renderer.destroy();
  });

  test("runs a command from a pointer tap on its row", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const ran: string[] = [];
    const palette = createCommandPalette(core, setup.renderer, "tap-palette", TOKENS);
    setup.renderer.root.add(palette.root);
    palette.update({ commands: commands(ran), width: 80, height: 24 });

    palette.handleKey(press("k", { ctrl: true }));
    await setup.flush();
    const row = setup.renderer.root.findDescendantById("tap-palette-command-down");
    expect(row).toBeInstanceOf(core.BoxRenderable);
    await setup.mockMouse.click(row!.x + 2, row!.y);
    expect(ran).toEqual(["down"]);
    expect(palette.isOpen()).toBe(false);
    setup.renderer.destroy();
  });

  test("fits inside a shallow narrow terminal without leaving the screen", async () => {
    const setup = await createTestRenderer({ width: 40, height: 12 });
    const palette = createCommandPalette(core, setup.renderer, "small-palette", TOKENS);
    setup.renderer.root.add(palette.root);
    palette.update({ commands: commands(), width: 40, height: 12 });

    palette.handleKey(press("k", { ctrl: true }));
    await setup.flush();
    expect(palette.root.width).toBeLessThanOrEqual(36);
    expect(palette.root.y + palette.root.height).toBeLessThanOrEqual(12);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("[R]");
    setup.renderer.destroy();
  });
});
