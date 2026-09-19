import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FX_BRIDGE_MAX_LINE_BYTES,
  FX_BRIDGE_MAX_REQUEST_BODY_BYTES,
  FX_MAX_PROVIDER_ADMISSIONS,
  FX_MIN_FORWARD_AUTHORITY_MS,
  FX_PROVIDER_REQUEST_BUDGET_MS,
  FX_PROVIDER_RESPONSE_SAFETY_MS,
  FX_RENEW_BEFORE_EXPIRY_MS,
  FX_ROLLING_LEASE_MS,
  fxProviderRequestBudgetMs,
} from '../src/fx-broker/runtime-bounds.ts';

test('provider responses can outlive the legacy two-minute ceiling within one rolling lease', () => {
  expect(FX_MAX_PROVIDER_ADMISSIONS).toBe(1024);
  expect(FX_MAX_PROVIDER_ADMISSIONS).toBeGreaterThan(35);
  expect(FX_BRIDGE_MAX_LINE_BYTES).toBe(16 * 1024);
  expect(FX_BRIDGE_MAX_REQUEST_BODY_BYTES).toBe(1024 * 1024);
  expect(FX_PROVIDER_REQUEST_BUDGET_MS).toBeGreaterThan(2 * 60_000);
  expect(FX_PROVIDER_REQUEST_BUDGET_MS).toBe(
    FX_ROLLING_LEASE_MS -
      FX_RENEW_BEFORE_EXPIRY_MS -
      FX_PROVIDER_RESPONSE_SAFETY_MS,
  );
  expect(FX_MIN_FORWARD_AUTHORITY_MS).toBe(
    FX_PROVIDER_REQUEST_BUDGET_MS + FX_PROVIDER_RESPONSE_SAFETY_MS,
  );
  expect(FX_MIN_FORWARD_AUTHORITY_MS).toBeLessThanOrEqual(
    FX_ROLLING_LEASE_MS,
  );
  expect(fxProviderRequestBudgetMs(1_000_000, 0)).toBe(
    FX_PROVIDER_REQUEST_BUDGET_MS,
  );
  expect(fxProviderRequestBudgetMs(100_000, 40_000)).toBe(60_000);
  expect(fxProviderRequestBudgetMs(40_000, 40_001)).toBe(-1);
});

test('bridge runtime identity stays bound to loaded code when source files change during preparation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentusage-loaded-bridge-'));
  try {
    const sourceRoot = join(root, 'src');
    cpSync(join(import.meta.dir, '..', 'src'), sourceRoot, { recursive: true });
    const bridgePath = join(sourceRoot, 'fx-broker', 'bridge.ts');
    const boundsPath = join(sourceRoot, 'fx-broker', 'runtime-bounds.ts');
    const bridgeUrl = `${pathToFileURL(bridgePath).href}?loaded=1`;
    const runtimeUrl = pathToFileURL(join(sourceRoot, 'fx-broker', 'bridge-runtime.ts')).href;
    const bridge = await import(bridgeUrl) as typeof import('../src/fx-broker/bridge.ts');
    const runtime = await import(runtimeUrl) as typeof import('../src/fx-broker/bridge-runtime.ts');
    const loadedSources = { run_fx_bridge: bridge.runFxBridge.toString() };
    const before = runtime.bridgeRuntimeEvidence(loadedSources);

    writeFileSync(bridgePath, `${readFileSync(bridgePath, 'utf8')}\n// replaced after module load\n`);
    writeFileSync(boundsPath, readFileSync(boundsPath, 'utf8').replace(
      'export const FX_MAX_PROVIDER_ADMISSIONS = 1024;',
      'export const FX_MAX_PROVIDER_ADMISSIONS = 35;',
    ));

    const after = runtime.bridgeRuntimeEvidence(loadedSources);
    expect(readFileSync(boundsPath, 'utf8')).toContain('FX_MAX_PROVIDER_ADMISSIONS = 35');
    expect(after.identity.source_sha256).toBe(before.identity.source_sha256);
    expect(after.identity.build_sha256).toBe(before.identity.build_sha256);
    expect(after.bounds.max_provider_admissions).toBe(1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
