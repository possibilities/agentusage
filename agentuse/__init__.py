"""agentuse-py — read-only Python reader for agentuse's profile catalog.

The agentuse daemon (`daemon.py`, run flat at the repo root via
``uv run python daemon.py``) owns the per-account state under
``~/.local/state/agentuse/`` — it scrapes Claude `/usage` and Codex `/status`
panels and writes one JSON envelope per account.  This package is a consumer:
it reads those envelopes plus the shared ``config.yaml`` catalog to answer
"which Claude profile should I route to right now?" — nothing more.  Keeping
the surface tiny lets the daemon absorb scraping churn behind two stable
functions.
"""

from agentuse.api import list_profiles, pick_profile

__all__ = [
    "list_profiles",
    "pick_profile",
]
