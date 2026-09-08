import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { selectGrokAccount } from "../src/balance/grok.ts";
import { materializeFullFocusPolicy } from "../src/focus.ts";
import { buildGrokObservation } from "../src/grok/observe.ts";
import { readState, statePath } from "../src/grok/store.ts";
import { fixtureState } from "./managed-fixtures.ts";
import { account, seedGrok, grokCli } from "./grok-fixtures.ts";

const NOW = Date.parse("2026-09-04T14:00:00Z");
const focus = (key: string) => ({ state: "active" as const,
  policy: materializeFullFocusPolicy("grok", key, { kind: "permanent" }, NOW), diagnostic: "none" as const });

describe("selectGrokAccount from owned state", () => {
  test("previews without changing bytes or the round-robin cursor", async () => {
    const fixture = fixtureState();
    await seedGrok(fixture.paths, [account(1, undefined, NOW), account(2, undefined, NOW)], { nextAvailableCursor: 1 });
    const before = readFileSync(statePath(fixture.paths));
    const result = await selectGrokAccount({ strategy: "next-available", env: fixture.env, nowMs: NOW });
    expect(result).toMatchObject({ ok: true, accountKey: "grok-2", dryRun: true, reservation: null });
    expect(readFileSync(statePath(fixture.paths))).toEqual(before);
  });

  test("claims a bounded reservation and refuses an exact reserved account", async () => {
    const fixture = fixtureState();
    await seedGrok(fixture.paths, [account(1, undefined, NOW)]);
    const result = await selectGrokAccount({ claim: true, reserveSeconds: 42, env: fixture.env, nowMs: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reservation?.expiresAt).toBe(new Date(NOW + 42_000).toISOString());
    expect((await readState(fixture.paths)).reservations).toHaveLength(1);
    expect(await selectGrokAccount({ account: "grok-1", env: fixture.env, nowMs: NOW })).toMatchObject({ ok: false, refusal: "account-reserved" });
  });

  test("focus pins an eligible account and an explicit caller account takes precedence", async () => {
    const fixture = fixtureState();
    const accounts = [account(1, undefined, NOW), account(2, undefined, NOW)];
    await seedGrok(fixture.paths, accounts);
    const options = { env: fixture.env, nowMs: NOW, observation: buildGrokObservation(accounts, NOW), focus: focus("grok-2") };
    expect(await selectGrokAccount(options)).toMatchObject({ ok: true, accountKey: "grok-2", reason: "full-focus" });
    expect(await selectGrokAccount({ ...options, account: "grok-1" })).toMatchObject({ ok: true, accountKey: "grok-1" });
  });

  test("a focused account that becomes ineligible falls back to another owned account", async () => {
    const fixture = fixtureState();
    const accounts = [account(1, undefined, NOW), account(2, undefined, NOW)];
    const observation = buildGrokObservation(accounts, NOW);
    accounts[0]!.enabled = false;
    await seedGrok(fixture.paths, accounts);
    const result = await selectGrokAccount({ env: fixture.env, nowMs: NOW, observation, focus: focus("grok-1") });
    expect(result).toMatchObject({ ok: true, accountKey: "grok-2" });
    if (result.ok) expect(result.reason).toStartWith("full-focus-fallback");
  });

  test("does not bypass a stale or missing focus observation", async () => {
    const fixture = fixtureState();
    await seedGrok(fixture.paths, [account(1, undefined, NOW)]);
    const options = { env: fixture.env, nowMs: NOW, focus: focus("grok-1") };
    expect(await selectGrokAccount(options)).toMatchObject({ ok: false, refusal: "observation-unavailable" });
    const observation = buildGrokObservation([account(1, undefined, NOW)], NOW - 3600_000);
    expect(await selectGrokAccount({ ...options, observation })).toMatchObject({ ok: false, refusal: "observation-stale" });
  });

  test("concurrent CLI claims serialize across processes without duplicate assignments", async () => {
    const fixture = fixtureState();
    await seedGrok(fixture.paths, [account(1), account(2)]);
    const results = await Promise.all([1, 2].map(() => grokCli(['balance', 'grok', '--claim', '--json'], fixture.env)));
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(new Set(results.map((result) => result.data.accountKey)).size).toBe(2);
    const third = await grokCli(['balance', 'grok', '--claim', '--json'], fixture.env);
    expect(third.code).toBe(3);
    expect(third.data.refusal).toBe('no-eligible-account');
    expect((await readState(fixture.paths)).reservations).toHaveLength(2);
    expect(results.map((result) => result.stdout).join('')).not.toContain('access-');
  });
});
