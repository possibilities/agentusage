/** Maximum authority carried without revalidation. */
export const FX_ROLLING_LEASE_MS = 5 * 60_000;

/** Idle bridges start renewing before this much authority remains. */
export const FX_RENEW_BEFORE_EXPIRY_MS = 60_000;

/** Leave a bounded interval to persist the provider result before expiry. */
export const FX_PROVIDER_RESPONSE_SAFETY_MS = 5_000;

/**
 * One admitted provider response may use the rolling horizon outside the idle
 * renewal window. This keeps the request finite without retaining the former
 * hidden two-minute ceiling beneath AgentFX's longer prompt deadline.
 */
export const FX_PROVIDER_REQUEST_BUDGET_MS =
  FX_ROLLING_LEASE_MS -
  FX_RENEW_BEFORE_EXPIRY_MS -
  FX_PROVIDER_RESPONSE_SAFETY_MS;

/** Renew before admission unless one full request budget and safety remain. */
export const FX_MIN_FORWARD_AUTHORITY_MS =
  FX_PROVIDER_REQUEST_BUDGET_MS + FX_PROVIDER_RESPONSE_SAFETY_MS;

/** Bound a provider response by both policy and its admitted lease deadline. */
export function fxProviderRequestBudgetMs(
  executionDeadlineMs: number,
  nowMs = Date.now(),
): number {
  return Math.min(
    FX_PROVIDER_REQUEST_BUDGET_MS,
    executionDeadlineMs - nowMs,
  );
}
