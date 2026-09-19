import { expect, test } from 'bun:test';
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
