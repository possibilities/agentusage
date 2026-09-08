import { AccountError } from "../accounts/storage.ts";

export type AuthStatus = "valid" | "expired" | "missing" | "error";
export type BillingStatus = "fresh" | "stale" | "unknown" | "error";
export type SelectionTier = "included" | "prepaid" | "payg" | "unknown";

export interface Credentials {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  issuer: string;
  clientId: string;
}

export interface NormalizedBilling {
  included: {
    usedPercent: number | null;
    remainingPercent: number | null;
    periodType: string | null;
    periodStart: string | null;
    resetsAt: string | null;
  };
  prepaid: { balanceUsd: number | null };
  payg: {
    enabled: boolean | null;
    usedUsd: number | null;
    capUsd: number | null;
    remainingUsd: number | null;
  };
  subscriptionTier: string | null;
}

export interface ObservationError {
  code: string;
  message: string;
}

export interface StoredObservation {
  lastGood: (NormalizedBilling & { observedAt: string }) | null;
  lastAttemptAt: string | null;
  failureCount: number;
  nextAttemptAtMs: number | null;
  error: ObservationError | null;
}

export interface StoredAccount {
  accountKey: string;
  displayName: string;
  ordinal: number;
  alias: string | null;
  email: string | null;
  userId: string;
  enabled: boolean;
  credentials: Credentials;
  observation: StoredObservation;
  createdAt: string;
  updatedAt: string;
}

export interface Reservation {
  id: string;
  accountKey: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface StoreState {
  version: 1;
  nextOrdinal: number;
  nextAvailableCursor: number | null;
  accounts: StoredAccount[];
  reservations: Reservation[];
}

export interface PublicAccount {
  accountKey: string;
  displayName: string;
  ordinal: number;
  alias: string | null;
  email: string | null;
  enabled: boolean;
  authStatus: AuthStatus;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountObservation extends PublicAccount {
  billingStatus: BillingStatus;
  included: NormalizedBilling["included"];
  prepaid: NormalizedBilling["prepaid"];
  payg: NormalizedBilling["payg"];
  subscriptionTier: string | null;
  observedAt: string | null;
  lastGoodAt: string | null;
  stale: boolean;
  error: ObservationError | null;
}

export class GrokError extends AccountError {
  constructor(code: string, message: string, readonly details?: unknown) {
    super(code, message);
  }
}
