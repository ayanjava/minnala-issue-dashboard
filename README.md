# Minnala Issue Dashboard

Single-page issue dashboard for [ayanjava/0dte-v2](https://github.com/ayanjava/0dte-v2)
that auto-refreshes from the GitHub API every 30 minutes. Hosted on GitHub
Pages (free), runs entirely in the browser, no backend.

> **Live:** `https://ayanjava.github.io/minnala-issue-dashboard/`
> (URL becomes active after the first Pages deploy — see Setup below.)

## What it shows

**Sidebar (left)** — modules + submodules with live open-issue counts,
derived from labels + title heuristics (`taxonomy.json`). Click any
module/submodule to filter the whole dashboard.

- 🎨 Frontend (UI) — V2 Pages · A11y · Design System · General UI
- ⚙️ Backend Core — Auth · Storage/Schema · Hot Path · Signal Engine · Multi-tenant
- 📡 Brokers & Streaming — Tiger · IBKR · Moomoo · Streaming Infra · Other
- 🧪 Testing & QA — Pytest · Vitest · Playwright/E2E · Coverage · Mutation · Other
- 🧹 Tech Debt — mypy · ruff · Cognitive complexity · Other
- 🚀 Infra & Deploy — AWS · Deploy/CI · GPU/Training · Other
- 🔒 Security · 📚 Documentation · ❓ Uncategorized

**Top bar filters** — Priority (P0/P1/P2/∅) · Status (open/closed/all) ·
Age (<7d / 7-30d / 30-90d / >90d) · Free-text search · Reset.

**Main panel:**
- 6 KPI tiles — Total open, P0, P1, P2, opened-7d, closed-7d.
- Donut — issues by module (open).
- Stacked bar — priority breakdown per module.
- Line — 90-day open-count trend.
- Bar — age distribution.
- Top-10 oldest open issues (click → opens in GH).
- Sortable + paginated table (#, title, module, priority, age, comments, state).
  Click any row → opens the issue on github.com in a new tab.

## Architecture

```
.github/workflows/refresh.yml   # cron every 30 min + manual trigger
scripts/
  fetch_issues.py               # pulls ayanjava/0dte-v2 issues via GH API
  classify.py                   # buckets by taxonomy.json + computes stats
taxonomy.json                   # label/title → module mapping (edit this)
docs/                           # GitHub Pages root (static, no build)
  index.html  app.js  styles.css
  data/issues.json              # refreshed by workflow
  data/stats.json               # pre-computed counts + trend
```

Everything in `docs/` is plain HTML + CSS + vanilla JS. No build step.
Chart.js is loaded from jsDelivr CDN at runtime (single script tag).

## Setup (one-time, ~5 minutes)

### 1. Push this repo to GitHub

```pwsh
cd C:\Users\ayanb\Downloads\0D\minnala-issue-dashboard
git add .
git commit -m "feat: initial issue dashboard"
gh repo create minnala-issue-dashboard --public --source=. --remote=origin --push
```

### 2. Create a fine-grained PAT for cross-repo issue read

The workflow needs to read issues from `ayanjava/0dte-v2` (a different repo
than this one), and the default `GITHUB_TOKEN` doesn't cross repo boundaries.
Make a fine-grained PAT:

1. https://github.com/settings/personal-access-tokens/new
2. **Resource owner:** `ayanjava`
3. **Repository access:** Only select repositories → `ayanjava/0dte-v2`
4. **Repository permissions:**
   - Contents: Read-only
   - Issues: Read-only
   - Metadata: Read-only (auto)
5. Expiration: 1 year is fine.
6. Generate token → copy.

Add as repo secret:

```pwsh
gh secret set ISSUES_TOKEN --repo ayanjava/minnala-issue-dashboard
# Paste the PAT when prompted.
```

### 3. Enable GitHub Pages

```pwsh
gh api repos/ayanjava/minnala-issue-dashboard/pages `
  -X POST -f source[branch]=main -f source[path]=/docs
```

(Or via UI: Settings → Pages → Source = "Deploy from a branch" → branch
`main`, folder `/docs`.)

### 4. Trigger first refresh

```pwsh
gh workflow run refresh.yml --repo ayanjava/minnala-issue-dashboard
```

Watch it run:

```pwsh
gh run watch --repo ayanjava/minnala-issue-dashboard
```

After the run completes, the dashboard lives at
`https://ayanjava.github.io/minnala-issue-dashboard/`.

## Running locally

```pwsh
cd C:\Users\ayanb\Downloads\0D\minnala-issue-dashboard
python scripts/fetch_issues.py    # uses `gh auth token` automatically
python scripts/classify.py
python -m http.server 8765 --directory docs
# open http://localhost:8765
```

## Editing the taxonomy

Open `taxonomy.json`. Each module has a list of submodules; each submodule
has a list of `rules` (first match wins). Rule formats:

```json
{"label": "ui"}                                     // exact label match
{"label_any": ["ui", "v1-cutover"]}                 // any of these labels
{"title_contains": ["Tiger", "tiger"]}              // substring in title
{"all":  [{"label": "ui"}, {"label": "v1-cutover"}]}  // AND
{"any":  [...]}                                     // OR (explicit)
{"always": true}                                    // catch-all (use last)
```

Modules are iterated in order — put the most specific bucket first.
Anything that matches no rule falls into the `uncategorized` module.

After editing, re-run the workflow (or the local commands) — the dashboard
picks up the new bucketing on next refresh.

## Refresh cadence

Cron is `*/30 * * * *` (every 30 minutes). To change, edit
`.github/workflows/refresh.yml`. Lower frequency = stale data;
higher = wasted GH Actions minutes (you have 2000/month free on private
repos, unlimited on public).
