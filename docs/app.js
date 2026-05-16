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
  assignees:  null,      // lazy-loaded (collaborators)
  drawer:     { number: null, comments: null },
};

const FILTERS = {
  module:    null,
  submodule: null,
  label:     null,
  type:      'all',
  kindType:  null,       // bug | feat | chore | docs (set by clicking a Type tile)
  priority:  'all',
  status:    'open',
  age:       'all',
  search:    '',
  assignedToMe: false,
  surface:   'all',
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
// surface filter and the new "UI vs Backend" donut.
function surfaceOf (labelNames) {
  const set = new Set(labelNames.map(n => n.toLowerCase()));
  const ui = set.has('ui') || set.has('frontend') || set.has('v1-cutover');
  const be = set.has('backend') || set.has('server') || set.has('api')
          || set.has('signal-engine') || set.has('broker') || set.has('streaming')
          || set.has('storage') || set.has('schema-drift') || set.has('auth')
          || set.has('multi-user') || set.has('infra');
  if (set.has('fullstack') || (ui && be)) return 'fullstack';
  if (ui) return 'ui';
  if (be) return 'backend';
  return 'unclassified';
}

// Type classification — Bug / Feature / Chore / Docs. Used for the
// "Type breakdown" tiles row on the dashboard.
function typeOf (labelNames) {
  const set = new Set(labelNames.map(n => n.toLowerCase()));
  if (set.has('bug')) return 'bug';
  if (set.has('documentation') || set.has('docs')) return 'docs';
  if (set.has('enhancement') || set.has('feature') || set.has('feat')) return 'feat';
  if (set.has('chore') || set.has('tech-debt') || set.has('task')) return 'chore';
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
      const taxResp = await fetch('taxonomy.json');
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
    if (FILTERS.type === 'pr'    && !i.is_pr) return false;
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
  if (FILTERS.search)             chips.push(`search:"${FILTERS.search}"`);
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
  document.getElementById('kpiP0').textContent         = cnt('p0');
  document.getElementById('kpiP1').textContent         = cnt('p1');
  document.getElementById('kpiP2').textContent         = cnt('p2');
  document.getElementById('kpiOpened7d').textContent   = src.filter(i => within(i.created_at, 7)).length;
  document.getElementById('kpiClosed7d').textContent   = src.filter(i => within(i.closed_at,  7)).length;
  document.getElementById('kpiMerged7d').textContent   = src.filter(i => i.merged && within(i.merged_at, 7)).length;
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
        x: { stacked: true, ticks: { color: COLOR.text, font: { family: 'Inter' } }, grid: { color: COLOR.grid } },
        y: { stacked: true, ticks: { color: COLOR.text, font: { family: 'Inter' } }, grid: { display: false } },
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
  // Charts only relevant on the dashboard view; cheap to compute either way.
  if (ROUTE.current === 'dashboard') {
    renderChartModule(filtered);
    renderChartSurface(filtered);
    renderChartPriorityStack(filtered);
    renderChartTrend();
    renderChartAge(filtered);
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
                             assignedToMe: false });
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

const VIEWS = ['dashboard', 'board', 'sprints', 'new', 'activity', 'commits'];

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

function renderTypeTiles (filtered) {
  const open = filtered.filter(i => i.state === 'open');
  const c = { bug: 0, feat: 0, chore: 0, docs: 0 };
  for (const i of open) if (i.kind_type) c[i.kind_type]++;
  document.getElementById('kpiBug').textContent   = c.bug;
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
  bindNewIssueForm();
  bindDrawer();
  window.addEventListener('hashchange', handleRoute);
  await loadData();
  await handleRoute();          // dispatches to active view; calls render()
})();
