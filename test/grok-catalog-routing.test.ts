import { expect, test } from "bun:test";
import { lockFile } from "../src/accounts/storage.ts";
import { readPool } from "../src/accounts/store.ts";
import { buildCodexObservation } from "../src/codex/observe.ts";
import { fetchGrokCatalog, recordGrokCatalogAttempt } from "../src/grok/catalog.ts";
import { buildGrokObservation } from "../src/grok/observe.ts";
import { nextGrokSourceRevision } from "../src/observe.ts";
import { readGrokCatalogRoutingEvidence } from "../src/routing-evidence/grok-catalog.ts";
import { readRoutingEvidence } from "../src/routing-evidence/projection.ts";
import { writeSidecar } from "../src/sidecar.ts";
import { account, billing, seedGrok } from "./grok-fixtures.ts";
import { fixtureState, managed, seed } from "./managed-fixtures.ts";

test("publishes complete Grok visibility while routing only reviewed, fresh, included models", async () => {
  const fixture = fixtureState();
  await seed(fixture, [managed()]);
  writeSidecar(fixture.paths.codexObservation, buildCodexObservation(readPool(fixture.paths).accounts, Date.now()));
  (await lockFile(fixture.paths.codexRefreshLock, 0))();
  const now = Date.now();
  const grok = account(2, billing({ included: {
    usedPercent: 1, remainingPercent: 99, periodType: "USAGE_PERIOD_TYPE_WEEKLY",
    periodStart: new Date(now - 1000).toISOString(), resetsAt: new Date(now + 86_400_000).toISOString(),
  } }), now);
  await seedGrok(fixture.paths, [grok]);
  const observation = buildGrokObservation([grok], now);
  observation.source_revision = nextGrokSourceRevision(null, now);
  writeSidecar(fixture.paths.grokObservation, observation);
  (await lockFile(fixture.paths.grokRefreshLock, 0))();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/models") return Response.json({ data: [
      { model: "grok-4.5", api_backend: "responses", supports_reasoning_effort: true, reasoning_efforts: [{ value: "low" }, { value: "medium" }], context_window: 131_072, max_completion_tokens: 8_192 },
      { model: "grok-4.6", api_backend: "responses", supports_reasoning_effort: true, reasoning_efforts: [{ value: "low" }, { value: "medium" }, { value: "high" }], context_window: 256_000, max_completion_tokens: 16_384 },
      { model: "grok-next-unreviewed", api_backend: "responses", supports_reasoning_effort: true, reasoning_efforts: [{ value: "medium" }], context_window: 256_000, max_completion_tokens: 16_384 },
    ] });
    return Response.json({ models: ["grok-4.5", "grok-4.6", "grok-next-unreviewed"].map((id) => ({ id, input_modalities: ["text"], output_modalities: ["text"] })) });
  } });
  try {
    const env = { ...fixture.env, AGENTUSAGE_TEST_GROK_ORIGIN: `http://127.0.0.1:${server.port}` };
    const capture = await fetchGrokCatalog(grok, env);
    recordGrokCatalogAttempt(fixture.paths, grok.accountKey, capture, null);
    const source = (await readRoutingEvidence(fixture.paths)).source_revision;
    const evidence = await readGrokCatalogRoutingEvidence(fixture.paths, source);
    expect(evidence.visibility.complete).toBe(true);
    expect(evidence.visibility.accounts[0]!.models.map((model) => model.model)).toEqual([
      "grok-4.5", "grok-4.6", "grok-next-unreviewed",
    ]);
    expect(evidence.advice.models).toEqual([
      { model: "grok-4.5", disposition: "reviewed_routable", reviewed_version: "xai-grok-agentic-catalog-2026-09-16" },
      { model: "grok-4.6", disposition: "reviewed_routable", reviewed_version: "xai-grok-agentic-catalog-2026-09-16" },
      { model: "grok-next-unreviewed", disposition: "review_required", reviewed_version: null },
    ]);
    expect(evidence.routable.default_model).toBe("grok-4.6");
    expect(evidence.routable.models.map((model) => model.model)).toEqual(["grok-4.6", "grok-4.5"]);
    expect(evidence.drift).toContainEqual({ code: "unreviewed_live_model", subject: "grok-next-unreviewed", account_key: "grok-2" });
    expect(evidence.notification).toMatchObject({ severity: "warning", code: "grok_catalog_drift" });
    const serialized = JSON.stringify(evidence);
    for (const privateValue of [grok.credentials.accessToken, grok.credentials.refreshToken, grok.userId, grok.email!])
      expect(serialized).not.toContain(privateValue);
  } finally { server.stop(true); }
});

test("keeps last-good catalog visible but refuses it after included quota is exhausted", async () => {
  const fixture = fixtureState();
  await seed(fixture, [managed()]);
  writeSidecar(fixture.paths.codexObservation, buildCodexObservation(readPool(fixture.paths).accounts, Date.now()));
  (await lockFile(fixture.paths.codexRefreshLock, 0))();
  const now = Date.now();
  const grok = account(1, billing({ included: {
    usedPercent: 100, remainingPercent: 0, periodType: "USAGE_PERIOD_TYPE_WEEKLY",
    periodStart: new Date(now - 1000).toISOString(), resetsAt: new Date(now + 86_400_000).toISOString(),
  } }), now);
  await seedGrok(fixture.paths, [grok]);
  const observation = buildGrokObservation([grok], now); observation.source_revision = 1;
  writeSidecar(fixture.paths.grokObservation, observation); (await lockFile(fixture.paths.grokRefreshLock, 0))();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    return Response.json(new URL(request.url).pathname === "/v1/models"
      ? { data: [{ model: "grok-4.6", api_backend: "responses", supports_reasoning_effort: true, reasoning_efforts: [{ value: "medium" }] }] }
      : { models: [{ id: "grok-4.6", input_modalities: ["text"], output_modalities: ["text"] }] });
  } });
  try {
    const capture = await fetchGrokCatalog(grok, { ...fixture.env, AGENTUSAGE_TEST_GROK_ORIGIN: `http://127.0.0.1:${server.port}` });
    recordGrokCatalogAttempt(fixture.paths, grok.accountKey, capture, null);
    const evidence = await readGrokCatalogRoutingEvidence(fixture.paths);
    expect(evidence.visibility.accounts[0]!.models.map((model) => model.model)).toEqual(["grok-4.6"]);
    expect(evidence.routable.models).toEqual([]);
    expect(evidence.routable.default_model).toBeNull();
  } finally { server.stop(true); }
});
