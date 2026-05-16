/* Minnala Issue Dashboard — vanilla JS SPA.
 *
 * State machine:
 *   1. Fetch data/issues.json + data/stats.json (parallel)
 *   2. Build sidebar from stats.modules
 *   3. Render charts (Chart.js)
 *   4. Apply filters → re-render KPIs, charts, table
 *
 * Filters are state-driven (FILTERS object). Any UI change updates
 * FILTERS then calls render(). All four chart objects live on
 * CHARTS so we can .destroy() + recreate on data refresh.
 */
'use strict';

const STATE = {
  issues:   [],
  stats:    null,
  modules:  [],          // flattened {id,label,icon,color,sub:[{id,label}]}
};

const FILTERS = {
  module:    null,       // module id (or null = all)
  submodule: null,       // submodule id within module
  priority:  'all',      // p0|p1|p2|none|all
  status:    'open',     // open|closed|all
  age:       'all',      // <7 | 7-30 | 30-90 | >90 | all
  search:    '',
};

const SORT  = { col: 'updated_at', dir: 'desc' };
const PAGE  = { idx: 0, size: 25 };
const CHARTS = {};       // keyed by canvas id

/* ── Data loading ─────────────────────────────────────────────── */

async function loadData () {
  // Cache-busting query param so a freshly-pushed JSON shows up immediately.
  const bust = Date.now();
  try {
    const [issuesResp, statsResp] = await Promise.all([
      fetch(`data/issues.json?t=${bust}`),
      fetch(`data/stats.json?t=${bust}`),
    ]);
    if (!issuesResp.ok || !statsResp.ok) {
      throw new Error(`HTTP ${issuesResp.status} / ${statsResp.status}`);
    }
    STATE.issues  = await issuesResp.json();
    STATE.stats   = await statsResp.json();
    STATE.modules = STATE.stats.modules || [];
    document.getElementById('lastUpdated').textContent =
      `updated ${fmtRelative(STATE.stats.generated_at)}`;
  } catch (e) {
    document.getElementById('lastUpdated').textContent =
      `⚠ failed to load (${e.message}) — run scripts/fetch_issues.py + classify.py`;
    STATE.issues = [];
    STATE.stats  = { totals: {}, by_priority: {}, modules: [],
                     oldest_open: [], trend_90d: [], age_buckets: {} };
  }
}

/* ── Helpers ──────────────────────────────────────────────────── */

function fmtRelative (iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso || '—';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60)        return `${sec}s ago`;
  if (sec < 3600)      return `${Math.floor(sec/60)}m ago`;
  if (sec < 86400)     return `${Math.floor(sec/3600)}h ago`;
  return new Date(iso).toLocaleString();
}

function moduleLabel (id) {
  const m = STATE.modules.find(x => x.id === id);
  return m ? `${m.icon} ${m.label}` : id;
}
function moduleColor (id) {
  const m = STATE.modules.find(x => x.id === id);
  return m ? m.color : '#9ca3af';
}
function submoduleLabel (modId, subId) {
  const m = STATE.modules.find(x => x.id === modId);
  if (!m) return subId;
  const s = (m.submodules || []).find(x => x.id === subId);
  return s ? s.label : subId;
}

/* ── Sidebar ──────────────────────────────────────────────────── */

function renderSidebar () {
  const root = document.getElementById('moduleTree');
  root.innerHTML = '';
  for (const m of STATE.modules) {
    if (m.open === 0 && (!m.submodules || m.submodules.every(s => s.open === 0))) {
      continue;   // hide empty modules
    }
    const li = document.createElement('li');
    li.className = (FILTERS.module === m.id) ? 'expanded' : '';
    const headerBtn = document.createElement('button');
    headerBtn.className = 'module-row' + (FILTERS.module === m.id && !FILTERS.submodule ? ' active' : '');
    headerBtn.innerHTML = `
      <span class="chev">▸</span>
      <span class="module-icon">${m.icon}</span>
      <span class="module-label">${m.label}</span>
      <span class="module-count">${m.open}</span>
    `;
    headerBtn.onclick = () => {
      if (FILTERS.module === m.id && !FILTERS.submodule) {
        FILTERS.module = null;
      } else {
        FILTERS.module = m.id;
        FILTERS.submodule = null;
      }
      render();
    };
    li.appendChild(headerBtn);

    if (m.submodules && m.submodules.length) {
      const ul = document.createElement('ul');
      ul.className = 'sub-list';
      for (const s of m.submodules) {
        if (s.open === 0 && s.closed === 0) continue;
        const subBtn = document.createElement('button');
        const isActive = FILTERS.module === m.id && FILTERS.submodule === s.id;
        subBtn.className = 'sub-row' + (isActive ? ' active' : '');
        subBtn.innerHTML = `
          <span class="module-label">${s.label}</span>
          <span class="module-count">${s.open}</span>
        `;
        subBtn.onclick = (ev) => {
          ev.stopPropagation();
          FILTERS.module = m.id;
          FILTERS.submodule = isActive ? null : s.id;
          render();
        };
        const subLi = document.createElement('li');
        subLi.appendChild(subBtn);
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
    if (FILTERS.priority !== 'all') {
      const p = i.priority || 'none';
      if (p !== FILTERS.priority) return false;
    }
    if (FILTERS.status !== 'all' && i.state !== FILTERS.status) return false;
    if (FILTERS.age !== 'all') {
      const a = i.age_days;
      if (FILTERS.age === '<7'    && !(a < 7))                return false;
      if (FILTERS.age === '7-30'  && !(a >= 7   && a < 30))   return false;
      if (FILTERS.age === '30-90' && !(a >= 30  && a < 90))   return false;
      if (FILTERS.age === '>90'   && !(a >= 90))              return false;
    }
    if (q) {
      const hay = (i.title + ' #' + i.number).toLowerCase();
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
  if (FILTERS.priority !== 'all') chips.push(FILTERS.priority.toUpperCase());
  if (FILTERS.status !== 'open')  chips.push(FILTERS.status);
  if (FILTERS.age !== 'all')      chips.push('age:' + FILTERS.age);
  if (FILTERS.search)             chips.push(`search:"${FILTERS.search}"`);
  if (chips.length === 0) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  banner.innerHTML = '<span class="muted">Filters:</span>' +
    chips.map(c => `<span class="chip">${c}</span>`).join('');
}

/* ── KPI tiles ────────────────────────────────────────────────── */

function renderKPIs (filtered) {
  const open = filtered.filter(i => i.state === 'open');
  const cnt = (p) => open.filter(i => (i.priority || 'none') === p).length;
  document.getElementById('kpiOpen').textContent  = open.length;
  document.getElementById('kpiP0').textContent    = cnt('p0');
  document.getElementById('kpiP1').textContent    = cnt('p1');
  document.getElementById('kpiP2').textContent    = cnt('p2');
  const t = STATE.stats?.totals || {};
  document.getElementById('kpiOpened7d').textContent = t.opened_7d ?? '—';
  document.getElementById('kpiClosed7d').textContent = t.closed_7d ?? '—';
}

/* ── Charts ───────────────────────────────────────────────────── */

// OKLCH palette mirroring frontend/src/design-system/theme.css tokens.
// Chart.js v4 accepts OKLCH color strings directly.
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

function chartDestroy (id) {
  if (CHARTS[id]) { CHARTS[id].destroy(); CHARTS[id] = null; }
}

function renderChartModule (filtered) {
  const open = filtered.filter(i => i.state === 'open');
  const byMod = {};
  for (const i of open) byMod[i.module] = (byMod[i.module] || 0) + 1;
  const labels = Object.keys(byMod).sort((a,b) => byMod[b] - byMod[a]);
  const data   = labels.map(k => byMod[k]);
  const colors = labels.map(k => moduleColor(k));
  const displayLabels = labels.map(k => {
    const m = STATE.modules.find(x => x.id === k);
    return m ? `${m.icon} ${m.label}` : k;
  });
  chartDestroy('chartModule');
  CHARTS.chartModule = new Chart(document.getElementById('chartModule'), {
    type: 'doughnut',
    data: {
      labels: displayLabels,
      datasets: [{ data, backgroundColor: colors, borderColor: COLOR.bg, borderWidth: 2 }],
    },
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
  const p0 = mods.map(m => open.filter(i => i.module === m.id && i.priority === 'p0').length);
  const p1 = mods.map(m => open.filter(i => i.module === m.id && i.priority === 'p1').length);
  const p2 = mods.map(m => open.filter(i => i.module === m.id && i.priority === 'p2').length);
  const np = mods.map(m => open.filter(i => i.module === m.id && !i.priority).length);
  chartDestroy('chartPriorityStack');
  CHARTS.chartPriorityStack = new Chart(document.getElementById('chartPriorityStack'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'P0', data: p0, backgroundColor: COLOR.loss },
        { label: 'P1', data: p1, backgroundColor: COLOR.alert },
        { label: 'P2', data: p2, backgroundColor: COLOR.blue },
        { label: '∅',  data: np, backgroundColor: COLOR.dim },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      scales: {
        x: { stacked: true,
             ticks: { color: COLOR.text, font: { family: 'Inter' } },
             grid:  { color: COLOR.grid } },
        y: { stacked: true,
             ticks: { color: COLOR.text, font: { family: 'Inter' } },
             grid:  { display: false } },
      },
      plugins: {
        legend: { position: 'bottom',
                  labels: { color: COLOR.text, font: { family: 'Inter', size: 11 } } },
      },
    },
  });
}

function renderChartTrend () {
  const t = STATE.stats?.trend_90d || [];
  chartDestroy('chartTrend');
  if (!t.length) return;
  CHARTS.chartTrend = new Chart(document.getElementById('chartTrend'), {
    type: 'line',
    data: {
      labels: t.map(d => d.date.slice(5)),
      datasets: [
        { label: 'Open count', data: t.map(d => d.open),
          borderColor: COLOR.accent,
          backgroundColor: 'oklch(0.78 0.20 145 / 0.14)',  // accent-soft
          fill: true, tension: 0.25, pointRadius: 0, borderWidth: 2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: COLOR.text, font: { family: 'Inter' }, maxTicksLimit: 12 },
             grid:  { display: false } },
        y: { ticks: { color: COLOR.text, font: { family: 'Inter' } },
             grid:  { color: COLOR.grid } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

function renderChartAge (filtered) {
  const open = filtered.filter(i => i.state === 'open');
  const b = { '<7d': 0, '7-30d': 0, '30-90d': 0, '>90d': 0 };
  for (const i of open) {
    const a = i.age_days;
    if (a < 7) b['<7d']++;
    else if (a < 30) b['7-30d']++;
    else if (a < 90) b['30-90d']++;
    else b['>90d']++;
  }
  chartDestroy('chartAge');
  CHARTS.chartAge = new Chart(document.getElementById('chartAge'), {
    type: 'bar',
    data: {
      labels: Object.keys(b),
      datasets: [{ label: 'Open issues', data: Object.values(b),
                   backgroundColor: [COLOR.accent, COLOR.blue, COLOR.alert, COLOR.loss] }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: COLOR.text, font: { family: 'Inter' } },
             grid:  { display: false } },
        y: { ticks: { color: COLOR.text, font: { family: 'Inter' } },
             grid:  { color: COLOR.grid } },
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
    li.onclick = () => window.open(i.url, '_blank', 'noopener');
    li.innerHTML = `
      <span class="o-num">#${i.number}</span>
      <span class="o-title">${escapeHTML(i.title)}</span>
      <span class="o-age">${i.age_days}d</span>
    `;
    list.appendChild(li);
  }
  if (items.length === 0) {
    list.innerHTML = '<li class="muted">No open issues.</li>';
  }
}

/* ── Table ────────────────────────────────────────────────────── */

function escapeHTML (s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  })[c]);
}

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
    return av < bv ? -1*dir : av > bv ? 1*dir : 0;
  });
}

function renderTable (filtered) {
  const sorted = sortIssues(filtered);
  const total = sorted.length;
  document.getElementById('tableCount').textContent =
    `${total} issue${total === 1 ? '' : 's'}`;

  // Pagination
  const start = PAGE.idx * PAGE.size;
  const slice = sorted.slice(start, start + PAGE.size);

  const tbody = document.getElementById('issueBody');
  tbody.innerHTML = '';
  for (const i of slice) {
    const tr = document.createElement('tr');
    tr.className = i.state === 'closed' ? 'closed' : '';
    tr.onclick = () => window.open(i.url, '_blank', 'noopener');
    const pri = i.priority || 'none';
    tr.innerHTML = `
      <td class="num"><span class="t-num">#${i.number}</span></td>
      <td><span class="t-title">${escapeHTML(i.title)}</span></td>
      <td><span class="t-mod" style="color:${moduleColor(i.module)}">${moduleLabel(i.module).split(' ')[0]}</span> <span class="muted">${escapeHTML(submoduleLabel(i.module, i.submodule))}</span></td>
      <td><span class="t-pri ${pri}">${pri}</span></td>
      <td class="num">${i.age_days}d</td>
      <td class="num">${i.comments}</td>
      <td><span class="t-state ${i.state}">${i.state}</span></td>
    `;
    tbody.appendChild(tr);
  }

  // Pager
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
    `<span class="pager-info">Page ${PAGE.idx+1} / ${pages}</span>`);
  const next = document.createElement('button');
  next.textContent = 'Next ›';
  next.disabled = PAGE.idx >= pages - 1;
  next.onclick = () => { PAGE.idx++; renderTable(filtered); };
  pager.appendChild(next);
}

/* ── Master render ────────────────────────────────────────────── */

function render () {
  renderSidebar();
  renderFilterBanner();
  const filtered = applyFilters(STATE.issues);
  renderKPIs(filtered);
  renderChartModule(filtered);
  renderChartPriorityStack(filtered);
  renderChartTrend();          // trend uses the full snapshot, not filtered
  renderChartAge(filtered);
  renderOldest();
  renderTable(filtered);
}

/* ── Event wiring ─────────────────────────────────────────────── */

function bindFilters () {
  // Pill groups.
  document.getElementById('filterPriority').addEventListener('click', e => {
    const btn = e.target.closest('button.pill');
    if (!btn) return;
    FILTERS.priority = btn.dataset.p;
    pillSelect('filterPriority', btn);
    render();
  });
  document.getElementById('filterStatus').addEventListener('click', e => {
    const btn = e.target.closest('button.pill');
    if (!btn) return;
    FILTERS.status = btn.dataset.s;
    pillSelect('filterStatus', btn);
    render();
  });
  document.getElementById('filterAge').addEventListener('click', e => {
    const btn = e.target.closest('button.pill');
    if (!btn) return;
    FILTERS.age = btn.dataset.a;
    pillSelect('filterAge', btn);
    render();
  });
  document.getElementById('search').addEventListener('input', e => {
    FILTERS.search = e.target.value;
    PAGE.idx = 0;
    render();
  });
  document.getElementById('resetBtn').addEventListener('click', () => {
    Object.assign(FILTERS, {
      module: null, submodule: null, priority: 'all',
      status: 'open', age: 'all', search: '',
    });
    document.getElementById('search').value = '';
    document.querySelectorAll('.pill-group').forEach(grp => {
      const first = grp.querySelector('.pill');
      pillSelect(grp.id, first);
    });
    PAGE.idx = 0;
    render();
  });

  // Quick filters in sidebar.
  document.querySelectorAll('button.link-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const q = btn.dataset.quick;
      Object.assign(FILTERS, { module: null, submodule: null, priority: 'all',
                               status: 'open', age: 'all', search: '' });
      document.getElementById('search').value = '';
      if (q === 'p0')             FILTERS.priority = 'p0';
      if (q === 'stale')          FILTERS.age = '>90';
      if (q === 'recent')         FILTERS.age = '<7';
      if (q === 'uncategorized')  FILTERS.module = 'uncategorized';
      // Mirror to pills.
      document.querySelectorAll('.pill-group').forEach(grp => {
        const wanted =
          grp.id === 'filterPriority' ? FILTERS.priority :
          grp.id === 'filterStatus'   ? FILTERS.status   :
          grp.id === 'filterAge'      ? FILTERS.age      : null;
        const target = grp.querySelector(`.pill[data-${grp.id === 'filterPriority' ? 'p' :
                                                       grp.id === 'filterStatus'   ? 's' : 'a'}="${wanted}"]`);
        if (target) pillSelect(grp.id, target);
      });
      PAGE.idx = 0;
      render();
    });
  });

  // Table header sort.
  document.querySelectorAll('#issueTable th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (SORT.col === col) {
        SORT.dir = SORT.dir === 'asc' ? 'desc' : 'asc';
      } else {
        SORT.col = col;
        SORT.dir = 'desc';
      }
      render();
    });
  });

  document.getElementById('refreshBtn').addEventListener('click', async () => {
    document.getElementById('lastUpdated').textContent = 'reloading…';
    await loadData();
    render();
  });
}

function pillSelect (groupId, btn) {
  document.querySelectorAll(`#${groupId} .pill`).forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
}

/* ── Boot ─────────────────────────────────────────────────────── */

(async () => {
  bindFilters();
  await loadData();
  render();
})();
