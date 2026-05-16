"""Fetch all issues from ayanjava/0dte-v2 via the GitHub API.

Output: ``docs/data/issues.raw.json`` — full raw API responses.

Auth resolution (first match wins):
  1. ``ISSUES_TOKEN`` env var       (workflow / cross-repo PAT)
  2. ``GITHUB_TOKEN`` env var       (workflow default)
  3. ``gh auth token`` shell output (local dev)
  4. unauthenticated                (60 req/hour limit, may fail)

Pure stdlib — no pip install needed.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = os.environ.get("ISSUES_REPO", "ayanjava/0dte-v2")
PER_PAGE = 100
OUT_PATH = Path(__file__).resolve().parent.parent / "docs" / "data" / "issues.raw.json"


def _resolve_token() -> str | None:
    for env_name in ("ISSUES_TOKEN", "GITHUB_TOKEN"):
        tok = os.environ.get(env_name)
        if tok:
            return tok
    try:
        result = subprocess.run(
            ["gh", "auth", "token"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            tok = result.stdout.strip()
            if tok:
                return tok
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return None


def _request(url: str, token: str | None) -> tuple[list[dict], dict[str, str]]:
    """Return (json_payload, response_headers). Raises on HTTP error."""
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "minnala-issue-dashboard/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read()
            headers = dict(resp.headers)
            return json.loads(body), headers
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", errors="replace")
        print(f"HTTP {e.code} fetching {url}: {msg[:400]}", file=sys.stderr)
        raise


def fetch_all(repo: str, state: str = "all") -> list[dict]:
    """Fetch every issue (open + closed). Paginates fully.

    Filters out pull-requests — GH's /issues endpoint returns both.
    """
    token = _resolve_token()
    if not token:
        print(
            "WARN: no GitHub token found (ISSUES_TOKEN / GITHUB_TOKEN / "
            "gh auth token). Running unauthenticated — 60 req/hour limit.",
            file=sys.stderr,
        )

    all_issues: list[dict] = []
    page = 1
    while True:
        url = (
            f"https://api.github.com/repos/{repo}/issues"
            f"?state={state}&per_page={PER_PAGE}&page={page}&sort=updated&direction=desc"
        )
        print(f"GET {url}", file=sys.stderr)
        payload, headers = _request(url, token)
        if not payload:
            break
        # Drop PRs — issues endpoint returns both.
        issues_only = [item for item in payload if "pull_request" not in item]
        all_issues.extend(issues_only)
        # Rate-limit visibility.
        remaining = headers.get("X-RateLimit-Remaining", "?")
        reset = headers.get("X-RateLimit-Reset", "?")
        print(
            f"  page={page}: got {len(payload)} ({len(issues_only)} non-PR). "
            f"ratelimit remaining={remaining} reset={reset}",
            file=sys.stderr,
        )
        if len(payload) < PER_PAGE:
            break
        page += 1
        # Be polite even when authenticated.
        time.sleep(0.2)
    return all_issues


def main() -> int:
    issues = fetch_all(REPO, state="all")
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(issues, indent=0), encoding="utf-8")
    open_n = sum(1 for i in issues if i["state"] == "open")
    closed_n = len(issues) - open_n
    print(
        f"OK: fetched {len(issues)} issues "
        f"({open_n} open, {closed_n} closed) → {OUT_PATH}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
