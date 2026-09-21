# 0018: Refresh Codex workspace names from accounts/check

Status: Accepted 2026-09-21 at the operator's request.

## Context

The two managed Codex accounts displayed frozen import labels
(`ArtHack (role:owner) [id:…]`, `Personal (role:owner) [id:…]`) copied from the
old multi-auth snapshot. Those strings never changed after a ChatGPT workspace
rename. Usage (`/backend-api/wham/usage`) reports email and plan type but no
workspace name. Native Codex already reads names from `accounts/check`.

## Decision

During a successful Codex usage refresh, GET `/backend-api/wham/accounts/check`
with the existing 404 fallback to `/api/codex/accounts/check`. Persist
`workspace_name` on the managed account and copy it onto the observation as
`workspaceName`. The TUI identity prefers that name over a frozen label.

Replace the stored label only when it is still tracking the provider name:
unset, equal to the previous workspace name, or the imported
`Name (role:…) [id:…]` form. Operator aliases stay selectors. A missing or
failed name fetch does not affect usage, eligibility, or last-good meters.
Explicit observation refresh (`freshWithinMs: 0`, including TUI `r`) forces
usage so a rename can appear immediately.

## Consequences

One extra bounded GET per Codex usage poll. Selectors that still used the old
derived label strings stop matching after the first successful name refresh.
The stable keys `codex-N`, account IDs, emails, and operator aliases remain.
