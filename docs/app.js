/* Minnala Issue Dashboard — vanilla JS SPA.
 *
 * Live data source: GitHub API at runtime. No cached JSON files —
 * every page load paginates through https://api.github.com/repos/
 * ayanjava/0dte-v2/issues?state=all (which returns both issues AND
 * PRs — we tell them apart by the .pull_request field).
 *
 * Auth:
 *   - Anonymous: 60 req/hour per IP. Paginating ~1,000 records uses
 *     ~11 calls, so ~5 page loads per hour before the wall.
 *   - With a PAT stored in localStorage: 5,000 req/hour. The user
 *     pastes one via the ⚙ Settings panel; it never leaves the browser.
 *
 * Classification is also done client-side using taxonomy.json — same
 * rule shape as scripts/classify.py so they stay in sync.
 */
'use strict';

const REPO = 'ayanjava/0dte-v2';

const STATE = {
  taxonomy: null,
  modules:  [],
  issues:   [],          // slim records, includes PRs
  stats:    null,
  rateLimit: { limit: null, remaining: null, reset: null, used: null },
  currentUser: null,     // /user login (for 'Assigned to me')
  milestones: null,      // lazy-loaded
  events:     null,      // lazy-loaded
  commits:    null,      // lazy-loaded
  reports:    null,      // lazy-loaded (Reports view)
  assignees:  null,      // lazy-loaded (collaborators)
  drawer:     { number: null, comments: null },
};

const FILTERS = {
  module:    null,
  submodule: null,
  label:     null,
  type:      'all',
  kindType:  null,       // bug | task | feat | chore | docs (set by clicking a Type tile)
  priority:  'all',
  status:    'open',
  age:       'all',
  search:    '',
  assignedToMe: false,
  assigneeAny:  false,    // detail tile: 🤝 Assigned (any assignee)
  assigneeNone: false,    // detail tile: 🆓 Unassigned
  wipOnly:      false,    // detail tile: ⏳ In progress (stage != 'todo')
  surface:   'all',
  // 5-proof filter: null=off, 'proved'=fully proved, 'partial'=some
  // proofs supplied but not all, 'needs'=at least one dim missing.
  proof:     null,
};

// Hash router: #/dashboard #/board #/sprints #/new #/activity #/commits
const ROUTE = { current: 'dashboard' };

const LABEL_META = new Map();   // labelName -> { color, count, used_pr, used_issue }

const SORT  = { col: 'updated_at', dir: 'desc' };
const PAGE  = { idx: 0, size: 25 };
const CHARTS = {};

// OKLCH palette mirroring frontend/src/design-system/theme.css tokens.
const CHART_PALETTE = [
  'oklch(0.78 0.20 145)',   // accent (green)
  'oklch(0.72 0.14 240)',   // blue
  'oklch(0.78 0.18 70)',    // alert (amber)
  'oklch(0.72 0.14 300)',   // purple
  'oklch(0.78 0.12 200)',   // cyan
  'oklch(0.68 0.20 22)',    // loss (red)
  'oklch(0.82 0.16 80)',    // brand (gold)
  'oklch(0.62 0.04 220)',   // text-dim (slate)
];
const COLOR = {
  accent: 'oklch(0.78 0.20 145)',
  alert:  'oklch(0.78 0.18 70)',
  loss:   'oklch(0.68 0.20 22)',
  blue:   'oklch(0.72 0.14 240)',
  purple: 'oklch(0.72 0.14 300)',
  cyan:   'oklch(0.78 0.12 200)',
  brand:  'oklch(0.82 0.16 80)',
  dim:    'oklch(0.62 0.04 220)',
  bg:     'oklch(0.13 0.020 240)',
  text:   'oklch(0.80 0.060 220)',
  grid:   'oklch(0.32 0.040 240 / 0.4)',
};

/* ── GitHub API ───────────────────────────────────────────────── */

const PAT_KEY = 'minnala-dashboard:gh_pat';

function getPAT () { return localStorage.getItem(PAT_KEY) || ''; }
function setPAT (v) {
  if (v && v.trim()) localStorage.setItem(PAT_KEY, v.trim());
  else localStorage.removeItem(PAT_KEY);
}

/* ── Theme switcher ──────────────────────────────────────────────
   Three palettes:
     • cockpit (default, dense dark cyan — matches the V2 frontend)
     • dark    (neutral grayscale, high contrast)
     • ocean   (teal-blue, vibrant)
   Apply by setting `data-theme` on <html>. CSS overrides in styles.css
   pick it up. Persisted via localStorage. Charts use the COLOR /
   CHART_PALETTE objects, which we refresh from CSS variables on every
   theme change so chart strokes/fills track the active palette. */

const THEME_KEY = 'minnala-dashboard:theme';
const THEMES = ['cockpit', 'dark', 'ocean'];

function getTheme () {
  const t = localStorage.getItem(THEME_KEY);
  return THEMES.includes(t) ? t : 'cockpit';
}

function setTheme (t) {
  if (!THEMES.includes(t)) t = 'cockpit';
  document.documentElement.dataset.theme = t;
  localStorage.setItem(THEME_KEY, t);
  document.querySelectorAll('.theme-pill').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === t);
  });
  refreshThemeColors();
  // Re-render existing charts/cards so they pick up the new palette.
  if (typeof render === 'function' && STATE.issues.length) render();
}

function refreshThemeColors () {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => (cs.getPropertyValue(name) || '').trim();
  COLOR.accent = v('--color-accent') || COLOR.accent;
  COLOR.alert  = v('--color-alert')  || COLOR.alert;
  COLOR.loss   = v('--color-loss')   || COLOR.loss;
  COLOR.blue   = v('--color-blue')   || COLOR.blue;
  COLOR.purple = v('--color-purple') || COLOR.purple;
  COLOR.cyan   = v('--color-cyan')   || COLOR.cyan;
  COLOR.brand  = v('--color-brand')  || COLOR.brand;
  COLOR.dim    = v('--color-text-dim') || COLOR.dim;
  COLOR.bg     = v('--color-bg')     || COLOR.bg;
  COLOR.text   = v('--color-text-mid') || COLOR.text;
  CHART_PALETTE.length = 0;
  CHART_PALETTE.push(
    COLOR.accent, COLOR.blue, COLOR.alert, COLOR.purple,
    COLOR.cyan,   COLOR.loss, COLOR.brand, COLOR.dim,
  );
}

function bindTheme () {
  // Apply current theme attribute before any chart renders.
  setTheme(getTheme());
  document.querySelectorAll('.theme-pill').forEach(b => {
    b.addEventListener('click', () => setTheme(b.dataset.theme));
  });
}

async function fetchPage (page, token) {
  const url = `https://api.github.com/repos/${REPO}/issues`
    + `?state=all&per_page=100&page=${page}&sort=updated&direction=desc`;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(url, { headers });

  // Capture rate-limit headers from every response so the UI can show
  // remaining quota even when a call succeeds.
  STATE.rateLimit = {
    limit:     parseInt(resp.headers.get('x-ratelimit-limit')     || '0', 10),
    remaining: parseInt(resp.headers.get('x-ratelimit-remaining') || '0', 10),
    reset:     parseInt(resp.headers.get('x-ratelimit-reset')     || '0', 10),
    used:      parseInt(resp.headers.get('x-ratelimit-used')      || '0', 10),
  };

  if (!resp.ok) {
    let detail = '';
    try { const j = await resp.json(); detail = j.message || ''; } catch {}
    const err = new Error(`GitHub API HTTP ${resp.status}${detail ? `: ${detail}` : ''}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

async function fetchAllIssues (token) {
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const data = await fetchPage(page, token);
    all.push(...data);
    if (data.length < 100) break;
  }
  return all;
}

/* ── Classifier (port of scripts/classify.py) ─────────────────── */

function ruleMatches (rule, item, labelSet) {
  if (rule.always) return true;
  if ('label' in rule) return labelSet.has(rule.label.toLowerCase());
  if ('label_any' in rule)
    return rule.label_any.some(l => labelSet.has(l.toLowerCase()));
  if ('title_contains' in rule) {
    const t = item.title || '';
    return rule.title_contains.some(n => t.includes(n));
  }
  if ('all' in rule) return rule.all.every(r => ruleMatches(r, item, labelSet));
  if ('any' in rule) return rule.any.some(r => ruleMatches(r, item, labelSet));
  return false;
}

function classifyOne (item, taxonomy) {
  const labels = (item.labels || []).map(l => l.name.toLowerCase());
  const labelSet = new Set(labels);

  // ── Explicit auto-tag fast path ─────────────────────────────
  // The "+ New issue" form attaches `module:<id>` + `submodule:<id>`
  // labels per the picker. If both are present AND the IDs exist in
  // taxonomy, classification is direct — no rule walk, no
  // misclassification when the title doesn't include a keyword.
  const modTag = labels.find(l => l.startsWith('module:'));
  const subTag = labels.find(l => l.startsWith('submodule:'));
  if (modTag && subTag) {
    const modId = modTag.slice(7);
    const subId = subTag.slice(10);
    const mod = taxonomy.modules.find(m => m.id === modId);
    if (mod && (mod.submodules || []).some(s => s.id === subId)) {
      return { module: modId, submodule: subId };
    }
  }
  // Module-only tag: bucket by module, leave submodule to rule walk
  // (or fall back to the first submodule if nothing matches).
  let forcedModule = null;
  if (modTag) {
    const modId = modTag.slice(7);
    if (taxonomy.modules.find(m => m.id === modId)) forcedModule = modId;
  }

  // ── Rule walk (existing path) ───────────────────────────────
  for (const m of taxonomy.modules) {
    if (forcedModule && m.id !== forcedModule) continue;
    for (const s of (m.submodules || [])) {
      for (const r of (s.rules || [])) {
        if (ruleMatches(r, item, labelSet)) {
          return { module: m.id, submodule: s.id };
        }
      }
    }
  }
  // Module forced but no submodule matched → put in first submodule.
  if (forcedModule) {
    const mod = taxonomy.modules.find(m => m.id === forcedModule);
    const firstSub = mod?.submodules?.[0]?.id || 'uncategorized';
    return { module: forcedModule, submodule: firstSub };
  }
  return { module: 'uncategorized', submodule: 'uncategorized' };
}

function priorityOf (labelNames, priorityLabels) {
  const set = new Set(labelNames.map(n => n.toLowerCase()));
  for (const p of priorityLabels) {
    if (set.has(p)) return p;
  }
  return null;
}

// Surface classification — UI / Backend / Full-stack / Unclassified.
// Derived from labels only (frontend ones get UI; backend/server/api get
// Backend; if both signals present → Full-stack). Used by the Kanban
// surface filter and the "UI vs Backend" donut. After the 2026-05-17
// granular label rollout this also recognises the new prefixes so an
// issue labelled only `ui-v2-dashboard` + `backend-router-trading` is
// classified as full-stack instead of falling through to unclassified.
function surfaceOf (labelNames) {
  const lc = labelNames.map(n => n.toLowerCase());
  const set = new Set(lc);
  const hasAnyPrefix = (prefixes) =>
    lc.some(n => prefixes.some(p => n.startsWith(p)));
  const ui = set.has('ui') || set.has('frontend') || set.has('v1-cutover')
          || hasAnyPrefix(['ui-v2-']);
  const be = set.has('backend') || set.has('server') || set.has('api')
          || set.has('signal-engine') || set.has('broker') || set.has('streaming')
          || set.has('storage') || set.has('schema-drift') || set.has('auth')
          || set.has('multi-user') || set.has('infra') || set.has('webhook')
          || hasAnyPrefix([
              'backend-', 'broker-', 'data-', 'aws-', 'db-', 'infra-',
              'webhook-', 'notify-', 'ml-', 'dl-', 'ts-', 'llm-', 'pay-',
            ]);
  if (set.has('fullstack') || (ui && be)) return 'fullstack';
  if (ui) return 'ui';
  if (be) return 'backend';
  return 'unclassified';
}

/* ── Five-proof contract ─────────────────────────────────────────
   For each dimension D ∈ {db, src, test, logs, ui}, an issue must
   declare one of:
     • proved-D       — proof supplied
     • proof-na-D     — N/A (dimension doesn't apply to this issue)
     • neither        — missing → contributes to `needs-proof`
   See .github/issue-workflow.json `five_proof_required` for the
   canonical contract. */
const PROOF_DIMS = ['db', 'src', 'test', 'logs', 'ui'];

function proofStatus (labelNames) {
  const set = new Set(labelNames.map(n => n.toLowerCase()));
  const dims = {};
  let supplied = 0, na = 0, missing = 0;
  for (const d of PROOF_DIMS) {
    if (set.has(`proved-${d}`)) { dims[d] = 'supplied'; supplied++; }
    else if (set.has(`proof-na-${d}`)) { dims[d] = 'na'; na++; }
    else { dims[d] = 'missing'; missing++; }
  }
  return {
    dims,
    supplied,
    na,
    missing,
    covered: supplied + na,
    fully_proved: missing === 0,
  };
}

// Type classification — Bug / Feature / Chore / Docs. Used for the
// "Type breakdown" tiles row on the dashboard.
function typeOf (labelNames) {
  const set = new Set(labelNames.map(n => n.toLowerCase()));
  if (set.has('bug')) return 'bug';
  if (set.has('task')) return 'task';
  if (set.has('documentation') || set.has('docs')) return 'docs';
  if (set.has('enhancement') || set.has('feature') || set.has('feat')) return 'feat';
  if (set.has('chore') || set.has('tech-debt')) return 'chore';
  return null;
}

// Kanban stage from labels (open) or 'done' (closed).
function stageOf (item) {
  if (item.state !== 'open') return 'done';
  const set = new Set((item.labels || []).map(n => n.toLowerCase()));
  if (set.has('review') || set.has('qa') || set.has('ready-for-review')) return 'inreview';
  if (set.has('in-progress') || set.has('wip') || set.has('doing')) return 'inprogress';
  return 'todo';
}

function ageDaysFrom (iso) {
  if (!iso) return -1;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return -1;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function slimRecord (item, taxonomy) {
  const isPR = !!item.pull_request;
  const merged = isPR && !!(item.pull_request.merged_at);
  const draft = isPR && (item.draft === true);
  const labelObjs = (item.labels || []);
  const labels = labelObjs.map(l => l.name);
  // Stash hex color from the GH label record so the sidebar Labels
  // section can render the colored dot. Only counts toward "open"
  // totals here — closed records still pass through.
  for (const lo of labelObjs) {
    const m = LABEL_META.get(lo.name) ||
      { color: '#' + (lo.color || '888'), count: 0, count_pr: 0, count_issue: 0 };
    if (item.state === 'open') {
      m.count++;
      if (isPR) m.count_pr++; else m.count_issue++;
    }
    LABEL_META.set(lo.name, m);
  }
  const { module, submodule } = classifyOne(item, taxonomy);

  // For PRs: treat 'closed + merged_at set' as a separate "merged" state
  // so the user can filter merged vs closed-without-merge.
  let state = item.state;
  if (merged) state = 'merged';

  return {
    number: item.number,
    title: item.title,
    state,
    is_pr: isPR,
    draft,
    merged,
    merged_at: isPR ? (item.pull_request.merged_at || null) : null,
    kind: isPR ? 'pr' : 'issue',
    labels,
    priority: priorityOf(labels, taxonomy.priority_labels),
    module,
    submodule,
    url: item.html_url,
    created_at: item.created_at,
    updated_at: item.updated_at,
    closed_at: item.closed_at,
    age_days: ageDaysFrom(item.created_at),
    comments: item.comments || 0,
    author: item.user?.login || '',
    author_avatar: item.user?.avatar_url || '',
    assignees: (item.assignees || []).map(a => ({
      login: a.login,
      avatar: a.avatar_url,
    })),
    surface: surfaceOf(labels),
    kind_type: typeOf(labels),
    proof: proofStatus(labels),
    stage: null,        // computed below; needs the slim record itself
    body: item.body || '',
    milestone: item.milestone ? { number: item.milestone.number,
                                  title: item.milestone.title } : null,
  };
}

/* ── Stats builder ───────────────────────────────────────────── */

function buildTrend (issues, days = 90) {
  const today = new Date(); today.setUTCHours(23, 59, 59, 999);
  const parsed = issues.map(i => ({
    created: new Date(i.created_at).getTime(),
    closed: i.closed_at ? new Date(i.closed_at).getTime() : null,
  })).filter(p => !Number.isNaN(p.created));

  const series = [];
  for (let d = days; d >= 0; d--) {
    const day = new Date(today.getTime() - d * 86400000);
    const dayEnd = day.getTime();
    let open = 0, opened = 0, closed = 0;
    const dayStart = dayEnd - 86400000;
    for (const p of parsed) {
      if (p.created > dayStart && p.created <= dayEnd) opened++;
      if (p.closed && p.closed > dayStart && p.closed <= dayEnd) closed++;
      if (p.created <= dayEnd && (p.closed === null || p.closed > dayEnd)) open++;
    }
    series.push({ date: day.toISOString().slice(0, 10), open, opened, closed });
  }
  return series;
}

function buildStats (issues, taxonomy) {
  const open = issues.filter(i => i.state === 'open');
  const openIssues = open.filter(i => !i.is_pr);
  const openPRs    = open.filter(i =>  i.is_pr);

  const cnt = (p) => open.filter(i => (i.priority || 'none') === p).length;
  const within = (iso, days) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return !Number.isNaN(t) && t >= (Date.now() - days * 86400000);
  };

  const oldest = [...open].sort((a, b) => b.age_days - a.age_days).slice(0, 15);

  const byMod = {};
  const byModPri = {};
  const bySub = {};
  for (const i of open) {
    byMod[i.module] = (byMod[i.module] || 0) + 1;
    byModPri[i.module] = byModPri[i.module] || { p0: 0, p1: 0, p2: 0, none: 0 };
    byModPri[i.module][i.priority || 'none']++;
    const k = `${i.module}:${i.submodule}`;
    bySub[k] = bySub[k] || { open: 0, closed: 0 };
    bySub[k].open++;
  }
  for (const i of issues) {
    if (i.state !== 'open') {
      const k = `${i.module}:${i.submodule}`;
      bySub[k] = bySub[k] || { open: 0, closed: 0 };
      bySub[k].closed++;
    }
  }

  const moduleTree = taxonomy.modules.map(m => ({
    id: m.id, label: m.label, icon: m.icon, color: m.color,
    open: byMod[m.id] || 0,
    submodules: (m.submodules || []).map(s => ({
      id: s.id, label: s.label,
      open: bySub[`${m.id}:${s.id}`]?.open || 0,
      closed: bySub[`${m.id}:${s.id}`]?.closed || 0,
    })),
  }));

  return {
    generated_at: new Date().toISOString(),
    totals: {
      total: issues.length,
      open: open.length,
      open_issues: openIssues.length,
      open_prs: openPRs.length,
      closed: issues.length - open.length,
      opened_7d:  issues.filter(i => within(i.created_at, 7)).length,
      closed_7d:  issues.filter(i => within(i.closed_at,  7)).length,
      merged_7d:  issues.filter(i => i.merged && within(i.merged_at, 7)).length,
    },
    by_priority: { p0: cnt('p0'), p1: cnt('p1'), p2: cnt('p2'), none: cnt('none') },
    age_buckets: (() => {
      const b = { '<7d': 0, '7-30d': 0, '30-90d': 0, '>90d': 0 };
      for (const i of open) {
        if (i.age_days < 7) b['<7d']++;
        else if (i.age_days < 30) b['7-30d']++;
        else if (i.age_days < 90) b['30-90d']++;
        else b['>90d']++;
      }
      return b;
    })(),
    oldest_open: oldest,
    trend_90d: buildTrend(issues, 90),
    modules: moduleTree,
  };
}

/* ── Top-level load ───────────────────────────────────────────── */

async function loadData () {
  setLoadingUI();
  try {
    if (!STATE.taxonomy) {
      // Cache-bust so taxonomy edits land without forcing users to hard-refresh.
      const taxResp = await fetch('taxonomy.json?v=2026-05-17c');
      STATE.taxonomy = await taxResp.json();
    }
    const token = getPAT();
    const raw = await fetchAllIssues(token);
    LABEL_META.clear();          // rebuild label index from scratch
    STATE.issues  = raw.map(r => slimRecord(r, STATE.taxonomy));
    for (const i of STATE.issues) i.stage = stageOf(i);
    // Resolve the logged-in user (for 'Assigned to me' toggle).
    // Non-fatal: failure leaves currentUser=null and the toggle just
    // shows no rows when checked.
    try { STATE.currentUser = await fetchCurrentUser(token); } catch { STATE.currentUser = null; }
    STATE.stats   = buildStats(STATE.issues, STATE.taxonomy);
    STATE.modules = STATE.stats.modules;

    clearErrorBanner();
    document.getElementById('lastUpdated').textContent =
      `live · fetched ${new Date().toLocaleTimeString()}`;
    updateRateLimitDisplay();
  } catch (e) {
    showErrorBanner(e);
    document.getElementById('lastUpdated').textContent = `⚠ load failed`;
    STATE.issues = STATE.issues.length ? STATE.issues : [];
    STATE.stats  = STATE.stats  || { totals: {}, by_priority: {}, modules: [],
                                     oldest_open: [], trend_90d: [], age_buckets: {} };
    STATE.modules = STATE.modules.length ? STATE.modules
                   : (STATE.taxonomy?.modules?.map(m => ({...m, open:0, submodules:m.submodules?.map(s => ({...s, open:0, closed:0})) || []})) || []);
  }
}

function setLoadingUI () {
  document.getElementById('lastUpdated').textContent = 'fetching from GitHub…';
}

function updateRateLimitDisplay () {
  const r = STATE.rateLimit;
  const el = document.getElementById('rateLimit');
  if (!r.limit) { el.textContent = ''; return; }
  const resetIn = r.reset ? Math.max(0, r.reset * 1000 - Date.now()) : 0;
  const mins = Math.round(resetIn / 60000);
  const isLow = r.remaining < 10;
  el.textContent = `API: ${r.remaining}/${r.limit}${mins ? ` · resets in ${mins}m` : ''}`;
  el.style.color = isLow ? COLOR.alert : '';
}

function showErrorBanner (err) {
  const el = document.getElementById('errorBanner');
  const hasToken = !!getPAT();
  const is404  = err.status === 404;
  const is401  = err.status === 401;
  const isRate = err.status === 403 || (err.message || '').toLowerCase().includes('rate limit');

  let hint = '';
  if (is404 && !hasToken) {
    hint = `<br><strong>Looks like a private repo.</strong> GitHub returns 404 to anonymous callers for private repositories. Click <strong>⚙ Settings</strong> above and paste a personal access token scoped to <code>${REPO}</code>. The token stays in your browser's localStorage.`;
  } else if (is404 && hasToken) {
    hint = `<br>Your token doesn't have access to <code>${REPO}</code>. Re-create it with <strong>Contents: Read + Issues: Read + Metadata: Read</strong> on this repo, or use a token with a broader scope.`;
  } else if (is401) {
    hint = `<br>Token rejected by GitHub (likely expired or revoked). Open <strong>⚙ Settings</strong> and paste a fresh one.`;
  } else if (isRate && !hasToken) {
    hint = `<br>Anonymous GitHub API is rate-limited to 60 req/hour. Click <strong>⚙ Settings</strong> to add a token (5,000 req/hour).`;
  } else if (isRate && hasToken) {
    hint = `<br>Your token has hit its rate limit. Wait for the reset shown above, or use a different PAT.`;
  }

  el.innerHTML = `<strong>${escapeHTML(err.message)}</strong>${hint}`;
  el.classList.remove('hidden');
}
function clearErrorBanner () { document.getElementById('errorBanner').classList.add('hidden'); }

/* ── Helpers ──────────────────────────────────────────────────── */

function moduleLabel (id) {
  const m = STATE.modules.find(x => x.id === id);
  return m ? `${m.icon} ${m.label}` : id;
}
function moduleColor (id) {
  const m = STATE.modules.find(x => x.id === id);
  return m ? m.color : COLOR.dim;
}
function submoduleLabel (modId, subId) {
  const m = STATE.modules.find(x => x.id === modId);
  if (!m) return subId;
  const s = (m.submodules || []).find(x => x.id === subId);
  return s ? s.label : subId;
}
function escapeHTML (s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}
function fmtRelative (iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60)    return `${sec}s ago`;
  if (sec < 3600)  return `${Math.floor(sec/60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec/3600)}h ago`;
  const days = Math.floor(sec / 86400);
  if (days < 30)   return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/* ── Sidebar ──────────────────────────────────────────────────── */

function renderSidebar () {
  const root = document.getElementById('moduleTree');
  root.innerHTML = '';
  // Show ALL taxonomy modules — including empty ones — so the menu
  // structure is visible as a placeholder (e.g. ML & DL waiting for
  // its first labeled issue). Empty rows are dimmed via .empty class.
  for (const m of STATE.modules) {
    const isEmpty = m.open === 0 && (!m.submodules || m.submodules.every(s => s.open === 0));
    const li = document.createElement('li');
    li.className = (FILTERS.module === m.id) ? 'expanded' : '';
    const head = document.createElement('button');
    head.className = 'module-row'
      + (FILTERS.module === m.id && !FILTERS.submodule ? ' active' : '')
      + (isEmpty ? ' empty' : '');
    head.innerHTML = `
      <span class="chev">▸</span>
      <span class="module-icon">${m.icon}</span>
      <span class="module-label">${m.label}</span>
      <span class="module-count">${m.open}</span>
    `;
    head.onclick = () => {
      if (FILTERS.module === m.id && !FILTERS.submodule) {
        FILTERS.module = null;
      } else {
        FILTERS.module = m.id;
        FILTERS.submodule = null;
      }
      PAGE.idx = 0;
      // Module clicks jump to the dashboard table per spec.
      if (ROUTE.current !== 'dashboard') navigate('dashboard');
      else render();
    };
    li.appendChild(head);

    if (m.submodules && m.submodules.length) {
      const ul = document.createElement('ul');
      ul.className = 'sub-list';
      for (const s of m.submodules) {
        if (s.open === 0 && s.closed === 0) continue;
        const sb = document.createElement('button');
        const isActive = FILTERS.module === m.id && FILTERS.submodule === s.id;
        sb.className = 'sub-row' + (isActive ? ' active' : '');
        sb.innerHTML = `
          <span class="module-label">${s.label}</span>
          <span class="module-count">${s.open}</span>
        `;
        sb.onclick = (ev) => {
          ev.stopPropagation();
          FILTERS.module = m.id;
          FILTERS.submodule = isActive ? null : s.id;
          PAGE.idx = 0;
          if (ROUTE.current !== 'dashboard') navigate('dashboard');
          else render();
        };
        const subLi = document.createElement('li');
        subLi.appendChild(sb);
        ul.appendChild(subLi);
      }
      li.appendChild(ul);
    }
    root.appendChild(li);
  }
}

/* ── Filtering ────────────────────────────────────────────────── */

function applyFilters (issues, opts = {}) {
  // opts.skipStatus: ignore the global Status pill (Open/Merged/Closed/All).
  // Used by the Kanban board — the column IS the state, so the global
  // filter shouldn't hide the Done column when Open is selected.
  const q = FILTERS.search.trim().toLowerCase();
  const skipStatus = !!opts.skipStatus;
  return issues.filter(i => {
    if (FILTERS.module    && i.module    !== FILTERS.module)    return false;
    if (FILTERS.submodule && i.submodule !== FILTERS.submodule) return false;
    if (FILTERS.label && !(i.labels || []).includes(FILTERS.label)) return false;
    if (FILTERS.kindType && i.kind_type !== FILTERS.kindType) return false;
    if (FILTERS.type === 'issue' && i.is_pr)  return false;
    if (FILTERS.type === 'bug'   && (i.is_pr || i.kind_type !== 'bug'))  return false;
    if (FILTERS.type === 'task'  && (i.is_pr || i.kind_type !== 'task')) return false;
    if (FILTERS.type === 'pr'    && !i.is_pr) return false;
    if (FILTERS.assigneeAny  && (i.assignees || []).length === 0) return false;
    if (FILTERS.assigneeNone && (i.assignees || []).length >  0)  return false;
    if (FILTERS.wipOnly      && (!i.stage || i.stage === 'todo' || i.stage === 'done')) return false;
    if (FILTERS.priority !== 'all') {
      const p = i.priority || 'none';
      if (p !== FILTERS.priority) return false;
    }
    if (!skipStatus && FILTERS.status !== 'all') {
      if (FILTERS.status === 'merged' && i.state !== 'merged') return false;
      if (FILTERS.status === 'open'   && i.state !== 'open')   return false;
      if (FILTERS.status === 'closed' && i.state !== 'closed' && i.state !== 'merged') return false;
    }
    if (FILTERS.age !== 'all') {
      const a = i.age_days;
      if (FILTERS.age === '<7'    && !(a < 7))                return false;
      if (FILTERS.age === '7-30'  && !(a >= 7   && a < 30))   return false;
      if (FILTERS.age === '30-90' && !(a >= 30  && a < 90))   return false;
      if (FILTERS.age === '>90'   && !(a >= 90))              return false;
    }
    if (q) {
      const hay = `${i.title} #${i.number} ${i.author}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (FILTERS.assignedToMe && STATE.currentUser) {
      const me = STATE.currentUser.login;
      if (!(i.assignees || []).some(a => a.login === me)) return false;
    }
    if (FILTERS.proof) {
      const p = i.proof;
      if (FILTERS.proof === 'proved'  && !p.fully_proved) return false;
      if (FILTERS.proof === 'needs'   && p.missing === 0) return false;
      if (FILTERS.proof === 'partial' && !(p.missing > 0 && p.covered > 0)) return false;
    }
    return true;
  });
}

function renderFilterBanner () {
  const banner = document.getElementById('filterBanner');
  const chips = [];
  if (FILTERS.module)    chips.push(moduleLabel(FILTERS.module));
  if (FILTERS.submodule) chips.push(submoduleLabel(FILTERS.module, FILTERS.submodule));
  if (FILTERS.label)     chips.push('label:' + FILTERS.label);
  if (FILTERS.kindType)  chips.push('type:' + FILTERS.kindType);
  if (FILTERS.type !== 'all')     chips.push(FILTERS.type.toUpperCase());
  if (FILTERS.priority !== 'all') chips.push(FILTERS.priority.toUpperCase());
  if (FILTERS.status !== 'open')  chips.push(FILTERS.status);
  if (FILTERS.age !== 'all')      chips.push('age:' + FILTERS.age);
  if (FILTERS.proof)              chips.push('proof:' + FILTERS.proof);
  if (FILTERS.search)             chips.push(`search:"${FILTERS.search}"`);
  if (FILTERS.assigneeAny)        chips.push('🤝 assigned');
  if (FILTERS.assigneeNone)       chips.push('🆓 unassigned');
  if (FILTERS.wipOnly)            chips.push('⏳ in-progress');
  if (chips.length === 0) { banner.classList.add('hidden'); return; }
  banner.classList.remove('hidden');
  banner.innerHTML = '<span class="muted">Filters:</span>' +
    chips.map(c => `<span class="chip">${escapeHTML(c)}</span>`).join('');
}

/* ── KPI tiles ────────────────────────────────────────────────── */

function renderKPIs (filtered) {
  // Reactive: KPIs reflect the current global filter set. Previously
  // this function read STATE.stats (computed once at load), so clicking
  // Priority/Status/Age pills didn't move the numbers.
  const src = filtered || STATE.issues || [];
  const open = src.filter(i => i.state === 'open');
  const cnt = (p) => open.filter(i => (i.priority || 'none') === p).length;
  const within = (iso, days) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return !Number.isNaN(t) && t >= (Date.now() - days * 86400000);
  };
  document.getElementById('kpiOpenIssues').textContent = open.filter(i => !i.is_pr).length;
  document.getElementById('kpiOpenPRs').textContent    = open.filter(i =>  i.is_pr).length;
  // Closed (all-time) ignores the status filter: shows the running total
  // since project start. Helps explain the open/closed disparity — most
  // closed records are old/superseded work, not current backlog.
  document.getElementById('kpiClosedAll').textContent =
    (STATE.issues || []).filter(i => !i.is_pr && (i.state === 'closed' || i.state === 'merged')).length;
  document.getElementById('kpiP0').textContent         = cnt('p0');
  document.getElementById('kpiP1').textContent         = cnt('p1');
  document.getElementById('kpiP2').textContent         = cnt('p2');
  // 7-day activity tiles: they show platform velocity ("how many closed
  // / merged in the last week"). Reading from `src` (status-filtered)
  // hid every closed/merged record when the default Status=Open pill is
  // active — the tiles read 0 even when many records existed. Re-run
  // the filter without the Status constraint so all other dimensions
  // (module / priority / age / search) still apply.
  const activity = applyFilters(STATE.issues || [], { skipStatus: true });
  document.getElementById('kpiOpened7d').textContent   = activity.filter(i => within(i.created_at, 7)).length;
  document.getElementById('kpiClosed7d').textContent   = activity.filter(i => within(i.closed_at,  7)).length;
  document.getElementById('kpiMerged7d').textContent   = activity.filter(i => i.merged && within(i.merged_at, 7)).length;
  // Workflow tiles: assigned / unassigned / in-progress. These fill the
  // 4-col grid's previously-orphaned row 3 and surface "who is on what"
  // alongside the priority + activity stats.
  const openIssues = open.filter(i => !i.is_pr);
  document.getElementById('kpiAssigned').textContent   = openIssues.filter(i => (i.assignees || []).length > 0).length;
  document.getElementById('kpiUnassigned').textContent = openIssues.filter(i => (i.assignees || []).length === 0).length;
  document.getElementById('kpiWip').textContent        = openIssues.filter(i => i.stage && i.stage !== 'todo').length;
}

/* ── Charts ───────────────────────────────────────────────────── */

function chartDestroy (id) { if (CHARTS[id]) { CHARTS[id].destroy(); CHARTS[id] = null; } }

function renderChartModule (filtered) {
  const open = filtered.filter(i => i.state === 'open');
  const byMod = {};
  for (const i of open) byMod[i.module] = (byMod[i.module] || 0) + 1;
  const labels = Object.keys(byMod).sort((a, b) => byMod[b] - byMod[a]);
  const data   = labels.map(k => byMod[k]);
  const colors = labels.map(k => moduleColor(k));
  const displayLabels = labels.map(k => moduleLabel(k));
  chartDestroy('chartModule');
  CHARTS.chartModule = new Chart(document.getElementById('chartModule'), {
    type: 'doughnut',
    data: { labels: displayLabels,
            datasets: [{ data, backgroundColor: colors, borderColor: COLOR.bg, borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right',
                  labels: { color: COLOR.text, font: { family: 'Inter', size: 11 } } },
        tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed}` } },
      },
    },
  });
}

function renderChartPriorityStack (filtered) {
  const open = filtered.filter(i => i.state === 'open');
  const mods = STATE.modules.filter(m => open.some(i => i.module === m.id));
  const labels = mods.map(m => m.label);
  const series = (p) => mods.map(m => open.filter(i => i.module === m.id && (i.priority || 'none') === p).length);
  chartDestroy('chartPriorityStack');
  CHARTS.chartPriorityStack = new Chart(document.getElementById('chartPriorityStack'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'P0', data: series('p0'),   backgroundColor: COLOR.loss },
        { label: 'P1', data: series('p1'),   backgroundColor: COLOR.alert },
        { label: 'P2', data: series('p2'),   backgroundColor: COLOR.blue },
        { label: '∅',  data: series('none'), backgroundColor: COLOR.dim },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      scales: {
        x: { stacked: true,
             ticks: { color: COLOR.text, font: { family: 'Inter' } },
             grid: { color: COLOR.grid } },
        y: { stacked: true,
             ticks: {
               color: COLOR.text, font: { family: 'Inter' },
               // Force every module label to render — Chart.js auto-skips
               // labels when the chart is short, which hid Backend Core /
               // Testing & QA / Infra & Deploy / Documentation rows.
               autoSkip: false,
               maxRotation: 0, minRotation: 0,
             },
             grid: { display: false } },
      },
      plugins: { legend: { position: 'bottom',
                           labels: { color: COLOR.text, font: { family: 'Inter', size: 11 } } } },
    },
  });
}

function renderChartTrend () {
  const t = STATE.stats?.trend_90d || [];
  chartDestroy('chartTrend');
  if (!t.length) return;
  CHARTS.chartTrend = new Chart(document.getElementById('chartTrend'), {
    type: 'line',
    data: { labels: t.map(d => d.date.slice(5)),
            datasets: [{ label: 'Open count', data: t.map(d => d.open),
                         borderColor: COLOR.accent,
                         backgroundColor: 'oklch(0.78 0.20 145 / 0.14)',
                         fill: true, tension: 0.25, pointRadius: 0, borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: COLOR.text, font: { family: 'Inter' }, maxTicksLimit: 12 }, grid: { display: false } },
        y: { ticks: { color: COLOR.text, font: { family: 'Inter' } }, grid: { color: COLOR.grid } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

function renderChartAge (filtered) {
  const open = filtered.filter(i => i.state === 'open');
  const b = { '<7d': 0, '7-30d': 0, '30-90d': 0, '>90d': 0 };
  for (const i of open) {
    if (i.age_days < 7) b['<7d']++;
    else if (i.age_days < 30) b['7-30d']++;
    else if (i.age_days < 90) b['30-90d']++;
    else b['>90d']++;
  }
  chartDestroy('chartAge');
  CHARTS.chartAge = new Chart(document.getElementById('chartAge'), {
    type: 'bar',
    data: { labels: Object.keys(b),
            datasets: [{ label: 'Open issues', data: Object.values(b),
                         backgroundColor: [COLOR.accent, COLOR.blue, COLOR.alert, COLOR.loss] }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: COLOR.text, font: { family: 'Inter' } }, grid: { display: false } },
        y: { ticks: { color: COLOR.text, font: { family: 'Inter' } }, grid: { color: COLOR.grid } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

/* ── Oldest list ──────────────────────────────────────────────── */

function renderOldest () {
  const list = document.getElementById('oldestList');
  list.innerHTML = '';
  const items = STATE.stats?.oldest_open || [];
  for (const i of items.slice(0, 10)) {
    const li = document.createElement('li');
    li.title = i.title;        // hover shows full title in tight sidebar
    li.onclick = () => window.open(i.url, '_blank', 'noopener');
    li.innerHTML = `
      <span class="o-num">${i.is_pr ? 'PR' : '#'}${i.number}</span>
      <span class="o-title">${escapeHTML(i.title)}</span>
      <span class="o-age">${i.age_days}d</span>
    `;
    list.appendChild(li);
  }
  if (items.length === 0) list.innerHTML = '<li class="muted">None.</li>';
}

function renderLabels () {
  const root = document.getElementById('labelList');
  const hint = document.querySelector('.sidebar .sidebar-sub-hint');
  root.innerHTML = '';

  // Sorted by open-count desc.
  // - Default: LABEL_META (whole-repo open issues).
  // - When FILTERS.module is set: rebuild counts from THAT module's
  //   open issues only, so the sidebar shows only labels that exist
  //   inside the selected bucket. (Submodule honored too.)
  // - Search input narrows by substring on label name.
  const q = (document.getElementById('labelSearch')?.value || '').trim().toLowerCase();
  let entries;
  if (FILTERS.module) {
    const inModule = STATE.issues.filter(i =>
      i.state === 'open' &&
      i.module === FILTERS.module &&
      (!FILTERS.submodule || i.submodule === FILTERS.submodule)
    );
    const local = new Map();
    for (const i of inModule) {
      for (const lname of (i.labels || [])) {
        const m = local.get(lname)
          || { color: LABEL_META.get(lname)?.color || '#888',
               count: 0, count_pr: 0, count_issue: 0 };
        m.count++;
        if (i.is_pr) m.count_pr++; else m.count_issue++;
        local.set(lname, m);
      }
    }
    entries = Array.from(local.entries());
    if (hint) hint.textContent = `in ${moduleLabel(FILTERS.module).split(' ').slice(1).join(' ') || FILTERS.module}`;
  } else {
    entries = Array.from(LABEL_META.entries());
    if (hint) hint.textContent = 'auto · click to filter';
  }
  entries = entries
    .filter(([name, m]) => m.count > 0 && (q === '' || name.toLowerCase().includes(q)))
    .sort((a, b) => b[1].count - a[1].count);
  if (entries.length === 0) {
    root.innerHTML = q
      ? `<li class="muted small" style="padding:var(--space-1) var(--space-3)">No labels match "${escapeHTML(q)}".</li>`
      : '<li class="muted">No labels.</li>';
    return;
  }
  for (const [name, m] of entries.slice(0, 40)) {
    const li = document.createElement('li');
    const isActive = FILTERS.label === name;
    const btn = document.createElement('button');
    btn.className = 'label-row' + (isActive ? ' active' : '');
    btn.title = `${m.count_issue} issue${m.count_issue === 1 ? '' : 's'} + ${m.count_pr} PR${m.count_pr === 1 ? '' : 's'}`;
    btn.innerHTML = `
      <span class="label-dot" style="background:${m.color}"></span>
      <span class="label-name">${escapeHTML(name)}</span>
      <span class="module-count">${m.count}</span>
    `;
    btn.onclick = () => {
      FILTERS.label = isActive ? null : name;
      PAGE.idx = 0;
      render();
    };
    li.appendChild(btn);
    root.appendChild(li);
  }
}

/* ── Table ────────────────────────────────────────────────────── */

function sortIssues (issues) {
  const dir = SORT.dir === 'asc' ? 1 : -1;
  const c = SORT.col;
  return [...issues].sort((a, b) => {
    let av = a[c], bv = b[c];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
  });
}

/* ── Proof rendering ──────────────────────────────────────────────
   - renderProofDots(p): 5 small dots per row (green=supplied / gray=N/A
     / red=missing), with a tooltip enumerating each dimension.
   - renderProofKPIs(scope): drives the four tiles in `.kpis-proof`.
     `scope` is the same activity-scope (skipStatus filter) used by the
     7-day tiles, so the proof view is not erased by Status=Open. */
function renderProofDots (p) {
  if (!p) return '';
  const labels = ['DB', 'SRC', 'TEST', 'LOGS', 'UI'];
  const dots = PROOF_DIMS.map((d, idx) => {
    const state = p.dims[d];
    const sym = state === 'supplied' ? '●' : state === 'na' ? '◐' : '○';
    return `<span class="proof-dot proof-${state}" title="${labels[idx]}: ${state}">${sym}</span>`;
  }).join('');
  const title = `${p.supplied} supplied · ${p.na} N/A · ${p.missing} missing`;
  return `<span class="proof-dots" title="${title}">${dots}</span>`;
}

function renderChartProofDims (scope) {
  const canvas = document.getElementById('chartProofDims');
  if (!canvas) return;
  const counts = PROOF_DIMS.map(d => {
    let supplied = 0, na = 0, missing = 0;
    for (const i of scope) {
      const st = i.proof?.dims?.[d];
      if (st === 'supplied') supplied++;
      else if (st === 'na')  na++;
      else missing++;
    }
    return { supplied, na, missing };
  });
  chartDestroy('chartProofDims');
  CHARTS.chartProofDims = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: PROOF_DIMS.map(d => d.toUpperCase()),
      datasets: [
        { label: 'Supplied', data: counts.map(c => c.supplied), backgroundColor: COLOR.accent },
        { label: 'N/A',      data: counts.map(c => c.na),       backgroundColor: COLOR.dim },
        { label: 'Missing',  data: counts.map(c => c.missing),  backgroundColor: COLOR.loss },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      scales: {
        x: { stacked: true, ticks: { color: COLOR.text }, grid: { color: COLOR.grid } },
        y: { stacked: true, ticks: { color: COLOR.text }, grid: { display: false } },
      },
      plugins: { legend: { position: 'bottom', labels: { color: COLOR.text, font: { size: 11 } } } },
    },
  });
}

function renderProofKPIs (scope) {
  if (!scope || !scope.length) return;
  let proved = 0, partial = 0, needs = 0, totalCovered = 0;
  for (const i of scope) {
    if (i.proof.fully_proved) proved++;
    else if (i.proof.supplied > 0 || i.proof.na > 0) partial++;
    else needs += 0;             // tally below
    if (i.proof.missing > 0) needs++;
    totalCovered += i.proof.covered;
  }
  const coveragePct = scope.length
    ? Math.round((totalCovered / (scope.length * 5)) * 100)
    : 0;
  document.getElementById('kpiProved').textContent       = proved;
  document.getElementById('kpiPartial').textContent      = partial;
  document.getElementById('kpiNeedsProof').textContent   = needs;
  document.getElementById('kpiProofCoverage').textContent = coveragePct + '%';
  // Highlight Needs-proof tile when the filter is active.
  document.querySelectorAll('.kpis-proof .kpi').forEach(el => {
    el.classList.toggle('active',
      FILTERS.proof && el.dataset.proof === FILTERS.proof);
  });
}

function renderTable (filtered) {
  const sorted = sortIssues(filtered);
  const total = sorted.length;
  document.getElementById('tableCount').textContent = `${total} record${total === 1 ? '' : 's'}`;

  const start = PAGE.idx * PAGE.size;
  const slice = sorted.slice(start, start + PAGE.size);

  const tbody = document.getElementById('issueBody');
  tbody.innerHTML = '';
  for (const i of slice) {
    const tr = document.createElement('tr');
    tr.className = (i.state === 'open' ? '' : 'closed');
    // Click body → drawer; the ↗ link in the title cell → GH directly.
    tr.onclick = (e) => {
      if (e.target.closest('.t-extlink')) return;   // let the link handle it
      openDrawer(i.number);
    };
    const pri = i.priority || 'none';
    const kindPill = i.is_pr
      ? `<span class="t-kind pr">${i.draft ? 'Draft' : 'PR'}</span>`
      : `<span class="t-kind issue">Issue</span>`;
    const stateLabel = i.state;
    tr.innerHTML = `
      <td class="num"><span class="t-num">${i.number}</span></td>
      <td>${kindPill}</td>
      <td>
        <span class="t-title">${escapeHTML(i.title)}</span>
        <a class="t-extlink" target="_blank" rel="noreferrer" href="${i.url}" title="Open in GitHub">↗</a>
      </td>
      <td>${renderAvatarStack(i.assignees, 2)}</td>
      <td><span class="t-mod" style="color:${moduleColor(i.module)}">${moduleLabel(i.module).split(' ')[0]}</span> <span class="muted">${escapeHTML(submoduleLabel(i.module, i.submodule))}</span></td>
      <td><span class="t-pri ${pri}">${pri}</span></td>
      <td><span class="t-author">${escapeHTML(i.author || '—')}</span></td>
      <td class="num">${i.age_days}d</td>
      <td class="num">${i.comments}</td>
      <td>${renderProofDots(i.proof)}</td>
      <td><span class="t-state ${stateLabel}">${stateLabel}</span></td>
    `;
    tbody.appendChild(tr);
  }

  const pages = Math.max(1, Math.ceil(total / PAGE.size));
  if (PAGE.idx >= pages) PAGE.idx = 0;
  const pager = document.getElementById('pager');
  pager.innerHTML = '';
  const prev = document.createElement('button');
  prev.textContent = '‹ Prev';
  prev.disabled = PAGE.idx === 0;
  prev.onclick = () => { PAGE.idx--; renderTable(filtered); };
  pager.appendChild(prev);
  pager.insertAdjacentHTML('beforeend',
    `<span class="pager-info">Page ${PAGE.idx + 1} / ${pages}</span>`);
  const next = document.createElement('button');
  next.textContent = 'Next ›';
  next.disabled = PAGE.idx >= pages - 1;
  next.onclick = () => { PAGE.idx++; renderTable(filtered); };
  pager.appendChild(next);
}

/* ── Master render ────────────────────────────────────────────── */

function render () {
  renderSidebar();
  renderOldest();
  renderLabels();
  renderFilterBanner();
  const filtered = applyFilters(STATE.issues);
  renderKPIs(filtered);
  renderTypeTiles(filtered);
  renderDetailTiles(filtered);
  // Proof tiles ignore the Status filter (same scope as 7-day tiles)
  // so closed/merged records still feed the proof view.
  renderProofKPIs(applyFilters(STATE.issues, { skipStatus: true }));
  // Charts only relevant on the dashboard view; cheap to compute either way.
  if (ROUTE.current === 'dashboard') {
    renderChartModule(filtered);
    renderChartSurface(filtered);
    renderChartType(filtered);
    renderChartPriorityStack(filtered);
    renderChartTrend();
    renderChartAge(filtered);
    renderChartProofDims(STATE.issues || []);
    renderTable(filtered);
  }
  // Board re-renders too if it's the active view (e.g. after filter change).
  if (ROUTE.current === 'board') renderBoard();
}

/* ── Event wiring ─────────────────────────────────────────────── */

function pillSelect (groupId, btn) {
  document.querySelectorAll(`#${groupId} .pill`).forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
}

function bindFilters () {
  document.getElementById('filterType').addEventListener('click', e => {
    const b = e.target.closest('button.pill'); if (!b) return;
    FILTERS.type = b.dataset.t; pillSelect('filterType', b);
    PAGE.idx = 0; render();
  });
  document.getElementById('filterPriority').addEventListener('click', e => {
    const b = e.target.closest('button.pill'); if (!b) return;
    FILTERS.priority = b.dataset.p; pillSelect('filterPriority', b);
    PAGE.idx = 0; render();
  });
  document.getElementById('filterStatus').addEventListener('click', e => {
    const b = e.target.closest('button.pill'); if (!b) return;
    FILTERS.status = b.dataset.s; pillSelect('filterStatus', b);
    PAGE.idx = 0; render();
  });
  document.getElementById('filterAge').addEventListener('click', e => {
    const b = e.target.closest('button.pill'); if (!b) return;
    FILTERS.age = b.dataset.a; pillSelect('filterAge', b);
    PAGE.idx = 0; render();
  });
  document.getElementById('search').addEventListener('input', e => {
    FILTERS.search = e.target.value; PAGE.idx = 0; render();
  });
  document.getElementById('resetBtn').addEventListener('click', () => {
    Object.assign(FILTERS, { module: null, submodule: null, label: null,
                             kindType: null, type: 'all', priority: 'all',
                             status: 'open', age: 'all', search: '',
                             assignedToMe: false,
                             assigneeAny: false, assigneeNone: false,
                             wipOnly: false });
    document.getElementById('search').value = '';
    const atm = document.getElementById('assignedToMe'); if (atm) atm.checked = false;
    document.querySelectorAll('.pill-group').forEach(g => {
      const first = g.querySelector('.pill'); pillSelect(g.id, first);
    });
    PAGE.idx = 0; render();
  });
  document.querySelectorAll('#issueTable th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (SORT.col === col) SORT.dir = SORT.dir === 'asc' ? 'desc' : 'asc';
      else { SORT.col = col; SORT.dir = 'desc'; }
      render();
    });
  });
  document.getElementById('refreshBtn').addEventListener('click', async () => {
    await loadData(); render();
  });
}

function bindSettings () {
  const panel = document.getElementById('settingsPanel');
  const input = document.getElementById('patInput');
  input.value = getPAT();
  document.getElementById('settingsBtn').addEventListener('click', () => {
    panel.classList.toggle('hidden');
  });
  document.getElementById('patSave').addEventListener('click', async () => {
    setPAT(input.value);
    panel.classList.add('hidden');
    await loadData(); render();
  });
  document.getElementById('patClear').addEventListener('click', async () => {
    setPAT(''); input.value = '';
    panel.classList.add('hidden');
    await loadData(); render();
  });
}

/* ═══════════════════════════════════════════════════════════════
   New GitHub API helpers — milestones, events, commits, assignees,
   current user, issue comments, POST new issue. All reuse the same
   PAT + rate-limit capture path as fetchPage().
   ═══════════════════════════════════════════════════════════════ */

async function ghGet (path, params = {}) {
  const url = new URL(`https://api.github.com${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const tok = getPAT();
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  const r = await fetch(url, { headers });
  STATE.rateLimit = {
    limit:     parseInt(r.headers.get('x-ratelimit-limit')     || '0', 10),
    remaining: parseInt(r.headers.get('x-ratelimit-remaining') || '0', 10),
    reset:     parseInt(r.headers.get('x-ratelimit-reset')     || '0', 10),
    used:      parseInt(r.headers.get('x-ratelimit-used')      || '0', 10),
  };
  updateRateLimitDisplay();
  if (!r.ok) {
    const txt = await r.text();
    const err = new Error(`GH ${r.status}: ${txt.slice(0, 120)}`);
    err.status = r.status; throw err;
  }
  return r.json();
}

async function ghPost (path, body) { return ghBodyRequest('POST', path, body); }
async function ghPatch (path, body) { return ghBodyRequest('PATCH', path, body); }
async function ghBodyRequest (method, path, body) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
  const tok = getPAT();
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  const r = await fetch(`https://api.github.com${path}`, {
    method, headers, body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text();
    const err = new Error(`GH ${r.status}: ${txt.slice(0, 200)}`);
    err.status = r.status; throw err;
  }
  return r.json();
}

const fetchCurrentUser = (tok) => ghGet('/user');
const fetchMilestones  = ()    => ghGet(`/repos/${REPO}/milestones`, { state: 'all', per_page: 100, sort: 'due_on', direction: 'asc' });
const fetchEvents      = ()    => ghGet(`/repos/${REPO}/events`,     { per_page: 50 });
const fetchCommits     = ()    => ghGet(`/repos/${REPO}/commits`,    { per_page: 30 });
const fetchAssignees   = ()    => ghGet(`/repos/${REPO}/assignees`,  { per_page: 100 });
const fetchComments    = (n)   => ghGet(`/repos/${REPO}/issues/${n}/comments`, { per_page: 100 });
const fetchIssueDetail = (n)   => ghGet(`/repos/${REPO}/issues/${n}`);

function createIssue (payload) {
  return ghPost(`/repos/${REPO}/issues`, payload);
}

/* ═══════════════════════════════════════════════════════════════
   Router — hash-based, no library.
   ═══════════════════════════════════════════════════════════════ */

const VIEWS = ['dashboard', 'board', 'sprints', 'new', 'activity', 'commits', 'reports'];

function parseHash () {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const [route, qs] = raw.split('?');
  const params = new URLSearchParams(qs || '');
  return { route: VIEWS.includes(route) ? route : 'dashboard', params };
}

function navigate (route, params) {
  let hash = '#/' + route;
  if (params && Object.keys(params).length) {
    hash += '?' + new URLSearchParams(params).toString();
  }
  if (location.hash !== hash) location.hash = hash;
  else handleRoute();
}

async function handleRoute () {
  const { route, params } = parseHash();
  ROUTE.current = route;

  // Read deep-link filter params (e.g. ?module=brokers&submodule=tiger)
  if (params.has('module'))    FILTERS.module    = params.get('module');
  if (params.has('submodule')) FILTERS.submodule = params.get('submodule');
  if (params.has('label'))     FILTERS.label     = params.get('label');

  // Toggle view containers.
  for (const v of VIEWS) {
    document.getElementById(`view-${v}`)?.classList.toggle('hidden', v !== route);
  }
  // Sidebar active highlight.
  document.querySelectorAll('.view-row').forEach(b => {
    b.classList.toggle('active', b.dataset.route === route);
  });

  render();                     // re-render shared sidebar + filters
  await renderActiveView();
}

async function renderActiveView () {
  switch (ROUTE.current) {
    case 'board':    renderBoard(); break;
    case 'sprints':  await renderSprintsView(); break;
    case 'activity': await renderActivityView(); break;
    case 'commits':  await renderCommitsView(); break;
    case 'reports':  await renderReportsView(); break;
    case 'new':      renderNewIssueForm(); break;
    case 'dashboard':
    default:                       // dashboard renders inside render()
  }
}

/* ═══════════════════════════════════════════════════════════════
   View: Kanban board
   ═══════════════════════════════════════════════════════════════ */

function renderBoard () {
  // Honors PRIORITY / AGE / Module / search filters + the surface
  // filter unique to the Board view. Status filter is intentionally
  // skipped — the four columns ARE the states (Done = closed), so
  // applying the default 'Open' filter would empty the Done column.
  const filtered = applyFilters(STATE.issues, { skipStatus: true }).filter(i =>
    FILTERS.surface === 'all' ? true : i.surface === FILTERS.surface
  );
  const buckets = { todo: [], inprogress: [], inreview: [], done: [] };
  for (const i of filtered) buckets[i.stage]?.push(i);

  for (const col of Object.keys(buckets)) {
    document.getElementById(`boardCount-${col}`).textContent = buckets[col].length;
    const body = document.getElementById(`boardCol-${col}`);
    body.innerHTML = '';
    if (buckets[col].length === 0) {
      body.innerHTML = '<div class="board-empty">Drop here</div>';
      continue;
    }
    for (const i of buckets[col].slice(0, 50)) {   // cap per col for sanity
      body.appendChild(boardCard(i));
    }
    if (buckets[col].length > 50) {
      const more = document.createElement('div');
      more.className = 'board-more muted';
      more.textContent = `+ ${buckets[col].length - 50} more`;
      body.appendChild(more);
    }
  }
}

function boardCard (i) {
  const card = document.createElement('div');
  card.className = 'board-card' + (i.is_pr ? ' is-pr' : '');
  card.draggable = !i.is_pr;          // PRs aren't movable via labels (state managed on GH side)
  card.dataset.issueNumber = i.number;
  const pri = i.priority || 'none';
  const updatedAgo = fmtRelative(i.updated_at);
  const avatarHTML = renderAvatarStack(i.assignees, 2);
  const moduleIcon = STATE.modules.find(m => m.id === i.module)?.icon || '';
  card.innerHTML = `
    <div class="bc-head">
      <span class="t-num">#${i.number}</span>
      ${i.is_pr ? '<span class="t-kind pr">PR</span>' : ''}
      <span class="t-pri ${pri}">${pri}</span>
      <span class="bc-spacer"></span>
      ${avatarHTML}
    </div>
    <div class="bc-title">${escapeHTML(i.title)}</div>
    <div class="bc-foot">
      <span class="bc-mod" style="color:${moduleColor(i.module)}" title="${escapeHTML(moduleLabel(i.module))}">${moduleIcon}</span>
      <span class="muted">updated ${updatedAgo}</span>
    </div>
  `;
  // Drag-to-move support (issues only). PRs left alone.
  if (card.draggable) {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(i.number));
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  }
  // Click body opens drawer; the ↗ link opens GH directly.
  card.onclick = (e) => {
    if (card.classList.contains('dragging')) return;   // ignore residual click after drag
    openDrawer(i.number);
  };
  return card;
}

/* ── Drag-and-drop: stage labels + close on Done ─────────────────
 * Maps the four kanban columns to label / state changes:
 *   todo       → strip in-progress|wip|doing + review|qa|ready-for-review
 *   inprogress → add 'in-progress', strip review labels
 *   inreview   → add 'review',      strip in-progress labels
 *   done       → state=closed (GH auto-closes; labels untouched)
 * Then PATCH /repos/.../issues/N to apply atomically.
 */
const STAGE_LABELS = {
  inprogress: ['in-progress', 'wip', 'doing'],
  inreview:   ['review', 'qa', 'ready-for-review'],
};
const ALL_STAGE_LABELS = [...STAGE_LABELS.inprogress, ...STAGE_LABELS.inreview];

async function moveIssueToStage (num, newStage) {
  const issue = STATE.issues.find(i => i.number === num);
  if (!issue) return;
  if (issue.stage === newStage) return;

  // Build target label set + state.
  const labels = new Set((issue.labels || []).filter(l => !ALL_STAGE_LABELS.includes(l.toLowerCase())));
  let state = 'open';
  if (newStage === 'inprogress') labels.add('in-progress');
  else if (newStage === 'inreview') labels.add('review');
  else if (newStage === 'done')   state = 'closed';
  else /* todo */                  state = 'open';

  // Optimistic UI update — flips immediately while the PATCH flies.
  const prev = { labels: [...issue.labels], state: issue.state, stage: issue.stage };
  issue.labels = Array.from(labels);
  issue.state = state;
  issue.stage = newStage;
  renderBoard();

  try {
    await ghPatch(`/repos/${REPO}/issues/${num}`, {
      labels: Array.from(labels),
      state,
    });
  } catch (e) {
    // Rollback if the API rejects (e.g. PAT missing Issues:Write).
    issue.labels = prev.labels;
    issue.state  = prev.state;
    issue.stage  = prev.stage;
    renderBoard();
    const is403 = e.status === 403;
    showErrorBanner(new Error(
      is403 ? `Kanban move failed: PAT lacks Issues: Write. Update your token in ⚙ Settings.`
            : `Kanban move failed: ${e.message}`
    ));
  }
}

/* ═══════════════════════════════════════════════════════════════
   View: Sprints / milestones
   ═══════════════════════════════════════════════════════════════ */

async function renderSprintsView () {
  const listEl = document.getElementById('sprintsList');
  const backlogEl = document.getElementById('backlogList');
  const backlogCountEl = document.getElementById('backlogCount');

  // Unassigned backlog (always derivable from local STATE.issues —
  // these are issues with milestone=null AND state=open).
  const backlog = applyFilters(STATE.issues).filter(i => !i.milestone && !i.is_pr).slice(0, 12);
  backlogCountEl.textContent = backlog.length ? `(top ${backlog.length})` : '';
  backlogEl.innerHTML = backlog.length
    ? backlog.map(i => `
        <li class="backlog-row" data-num="${i.number}" title="${escapeHTML(i.title)}">
          <span class="o-num">#${i.number}</span>
          <span class="o-title">${escapeHTML(i.title)}</span>
          <span class="t-pri ${i.priority || 'none'}">${i.priority || 'none'}</span>
        </li>`).join('')
    : '<li class="muted" style="padding: var(--space-3)">No unassigned issues.</li>';
  backlogEl.querySelectorAll('.backlog-row').forEach(r => {
    r.onclick = () => openDrawer(parseInt(r.dataset.num, 10));
  });

  // Milestones — lazy fetch on first visit.
  if (STATE.milestones === null) {
    try { STATE.milestones = await fetchMilestones(); }
    catch (e) { listEl.innerHTML = `<div class="error-banner">${escapeHTML(e.message)}</div>`; return; }
  }

  if (!STATE.milestones.length) {
    listEl.innerHTML = `
      <div class="card empty-state">
        <div class="card-body">
          <h3>No milestones yet</h3>
          <p class="muted">Create your first milestone on GitHub to plan a sprint.</p>
          <a class="btn-primary" target="_blank" rel="noopener"
             href="https://github.com/${REPO}/milestones/new">Create on GitHub →</a>
        </div>
      </div>`;
    return;
  }

  listEl.innerHTML = STATE.milestones.map(m => renderMilestoneCard(m)).join('');
}

function renderMilestoneCard (m) {
  const open = m.open_issues || 0;
  const closed = m.closed_issues || 0;
  const total = open + closed;
  const pct = total ? Math.round((closed / total) * 100) : 0;
  const due = m.due_on ? new Date(m.due_on).toLocaleDateString() : '—';
  const stateClass = m.state === 'open' ? 'open' : 'closed';

  // Modules in scope — issues on this milestone, grouped by module.
  const onMilestone = STATE.issues.filter(i => i.milestone?.number === m.number);
  const modCounts = {};
  for (const i of onMilestone) modCounts[i.module] = (modCounts[i.module] || 0) + 1;
  const modChips = Object.entries(modCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => {
      const mm = STATE.modules.find(x => x.id === id);
      return `<span class="ms-chip" style="border-color:${mm?.color || COLOR.dim}">
        ${mm?.icon || ''} ${escapeHTML(mm?.label || id)} <span class="muted">${n}</span></span>`;
    }).join('');

  return `
    <article class="card milestone-card">
      <header class="milestone-head">
        <div>
          <h3 class="milestone-title">${escapeHTML(m.title)}</h3>
          ${m.description ? `<p class="muted small">${escapeHTML(m.description)}</p>` : ''}
        </div>
        <span class="t-state ${stateClass}">${m.state}</span>
      </header>
      <div class="milestone-progress">
        <div class="milestone-bar"><div class="milestone-bar-fill" style="width:${pct}%"></div></div>
        <span class="milestone-pct">${pct}%</span>
      </div>
      <div class="milestone-stats">
        <div><span class="muted">open</span> <span class="big">${open}</span></div>
        <div><span class="muted">closed</span> <span class="big">${closed}</span></div>
        <div><span class="muted">due</span> <span class="big">${due}</span></div>
      </div>
      ${modChips ? `<div class="milestone-mods"><span class="muted small">Modules in scope:</span> ${modChips}</div>` : ''}
      <footer class="milestone-foot">
        <a class="btn-ghost" target="_blank" rel="noopener" href="${m.html_url}">Open in GitHub →</a>
      </footer>
    </article>`;
}

/* ═══════════════════════════════════════════════════════════════
   View: Activity feed
   ═══════════════════════════════════════════════════════════════ */

async function renderActivityView () {
  const list = document.getElementById('activityList');
  if (STATE.events === null) {
    try { STATE.events = await fetchEvents(); }
    catch (e) { list.innerHTML = `<li class="error-banner">${escapeHTML(e.message)}</li>`; return; }
  }
  if (!STATE.events.length) {
    list.innerHTML = '<li class="muted" style="padding: var(--space-4)">No recent activity.</li>';
    return;
  }
  list.innerHTML = STATE.events.map(renderEventRow).join('');
}

function renderEventRow (e) {
  const actor = e.actor?.login || '—';
  const avatar = e.actor?.avatar_url || '';
  const when = fmtRelative(e.created_at);
  const p = e.payload || {};
  let icon = '·', tone = 'neutral', text = e.type, link = `https://github.com/${REPO}`;

  switch (e.type) {
    case 'IssuesEvent':
      icon = '⚪'; tone = 'blue';
      text = `${p.action} issue #${p.issue?.number}: ${p.issue?.title || ''}`;
      link = p.issue?.html_url || link;
      break;
    case 'IssueCommentEvent':
      icon = '💬'; tone = 'cyan';
      text = `commented on #${p.issue?.number}: ${(p.comment?.body || '').slice(0, 120)}`;
      link = p.comment?.html_url || link;
      break;
    case 'PullRequestEvent':
      icon = '🔀'; tone = 'purple';
      text = `${p.action} PR #${p.pull_request?.number}: ${p.pull_request?.title || ''}`;
      link = p.pull_request?.html_url || link;
      break;
    case 'PullRequestReviewCommentEvent':
      icon = '📝'; tone = 'purple';
      text = `review comment on PR #${p.pull_request?.number}: ${(p.comment?.body || '').slice(0, 120)}`;
      link = p.comment?.html_url || link;
      break;
    case 'PushEvent': {
      icon = '⬆'; tone = 'accent';
      const branch = (p.ref || '').replace('refs/heads/', '');
      const n = (p.commits || []).length;
      text = `pushed ${n} commit${n === 1 ? '' : 's'} to ${branch}`;
      const first = p.commits?.[0];
      link = first ? `https://github.com/${REPO}/commit/${first.sha}` : link;
      break;
    }
    case 'CreateEvent':
      icon = '🌱'; tone = 'accent';
      text = `created ${p.ref_type} ${p.ref || ''}`;
      link = `https://github.com/${REPO}/${p.ref_type === 'branch' ? 'tree' : ''}/${p.ref || ''}`;
      break;
    case 'DeleteEvent':
      icon = '🗑'; tone = 'loss';
      text = `deleted ${p.ref_type} ${p.ref || ''}`; break;
    case 'WatchEvent':
      icon = '⭐'; tone = 'alert';
      text = `starred the repo`; break;
    case 'ForkEvent':
      icon = '🍴'; tone = 'cyan';
      text = `forked the repo`; break;
  }
  return `
    <li class="activity-row tone-${tone}">
      <span class="activity-icon">${icon}</span>
      ${avatar ? `<img class="avatar sm" src="${avatar}&s=40" alt="">` : ''}
      <span class="activity-actor">${escapeHTML(actor)}</span>
      <a class="activity-text" target="_blank" rel="noopener" href="${link}">${escapeHTML(text)}</a>
      <span class="muted activity-when">${when}</span>
    </li>`;
}

/* ═══════════════════════════════════════════════════════════════
   View: Commits feed
   ═══════════════════════════════════════════════════════════════ */

async function renderCommitsView () {
  const list = document.getElementById('commitsList');
  if (STATE.commits === null) {
    try { STATE.commits = await fetchCommits(); }
    catch (e) { list.innerHTML = `<li class="error-banner">${escapeHTML(e.message)}</li>`; return; }
  }
  if (!STATE.commits.length) {
    list.innerHTML = '<li class="muted" style="padding: var(--space-4)">No commits.</li>';
    return;
  }
  list.innerHTML = STATE.commits.map(c => {
    const sha = (c.sha || '').slice(0, 7);
    const author = c.author?.login || c.commit?.author?.name || '—';
    const avatar = c.author?.avatar_url || '';
    const date = c.commit?.author?.date || c.commit?.committer?.date;
    const msgFirst = (c.commit?.message || '').split('\n')[0];
    // Auto-link "#123" → clickable chip
    const linked = escapeHTML(msgFirst).replace(/#(\d+)/g, (m, n) =>
      `<a class="issue-chip" target="_blank" rel="noopener" href="https://github.com/${REPO}/issues/${n}">#${n}</a>`);
    return `
      <li class="commit-row">
        ${avatar ? `<img class="avatar sm" src="${avatar}&s=40" alt="">` : '<span class="avatar sm placeholder"></span>'}
        <a class="commit-msg" target="_blank" rel="noopener" href="${c.html_url}">${linked}</a>
        <span class="sha-badge"><code>${sha}</code></span>
        <span class="muted commit-author">${escapeHTML(author)}</span>
        <span class="muted commit-when">${fmtRelative(date)}</span>
      </li>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════════════
   View: Reports — pulls CI-emitted JSON from 0dte-v2/reports/ so the
   dashboard becomes the single pane for "what's working / what's
   broken / what's left to develop." Schemas live in
   ayanjava/0dte-v2:reports/README.md.
   ═══════════════════════════════════════════════════════════════ */

// 0dte-v2 is private, so raw.githubusercontent.com 404s without auth.
// Use the GitHub Contents API with `Accept: application/vnd.github.raw`
// which returns the file body directly and respects the PAT the user
// already pasted into the ⚙ Settings panel.
const REPORT_API_BASE  = `https://api.github.com/repos/${REPO}/contents/reports`;
const REPORT_HUMAN_BASE = `https://github.com/${REPO}/blob/main/reports`;

const REPORT_FILES = [
  { key: 'progress',     name: 'progress.json',     desc: 'Issue counts + 5-proof status per module',
    rebuild: 'python deploy/labels/build_progress_report.py > reports/progress.json' },
  { key: 'tests',        name: 'test-summary.json', desc: 'pytest --json-report output',
    rebuild: 'python -m pytest tests/ --json-report --json-report-file=reports/test-summary.json' },
  { key: 'sonar',        name: 'sonar-summary.json',desc: 'SonarQube quality-gate + metrics',
    rebuild: 'sonar-scanner && python deploy/reports/build_sonar_summary.py > reports/sonar-summary.json' },
  { key: 'coverage',     name: 'coverage.json',     desc: 'coverage.py per-package line coverage',
    rebuild: 'coverage run --source=app,src -m pytest && coverage json -o reports/coverage.json' },
  { key: 'buildStatus',  name: 'build-status.json', desc: 'pre-commit + GH-actions check results',
    rebuild: 'python deploy/labels/build_build_status.py > reports/build-status.json' },
];

// Returns one of: 'live', 'placeholder', 'stale', 'missing'.
// "Placeholder" = file exists but the meaningful fields are null (we
// committed schema-only seeds so the dashboard can render the layout
// before CI wires the real numbers). "Stale" = generated_at is older
// than 24h. Used to colour the source rows.
function reportTrust (key, slot, err) {
  if (err) return 'missing';
  const data = slot?.data;
  if (!data) return 'missing';
  if (data.source === 'manual-seed') return 'placeholder';
  // Per-file "is this real?" heuristic.
  const realByKey = {
    progress:    () => data.totals?.open != null && data.totals?.closed != null,
    tests:       () => (data.summary?.passed ?? null) !== null,
    sonar:       () => data.metrics?.lines_of_code != null,
    coverage:    () => data.overall_pct != null,
    buildStatus: () => {
      const checks = Object.values(data.checks || {});
      return checks.some(c => c.status && c.status !== 'unknown');
    },
  };
  if (!(realByKey[key]?.() ?? true)) return 'placeholder';
  if (data.generated_at) {
    const t = new Date(data.generated_at).getTime();
    if (!Number.isNaN(t) && Date.now() - t > 24 * 3600 * 1000) return 'stale';
  }
  return 'live';
}

async function fetchReports () {
  const out = {};
  const errs = {};
  const token = getPAT();
  await Promise.all(REPORT_FILES.map(async f => {
    try {
      const headers = {
        'Accept': 'application/vnd.github.raw',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const r = await fetch(`${REPORT_API_BASE}/${f.name}?ref=main`, { headers });
      if (!r.ok) {
        errs[f.key] = `HTTP ${r.status}` +
          (r.status === 404 && !token ? ' — paste a PAT in ⚙ Settings (repo is private)' : '');
        return;
      }
      out[f.key] = { fetched_at: new Date().toISOString(), data: await r.json() };
    } catch (e) { errs[f.key] = e.message; }
  }));
  return { reports: out, errors: errs };
}

async function renderReportsView () {
  const sourcesList = document.getElementById('rptSourcesList');
  if (!STATE.reports) {
    sourcesList.innerHTML = '<li class="muted">Fetching reports…</li>';
    STATE.reports = await fetchReports();
  }
  renderReportsKPIs(STATE.reports);
  renderReportsCharts(STATE.reports);
  renderReportsSonarRatings(STATE.reports);
  renderReportsBuildChecks(STATE.reports);
  renderReportsTopNeeds(STATE.reports);
  renderReportsSources(STATE.reports);
  renderReportsFailing(STATE.reports);
  renderReportsModuleTable(STATE.reports);
}

function renderReportsKPIs ({ reports }) {
  const prog = reports.progress?.data;
  const tests = reports.tests?.data;
  const sonar = reports.sonar?.data;
  const cov   = reports.coverage?.data;

  document.getElementById('rptOverallPct').textContent =
    prog?.totals?.done_pct != null ? prog.totals.done_pct + '%' : '—';
  // Tests tile prefers run pass-rate; falls back to collection count
  // (real number from `pytest --collect-only`) so users see scale
  // even before CI runs a full suite. Final fallback: em-dash.
  const testEl = document.getElementById('rptTestPct');
  if (tests?.summary?.pass_rate != null) {
    testEl.textContent = tests.summary.pass_rate + '%';
  } else if (tests?.summary?.passed != null && tests?.summary?.total) {
    testEl.textContent = Math.round(tests.summary.passed / tests.summary.total * 100) + '%';
  } else if (tests?.collection?.tests_collected) {
    testEl.textContent = tests.collection.tests_collected.toLocaleString();
    testEl.title = `${tests.collection.tests_collected.toLocaleString()} tests collected by pytest (no run results yet). ${tests.collection.collection_errors || 0} collection errors.`;
  } else {
    testEl.textContent = '—';
  }
  document.getElementById('rptCoveragePct').textContent =
    cov?.overall_pct != null ? cov.overall_pct + '%' : '—';
  // Quality-gate tile: if sonar has a web_url, render it as a link
  // out to the actual SonarQube dashboard. Otherwise show the bare
  // gate name (PASSED / FAILED / PENDING).
  const qgEl = document.getElementById('rptQualityGate');
  const qg = sonar?.quality_gate || '—';
  if (sonar?.web_url) {
    qgEl.innerHTML = `<a href="${escapeHTML(sonar.web_url)}" target="_blank" rel="noopener">${escapeHTML(qg)} ↗</a>`;
  } else {
    qgEl.textContent = qg;
  }
  document.getElementById('rptProvedPct').textContent =
    prog?.totals?.proved_pct != null ? prog.totals.proved_pct + '%' : '—';

  const latest = Object.values(reports)
    .map(r => r?.data?.generated_at).filter(Boolean).sort().pop();
  document.getElementById('rptUpdated').textContent =
    latest ? fmtRelative(latest) : '—';
}

function renderReportsCharts ({ reports }) {
  // Module progress — replaced the absolute-count stacked bar (which
  // squashed everything except Backend Core into invisible slivers)
  // with a sorted 100%-stacked progress chart: every module is the
  // same width, the green portion is its done %, the amber portion
  // is its remaining open work. Sorted by done % so the modules that
  // need the most attention sit at the bottom.
  const prog = reports.progress?.data;
  if (prog?.by_module) {
    const mods = Object.entries(prog.by_module)
      .filter(([id, m]) => id !== 'uncategorized' && (m.open + m.closed) > 0)
      .sort((a, b) => (b[1].done_pct || 0) - (a[1].done_pct || 0));
    const labels = mods.map(([, m]) => m.label || '');
    const donePct   = mods.map(([, m]) => m.done_pct ?? 0);
    const openPct   = mods.map(([, m]) => +(100 - (m.done_pct ?? 0)).toFixed(1));
    const totals    = mods.map(([, m]) => (m.open || 0) + (m.closed || 0));
    chartDestroy('rptModuleProgress');
    // Give every module ~32px so the y-axis labels never overlap (the
    // default 220px wrap squashed 16 modules into 13px each).
    sizeChartWrap('rptModuleProgress', mods.length, 32);
    CHARTS.rptModuleProgress = new Chart(
      document.getElementById('rptModuleProgress'),
      {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: 'Done', data: donePct, backgroundColor: COLOR.accent,
              meta_counts: mods.map(([, m]) => m.closed) },
            { label: 'Open', data: openPct, backgroundColor: COLOR.alert,
              meta_counts: mods.map(([, m]) => m.open) },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false, indexAxis: 'y',
          scales: {
            x: { stacked: true, min: 0, max: 100,
                 ticks: { color: COLOR.text, callback: v => v + '%' },
                 grid: { color: COLOR.grid } },
            y: { stacked: true,
                 ticks: { color: COLOR.text, autoSkip: false, font: { size: 11 } },
                 grid: { display: false } },
          },
          plugins: {
            legend: { position: 'bottom',
                      labels: { color: COLOR.text, font: { size: 11 } } },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const idx = ctx.dataIndex;
                  const ds  = ctx.dataset;
                  const count = ds.meta_counts[idx];
                  return ` ${ds.label}: ${count} (${ctx.parsed.x}% of ${totals[idx]})`;
                },
              },
            },
          },
        },
      });
  }

  // 5-proof state by module — stacked bar showing proved / partial /
  // needs_proof. Same module ordering as the Module progress chart
  // so eyeballs can correlate the two.
  if (prog?.by_module) {
    const mods = Object.entries(prog.by_module)
      .filter(([id, m]) => id !== 'uncategorized' && (m.open + m.closed) > 0)
      .sort((a, b) => (b[1].needs_proof || 0) - (a[1].needs_proof || 0));
    chartDestroy('rptProofByModule');
    sizeChartWrap('rptProofByModule', mods.length, 32);
    CHARTS.rptProofByModule = new Chart(
      document.getElementById('rptProofByModule'),
      {
        type: 'bar',
        data: {
          labels: mods.map(([, m]) => m.label || ''),
          datasets: [
            { label: 'Proved',      data: mods.map(([, m]) => m.proved      || 0), backgroundColor: COLOR.accent },
            { label: 'Partial',     data: mods.map(([, m]) => m.partial     || 0), backgroundColor: COLOR.alert  },
            { label: 'Needs proof', data: mods.map(([, m]) => m.needs_proof || 0), backgroundColor: COLOR.loss   },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false, indexAxis: 'y',
          scales: {
            x: { stacked: true, ticks: { color: COLOR.text }, grid: { color: COLOR.grid } },
            y: { stacked: true, ticks: { color: COLOR.text, autoSkip: false, font: { size: 11 } }, grid: { display: false } },
          },
          plugins: { legend: { position: 'bottom', labels: { color: COLOR.text, font: { size: 11 } } } },
        },
      });
  }

  // Priority breakdown by module — open P0/P1/P2 counts. Sorted by
  // P0 desc so the highest-severity backlog sits at top.
  if (prog?.by_module) {
    const mods = Object.entries(prog.by_module)
      .filter(([id, m]) => id !== 'uncategorized'
                            && ((m.p0_open || 0) + (m.p1_open || 0) + (m.p2_open || 0)) > 0)
      .sort((a, b) => ((b[1].p0_open||0)*100 + (b[1].p1_open||0)*10 + (b[1].p2_open||0))
                     - ((a[1].p0_open||0)*100 + (a[1].p1_open||0)*10 + (a[1].p2_open||0)));
    chartDestroy('rptPriorityByModule');
    if (mods.length) {
      sizeChartWrap('rptPriorityByModule', mods.length, 32);
      CHARTS.rptPriorityByModule = new Chart(
        document.getElementById('rptPriorityByModule'),
        {
          type: 'bar',
          data: {
            labels: mods.map(([, m]) => m.label || ''),
            datasets: [
              { label: 'P0', data: mods.map(([, m]) => m.p0_open || 0), backgroundColor: COLOR.loss  },
              { label: 'P1', data: mods.map(([, m]) => m.p1_open || 0), backgroundColor: COLOR.alert },
              { label: 'P2', data: mods.map(([, m]) => m.p2_open || 0), backgroundColor: COLOR.blue  },
            ],
          },
          options: {
            responsive: true, maintainAspectRatio: false, indexAxis: 'y',
            scales: {
              x: { stacked: true, ticks: { color: COLOR.text, precision: 0 }, grid: { color: COLOR.grid } },
              y: { stacked: true, ticks: { color: COLOR.text, autoSkip: false, font: { size: 11 } }, grid: { display: false } },
            },
            plugins: { legend: { position: 'bottom', labels: { color: COLOR.text, font: { size: 11 } } } },
          },
        });
    } else {
      chartEmpty('rptPriorityByModule', 'No open priority-tagged work — all P0/P1/P2 are closed.');
    }
  }

  // Coverage by package (top 10 by LOC)
  const cov = reports.coverage?.data;
  const byPkg = cov?.by_package ? Object.entries(cov.by_package) : [];
  if (byPkg.length) {
    const top = byPkg
      .map(([k, v]) => [k, v])
      .sort((a, b) => (b[1].lines || 0) - (a[1].lines || 0))
      .slice(0, 10);
    chartDestroy('rptCoverageByModule');
    CHARTS.rptCoverageByModule = new Chart(
      document.getElementById('rptCoverageByModule'),
      {
        type: 'bar',
        data: {
          labels: top.map(([k]) => k),
          datasets: [{ label: 'Coverage %', data: top.map(([, v]) => v.pct ?? 0),
                       backgroundColor: COLOR.blue }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, indexAxis: 'y',
          scales: {
            x: { min: 0, max: 100, ticks: { color: COLOR.text }, grid: { color: COLOR.grid } },
            y: { ticks: { color: COLOR.text }, grid: { display: false } },
          },
          plugins: { legend: { display: false } },
        },
      });
  } else {
    chartEmpty('rptCoverageByModule', 'No coverage.json data yet — wire `coverage json -o reports/coverage.json` into CI.');
  }

  // Test breakdown — only render if at least one bucket has a real
  // (non-null, > 0) count. The placeholder test-summary.json carries
  // total:948 but every bucket is null, which previously drew an
  // empty doughnut with just the legend visible.
  const t = reports.tests?.data?.summary;
  const tHasData = t && (
    (t.passed > 0) || (t.failed > 0) || (t.skipped > 0) ||
    (t.error > 0) || (t.xfail > 0)
  );
  if (tHasData) {
    chartDestroy('rptTestBreakdown');
    CHARTS.rptTestBreakdown = new Chart(
      document.getElementById('rptTestBreakdown'),
      {
        type: 'doughnut',
        data: {
          labels: ['Passed', 'Failed', 'Skipped', 'Error', 'xfail'],
          datasets: [{
            data: [t.passed||0, t.failed||0, t.skipped||0, t.error||0, t.xfail||0],
            backgroundColor: [COLOR.accent, COLOR.loss, COLOR.dim, COLOR.alert, COLOR.purple],
            borderColor: COLOR.bg, borderWidth: 2,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'right', labels: { color: COLOR.text, font: { size: 11 } } } },
        },
      });
  } else {
    chartEmpty('rptTestBreakdown',
      'No test-summary.json data yet. Run locally:\n' +
      '`python -m pytest tests/ --json-report --json-report-file=reports/test-summary.json`\n' +
      'then commit reports/test-summary.json to the 0dte-v2 main branch.');
  }

  // Sonar findings
  const sm = reports.sonar?.data?.metrics;
  if (sm && (sm.bugs != null || sm.code_smells != null)) {
    chartDestroy('rptSonarFindings');
    CHARTS.rptSonarFindings = new Chart(
      document.getElementById('rptSonarFindings'),
      {
        type: 'bar',
        data: {
          labels: ['Bugs', 'Code smells', 'Vulnerabilities', 'Security hotspots'],
          datasets: [{
            data: [sm.bugs||0, sm.code_smells||0, sm.vulnerabilities||0, sm.security_hotspots||0],
            backgroundColor: [COLOR.loss, COLOR.alert, COLOR.purple, COLOR.brand],
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, indexAxis: 'y',
          scales: {
            x: { beginAtZero: true, ticks: { color: COLOR.text }, grid: { color: COLOR.grid } },
            y: { ticks: { color: COLOR.text }, grid: { display: false } },
          },
          plugins: { legend: { display: false } },
        },
      });
  } else {
    chartEmpty('rptSonarFindings', 'No sonar-summary.json data yet — export `/api/measures/component?metricKeys=…` and dump to reports/sonar-summary.json.');
  }
}

function renderReportsSonarRatings ({ reports }) {
  const root = document.getElementById('rptSonarRatings');
  const sub  = document.getElementById('rptSonarSubhead');
  if (!root) return;
  const sonar = reports.sonar?.data;
  if (!sonar || sonar.source === 'manual-seed' || !sonar.ratings) {
    root.innerHTML = '<div class="chart-empty muted">No sonar-summary.json data yet. Run `sonar-scanner` locally and dump the API response to reports/sonar-summary.json.</div>';
    sub.textContent = '';
    return;
  }
  const ratings = sonar.ratings || {};
  const m = sonar.metrics || {};
  const chip = (axis, val) => {
    const v = (val || '?').toString().toUpperCase();
    return `<div class="sonar-rating-chip rating-${v.toLowerCase()}">
      <div class="sr-axis">${escapeHTML(axis)}</div>
      <div class="sr-grade">${escapeHTML(v)}</div>
    </div>`;
  };
  const kpi = (label, val, suffix = '') =>
    `<div class="sonar-kpi"><div class="k-label">${label}</div><div class="k-val">${val == null ? '—' : escapeHTML(String(val)) + suffix}</div></div>`;
  root.innerHTML = `
    <div class="sonar-grid">
      ${chip('Reliability',     ratings.reliability)}
      ${chip('Security',        ratings.security)}
      ${chip('Maintainability', ratings.maintainability)}
      ${kpi('Coverage',     m.coverage_pct,       '%')}
      ${kpi('Duplications', m.duplications_pct,   '%')}
      ${kpi('Tech debt',    m.tech_debt_min != null ? Math.round(m.tech_debt_min / 60) : null, ' h')}
      ${kpi('Lines of code', m.lines_of_code)}
    </div>
  `;
  sub.textContent = sonar.web_url ? '' : '(quality_gate = ' + (sonar.quality_gate || '?') + ')';
}

function renderReportsBuildChecks ({ reports }) {
  const tbody = document.getElementById('rptBuildTbody');
  const sub = document.getElementById('rptBuildSubhead');
  if (!tbody) return;
  const data = reports.buildStatus?.data;
  if (!data?.checks) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted" style="padding:var(--space-3)">No build-status.json data.</td></tr>';
    sub.textContent = '';
    return;
  }
  const rows = Object.entries(data.checks).map(([name, c]) => {
    const status = (c.status || 'unknown').toLowerCase();
    const icon = ({
      passed:  '✅', success: '✅', ok: '✅',
      failed:  '❌', failure: '❌', error: '❌',
      skipped: '⏭️',
      unknown: '❓', pending: '⏳', running: '⏳',
    })[status] || '❓';
    const link = c.url
      ? `<a href="${escapeHTML(c.url)}" target="_blank" rel="noopener">log ↗</a>`
      : '<span class="muted">—</span>';
    const dur = c.duration_sec != null ? `${c.duration_sec}s` : '—';
    return `<tr class="build-row build-${status}">
      <td><code class="check-name">${escapeHTML(name)}</code></td>
      <td class="num"><span class="build-status">${icon} ${escapeHTML(status)}</span></td>
      <td class="num">${dur}</td>
      <td>${link}</td>
    </tr>`;
  }).join('');
  tbody.innerHTML = rows;
  const counts = Object.values(data.checks).reduce((acc, c) => {
    const s = (c.status || 'unknown').toLowerCase();
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});
  sub.textContent = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' · ')
    + ` · commit ${(data.commit || '').slice(0, 7)}`;
}

function renderReportsTopNeeds ({ reports }) {
  const tbody = document.getElementById('rptTopNeedsTbody');
  if (!tbody) return;
  const prog = reports.progress?.data?.by_module || {};
  const cov  = reports.coverage?.data?.by_package || {};
  const rows = Object.entries(prog)
    .filter(([id, m]) => id !== 'uncategorized' && (m.needs_proof || 0) > 0)
    .sort((a, b) => (b[1].needs_proof || 0) - (a[1].needs_proof || 0))
    .slice(0, 10)
    .map(([id, m]) => {
      const c = Object.entries(cov).find(([k]) => k.includes(id)) || [null, {}];
      const covPct = c[1].pct != null ? c[1].pct + '%' : '—';
      return `<tr data-mod="${id}">
        <td><span class="t-mod" style="color:${moduleColor(id)}">${escapeHTML(m.label || id)}</span></td>
        <td class="num">${m.open ?? '—'}</td>
        <td class="num">${m.closed ?? '—'}</td>
        <td class="num"><span class="trust missing">${m.needs_proof}</span></td>
        <td class="num">${covPct}</td>
      </tr>`;
    }).join('');
  tbody.innerHTML = rows ||
    '<tr><td colspan="5" class="muted" style="padding:var(--space-3)">Every module is fully proved 🎉</td></tr>';
  tbody.querySelectorAll('tr[data-mod]').forEach(tr => {
    tr.addEventListener('click', () => {
      FILTERS.module = tr.dataset.mod;
      FILTERS.submodule = null;
      FILTERS.proof = 'needs';
      navigate('dashboard');
    });
  });
}

function chartEmpty (canvasId, msg) {
  chartDestroy(canvasId);
  const c = document.getElementById(canvasId);
  if (!c) return;
  const wrap = c.parentElement;
  wrap.innerHTML = `<div class="chart-empty muted">${escapeHTML(msg)}</div>`;
}

// Resize a chart's wrap so labels don't crowd. min keeps the panel
// from collapsing on tiny datasets; perItem (px) is the per-row
// vertical budget for horizontal bar charts.
function sizeChartWrap (canvasId, count, perItem = 32, min = 220) {
  const c = document.getElementById(canvasId);
  if (!c) return;
  const wrap = c.parentElement;
  wrap.style.height = Math.max(min, count * perItem + 60) + 'px';
}

function renderReportsSources ({ reports, errors }) {
  const list = document.getElementById('rptSourcesList');
  list.innerHTML = REPORT_FILES.map(f => {
    const slot = reports[f.key];
    const err  = errors[f.key];
    const trust = reportTrust(f.key, slot, err);
    const trustBadge = ({
      live:        '<span class="trust live">● LIVE</span>',
      placeholder: '<span class="trust placeholder">◐ PLACEHOLDER</span>',
      stale:       '<span class="trust stale">⚠ STALE</span>',
      missing:     `<span class="trust missing">✗ MISSING${err ? ` (${escapeHTML(err)})` : ''}</span>`,
    })[trust];
    const when = slot?.data?.generated_at ? fmtRelative(slot.data.generated_at) : '—';
    const commit = slot?.data?.commit
      ? `<code class="rs-commit" title="Report generated against this commit">${escapeHTML(slot.data.commit.slice(0, 7))}</code>`
      : '';
    const url = `${REPORT_HUMAN_BASE}/${f.name}`;
    const rebuild = f.rebuild
      ? `<button class="rs-copy btn-ghost" data-cmd="${escapeHTML(f.rebuild)}" title="Copy local rebuild command">📋 rebuild cmd</button>`
      : '';
    return `<li class="report-source-row trust-${trust}">
      <span class="rs-name"><a target="_blank" rel="noopener" href="${url}">${f.name}</a> ${commit}</span>
      <span class="rs-desc muted">${escapeHTML(f.desc)}</span>
      <span class="rs-status">${trustBadge}</span>
      <span class="rs-when muted">${when}</span>
      <span class="rs-action">${rebuild}</span>
    </li>`;
  }).join('');
  list.querySelectorAll('.rs-copy').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cmd = btn.dataset.cmd;
      try {
        await navigator.clipboard.writeText(cmd);
        const old = btn.textContent;
        btn.textContent = '✓ copied';
        setTimeout(() => { btn.textContent = old; }, 1200);
      } catch { /* user can copy manually */ }
    });
  });
  // The fetcher uses GitHub Contents API (Accept: application/vnd.github.raw)
  // because raw.githubusercontent.com requires anonymous read which is
  // refused for private repos. The note must match what the code does.
  document.getElementById('rptSourcesNote').textContent =
    `live from api.github.com/repos/${REPO}/contents/reports/ — private repo, needs PAT in ⚙ Settings`;
}

function renderReportsFailing ({ reports }) {
  const list = document.getElementById('rptFailingList');
  const fail = reports.tests?.data?.failures || [];
  if (!fail.length) {
    list.innerHTML = '<li class="muted">No failing tests in latest run.</li>';
    document.getElementById('rptFailingNote').textContent = '';
    return;
  }
  list.innerHTML = fail.slice(0, 50).map(f => `
    <li class="report-failure-row">
      <code class="rf-test">${escapeHTML(f.test || '?')}</code>
      <span class="muted rf-mod">${escapeHTML(f.module || '')}</span>
      <pre class="rf-error">${escapeHTML((f.error || '').slice(0, 600))}</pre>
    </li>`).join('');
  document.getElementById('rptFailingNote').textContent =
    `${fail.length} failure${fail.length === 1 ? '' : 's'}`;
}

function renderReportsModuleTable ({ reports }) {
  const tbody = document.getElementById('rptModuleTbody');
  const prog = reports.progress?.data?.by_module || {};
  const tests = reports.tests?.data?.by_module || {};
  const cov   = reports.coverage?.data?.by_package || {};

  // Match the dashboard's module ordering (taxonomy-driven).
  const rows = STATE.modules
    .filter(m => m.id !== 'uncategorized')
    .map(m => {
      const p = prog[m.id] || {};
      const t = tests[m.id] || {};
      // Coverage by_package keys are file paths — match by id prefix.
      const c = Object.entries(cov).find(([k]) => k.includes(m.id)) || [null, {}];
      const testPct = t.total
        ? Math.round(((t.passed || 0) / t.total) * 100) + '%' : '—';
      const covPct  = c[1].pct != null ? c[1].pct + '%' : '—';
      return `<tr data-mod="${m.id}">
        <td><span class="t-mod" style="color:${moduleColor(m.id)}">${escapeHTML(m.label)}</span></td>
        <td class="num">${p.open ?? '—'}</td>
        <td class="num">${p.closed ?? '—'}</td>
        <td class="num">${p.done_pct != null ? p.done_pct + '%' : '—'}</td>
        <td class="num">${testPct}</td>
        <td class="num">${covPct}</td>
        <td class="num">${p.needs_proof ?? '—'}</td>
      </tr>`;
    }).join('');
  tbody.innerHTML = rows;
  tbody.querySelectorAll('tr[data-mod]').forEach(tr => {
    tr.addEventListener('click', () => {
      FILTERS.module = tr.dataset.mod;
      FILTERS.submodule = null;
      navigate('dashboard');
    });
  });
}

function bindReportsRefresh () {
  document.getElementById('rptRefreshBtn')?.addEventListener('click', async () => {
    STATE.reports = null;
    await renderReportsView();
  });
  // Click-to-copy on every `data-copy="..."` code block in the
  // "How to run" panel. The user can drop the command straight into
  // their 0dte-v2 shell.
  document.querySelectorAll('.how-to-run code[data-copy]').forEach(code => {
    code.style.cursor = 'pointer';
    code.title = 'Click to copy';
    code.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.dataset.copy);
        const old = code.textContent;
        code.textContent = '✓ copied to clipboard';
        setTimeout(() => { code.textContent = old; }, 1200);
      } catch { /* clipboard blocked — user can copy manually */ }
    });
  });
}

/* ═══════════════════════════════════════════════════════════════
   View: New issue form
   ═══════════════════════════════════════════════════════════════ */

const NI_STATE = {
  surface: 'ui', type: 'bug', priority: 'p1',
  module: '',           // taxonomy module id, e.g. 'frontend'
  submodule: '',        // taxonomy submodule id, e.g. 'ui-v2'
  assignees: new Set(),
};

async function renderNewIssueForm () {
  // Reset success state on every view entry.
  document.getElementById('newIssueForm').classList.remove('hidden');
  document.getElementById('newSuccess').classList.add('hidden');

  // Populate Module dropdown from taxonomy.
  const modSel = document.getElementById('niModuleSelect');
  if (modSel.options.length <= 1 && STATE.taxonomy) {
    for (const m of STATE.taxonomy.modules) {
      if (m.id === 'uncategorized') continue;
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.icon || ''} ${m.label}`.trim();
      modSel.appendChild(opt);
    }
  }
  // If a module was already selected, keep its submodule list populated.
  populateSubmoduleSelect(NI_STATE.module);

  // Lazy-load assignee suggestions.
  const aBox = document.getElementById('niAssignees');
  if (STATE.assignees === null) {
    try { STATE.assignees = await fetchAssignees(); }
    catch (e) { aBox.innerHTML = `<span class="muted small">Couldn't load assignees: ${escapeHTML(e.message)}</span>`; STATE.assignees = []; }
  }
  if (STATE.assignees.length) {
    aBox.innerHTML = STATE.assignees.map(a => `
      <button class="pill assignee-pill ${NI_STATE.assignees.has(a.login) ? 'active' : ''}" data-login="${escapeHTML(a.login)}">
        <img class="avatar xs" src="${a.avatar_url}&s=24" alt="">
        ${escapeHTML(a.login)}
      </button>`).join('');
    aBox.querySelectorAll('.assignee-pill').forEach(b => {
      b.onclick = () => {
        const log = b.dataset.login;
        if (NI_STATE.assignees.has(log)) NI_STATE.assignees.delete(log);
        else NI_STATE.assignees.add(log);
        b.classList.toggle('active');
        refreshNiPreview();
      };
    });
  } else if (!aBox.innerHTML) {
    aBox.innerHTML = '<span class="muted small">No assignees available.</span>';
  }

  refreshNiPreview();
}

function composeNiLabels () {
  const labels = [];
  if (NI_STATE.surface === 'both') labels.push('ui', 'backend');
  else if (NI_STATE.surface)       labels.push(NI_STATE.surface);
  labels.push(NI_STATE.type);
  labels.push(NI_STATE.priority);
  // Module + submodule auto-tags. The classifier short-circuits on
  // these (see classifyOne) so the new issue immediately lands in
  // the right sidebar bucket without taxonomy rule edits.
  if (NI_STATE.module)    labels.push(`module:${NI_STATE.module}`);
  if (NI_STATE.submodule) labels.push(`submodule:${NI_STATE.submodule}`);
  return labels;
}

function refreshNiPreview () {
  const labels = composeNiLabels();
  document.getElementById('niPreview').innerHTML = labels.map(l =>
    `<span class="t-kind issue">${escapeHTML(l)}</span>`).join(' ');
}

function populateSubmoduleSelect (moduleId) {
  const sel = document.getElementById('niSubmoduleSelect');
  sel.innerHTML = '<option value="">— pick a submodule —</option>';
  if (!moduleId || !STATE.taxonomy) {
    sel.disabled = true;
    return;
  }
  const mod = STATE.taxonomy.modules.find(m => m.id === moduleId);
  if (!mod || !mod.submodules?.length) {
    sel.disabled = true;
    return;
  }
  for (const s of mod.submodules) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.label;
    if (s.id === NI_STATE.submodule) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.disabled = false;
}

function bindNewIssueForm () {
  const wire = (groupId, key) => {
    document.getElementById(groupId).addEventListener('click', e => {
      const b = e.target.closest('.pill'); if (!b) return;
      NI_STATE[key] = b.dataset.v;
      document.querySelectorAll(`#${groupId} .pill`).forEach(p => p.classList.remove('active'));
      b.classList.add('active');
      refreshNiPreview();
    });
  };
  wire('niSurface', 'surface');
  wire('niType', 'type');
  wire('niPriority', 'priority');
  document.getElementById('niModuleSelect').addEventListener('change', e => {
    NI_STATE.module = e.target.value;
    NI_STATE.submodule = '';        // reset cascade
    populateSubmoduleSelect(NI_STATE.module);
    refreshNiPreview();
  });
  document.getElementById('niSubmoduleSelect').addEventListener('change', e => {
    NI_STATE.submodule = e.target.value;
    refreshNiPreview();
  });
  document.getElementById('niCreate').addEventListener('click', async () => {
    const title = document.getElementById('niTitle').value.trim();
    const body  = document.getElementById('niBody').value;
    const statusEl = document.getElementById('niStatus');
    if (!title) { statusEl.textContent = 'Title required.'; return; }
    statusEl.textContent = 'Submitting…';
    try {
      const result = await createIssue({
        title, body,
        labels: composeNiLabels(),
        assignees: Array.from(NI_STATE.assignees),
      });
      document.getElementById('newIssueForm').classList.add('hidden');
      const ok = document.getElementById('newSuccess');
      ok.classList.remove('hidden');
      document.getElementById('newSuccessBody').innerHTML = `
        <h3>#${result.number} — ${escapeHTML(result.title)}</h3>
        <div class="ni-success-labels">${(result.labels || []).map(l =>
          `<span class="t-kind issue">${escapeHTML(l.name)}</span>`).join(' ')}</div>
        <div class="ni-actions">
          <a class="btn-primary" target="_blank" rel="noopener" href="${result.html_url}">Open in GitHub →</a>
          <button class="btn-ghost" id="niAnother">Create another</button>
        </div>`;
      document.getElementById('niAnother').onclick = () => {
        document.getElementById('niTitle').value = '';
        document.getElementById('niBody').value = '';
        NI_STATE.module = '';
        NI_STATE.submodule = '';
        document.getElementById('niModuleSelect').value = '';
        populateSubmoduleSelect('');
        renderNewIssueForm();
      };
      // Refresh dashboard data so the new issue shows up next time.
      STATE.issues.length = 0;
      await loadData();
      render();
    } catch (e) {
      // Special-case the common 403 'Resource not accessible' — that's
      // the PAT-missing-Issues:Write case. Give the user a click-path
      // fix instead of a generic API error.
      const is403 = e.status === 403 || /403/.test(e.message);
      const isReadOnly = /not accessible/i.test(e.message);
      if (is403 && isReadOnly) {
        statusEl.innerHTML = `<span style="color:var(--color-loss)">PAT lacks <strong>Issues: Write</strong>.</span> ` +
          `Open <a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener">your PAT</a>, ` +
          `change Issues → <strong>Read and write</strong>, save, then paste again via ⚙ Settings.`;
      } else {
        statusEl.textContent = `Error: ${e.message}`;
      }
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   Issue detail drawer
   ═══════════════════════════════════════════════════════════════ */

function escapeAttr (s) { return escapeHTML(s).replace(/"/g, '&quot;'); }

// Very small markdown subset — bold/italic/inline code/code block/
// link/autolink/#N. NOT a full parser; goal is "readable enough".
function simpleMd (text) {
  if (!text) return '';
  let html = escapeHTML(text);
  html = html.replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c}</code></pre>`);
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    '<a target="_blank" rel="noreferrer" href="$2">$1</a>');
  html = html.replace(/(^|\s)(https?:\/\/[^\s<]+)/g,
    '$1<a target="_blank" rel="noreferrer" href="$2">$2</a>');
  html = html.replace(/(^|\s)#(\d+)/g,
    `$1<a class="issue-chip" target="_blank" rel="noreferrer" href="https://github.com/${REPO}/issues/$2">#$2</a>`);
  html = html.replace(/\n/g, '<br>');
  return html;
}

async function openDrawer (n) {
  STATE.drawer = { number: n, comments: null };
  const issue = STATE.issues.find(i => i.number === n);
  const drawer = document.getElementById('drawer');
  drawer.classList.remove('hidden');
  drawer.setAttribute('aria-hidden', 'false');

  if (issue) {
    document.getElementById('drawerNumber').textContent = `#${n}`;
    document.getElementById('drawerTitle').textContent = issue.title;
    document.getElementById('drawerState').textContent = issue.state;
    document.getElementById('drawerState').className = `t-state ${issue.state}`;
    const tags = [];
    if (issue.surface !== 'unclassified') tags.push(`<span class="t-kind">surface: ${issue.surface}</span>`);
    if (issue.kind_type) tags.push(`<span class="t-kind">type: ${issue.kind_type}</span>`);
    if (issue.module)    tags.push(`<span class="t-kind" style="color:${moduleColor(issue.module)}; border-color:${moduleColor(issue.module)}">${escapeHTML(moduleLabel(issue.module))}</span>`);
    if (issue.priority)  tags.push(`<span class="t-pri ${issue.priority}">${issue.priority}</span>`);
    if (issue.is_pr)     tags.push(`<span class="t-kind pr">PR</span>`);
    document.getElementById('drawerTags').innerHTML = tags.join(' ');
    document.getElementById('drawerOpened').textContent = new Date(issue.created_at).toLocaleString();
    document.getElementById('drawerUpdated').textContent = fmtRelative(issue.updated_at);
    document.getElementById('drawerBody').innerHTML = simpleMd(issue.body);
    document.getElementById('drawerOpen').href = issue.url;
    document.getElementById('drawerComment').href = issue.url + '#new_comment_field';
  }

  // Fetch comments lazily.
  const cl = document.getElementById('drawerCommentsList');
  const cc = document.getElementById('drawerCommentsCount');
  cc.textContent = '(loading…)';
  cl.innerHTML = '';
  try {
    const comments = await fetchComments(n);
    STATE.drawer.comments = comments;
    cc.textContent = `(${comments.length})`;
    cl.innerHTML = comments.length
      ? comments.map(c => `
          <li class="comment-row">
            <img class="avatar sm" src="${c.user?.avatar_url || ''}&s=40" alt="">
            <div class="comment-body">
              <div class="comment-meta">
                <strong>${escapeHTML(c.user?.login || '—')}</strong>
                <span class="muted small">${fmtRelative(c.created_at)}</span>
              </div>
              <div class="comment-text">${simpleMd((c.body || '').slice(0, 320) + ((c.body || '').length > 320 ? '…' : ''))}</div>
            </div>
          </li>`).join('')
      : '<li class="muted" style="padding: var(--space-3)">No comments.</li>';
  } catch (e) {
    cc.textContent = '(error)';
    cl.innerHTML = `<li class="muted small">Couldn't load comments: ${escapeHTML(e.message)}</li>`;
  }
}

function closeDrawer () {
  const d = document.getElementById('drawer');
  d.classList.add('hidden');
  d.setAttribute('aria-hidden', 'true');
  STATE.drawer = { number: null, comments: null };
}

function bindDrawer () {
  document.getElementById('drawerClose').addEventListener('click', closeDrawer);
  document.querySelector('.drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('drawer').classList.contains('hidden')) {
      closeDrawer();
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   Sidebar/UI for new routes + avatars + UI-vs-Backend donut +
   Type breakdown tiles + "Assigned to me" toggle wiring.
   ═══════════════════════════════════════════════════════════════ */

function renderAvatarStack (assignees, max = 2) {
  if (!assignees || !assignees.length) return '<span class="avatar-stack empty"></span>';
  const items = assignees.slice(0, max);
  const rest = assignees.length - items.length;
  const stack = items.map((a, i) =>
    `<img class="avatar sm" src="${a.avatar}&s=40" alt="${escapeAttr(a.login)}" title="${escapeAttr(a.login)}" style="z-index:${10 - i}">`
  ).join('');
  const more = rest > 0 ? `<span class="avatar-more">+${rest}</span>` : '';
  return `<span class="avatar-stack">${stack}${more}</span>`;
}

function renderChartSurface (filtered) {
  const open = filtered.filter(i => i.state === 'open');
  const c = { ui: 0, backend: 0, fullstack: 0, unclassified: 0 };
  for (const i of open) c[i.surface] = (c[i.surface] || 0) + 1;
  const labels = ['UI', 'Backend', 'Full-stack', 'Unclassified'];
  const data = [c.ui, c.backend, c.fullstack, c.unclassified];
  const colors = [COLOR.accent, COLOR.blue, COLOR.purple, COLOR.dim];
  chartDestroy('chartSurface');
  CHARTS.chartSurface = new Chart(document.getElementById('chartSurface'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: COLOR.bg, borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { color: COLOR.text, font: { family: 'Inter', size: 11 } } },
        tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed}` } },
      },
    },
  });
}

function renderChartType (filtered) {
  // Donut split of Issues (bug) vs Tasks vs Features vs Chores vs Docs
  // among OPEN non-PR records. Click handler narrows the dashboard to the
  // clicked slice (same effect as clicking the matching KPI tile).
  const open = filtered.filter(i => i.state === 'open' && !i.is_pr);
  const c = { bug: 0, task: 0, feat: 0, chore: 0, docs: 0, untyped: 0 };
  for (const i of open) {
    if (i.kind_type) c[i.kind_type]++; else c.untyped++;
  }
  const labels = ['🐞 Issues', '📝 Tasks', '✨ Features', '🧹 Chores', '📚 Docs', '∅ Untyped'];
  const data   = [c.bug, c.task, c.feat, c.chore, c.docs, c.untyped];
  const colors = [COLOR.loss, COLOR.blue, COLOR.accent, COLOR.dim, COLOR.brand, '#444'];
  chartDestroy('chartType');
  const ctx = document.getElementById('chartType');
  if (!ctx) return;
  CHARTS.chartType = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: COLOR.bg, borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { color: COLOR.text, font: { family: 'Inter', size: 11 } } },
        tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed}` } },
      },
      onClick: (_evt, els) => {
        if (!els.length) return;
        const map = ['bug', 'task', 'feat', 'chore', 'docs', null];
        const kt  = map[els[0].index];
        FILTERS.kindType = (FILTERS.kindType === kt) ? null : kt;
        PAGE.idx = 0; render();
      },
    },
  });
}

function renderTypeTiles (filtered) {
  const open = filtered.filter(i => i.state === 'open');
  const c = { bug: 0, task: 0, feat: 0, chore: 0, docs: 0 };
  for (const i of open) if (i.kind_type) c[i.kind_type]++;
  document.getElementById('kpiBug').textContent   = c.bug;
  document.getElementById('kpiTask').textContent  = c.task;
  document.getElementById('kpiFeat').textContent  = c.feat;
  document.getElementById('kpiChore').textContent = c.chore;
  document.getElementById('kpiDocs').textContent  = c.docs;
  // Highlight the active type-tile if one is selected.
  document.querySelectorAll('.kpi.clickable[data-kt]').forEach(t => {
    t.classList.toggle('active', t.dataset.kt === FILTERS.kindType);
  });
}

function bindTypeTiles () {
  document.querySelectorAll('.kpi.clickable[data-kt]').forEach(t => {
    t.addEventListener('click', () => {
      const kt = t.dataset.kt;
      FILTERS.kindType = (FILTERS.kindType === kt) ? null : kt;
      PAGE.idx = 0;
      render();
    });
  });
}

/* ──────────────────────────────────────────────────────────────
   Detail tiles (12 in 3 rows):
     row A — Tasks by priority (P0/P1/P2) + Epic count among tasks
     row B — Issues (bugs) by priority + audit-v2 cohort
     row C — Age stats (oldest / avg / stale >30d) + Epics total
   Each tile is click-to-filter. Click again to clear.
   The active pill state of the Type/Priority bars doesn't auto-sync
   (same UX pattern as bindTypeTiles), but the filter banner + table
   row count both reflect the new filter, so functional intent is clear.
   ────────────────────────────────────────────────────────────── */
function renderDetailTiles (filtered) {
  const open = filtered.filter(i => i.state === 'open' && !i.is_pr);
  const c = {
    taskP0: 0, taskP1: 0, taskP2: 0, taskEpic: 0,
    bugP0:  0, bugP1:  0, bugP2:  0, auditV2:  0,
    epics:  0,
  };
  let oldestAge = 0;
  let ageSum = 0;
  let stale = 0;
  const now = Date.now();
  for (const i of open) {
    const labels = new Set((i.labels || []).map(l => l.toLowerCase()));
    if (i.kind_type === 'task') {
      if (i.priority === 'p0') c.taskP0++;
      else if (i.priority === 'p1') c.taskP1++;
      else if (i.priority === 'p2') c.taskP2++;
      if (labels.has('epic')) c.taskEpic++;
    } else if (i.kind_type === 'bug') {
      if (i.priority === 'p0') c.bugP0++;
      else if (i.priority === 'p1') c.bugP1++;
      else if (i.priority === 'p2') c.bugP2++;
    }
    if (labels.has('audit-v2')) c.auditV2++;
    if (labels.has('epic')) c.epics++;
    if (i.age_days > oldestAge) oldestAge = i.age_days;
    if (i.age_days >= 0) ageSum += i.age_days;
    // updated_at-based staleness (no update in 30+ days)
    if (i.updated_at) {
      const d = Math.floor((now - new Date(i.updated_at).getTime()) / 86400000);
      if (d > 30) stale++;
    }
  }
  const avgAge = open.length ? Math.round(ageSum / open.length) : 0;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('kpiTaskP0',  c.taskP0);
  set('kpiTaskP1',  c.taskP1);
  set('kpiTaskP2',  c.taskP2);
  set('kpiTaskEpic',c.taskEpic);
  set('kpiBugP0',   c.bugP0);
  set('kpiBugP1',   c.bugP1);
  set('kpiBugP2',   c.bugP2);
  set('kpiAuditV2', c.auditV2);
  set('kpiOldestAge', oldestAge + 'd');
  set('kpiAvgAge',  avgAge + 'd');
  set('kpiStale',   stale);
  set('kpiEpics',   c.epics);
}

function bindDetailTiles () {
  document.querySelectorAll('.kpi.clickable[data-detail]').forEach(t => {
    t.addEventListener('click', () => {
      const d = t.dataset.detail;
      // Toggle behavior: if this tile is currently the active filter
      // (kindType+priority/label match), clear; otherwise apply.
      const cur = `${FILTERS.kindType || ''}|${FILTERS.priority || 'all'}|${FILTERS.label || ''}`;
      const applyAndCompare = (kt, pr, lb) => {
        const next = `${kt || ''}|${pr || 'all'}|${lb || ''}`;
        if (cur === next) {
          FILTERS.kindType = null; FILTERS.priority = 'all'; FILTERS.label = null;
        } else {
          FILTERS.kindType = kt; FILTERS.priority = pr; FILTERS.label = lb;
        }
      };
      switch (d) {
        case 'task-p0':   applyAndCompare('task', 'p0', null);    break;
        case 'task-p1':   applyAndCompare('task', 'p1', null);    break;
        case 'task-p2':   applyAndCompare('task', 'p2', null);    break;
        case 'task-epic': applyAndCompare('task', 'all', 'epic'); break;
        case 'bug-p0':    applyAndCompare('bug',  'p0', null);    break;
        case 'bug-p1':    applyAndCompare('bug',  'p1', null);    break;
        case 'bug-p2':    applyAndCompare('bug',  'p2', null);    break;
        case 'audit-v2':  applyAndCompare(null,   'all', 'audit-v2'); break;
        case 'epic':      applyAndCompare(null,   'all', 'epic'); break;
        case 'assigned':
          // Toggle assignee-filter dimension. Backed by FILTERS.assignedToMe
          // when a PAT is present; otherwise we just filter the table view
          // for issues with any assignee.
          FILTERS.assigneeAny = !FILTERS.assigneeAny;
          if (FILTERS.assigneeAny) FILTERS.assigneeNone = false;
          break;
        case 'unassigned':
          FILTERS.assigneeNone = !FILTERS.assigneeNone;
          if (FILTERS.assigneeNone) FILTERS.assigneeAny = false;
          break;
        case 'wip':
          FILTERS.wipOnly = !FILTERS.wipOnly;
          break;
        case 'stale':
          // Stale tile sorts the table by updated_at asc to surface
          // oldest-updated; no FILTERS change since it's a view ordering hint.
          PAGE.sort = { key: 'age_days', dir: 'desc' };
          break;
        case 'oldest':
          // Sort by age desc — surfaces longest-open at the top.
          PAGE.sort = { key: 'age_days', dir: 'desc' };
          break;
        case 'avg-age':
          // No-op filter; tooltip already shows the value.
          return;
      }
      PAGE.idx = 0;
      render();
    });
  });
}

function bindProofTiles () {
  document.querySelectorAll('.kpi.clickable[data-proof]').forEach(t => {
    t.addEventListener('click', () => {
      const v = t.dataset.proof;
      FILTERS.proof = (FILTERS.proof === v) ? null : v;
      PAGE.idx = 0;
      render();
    });
  });
}

/* ═══════════════════════════════════════════════════════════════
   Wire the new sidebar VIEWS section + module deep-links + board
   surface pill + assigned-to-me toggle + drawer + new-issue form.
   ═══════════════════════════════════════════════════════════════ */

function bindNewSidebar () {
  document.querySelectorAll('.view-row').forEach(b => {
    b.addEventListener('click', () => {
      navigate(b.dataset.route);
      closeMobileSidebar();    // auto-close on mobile after picking a view
    });
  });
}

// ── Mobile sidebar drawer ─────────────────────────────────────
function openMobileSidebar () {
  document.body.classList.add('sidebar-open');
  document.getElementById('sidebarBackdrop')?.classList.remove('hidden');
}
function closeMobileSidebar () {
  document.body.classList.remove('sidebar-open');
  document.getElementById('sidebarBackdrop')?.classList.add('hidden');
}
function bindMobileSidebar () {
  document.getElementById('sidebarToggle')?.addEventListener('click', () => {
    if (document.body.classList.contains('sidebar-open')) closeMobileSidebar();
    else openMobileSidebar();
  });
  document.getElementById('sidebarBackdrop')?.addEventListener('click', closeMobileSidebar);
  // Sidebar item clicks (module/submodule) — also close on mobile.
  document.getElementById('moduleTree')?.addEventListener('click', () => {
    if (window.innerWidth <= 900) closeMobileSidebar();
  });
}

function bindBoardSurface () {
  document.getElementById('boardSurface')?.addEventListener('click', e => {
    const b = e.target.closest('.pill'); if (!b) return;
    FILTERS.surface = b.dataset.surf;
    document.querySelectorAll('#boardSurface .pill').forEach(p => p.classList.remove('active'));
    b.classList.add('active');
    renderBoard();
  });
}

function bindBoardDropTargets () {
  for (const col of ['todo', 'inprogress', 'inreview', 'done']) {
    const colEl = document.querySelector(`.board-col[data-col="${col}"]`);
    if (!colEl) continue;
    colEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      colEl.classList.add('drop-target');
    });
    colEl.addEventListener('dragleave', (e) => {
      // Only un-highlight when the cursor truly leaves the column box,
      // not when it crosses an inner element.
      if (e.target === colEl || !colEl.contains(e.relatedTarget)) {
        colEl.classList.remove('drop-target');
      }
    });
    colEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      colEl.classList.remove('drop-target');
      const num = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (num) await moveIssueToStage(num, col);
    });
  }
}

function bindAssignedToMe () {
  document.getElementById('assignedToMe')?.addEventListener('change', e => {
    FILTERS.assignedToMe = e.target.checked;
    PAGE.idx = 0; render();
  });
}

/* ═══════════════════════════════════════════════════════════════
   Boot — replaces the previous IIFE at the bottom of the file.
   ═══════════════════════════════════════════════════════════════ */

(async () => {
  bindTheme();
  bindFilters();
  bindSettings();
  bindNewSidebar();
  bindMobileSidebar();
  bindBoardDropTargets();
  // Sidebar label search — incremental filter on the rendered list only.
  document.getElementById('labelSearch')?.addEventListener('input', () => renderLabels());
  bindBoardSurface();
  bindAssignedToMe();
  bindTypeTiles();
  bindDetailTiles();
  bindProofTiles();
  bindReportsRefresh();
  bindNewIssueForm();
  bindDrawer();
  window.addEventListener('hashchange', handleRoute);
  await loadData();
  await handleRoute();          // dispatches to active view; calls render()
})();
