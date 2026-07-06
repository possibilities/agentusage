#!/usr/bin/env bun

/**
 * Regenerate every corpus `expected.json` from the frozen `screen.txt` via the
 * TS parsers — the bun successor to the Python `generate.py`, so the goldens can
 * be re-derived once Python is deleted.
 *
 *     bun tests/generate.ts           # rewrite every expected.json
 *     bun tests/generate.ts --check   # verify byte-identical, write nothing
 *
 * `--check` is the custody proof: it re-derives each golden and asserts it is
 * BYTE-identical to the committed file, exiting non-zero on any drift. Matching
 * the checked-in goldens (last authored by generate.py) proves the bun
 * derivation reproduces the Python contract exactly.
 *
 * Byte-identity requires reproducing Python's `json.dumps(payload, indent=2,
 * ensure_ascii=False) + "\n"`: two-space indent, `": "` key separator, non-ASCII
 * kept literal (JS `JSON.stringify` already does this for strings), and — the one
 * real divergence — Python float repr. Claude percents are Python floats
 * (`42.0`), codex percents Python ints (`1`); JS collapses `42.0` to `42`, so
 * claude percents are tagged {@link PyFloat} and rendered with the trailing `.0`.
 *
 * A genuinely new scenario needs a new `screen.txt` first: freeze it via the
 * tmux-render path documented in corpus_schema.md (there is no parser that can
 * invent a screen), then regenerate its expected.json here.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CaseMeta,
  deriveContract,
  type Target,
} from "./conformance-derive";

const CORPUS_DIR = join(import.meta.dir, "fixtures", "corpus");

// ---------- Python-json.dumps-compatible serialization ----------------------

/** A number that must serialize as a Python float (integer-valued → `N.0`). */
class PyFloat {
  constructor(readonly value: number) {}
}

function renderFloat(n: number): string {
  // json.dumps(float) → repr(float): an integer-valued float keeps its `.0`.
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

function serialize(value: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  const childPad = "  ".repeat(indent + 1);
  if (value === null) {
    return "null";
  }
  if (value instanceof PyFloat) {
    return renderFloat(value.value);
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return String(value);
    case "string":
      // JS and Python (ensure_ascii=False) escape the same control set and keep
      // non-ASCII literal, so this is byte-identical for the corpus strings.
      return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    const items = value.map((v) => childPad + serialize(v, indent + 1));
    return `[\n${items.join(",\n")}\n${pad}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return "{}";
    }
    const items = entries.map(
      ([k, v]) =>
        `${childPad}${JSON.stringify(k)}: ${serialize(v, indent + 1)}`,
    );
    return `{\n${items.join(",\n")}\n${pad}}`;
  }
  throw new Error(`cannot serialize value of type ${typeof value}`);
}

function pyStringify(value: unknown): string {
  return `${serialize(value, 0)}\n`;
}

/**
 * Tag claude usage-window percents as Python floats. Claude parses percents with
 * `parseFloat` (Python `float`); codex with integer arithmetic (Python `int`).
 * Only claude's need the `.0` treatment; codex ints render as-is.
 */
function markFloats(
  payload: Record<string, unknown>,
  target: Target,
): Record<string, unknown> {
  if (target !== "claude") {
    return payload;
  }
  const usage = payload.usage;
  if (usage && typeof usage === "object") {
    for (const win of Object.values(usage as Record<string, unknown>)) {
      if (win && typeof win === "object" && "percent_used" in win) {
        const w = win as Record<string, unknown>;
        if (typeof w.percent_used === "number") {
          w.percent_used = new PyFloat(w.percent_used);
        }
      }
    }
  }
  return payload;
}

// ---------- corpus walk -----------------------------------------------------

function corpusCases(): string[] {
  return readdirSync(CORPUS_DIR)
    .filter((name) => statSync(join(CORPUS_DIR, name)).isDirectory())
    .sort();
}

async function renderExpected(name: string): Promise<string> {
  const dir = join(CORPUS_DIR, name);
  const meta = JSON.parse(
    readFileSync(join(dir, "case.json"), "utf8"),
  ) as CaseMeta;
  const screen = readFileSync(join(dir, "screen.txt"), "utf8");
  const { payload } = await deriveContract(meta, screen);
  return pyStringify(markFloats(payload, meta.target));
}

/** The first line index where two texts differ, for a compact drift report. */
function firstDiffLine(a: string, b: string): number {
  const al = a.split("\n");
  const bl = b.split("\n");
  const n = Math.max(al.length, bl.length);
  for (let i = 0; i < n; i++) {
    if (al[i] !== bl[i]) {
      return i;
    }
  }
  return -1;
}

async function main(argv: string[]): Promise<number> {
  const check = argv.includes("--check");
  const names = corpusCases();
  let drift = 0;

  for (const name of names) {
    const rendered = await renderExpected(name);
    const path = join(CORPUS_DIR, name, "expected.json");

    if (check) {
      const committed = readFileSync(path, "utf8");
      if (rendered !== committed) {
        drift += 1;
        const line = firstDiffLine(committed, rendered);
        process.stderr.write(
          `DRIFT ${name}: regenerated expected.json differs at line ${line + 1}\n` +
            `  committed: ${JSON.stringify(committed.split("\n")[line])}\n` +
            `  generated: ${JSON.stringify(rendered.split("\n")[line])}\n`,
        );
      }
    } else {
      writeFileSync(path, rendered);
    }
  }

  if (check) {
    if (drift > 0) {
      process.stderr.write(
        `\n${drift}/${names.length} goldens drifted — bun derivation is NOT byte-identical\n`,
      );
      return 1;
    }
    process.stdout.write(
      `all ${names.length} goldens byte-identical to the bun re-derivation\n`,
    );
    return 0;
  }

  process.stdout.write(`regenerated ${names.length} expected.json goldens\n`);
  return 0;
}

process.exit(await main(Bun.argv.slice(2)));
