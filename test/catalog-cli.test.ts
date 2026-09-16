import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function validBundle() {
  const now = new Date();
  const reviewAfter = new Date(now.getTime() + 86_400_000);
  return {
    schema_version: 1,
    metadata: { version: 'test', reviewed_at: now.toISOString(), review_after: reviewAfter.toISOString(), sources: ['test fixture'], models: [] },
    native_catalog: { source: 'codex_app_server_model_list', client_version: 'test', observed_at: now.toISOString(), pages: [{ data: [], nextCursor: null }] },
    usage: { schema_version: 1, generated_at: now.toISOString(), claude: null, codex: { schema_version: 2, observed_at_ms: now.getTime(), health: 'ok', dependency: null, recommendation: null, accounts: [], notes: [] }, grok: null },
    extra_secret: 'do-not-echo',
  };
}

function run(input: string, args = ['catalog', 'audit', '--file', '-', '--json'], env = process.env) {
  return Bun.spawnSync([process.execPath, `${import.meta.dir}/../src/cli.ts`, ...args], { stdin: Buffer.from(input), stdout: 'pipe', stderr: 'pipe', env });
}

describe('catalog audit CLI', () => {
  test('stdin clean parity exits zero and remains offline/non-routing', () => {
    const result = run(JSON.stringify(validBundle()));
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout.toString());
    expect(report.ok).toBe(true);
    expect(report.identity_correlation).toBe('unavailable');
    expect(report.routing_enabled).toBe(false);
    expect(report.selection).toBeNull();
    expect(result.stdout.toString()).not.toContain('do-not-echo');
  });

  test('valid diagnostic exits one; malformed input exits two with sanitized JSON', () => {
    const diagnostic = validBundle();
    diagnostic.usage = null as any;
    expect(run(JSON.stringify(diagnostic)).exitCode).toBe(1);
    const malformed = run('{"token":"highly-secret"');
    expect(malformed.exitCode).toBe(2);
    expect(JSON.parse(malformed.stdout.toString()).error.code).toBe('invalid-json');
    expect(malformed.stdout.toString()).not.toContain('highly-secret');
  });

  test('bad arguments exit two without echoing arbitrary argument text', () => {
    const result = run('', ['catalog', 'audit', '--secret-token-value']);
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).not.toContain('secret-token-value');
  });

  test('file-open failures use a stable sanitized diagnostic', () => {
    const missing = join(tmpdir(), `agentusage-catalog-missing-${crypto.randomUUID()}`);
    const result = run('', ['catalog', 'audit', '--file', missing, '--json']);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout.toString()).error.code).toBe('input-read-failed');
    expect(result.stdout.toString()).not.toContain(missing);
  });

  test('does not read or create default AgentUsage state', () => {
    const stateRoot = join(tmpdir(), `agentusage-catalog-state-${crypto.randomUUID()}`);
    const result = run(JSON.stringify(validBundle()), undefined, { ...process.env, AGENTUSAGE_STATE_ROOT: stateRoot });
    expect(result.exitCode).toBe(0);
    expect(existsSync(stateRoot)).toBe(false);
  });
});
