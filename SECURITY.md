# Security model — Minnala Issue Dashboard

This dashboard repo is **PUBLIC** (GitHub Pages serves from `docs/`).
The data repo it reads is **PRIVATE** (`ayanjava/0dte-v2`). Every
reasonable person who clones this repo can read every line of HTML,
CSS, and JS. So the rule is simple:

> **Nothing in this repo can be trusted with a secret.**

What that means in practice and how the dashboard still gets to
private data:

## 1. What lives in this repo (public)

| Surface | Contents | Sensitive? |
|---|---|---|
| `docs/index.html` | Markup, no scripts inline. | No |
| `docs/app.js` | All client logic. Reads `localStorage` for the user's PAT and calls `api.github.com`. No tokens baked in. | No |
| `docs/styles.css` | Theme tokens (OKLCH triples). | No |
| `docs/taxonomy.json` | Label → module mapping. Module/sub-module **names** are public; the underlying private code is not. | Borderline |
| `README.md`, `SECURITY.md` | This file. | No |

**Confirmed clean:** `git grep -nE 'AKIA|ghp_|ghs_|gho_|52\.200\.|api[_-]?key|password|token.*='` returns only the PAT-input placeholder text ("ghp_…") and references to the user's own browser storage. No real credentials.

## 2. How the dashboard reads the private repo

GitHub's API requires authentication for private repos. The dashboard
asks the **user** to paste a personal access token via the ⚙ Settings
panel; it is stored **only** in `localStorage` under the key
`minnala-dashboard:gh_pat` and never sent anywhere except
`api.github.com` over HTTPS.

```
Browser                      api.github.com
┌────────┐  Authorization:    ┌────────────┐
│  YOU   │  Bearer <PAT>      │ private    │
│  PAT   │ ───────────────►   │ 0dte-v2    │
│  (LS)  │ ◄───────────────   │ contents/  │
└────────┘   JSON body        └────────────┘
```

The dashboard never proxies. There is no server. Anonymous visitors
(no PAT) see 404 errors on every fetch and an empty UI — they cannot
read a single byte of the private repo through us.

## 3. What the PAT should be scoped to

Minimum scopes that make the dashboard work:

- **Fine-grained PAT** scoped to `ayanjava/0dte-v2`:
  - **Repository permissions**: `Contents: Read-only`, `Issues: Read-only`, `Metadata: Read-only`, `Pull requests: Read-only`
  - No write permissions. No org admin. No SSO.
- **Classic PAT** (legacy): `repo` (full) is too broad — only use if your repo doesn't support fine-grained PATs.

Never paste a PAT with write scopes into the dashboard. There is no
write-back code path — write scopes would only widen the blast radius
if your browser is compromised.

## 4. Where the dashboard COULD leak data — and doesn't

- The PAT never reaches GitHub Pages's logs (no server-side fetch).
- The PAT is never sent in a URL query string (always
  `Authorization: Bearer`).
- No 3rd-party JS is loaded (only `chart.js` from jsDelivr, pinned by
  exact version, no SRI yet — see "Improvements" below).
- The dashboard never POSTs/PUTs/DELETEs on the private repo unless
  the user clicks "Create issue", which uses the same PAT.
- `localStorage` is per-origin (`ayanjava.github.io`). Other GitHub
  Pages sites cannot read it.

## 5. What still requires care

- **Your laptop's browser profile**: anyone with file access can read
  `localStorage`. Rotate the PAT if you suspect compromise.
- **Browser extensions** can sometimes read `localStorage` of pages
  they have permissions for. Audit your extensions.
- **CDN supply chain**: jsDelivr ships `chart.js@4.4.4`. Adding SRI
  (`integrity="sha384-…"`) tightens this — open issue if you want it
  enforced.
- **Issue titles/bodies** can contain stack traces with file paths or
  log lines. Those become readable in the dashboard while your PAT is
  active. Treat the dashboard as a private view of the private repo —
  don't screenshot/share without scrubbing.

## 6. Reports live in the private repo too

`reports/*.json` files (test summary, sonar scan, coverage, etc.) are
committed to **`ayanjava/0dte-v2:main/reports/`**, NOT to this public
repo. The dashboard fetches them with the same authenticated Contents
API call:

```
GET https://api.github.com/repos/ayanjava/0dte-v2/contents/reports/progress.json?ref=main
Accept: application/vnd.github.raw
Authorization: Bearer <PAT>
```

Numbers visible on the Reports view (open/closed counts, coverage %,
failing-test names) are private to whoever has a PAT. Don't expose
the Reports view in a screencast/screenshot without considering what
the audience is allowed to see.

## 7. What to do if you suspect a PAT leaked

1. Open <https://github.com/settings/tokens> (or
   `/settings/personal-access-tokens`).
2. Revoke the token immediately. (GitHub also auto-revokes tokens
   that show up in commits — they scan for this.)
3. Look at the **audit log** for the repo to see what was accessed.
4. Generate a fresh PAT, paste into the dashboard.

## 8. Reporting a security issue

Open a private issue on `ayanjava/0dte-v2` with the
`security,audit,p0` labels, or DM the maintainer directly. Do **not**
open a public issue on this repo — issues here are also public.
