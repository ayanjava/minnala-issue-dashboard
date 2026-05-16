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
};

const FILTERS = {
  module:    null,
  submodule: null,
  label:     null,       // single auto-discovered label
  type:      'all',      // all | issue | pr
  priority:  'all',      // all | p0 | p1 | p2 | none
  status:    'open',     // open | closed | merged | all
  age:       'all',
  search:    '',
};

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
  const labelSet = new Set((item.labels || []).map(l => l.name.toLowerCase()));
  for (const m of taxonomy.modules) {
    for (const s of (m.submodules || [])) {
      for (const r of (s.rules || [])) {
        if (ruleMatches(r, item, labelSet)) {
          return { module: m.id, submodule: s.id };
        }
      }
    }
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
    assignee: item.assignee?.login || '',
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
      if (FILTERS.module === m.id && !FILTERS.submodule) { FILTERS.module = null; }
      else { FILTERS.module = m.id; FILTERS.submodule = null; }
      PAGE.idx = 0; render();
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
          PAGE.idx = 0; render();
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

function applyFilters (issues) {
  const q = FILTERS.search.trim().toLowerCase();
  return issues.filter(i => {
    if (FILTERS.module    && i.module    !== FILTERS.module)    return false;
    if (FILTERS.submodule && i.submodule !== FILTERS.submodule) return false;
    if (FILTERS.label && !(i.labels || []).includes(FILTERS.label)) return false;
    if (FILTERS.type === 'issue' && i.is_pr)  return false;
    if (FILTERS.type === 'pr'    && !i.is_pr) return false;
    if (FILTERS.priority !== 'all') {
      const p = i.priority || 'none';
      if (p !== FILTERS.priority) return false;
    }
    if (FILTERS.status !== 'all') {
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
    return true;
  });
}

function renderFilterBanner () {
  const banner = document.getElementById('filterBanner');
  const chips = [];
  if (FILTERS.module)    chips.push(moduleLabel(FILTERS.module));
  if (FILTERS.submodule) chips.push(submoduleLabel(FILTERS.module, FILTERS.submodule));
  if (FILTERS.label)     chips.push('label:' + FILTERS.label);
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

function renderKPIs () {
  if (!STATE.stats) return;
  const t = STATE.stats.totals || {};
  const p = STATE.stats.by_priority || {};
  document.getElementById('kpiOpenIssues').textContent = t.open_issues ?? '—';
  document.getElementById('kpiOpenPRs').textContent    = t.open_prs    ?? '—';
  document.getElementById('kpiP0').textContent         = p.p0 ?? '—';
  document.getElementById('kpiP1').textContent         = p.p1 ?? '—';
  document.getElementById('kpiP2').textContent         = p.p2 ?? '—';
  document.getElementById('kpiOpened7d').textContent   = t.opened_7d ?? '—';
  document.getElementById('kpiClosed7d').textContent   = t.closed_7d ?? '—';
  document.getElementById('kpiMerged7d').textContent   = t.merged_7d ?? '—';
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
  root.innerHTML = '';
  // Sorted by open-count desc; cap to 40 so the sidebar isn't a wall.
  const entries = Array.from(LABEL_META.entries())
    .filter(([, m]) => m.count > 0)
    .sort((a, b) => b[1].count - a[1].count);
  if (entries.length === 0) {
    root.innerHTML = '<li class="muted">No labels.</li>';
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
    tr.onclick = () => window.open(i.url, '_blank', 'noopener');
    const pri = i.priority || 'none';
    const kindPill = i.is_pr
      ? `<span class="t-kind pr">${i.draft ? 'Draft' : 'PR'}</span>`
      : `<span class="t-kind issue">Issue</span>`;
    const stateLabel = i.state;
    tr.innerHTML = `
      <td class="num"><span class="t-num">${i.number}</span></td>
      <td>${kindPill}</td>
      <td><span class="t-title">${escapeHTML(i.title)}</span></td>
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
  renderKPIs();
  renderChartModule(filtered);
  renderChartPriorityStack(filtered);
  renderChartTrend();
  renderChartAge(filtered);
  renderTable(filtered);
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
                             type: 'all', priority: 'all', status: 'open',
                             age: 'all', search: '' });
    document.getElementById('search').value = '';
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

/* ── Boot ─────────────────────────────────────────────────────── */

(async () => {
  bindFilters();
  bindSettings();
  await loadData();
  render();
})();
