"""Read each arthack-claude profile's .claude.json and dump a plan-tier
summary to a stable JSON file in /tmp.

Output: /tmp/tuiuse-plans.json
"""
import json
from pathlib import Path

PROFILES_DIR = Path.home() / ".claude-profiles"
OUTPUT = Path("/tmp/tuiuse-plans.json")

# Map the raw organizationRateLimitTier string to a friendly label.
TIER_LABELS = {
    "default_claude_ai": "Pro",
    "default_claude_max_5x": "Max 5x",
    "default_claude_max_20x": "Max 20x",
}


def summarize(profile_dir: Path) -> dict:
    claude_json = profile_dir / ".claude.json"
    if not claude_json.exists():
        return {"error": f"missing {claude_json}"}

    data = json.loads(claude_json.read_text())
    oa = data.get("oauthAccount") or {}
    tier = oa.get("organizationRateLimitTier")

    if tier is None:
        plan = None
    else:
        plan = TIER_LABELS.get(tier, f"Unknown ({tier})")

    return {
        "display_name": oa.get("displayName"),
        "organization_type": oa.get("organizationType"),
        "rate_limit_tier": tier,
        "plan": plan,
    }


def main():
    if not PROFILES_DIR.is_dir():
        raise SystemExit(f"not found: {PROFILES_DIR}")

    summary = {
        p.name: summarize(p)
        for p in sorted(PROFILES_DIR.iterdir())
        if p.is_dir()
    }

    OUTPUT.write_text(json.dumps(summary, indent=2) + "\n")
    print(OUTPUT)


if __name__ == "__main__":
    main()
