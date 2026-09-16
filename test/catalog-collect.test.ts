import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { auditCatalog, CatalogInputError, collectCatalog, validateCatalogAuditInput } from '../src/catalog/index.ts';
import { CONTRACT } from '../src/guide.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function metadata() {
  return {
    version: 'test-metadata',
    reviewed_at: '2026-09-16T12:00:00Z',
    review_after: '2027-09-16T12:00:00Z',
    sources: ['stock Codex 0.154.0 source'],
    models: [],
  };
}

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gpt-test-picker', model: 'gpt-test', upgrade: null, upgradeInfo: null,
    availabilityNux: null, displayName: 'GPT Test', description: 'untrusted description',
    modelSpecialty: null, hidden: true,
    supportedReasoningEfforts: [
      { reasoningEffort: 'high', description: 'High' },
      { reasoningEffort: 'low', description: 'Low' },
    ],
    defaultReasoningEffort: 'high', inputModalities: ['image', 'text'],
    supportsPersonality: false, multiAgentVersion: 'v2', additionalSpeedTiers: [],
    serviceTiers: [{ id: 'priority', name: 'Priority', description: 'untrusted tier description' }],
    defaultServiceTier: 'priority', isDefault: true,
    extraSecret: 'must-not-appear',
    ...overrides,
  };
}

interface FakeConfig {
  version?: string;
  pages?: Array<{ data: unknown[]; nextCursor: string | null }>;
  behavior?: string;
}

function fakeCodex(config: FakeConfig = {}) {
  const root = join(tmpdir(), `agentusage-collector-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  const executable = join(root, 'codex-fake');
  const log = join(root, 'requests.jsonl');
const source = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const config = ${JSON.stringify(config)};
const log = ${JSON.stringify(log)};
const args = process.argv.slice(2);
appendFileSync(log, JSON.stringify({kind:'argv',args,pid:process.pid})+'\\n');
const holder = () => {
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {stdin:'ignore',stdout:'inherit',stderr:'inherit'});
  appendFileSync(log, JSON.stringify({kind:'descendant',pid:child.pid})+'\\n');
};
if (args[0] === '--version') {
  console.log(config.version ?? 'codex-cli 0.154.0');
  if (config.behavior === 'version-descendant') holder();
  process.exit(0);
}
if (args.join(' ') !== 'app-server --listen stdio://') process.exit(9);
let buffer = ''; let page = 0;
const send = (value) => process.stdout.write(JSON.stringify(value)+'\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (buffer.includes('\\n')) {
    const at = buffer.indexOf('\\n'); const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    appendFileSync(log, JSON.stringify({kind:'message',message})+'\\n');
    if (message.method === 'initialize') {
      if (config.behavior === 'timeout') continue;
      if (config.behavior === 'malformed') { process.stdout.write('{bad json\\n'); continue; }
      if (config.behavior === 'unknown-id') { send({id:999,result:{}}); continue; }
      if (config.behavior === 'server-request') { send({id:99,method:'account/login',params:{token:'secret'}}); continue; }
      if (config.behavior === 'native-error') { send({id:message.id,error:{code:-1,message:'secret reflected error'}}); continue; }
      if (config.behavior === 'premature-exit') process.exit(7);
      if (config.behavior === 'stderr-flood') { process.stderr.write('x'.repeat(70000)); continue; }
      send({method:'catalog/progress',params:{secret:'ignored notification'}});
      send({id:message.id,result:{userAgent:'codex_cli_rs/0.154.0',codexHome:'/tmp/fake-codex-home',platformFamily:'unix',platformOs:'macos'}});
    } else if (message.method === 'model/list') {
      const response = (config.pages ?? [{data:[],nextCursor:null}])[page++];
      if (response === undefined) process.exit(8);
      send({method:'catalog/progress',params:{page}});
      if (config.behavior === 'trailing-request') {
        process.stdout.write(JSON.stringify({id:message.id,result:response})+'\\n'+JSON.stringify({id:99,method:'item/commandExecution/requestApproval',params:{secret:'no'}})+'\\n');
      } else if (config.behavior === 'trailing-partial') {
        process.stdout.write(JSON.stringify({id:message.id,result:response})+'\\n{bad');
      } else if (config.behavior === 'trailing-utf8') {
        process.stdout.write(JSON.stringify({id:message.id,result:response})+'\\n');
        process.stdout.write(Buffer.from([0xc3]));
      } else send({id:message.id,result:response});
      if (config.behavior === 'app-descendant') { holder(); setTimeout(() => process.exit(0), 1); }
    }
  }
});
process.stdin.on('end', () => { appendFileSync(log, JSON.stringify({kind:'ended',pid:process.pid})+'\\n'); });
process.stdin.resume();
`;
  writeFileSync(executable, source, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return { root, executable, log };
}

function logEntries(path: string): any[] {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('native catalog collector', () => {
  test('captures an exact multipage hidden catalog with a continuity receipt', async () => {
    const fake = fakeCodex({ pages: [
      { data: [model()], nextCursor: 'opaque-next' },
      { data: [model({ id: 'second-picker', model: 'second', hidden: false, isDefault: false })], nextCursor: null },
    ] });
    const bundle = await collectCatalog({ executable: fake.executable, expectedVersion: '0.154.0', metadata: metadata() }, {
      now: (() => { const values = [new Date('2026-09-16T12:00:00Z'), new Date('2026-09-16T12:00:01Z')]; return () => values.shift()!; })(),
      randomUUID: () => '12345678-1234-4123-8123-123456789abc',
      shutdownGraceMs: 50,
    });
    expect(validateCatalogAuditInput(bundle)).toEqual(bundle);
    expect(bundle.usage).toBeNull();
    expect(bundle.native_catalog.pages[0]!.data[0]).toEqual({
      id: 'gpt-test-picker', model: 'gpt-test', hidden: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'low' }],
      defaultReasoningEffort: 'high', inputModalities: ['image', 'text'], multiAgentVersion: 'v2',
      serviceTiers: [{ id: 'priority' }], defaultServiceTier: 'priority', isDefault: true,
    });
    expect(JSON.stringify(bundle)).not.toContain('must-not-appear');
    expect(bundle.native_catalog.capture_receipt!.pages).toEqual([
      { request_id: 2, requested_cursor: null, returned_next_cursor: 'opaque-next', include_hidden: true, limit: 100, model_count: 1 },
      { request_id: 3, requested_cursor: 'opaque-next', returned_next_cursor: null, include_hidden: true, limit: 100, model_count: 1 },
    ]);
    const messages = logEntries(fake.log).filter((entry) => entry.kind === 'message').map((entry) => entry.message);
    expect(messages.map((entry) => entry.method)).toEqual(['initialize', 'initialized', 'model/list', 'model/list']);
    expect(messages[2]).toMatchObject({ id: 2, params: { cursor: null, limit: 100, includeHidden: true } });
    expect(messages[3]).toMatchObject({ id: 3, params: { cursor: 'opaque-next', limit: 100, includeHidden: true } });
    expect(messages.some((entry) => /account|auth|thread|turn|control|quota/iu.test(entry.method))).toBe(false);
    expect(logEntries(fake.log).some((entry) => entry.kind === 'ended')).toBe(true);
  });

  test('rejects unsupported and mismatched versions before app-server startup', async () => {
    const unsupported = fakeCodex();
    await expect(collectCatalog({ executable: unsupported.executable, expectedVersion: '0.155.0', metadata: metadata() })).rejects.toMatchObject({ code: 'unsupported-collector-version' });
    expect(existsSync(unsupported.log)).toBe(false);
    const mismatch = fakeCodex({ version: 'codex-cli 0.153.0' });
    await expect(collectCatalog({ executable: mismatch.executable, expectedVersion: '0.154.0', metadata: metadata() })).rejects.toMatchObject({ code: 'codex-version-mismatch' });
    expect(logEntries(mismatch.log).map((entry) => entry.args)).toEqual([['--version']]);
    const invalidMetadata = fakeCodex();
    await expect(collectCatalog({ executable: invalidMetadata.executable, expectedVersion: '0.154.0', metadata: { ...metadata(), sources: [] } })).rejects.toMatchObject({ code: 'invalid-metadata' });
    expect(existsSync(invalidMetadata.log)).toBe(false);
  });

  test.each([
    ['malformed', 'malformed-native-output'],
    ['unknown-id', 'unexpected-native-response'],
    ['server-request', 'unexpected-server-request'],
    ['native-error', 'native-request-failed'],
    ['premature-exit', 'native-exited'],
    ['stderr-flood', 'native-output-limit'],
  ])('fails closed for %s without reflecting native content', async (behavior, code) => {
    const fake = fakeCodex({ behavior });
    let error: unknown;
    try {
      await collectCatalog({ executable: fake.executable, expectedVersion: '0.154.0', metadata: metadata() }, { requestTimeoutMs: 300, totalTimeoutMs: 500, shutdownGraceMs: 20 });
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(CatalogInputError);
    expect((error as CatalogInputError).code).toBe(code);
    expect(String(error)).not.toContain('secret');
  });

  test('rejects missing explicit fields, repeated cursors, and request timeout', async () => {
    const missing = fakeCodex({ pages: [{ data: [model({ serviceTiers: undefined })], nextCursor: null }] });
    await expect(collectCatalog({ executable: missing.executable, expectedVersion: '0.154.0', metadata: metadata() }, { shutdownGraceMs: 20 })).rejects.toMatchObject({ code: 'invalid-native-model' });
    const repeated = fakeCodex({ pages: [
      { data: [], nextCursor: 'again' }, { data: [], nextCursor: 'again' },
    ] });
    await expect(collectCatalog({ executable: repeated.executable, expectedVersion: '0.154.0', metadata: metadata() }, { shutdownGraceMs: 20 })).rejects.toMatchObject({ code: 'repeated-native-cursor' });
    const timeout = fakeCodex({ behavior: 'timeout' });
    await expect(collectCatalog({ executable: timeout.executable, expectedVersion: '0.154.0', metadata: metadata() }, {
      requestTimeoutMs: 30, totalTimeoutMs: 100, shutdownGraceMs: 20,
    })).rejects.toMatchObject({ code: 'native-timeout' });
  });

  test('does not send a request after the total capture deadline', async () => {
    const fake = fakeCodex();
    await expect(collectCatalog({ executable: fake.executable, expectedVersion: '0.154.0', metadata: metadata() }, {
      requestTimeoutMs: 150, totalTimeoutMs: 0, shutdownGraceMs: 20,
    })).rejects.toMatchObject({ code: 'native-timeout' });
    expect(logEntries(fake.log).filter((entry) => entry.kind === 'message')).toEqual([]);
  });

  test('audit validates collector receipt continuity and explicit collector fields', async () => {
    const fake = fakeCodex({ pages: [{ data: [model()], nextCursor: null }] });
    const bundle = await collectCatalog({ executable: fake.executable, expectedVersion: '0.154.0', metadata: metadata() }, { shutdownGraceMs: 20 });
    expect((auditCatalog(bundle).native_catalog as any).provenance).toContain('not cryptographic attestation');
    const tampered = structuredClone(bundle);
    tampered.native_catalog.capture_receipt!.pages[0]!.requested_cursor = 'forged';
    expect(() => validateCatalogAuditInput(tampered)).toThrow(new CatalogInputError('invalid-capture-receipt'));
    const fallback = structuredClone(bundle);
    delete fallback.native_catalog.pages[0]!.data[0]!.serviceTiers;
    fallback.native_catalog.pages[0]!.data[0]!.additionalSpeedTiers = ['priority'];
    expect(() => validateCatalogAuditInput(fallback)).toThrow(new CatalogInputError('invalid-capture-receipt'));
    for (const [field, value] of [['multiAgentVersion', 'v3'], ['inputModalities', ['video']]] as const) {
      const impossible = structuredClone(bundle);
      impossible.native_catalog.pages[0]!.data[0]![field] = value;
      expect(() => validateCatalogAuditInput(impossible)).toThrow(new CatalogInputError('invalid-capture-receipt'));
    }
  });

  test('rejects a trailing server request buffered with the terminal response', async () => {
    const fake = fakeCodex({ behavior: 'trailing-request' });
    await expect(collectCatalog({ executable: fake.executable, expectedVersion: '0.154.0', metadata: metadata() }, {
      shutdownGraceMs: 20,
    })).rejects.toMatchObject({ code: 'unexpected-server-request' });
  });

  test.each(['trailing-partial', 'trailing-utf8'])('rejects malformed unterminated terminal output: %s', async (behavior) => {
    const fake = fakeCodex({ behavior });
    await expect(collectCatalog({ executable: fake.executable, expectedVersion: '0.154.0', metadata: metadata() }, {
      shutdownGraceMs: 20,
    })).rejects.toMatchObject({ code: 'malformed-native-output' });
  });

  test('enforces the requested page limit', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => model({ id: `picker-${index}`, model: `model-${index}`, isDefault: index === 0 }));
    const fake = fakeCodex({ pages: [{ data: rows, nextCursor: null }] });
    await expect(collectCatalog({ executable: fake.executable, expectedVersion: '0.154.0', metadata: metadata() }, {
      shutdownGraceMs: 20,
    })).rejects.toMatchObject({ code: 'invalid-native-page' });
  });

  test.each(['version-descendant', 'app-descendant'])('bounds inherited pipes and reaps the owned %s process group', async (behavior) => {
    const fake = fakeCodex({ behavior });
    const started = Date.now();
    await collectCatalog({ executable: fake.executable, expectedVersion: '0.154.0', metadata: metadata() }, {
      versionTimeoutMs: 200, requestTimeoutMs: 200, totalTimeoutMs: 500, shutdownGraceMs: 30,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    const descendants = logEntries(fake.log).filter((entry) => entry.kind === 'descendant');
    expect(descendants).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(() => process.kill(descendants[0]!.pid, 0)).toThrow();
  });

  test('CLI emits a bounded audit-readable bundle without reading AgentUsage state', () => {
    const fake = fakeCodex({ pages: [{ data: [model()], nextCursor: null }] });
    const metadataPath = join(fake.root, 'metadata.json');
    writeFileSync(metadataPath, JSON.stringify({
      schema_version: 1,
      metadata: { ...metadata(), unknown_secret: 'metadata-secret' },
      unknown_secret: 'top-secret',
    }));
    const stateRoot = join(fake.root, 'state-must-stay-absent');
    const result = Bun.spawnSync([
      process.execPath, `${import.meta.dir}/../src/cli.ts`, 'catalog', 'collect',
      '--metadata', metadataPath, '--codex', fake.executable,
      '--expected-version', '0.154.0', '--json',
    ], {
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, AGENTUSAGE_STATE_ROOT: stateRoot },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.byteLength).toBeLessThanOrEqual(1024 * 1024);
    expect(result.stdout.toString()).not.toContain('secret');
    expect(existsSync(stateRoot)).toBe(false);
    const parsed = JSON.parse(result.stdout.toString());
    expect(validateCatalogAuditInput(parsed)).toEqual(parsed);
    const audit = Bun.spawnSync([
      process.execPath, `${import.meta.dir}/../src/cli.ts`, 'catalog', 'audit', '--file', '-', '--json',
    ], { stdin: result.stdout, stdout: 'pipe', stderr: 'pipe' });
    expect(audit.exitCode).toBe(1);
    expect(JSON.parse(audit.stdout.toString()).diagnostics).toContainEqual({ code: 'usage_missing', severity: 'warning', subject: null });
  });

  test('guide advertises collect under catalog with conservative mutation semantics', () => {
    const catalog = CONTRACT.commands.find((command) => command.name === 'catalog')!;
    const collect = catalog.subcommands?.find((command) => command.name === 'collect');
    expect(collect).toMatchObject({ audience: 'operator', mutates: true, blocking: true });
    expect(CONTRACT.commands.find((command) => command.name === 'balance')!.subcommands?.some((command) => command.name === 'collect')).toBe(false);
  });
});
