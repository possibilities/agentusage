import { describe, expect, test } from 'bun:test';
import { buildObservation, parseClaudeUsage } from '../src/claude/observe.ts';
import { validateObservation } from '../src/claude/types.ts';
import { claudeUsage, managed } from './managed-fixtures.ts';
describe('owned Claude observations', () => {
  test('routes XOR issues, stable ordinals, capacity and last-good measurements', () => {
    const now = Date.now();
    const a = managed('claude');
    const b = managed('claude', 3, { auth_error: 'relogin-required', usage: { measured_at_ms: now - 600_000, value: claudeUsage(90) } });
    const observation = buildObservation([a, b], now);
    expect(validateObservation(observation)).not.toBeNull();
    expect(observation.routes.map(r => r.id)).toEqual(['claude-1']);
    expect(observation.account_issues).toEqual({ 'claude-3': 'relogin-required' });
    expect(observation.claude_accounts.ordinals).toEqual({ 'claude-1': 0, 'claude-3': 2 });
    expect(observation.account_capacity?.['claude-1']).toEqual({ subscriptionType: 'max', rateLimitMultiplier: 20 });
    expect(observation.account_measurements?.['claude-3']?.measuredAtMs).toBe(now - 600_000);
    expect(observation.routes[0]!.windows.find(w => w.key === 'model:fable')!.utilization).toBe(.3);
  });
  test('malformed scoped windows poison the account; partial binding windows refuse', () => {
    const a = managed('claude'); a.usage!.value.seven_day_fable = { utilization: 'unknown' };
    const b = managed('claude', 2); delete b.usage!.value.seven_day;
    const observed = buildObservation([a, b], Date.now());
    expect(observed.routes).toHaveLength(0);
    expect(observed.account_issues).toEqual({ 'claude-1': 'malformed-scoped-windows', 'claude-2': 'missing-windows' });
  });
  test('stale, failed and disabled readings remain displayable, never launchable', () => {
    const a = managed('claude', 1); a.usage!.measured_at_ms -= 600_000;
    const b = managed('claude', 2, { usage_error: { code: 'http-429', status: 429 } });
    const c = managed('claude', 3, { enabled: false });
    const observed = buildObservation([a, b, c], Date.now());
    expect(observed.routes).toHaveLength(0);
    expect(Object.keys(observed.account_measurements!)).toHaveLength(3);
  });
  test('over-limit percentages and enabled spend, UTC resets only', () => {
    const parsed = parseClaudeUsage({ ...claudeUsage(104), extra_usage: { utilization: 12, is_enabled: true }, seven_day_fable: { utilization: 80, resets_at: '2026-08-08 12:00:00' } });
    expect(parsed.windows.find(w => w.key === 'session')!.utilization).toBe(1.04);
    expect(parsed.windows.find(w => w.key === 'spend')!.utilization).toBe(.12);
    expect(parsed.windows.find(w => w.key === 'model:fable')!.resetsAt).toBeNull();
  });
});
