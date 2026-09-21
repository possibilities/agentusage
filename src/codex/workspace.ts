import { nonempty, record } from "../accounts/storage.ts";

export const WORKSPACE_NAME_MAX = 256;

const DERIVED_LABEL = /\s\(role:[^)]+\)\s\[id:[^\]]+\]$/u;

function textName(value: unknown): string | null {
  if (!nonempty(value) || value.length > WORKSPACE_NAME_MAX) return null;
  const name = value.trim();
  return name.length > 0 && name.length <= WORKSPACE_NAME_MAX ? name : null;
}

function textId(value: unknown): string | null {
  return nonempty(value) ? value : null;
}

function accountEntry(value: unknown): { id: string; name: string | null } | null {
  const entry = record(value);
  if (!entry) return null;
  const nested = record(entry.account);
  const id =
    textId(entry.id) ??
    textId(entry.account_id) ??
    textId(nested?.account_id) ??
    textId(nested?.id);
  if (id === null) return null;
  return {
    id,
    name: textName(entry.name) ?? textName(nested?.name),
  };
}

/** Current ChatGPT/Codex workspace name for this managed account id. */
export function parseCodexWorkspaceName(
  value: unknown,
  accountId: string,
): string | null {
  const accounts = record(value)?.accounts;
  const entries: Array<{ id: string; name: string | null }> = [];
  if (Array.isArray(accounts)) {
    for (const item of accounts) {
      const entry = accountEntry(item);
      if (entry) entries.push(entry);
    }
  } else {
    const map = record(accounts);
    if (map) {
      for (const item of Object.values(map)) {
        const entry = accountEntry(item);
        if (entry) entries.push(entry);
      }
    }
  }
  return entries.find((entry) => entry.id === accountId)?.name ?? null;
}

/**
 * True when the stored label is still tracking the provider workspace name:
 * unset, equal to the last observed name, or the imported multi-auth snapshot
 * form `Name (role:…) [id:…]`.
 */
export function isTrackedCodexLabel(
  label: string | null,
  previousWorkspaceName: string | null,
): boolean {
  if (label === null) return true;
  if (previousWorkspaceName !== null && label === previousWorkspaceName) return true;
  return DERIVED_LABEL.test(label);
}

export function workspaceNameConflicts(
  accounts: readonly {
    key: string;
    account_id: string;
    ordinal: number;
    email: string | null;
    label: string | null;
  }[],
  accountKey: string,
  name: string,
): boolean {
  return accounts.some(
    (other) =>
      other.key !== accountKey &&
      (other.key === name ||
        other.account_id === name ||
        String(other.ordinal) === name ||
        other.email === name ||
        other.label === name),
  );
}
