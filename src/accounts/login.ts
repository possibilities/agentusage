import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { StatePaths } from '../paths.ts';
import { runBounded } from '../proc.ts';
import {
  AccountError,
  nonempty,
  privateDirectory,
  readPrivate,
  record,
} from './storage.ts';
import { importAccount, type ManagedProvider } from './store.ts';
import { jsonBody, providerURL, type Env } from './http.ts';

export async function identifyImport(
  provider: ManagedProvider,
  value: unknown,
  env: Env = process.env,
): Promise<unknown> {
  if (provider === 'codex') return value;
  const root = record(value),
    oauth = record(root?.claudeAiOauth) ?? root;
  const token = oauth?.accessToken ?? oauth?.access_token;
  if (!nonempty(token))
    throw new AccountError(
      'invalid-credentials',
      'Claude import requires OAuth credentials',
    );
  const response = await fetch(
    providerURL('claude', '/api/oauth/profile', env),
    {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new AccountError(
      'identity-unavailable',
      `Claude profile returned HTTP ${response.status}; sign in again`,
    );
  }
  const profile = await jsonBody(response),
    account = record(profile.account);
  if (!nonempty(account?.uuid))
    throw new AccountError(
      'invalid-response',
      'Claude profile did not identify the account',
    );
  if (nonempty(root?.account_id) && root.account_id !== account.uuid)
    throw new AccountError(
      'identity-mismatch',
      'Claude profile differs from imported identity',
    );
  return {
    ...root,
    claudeAiOauth: oauth,
    account_id: account.uuid,
    email: account.email,
  };
}

/** Only an explicitly named credential file is imported; native/swap stores are never discovered. */
export async function importFile(
  paths: StatePaths,
  provider: ManagedProvider,
  file: string,
  options: { label?: string; account?: string },
  env: Env = process.env,
) {
  const raw = readPrivate(
    file,
    (x) => x,
    () => {
      throw new AccountError('missing-file', 'Credential file does not exist');
    },
  );
  return importAccount(
    paths,
    provider,
    await identifyImport(provider, raw, env),
    options,
  );
}

export async function loginAccount(
  paths: StatePaths,
  provider: ManagedProvider,
  options: { label?: string; account?: string; deviceAuth?: boolean },
  env: Env = process.env,
) {
  privateDirectory(paths.stateRoot);
  const directory = mkdtempSync(join(paths.stateRoot, '.login-'));
  const service =
    'Claude Code-credentials-' +
    createHash('sha256')
      .update(directory.normalize('NFC'))
      .digest('hex')
      .slice(0, 8);
  const security = async (args: string[]) =>
    runBounded(['/usr/bin/security', ...args], {
      timeoutMs: 5_000,
      maxOutputBytes: 256 * 1024,
    });
  let mayCleanKeychain = false;
  try {
    if (provider === 'claude' && process.platform === 'darwin') {
      const prior = await security(['find-generic-password', '-s', service]);
      if (prior.ok || prior.error || prior.code !== 44)
        throw new AccountError(
          'login-state-conflict',
          'Cannot prove the temporary Claude keychain item is absent',
        );
      mayCleanKeychain = true;
    }
    const childEnv = { ...env, AGENTLAUNCH_LAUNCH: '1' };
    for (const key of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CODEX_API_KEY',
      'CODEX_ACCESS_TOKEN',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'CODEX_MULTI_AUTH_DIR',
      'AGENTUSAGE_AUTH_TOKEN',
      'AGENTUSAGE_ACCOUNT',
    ])
      delete (childEnv as Env)[key];
    (childEnv as Env)[
      provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
    ] = directory;
    const command = [
      provider,
      ...(provider === 'codex'
        ? ['login', ...(options.deviceAuth ? ['--device-auth'] : [])]
        : ['auth', 'login']),
    ];
    const child = Bun.spawn({
      cmd: command,
      env: childEnv,
      stdin: 'inherit',
      stdout: 2,
      stderr: 'inherit',
    });
    let interrupted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      interrupted = true;
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2_000);
    };
    const timer = setTimeout(terminate, 10 * 60_000);
    process.on('SIGINT', terminate);
    process.on('SIGTERM', terminate);
    try {
      const code = await child.exited;
      if (interrupted || code !== 0)
        throw new AccountError(
          'login-failed',
          'Native login did not complete successfully',
        );
    } finally {
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.off('SIGINT', terminate);
      process.off('SIGTERM', terminate);
    }
    let raw = readPrivate(
      join(directory, provider === 'codex' ? 'auth.json' : '.credentials.json'),
      (x) => x,
      () => null,
    );
    if (raw === null && mayCleanKeychain) {
      const item = await security([
        'find-generic-password',
        '-s',
        service,
        '-w',
      ]);
      if (item.ok) {
        try {
          raw = JSON.parse(item.stdout);
        } catch {}
      }
    }
    if (raw === null)
      throw new AccountError(
        'login-credentials-missing',
        'Native login produced no readable OAuth credentials',
      );
    return await importAccount(
      paths,
      provider,
      await identifyImport(provider, raw, env),
      options,
    );
  } finally {
    if (mayCleanKeychain)
      await security(['delete-generic-password', '-s', service]);
    rmSync(directory, { recursive: true, force: true });
  }
}
