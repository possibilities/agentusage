import { createHash } from "node:crypto";
import { jsonBody, providerURL, type Env } from "../accounts/http.ts";
import { readPrivate, writePrivate } from "../accounts/storage.ts";
import type { StatePaths } from "../paths.ts";
import { credentialsNeedRefresh, providerSignal, XAI_COMPAT_VERSION } from "./oauth.ts";
import type { StoredAccount } from "./model.ts";

export const GROK_CATALOG_SCHEMA_VERSION = 1 as const;
export const GROK_CATALOG_FRESHNESS_MS = 5 * 60_000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const MODALITIES = new Set(["text", "image", "audio", "video"]);

export interface GrokCatalogModel {
  model: string;
  api_backend: string | null;
  efforts: string[];
  supports_reasoning_effort: boolean;
  input_modalities: string[];
  output_modalities: string[];
  context_window: number | null;
  max_output_tokens: number | null;
  capability_complete: boolean;
}

export interface GrokCatalogCapture {
  account_key: string;
  observed_at: string;
  credential_fingerprint: string;
  digest: string;
  models: GrokCatalogModel[];
}

interface GrokCatalogAccountState {
  account_key: string;
  last_good: GrokCatalogCapture | null;
  last_attempt_at: string;
  error_code: string | null;
}

export interface GrokCatalogState {
  schema_version: typeof GROK_CATALOG_SCHEMA_VERSION;
  accounts: GrokCatalogAccountState[];
}

export interface ReviewedGrokModel {
  model: "grok-4.6" | "grok-4.5";
  preference_rank: number;
  task_fit: string[];
  strengths: string[];
  weaknesses: string[];
  effort_guidance: Record<string, string>;
  source: string;
}

export const GROK_REVIEWED_VERSION = "xai-grok-agentic-catalog-2026-09-16" as const;
export const REVIEWED_GROK_MODELS: readonly ReviewedGrokModel[] = [
  {
    model: "grok-4.6",
    preference_rank: 1,
    task_fit: ["long_running_agentic_work", "codebase_work", "complex_implementation"],
    strengths: ["long_horizon_execution", "tool_use", "codebase_navigation"],
    weaknesses: ["higher_effort_can_increase_latency", "fit_for_narrow_mechanical_work_requires_judgment"],
    effort_guidance: {
      low: "bounded discovery or a narrow, well-specified change",
      medium: "ordinary implementation and debugging",
      high: "difficult multi-file reasoning or recovery",
      xhigh: "rare high-consequence architecture or deeply coupled debugging",
    },
    source: "https://x.ai/news/grok-4-6",
  },
  {
    model: "grok-4.5",
    preference_rank: 2,
    task_fit: ["general_agentic_work", "implementation", "review"],
    strengths: ["retained_compatible_fallback", "general_tool_use"],
    weaknesses: ["superseded_by_grok_4_6_for_long_running_agentic_and_codebase_work"],
    effort_guidance: {
      low: "bounded discovery or a narrow task",
      medium: "ordinary implementation",
      high: "difficult reasoning when Grok 4.6 is unavailable",
      xhigh: "use only when the task warrants the added depth and latency",
    },
    source: "https://x.ai/news/grok-4-6",
  },
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function boundedInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function stringSet(value: unknown, allowed: Set<string>): string[] {
  if (!Array.isArray(value) || value.length > 16) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && allowed.has(item)))].sort();
}

function parseEfforts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16) return [];
  return [...new Set(value.map(record).map((item) => item?.value).filter((item): item is string => typeof item === "string" && EFFORTS.has(item)))].sort();
}

/** Strict, allowlisted join of the two provider catalogs. Unknown fields and raw bodies never survive. */
export function normalizeGrokCatalog(modelsBody: unknown, modalitiesBody: unknown): GrokCatalogModel[] {
  const modelsRoot = record(modelsBody);
  const modalitiesRoot = record(modalitiesBody);
  if (!Array.isArray(modelsRoot?.data) || modelsRoot.data.length > 128 ||
      !Array.isArray(modalitiesRoot?.models) || modalitiesRoot.models.length > 128) {
    throw new Error("catalog_response_invalid");
  }
  const modelRows = new Map<string, Record<string, unknown>>();
  for (const raw of modelsRoot.data) {
    const item = record(raw);
    const id = item?.model;
    if (typeof id !== "string" || !MODEL_ID.test(id) || modelRows.has(id))
      throw new Error("catalog_response_invalid");
    modelRows.set(id, item!);
  }
  const modalityRows = new Map<string, Record<string, unknown>>();
  for (const raw of modalitiesRoot.models) {
    const item = record(raw);
    const id = item?.id;
    if (typeof id !== "string" || !MODEL_ID.test(id) || modalityRows.has(id))
      throw new Error("catalog_response_invalid");
    modalityRows.set(id, item!);
  }
  const ids = [...new Set([...modelRows.keys(), ...modalityRows.keys()])].sort();
  if (ids.length === 0 || ids.length > 256) throw new Error("catalog_response_invalid");
  return ids.map((model) => {
    const capability = modelRows.get(model);
    const modality = modalityRows.get(model);
    const efforts = parseEfforts(capability?.reasoning_efforts);
    const supportsReasoning = capability?.supports_reasoning_effort === true;
    return {
      model,
      api_backend: typeof capability?.api_backend === "string" && capability.api_backend.length <= 64
        ? capability.api_backend
        : null,
      efforts,
      supports_reasoning_effort: supportsReasoning,
      input_modalities: stringSet(modality?.input_modalities, MODALITIES),
      output_modalities: stringSet(modality?.output_modalities, MODALITIES),
      context_window: boundedInteger(capability?.context_window),
      max_output_tokens: boundedInteger(capability?.max_completion_tokens),
      capability_complete: capability !== undefined && modality !== undefined &&
        capability.api_backend === "responses" && supportsReasoning && efforts.length > 0 &&
        stringSet(modality.output_modalities, MODALITIES).includes("text"),
    };
  });
}

function headers(account: StoredAccount): Headers {
  return new Headers({
    authorization: `Bearer ${account.credentials.accessToken}`,
    "x-grok-user-id": account.userId,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    "x-grok-client-version": XAI_COMPAT_VERSION,
    "x-grok-client-identifier": "agentusage",
    accept: "application/json",
  });
}

export async function fetchGrokCatalog(
  account: StoredAccount,
  env: Env = process.env,
  deadlineMs?: number,
): Promise<GrokCatalogCapture> {
  if (credentialsNeedRefresh(account.credentials)) throw new Error("catalog_auth_unavailable");
  const signal = providerSignal(deadlineMs);
  const response = await fetch(providerURL("grok", "/v1/models", env), {
    headers: headers(account), redirect: "manual", signal,
  }).catch(() => null);
  if (response === null || response.status !== 200) {
    await response?.body?.cancel();
    throw new Error(response && [401, 403].includes(response.status) ? "catalog_auth_unavailable" : "catalog_unavailable");
  }
  const modalitiesUrl = env.AGENTUSAGE_TEST_GROK_ORIGIN
    ? providerURL("grok", "/v1/language-models", env)
    : "https://api.x.ai/v1/language-models";
  const modalities = await fetch(modalitiesUrl, {
    headers: { authorization: `Bearer ${account.credentials.accessToken}`, accept: "application/json" },
    redirect: "manual", signal,
  }).catch(() => null);
  if (modalities === null || modalities.status !== 200) {
    await modalities?.body?.cancel();
    throw new Error(modalities && [401, 403].includes(modalities.status) ? "catalog_auth_unavailable" : "catalog_unavailable");
  }
  let modelsBody: unknown;
  let modalitiesBody: unknown;
  try {
    modelsBody = await jsonBody(response);
    modalitiesBody = await jsonBody(modalities);
  } catch {
    throw new Error("catalog_response_invalid");
  }
  const models = normalizeGrokCatalog(modelsBody, modalitiesBody);
  const observedAt = new Date().toISOString();
  return {
    account_key: account.accountKey,
    observed_at: observedAt,
    credential_fingerprint: createHash("sha256").update(account.credentials.accessToken).digest("hex"),
    digest: digest(models),
    models,
  };
}

const emptyState = (): GrokCatalogState => ({ schema_version: GROK_CATALOG_SCHEMA_VERSION, accounts: [] });

function validateState(value: unknown): GrokCatalogState {
  const root = record(value);
  if (root?.schema_version !== GROK_CATALOG_SCHEMA_VERSION || !Array.isArray(root.accounts) || root.accounts.length > 100)
    throw new Error("catalog_state_invalid");
  for (const raw of root.accounts) {
    const item = record(raw);
    if (!item || typeof item.account_key !== "string" || !/^grok-[1-9]\d*$/u.test(item.account_key) ||
        typeof item.last_attempt_at !== "string" || !Number.isFinite(Date.parse(item.last_attempt_at)) ||
        !(item.error_code === null || typeof item.error_code === "string") ||
        !(item.last_good === null || validCapture(item.last_good, item.account_key))) throw new Error("catalog_state_invalid");
  }
  return value as GrokCatalogState;
}

function validCapture(value: unknown, accountKey: unknown): boolean {
  const capture = record(value);
  if (!capture || capture.account_key !== accountKey || typeof capture.observed_at !== "string" ||
      !Number.isFinite(Date.parse(capture.observed_at)) || typeof capture.credential_fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/u.test(capture.credential_fingerprint) || typeof capture.digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(capture.digest) || !Array.isArray(capture.models)) return false;
  try {
    return capture.digest === digest(capture.models) && capture.models.length <= 256 &&
      capture.models.every((model) => {
        const row = record(model);
        return row !== null && typeof row.model === "string" && MODEL_ID.test(row.model) &&
          Array.isArray(row.efforts) && Array.isArray(row.input_modalities) && Array.isArray(row.output_modalities) &&
          typeof row.supports_reasoning_effort === "boolean" && typeof row.capability_complete === "boolean";
      });
  } catch { return false; }
}

export function readGrokCatalogState(paths: StatePaths): GrokCatalogState {
  return readPrivate(paths.grokCatalog, validateState, emptyState);
}

export function recordGrokCatalogAttempt(
  paths: StatePaths,
  accountKey: string,
  capture: GrokCatalogCapture | null,
  errorCode: string | null,
): void {
  const state = readGrokCatalogState(paths);
  const previous = state.accounts.find((item) => item.account_key === accountKey);
  const row: GrokCatalogAccountState = {
    account_key: accountKey,
    last_good: capture ?? previous?.last_good ?? null,
    last_attempt_at: new Date().toISOString(),
    error_code: errorCode,
  };
  state.accounts = [...state.accounts.filter((item) => item.account_key !== accountKey), row]
    .sort((left, right) => left.account_key.localeCompare(right.account_key));
  writePrivate(paths.grokCatalog, state);
}

export function pruneGrokCatalogState(paths: StatePaths, accountKeys: Set<string>): void {
  const state = readGrokCatalogState(paths);
  const accounts = state.accounts.filter((item) => accountKeys.has(item.account_key));
  if (accounts.length !== state.accounts.length) writePrivate(paths.grokCatalog, { ...state, accounts });
}

export function errorCode(error: unknown): string {
  return error instanceof Error && ["catalog_auth_unavailable", "catalog_unavailable", "catalog_response_invalid"].includes(error.message)
    ? error.message
    : "catalog_unavailable";
}
