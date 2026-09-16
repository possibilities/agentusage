import { buildGrokObservation } from '../src/grok/observe.ts';
import { nextGrokSourceRevision } from '../src/observe.ts';
import { account, billing, seedGrok } from './grok-fixtures.ts';
import { lockFile } from '../src/accounts/storage.ts';
import { writeSidecar } from '../src/sidecar.ts';
import type { StatePaths } from '../src/paths.ts';
export async function seedObservedGrok(paths: StatePaths): Promise<void> {
  const now = Date.now();
  const row = account(2, billing({included:{usedPercent:0, remainingPercent:100, periodType:"USAGE_PERIOD_TYPE_WEEKLY",periodStart:new Date(now-1000).toISOString(),resetsAt:new Date(now+86400_000).toISOString()}}), now);
  await seedGrok(paths, [row]);
  const observation = buildGrokObservation([row], now);
  observation.source_revision = nextGrokSourceRevision(null, now);
  writeSidecar(paths.grokObservation, observation);
  (await lockFile(paths.grokRefreshLock, 0))();
}
