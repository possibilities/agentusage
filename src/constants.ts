/**
 * Freshness and pacing constants, mirroring keeper's account-routing-config
 * values so balance behavior matches the old system observation-for-observation.
 */

/** Balance refuses to act on a claude observation older than this. */
export const OBSERVATION_FRESHNESS_CEILING_MS = 5 * 60_000;

export const OBSERVE_INTERVAL_MS = 3 * 60_000;
export const OBSERVE_JITTER_MS = 30_000;

/** Codex sidecar shares the claude ceiling; codex-swap paces real fetches. */
export const CODEX_OBSERVATION_FRESHNESS_CEILING_MS = 5 * 60_000;

export const RESERVATION_TTL_MS = 90_000;
export const RESERVATION_UTILIZATION_STEP = 0.05;
export const MAX_RESERVATIONS_PER_ROUTE = 64;
export const MAX_LEDGER_ROUTES = 64;

export const SUBPROCESS_TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_BYTES = 262_144;
export const MAX_CSWAP_ACCOUNTS = 32;

/** Wake this long after an exhausted weekly window's reset to observe it. */
export const WEEKLY_RESET_WAKE_SLACK_MS = 30_000;

/** At most one `cswap recover` attempt per account per this interval. */
export const RECOVERY_MIN_INTERVAL_MS = 15 * 60_000;
export const RECOVERY_TIMEOUT_MS = 120_000;

/** Focus leaves larger than this are refused as malformed. */
export const FOCUS_LEAF_MAX_BYTES = 8_192;
