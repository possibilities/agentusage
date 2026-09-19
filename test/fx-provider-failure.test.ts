import { expect, test } from 'bun:test';
import {
  normalizeProviderErrorCode,
  providerErrorCodeFromBody,
} from '../src/fx-broker/provider-failure.ts';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

test('provider error codes use a finite normalized vocabulary', () => {
  expect(normalizeProviderErrorCode('PermissionDenied')).toBe('permission_denied');
  expect(normalizeProviderErrorCode('rate-limit-exceeded')).toBe('rate_limit_exceeded');
  expect(normalizeProviderErrorCode('acct_0123456789')).toBeNull();
  expect(normalizeProviderErrorCode('Bearer SECRET')).toBeNull();
  expect(normalizeProviderErrorCode('x'.repeat(65))).toBeNull();
  expect(providerErrorCodeFromBody(bytes({error:{code:'insufficient_permissions',message:'PRIVATE'}}))).toBe('permission_denied');
  expect(providerErrorCodeFromBody(bytes({error:{type:'insufficient_quota'}}))).toBe('quota_exhausted');
  expect(providerErrorCodeFromBody(bytes({error:{code:'account_123456789'}}))).toBeNull();
  expect(providerErrorCodeFromBody(new TextEncoder().encode('{malformed'))).toBeNull();
  expect(providerErrorCodeFromBody(new Uint8Array([0xff,0xfe]))).toBeNull();
  expect(providerErrorCodeFromBody(new Uint8Array(16 * 1024 + 1))).toBeNull();
});
