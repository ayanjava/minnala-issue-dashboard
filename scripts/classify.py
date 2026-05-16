"""Classify raw issues into modules + submodules per ``taxonomy.json``.

Reads:
  docs/data/issues.raw.json     (output of fetch_issues.py)
  taxonomy.json                 (module rule definitions)

Writes:
  docs/data/issues.json         (slim per-issue records + classification)
  docs/data/stats.json          (pre-computed counts + trend + oldest)

Pure stdlib — no pip install needed.
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
RAW_PATH = ROOT / "docs" / "data" / "issues.raw.json"
OUT_ISSUES = ROOT / "docs" / "data" / "issues.json"
OUT_STATS = ROOT / "docs" / "data" / "stats.json"
TAXONOMY_PATH = ROOT / "taxonomy.json"


# ── Rule matchers ───────────────────────────────────────────────────


def _rule_matches(rule: dict, issue: dict, labels: set[str]) -> bool:
    """Recursively evaluate one rule against an issue."""
    if rule.get("always"):
        return True
    if "label" in rule:
        return rule["label"].lower() in labels
    if "label_any" in rule:
        return any(lbl.lower() in labels for lbl in rule["label_any"])
    if "title_contains" in rule:
        title = issue.get("title", "") or ""
        return any(needle in title for needle in rule["title_contains"])
    if "all" in rule:
        return all(_rule_matches(sub, issue, labels) for sub in rule["all"])
    if "any" in rule:
        return any(_rule_matches(sub, issue, labels) for sub in rule["any"])
    return False


def _classify_one(issue: dict, taxonomy: dict) -> tuple[str, str]:
    """Return (module_id, submodule_id)."""
    labels = {lbl["name"].lower() for lbl in issue.get("labels", [])}
    for module in taxonomy["modules"]:
        for sub in module.get("submodules", []):
            for rule in sub.get("rules", []):
                if _rule_matches(rule, issue, labels):
                    return module["id"], sub["id"]
    return "uncategorized", "uncategorized"


def _resolve_priority(labels: set[str], priority_labels: list[str]) -> str | None:
    for p in priority_labels:
        if p in labels:
            return p
    return None


def _age_days(iso_ts: str) -> int:
    """Whole days since iso_ts (UTC)."""
    try:
        ts = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
        return max(0, (datetime.now(timezone.utc) - ts).days)
    except (ValueError, AttributeError):
        return -1


# ── Slim issue record ──────────────────────────────────────────────


def _slim(issue: dict, taxonomy: dict) -> dict:
    labels_lower = {lbl["name"].lower() for lbl in issue.get("labels", [])}
    module_id, sub_id = _classify_one(issue, taxonomy)
    priority = _resolve_priority(labels_lower, taxonomy["priority_labels"])
    return {
        "number": issue["number"],
        "title": issue["title"],
        "state": issue["state"],
        "labels": [lbl["name"] for lbl in issue.get("labels", [])],
        "priority": priority,
        "module": module_id,
        "submodule": sub_id,
        "url": issue["html_url"],
        "created_at": issue["created_at"],
        "updated_at": issue["updated_at"],
        "closed_at": issue.get("closed_at"),
        "age_days": _age_days(issue["created_at"]),
        "comments": issue.get("comments", 0),
    }


# ── Stats ──────────────────────────────────────────────────────────


def _build_trend(issues: list[dict], days: int = 90) -> list[dict]:
    """Daily open-count time series for the last ``days`` days.

    Method: for each day in the window, count issues where
    ``created_at <= day_end AND (closed_at is None OR closed_at > day_end)``.
    Linear in (issues × days) — fine for <2000 issues.
    """
    today = datetime.now(timezone.utc).date()
    series: list[dict] = []
    # Parse once.
    parsed = []
    for i in issues:
        try:
            c = datetime.fromisoformat(i["created_at"].replace("Z", "+00:00"))
        except Exception:
            continue
        closed = None
        if i.get("closed_at"):
            try:
                closed = datetime.fromisoformat(i["closed_at"].replace("Z", "+00:00"))
            except Exception:
                pass
        parsed.append((c, closed))

    for d in range(days, -1, -1):
        day = today - timedelta(days=d)
        day_end = datetime.combine(day, datetime.max.time(), tzinfo=timezone.utc)
        open_count = 0
        opened_today = 0
        closed_today = 0
        for c, closed in parsed:
            if c.date() == day:
                opened_today += 1
            if closed and closed.date() == day:
                closed_today += 1
            if c <= day_end and (closed is None or closed > day_end):
                open_count += 1
        series.append({
            "date": day.isoformat(),
            "open": open_count,
            "opened": opened_today,
            "closed": closed_today,
        })
    return series


def _build_stats(issues: list[dict], taxonomy: dict) -> dict:
    open_issues = [i for i in issues if i["state"] == "open"]
    by_priority = defaultdict(int)
    by_module = defaultdict(int)
    by_module_priority: dict[str, dict[str, int]] = defaultdict(
        lambda: {"p0": 0, "p1": 0, "p2": 0, "none": 0},
    )
    by_submodule: dict[str, dict[str, int]] = defaultdict(
        lambda: {"open": 0, "closed": 0},
    )

    for i in open_issues:
        p = i["priority"] or "none"
        by_priority[p] += 1
        by_module[i["module"]] += 1
        by_module_priority[i["module"]][p] += 1
        by_submodule[f"{i['module']}:{i['submodule']}"]["open"] += 1

    for i in issues:
        if i["state"] == "closed":
            by_submodule[f"{i['module']}:{i['submodule']}"]["closed"] += 1

    week_ago = datetime.now(timezone.utc) - timedelta(days=7)

    def _within_week(iso: str | None) -> bool:
        if not iso:
            return False
        try:
            return datetime.fromisoformat(iso.replace("Z", "+00:00")) >= week_ago
        except Exception:
            return False

    opened_7d = sum(1 for i in issues if _within_week(i["created_at"]))
    closed_7d = sum(1 for i in issues if _within_week(i["closed_at"]))

    # Oldest open — top 15.
    oldest = sorted(open_issues, key=lambda x: x["age_days"], reverse=True)[:15]

    # Stale buckets (open issues only).
    age_buckets = {"<7d": 0, "7-30d": 0, "30-90d": 0, ">90d": 0}
    for i in open_issues:
        a = i["age_days"]
        if a < 7:
            age_buckets["<7d"] += 1
        elif a < 30:
            age_buckets["7-30d"] += 1
        elif a < 90:
            age_buckets["30-90d"] += 1
        else:
            age_buckets[">90d"] += 1

    # Module tree with counts attached.
    module_tree = []
    for m in taxonomy["modules"]:
        sub_list = []
        for s in m.get("submodules", []):
            key = f"{m['id']}:{s['id']}"
            sub_list.append({
                "id": s["id"],
                "label": s["label"],
                "open": by_submodule[key]["open"],
                "closed": by_submodule[key]["closed"],
            })
        module_tree.append({
            "id": m["id"],
            "label": m["label"],
            "icon": m.get("icon", ""),
            "color": m.get("color", "#9ca3af"),
            "open": by_module[m["id"]],
            "submodules": sub_list,
        })

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "repo": "ayanjava/0dte-v2",
        "totals": {
            "total": len(issues),
            "open": len(open_issues),
            "closed": len(issues) - len(open_issues),
            "opened_7d": opened_7d,
            "closed_7d": closed_7d,
        },
        "by_priority": dict(by_priority),
        "by_module": dict(by_module),
        "by_module_priority": {k: dict(v) for k, v in by_module_priority.items()},
        "age_buckets": age_buckets,
        "oldest_open": oldest,
        "trend_90d": _build_trend(issues, days=90),
        "modules": module_tree,
    }


# ── Entry point ────────────────────────────────────────────────────


def main() -> int:
    if not RAW_PATH.exists():
        print(f"ERROR: {RAW_PATH} missing — run fetch_issues.py first.", file=sys.stderr)
        return 1
    raw = json.loads(RAW_PATH.read_text(encoding="utf-8"))
    taxonomy = json.loads(TAXONOMY_PATH.read_text(encoding="utf-8"))

    slim = [_slim(i, taxonomy) for i in raw]
    OUT_ISSUES.write_text(json.dumps(slim, indent=0), encoding="utf-8")

    stats = _build_stats(slim, taxonomy)
    OUT_STATS.write_text(json.dumps(stats, indent=2), encoding="utf-8")

    print(
        f"OK: classified {len(slim)} issues → {OUT_ISSUES}, stats → {OUT_STATS}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
