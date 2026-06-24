"""agentusage — stateless one-shot usage scrape util.

The package exposes a single entry point, ``scrape_cli``, invoked once per
account by the keeper usage-scraper-worker:

    uv run --project ~/code/agentusage python -m agentusage.scrape_cli \\
        --target claude --profile default

It does exactly one scrape, prints one discriminated JSON object on stdout,
writes NO state. Orchestration (scheduling, envelope assembly, tier/multiplier
resolution, idle/cooldown gating) lives in the keeper worker — not here.
"""
