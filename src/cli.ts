#!/usr/bin/env bun
import {
  CODEX_OBSERVATION_FRESHNESS_CEILING_MS,
  GROK_OBSERVATION_FRESHNESS_CEILING_MS,
  OBSERVATION_FRESHNESS_CEILING_MS,
} from './constants.ts';
import { displayNameForRouteId, type Observation } from './claude/types.ts';
import {
  laneHeadroomPercent,
  mainLane,
  type CodexObservation,
} from './codex/types.ts';
import { selectClaudeRoute, resolveRouteRef } from './balance/claude.ts';
import {
  codexAuthEligible,
  selectCodexAccount,
  selectCodexSpark,
} from './balance/codex.ts';
import { selectGrokAccount } from './balance/grok.ts';
import {
  readClaudeObservation,
  readCodexObservation,
  readGrokObservation,
  refreshClaudeObservation,
  refreshCodexObservation,
  refreshGrokObservation,
} from './observe.ts';
import { statePaths, type StatePaths } from './paths.ts';
import { AccountError } from './accounts/storage.ts';
import {
  changePool,
  findAccount,
  publicAccount,
  readPool,
} from './accounts/store.ts';
import { importFile, loginAccount } from './accounts/login.ts';
import { accessAccount } from './accounts/credentials.ts';
import { changeGrokAccount, importGrokState, listGrokAccounts, loginGrokAccount, recoverGrokAccount } from './grok/accounts.ts';
import { prepareLaunch } from './service/prepare.ts';
import { linesToText, renderFrameLines } from './render.ts';
import {
  effectiveClaudeFullFocus,
  effectiveCodexFullFocus,
  effectiveFableFocus,
  effectiveGrokFullFocus,
  effectiveNonFableFocus,
  materializeFocusPolicy,
  materializeFullFocusPolicy,
  normalizeRouteId,
  readFocusLeaf,
  readFullFocusLeaf,
  resolveObservedCodexWeeklyReset,
  resolveObservedFableReset,
  resolveObservedGrokIncludedReset,
  resolveObservedWeekReset,
  writeFocusLeaf,
  type AccountFocusLifetime,
  type CurrentResetFocusResult,
  type FableFocusLifetime,
  type FableFocusPolicy,
  type FocusDelivery,
  type FullFocusLifetime,
} from './focus.ts';
import { buildViewModel } from './view.ts';
import { grokAccountEligible, type GrokObservation } from './grok/types.ts';
import { daemonRun, daemonStatus } from './daemon.ts';
import { VERSION } from './version.ts';
import {
  guideEnvelope,
  renderAgentHelp,
  renderAgentTeaser,
  renderHelp,
} from './guide.ts';

interface Flags {
  booleans: Set<string>;
  strings: Map<string, string>;
  positionals: string[];
}

function parseFlags(
  args: readonly string[],
  booleanNames: readonly string[],
  stringNames: readonly string[],
): Flags | null {
  const flags: Flags = {
    booleans: new Set(),
    strings: new Map(),
    positionals: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) {
      flags.positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (booleanNames.includes(name)) {
      flags.booleans.add(name);
      continue;
    }
    if (stringNames.includes(name)) {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        console.error(`agentusage: --${name} requires a value`);
        return null;
      }
      flags.strings.set(name, value);
      index += 1;
      continue;
    }
    console.error(`agentusage: unknown flag --${name}`);
    return null;
  }
  return flags;
}

function parseDurationMs(value: string): number | null {
  const match = /^(\d+)(ms|s|m)$/u.exec(value);
  if (match === null) return null;
  const amount = Number(match[1]);
  if (match[2] === 'ms') return amount;
  if (match[2] === 's') return amount * 1000;
  return amount * 60_000;
}

/** Claude provider-focus targets are route ids; codex targets are accountKeys. */
function providerTargetName(
  provider: 'claude' | 'codex' | 'grok',
  target: string,
): string {
  return provider === 'claude' ? displayNameForRouteId(target) : target;
}

function emitJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function colorEnabled(): boolean {
  return process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
}

async function ensureFreshClaude(
  paths: StatePaths,
  env: NodeJS.ProcessEnv,
): Promise<Observation | null> {
  const current = readClaudeObservation(paths);
  const nowMs = Date.now();
  if (
    current !== null &&
    current.health === 'ok' &&
    nowMs - current.observed_at_ms <= OBSERVATION_FRESHNESS_CEILING_MS
  ) {
    return current;
  }
  const refreshed = await refreshClaudeObservation(paths, { env });
  return refreshed.value ?? current;
}

async function ensureFreshCodex(
  paths: StatePaths,
  env: NodeJS.ProcessEnv,
): Promise<CodexObservation | null> {
  const current = readCodexObservation(paths);
  const nowMs = Date.now();
  if (
    current !== null &&
    current.health === 'ok' &&
    nowMs - current.observed_at_ms <= CODEX_OBSERVATION_FRESHNESS_CEILING_MS
  ) {
    return current;
  }
  const refreshed = await refreshCodexObservation(paths, { env });
  return refreshed.value ?? current;
}

async function ensureFreshGrok(
  paths: StatePaths,
  env: NodeJS.ProcessEnv,
): Promise<GrokObservation | null> {
  const current = readGrokObservation(paths);
  const nowMs = Date.now();
  if (
    current !== null &&
    current.health === 'ok' &&
    nowMs - current.observed_at_ms <= GROK_OBSERVATION_FRESHNESS_CEILING_MS
  ) {
    return current;
  }
  // Ordinary refresh respects the owned Grok billing backoff. Explicit
  // `agentusage refresh grok` also retries accounts currently in backoff.
  const refreshed = await refreshGrokObservation(paths, {
    env,
    freshWithinMs: 0,
  });
  return refreshed.value ?? current;
}

function readFocusStates(
  paths: StatePaths,
  observation: Observation | null,
  codexObservation: CodexObservation | null,
  grokObservation: GrokObservation | null,
  nowMs: number,
) {
  const fableDelivery = readFocusLeaf(
    paths.fableFocusLeaf,
    true,
  ) as FocusDelivery<FableFocusPolicy>;
  const nonFableDelivery = readFocusLeaf(paths.nonFableFocusLeaf, false);
  return {
    fable: effectiveFableFocus(fableDelivery, observation, nowMs),
    nonFable: effectiveNonFableFocus(nonFableDelivery, nowMs),
    claudeFull: effectiveClaudeFullFocus(
      readFullFocusLeaf(paths.claudeFullFocusLeaf, 'claude'),
      observation,
      nowMs,
    ),
    codexFull: effectiveCodexFullFocus(
      readFullFocusLeaf(paths.codexFullFocusLeaf, 'codex'),
      codexObservation,
      nowMs,
    ),
    grokFull: effectiveGrokFullFocus(
      readFullFocusLeaf(paths.grokFullFocusLeaf, 'grok'),
      grokObservation,
      nowMs,
    ),
  };
}

// ---------------------------------------------------------------------------
// usage

async function usageCommand(args: string[]): Promise<number> {
  const flags = parseFlags(args, ['snapshot', 'watch', 'json'], ['timeout']);
  if (flags === null) return 2;
  if (flags.booleans.has('json') && flags.booleans.has('watch')) {
    console.error(
      'agentusage usage: --json and --watch are mutually exclusive',
    );
    return 2;
  }
  const paths = statePaths(process.env);

  const timeoutValue = flags.strings.get('timeout');
  if (timeoutValue !== undefined) {
    const timeoutMs = parseDurationMs(timeoutValue);
    if (timeoutMs === null) {
      console.error(
        `agentusage usage: bad --timeout ${timeoutValue} (unit required, e.g. 500ms, 2s)`,
      );
      return 2;
    }
    const deadline = Date.now() + timeoutMs;
    while (
      readClaudeObservation(paths) === null &&
      readCodexObservation(paths) === null &&
      readGrokObservation(paths) === null &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  if (flags.booleans.has('json')) {
    emitJson({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      claude: readClaudeObservation(paths),
      codex: readCodexObservation(paths),
      grok: readGrokObservation(paths),
    });
    return 0;
  }

  const live =
    flags.booleans.has('watch') ||
    (!flags.booleans.has('snapshot') &&
      process.stdout.isTTY === true &&
      process.env.CI === undefined &&
      process.env.TERM !== 'dumb');

  if (live) {
    const { runUsageTui } = await import('./tui/app.ts');
    await runUsageTui(paths);
    return 0;
  }

  const nowMs = Date.now();
  const claude = readClaudeObservation(paths);
  const codex = readCodexObservation(paths);
  const grok = readGrokObservation(paths);
  const focus = readFocusStates(paths, claude, codex, grok, nowMs);
  const vm = buildViewModel({
    claude,
    codex,
    grok,
    fable: focus.fable,
    nonFable: focus.nonFable,
    claudeFull: focus.claudeFull,
    codexFull: focus.codexFull,
    grokFull: focus.grokFull,
    nowMs,
  });
  const width = process.stdout.columns ?? 100;
  process.stdout.write(
    linesToText(renderFrameLines(vm, Math.min(width, 120)), colorEnabled()),
  );
  const meta = {
    schema_version: 1,
    claude:
      claude === null
        ? null
        : {
            health: claude.health,
            age_s: Math.round((nowMs - claude.observed_at_ms) / 1000),
            accounts: claude.claude_accounts.count,
          },
    codex:
      codex === null
        ? null
        : {
            health: codex.health,
            age_s: Math.round((nowMs - codex.observed_at_ms) / 1000),
            accounts: codex.accounts.length,
          },
    grok:
      grok === null
        ? null
        : {
            health: grok.health,
            age_s: Math.round((nowMs - grok.observed_at_ms) / 1000),
            accounts: grok.accounts.length,
          },
  };
  process.stdout.write(`agentusage-meta: ${JSON.stringify(meta)}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// status

async function statusCommand(args: string[]): Promise<number> {
  const flags = parseFlags(args, ['json'], []);
  if (flags === null) return 2;
  const paths = statePaths(process.env);
  const nowMs = Date.now();
  const claude = readClaudeObservation(paths);
  const codex = readCodexObservation(paths);
  const grok = readGrokObservation(paths);
  const focus = readFocusStates(paths, claude, codex, grok, nowMs);
  const codexFocusTarget =
    focus.codexFull.state === 'active' && focus.codexFull.policy !== null
      ? focus.codexFull.policy.target
      : null;

  const claudePreview =
    claude === null
      ? null
      : selectClaudeRoute({ observation: claude, paths, nowMs, dryRun: true });
  const claudeFablePreview =
    claude === null
      ? null
      : selectClaudeRoute({
          observation: claude,
          paths,
          nowMs,
          dryRun: true,
          fableIntent: true,
        });
  const sparkPreview =
    codex === null ? null : selectCodexSpark(codex, nowMs, codexFocusTarget);
  const grokPreview =
    grok === null
      ? null
      : await selectGrokAccount({
          observation: grok,
          focus: focus.grokFull,
          claim: false,
          nowMs,
        });

  if (flags.booleans.has('json')) {
    emitJson({
      schema_version: 1,
      generated_at: new Date(nowMs).toISOString(),
      claude:
        claude === null
          ? null
          : {
              health: claude.health,
              age_s: Math.round((nowMs - claude.observed_at_ms) / 1000),
              routes: claude.routes.length,
              issues: claude.account_issues,
            },
      codex:
        codex === null
          ? null
          : {
              health: codex.health,
              age_s: Math.round((nowMs - codex.observed_at_ms) / 1000),
              accounts: codex.accounts.length,
              recommendation: codex.recommendation,
            },
      grok:
        grok === null
          ? null
          : {
              health: grok.health,
              age_s: Math.round((nowMs - grok.observed_at_ms) / 1000),
              accounts: grok.accounts.length,
            },
      claude_focus: focus.claudeFull,
      codex_focus: focus.codexFull,
      grok_focus: focus.grokFull,
      fable_focus: focus.fable,
      non_fable_focus: focus.nonFable,
      previews: {
        claude: claudePreview,
        claude_fable: claudeFablePreview,
        codex_spark: sparkPreview,
        grok: grokPreview,
      },
    });
    return 0;
  }

  const describe = (label: string, value: string): void => {
    console.log(`${label.padEnd(16)} ${value}`);
  };
  describe(
    'claude',
    claude === null
      ? 'no observation'
      : `${claude.health} · ${Math.round((nowMs - claude.observed_at_ms) / 1000)}s old · ${claude.routes.length} routes`,
  );
  describe(
    'codex',
    codex === null
      ? 'no observation'
      : `${codex.health} · ${Math.round((nowMs - codex.observed_at_ms) / 1000)}s old · ${codex.accounts.length} accounts`,
  );
  describe(
    'grok',
    grok === null
      ? 'no observation'
      : `${grok.health} · ${Math.round((nowMs - grok.observed_at_ms) / 1000)}s old · ${grok.accounts.length} accounts`,
  );
  describe(
    'claude focus',
    focus.claudeFull.state === 'off'
      ? 'off'
      : `${focus.claudeFull.state} → ${focus.claudeFull.policy === null ? '?' : displayNameForRouteId(focus.claudeFull.policy.target)}`,
  );
  describe(
    'codex focus',
    focus.codexFull.state === 'off'
      ? 'off'
      : `${focus.codexFull.state} → ${focus.codexFull.policy?.target ?? '?'}`,
  );
  describe(
    'grok focus',
    focus.grokFull.state === 'off'
      ? 'off'
      : `${focus.grokFull.state} → ${focus.grokFull.policy?.target ?? '?'}`,
  );
  describe(
    'fable focus',
    focus.fable.state === 'off'
      ? 'off'
      : `${focus.fable.state} → ${focus.fable.policy === null ? '?' : displayNameForRouteId(focus.fable.policy.target_route)}`,
  );
  describe(
    'non-fable focus',
    focus.nonFable.state === 'off'
      ? 'off'
      : `${focus.nonFable.state} → ${focus.nonFable.policy === null ? '?' : displayNameForRouteId(focus.nonFable.policy.target_route)}`,
  );
  if (claudePreview !== null) {
    describe(
      'would choose',
      claudePreview.ok
        ? `${claudePreview.display_name} (${claudePreview.reason})`
        : claudePreview.refusal,
    );
  }
  if (claudeFablePreview !== null) {
    describe(
      '… for fable',
      claudeFablePreview.ok
        ? `${claudeFablePreview.display_name} (${claudeFablePreview.reason})`
        : claudeFablePreview.refusal,
    );
  }
  if (codex?.recommendation != null)
    describe('codex rec.', codex.recommendation.accountKey);
  if (sparkPreview !== null) {
    describe(
      'codex spark',
      sparkPreview.ok
        ? `${sparkPreview.accountKey} (${sparkPreview.score}% headroom)`
        : sparkPreview.refusal,
    );
  }
  if (grokPreview !== null) {
    describe(
      'grok choice',
      grokPreview.ok
        ? `${grokPreview.displayName} (${grokPreview.reason})`
        : grokPreview.refusal,
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// balance

async function balanceCommand(args: string[]): Promise<number> {
  const provider = args[0];
  if (provider !== 'claude' && provider !== 'codex' && provider !== 'grok') {
    console.error('agentusage balance: expected provider claude|codex|grok');
    return 2;
  }
  const rest = args.slice(1);
  const paths = statePaths(process.env);

  if (provider === 'claude') {
    const flags = parseFlags(
      rest,
      ['fable', 'no-fable', 'dry-run', 'json'],
      ['model', 'account'],
    );
    if (flags === null) return 2;
    if (flags.booleans.has('fable') && flags.booleans.has('no-fable')) {
      console.error(
        'agentusage balance claude: --fable and --no-fable are mutually exclusive',
      );
      return 2;
    }
    const fableIntent = flags.booleans.has('fable')
      ? true
      : flags.booleans.has('no-fable')
        ? false
        : null;
    const observation = flags.booleans.has('dry-run')
      ? readClaudeObservation(paths)
      : await ensureFreshClaude(paths, process.env);
    if (observation === null) {
      const failure = {
        schema_version: 1,
        provider: 'claude',
        ok: false,
        refusal: 'observation-unavailable',
        detail: 'no Claude observation; add an account and refresh',
      };
      if (flags.booleans.has('json')) emitJson(failure);
      else console.error(`agentusage: ${failure.detail}`);
      return 1;
    }
    const selection = selectClaudeRoute({
      observation,
      paths,
      model: flags.strings.get('model') ?? null,
      fableIntent,
      requestedRoute: flags.strings.get('account') ?? null,
      dryRun: flags.booleans.has('dry-run'),
    });
    if (flags.booleans.has('json')) {
      emitJson({ schema_version: 1, provider: 'claude', ...selection });
    } else if (selection.ok) {
      console.log(
        `${selection.route.id} (${selection.display_name}) — ${selection.reason}`,
      );
      console.log(
        `prepare: agentusage prepare claude --account ${selection.route.id} --json`,
      );
    } else {
      console.error(`agentusage: ${selection.refusal}: ${selection.detail}`);
    }
    if (selection.ok) return 0;
    return selection.refusal === 'no-eligible-account' ? 3 : 1;
  }

  if (provider === 'grok') {
    const flags = parseFlags(
      rest,
      ['claim', 'dry-run', 'json', 'allow-unknown'],
      ['strategy', 'account', 'reserve-seconds'],
    );
    if (flags === null) return 2;
    if (flags.booleans.has('claim') && flags.booleans.has('dry-run')) {
      console.error(
        'agentusage balance grok: --claim and --dry-run are mutually exclusive',
      );
      return 2;
    }
    const strategy = flags.strings.get('strategy');
    if (
      strategy !== undefined &&
      strategy !== 'best' &&
      strategy !== 'next-available'
    ) {
      console.error(
        'agentusage balance grok: --strategy must be best|next-available',
      );
      return 2;
    }
    if (strategy !== undefined && flags.strings.has('account')) {
      console.error(
        'agentusage balance grok: --strategy and --account are mutually exclusive',
      );
      return 2;
    }
    let reserveSeconds: number | undefined;
    const reserveToken = flags.strings.get('reserve-seconds');
    if (reserveToken !== undefined) {
      reserveSeconds = Number(reserveToken);
      if (
        !Number.isSafeInteger(reserveSeconds) ||
        reserveSeconds < 1 ||
        reserveSeconds > 300
      ) {
        console.error(
          'agentusage balance grok: --reserve-seconds must be an integer from 1 to 300',
        );
        return 2;
      }
      if (!flags.booleans.has('claim')) {
        console.error(
          'agentusage balance grok: --reserve-seconds requires --claim',
        );
        return 2;
      }
    }
    const delivery = readFullFocusLeaf(paths.grokFullFocusLeaf, 'grok');
    const observation =
      delivery.policy === null
        ? readGrokObservation(paths)
        : await ensureFreshGrok(paths, process.env);
    const nowMs = Date.now();
    const grokFocus = effectiveGrokFullFocus(delivery, observation, nowMs);
    const selection = await selectGrokAccount({
      strategy: strategy as 'best' | 'next-available' | undefined,
      account: flags.strings.get('account'),
      claim: flags.booleans.has('claim'),
      reserveSeconds,
      allowUnknown: flags.booleans.has('allow-unknown'),
      observation,
      focus: grokFocus,
      nowMs,
    });
    if (flags.booleans.has('json')) {
      emitJson({
        schema_version: 1,
        provider: 'grok',
        focus: {
          state: grokFocus.state,
          target: grokFocus.policy?.target ?? null,
        },
        ...selection,
      });
    } else if (selection.ok) {
      const dollars =
        selection.score.remainingDollars === null
          ? ''
          : ` · $${selection.score.remainingDollars.toFixed(2)} remaining`;
      const included =
        selection.score.remainingIncludedPercent === null
          ? ''
          : ` · ${Math.round(selection.score.remainingIncludedPercent * 10) / 10}% included remaining`;
      const reservation =
        selection.reservation === null
          ? ''
          : ` · reservation ${selection.reservation.id} until ${selection.reservation.expiresAt ?? '?'}`;
      console.log(
        `${selection.displayName} — ${selection.reason} · ${selection.score.tier}${included}${dollars}${reservation}`,
      );
      console.log('selection only; no Grok harness activation is configured');
    } else {
      console.error(`agentusage: ${selection.refusal}: ${selection.detail}`);
    }
    if (selection.ok) return 0;
    return selection.refusal === 'no-eligible-account' ? 3 : 1;
  }

  const flags = parseFlags(
    rest,
    ['claim', 'dry-run', 'json', 'allow-unknown'],
    ['model', 'strategy', 'account'],
  );
  if (flags === null) return 2;
  if (flags.booleans.has('claim') && flags.booleans.has('dry-run')) {
    console.error(
      'agentusage balance: --claim and --dry-run are mutually exclusive',
    );
    return 2;
  }
  const strategy = flags.strings.get('strategy');
  if (
    strategy !== undefined &&
    strategy !== 'best' &&
    strategy !== 'next-available'
  ) {
    console.error(
      'agentusage balance codex: --strategy must be best|next-available',
    );
    return 2;
  }
  const pathsEnv = process.env;
  const observation = flags.booleans.has('dry-run')
    ? readCodexObservation(paths)
    : await ensureFreshCodex(paths, pathsEnv);
  const nowMs = Date.now();
  const focus = effectiveCodexFullFocus(
    readFullFocusLeaf(paths.codexFullFocusLeaf, 'codex'),
    observation,
    nowMs,
  );
  const selection = await selectCodexAccount({
    observation,
    focus,
    nowMs,
    env: pathsEnv,
    model: flags.strings.get('model'),
    account: flags.strings.get('account'),
    strategy: strategy as 'best' | 'next-available' | undefined,
    claim: flags.booleans.has('claim'),
    allowUnknown: flags.booleans.has('allow-unknown'),
  });
  if (flags.booleans.has('json'))
    emitJson({ schema_version: 1, provider: 'codex', ...selection });
  else if (selection.ok)
    console.log(`${selection.accountKey} — ${selection.reason}`);
  else console.error(`agentusage: ${selection.refusal}: ${selection.detail}`);
  return selection.ok ? 0 : 3;
}

// ---------------------------------------------------------------------------
// focus

type FocusKind = 'fable' | 'non-fable' | 'claude' | 'codex' | 'grok';
type FocusAction = 'show' | 'set' | 'clear';

function isFocusKind(value: string | undefined): value is FocusKind {
  return (
    value === 'fable' ||
    value === 'non-fable' ||
    value === 'claude' ||
    value === 'codex' ||
    value === 'grok'
  );
}

function isFocusAction(value: string | undefined): value is FocusAction {
  return value === 'show' || value === 'set' || value === 'clear';
}

async function focusCommand(args: string[]): Promise<number> {
  // The contract spells this action-first — `focus set fable <ref> <lifetime>` —
  // but the target-first order it replaced (`focus fable set …`) is still
  // accepted, unchanged, for everything already typed or scripted.
  let kind: FocusKind;
  let action: FocusAction;
  if (isFocusAction(args[0]) && isFocusKind(args[1])) {
    action = args[0];
    kind = args[1];
  } else if (isFocusKind(args[0]) && isFocusAction(args[1])) {
    kind = args[0];
    action = args[1];
  } else if (isFocusKind(args[0])) {
    console.error('agentusage focus: expected show|set|clear');
    return 2;
  } else {
    console.error(
      'agentusage focus: expected fable|non-fable|claude|codex|grok',
    );
    return 2;
  }
  const flags = parseFlags(
    args.slice(2),
    ['json', 'require-eligible'],
    ['expect-reset'],
  );
  if (flags === null) return 2;
  const paths = statePaths(process.env);
  const nowMs = Date.now();
  if (kind === 'claude' || kind === 'codex' || kind === 'grok') {
    return fullFocusAction(kind, action, flags, paths, nowMs);
  }
  const leafPath =
    kind === 'fable' ? paths.fableFocusLeaf : paths.nonFableFocusLeaf;

  if (action === 'show') {
    const observation = readClaudeObservation(paths);
    const status =
      kind === 'fable'
        ? effectiveFableFocus(
            readFocusLeaf(leafPath, true) as FocusDelivery<FableFocusPolicy>,
            observation,
            nowMs,
          )
        : effectiveNonFableFocus(readFocusLeaf(leafPath, false), nowMs);
    if (flags.booleans.has('json'))
      emitJson({ schema_version: 1, kind, ...status });
    else if (status.state === 'off') console.log(`${kind} focus: off`);
    else {
      console.log(
        `${kind} focus: ${status.state}${status.policy === null ? '' : ` → ${displayNameForRouteId(status.policy.target_route)} (${status.policy.lifetime.kind})`}${
          status.diagnostic === 'none' ? '' : ` [${status.diagnostic}]`
        }`,
      );
    }
    return 0;
  }

  if (action === 'clear') {
    writeFocusLeaf(leafPath, null);
    if (flags.booleans.has('json'))
      emitJson({ schema_version: 1, kind, cleared: true });
    else console.log(`${kind} focus cleared`);
    return 0;
  }

  const targetRef = flags.positionals[0];
  const lifetimeToken = flags.positionals[1];
  if (targetRef === undefined || lifetimeToken === undefined) {
    console.error(
      `agentusage focus ${kind} set: expected <route|claude-N> <lifetime>`,
    );
    return 2;
  }

  const observation = await ensureFreshClaude(paths, process.env);
  let targetRoute: string | null = null;
  if (observation !== null)
    targetRoute = resolveRouteRef(observation, targetRef);
  if (targetRoute === null) targetRoute = normalizeRouteId(targetRef);
  if (targetRoute === null) {
    console.error(
      `agentusage focus: cannot resolve target ${targetRef} (no fresh observation and not a route id)`,
    );
    return 1;
  }

  let lifetime: FableFocusLifetime | AccountFocusLifetime;
  if (lifetimeToken === 'permanent') {
    lifetime = { kind: 'permanent' };
  } else if (lifetimeToken === 'absolute') {
    const deadline = flags.positionals[2];
    if (deadline === undefined) {
      console.error(
        'agentusage focus set: absolute lifetime requires a UTC deadline',
      );
      return 2;
    }
    const deadlineMs = Date.parse(deadline);
    if (
      !Number.isFinite(deadlineMs) ||
      !/(?:[zZ]|[+-]\d{2}:?\d{2})$/u.test(deadline)
    ) {
      console.error(`agentusage focus set: bad UTC deadline ${deadline}`);
      return 2;
    }
    if (deadlineMs <= nowMs) {
      console.error('agentusage focus set: deadline is already elapsed');
      return 1;
    }
    lifetime = {
      kind: 'absolute',
      deadline_at: new Date(deadlineMs).toISOString(),
    };
  } else if (
    (lifetimeToken === 'current-reset' || lifetimeToken === 'cycle-end') &&
    kind === 'fable'
  ) {
    const resolved = resolveObservedFableReset(
      observation,
      targetRoute,
      nowMs,
      flags.strings.get('expect-reset') ?? null,
    );
    if (!resolved.ok) {
      console.error(`agentusage focus set: ${resolved.error}`);
      return 1;
    }
    lifetime =
      lifetimeToken === 'current-reset'
        ? { kind: 'absolute', deadline_at: resolved.resetAt }
        : { kind: 'cycle-end', reset_at: resolved.resetAt };
  } else {
    console.error(
      `agentusage focus ${kind} set: unsupported lifetime ${lifetimeToken}`,
    );
    return 2;
  }

  if (observation !== null) {
    const route = observation.routes.find(
      (candidate) => candidate.id === targetRoute,
    );
    const eligible = route !== undefined;
    if (!eligible) {
      const message = `target ${targetRoute} is not currently launch-eligible`;
      if (flags.booleans.has('require-eligible')) {
        console.error(`agentusage focus set: ${message}`);
        return 1;
      }
      console.error(`agentusage focus set: warning: ${message}`);
    }
  }

  if (kind === 'fable') {
    writeFocusLeaf(
      leafPath,
      materializeFocusPolicy(
        targetRoute,
        lifetime as FableFocusLifetime,
        true,
        nowMs,
      ),
    );
  } else {
    writeFocusLeaf(
      leafPath,
      materializeFocusPolicy(
        targetRoute,
        lifetime as AccountFocusLifetime,
        false,
        nowMs,
      ),
    );
  }
  if (flags.booleans.has('json'))
    emitJson({ schema_version: 1, kind, target_route: targetRoute, lifetime });
  else
    console.log(
      `${kind} focus → ${displayNameForRouteId(targetRoute)} (${lifetime.kind})`,
    );
  return 0;
}

function parseAbsoluteDeadline(
  deadline: string | undefined,
  nowMs: number,
): { ok: true; iso: string } | { ok: false; code: number; message: string } {
  if (deadline === undefined)
    return {
      ok: false,
      code: 2,
      message: 'absolute lifetime requires a UTC deadline',
    };
  const deadlineMs = Date.parse(deadline);
  if (
    !Number.isFinite(deadlineMs) ||
    !/(?:[zZ]|[+-]\d{2}:?\d{2})$/u.test(deadline)
  ) {
    return { ok: false, code: 2, message: `bad UTC deadline ${deadline}` };
  }
  if (deadlineMs <= nowMs)
    return { ok: false, code: 1, message: 'deadline is already elapsed' };
  return { ok: true, iso: new Date(deadlineMs).toISOString() };
}

async function fullFocusAction(
  provider: 'claude' | 'codex' | 'grok',
  action: 'show' | 'set' | 'clear',
  flags: Flags,
  paths: StatePaths,
  nowMs: number,
): Promise<number> {
  const leafPath =
    provider === 'claude'
      ? paths.claudeFullFocusLeaf
      : provider === 'codex'
        ? paths.codexFullFocusLeaf
        : paths.grokFullFocusLeaf;

  if (action === 'show') {
    const delivery = readFullFocusLeaf(leafPath, provider);
    const status =
      provider === 'claude'
        ? effectiveClaudeFullFocus(
            delivery,
            readClaudeObservation(paths),
            nowMs,
          )
        : provider === 'codex'
          ? effectiveCodexFullFocus(
              delivery,
              readCodexObservation(paths),
              nowMs,
            )
          : effectiveGrokFullFocus(delivery, readGrokObservation(paths), nowMs);
    if (flags.booleans.has('json'))
      emitJson({ schema_version: 1, kind: provider, ...status });
    else if (status.state === 'off') console.log(`${provider} focus: off`);
    else {
      console.log(
        `${provider} focus: ${status.state}${status.policy === null ? '' : ` → ${providerTargetName(provider, status.policy.target)} (${status.policy.lifetime.kind})`}${
          status.diagnostic === 'none' ? '' : ` [${status.diagnostic}]`
        }`,
      );
    }
    return 0;
  }

  if (action === 'clear') {
    writeFocusLeaf(leafPath, null);
    if (flags.booleans.has('json'))
      emitJson({ schema_version: 1, kind: provider, cleared: true });
    else console.log(`${provider} focus cleared`);
    return 0;
  }

  const targetRef = flags.positionals[0];
  const lifetimeToken = flags.positionals[1];
  if (targetRef === undefined || lifetimeToken === undefined) {
    console.error(
      `agentusage focus ${provider} set: expected <${provider === 'claude' ? 'route|claude-N' : provider === 'grok' ? 'accountKey|grok-N' : 'accountKey'}> <lifetime>`,
    );
    return 2;
  }

  let target: string;
  let eligible: boolean | null;
  let resolveReset: (expect: string | null) => CurrentResetFocusResult;

  if (provider === 'claude') {
    const observation = await ensureFreshClaude(paths, process.env);
    let resolved =
      observation === null ? null : resolveRouteRef(observation, targetRef);
    if (resolved === null) resolved = normalizeRouteId(targetRef);
    if (resolved === null) {
      console.error(
        `agentusage focus: cannot resolve target ${targetRef} (no fresh observation and not a route id)`,
      );
      return 1;
    }
    const targetRoute = resolved;
    target = targetRoute;
    eligible =
      observation === null
        ? null
        : observation.routes.some((route) => route.id === targetRoute);
    resolveReset = (expect) =>
      resolveObservedWeekReset(observation, targetRoute, nowMs, expect);
  } else if (provider === 'codex') {
    const observation = await ensureFreshCodex(paths, process.env);
    if (observation === null || observation.health !== 'ok') {
      console.error(
        'agentusage focus codex set: needs a fresh codex observation to resolve the account',
      );
      return 1;
    }
    const account = observation.accounts.find(
      (candidate) => candidate.accountKey === targetRef,
    );
    if (account === undefined) {
      console.error(
        `agentusage focus codex set: unknown codex account ${targetRef}`,
      );
      return 1;
    }
    target = account.accountKey;
    const lane = mainLane(account);
    const headroom = lane === null ? null : laneHeadroomPercent(lane);
    eligible = codexAuthEligible(account) && headroom !== null && headroom > 0;
    resolveReset = (expect) =>
      resolveObservedCodexWeeklyReset(
        observation,
        account.accountKey,
        nowMs,
        expect,
      );
  } else {
    const observation = await ensureFreshGrok(paths, process.env);
    if (observation === null || observation.health !== 'ok') {
      console.error(
        'agentusage focus grok set: needs a fresh grok observation to resolve the account',
      );
      return 1;
    }
    const account = observation.accounts.find(
      (candidate) =>
        candidate.accountKey === targetRef ||
        candidate.displayName === targetRef,
    );
    if (account === undefined) {
      console.error(
        `agentusage focus grok set: unknown grok account ${targetRef}`,
      );
      return 1;
    }
    target = account.accountKey;
    eligible = grokAccountEligible(account);
    resolveReset = (expect) =>
      resolveObservedGrokIncludedReset(
        observation,
        account.accountKey,
        nowMs,
        expect,
      );
  }

  let lifetime: FullFocusLifetime;
  if (lifetimeToken === 'permanent') {
    lifetime = { kind: 'permanent' };
  } else if (lifetimeToken === 'absolute') {
    const deadline = parseAbsoluteDeadline(flags.positionals[2], nowMs);
    if (!deadline.ok) {
      console.error(`agentusage focus set: ${deadline.message}`);
      return deadline.code;
    }
    lifetime = { kind: 'absolute', deadline_at: deadline.iso };
  } else if (
    lifetimeToken === 'current-reset' ||
    lifetimeToken === 'cycle-end'
  ) {
    const resolved = resolveReset(flags.strings.get('expect-reset') ?? null);
    if (!resolved.ok) {
      console.error(`agentusage focus set: ${resolved.error}`);
      return 1;
    }
    lifetime =
      lifetimeToken === 'current-reset'
        ? { kind: 'absolute', deadline_at: resolved.resetAt }
        : { kind: 'cycle-end', reset_at: resolved.resetAt };
  } else {
    console.error(
      `agentusage focus ${provider} set: unsupported lifetime ${lifetimeToken}`,
    );
    return 2;
  }

  if (eligible === false) {
    const message = `target ${target} is not currently launch-eligible`;
    if (flags.booleans.has('require-eligible')) {
      console.error(`agentusage focus set: ${message}`);
      return 1;
    }
    console.error(`agentusage focus set: warning: ${message}`);
  }

  writeFocusLeaf(
    leafPath,
    materializeFullFocusPolicy(provider, target, lifetime, nowMs),
  );
  if (flags.booleans.has('json'))
    emitJson({ schema_version: 1, kind: provider, target, lifetime });
  else
    console.log(
      `${provider} focus → ${providerTargetName(provider, target)} (${lifetime.kind})`,
    );
  return 0;
}

// ---------------------------------------------------------------------------
// recover / refresh / daemon

async function accountsCommand(args: string[]): Promise<number> {
  const [action, provider, ...rest] = args;
  if (provider !== 'claude' && provider !== 'codex' && provider !== 'grok') {
    console.error(
      'agentusage accounts: expected list|import|login|enable|disable|remove|label claude|codex|grok',
    );
    return 2;
  }
  const flags = parseFlags(
    rest,
    ['json', 'device-auth', 'no-open', 'clear-label'],
    ['file', 'label', 'account'],
  );
  if (!flags) return 2;
  const paths = statePaths(process.env);
  try {
    if (provider === 'grok') {
      const result = await grokAccountsCommand(action, flags, paths);
      emitJson({ schema_version: 1, ok: true, provider, ...result });
      return 0;
    }
    if (flags.booleans.has('no-open') || flags.booleans.has('clear-label'))
      throw new AccountError('invalid-option', '--no-open and --clear-label apply to Grok account commands');
    let result: unknown;
    if (action === 'list')
      result = {
        accounts: readPool(paths)
          .accounts.filter((a) => a.provider === provider)
          .map(publicAccount),
      };
    else if (action === 'import') {
      const file = flags.strings.get('file');
      if (!file)
        throw new AccountError(
          'missing-file',
          'accounts import requires --file PATH',
        );
      result = {
        account: await importFile(paths, provider, file, {
          label: flags.strings.get('label'),
          account: flags.strings.get('account'),
        }),
      };
    } else if (action === 'login') {
      if (flags.booleans.has('device-auth') && provider !== 'codex')
        throw new AccountError(
          'invalid-option',
          '--device-auth is supported for Codex only',
        );
      result = {
        account: await loginAccount(paths, provider, {
          label: flags.strings.get('label'),
          account: flags.strings.get('account'),
          deviceAuth: flags.booleans.has('device-auth'),
        }),
      };
    } else if (
      action === 'enable' ||
      action === 'disable' ||
      action === 'remove'
    ) {
      const selector = flags.positionals[0] ?? flags.strings.get('account');
      if (!selector)
        throw new AccountError(
          'missing-account',
          'Account action requires a selector',
        );
      result = await changePool(paths, (pool) => {
        const account = findAccount(pool, provider, selector);
        if (action === 'remove')
          pool.accounts = pool.accounts.filter((a) => a !== account);
        else account.enabled = action === 'enable';
        return {
          account: publicAccount(account),
          removed: action === 'remove',
        };
      });
    } else {
      console.error(
        'agentusage accounts: expected list|import|login|enable|disable|remove',
      );
      return 2;
    }
    // Account management never prints credentials, even without --json.
    emitJson({ schema_version: 1, ok: true, provider, ...(result as object) });
    return 0;
  } catch (error) {
    return accountFailure(provider, error, flags.booleans.has('json'));
  }
}

async function grokAccountsCommand(action: string | undefined, flags: Flags, paths: StatePaths): Promise<object> {
  const actions = ['list', 'import', 'login', 'enable', 'disable', 'remove', 'label'];
  if (!action || !actions.includes(action)) throw new AccountError('invalid-action', 'Unknown Grok account action');
  const allowedStrings = action === 'import' ? ['file']
    : action === 'login' || action === 'label' ? ['account', 'label']
    : action === 'list' ? [] : ['account'];
  const allowedBooleans = ['json', ...(action === 'login' ? ['device-auth', 'no-open'] : action === 'label' ? ['clear-label'] : [])];
  if ([...flags.strings.keys()].some((name) => !allowedStrings.includes(name)) ||
      [...flags.booleans].some((name) => !allowedBooleans.includes(name)))
    throw new AccountError('invalid-option', 'The option does not apply to this Grok account action');
  const needsSelector = ['enable', 'disable', 'remove', 'label'].includes(action);
  if (flags.positionals.length > (needsSelector ? 1 : 0) ||
      (flags.positionals.length > 0 && flags.strings.has('account')))
    throw new AccountError('invalid-argument', 'Supply exactly one account selector for an account action');
  if (action === 'list') return { accounts: await listGrokAccounts(paths) };
  if (action === 'import') {
    const file = flags.strings.get('file');
    if (!file) throw new AccountError('missing-file', 'accounts import grok requires --file PATH');
    return importGrokState(paths, file);
  }
  if (action === 'login') return {
    account: await loginGrokAccount(paths, {
      label: flags.strings.get('label'), account: flags.strings.get('account'),
      openBrowser: !flags.booleans.has('no-open'),
      onPrompt: ({ verificationUri, userCode, expiresIn }) => {
        console.error(`Open ${verificationUri}\nEnter code: ${userCode}\nWaiting for xAI authorization (expires in ${expiresIn}s)…`);
      },
    }),
  };
  const selector = flags.positionals[0] ?? flags.strings.get('account');
  if (!selector) throw new AccountError('missing-account', 'Account action requires a selector');
  const clearLabel = flags.booleans.has('clear-label');
  const label = flags.strings.get('label');
  if (action === 'label' && Number(clearLabel) + Number(label !== undefined) !== 1)
    throw new AccountError('invalid-option', 'Use exactly one of --label TEXT or --clear-label');
  return changeGrokAccount(paths, action as 'enable' | 'disable' | 'remove' | 'label', selector, clearLabel ? null : label);
}

function accountFailure(
  provider: string,
  error: unknown,
  json: boolean,
): number {
  const refusal =
    error instanceof AccountError ? error.code : 'account-operation-failed';
  const detail =
    error instanceof AccountError ? error.message : 'Account operation failed';
  if (json)
    emitJson({ schema_version: 1, ok: false, provider, refusal, detail });
  else console.error(`agentusage: ${refusal}: ${detail}`);
  return 1;
}

async function prepareCommand(args: string[]): Promise<number> {
  const [provider, ...rest] = args;
  if (provider !== 'claude' && provider !== 'codex') {
    console.error('agentusage prepare: expected claude|codex');
    return 2;
  }
  const flags = parseFlags(rest, ['json', 'dry-run'], ['account', 'model']);
  if (!flags) return 2;
  if (!flags.booleans.has('json') || flags.positionals.length) {
    console.error(
      'agentusage prepare requires --json (private launcher transport)',
    );
    return 2;
  }
  try {
    const prepared = await prepareLaunch(statePaths(process.env), provider, {
      account: flags.strings.get('account'),
      model: flags.strings.get('model'),
      dryRun: flags.booleans.has('dry-run'),
    });
    emitJson({ schema_version: 1, ok: true, ...prepared });
    return 0;
  } catch (error) {
    return accountFailure(provider, error, true);
  }
}

async function recoverCommand(args: string[]): Promise<number> {
  const flags = parseFlags(args, ['json'], []);
  if (!flags) return 2;
  const key = flags.positionals[0];
  if (!key || !/^(claude|codex|grok)-[1-9]\d*$/u.test(key)) {
    console.error(
      'agentusage recover: expected claude-N|codex-N|grok-N; use accounts login to reauthenticate',
    );
    return 2;
  }
  try {
    if (key.startsWith('grok-')) {
      const account = await recoverGrokAccount(statePaths(process.env), key);
      emitJson({ schema_version: 1, ok: true, account });
      return 0;
    }
    const account = await accessAccount(statePaths(process.env), key);
    emitJson({ schema_version: 1, ok: true, account: publicAccount(account) });
    return 0;
  } catch (error) {
    return accountFailure(
      key.split('-')[0]!,
      error,
      flags.booleans.has('json'),
    );
  }
}

async function refreshCommand(args: string[]): Promise<number> {
  const flags = parseFlags(args, ['json'], ['account']);
  if (flags === null) return 2;
  const scope = flags.positionals[0] ?? 'all';
  if (
    scope !== 'claude' &&
    scope !== 'codex' &&
    scope !== 'grok' &&
    scope !== 'all'
  ) {
    console.error('agentusage refresh: expected claude|codex|grok|all');
    return 2;
  }
  if (flags.positionals.length > 1 || (flags.strings.has('account') && scope !== 'grok')) {
    console.error('agentusage refresh: --account requires the grok scope');
    return 2;
  }
  const paths = statePaths(process.env);
  const outcomes: Record<string, unknown> = {};
  if (scope === 'claude' || scope === 'all') {
    const result = await refreshClaudeObservation(paths, { freshWithinMs: 0 });
    outcomes.claude = {
      outcome: result.outcome,
      health: result.value?.health ?? null,
    };
  }
  if (scope === 'codex' || scope === 'all') {
    const result = await refreshCodexObservation(paths, { freshWithinMs: 0 });
    outcomes.codex = {
      outcome: result.outcome,
      health: result.value?.health ?? null,
    };
  }
  if (scope === 'grok' || scope === 'all') {
    const result = await refreshGrokObservation(paths, {
      freshWithinMs: 0,
      providerRefresh: true,
      account: flags.strings.get('account'),
    });
    outcomes.grok = {
      outcome: result.outcome,
      health: result.value?.health ?? null,
    };
  }
  if (flags.booleans.has('json')) emitJson({ schema_version: 1, ...outcomes });
  else {
    for (const [provider, summary] of Object.entries(outcomes)) {
      const value = summary as { outcome: string; health: string | null };
      console.log(
        `${provider}: ${value.outcome}${value.health === null ? '' : ` (health ${value.health})`}`,
      );
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case 'usage':
      return usageCommand(rest);
    case 'status':
      return statusCommand(rest);
    case 'accounts':
      return accountsCommand(rest);
    case 'prepare':
      return prepareCommand(rest);
    case 'balance':
      return balanceCommand(rest);
    case 'focus':
      return focusCommand(rest);
    case 'recover':
      return recoverCommand(rest);
    case 'refresh':
      return refreshCommand(rest);
    case 'daemon': {
      const mode = rest[0] ?? 'run';
      if (mode === 'status') return daemonStatus();
      if (mode === 'run') {
        await daemonRun();
        return 0;
      }
      console.error('agentusage daemon: expected run|status');
      return 2;
    }
    case 'guide': {
      const flags = parseFlags(rest, ['json'], []);
      if (flags === null) return 2;
      emitJson(guideEnvelope());
      return 0;
    }
    case '--agent-help':
      console.log(renderAgentHelp());
      return 0;
    case '--agent-teaser':
      console.log(renderAgentTeaser());
      return 0;
    case 'help':
    case '--help':
    case '-h':
      console.log(renderHelp());
      return 0;
    case 'version':
    case '--version':
      console.log(VERSION);
      return 0;
    default:
      console.error(`agentusage: unknown command ${command}\n`);
      console.log(renderHelp());
      return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`agentusage: ${String(error)}`);
      process.exit(1);
    },
  );
}
