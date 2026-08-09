import { homedir } from "node:os";
import { join } from "node:path";

export interface StatePaths {
  stateRoot: string;
  claudeDir: string;
  codexDir: string;
  claudeObservation: string;
  claudeRefreshLock: string;
  codexObservation: string;
  codexRefreshLock: string;
  reservations: string;
  reservationsLock: string;
  fableFocusLeaf: string;
  nonFableFocusLeaf: string;
  claudeFullFocusLeaf: string;
  codexFullFocusLeaf: string;
}

export function statePaths(env: Record<string, string | undefined> = process.env): StatePaths {
  const stateRoot =
    env.AGENTUSAGE_STATE_ROOT && env.AGENTUSAGE_STATE_ROOT !== ""
      ? env.AGENTUSAGE_STATE_ROOT
      : join(homedir(), ".local", "state", "agentusage");
  const claudeDir = join(stateRoot, "account-routing");
  const codexDir = join(stateRoot, "codex-account-routing");
  return {
    stateRoot,
    claudeDir,
    codexDir,
    claudeObservation: join(claudeDir, "observation.json"),
    claudeRefreshLock: join(claudeDir, "observation.json.refresh.lock"),
    codexObservation: join(codexDir, "observation.json"),
    codexRefreshLock: join(codexDir, "observation.json.refresh.lock"),
    reservations: join(claudeDir, "reservations.json"),
    reservationsLock: join(claudeDir, "reservations.json.lock"),
    fableFocusLeaf: join(claudeDir, "fable-focus-policy.json"),
    nonFableFocusLeaf: join(claudeDir, "non-fable-focus-policy.json"),
    claudeFullFocusLeaf: join(claudeDir, "full-focus-policy.json"),
    codexFullFocusLeaf: join(codexDir, "full-focus-policy.json"),
  };
}

export function cswapArgv(env: Record<string, string | undefined> = process.env): string[] {
  const bin = env.AGENTUSAGE_CSWAP_BIN && env.AGENTUSAGE_CSWAP_BIN !== "" ? env.AGENTUSAGE_CSWAP_BIN : "cswap";
  return [bin];
}

export function codexSwapArgv(env: Record<string, string | undefined> = process.env): string[] {
  const bin =
    env.AGENTUSAGE_CODEX_SWAP_BIN && env.AGENTUSAGE_CODEX_SWAP_BIN !== ""
      ? env.AGENTUSAGE_CODEX_SWAP_BIN
      : "codex-swap";
  return [bin];
}
