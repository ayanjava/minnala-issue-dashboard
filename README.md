# Minnala Issue Dashboard

Live, single-page dashboard for [ayanjava/0dte-v2](https://github.com/ayanjava/0dte-v2)
issues **and pull requests**. Pure client-side — fetches directly from the
GitHub REST API on every page load. No cached snapshots, no backend, no
build step.

> **Live URL:** `https://ayanjava.github.io/minnala-issue-dashboard/`
> (after the one-time Pages setup below).

## What it shows

**Sidebar** — module/submodule tree with live open-record counts, driven
by `docs/taxonomy.json` (label + title-keyword rules):

- 🎨 Frontend (UI) — V2 Pages · A11y · Design System · General UI
- ⚙️ Backend Core — Auth · Storage/Schema · Hot Path · Signal Engine · Multi-tenant
- 📡 Brokers & Streaming — Tiger · IBKR · Moomoo · Streaming Infra
- 🧪 Testing & QA — Pytest · Vitest · Playwright/E2E · Coverage · Mutation
- 🧹 Tech Debt — mypy · ruff · Cognitive complexity
- 🚀 Infra & Deploy — AWS · Deploy/CI · GPU/Training
- 🔒 Security · 📚 Documentation · ❓ Uncategorized

**Filter bar** (all combinable, apply across charts + table):
- **Type** — All / Issue / PR
- **Priority** — All / P0 / P1 / P2 / ∅
- **Status** — Open / Merged / Closed / All
- **Age** — All / <7d / 7-30d / 30-90d / >90d
- Free-text search (title, #number, author)

**KPI tiles** — Open Issues · Open PRs · P0 · P1 · P2 · Opened 7d · Closed 7d · Merged 7d

**Charts** (Chart.js v4):
- Donut: issues by module (open)
- Stacked horizontal bar: priority breakdown per module
- Line: 90-day open-count trend
- Bar: age distribution

**Table** — sortable + paginated, columns: `# · Type · Title · Module ·
Pri · Author · Age · 💬 · State`. Click any row → opens the issue/PR
on github.com in a new tab. Merged PRs show purple state pill;
open issues green; closed/merged dim.

## Why this needs a PAT

`ayanjava/0dte-v2` is a **private repository**. The GitHub REST API
returns `HTTP 404 Not Found` to anonymous browser requests against
private repos (it's how GH hides their existence). The dashboard needs
a fine-grained personal access token to read the issue + PR list.

Token is stored in `localStorage` only — never sent anywhere except
GitHub's API. Click **⚙ Settings** in the topbar to paste it once.

### Creating the token

1. Open <https://github.com/settings/personal-access-tokens/new>
2. **Resource owner**: `ayanjava`
3. **Repository access**: Only select repositories → `ayanjava/0dte-v2`
4. **Permissions**:
   - Contents — Read
   - Issues — Read
   - Metadata — Read (auto)
   - Pull requests — Read
5. Generate, copy the `github_pat_…` string.
6. Open the dashboard → ⚙ Settings → paste → Save.

Anonymous (60 req/hr) → authenticated (5,000 req/hr). Fetching the full
~1,000-record snapshot uses ~11 paginated calls per page load, so a
token easily covers all-day use.

## Architecture

```
.github/workflows/refresh.yml   # static-only Pages deploy on push to main
docs/                           # GitHub Pages root
  index.html
  app.js                        # vanilla JS: GH API client + classifier + charts
  styles.css                    # mirrors frontend/src/design-system/theme.css tokens
  taxonomy.json                 # module rule mapping (edit this)
README.md
.gitignore
```

No Python, no Node, no build step. Chart.js loaded from jsDelivr CDN at runtime.

## Setup (one-time, ~3 minutes)

### 1. Push this repo to GitHub

```pwsh
cd C:\Users\ayanb\Downloads\0D\minnala-issue-dashboard
gh repo create minnala-issue-dashboard --public --source=. --remote=origin --push
```

(Public repo is fine — the dashboard contains no secrets. Your PAT
stays in your browser. If you'd rather make the dashboard repo
private too, use `--private` and Pages will still work on the same
URL once enabled.)

### 2. Enable GitHub Pages

```pwsh
gh api repos/ayanjava/minnala-issue-dashboard/pages `
  -X POST -f source[branch]=main -f source[path]=/docs
```

Or via UI: Settings → Pages → Source = "Deploy from a branch" → branch
`main`, folder `/docs`.

### 3. Open the live URL

```
https://ayanjava.github.io/minnala-issue-dashboard/
```

(1–2 minutes after step 2 for Pages to propagate.)

### 4. Paste a PAT in the Settings panel (see "Why this needs a PAT")

After save, the dashboard immediately re-fetches. From then on it
loads live data on every visit + every click of the ↻ button.

## Running locally

```pwsh
cd C:\Users\ayanb\Downloads\0D\minnala-issue-dashboard
python -m http.server 8765 --directory docs
# open http://localhost:8765
# click ⚙ Settings, paste a PAT
```

## Editing the taxonomy

Open `docs/taxonomy.json`. Each module has `submodules`; each submodule
has a list of `rules` (first match wins). Rule formats:

```json
{"label": "ui"}                        // exact label match (case-insensitive)
{"label_any": ["ui", "v1-cutover"]}    // any of these labels
{"title_contains": ["Tiger", "tiger"]} // substring in title
{"all":  [{"label":"ui"},{"label":"v1-cutover"}]}   // AND
{"any":  [...]}                        // OR (explicit)
{"always": true}                       // catch-all (use last)
```

After editing, just refresh the browser — the SPA re-fetches and
re-classifies on every load.

## Design system

Styles in `docs/styles.css` mirror the tokens in
[frontend/src/design-system/theme.css](https://github.com/ayanjava/0dte-v2/blob/main/frontend/src/design-system/theme.css)
(`.theme-v2` + `.theme-cockpit` blocks). If those change, mirror them
here. Inter font + JetBrains Mono on numerics. Chart palette uses the
same OKLCH tones so the dashboard reads as part of the Minnala
product.
