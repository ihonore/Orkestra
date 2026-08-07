/**
 * The dashboard document.
 *
 * Embedded as a string rather than shipped as an asset, for the same reason the
 * config template is: `tsc` copies no files, so an asset would need a build step
 * that this project deliberately does not have.
 *
 * Design notes, so future edits stay coherent rather than drifting into a
 * generic admin panel:
 *
 *  - The subject is a *geographic sweep*, not a SaaS funnel. The visual
 *    reference is a survey plate: hairline grid, tabular figures, muted petrol
 *    ground, and one signal colour. Monospace is the primary face because every
 *    value on this page is a measurement.
 *  - The signature element is the sweep plate — one cell per city, filling as
 *    its 85 categories complete. It shows a 15,725-job run in a single glance,
 *    which no table of counts can do.
 *  - Amber means "in progress", verdigris means "complete", rust means
 *    "needs attention". Nothing else is coloured, so colour always carries
 *    meaning.
 */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gms · sweep</title>
<style>
  :root {
    --deep:      #0b181f;
    --panel:     #102630;
    --panel-2:   #0e2029;
    --rule:      #1c3b48;
    --rule-soft: #16303b;
    --ink:       #cfe3ea;
    --dim:       #6d8f9c;
    --faint:     #47646f;
    --amber:     #e8a33d;
    --verdigris: #4fb79a;
    --rust:      #c2603f;

    --mono: ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--deep);
    color: var(--ink);
    font: 400 14px/1.5 var(--mono);
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
  }

  /* Plate annotations: small, spaced, quiet. */
  .label {
    font: 600 10px/1 var(--sans);
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--faint);
  }

  a { color: var(--amber); text-decoration: none; }
  a:hover { text-decoration: underline; }
  button, input, select { font: inherit; color: inherit; }

  :focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }

  /* ── Frame ─────────────────────────────────────────────────────────── */
  .frame { display: grid; grid-template-columns: 190px 1fr; min-height: 100vh; }

  nav {
    border-right: 1px solid var(--rule);
    padding: 22px 0;
    position: sticky; top: 0; height: 100vh;
    display: flex; flex-direction: column;
  }
  .brand {
    padding: 0 20px 22px;
    font: 700 17px/1 var(--sans);
    letter-spacing: .2em;
    text-transform: uppercase;
  }
  .brand span { color: var(--amber); }
  .brand small {
    display: block; margin-top: 7px;
    font: 400 10px/1.4 var(--sans); letter-spacing: .1em; color: var(--faint);
  }
  nav a {
    display: block; padding: 9px 20px;
    color: var(--dim); border-left: 2px solid transparent;
    font: 500 12px/1 var(--sans); letter-spacing: .08em; text-transform: uppercase;
  }
  nav a:hover { color: var(--ink); text-decoration: none; background: var(--panel-2); }
  nav a.on { color: var(--amber); border-left-color: var(--amber); background: var(--panel-2); }
  .navfoot { margin-top: auto; padding: 0 20px; }

  main { padding: 30px 34px 60px; max-width: 1500px; }
  section { display: none; }
  section.on { display: block; }

  h2 {
    margin: 0 0 4px;
    font: 600 21px/1.2 var(--sans); letter-spacing: -.01em;
  }
  .sub { color: var(--dim); font-size: 12px; margin-bottom: 26px; }

  /* ── Readout row ───────────────────────────────────────────────────── */
  .readout {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    border: 1px solid var(--rule); background: var(--panel);
    margin-bottom: 28px;
  }
  .cell { padding: 15px 17px; border-right: 1px solid var(--rule-soft); }
  .cell:last-child { border-right: 0; }
  .cell .n {
    display: block; margin-top: 9px;
    font: 400 27px/1 var(--mono); letter-spacing: -.02em;
  }
  .cell .n.hi { color: var(--amber); }
  .cell .n.ok { color: var(--verdigris); }
  .cell .n.bad { color: var(--rust); }
  .cell .of { color: var(--faint); font-size: 12px; }

  /* ── The sweep plate: the signature element ────────────────────────── */
  .plate {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(58px, 1fr));
    gap: 3px;
    border: 1px solid var(--rule); background: var(--panel);
    padding: 12px;
  }
  .tile {
    position: relative; aspect-ratio: 1;
    background: var(--panel-2);
    border: 1px solid var(--rule-soft);
    overflow: hidden; cursor: default;
  }
  /* The fill is the datum: height encodes completion. */
  .tile i {
    position: absolute; inset: auto 0 0 0;
    background: var(--amber); opacity: .5;
    transition: height .3s ease;
  }
  .tile.done i { background: var(--verdigris); opacity: .65; }
  .tile.fail { border-color: var(--rust); }
  /* The label is ground, the fill is figure: a legible key to *where* a cell
     is, not something that competes with the datum it annotates. */
  .tile b {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font: 500 10px/1 var(--sans); letter-spacing: .04em;
    color: var(--faint);
  }
  .tile:hover { border-color: var(--amber); }
  .tile:hover b { color: var(--ink); }

  .legend { display: flex; gap: 20px; margin-top: 13px; align-items: center; }
  .legend i { width: 9px; height: 9px; display: inline-block; margin-right: 6px; }

  /* ── Tables ────────────────────────────────────────────────────────── */
  .tools { display: flex; gap: 9px; flex-wrap: wrap; margin-bottom: 15px; align-items: center; }
  input[type=search], select {
    background: var(--panel); border: 1px solid var(--rule);
    padding: 8px 11px; min-width: 190px;
  }
  input[type=search]::placeholder { color: var(--faint); }
  .chip {
    background: var(--panel); border: 1px solid var(--rule);
    padding: 8px 13px; cursor: pointer; color: var(--dim);
    font: 500 11px/1 var(--sans); letter-spacing: .07em; text-transform: uppercase;
  }
  .chip[aria-pressed="true"] { border-color: var(--amber); color: var(--amber); }

  .wrap { border: 1px solid var(--rule); background: var(--panel); overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  th {
    text-align: left; padding: 10px 13px;
    border-bottom: 1px solid var(--rule);
    font: 600 10px/1 var(--sans); letter-spacing: .12em; text-transform: uppercase;
    color: var(--faint); white-space: nowrap; position: sticky; top: 0; background: var(--panel);
  }
  td { padding: 9px 13px; border-bottom: 1px solid var(--rule-soft); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  tr:hover td { background: var(--panel-2); }
  .nm { font-family: var(--sans); font-weight: 500; }
  .muted { color: var(--faint); }
  .tag {
    font: 600 9px/1 var(--sans); letter-spacing: .09em; text-transform: uppercase;
    padding: 3px 6px; border: 1px solid currentColor;
  }
  .tag.personal { color: var(--verdigris); }
  .tag.role { color: var(--amber); }
  .tag.free { color: var(--dim); }

  /* ── Config ────────────────────────────────────────────────────────── */
  .fields { border: 1px solid var(--rule); background: var(--panel); max-width: 720px; }
  .field {
    display: grid; grid-template-columns: 1fr 210px; gap: 16px;
    align-items: center; padding: 13px 17px;
    border-bottom: 1px solid var(--rule-soft);
  }
  .field:last-of-type { border-bottom: 0; }
  .field .k { font-family: var(--sans); font-size: 13px; }
  .field .p { color: var(--faint); font-size: 11px; margin-top: 3px; }
  .field input[type=number], .field input[type=text] {
    background: var(--panel-2); border: 1px solid var(--rule); padding: 7px 10px; width: 100%;
  }
  .save {
    background: var(--amber); color: #0b181f; border: 0;
    padding: 10px 20px; cursor: pointer; font-weight: 600;
    font-family: var(--sans); letter-spacing: .05em;
  }
  .save:disabled { opacity: .4; cursor: not-allowed; }
  .note { margin-top: 12px; font-size: 12px; }
  .note.ok { color: var(--verdigris); }
  .note.bad { color: var(--rust); }

  pre {
    background: var(--panel); border: 1px solid var(--rule);
    padding: 17px; overflow-x: auto; font-size: 12px; color: var(--dim);
  }

  .empty { padding: 42px; text-align: center; color: var(--faint); }

  @media (max-width: 820px) {
    .frame { grid-template-columns: 1fr; }
    nav { position: static; height: auto; flex-direction: row; overflow-x: auto; }
    .brand, .navfoot { display: none; }
    main { padding: 20px 16px 50px; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<div class="frame">
  <nav>
    <div class="brand">gms<span>.</span><small>sweep control</small></div>
    <a href="#overview" class="on" data-tab="overview">Overview</a>
    <a href="#sweep" data-tab="sweep">Sweep</a>
    <a href="#leads" data-tab="leads">Leads</a>
    <a href="#issues" data-tab="issues">Issues</a>
    <a href="#config" data-tab="config">Settings</a>
    <div class="navfoot">
      <div class="label" id="pulse">reading…</div>
    </div>
  </nav>

  <main>
    <section id="overview" class="on">
      <h2>Overview</h2>
      <div class="sub" id="ov-sub"></div>
      <div class="readout" id="ov-jobs"></div>
      <div class="label" style="margin:26px 0 11px">What the sweep produced</div>
      <div class="readout" id="ov-yield"></div>
      <div class="label" style="margin:26px 0 11px">Website crawl</div>
      <div class="readout" id="ov-domains"></div>
    </section>

    <section id="sweep">
      <h2>Sweep plate</h2>
      <div class="sub">One cell per city. Fill height is the share of its categories finished.</div>
      <div class="tools">
        <button class="chip" data-by="city" aria-pressed="true">By city</button>
        <button class="chip" data-by="state" aria-pressed="false">By state</button>
        <button class="chip" data-by="category" aria-pressed="false">By category</button>
      </div>
      <div class="plate" id="plate"></div>
      <div class="legend label">
        <span><i style="background:var(--verdigris);opacity:.65"></i>complete</span>
        <span><i style="background:var(--amber);opacity:.5"></i>in progress</span>
        <span><i style="background:var(--panel-2);border:1px solid var(--rust)"></i>has failures</span>
        <span id="plate-count"></span>
      </div>
    </section>

    <section id="leads">
      <h2>Leads</h2>
      <div class="sub" id="leads-sub"></div>
      <div class="tools">
        <input type="search" id="q" placeholder="Search name, city, email, site…">
        <select id="state"><option value="">All states</option></select>
        <button class="chip" id="f-email" aria-pressed="false">Has email</button>
        <button class="chip" id="f-phone" aria-pressed="false">Has phone</button>
      </div>
      <div class="wrap"><table>
        <thead><tr>
          <th>Business</th><th>Category</th><th>Phone</th><th>Email</th>
          <th>Where</th><th>Rating</th><th>Site</th>
        </tr></thead>
        <tbody id="leads-body"></tbody>
      </table></div>
      <div class="tools" style="margin-top:13px">
        <button class="chip" id="prev">Previous</button>
        <span class="label" id="page-of"></span>
        <button class="chip" id="next">Next</button>
      </div>
    </section>

    <section id="issues">
      <h2>Issues</h2>
      <div class="sub">Jobs that exhausted their attempts, and where each stopped.</div>
      <div class="tools"><button class="chip" id="retry">Retry all failed</button></div>
      <div class="wrap"><table>
        <thead><tr><th>Job</th><th>Search</th><th>Tries</th><th>Kind</th><th>Error</th></tr></thead>
        <tbody id="fail-body"></tbody>
      </table></div>
      <div class="label" style="margin:26px 0 11px">Export cursors</div>
      <div class="wrap"><table>
        <thead><tr><th>Exporter</th><th>Entity</th><th>Position</th><th>Rows</th><th>Target</th></tr></thead>
        <tbody id="exp-body"></tbody>
      </table></div>
    </section>

    <section id="config">
      <h2>Settings</h2>
      <div class="sub" id="cfg-sub"></div>
      <div class="fields" id="cfg-fields"></div>
      <div class="tools" style="margin-top:15px">
        <button class="save" id="save">Save changes</button>
      </div>
      <div class="note" id="cfg-note"></div>
      <div class="label" style="margin:30px 0 11px">Effective configuration (secrets removed)</div>
      <pre id="cfg-json"></pre>
    </section>
  </main>
</div>

<script>
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const num = (n) => (n ?? 0).toLocaleString();
const get = (u) => fetch(u).then((r) => r.json());

function duration(ms) {
  if (ms == null) return 'unknown';
  const h = ms / 3600000;
  if (h < 1) return Math.round(ms / 60000) + 'm';
  if (h < 48) return h.toFixed(1) + 'h';
  return (h / 24).toFixed(1) + ' days';
}

function readout(target, cells) {
  $(target).innerHTML = cells.map((c) =>
    '<div class="cell"><span class="label">' + esc(c.k) + '</span>' +
    '<span class="n ' + (c.tone || '') + '">' + esc(c.v) +
    (c.of ? ' <span class="of">/ ' + esc(c.of) + '</span>' : '') + '</span></div>').join('');
}

// ── Tabs ───────────────────────────────────────────────────────────────
function show(tab) {
  $$('section').forEach((s) => s.classList.toggle('on', s.id === tab));
  $$('nav a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  if (tab === 'sweep') loadPlate();
  if (tab === 'leads') loadLeads();
  if (tab === 'issues') loadIssues();
  if (tab === 'config') loadConfig();
}
$$('nav a').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault(); location.hash = a.dataset.tab; show(a.dataset.tab);
}));

// ── Overview ───────────────────────────────────────────────────────────
async function loadOverview() {
  const o = await get('/api/overview');
  const done = o.jobs.done + o.jobs.skipped;
  const pct = o.jobsTotal ? Math.round((done / o.jobsTotal) * 100) : 0;

  $('#ov-sub').textContent =
    o.seeds.cities + ' cities x ' + o.seeds.categories + ' categories · ' +
    num(o.jobsTotal) + ' jobs · ' + pct + '% swept';

  readout('#ov-jobs', [
    { k: 'Done', v: num(done), of: num(o.jobsTotal), tone: 'ok' },
    { k: 'Running', v: num(o.jobs.leased), tone: o.jobs.leased ? 'hi' : '' },
    { k: 'Queued', v: num(o.jobs.pending) },
    { k: 'Failed', v: num(o.jobs.failed), tone: o.jobs.failed ? 'bad' : '' },
    { k: 'Per hour', v: num(o.throughputPerHour) },
    { k: 'Remaining', v: duration(o.etaMs) },
  ]);

  readout('#ov-yield', [
    { k: 'Businesses', v: num(o.businesses) },
    { k: 'With phone', v: num(o.withPhone), of: num(o.businesses) },
    { k: 'With website', v: num(o.withWebsite), of: num(o.businesses) },
    { k: 'With email', v: num(o.withEmail), of: num(o.businesses), tone: 'ok' },
    { k: 'Addresses', v: num(o.emails.usable), tone: 'hi' },
    { k: 'Named person', v: num(o.emails.personal), of: num(o.emails.usable) },
  ]);

  const d = o.domains || {};
  readout('#ov-domains', [
    { k: 'Crawled', v: num(d.done), tone: 'ok' },
    { k: 'Queued', v: num(d.pending) },
    { k: 'Unreachable', v: num(d.failed), tone: d.failed ? 'bad' : '' },
    { k: 'Parked', v: num(d.parked) },
    { k: 'Skipped', v: num(d.skipped) },
  ]);

  $('#pulse').textContent = o.jobs.leased > 0
    ? o.jobs.leased + ' running'
    : (o.jobs.pending > 0 ? 'idle · ' + num(o.jobs.pending) + ' queued' : 'sweep complete');
}

// ── Sweep plate ────────────────────────────────────────────────────────
let plateBy = 'city';
$$('[data-by]').forEach((b) => b.addEventListener('click', () => {
  plateBy = b.dataset.by;
  $$('[data-by]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  loadPlate();
}));

async function loadPlate() {
  const groups = await get('/api/progress?by=' + plateBy);
  if (!groups.length) {
    $('#plate').innerHTML = '<div class="empty">Nothing planned yet. Run <b>gms plan</b>.</div>';
    return;
  }
  $('#plate').innerHTML = groups.map((g) => {
    const share = g.total ? (g.done + g.skipped) / g.total : 0;
    const complete = g.pending + g.leased + g.failed === 0;
    const title = g.label + (g.sublabel ? ', ' + g.sublabel : '') +
      ' — ' + g.done + '/' + g.total + ' done' +
      (g.failed ? ', ' + g.failed + ' failed' : '') +
      (g.leased ? ', ' + g.leased + ' running' : '');
    return '<div class="tile' + (complete ? ' done' : '') + (g.failed ? ' fail' : '') +
      '" title="' + esc(title) + '">' +
      '<i style="height:' + (share * 100).toFixed(1) + '%"></i>' +
      '<b>' + esc(g.sublabel || g.label.slice(0, 4)) + '</b></div>';
  }).join('');
  const complete = groups.filter((g) => g.pending + g.leased + g.failed === 0).length;
  $('#plate-count').textContent = complete + ' of ' + groups.length + ' complete';
}

// ── Leads ──────────────────────────────────────────────────────────────
let page = 0, statesLoaded = false;
const LIMIT = 100;

async function loadLeads() {
  const p = new URLSearchParams({
    search: $('#q').value, state: $('#state').value,
    hasEmail: $('#f-email').getAttribute('aria-pressed') === 'true' ? '1' : '0',
    hasPhone: $('#f-phone').getAttribute('aria-pressed') === 'true' ? '1' : '0',
    limit: String(LIMIT), offset: String(page * LIMIT),
  });
  const d = await get('/api/leads?' + p);

  if (!statesLoaded && d.states) {
    $('#state').innerHTML = '<option value="">All states</option>' +
      d.states.map((s) => '<option>' + esc(s) + '</option>').join('');
    statesLoaded = true;
  }

  $('#leads-sub').textContent = num(d.total) + ' matching';
  $('#page-of').textContent = d.total
    ? (page * LIMIT + 1) + '–' + Math.min((page + 1) * LIMIT, d.total) + ' of ' + num(d.total) : '';

  $('#leads-body').innerHTML = d.rows.length ? d.rows.map((r) =>
    '<tr>' +
    '<td class="nm">' + esc(r.name) + '</td>' +
    '<td class="muted">' + esc(r.category || '') + '</td>' +
    '<td>' + esc(r.phone || '') + '</td>' +
    '<td>' + (r.email
      ? esc(r.email) + ' <span class="tag ' + esc(r.email_type) + '">' + esc(r.email_type) + '</span>'
      : '<span class="muted">—</span>') + '</td>' +
    '<td class="muted">' + esc([r.city, r.state].filter(Boolean).join(', ')) + '</td>' +
    '<td>' + (r.rating ?? '') + '</td>' +
    '<td>' + (r.website ? '<a href="' + esc(r.website) + '" target="_blank" rel="noopener">open</a>' : '') + '</td>' +
    '</tr>').join('')
    : '<tr><td colspan="7" class="empty">No leads match. Run <b>gms run</b> to collect some.</td></tr>';
}

let typing;
$('#q').addEventListener('input', () => {
  clearTimeout(typing);
  typing = setTimeout(() => { page = 0; loadLeads(); }, 250);
});
$('#state').addEventListener('change', () => { page = 0; loadLeads(); });
['#f-email', '#f-phone'].forEach((id) => $(id).addEventListener('click', () => {
  const el = $(id);
  el.setAttribute('aria-pressed', el.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
  page = 0; loadLeads();
}));
$('#prev').addEventListener('click', () => { if (page > 0) { page--; loadLeads(); } });
$('#next').addEventListener('click', () => { page++; loadLeads(); });

// ── Issues ─────────────────────────────────────────────────────────────
async function loadIssues() {
  const [fails, exports] = await Promise.all([get('/api/failures'), get('/api/exports')]);

  $('#fail-body').innerHTML = fails.length ? fails.map((f) => {
    let where = f.task_key;
    try { const p = JSON.parse(f.params_json); if (p.category) where = p.category + ' in ' + p.city + ', ' + p.stateCode; } catch {}
    return '<tr><td>' + f.id + '</td><td class="nm">' + esc(where) + '</td>' +
      '<td>' + f.attempts + '/' + f.max_attempts + '</td>' +
      '<td class="muted">' + esc(f.last_error_kind || '') + '</td>' +
      '<td class="muted">' + esc((f.last_error || '').slice(0, 110)) + '</td></tr>';
  }).join('') : '<tr><td colspan="5" class="empty">No failures.</td></tr>';

  $('#exp-body').innerHTML = exports.length ? exports.map((c) =>
    '<tr><td>' + esc(c.exporter) + '</td><td>' + esc(c.entity) + '</td>' +
    '<td>' + num(c.last_id) + '</td><td>' + num(c.rows_total) + '</td>' +
    '<td class="muted">' + esc(c.target) + '</td></tr>').join('')
    : '<tr><td colspan="5" class="empty">Nothing exported yet.</td></tr>';
}

$('#retry').addEventListener('click', async () => {
  const r = await fetch('/api/jobs/retry', { method: 'POST' }).then((x) => x.json());
  $('#retry').textContent = 'Requeued ' + r.retried;
  loadIssues(); loadOverview();
});

// ── Settings ───────────────────────────────────────────────────────────
async function loadConfig() {
  const c = await get('/api/config');
  $('#cfg-sub').textContent = c.writable
    ? 'Changes are written to gms.config.local.yaml and apply to the next run.'
    : 'Read-only. Restart with --allow-config-write to edit here.';

  $('#cfg-fields').innerHTML = c.editable.map((f) => {
    const id = 'f_' + f.path.replace(/\./g, '_');
    let control;
    if (f.kind === 'boolean') {
      control = '<select id="' + id + '" data-path="' + esc(f.path) + '">' +
        '<option value="true"' + (f.value ? ' selected' : '') + '>On</option>' +
        '<option value="false"' + (!f.value ? ' selected' : '') + '>Off</option></select>';
    } else if (f.kind === 'range') {
      control = '<input type="text" id="' + id + '" data-path="' + esc(f.path) +
        '" data-kind="range" value="' + esc((f.value || []).join(', ')) + '">';
    } else {
      control = '<input type="number" id="' + id + '" data-path="' + esc(f.path) +
        '" value="' + esc(f.value) + '">';
    }
    return '<div class="field"><div><div class="k">' + esc(f.label) + '</div>' +
      '<div class="p">' + esc(f.path) + '</div></div>' + control + '</div>';
  }).join('');

  $('#save').disabled = !c.writable;
  $('#cfg-json').textContent = JSON.stringify(c.config, null, 2);
}

$('#save').addEventListener('click', async () => {
  const updates = {};
  $$('#cfg-fields [data-path]').forEach((el) => {
    const path = el.dataset.path;
    if (el.tagName === 'SELECT') updates[path] = el.value === 'true';
    else if (el.dataset.kind === 'range') {
      updates[path] = el.value.split(',').map((n) => Number(n.trim())).filter((n) => !isNaN(n));
    } else updates[path] = Number(el.value);
  });

  const note = $('#cfg-note');
  const r = await fetch('/api/config', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(updates),
  }).then((x) => x.json());

  note.className = 'note ' + (r.error ? 'bad' : 'ok');
  note.textContent = r.error ? r.error : r.note;
  if (!r.error) loadConfig();
});

// ── Boot ───────────────────────────────────────────────────────────────
loadOverview();
setInterval(loadOverview, 5000);

// Changing the hash is a same-document navigation, so the script does not
// re-run. Without this listener, back/forward and a pasted #leads link leave
// the page showing whatever tab was already open.
const routeFromHash = () => {
  const tab = location.hash.slice(1);
  show(document.getElementById(tab) ? tab : 'overview');
};
window.addEventListener('hashchange', routeFromHash);
routeFromHash();
</script>
</body>
</html>`;
