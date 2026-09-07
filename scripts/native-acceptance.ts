import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strict as assert } from 'node:assert';
import { statePaths } from '../src/paths.ts';
import { importAccount, changePool } from '../src/accounts/store.ts';
import { startProxy } from '../src/service/proxy.ts';
import { readLeases } from '../src/service/leases.ts';
import { readCapped } from '../src/accounts/http.ts';
// Opt-in acceptance against installed native CLIs, isolated fake credentials and
// loopback mock upstreams. No production homes or installed commands are changed.
const usageRoot = resolve(import.meta.dir, '..');
const launchRoot = process.env.AGENTUSAGE_ACCEPTANCE_AGENTLAUNCH;
if (!launchRoot)
  throw new Error(
    'Set AGENTUSAGE_ACCEPTANCE_AGENTLAUNCH to the candidate AgentLaunch checkout',
  );
const binaries = {
  codex: process.env.AGENTUSAGE_ACCEPTANCE_CODEX ?? Bun.which('codex'),
  claude: process.env.AGENTUSAGE_ACCEPTANCE_CLAUDE ?? Bun.which('claude'),
};
if (!binaries.codex || !binaries.claude)
  throw new Error(
    'Install stock Codex and Claude or set AGENTUSAGE_ACCEPTANCE_CODEX/CLAUDE',
  );
const { seedFleetResources } = (await import(
  pathToFileURL(join(launchRoot, 'test/resource-fixture.ts')).href
)) as { seedFleetResources(home: string): void };
const root = realpathSync(
  mkdtempSync(join(tmpdir(), 'agentusage-native-bundle-')),
);
const calls: Array<{
  path: string;
  account: string | null;
  body: Record<string, unknown> | null;
}> = [];
let quota = false;
let number = 0;
const upstream = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    let body: Record<string, unknown> | null = null;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {}
    calls.push({ path, account: req.headers.get('chatgpt-account-id'), body });
    assert.match(
      req.headers.get('authorization') ?? '',
      /^Bearer fake-(codex|claude)-[12]$/u,
    );
    if (path.endsWith('/responses')) {
      if (quota && req.headers.get('chatgpt-account-id') === 'proof-codex-1')
        return Response.json(
          { error: { type: 'usage_limit_reached', resets_in_seconds: 3600 } },
          { status: 429 },
        );
      const id = `resp_${++number}`;
      const answer = JSON.stringify(body?.input).includes(
        'Say interactive proof',
      )
        ? 'interactive accepted'
        : 'proof ok';
      const item = {
        id: `msg_${number}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: answer, annotations: [] }],
      };
      const events = [
        {
          type: 'response.created',
          response: { id, status: 'in_progress', output: [] },
        },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { ...item, content: [] },
        },
        {
          type: 'response.content_part.added',
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        },
        {
          type: 'response.output_text.delta',
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: answer,
        },
        {
          type: 'response.output_text.done',
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          text: answer,
        },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: {
            id,
            status: 'completed',
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ];
      return new Response(
        events
          .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
          .join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    if (path.endsWith('/messages'))
      return Response.json({
        id: 'msg_proof',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'proof ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    if (path.endsWith('/models')) return Response.json({ models: [] });
    return Response.json({
      account: { uuid: 'proof-claude-1', email: 'proof@example.invalid' },
      organization: { uuid: 'proof-org', organization_type: 'claude_max' },
    });
  },
});
const env = {
  PATH: join(root, 'bin') + ':' + process.env.PATH,
  HOME: root,
  TMPDIR: root,
  AGENTLAUNCH_LAUNCH: '1',
  AGENTUSAGE_STATE_ROOT: join(root, 'state'),
  AGENTUSAGE_TEST_CODEX_ORIGIN: upstream.url.origin,
  AGENTUSAGE_TEST_CLAUDE_ORIGIN: upstream.url.origin,
  CLAUDE_CONFIG_DIR: join(root, 'claude'),
  CODEX_HOME: join(root, 'codex'),
  OPENAI_BASE_URL: 'http://127.0.0.1:9',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};
let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
try {
  for (const p of [join(root, 'bin'), env.CODEX_HOME, env.CLAUDE_CONFIG_DIR])
    mkdirSync(p, { recursive: true, mode: 0o700 });
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  writeFileSync(
    join(root, 'bin', 'agentusage'),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(usageRoot, 'src/cli.ts'))} "$@"\n`,
    { mode: 0o700 },
  );
  for (const harness of ['codex', 'claude'] as const)
    writeFileSync(
      join(root, 'bin', harness),
      `#!/bin/sh\nexec ${quote(binaries[harness]!)} "$@"\n`,
      { mode: 0o700 },
    );
  writeFileSync(join(root, 'bin', 'npx'), '#!/bin/sh\nexit 0\n', {
    mode: 0o700,
  });
  seedFleetResources(root);
  writeFileSync(
    join(env.CODEX_HOME, 'proof.config.toml'),
    'model_reasoning_effort="low"\n',
  );
  writeFileSync(
    join(env.CLAUDE_CONFIG_DIR, '.claude.json'),
    JSON.stringify({ hasCompletedOnboarding: true }),
  );
  const paths = statePaths(env);
  for (const [provider, n] of [
    ['codex', 1],
    ['codex', 2],
    ['claude', 1],
  ] as const) {
    await importAccount(paths, provider, {
      account_id: `proof-${provider}-${n}`,
      access_token: `fake-${provider}-${n}`,
      refresh_token: null,
      expires_at_ms: Date.now() + 3600_000,
    });
  }
  await changePool(paths, (p) => {
    for (const a of p.accounts) {
      a.usage = {
        measured_at_ms: Date.now(),
        value:
          a.provider === 'codex'
            ? {
                rate_limit: {
                  limit_reached: false,
                  primary_window: {
                    used_percent: 10,
                    limit_window_seconds: 18000,
                  },
                  secondary_window: {
                    used_percent: 10,
                    limit_window_seconds: 604800,
                  },
                },
              }
            : {
                five_hour: { utilization: 10 },
                seven_day: { utilization: 10 },
              },
      };
      a.next_poll_at_ms = Date.now() + 180_000;
    }
  });
  proxy = await startProxy(paths, { env, port: 0 });
  async function run(label: string, args: string[]) {
    const child = Bun.spawn(
      [process.execPath, join(launchRoot!, 'src/main.ts'), ...args],
      { env, cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    );
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    const timer = setTimeout(terminate, 30_000);
    try {
      const [out, err, code] = await Promise.all([
        readCapped(new Response(child.stdout), 1024 * 1024),
        readCapped(new Response(child.stderr), 1024 * 1024),
        child.exited,
      ]);
      const stdout = Buffer.from(out).toString(),
        stderr = Buffer.from(err).toString();
      console.log(
        JSON.stringify({
          label,
          code,
          stdout: stdout.slice(-2500),
          stderr: stderr.slice(-1800),
          calls: calls.map((c) => ({
            path: c.path,
            account: c.account,
            model: c.body?.model,
            previous_response_id: c.body?.previous_response_id,
          })),
          leases: readLeases(paths).leases.length,
        }),
      );
      assert.equal(code, 0, label + ' native exit');
      assert.equal(
        readLeases(paths).leases.length,
        0,
        label + ' released its lease',
      );
      return stdout;
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) terminate();
      await child.exited;
      clearTimeout(escalation);
    }
  }
  const out = await run('codex-open', [
    '--x-harness',
    'codex',
    '--x-no-yolo',
    '--x-account',
    'proof-codex-1',
    '-p',
    'proof',
    'exec',
    '--skip-git-repo-check',
    '--json',
    '-c',
    'mcp_servers.shadcn.enabled=false',
    '-c',
    'model_reasoning_effort="low"',
    'Say proof ok',
  ]);
  assert.ok(out.includes('proof ok'), 'native Codex emitted assistant content');
  const id = JSON.parse(
    out.split('\n').find((x) => x.includes('thread.started'))!,
  ).thread_id;
  quota = true;
  await run('codex-resume', [
    '--x-harness',
    'codex',
    '--x-no-yolo',
    '-p',
    'proof',
    'exec',
    'resume',
    id,
    '--skip-git-repo-check',
    '--json',
    '-c',
    'mcp_servers.shadcn.enabled=false',
    '-c',
    'model_reasoning_effort="low"',
    'Repeat the previous answer',
  ]);
  const claudeOut = await run('claude-open', [
    '--x-harness',
    'claude',
    '--x-no-yolo',
    '-p',
    'Say proof ok',
    '--output-format',
    'json',
    '--max-turns',
    '1',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--settings',
    '{"disableAllHooks":true}',
  ]);
  const lastCodex = calls.filter((c) => c.path.endsWith('/responses')).at(-1)!;
  if (
    !JSON.stringify(lastCodex.body?.input).includes('Say proof ok') ||
    !JSON.stringify(lastCodex.body?.input).includes('proof ok')
  )
    throw new Error('Native resume lost shared history');
  await changePool(paths, (p) => {
    p.accounts[0]!.quota_blocks = {};
  });
  // Rotation after the last codex-2 resume picks codex-1, whose rejection must transparently retry codex-2.
  const beforeQuota = calls.length;
  await run('codex-auto-quota', [
    '--x-harness',
    'codex',
    '--x-no-yolo',
    'exec',
    '--skip-git-repo-check',
    '--json',
    '-c',
    'mcp_servers.shadcn.enabled=false',
    'Say quota proof',
  ]);
  assert.deepEqual(
    calls
      .slice(beforeQuota)
      .filter((c) => c.path.endsWith('/responses'))
      .map((c) => c.account),
    ['proof-codex-1', 'proof-codex-2'],
    'automatic quota failover',
  );
  const claudeId = JSON.parse(claudeOut.trim()).session_id;
  await run('claude-resume', [
    'x-resume',
    claudeId,
    '--x-harness',
    'claude',
    '--x-no-yolo',
    '-p',
    'Repeat previous answer',
    '--output-format',
    'json',
    '--max-turns',
    '1',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--settings',
    '{"disableAllHooks":true}',
  ]);
  const claudeRequests = calls.filter((c) => c.path.endsWith('/messages'));
  assert.ok(
    JSON.stringify(claudeRequests.at(-1)?.body).includes('Say proof ok'),
    'Claude resume kept native history',
  );
  if (process.argv.includes('--interactive-window')) {
    const manifest = join(root, 'interactive.json');
    writeFileSync(manifest, JSON.stringify({ env, id, root, launchRoot }), {
      mode: 0o600,
    });
    console.log(JSON.stringify({ interactive_manifest: manifest }));
    console.log('INTERACTIVE_READY');
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (await Bun.file(join(root, 'interactive-done')).exists()) break;
      await Bun.sleep(200);
    }
  }
  console.log(
    JSON.stringify({
      result: 'passed',
      sharedCodexHome: env.CODEX_HOME,
      root,
      calls: calls.map((c) => ({ path: c.path, account: c.account })),
      leases: readLeases(paths).leases.length,
    }),
  );
} finally {
  await proxy?.stop(0);
  await upstream.stop(true);
  rmSync(root, { recursive: true, force: true });
}
