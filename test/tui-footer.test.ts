import { describe, expect, test } from "bun:test";
import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createFleetFooter, footerCopy, type FleetFooterAction } from "../src/tui/footer.ts";

const actions: FleetFooterAction[] = [
  { id: "quit", key: "Q", label: "quit", onPress() {} },
  { id: "refresh", key: "R", label: "refresh", onPress() {} },
  { id: "up", key: "↑", label: "up", onPress() {} },
  { id: "down", key: "↓", label: "down", onPress() {} },
  { id: "bottom", key: "⇧G", label: "bottom", onPress() {} },
];

describe("fleet footer", () => {
  test("compresses copy without wrapping or showing scrollbars", async () => {
    expect(footerCopy({ actions, mode: "AUTO / 1s", width: 40 }).mode).toBe("");
    const setup = await createTestRenderer({ width: 72, height: 6 });
    const footer = createFleetFooter(core, setup.renderer, "test-footer", {
      field: "#111111",
      line: "#333333",
      accent: "#00ffff",
      muted: "#999999",
    });
    setup.renderer.root.add(footer.root);
    footer.update({ actions, mode: "AUTO / 1s", width: 72 });
    await setup.flush();

    const rail = setup.renderer.root.findDescendantById("test-footer-actions");
    expect(rail).toBeInstanceOf(core.ScrollBoxRenderable);
    expect((rail as core.ScrollBoxRenderable).horizontalScrollBar.visible).toBe(false);
    expect((rail as core.ScrollBoxRenderable).verticalScrollBar.visible).toBe(false);
    const frame = setup.captureCharFrame();
    expect(frame).not.toMatch(/^\s*A\s*$/m);
    expect(frame.split("\n").filter((row) => row.includes("[")).length).toBe(1);
    setup.renderer.destroy();
  });

  test("scrolls an overflowing rail horizontally with a touch-style vertical gesture", async () => {
    const setup = await createTestRenderer({ width: 24, height: 6 });
    const footer = createFleetFooter(core, setup.renderer, "touch-footer", {
      field: "#111111",
      line: "#333333",
      accent: "#00ffff",
      muted: "#999999",
    });
    setup.renderer.root.add(footer.root);
    footer.update({ actions, width: 24 });
    await setup.flush();

    const rail = setup.renderer.root.findDescendantById("touch-footer-actions");
    expect(rail).toBeInstanceOf(core.ScrollBoxRenderable);
    expect((rail as core.ScrollBoxRenderable).scrollLeft).toBe(0);
    await setup.mockMouse.scroll(rail!.x + 1, rail!.y, "down");
    await setup.flush();
    expect((rail as core.ScrollBoxRenderable).scrollLeft).toBeGreaterThan(0);
    setup.renderer.destroy();
  });

  test("routes a pointer tap on an action through the footer shell", async () => {
    const setup = await createTestRenderer({ width: 72, height: 6 });
    let pressed = "";
    const footer = createFleetFooter(core, setup.renderer, "pointer-footer", {
      field: "#111111",
      line: "#333333",
      accent: "#00ffff",
      muted: "#999999",
    });
    setup.renderer.root.add(footer.root);
    footer.update({
      width: 72,
      actions: actions.map((action) => ({
        ...action,
        onPress: () => {
          pressed = action.id;
        },
      })),
    });
    await setup.flush();

    const bottom = setup.renderer.root.findDescendantById("pointer-footer-action-bottom");
    expect(bottom).toBeInstanceOf(core.BoxRenderable);
    await setup.mockMouse.click(bottom!.x + 1, bottom!.y);
    expect(pressed).toBe("bottom");
    setup.renderer.destroy();
  });
});
