import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { changeGrokAccount, importGrokState, listGrokAccounts } from '../src/grok/accounts.ts';
import { emptyState, readState, statePath, withState } from '../src/grok/store.ts';
import { statePaths } from '../src/paths.ts';
import { fixtureState } from './managed-fixtures.ts';
import { account, grokCli, seedGrok, state } from './grok-fixtures.ts';

describe('Grok account ownership and explicit snapshot import', () => {
  test('preserves ordinals, aliases, billing, reservations and cursor; refuses to replace an occupied inventory', async () => {
    const fixture = fixtureState();
    const now = Date.now();
    const snapshot = state([account(2), account(4)]);
    snapshot.accounts[0]!.alias = 'work';
    snapshot.accounts[1]!.enabled = false;
    snapshot.nextAvailableCursor = 4;
    snapshot.reservations = [{ id: 'live-reservation', accountKey: 'grok-2', createdAtMs: now, expiresAtMs: now + 30_000 }];
    const file = join(fixture.root, 'snapshot.json');
    writeFileSync(file, JSON.stringify(snapshot), { mode: 0o600 });
    const original = readFileSync(file);
    expect((await importGrokState(fixture.paths, file)).imported).toBe(true);
    expect(await readState(fixture.paths)).toEqual(snapshot);
    expect((await importGrokState(fixture.paths, file)).imported).toBe(false);
    await changeGrokAccount(fixture.paths, 'label', 'work', 'renamed');
    await expect(importGrokState(fixture.paths, file)).rejects.toMatchObject({ code: 'account-store-not-empty' });
    expect(readFileSync(file)).toEqual(original);
    expect(statSync(statePath(fixture.paths)).mode & 0o777).toBe(0o600);
    const output = JSON.stringify(await listGrokAccounts(fixture.paths));
    expect(output).not.toContain('access-');
    expect(output).not.toContain('refresh-');
  });

  test('an absent owned inventory stays absent during list and does not discover legacy state', async () => {
    const fixture = fixtureState();
    const absent = join(fixture.root, 'absent');
    const legacy = join(fixture.root, 'legacy');
    mkdirSync(legacy, { mode: 0o700 });
    writeFileSync(join(legacy, 'state.json'), JSON.stringify(state([account(1)])), { mode: 0o600 });
    const result = await grokCli(['accounts', 'list', 'grok', '--json'], { AGENTUSAGE_STATE_ROOT: absent, GROK_SWAP_HOME: legacy });
    expect(result.code).toBe(0);
    expect(result.data.accounts).toEqual([]);
    expect(existsSync(absent)).toBe(false);
  });

  test('unsafe snapshot permissions and hardlinks are refused without creating owned state', async () => {
    const fixture = fixtureState();
    const file = join(fixture.root, 'input.json');
    writeFileSync(file, JSON.stringify(emptyState()), { mode: 0o644 });
    await expect(importGrokState(fixture.paths, file)).rejects.toMatchObject({ code: 'unsafe-state' });
    chmodSync(file, 0o600);
    linkSync(file, join(fixture.root, 'linked.json'));
    await expect(importGrokState(fixture.paths, file)).rejects.toMatchObject({ code: 'unsafe-state' });
    expect(existsSync(statePath(fixture.paths))).toBe(false);
  });

  test('unsafe state roots, ancestor symlinks, leaves and hardlinks are refused', async () => {
    const fixture = fixtureState();
    const real = join(fixture.root, 'real');
    mkdirSync(real, { mode: 0o700 });
    const alias = join(fixture.root, 'alias');
    symlinkSync(real, alias);
    for (const root of [alias, join(alias, 'nested')]) {
      await expect(withState(statePaths({ AGENTUSAGE_STATE_ROOT: root }), () => ({ result: null, changed: true })))
        .rejects.toMatchObject({ code: 'store_unsafe' });
    }
    await seedGrok(fixture.paths, [account(1)]);
    const file = statePath(fixture.paths);
    chmodSync(file, 0o644);
    await expect(readState(fixture.paths)).rejects.toMatchObject({ code: 'unsafe-state' });
    expect(statSync(file).mode & 0o777).toBe(0o644);
    chmodSync(file, 0o600);
    linkSync(file, join(fixture.root, 'linked-store.json'));
    await expect(changeGrokAccount(fixture.paths, 'disable', 'grok-1')).rejects.toMatchObject({ code: 'unsafe-state' });
  });

  test('malformed state and untrusted OAuth origins are refused without overwriting bytes', async () => {
    const fixture = fixtureState();
    await seedGrok(fixture.paths, [account(1)]);
    const file = statePath(fixture.paths);
    const snapshot = state([account(1)]);
    snapshot.accounts[0]!.credentials.issuer = 'https://untrusted.example';
    writeFileSync(file, JSON.stringify(snapshot));
    const original = readFileSync(file);
    await expect(changeGrokAccount(fixture.paths, 'disable', 'grok-1')).rejects.toMatchObject({ code: 'store_corrupt' });
    expect(readFileSync(file)).toEqual(original);
    writeFileSync(file, '{invalid');
    await expect(readState(fixture.paths)).rejects.toMatchObject({ code: 'invalid-state' });
    expect(readFileSync(file, 'utf8')).toBe('{invalid');
  });

  test('labels cannot shadow identifiers and disabling removes reservations', async () => {
    const fixture = fixtureState();
    const now = Date.now();
    await seedGrok(fixture.paths, [account(1), account(2)], {
      reservations: [{ id: 'reservation', accountKey: 'grok-1', createdAtMs: now, expiresAtMs: now + 30_000 }],
    });
    for (const label of ['grok-2', '2', 'acct_2', 'user2@example.test'])
      await expect(changeGrokAccount(fixture.paths, 'label', 'grok-1', label)).rejects.toMatchObject({ code: 'alias_conflict' });
    await changeGrokAccount(fixture.paths, 'label', 'grok-1', 'work');
    await changeGrokAccount(fixture.paths, 'disable', 'work');
    expect((await readState(fixture.paths)).reservations).toEqual([]);
    await changeGrokAccount(fixture.paths, 'label', 'work', null);
    await changeGrokAccount(fixture.paths, 'remove', 'grok-1');
    expect((await readState(fixture.paths)).nextOrdinal).toBe(3);
  });

  test('CLI import and lifecycle commands expose only public account summaries', async () => {
    const fixture = fixtureState();
    const file = join(fixture.root, 'snapshot.json');
    writeFileSync(file, JSON.stringify(state([account(1)])), { mode: 0o600 });
    const calls = [
      ['accounts', 'import', 'grok', '--file', file, '--json'],
      ['accounts', 'label', 'grok', 'grok-1', '--label', 'work', '--json'],
      ['accounts', 'disable', 'grok', 'work', '--json'],
      ['accounts', 'enable', 'grok', 'grok-1', '--json'],
      ['accounts', 'label', 'grok', 'work', '--clear-label', '--json'],
      ['accounts', 'list', 'grok', '--json'],
      ['accounts', 'remove', 'grok', 'grok-1', '--json'],
    ];
    for (const args of calls) {
      const result = await grokCli(args, fixture.env);
      expect(result.code).toBe(0);
      expect(result.data).toMatchObject({ schema_version: 1, ok: true, provider: 'grok' });
      expect(result.stdout + result.stderr).not.toContain('access-1');
      expect(result.stdout + result.stderr).not.toContain('refresh-1');
    }
    expect((await readState(fixture.paths)).accounts).toEqual([]);
    expect((await readState(fixture.paths)).nextOrdinal).toBe(2);
  });
});
