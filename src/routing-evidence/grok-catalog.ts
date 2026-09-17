import { createHash } from "node:crypto";
import { credentialFingerprint } from "../grok/billing.ts";
import {
  GROK_CATALOG_FRESHNESS_MS,
  GROK_REVIEWED_VERSION,
  REVIEWED_GROK_MODELS,
  readGrokCatalogState,
  type GrokCatalogModel,
} from "../grok/catalog.ts";
import { readState } from "../grok/store.ts";
import type { GrokAccountView } from "../grok/types.ts";
import type { StatePaths } from "../paths.ts";
import { withRoutingEvidenceSnapshot } from "./projection.ts";

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
};
const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");

function quotaEligible(account: GrokAccountView, observationMs: number, nowMs: number): boolean {
  const reset = account.included?.resetsAt ? Date.parse(account.included.resetsAt) : NaN;
  return account.enabled && account.authStatus === "valid" && account.billingStatus === "fresh" && !account.stale &&
    account.observedAtMs !== null && account.observedAtMs <= nowMs && nowMs - account.observedAtMs < GROK_CATALOG_FRESHNESS_MS &&
    observationMs <= nowMs && nowMs - observationMs < GROK_CATALOG_FRESHNESS_MS &&
    account.included?.remainingPercent !== null && account.included?.remainingPercent !== undefined &&
    account.included.remainingPercent > 0 && Number.isFinite(reset) && reset > nowMs;
}

export interface GrokCatalogRoutingEvidence {
  schema_version: 1;
  source_revision: string;
  generated_at: string;
  observed_at: string | null;
  expires_at: string | null;
  digest: string;
  status: "ok" | "drift" | "unavailable";
  reviewed: {
    version: typeof GROK_REVIEWED_VERSION;
    cross_provider_economics: "unavailable";
    within_grok_cost_equivalence: "unavailable";
    models: typeof REVIEWED_GROK_MODELS;
  };
  visibility: {
    /** True only when every owned account has a fresh, current successful capture. */
    complete: boolean;
    accounts: Array<{
      account_key: string;
      observed_at: string | null;
      expires_at: string | null;
      digest: string | null;
      fresh: boolean;
      credential_current: boolean;
      error_code: string | null;
      models: GrokCatalogModel[];
    }>;
  };
  advice: {
    models: Array<{
      model: string;
      disposition: "reviewed_routable" | "reviewed_unavailable" | "review_required" | "incompatible_capability";
      reviewed_version: typeof GROK_REVIEWED_VERSION | null;
    }>;
  };
  routable: {
    default_model: string | null;
    models: Array<{
      model: string;
      account_keys: string[];
      efforts: string[];
      input_modalities: string[];
      output_modalities: string[];
      task_fit: string[];
      strengths: string[];
      weaknesses: string[];
      effort_guidance: Record<string, string>;
      preference_rank: number;
    }>;
  };
  drift: Array<{ code: string; subject: string | null; account_key: string | null }>;
  notification: { severity: "warning"; code: "grok_catalog_drift"; subjects: string[] } | null;
}

export async function readGrokCatalogRoutingEvidence(
  paths: StatePaths,
  expectedSourceRevision?: string,
  nowMs = Date.now(),
): Promise<GrokCatalogRoutingEvidence> {
  return withRoutingEvidenceSnapshot(paths, async (evidence) => {
    if (expectedSourceRevision !== undefined && evidence.source_revision !== expectedSourceRevision)
      throw new Error("source_revision_conflict");
    const [catalog, state] = await Promise.all([readGrokCatalogState(paths), readState(paths)]);
    const credentials = new Map(state.accounts.map((account) => [
      account.accountKey,
      credentialFingerprint(account.credentials.accessToken),
    ]));
    const publicAccounts = new Map(evidence.usage.grok.accounts.map((account) => [account.accountKey, account]));
    const drift: GrokCatalogRoutingEvidence["drift"] = [];
    const visibility: GrokCatalogRoutingEvidence["visibility"]["accounts"] = [];
    for (const account of state.accounts.sort((left, right) => left.ordinal - right.ordinal)) {
      const stored = catalog.accounts.find((item) => item.account_key === account.accountKey);
      const capture = stored?.last_good ?? null;
      const observedMs = capture ? Date.parse(capture.observed_at) : NaN;
      const current = capture !== null && capture.credential_fingerprint === credentials.get(account.accountKey);
      const fresh = current && Number.isFinite(observedMs) && observedMs <= nowMs && nowMs - observedMs < GROK_CATALOG_FRESHNESS_MS;
      const expiresAt = Number.isFinite(observedMs) ? new Date(observedMs + GROK_CATALOG_FRESHNESS_MS).toISOString() : null;
      visibility.push({
        account_key: account.accountKey,
        observed_at: capture?.observed_at ?? null,
        expires_at: expiresAt,
        digest: capture?.digest ?? null,
        fresh,
        credential_current: current,
        error_code: stored?.error_code ?? (capture ? null : "catalog_unavailable"),
        models: capture ? structuredClone(capture.models) : [],
      });
      if (!capture) drift.push({ code: "catalog_unavailable", subject: null, account_key: account.accountKey });
      else if (!current) drift.push({ code: "catalog_credential_stale", subject: null, account_key: account.accountKey });
      else if (!fresh) drift.push({ code: "catalog_stale", subject: null, account_key: account.accountKey });
      if (stored?.error_code) drift.push({ code: stored.error_code, subject: null, account_key: account.accountKey });
      for (const model of capture?.models ?? []) {
        const reviewed = REVIEWED_GROK_MODELS.some((item) => item.model === model.model);
        if (model.capability_complete && !reviewed)
          drift.push({ code: "unreviewed_live_model", subject: model.model, account_key: account.accountKey });
        if (!model.capability_complete && reviewed)
          drift.push({ code: "reviewed_capability_mismatch", subject: model.model, account_key: account.accountKey });
      }
    }
    const routableModels: GrokCatalogRoutingEvidence["routable"]["models"] = [];
    for (const reviewed of REVIEWED_GROK_MODELS) {
      const compatible = visibility.filter((account) => {
        const quota = publicAccounts.get(account.account_key);
        const model = account.models.find((item) => item.model === reviewed.model);
        return account.fresh && quota !== undefined && quotaEligible(quota, evidence.usage.grok.observed_at_ms, nowMs) &&
          model?.capability_complete === true;
      });
      if (compatible.length === 0) continue;
      const models = compatible.map((account) => account.models.find((item) => item.model === reviewed.model)!);
      const common = (field: "efforts" | "input_modalities" | "output_modalities") =>
        models[0]![field].filter((item) => models.every((model) => model[field].includes(item))).sort();
      const efforts = common("efforts");
      if (efforts.length === 0 || !common("output_modalities").includes("text")) {
        drift.push({ code: "reviewed_capability_mismatch", subject: reviewed.model, account_key: null });
        continue;
      }
      routableModels.push({
        model: reviewed.model,
        account_keys: compatible.map((account) => account.account_key).sort(),
        efforts,
        input_modalities: common("input_modalities"),
        output_modalities: common("output_modalities"),
        task_fit: [...reviewed.task_fit],
        strengths: [...reviewed.strengths],
        weaknesses: [...reviewed.weaknesses],
        effort_guidance: Object.fromEntries(Object.entries(reviewed.effort_guidance).filter(([effort]) => efforts.includes(effort))),
        preference_rank: reviewed.preference_rank,
      });
    }
    routableModels.sort((left, right) => left.preference_rank - right.preference_rank);
    if (!routableModels.some((item) => item.model === "grok-4.6"))
      drift.push({ code: "preferred_reviewed_model_unavailable", subject: "grok-4.6", account_key: null });
    const uniqueDrift = [...new Map(drift.map((item) => [`${item.code}:${item.subject ?? ""}:${item.account_key ?? ""}`, item])).values()]
      .sort((left, right) => canonical(left).localeCompare(canonical(right)));
    const observed = visibility.map((item) => item.observed_at).filter((item): item is string => item !== null).sort().at(-1) ?? null;
    const expiries = visibility.map((item) => item.expires_at).filter((item): item is string => item !== null).sort();
    const complete = visibility.length === state.accounts.length &&
      visibility.every((item) => item.fresh && item.error_code === null);
    const allModels = [...new Set(visibility.flatMap((account) => account.models.map((model) => model.model)))].sort();
    const advice = { models: allModels.map((model) => {
      const reviewed = REVIEWED_GROK_MODELS.some((item) => item.model === model);
      const capabilities = visibility.flatMap((account) => account.models).filter((item) => item.model === model);
      const disposition = !capabilities.some((item) => item.capability_complete)
        ? "incompatible_capability" as const
        : !reviewed
          ? "review_required" as const
          : routableModels.some((item) => item.model === model)
            ? "reviewed_routable" as const
            : "reviewed_unavailable" as const;
      return { model, disposition, reviewed_version: reviewed ? GROK_REVIEWED_VERSION : null };
    }) };
    const body = {
      reviewed: {
        version: GROK_REVIEWED_VERSION,
        cross_provider_economics: "unavailable" as const,
        within_grok_cost_equivalence: "unavailable" as const,
        models: REVIEWED_GROK_MODELS,
      },
      visibility: { complete, accounts: visibility },
      advice,
      routable: { default_model: routableModels[0]?.model ?? null, models: routableModels },
      drift: uniqueDrift,
    };
    return {
      schema_version: 1,
      source_revision: evidence.source_revision,
      generated_at: evidence.generated_at,
      observed_at: observed,
      expires_at: expiries[0] ?? null,
      digest: digest(body),
      status: visibility.every((item) => item.models.length === 0) ? "unavailable" : uniqueDrift.length ? "drift" : "ok",
      ...body,
      notification: uniqueDrift.length
        ? { severity: "warning", code: "grok_catalog_drift", subjects: [...new Set(uniqueDrift.map((item) => item.subject ?? item.account_key ?? item.code))].sort() }
        : null,
    };
  }, nowMs);
}
