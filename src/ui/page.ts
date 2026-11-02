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

  /* ── Control: numbered steps, because this genuinely is a sequence ──── */
  .step {
    border: 1px solid var(--rule); background: var(--panel);
    margin-bottom: 13px; padding: 17px 19px;
    display: grid; grid-template-columns: 34px 1fr auto; gap: 17px; align-items: start;
  }
  .step.blocked { opacity: .45; }
  .step .idx {
    font: 400 19px/1 var(--mono); color: var(--faint);
    border: 1px solid var(--rule); width: 34px; height: 34px;
    display: flex; align-items: center; justify-content: center;
  }
  .step.ready .idx { color: var(--amber); border-color: var(--amber); }
  .step.satisfied .idx { color: var(--verdigris); border-color: var(--verdigris); }
  .step h3 { margin: 0 0 3px; font: 600 15px/1.3 var(--sans); }
  .step p { margin: 0; color: var(--dim); font-size: 12px; }
  .step .opts { display: flex; gap: 9px; flex-wrap: wrap; margin-top: 13px; align-items: center; }
  .step .opts label { font: 500 11px/1 var(--sans); color: var(--faint); letter-spacing: .05em; }
  .step .opts input[type=number] { width: 78px; }
  .step .opts input[type=number], .step .opts input[type=text], .step .opts select {
    background: var(--panel-2); border: 1px solid var(--rule); padding: 6px 9px;
  }
  .step .opts input[type=file] { font-size: 11px; color: var(--dim); max-width: 260px; }

  .go {
    background: var(--amber); color: #0b181f; border: 0;
    padding: 10px 19px; cursor: pointer; font-weight: 600;
    font-family: var(--sans); letter-spacing: .04em; white-space: nowrap;
  }
  .go.ghost { background: transparent; color: var(--dim); border: 1px solid var(--rule); }
  a.go { display: inline-block; text-decoration: none; }
  a.go.ghost:hover { color: var(--ink); border-color: var(--amber); }
  .go.stop { background: var(--rust); color: #fff; }
  .go:disabled { opacity: .35; cursor: not-allowed; }

  .runbar {
    display: flex; flex-direction: column; gap: 0;
    border: 1px solid var(--rule); background: var(--panel);
    padding: 13px 17px; margin-bottom: 11px;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); flex: none; }
  .dot.live { background: var(--amber); animation: pulse 1.4s ease-in-out infinite; }
  .dot.ok { background: var(--verdigris); }
  .dot.bad { background: var(--rust); }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }

  .console {
    max-height: 340px; overflow-y: auto; white-space: pre-wrap;
    word-break: break-word; font-size: 11.5px; line-height: 1.65; margin: 0;
  }

  /* ── Cities and services ───────────────────────────────────────────── */
  .meter {
    display: inline-block; vertical-align: middle;
    width: 90px; height: 6px; margin-right: 9px;
    background: var(--panel-2); border: 1px solid var(--rule-soft);
  }
  .meter i { display: block; height: 100%; background: var(--amber); opacity: .7; }
  .meter.full i { background: var(--verdigris); }
  tr.off td { color: var(--faint); }
  tr.off td.nm { text-decoration: line-through; text-decoration-color: var(--rule); }
  .tag.complete { color: var(--verdigris); }
  .tag.running, .tag.in-progress { color: var(--amber); }
  .tag.queued, .tag.not-planned { color: var(--dim); }
  .tag.paused, .tag.on-hold { color: var(--faint); }
  .tag.needs-retry { color: var(--rust); }
  .acts { white-space: nowrap; text-align: right; }
  .act {
    background: none; border: 0; padding: 0 0 0 13px; cursor: pointer;
    color: var(--dim); font: 500 11px/1 var(--sans); letter-spacing: .05em;
  }
  .act:hover { color: var(--amber); }
  .act.danger:hover { color: var(--rust); }
  .spacer { flex: 1; }
  .editor {
    border: 1px solid var(--amber); background: var(--panel);
    padding: 15px 17px; margin-bottom: 15px;
  }
  .editor .opts { display: flex; gap: 11px; flex-wrap: wrap; align-items: flex-end; }
  .editor label { display: flex; flex-direction: column; gap: 6px; }
  .editor label span { font: 500 10px/1 var(--sans); letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }
  .editor input {
    background: var(--panel-2); border: 1px solid var(--rule); padding: 7px 10px;
  }
  .editor input::placeholder { color: var(--faint); }
  .editor .p { color: var(--faint); font-size: 11px; margin-top: 10px; }
  .step details { margin-top: 13px; }
  .aprow { display: flex; gap: 11px; align-items: center; font-size: 12px; margin-bottom: 6px; }
  .aprow .nm { min-width: 150px; }
  .step.autopilot .idx { font-size: 17px; }
  .runrow { display: flex; align-items: center; gap: 13px; padding: 7px 0; cursor: pointer; }
  .runrow + .runrow { border-top: 1px solid var(--rule-soft); }
  .runrow.shown > span:nth-child(2) { color: var(--amber); }
  .good { color: var(--verdigris); }
  .warn { color: var(--amber); }
  .bad { color: var(--rust); }
  .checks { list-style: none; margin: 13px 0 0; padding: 0; font-size: 12px; }
  .checks li { margin-bottom: 7px; }
  .checks .muted { white-space: pre-wrap; margin: 3px 0 0 16px; }
  .states { gap: 5px; }
  .chip.st { padding: 6px 8px; min-width: 52px; text-align: left; }
  .chip.st small {
    display: block; margin-top: 4px;
    font: 400 9px/1 var(--mono); letter-spacing: 0; text-transform: none; color: var(--faint);
  }
  .next { margin: 8px 0 0; padding-left: 22px; color: var(--ink); font-size: 12px; columns: 2; column-gap: 34px; }
  .next li { margin-bottom: 3px; }
  .step summary { cursor: pointer; color: var(--dim); font: 500 12px/1.4 var(--sans); }
  .step summary:hover { color: var(--ink); }

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
    <a href="#control" data-tab="control">Control</a>
    <a href="#cities" data-tab="cities">Cities</a>
    <a href="#categories" data-tab="categories">Services</a>
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

    <section id="control">
      <h2>Control</h2>
      <div class="sub" id="ctl-sub"></div>

      <div id="autopilot"></div>
      <div id="steps"></div>

      <div class="label" style="margin:30px 0 11px">Activity</div>
      <div class="runbar" id="runbar"></div>
      <pre class="console" id="log">No task has run yet.</pre>
    </section>

    <section id="cities">
      <h2>Cities</h2>
      <div class="sub" id="cities-sub"></div>
      <div class="tools">
        <input type="search" id="cities-q" placeholder="Search city, state or zip…">
        <span class="spacer"></span>
        <button class="go ghost" id="cities-save" title="Write these lists to the project's seeds/ folder">Save to seeds/</button>
        <button class="go" id="cities-add">Add city</button>
      </div>
      <div class="tools" id="cities-chips"></div>
      <div id="cities-form"></div>
      <div class="note" id="cities-note"></div>
      <div class="wrap"><table>
        <thead><tr>
          <th>City</th><th>State</th><th>Zip</th><th>Searches</th><th>Leads</th>
          <th>Last search</th><th>Status</th><th></th>
        </tr></thead>
        <tbody id="cities-body"></tbody>
      </table></div>
    </section>

    <section id="categories">
      <h2>Services</h2>
      <div class="sub" id="categories-sub"></div>
      <div class="tools">
        <input type="search" id="categories-q" placeholder="Search services…">
        <span class="spacer"></span>
        <button class="go ghost" id="categories-save" title="Write these lists to the project's seeds/ folder">Save to seeds/</button>
        <button class="go" id="categories-add">Add service</button>
      </div>
      <div class="tools" id="categories-chips"></div>
      <div id="categories-form"></div>
      <div class="note" id="categories-note"></div>
      <div class="wrap"><table>
        <thead><tr>
          <th>Service</th><th>Weight</th><th>Searches</th><th>Leads</th>
          <th>Last search</th><th>Status</th><th></th>
        </tr></thead>
        <tbody id="categories-body"></tbody>
      </table></div>
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
      <div class="tools"><button class="chip" id="retry">Retry all failed</button>
        <button class="chip" id="rescrape">Re-scrape finished searches</button></div>
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
  if (tab === 'control') loadControl();
  if (tab === 'cities' || tab === 'categories') loadSeeds(tab);
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
    ...(o.jobs.paused ? [{ k: 'Paused', v: num(o.jobs.paused) }] : []),
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

  // A lease is not a running process: an aborted run leaves one held until the
  // reaper reclaims it, and calling that "running" sends people looking for a
  // process that already exited.
  $('#pulse').textContent = ctlState.running
    ? 'working · ' + ctlState.running.label.toLowerCase()
    : o.jobs.leased > 0
      ? o.jobs.leased + ' job(s) leased'
      : o.jobs.pending > 0
        ? 'idle · ' + num(o.jobs.pending) + ' queued'
        : o.jobsTotal > 0 ? 'sweep complete' : 'no jobs yet';
}

// ── Control ────────────────────────────────────────────────────────────
// Steps are numbered because this really is a sequence: you cannot plan jobs
// before importing seeds, or find emails before scraping websites. The number
// encodes a dependency, not decoration.
let ctlState = { enabled: false, running: null, tasks: [] };
let ctlOverview = null;
let uploaded = { cities: null, categories: null };

async function loadControl() {
  const [t, o, q, g, a] = await Promise.all([
    get('/api/tasks'), get('/api/overview'), get('/api/queue'), get('/api/sheets/settings'),
    get('/api/autopilot')]);
  ctlState = t; ctlOverview = o; queue = q; sheets = g; auto = a;
  renderAutopilot(true);

  $('#ctl-sub').textContent = t.enabled
    ? 'Run everything from here. Each step unlocks when the one before it is done.'
    : 'Read-only. Restart with --control to run tasks from this page.';

  const hasSeeds = o.seeds.cities > 0 && o.seeds.categories > 0;
  const hasJobs = o.jobsTotal > 0;
  const hasBusinesses = o.businesses > 0;
  const hasDomains = (o.domains.pending || 0) + (o.domains.done || 0) > 0;
  // Each button waits only for its own task: finding emails while a scrape runs
  // is the normal case, not a conflict.
  const runningNames = new Set(t.tasks.filter((x) => x.state === 'running').map((x) => x.name));
  const busy = (name) => runningNames.has(name);

  const steps = [
    {
      n: 1, title: 'Your cities and services',
      why: 'They ship with the project in the seeds/ folder and load on the first gms db migrate. Add, edit or pause them on the Cities and Services pages.',
      satisfied: hasSeeds,
      status: hasSeeds ? o.seeds.cities + ' cities · ' + o.seeds.categories + ' services' : null,
      body:
        '<div class="opts"><a class="go ghost" href="#cities">Manage cities</a>' +
        '<a class="go ghost" href="#categories">Manage services</a></div>' +
        '<details' + (hasSeeds ? '' : ' open') + '><summary>Import from a spreadsheet instead</summary>' +
        '<div class="opts">' +
        '<label class="chip">' + (workbook ? 'Change file' : 'Choose file') +
        '<input type="file" id="up-book" accept=".xlsx,.csv" hidden></label>' +
        (workbook ? '<span>' + esc(workbook.name) + '</span>' : '<span class="muted">an .xlsx workbook or a .csv</span>') +
        '</div><div class="opts">' +
        '<label>Cities sheet</label>' + sheetPicker('sheet-cities', /cit/i) +
        '<button class="go ghost" id="do-cities"' + (workbook ? '' : ' disabled') + '>Import cities</button>' +
        '<label>Services sheet</label>' + sheetPicker('sheet-cats', /serv|categ/i) +
        '<button class="go ghost" id="do-cats"' + (workbook ? '' : ' disabled') + '>Import services</button>' +
        '</div><p style="margin-top:9px">Rows are matched by zip and service name, so importing again updates them in place. Nothing is deleted and paused rows stay paused.</p></details>',
    },
    {
      n: 2, title: 'Create the job list',
      why: 'One job per city and service. Costs nothing and starts nothing — it just builds the queue.',
      blocked: !hasSeeds, satisfied: hasJobs,
      status: hasJobs ? num(o.jobsTotal) + ' jobs' : null,
      body:
        '<div class="opts">' +
        '<label>Only these cities</label><input type="text" id="p-cities" placeholder="all" style="width:150px">' +
        '<label>Only these services</label><input type="text" id="p-cats" placeholder="all" style="width:150px">' +
        '<button class="go" id="do-plan"' + (busy('plan') ? ' disabled' : '') + '>Create jobs</button>' +
        '</div>',
    },
    {
      n: 3, title: 'Choose where to search first',
      why: 'Spreading gives every state a search before any state gets its next one, rotating cities and services, so leads from everywhere arrive early. Changes apply from the next search a worker picks up; a running scrape does not need restarting.',
      blocked: !hasJobs, satisfied: hasJobs,
      status: hasJobs ? planText(q.plan) : null,
      body:
        '<div class="opts">' +
        '<label>Order</label><select id="q-order">' +
        '<option value="spread"' + (q.plan.order === 'spread' ? ' selected' : '') + '>Spread across states</option>' +
        '<option value="by-state"' + (q.plan.order === 'by-state' ? ' selected' : '') + '>One state at a time</option></select>' +
        '<label>Chosen states</label><select id="q-scope">' +
        '<option value="first"' + (q.plan.only ? '' : ' selected') + '>Search these first</option>' +
        '<option value="only"' + (q.plan.only ? ' selected' : '') + '>Search only these</option></select>' +
        '<button class="go ghost" id="q-clear">Clear states</button>' +
        '<button class="go" id="do-queue">Apply</button>' +
        '</div><div class="opts states" id="q-states">' + stateChips() + '</div>' +
        '<p style="margin-top:9px">Click states to choose them, then Apply. The number under each is the searches left there. ' +
        'Searching only some states parks the rest as on hold; a city you paused yourself stays paused either way.</p>' +
        '<div class="label" style="margin-top:15px">Next up</div>' +
        '<ol class="next">' + (q.next.length
          ? q.next.map((j) => '<li>' + esc(j.category) + ' <span class="muted">in</span> ' + esc(j.city + ', ' + j.stateCode) + '</li>').join('')
          : '<li class="muted">nothing queued</li>') + '</ol>',
    },
    {
      n: 4, title: 'Collect businesses from Google Maps',
      why: 'Works through the queue. Safe to stop and restart — it picks up exactly where it left off.',
      blocked: !hasJobs, satisfied: hasBusinesses,
      status: hasBusinesses ? num(o.businesses) + ' businesses' : null,
      body:
        '<div class="opts">' +
        '<label>Workers</label><input type="number" id="r-workers" value="4" min="1" max="16">' +
        '<label>Stop after</label><input type="number" id="r-max" placeholder="all" min="1">' +
        '<label><input type="checkbox" id="r-headful"> Show browser</label>' +
        '<button class="go" id="do-run"' + (busy('run') ? ' disabled' : '') + '>Start scraping</button>' +
        '</div>',
    },
    {
      n: 5, title: 'Find email addresses',
      why: 'Crawls each business website. Government and education addresses are excluded.',
      blocked: !hasDomains, satisfied: o.emails.usable > 0,
      status: o.emails.usable > 0 ? num(o.emails.usable) + ' addresses' : null,
      body:
        '<div class="opts">' +
        '<label>Workers</label><input type="number" id="e-workers" value="8" min="1" max="32">' +
        '<label>Stop after</label><input type="number" id="e-max" placeholder="all" min="1">' +
        '<button class="go" id="do-enrich"' + (busy('enrich') ? ' disabled' : '') + '>Find emails</button>' +
        '</div>',
    },
    {
      n: 6, title: 'Export your leads',
      why: 'Writes a CSV of everything new since the last export.',
      blocked: !hasBusinesses, satisfied: false,
      body:
        '<div class="opts">' +
        '<select id="x-entity"><option value="leads-flat">Leads</option>' +
        '<option value="businesses">Businesses</option><option value="emails">Emails</option></select>' +
        '<label><input type="checkbox" id="x-excel"> Excel-safe zips</label>' +
        '<label><input type="checkbox" id="x-split"> One file per state</label>' +
        '<label><input type="checkbox" id="x-full"> Export everything again</label>' +
        '<button class="go" id="do-export"' + (busy('export') ? ' disabled' : '') + '>Export CSV</button>' +
        '</div>',
    },
    {
      n: 7, title: 'Share with your team',
      why: 'Sends new leads to a Google Sheet anyone can open. Run it again any time — it only sends what is new.',
      blocked: !hasBusinesses, satisfied: false,
      status: sheets.spreadsheetId && sheets.keyFound ? 'ready' : null,
      body: sheetsBody(busy('export-sheets')),
    },
  ];

  // Re-rendering happens whenever a task finishes; keep what was typed.
  const kept = {};
  $$('#steps input, #steps select').forEach((el) => {
    if (el.id && el.type !== 'file') kept[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  const openDetails = $('#steps details')?.open;

  $('#steps').innerHTML = steps.map((s) =>
    '<div class="step ' + (s.blocked ? 'blocked' : s.satisfied ? 'satisfied' : 'ready') + '">' +
    '<div class="idx">' + s.n + '</div>' +
    '<div><h3>' + esc(s.title) + '</h3><p>' + esc(s.why) + '</p>' +
    (t.enabled && !s.blocked ? s.body : '') + '</div>' +
    '<div class="label">' + (s.status ? esc(s.status) : s.blocked ? 'waiting' : '') + '</div></div>',
  ).join('');

  for (const [id, value] of Object.entries(kept)) {
    const el = document.getElementById(id);
    if (!el || (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === value))) continue;
    if (el.type === 'checkbox') el.checked = value; else el.value = value;
  }
  if (openDetails !== undefined && $('#steps details')) $('#steps details').open = openDetails;

  if (t.enabled) wireControls();
  renderRun();
}

// ── Autopilot ──────────────────────────────────────────────────────────
// The status lines refresh every few seconds; the settings form only when the
// page reloads it, so a half-typed number is never overwritten.
let auto = { available: false };

const STAGES = [
  ['scrape', 'Scrape Google Maps'],
  ['emails', 'Find emails'],
  ['sheets', 'Send to the sheet'],
];

function renderAutopilot(withForm) {
  const box = $('#autopilot');
  if (!auto.available) { box.innerHTML = ''; return; }
  const st = auto.settings, on = st.enabled;
  const stateDot = { running: 'live', waiting: '', idle: 'ok', blocked: 'bad', off: '' };

  const status =
    STAGES.map(([key, label]) => {
      const s = auto.status[key];
      return '<div class="aprow"><span class="dot ' + stateDot[s.state] + '"></span>' +
        '<span class="nm">' + esc(label) + '</span><span class="muted">' + esc(s.detail) + '</span></div>';
    }).join('') +
    '<div class="aprow"><span class="dot"></span><span class="nm">Memory</span><span class="muted">' +
    num(auto.memory.freeMb) + ' MB free of ' + num(auto.memory.totalMb) + ' MB · new steps wait below ' +
    num(st.minFreeMemoryMb) + ' MB</span></div>' +
    (auto.note ? '<div class="note bad">' + esc(auto.note) + '</div>' : '');

  if (!withForm && $('#ap-status')) {
    $('#ap-status').innerHTML = status;
    return;
  }

  const n = (id, value, min, max, w) =>
    '<input type="number" id="' + id + '" value="' + esc(value) + '" min="' + min + '" max="' + max + '" style="width:' + (w || 78) + 'px">';
  const c = (id, value, text) =>
    '<label><input type="checkbox" id="' + id + '"' + (value ? ' checked' : '') + '> ' + esc(text) + '</label>';
  const wasOpen = $('#ap-settings')?.open;

  box.innerHTML = '<div class="step autopilot' + (on ? ' satisfied' : ' ready') + '">' +
    '<div class="idx">&#8635;</div><div>' +
    '<h3>Autopilot ' + (on ? '<span class="tag complete">on</span>' : '<span class="tag paused">off</span>') + '</h3>' +
    '<p>Keeps scraping, finds emails as websites come in, and sends new leads with an email to the sheet in batches. ' +
    'Leave the dashboard open; it carries on after a restart.</p>' +
    '<div id="ap-status" style="margin-top:12px">' + status + '</div>' +
    '<details id="ap-settings"' + (wasOpen ? ' open' : '') + '><summary>Settings</summary>' +
    '<div class="opts">' + c('ap-scrape', st.scrape.enabled, 'Scrape') +
      '<label>workers</label>' + n('ap-scrape-workers', st.scrape.workers, 1, 8) +
      '<span class="muted">each is a Chrome using 400–700 MB</span></div>' +
    '<div class="opts">' + c('ap-emails', st.emails.enabled, 'Find emails') +
      '<label>workers</label>' + n('ap-emails-workers', st.emails.workers, 1, 32) +
      '<label>start when</label>' + n('ap-emails-min', st.emails.minSites, 1, 10000) +
      '<label>websites are waiting</label></div>' +
    '<div class="opts">' + c('ap-sheets', st.sheets.enabled, 'Send to the sheet') +
      '<label>every</label>' + n('ap-sheets-batch', st.sheets.batchRows, 50, 10000, 90) +
      '<label>leads, or every</label>' + n('ap-sheets-wait', st.sheets.maxWaitMinutes, 10, 1440) +
      '<label>minutes</label><span class="muted">layout: ' + esc(LAYOUTS[sheets.layout].label.toLowerCase()) +
      ' (step 7)</span></div>' +
    '<div class="opts"><label>Start nothing new when free memory is below</label>' +
      n('ap-memory', st.minFreeMemoryMb, 256, 65536, 90) + '<label>MB</label></div>' +
    '<div class="opts"><button class="go ghost" id="ap-save">Save settings</button>' +
      '<button class="go ghost" id="ap-defaults">Recommended settings</button></div>' +
    '<p style="margin-top:9px">The recommended settings suit a 7 GB VPS on one internet address. ' +
    'More scrape workers mostly means Google blocks sooner: raise them one at a time and watch the Issues page.</p>' +
    '</details></div>' +
    '<div><button class="go' + (on ? ' stop' : '') + '" id="ap-toggle">' + (on ? 'Turn off' : 'Turn on') + '</button></div>' +
    '</div>';

  const formSettings = (enabled) => ({
    enabled,
    scrape: { enabled: $('#ap-scrape').checked, workers: Number($('#ap-scrape-workers').value) },
    emails: { enabled: $('#ap-emails').checked, workers: Number($('#ap-emails-workers').value),
      minSites: Number($('#ap-emails-min').value) },
    sheets: { enabled: $('#ap-sheets').checked, batchRows: Number($('#ap-sheets-batch').value),
      maxWaitMinutes: Number($('#ap-sheets-wait').value) },
    minFreeMemoryMb: Number($('#ap-memory').value),
  });
  const send = async (body) => {
    const res = await fetch('/api/autopilot', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const r = await res.json();
    if (!res.ok) { alert(r.error); return; }
    auto = r;
    loadControl();
  };
  $('#ap-toggle').addEventListener('click', () => send(formSettings(!on)));
  $('#ap-save').addEventListener('click', () => send(formSettings(on)));
  // Everything but the switch itself, from the server's own defaults.
  $('#ap-defaults').addEventListener('click', () => send({ enabled: on }));
}

// ── Google Sheets ──────────────────────────────────────────────────────
// Settings and the key are saved by the server into gms.config.local.yaml and
// ~/gms-credentials. The key's contents never come back to the page; only the
// address it authenticates as, which is what the sheet must be shared with.
let sheets = { spreadsheetId: null, layout: 'business', sheetName: 'Leads by business', credentialsFile: null, keyFound: false, clientEmail: null, writable: false };

/** The sheet layouts, the export each sends, and each one's usual tab. */
const LAYOUTS = {
  business: { label: 'One row per business', entity: 'leads-by-business', tab: 'Leads by business' },
  email: { label: 'One row per email', entity: 'leads-with-email', tab: 'Leads' },
  all: { label: 'Every lead, with or without email', entity: 'leads-flat', tab: 'Leads' },
};
let sheetsCheck = null;
let sheetsNote = null;

function sheetsBody(busy) {
  const url = sheets.spreadsheetId ? 'https://docs.google.com/spreadsheets/d/' + sheets.spreadsheetId + '/edit' : '';
  const off = sheets.writable ? '' : ' disabled';
  const key = sheets.keyFound
    ? '<span class="good">&#10003; ' + esc(sheets.clientEmail || 'service account') + '</span>'
    : sheets.credentialsFile
      ? '<span class="bad">not found: ' + esc(sheets.credentialsFile) + '</span>'
      : '<span class="muted">none yet</span>';
  const marks = { ok: '<span class="good">&#10003;</span>', warn: '<span class="warn">!</span>', fail: '<span class="bad">&#10007;</span>' };
  return '<div class="opts">' +
    '<label>Sheet</label><input type="text" id="g-sheet" placeholder="paste the sheet’s link" style="width:380px" value="' + esc(url) + '"' + off + '>' +
    '<label>Tab</label><input type="text" id="g-tab" style="width:150px" value="' + esc(sheets.sheetName) + '"' + off + '>' +
    '<button class="go ghost" id="g-save"' + off + '>Save</button>' +
    '<span class="warn" id="g-dirty" hidden>not saved yet</span>' +
    (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">open the sheet</a>' : '') +
    '</div><div class="opts"><label>Layout</label><select id="g-layout"' + off + '>' +
    Object.entries(LAYOUTS).map(([k, l]) =>
      '<option value="' + k + '"' + (k === sheets.layout ? ' selected' : '') + '>' + esc(l.label) + '</option>').join('') +
    '</select><span class="muted">' + esc(sheets.layout === 'business'
      ? 'best address first, the rest in "other emails"; sent once its website has been checked'
      : sheets.layout === 'email' ? 'a business with three addresses fills three rows'
      : 'also businesses with no email yet, which appear again once one is found') + '</span>' +
    '</div><div class="opts"><label>Key file</label>' + key +
    '<label class="chip">' + (sheets.keyFound ? 'Replace key' : 'Choose key file') +
    '<input type="file" id="g-key" accept=".json,application/json" hidden' + off + '></label></div>' +
    '<p style="margin-top:9px">' + (sheets.clientEmail
      ? 'In the sheet, press Share and add <b>' + esc(sheets.clientEmail) + '</b> as an Editor.'
      : 'The key is the .json file downloaded for the service account in Google Cloud: IAM &amp; Admin → Service accounts → Keys → Add key → JSON. It is stored in your user folder, never in the project.') + '</p>' +
    '<div class="opts"><button class="go ghost" id="g-test">Test connection</button>' +
    '<button class="go" id="do-sheets"' + (busy || !sheets.spreadsheetId ? ' disabled' : '') + '>Send to Sheet</button></div>' +
    (sheetsNote ? '<div class="note ' + sheetsNote.tone + '">' + esc(sheetsNote.text) + '</div>' : '') +
    (sheetsCheck ? '<ul class="checks">' + sheetsCheck.map((c) =>
      '<li>' + marks[c.status] + ' <b>' + esc(c.name) + '</b> ' + esc(c.detail) +
      (c.hint && c.status !== 'ok' ? '<div class="muted">' + esc(c.hint) + '</div>' : '') + '</li>').join('') + '</ul>' : '');
}

/** The id in whatever was pasted, as the server will read it. */
function sheetIdOf(text) {
  const t = String(text || '').trim();
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(t);
  return m ? m[1] : t;
}

/** Whether the Sheet or Tab box differs from what is saved. */
function sheetsDirty() {
  const sheet = $('#g-sheet'), tab = $('#g-tab');
  if (!sheet) return false;
  return sheetIdOf(sheet.value) !== (sheets.spreadsheetId || '') ||
    tab.value.trim() !== sheets.sheetName || $('#g-layout').value !== sheets.layout;
}

/** Save the Sheet and Tab boxes. Returns false, with the reason shown, on failure. */
async function saveSheets() {
  const r = await sheetsPost('/api/sheets/settings',
    JSON.stringify({ spreadsheet: $('#g-sheet').value, sheetName: $('#g-tab').value,
      layout: $('#g-layout').value }), 'application/json');
  if (!r) return false;
  sheets = r;
  sheetsNote = { tone: r.warning ? 'bad' : 'ok', text: r.warning || 'Saved. The next export uses it.' };
  sheetsCheck = null;
  return true;
}

async function sheetsPost(url, body, contentType) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': contentType }, body });
  const r = await res.json();
  if (!res.ok) { sheetsNote = { tone: 'bad', text: r.error }; loadControl(); return null; }
  return r;
}

// ── Queue order ────────────────────────────────────────────────────────
let queue = { plan: { order: 'spread', states: [], only: false }, states: [], next: [] };
/** States toggled but not yet applied. null means "whatever the plan says". */
let queueDraft = null;

function planText(p) {
  const order = p.order === 'spread' ? 'spread' : 'one state at a time';
  if (!p.states.length) return order + ' · all states';
  const list = p.states.length > 4 ? p.states.length + ' states' : p.states.join(', ');
  return order + ' · ' + (p.only ? 'only ' + list : list + ' first');
}

function stateChips() {
  const chosen = new Set(queueDraft ?? queue.plan.states);
  return queue.states.map((st) =>
    '<button class="chip st" data-state="' + esc(st.code) + '" aria-pressed="' + chosen.has(st.code) + '" title="' +
    esc(st.name + ': ' + num(st.done) + ' searches done, ' + num(st.remaining) + ' to go') + '">' +
    esc(st.code) + '<small>' + (st.remaining ? num(st.remaining) : 'done') + '</small></button>').join('');
}

/** A sheet chooser for the uploaded workbook, preselecting the likely sheet. */
function sheetPicker(id, likely) {
  if (!workbook) return '<select id="' + id + '" disabled><option>choose a file first</option></select>';
  if (!workbook.sheets) return '<select id="' + id + '" disabled><option value="">CSV: whole file</option></select>';
  const pick = workbook.sheets.find((n) => likely.test(n));
  return '<select id="' + id + '">' + workbook.sheets.map((n) =>
    '<option' + (n === pick ? ' selected' : '') + '>' + esc(n) + '</option>').join('') + '</select>';
}

/** Which task's output the log shows. null: the newest running one. */
let shownTaskId = null;

function renderRun() {
  const running = ctlState.tasks.filter((x) => x.state === 'running');
  const last = ctlState.tasks[0];
  const shown = ctlState.tasks.find((x) => x.id === shownTaskId) || running[0] || last;

  const row = (task) => {
    const live = task.state === 'running';
    const dot = live ? 'live' : task.state === 'succeeded' ? 'ok' : task.state === 'failed' ? 'bad' : '';
    return '<div class="runrow' + (task === shown ? ' shown' : '') + '" data-task="' + esc(task.id) + '">' +
      '<span class="dot ' + dot + '"></span>' +
      '<span>' + esc(task.label) + '</span>' +
      '<span class="label">' + esc(live ? 'running · since ' + new Date(task.startedAt).toLocaleTimeString() : task.state) + '</span>' +
      (live ? '<button class="go stop" data-stop="' + esc(task.id) + '" style="margin-left:auto">Stop</button>' : '') +
      '</div>';
  };
  const rows = running.length ? running : last ? [last] : [];
  $('#runbar').innerHTML = rows.length
    ? rows.map(row).join('')
    : '<div class="runrow"><span class="dot"></span><span class="label">nothing running</span></div>';

  const log = $('#log');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  log.textContent = shown && shown.lines.length
    ? shown.lines.map(readable).join('\n') : 'No output yet.';
  if (atBottom) log.scrollTop = log.scrollHeight;
}

// One listener for every row: rows are re-rendered every poll.
$('#runbar').addEventListener('click', async (e) => {
  const stop = e.target.closest('[data-stop]');
  if (stop) {
    stop.disabled = true;
    await fetch('/api/tasks/stop', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: stop.dataset.stop }) });
    loadControl();
    return;
  }
  const rowEl = e.target.closest('[data-task]');
  if (rowEl) { shownTaskId = rowEl.dataset.task; renderRun(); }
});

/**
 * Render one output line for a human.
 *
 * The child logs structured NDJSON — right for the log file, unreadable in a
 * panel. Show the message and the few fields that carry meaning, and drop the
 * envelope. Anything that is not JSON is already human-readable CLI output and
 * passes through untouched.
 */
function readable(line) {
  if (line[0] !== '{') return line;
  let e;
  try { e = JSON.parse(line); } catch { return line; }
  if (!e.msg) return line;

  const time = e.time ? new Date(e.time).toLocaleTimeString() : '';
  const detail = ['query', 'domain', 'taskKey', 'found', 'records', 'emails', 'pages', 'reason', 'count']
    .filter((k) => e[k] !== undefined)
    .map((k) => k + '=' + e[k])
    .join(' ');
  const level = e.level === 'error' || e.level === 'fatal' ? '! '
    : e.level === 'warn' ? '~ ' : '  ';
  return time + level + e.msg + (detail ? '  ' + detail : '');
}

async function startTask(command, options) {
  const r = await fetch('/api/tasks/start', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, options }),
  }).then((x) => x.json());
  if (r.error) { alert(r.error); return; }
  loadControl();
}

/** The workbook uploaded for step 1, kept across re-renders. */
let workbook = null;

async function uploadWorkbook(file) {
  const r = await fetch('/api/upload?name=' + encodeURIComponent(file.name), {
    method: 'POST', body: file,
  }).then((x) => x.json());
  if (r.error) { alert(r.error); return; }
  let sheets = null;
  if (!/\.csv$/i.test(file.name)) {
    const listed = await get('/api/sheets?file=' + encodeURIComponent(r.file));
    if (listed.error) { alert(listed.error); return; }
    sheets = listed.sheets;
  }
  workbook = { file: r.file, name: file.name, sheets };
  loadControl();
}

function wireControls() {
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };

  const book = $('#up-book');
  if (book) book.addEventListener('change', () => { if (book.files[0]) uploadWorkbook(book.files[0]); });
  on('#do-cities', () => workbook && startTask('import-cities', {
    file: workbook.file, sheet: workbook.sheets ? $('#sheet-cities').value : '' }));
  on('#do-cats', () => workbook && startTask('import-categories', {
    file: workbook.file, sheet: workbook.sheets ? $('#sheet-cats').value : '' }));
  const chips = $('#q-states');
  if (chips) chips.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-state]');
    if (!chip) return;
    const chosen = new Set(queueDraft ?? queue.plan.states);
    if (chosen.has(chip.dataset.state)) chosen.delete(chip.dataset.state); else chosen.add(chip.dataset.state);
    queueDraft = [...chosen].sort();
    chip.setAttribute('aria-pressed', String(chosen.has(chip.dataset.state)));
  });
  on('#q-clear', () => {
    queueDraft = [];
    $$('#q-states [data-state]').forEach((c) => c.setAttribute('aria-pressed', 'false'));
  });
  on('#do-queue', async () => {
    const res = await fetch('/api/queue', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: $('#q-order').value, states: queueDraft ?? queue.plan.states,
        only: $('#q-scope').value === 'only' }),
    });
    const r = await res.json();
    if (!res.ok) { alert(r.error); return; }
    queueDraft = null;
    loadControl();
  });
  on('#do-plan', () => startTask('plan', {
    cities: $('#p-cities').value, categories: $('#p-cats').value }));
  on('#do-run', () => startTask('run', {
    workers: Number($('#r-workers').value), maxJobs: Number($('#r-max').value) || undefined,
    headful: $('#r-headful').checked }));
  on('#do-enrich', () => startTask('enrich', {
    workers: Number($('#e-workers').value), maxDomains: Number($('#e-max').value) || undefined }));
  on('#do-export', () => startTask('export', {
    entity: $('#x-entity').value, excelSafe: $('#x-excel').checked,
    splitByState: $('#x-split').checked, full: $('#x-full').checked }));
  // A typed link survives re-renders, so an unsaved one looks exactly like a
  // saved one — which is how "Test connection" came to report "not configured"
  // beside a perfectly good link. Say when it is unsaved, and save it before
  // anything that depends on it.
  const sheetInput = $('#g-sheet'), tabInput = $('#g-tab');
  const markDirty = () => {
    const dirty = sheetsDirty();
    $('#g-dirty').hidden = !dirty;
    $('#do-sheets').disabled = ctlState.tasks.some((x) => x.name === 'export-sheets' && x.state === 'running') ||
      !(sheets.spreadsheetId || sheetInput.value.trim());
  };
  if (sheetInput) {
    sheetInput.addEventListener('input', markDirty);
    tabInput.addEventListener('input', markDirty);
    // Each layout has its own columns, so its own tab: suggest that tab when
    // the layout changes, unless someone has typed a name of their own.
    $('#g-layout').addEventListener('change', () => {
      const usual = Object.values(LAYOUTS).map((l) => l.tab);
      if (tabInput.value.trim() === '' || usual.includes(tabInput.value.trim())) {
        tabInput.value = LAYOUTS[$('#g-layout').value].tab;
      }
      markDirty();
    });
    markDirty();
  }
  on('#g-save', async () => {
    if (await saveSheets()) loadControl();
  });
  const keyInput = $('#g-key');
  if (keyInput) keyInput.addEventListener('change', async () => {
    const file = keyInput.files[0];
    if (!file) return;
    if (sheetsDirty() && !(await saveSheets())) return;
    const r = await sheetsPost('/api/sheets/key', await file.text(), 'application/json');
    if (!r) return;
    sheetsNote = { tone: 'ok', text: 'Key saved. Now share the sheet with the address shown, then test the connection.' };
    sheetsCheck = null;
    loadControl();
  });
  on('#g-test', async () => {
    if (sheetsDirty() && !(await saveSheets())) return;
    $('#g-test').disabled = true;
    $('#g-test').textContent = 'Testing…';
    const r = await sheetsPost('/api/sheets/check', '{}', 'application/json');
    if (!r) return;
    sheetsCheck = r.results;
    sheetsNote = null;
    loadControl();
  });
  on('#do-sheets', async () => {
    if (sheetsDirty() && !(await saveSheets())) return;
    // The layout's own export — the same one autopilot sends — so a manual
    // send and an automatic one never disagree about what belongs in the sheet.
    startTask('export-sheets', { entity: LAYOUTS[sheets.layout].entity });
  });
}

let pollCount = 0;
// While a task runs, poll often enough that the log feels live.
setInterval(async () => {
  if (!$('#control').classList.contains('on')) return;
  const t = await get('/api/tasks');
  const before = new Set(ctlState.tasks.filter((x) => x.state === 'running').map((x) => x.id));
  ctlState = t;
  renderRun();
  // Re-render the steps when a task finishes, or one starts (autopilot starts
  // them unprompted): counts, unlocks and button states have changed.
  const now = new Set(t.tasks.filter((x) => x.state === 'running').map((x) => x.id));
  const changed = before.size !== now.size || [...now].some((id) => !before.has(id));
  if (changed) { loadControl(); loadOverview(); return; }
  if (++pollCount % 4 === 0) { auto = await get('/api/autopilot'); renderAutopilot(false); }
}, 1500);

// ── Cities and services ───────────────────────────────────────────────
// One table per list, with each row's share of searches finished. Pausing is
// the way to drop something that has already produced leads: the server
// refuses to delete those, and says so.
const SEEDS = {
  cities: {
    kind: 'city', noun: 'city', plural: 'cities',
    label: (c) => c.city + ', ' + c.state_code,
    match: (c) => [c.city, c.state, c.state_code, c.zip, c.county].join(' ').toLowerCase(),
    cells: (c) =>
      '<td class="nm">' + esc(c.city) + '</td>' +
      '<td>' + esc(c.state_code) + '</td>' +
      '<td class="muted">' + esc(c.zip) + '</td>',
    fields: [
      { k: 'city', label: 'City', ph: 'Atlanta', w: 170 },
      { k: 'stateCode', label: 'State', ph: 'GA', w: 60 },
      { k: 'zip', label: 'Zip', ph: '30303', w: 90 },
      { k: 'coordinates', label: 'Coordinates', ph: '33.7533, -84.3899', w: 190 },
      { k: 'county', label: 'County', ph: 'optional', w: 140 },
      { k: 'population', label: 'Population', ph: 'optional', w: 110 },
    ],
    values: (c) => ({
      city: c.city, stateCode: c.state_code, zip: c.zip, coordinates: c.lat + ', ' + c.lng,
      county: c.county || '', population: c.population ?? '',
    }),
    hint: 'Coordinates: in Google Maps, right-click the city centre and click the numbers at the top to copy them.',
  },
  categories: {
    kind: 'category', noun: 'service', plural: 'services',
    label: (c) => c.name,
    match: (c) => [c.name, c.aliases || ''].join(' ').toLowerCase(),
    cells: (c) =>
      '<td class="nm">' + esc(c.name) + '</td>' +
      '<td class="muted">' + esc(c.weight) + '</td>',
    fields: [
      { k: 'name', label: 'Service', ph: 'Plumber', w: 260 },
      { k: 'weight', label: 'Weight', ph: '1', w: 70 },
      { k: 'aliases', label: 'Also search for', ph: 'optional, separated by |', w: 260 },
    ],
    values: (c) => ({
      name: c.name, weight: c.weight,
      aliases: c.aliases ? JSON.parse(c.aliases).join(' | ') : '',
    }),
    hint: 'Weight orders the queue: a higher weight is searched sooner. Changing it re-orders searches not yet run.',
  },
};

const FILTERS = [
  ['all', 'All'], ['active', 'Active'], ['complete', 'Complete'],
  ['in progress', 'In progress'], ['queued', 'Not started'], ['needs retry', 'Needs retry'],
  ['on hold', 'On hold'], ['paused', 'Paused'],
];
let canWrite = false;
const seedState = {
  cities: { rows: [], filter: 'all', editing: null },
  categories: { rows: [], filter: 'all', editing: null },
};

function ago(t) {
  if (!t) return '—';
  const m = (Date.now() - t) / 60000;
  if (m < 1) return 'just now';
  if (m < 60) return Math.round(m) + 'm ago';
  if (m < 2880) return Math.round(m / 60) + 'h ago';
  return Math.round(m / 1440) + 'd ago';
}

function inFilter(row, filter) {
  if (filter === 'all') return true;
  if (filter === 'active') return row.seed.active === 1;
  if (filter === 'queued') return row.progress === 'queued' || row.progress === 'not planned';
  if (filter === 'in progress') return row.progress === 'in progress' || row.progress === 'running';
  return row.progress === filter;
}

async function loadSeeds(which) {
  seedState[which].rows = await get('/api/seeds?kind=' + which);
  renderSeeds(which);
}

function renderSeeds(which) {
  const spec = SEEDS[which], state = seedState[which], rows = state.rows;
  const q = $('#' + which + '-q').value.trim().toLowerCase();

  const active = rows.filter((r) => r.seed.active === 1).length;
  const complete = rows.filter((r) => r.progress === 'complete').length;
  $('#' + which + '-sub').textContent =
    rows.length + ' ' + spec.plural + ' · ' + active + ' active · ' + complete + ' complete' +
    (canWrite ? '' : ' · read-only, restart with --control to edit');

  $('#' + which + '-chips').innerHTML = FILTERS.map(([key, label]) => {
    const n = rows.filter((r) => inFilter(r, key)).length;
    return '<button class="chip" data-filter="' + key + '" aria-pressed="' + (state.filter === key) + '">' +
      esc(label) + ' ' + n + '</button>';
  }).join('');

  $('#' + which + '-add').hidden = !canWrite;
  $('#' + which + '-save').hidden = !canWrite;

  const shown = rows.filter((r) => inFilter(r, state.filter) && (!q || spec.match(r.seed).includes(q)));
  const span = which === 'cities' ? 8 : 7;
  $('#' + which + '-body').innerHTML = shown.length ? shown.map((r) => {
    const j = r.jobs, finished = j.done + j.skipped;
    const share = j.total ? finished / j.total : 0;
    const off = r.seed.active !== 1;
    return '<tr data-id="' + r.seed.id + '"' + (off ? ' class="off"' : '') + '>' + spec.cells(r.seed) +
      '<td>' + (j.total
        ? '<span class="meter' + (share === 1 ? ' full' : '') + '"><i style="width:' + (share * 100).toFixed(1) + '%"></i></span>' +
          num(finished) + '<span class="muted"> / ' + num(j.total) + '</span>' +
          (j.failed ? ' <span class="tag needs-retry">' + j.failed + ' failed</span>' : '')
        : '<span class="muted">none planned</span>') + '</td>' +
      '<td>' + (r.leads ? num(r.leads) : '<span class="muted">0</span>') + '</td>' +
      '<td class="muted">' + ago(j.lastFinishedAt) + '</td>' +
      '<td><span class="tag ' + r.progress.replace(/ /g, '-') + '">' + esc(r.progress) + '</span></td>' +
      '<td class="acts">' + (canWrite
        ? '<button class="act" data-act="edit">Edit</button>' +
          '<button class="act" data-act="' + (off ? 'resume' : 'pause') + '">' + (off ? 'Resume' : 'Pause') + '</button>' +
          '<button class="act danger" data-act="delete">Delete</button>'
        : '') + '</td></tr>';
  }).join('') : '<tr><td colspan="' + span + '" class="empty">' +
    (rows.length ? 'Nothing matches.' : 'No ' + spec.plural + ' yet. Run gms seeds load, or add one.') + '</td></tr>';

  renderEditor(which);
}

function renderEditor(which) {
  const spec = SEEDS[which], state = seedState[which], box = $('#' + which + '-form');
  if (state.editing === null) { box.innerHTML = ''; return; }
  const row = state.editing === 'new' ? null : state.rows.find((r) => r.seed.id === state.editing);
  const values = row ? spec.values(row.seed) : {};
  box.innerHTML = '<div class="editor"><div class="opts">' +
    spec.fields.map((f) => '<label><span>' + esc(f.label) + '</span>' +
      '<input type="text" data-field="' + f.k + '" placeholder="' + esc(f.ph) + '" style="width:' + f.w + 'px" value="' +
      esc(values[f.k] ?? '') + '"></label>').join('') +
    '<button class="go" data-act="submit">' + (row ? 'Save' : 'Add ' + spec.noun) + '</button>' +
    '<button class="go ghost" data-act="cancel">Cancel</button>' +
    '</div><div class="p">' + esc(spec.hint) +
    (row ? ' Saving updates the searches not yet run; finished ones keep what they searched.' : '') + '</div></div>';
  box.querySelector('input').focus();
}

function seedNote(which, tone, text) {
  const note = $('#' + which + '-note');
  note.className = 'note ' + tone;
  note.textContent = text;
}

async function seedEdit(which, op, id, values) {
  const spec = SEEDS[which];
  const res = await fetch('/api/seeds', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: spec.kind, op, id, values }),
  });
  const r = await res.json();
  if (!res.ok) {
    seedNote(which, 'bad', r.error + (r.hint ? ' ' + r.hint : ''));
    return false;
  }
  const n = (k, word) => (r[k] ? ' ' + num(r[k]) + ' ' + word + '.' : '');
  seedNote(which, 'ok',
    op === 'add' ? 'Added.' + (r.jobsCreated ? n('jobsCreated', 'searches queued') : ' Its searches are created with the next "Create jobs".')
    : op === 'update' ? 'Saved.' + n('jobsUpdated', 'queued searches updated')
    : op === 'pause' ? 'Paused. Nothing more is searched for it.' + n('jobsChanged', 'queued searches parked')
    : op === 'resume' ? 'Resumed.' + n('jobsChanged', 'searches back in the queue') + n('jobsCreated', 'new searches queued')
    : 'Deleted.' + n('jobsRemoved', 'planned searches removed'));
  return true;
}

['cities', 'categories'].forEach((which) => {
  const spec = SEEDS[which], state = seedState[which];

  $('#' + which + '-q').addEventListener('input', () => renderSeeds(which));
  $('#' + which + '-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    renderSeeds(which);
  });
  $('#' + which + '-add').addEventListener('click', () => {
    state.editing = 'new'; seedNote(which, '', ''); renderEditor(which);
  });
  $('#' + which + '-save').addEventListener('click', async () => {
    const res = await fetch('/api/seeds/save', { method: 'POST' });
    const r = await res.json();
    seedNote(which, res.ok ? 'ok' : 'bad', res.ok
      ? 'Wrote ' + r.cities + ' cities and ' + r.categories + ' services to ' + r.dir +
        '. Commit that folder so a fresh install, such as the VPS, starts from these lists.'
      : r.error);
  });

  $('#' + which + '-form').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'cancel') { state.editing = null; renderEditor(which); return; }
    if (act !== 'submit') return;
    const values = {};
    $$('#' + which + '-form [data-field]').forEach((el) => { values[el.dataset.field] = el.value; });
    const isNew = state.editing === 'new';
    if (await seedEdit(which, isNew ? 'add' : 'update', isNew ? undefined : state.editing, values)) {
      state.editing = null;
      loadSeeds(which);
    }
  });
  $('#' + which + '-form').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#' + which + '-form [data-act="submit"]').click();
    if (e.key === 'Escape') $('#' + which + '-form [data-act="cancel"]').click();
  });

  $('#' + which + '-body').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const tr = e.target.closest('tr[data-id]');
    if (!act || !tr) return;
    const id = Number(tr.dataset.id);
    const row = state.rows.find((r) => r.seed.id === id);
    if (act === 'edit') { state.editing = id; seedNote(which, '', ''); renderEditor(which); return; }
    // The server refuses these too; saying so up front saves a pointless confirm.
    if (act === 'delete' && row.leads > 0) {
      seedNote(which, 'bad', spec.label(row.seed) + ' has already produced ' + num(row.leads) +
        ' leads, so it cannot be deleted. Pause it instead: nothing more is searched for this ' +
        spec.noun + ', and its leads keep their origin.');
      return;
    }
    if (act === 'delete' && !confirm('Delete ' + spec.label(row.seed) + '?' +
      (row.jobs.total ? ' Its ' + row.jobs.total + ' planned searches are removed too.' : ''))) return;
    if (await seedEdit(which, act, id)) loadSeeds(which);
  });
});

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
    const complete = g.pending + g.leased + g.failed + g.paused === 0;
    const title = g.label + (g.sublabel ? ', ' + g.sublabel : '') +
      ' — ' + g.done + '/' + g.total + ' done' +
      (g.failed ? ', ' + g.failed + ' failed' : '') +
      (g.leased ? ', ' + g.leased + ' running' : '') +
      (g.paused ? ', ' + g.paused + ' paused' : '');
    return '<div class="tile' + (complete ? ' done' : '') + (g.failed ? ' fail' : '') +
      '" title="' + esc(title) + '">' +
      '<i style="height:' + (share * 100).toFixed(1) + '%"></i>' +
      '<b>' + esc(g.sublabel || g.label.slice(0, 4)) + '</b></div>';
  }).join('');
  const complete = groups.filter((g) => g.pending + g.leased + g.failed + g.paused === 0).length;
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
    '<td>' + (c.last_sub_id ? num(c.last_id) + ' / ' + num(c.last_sub_id) : num(c.last_id)) + '</td>' +
    '<td>' + num(c.rows_total) + '</td>' +
    '<td class="muted">' + esc(c.target) + '</td></tr>').join('')
    : '<tr><td colspan="5" class="empty">Nothing exported yet.</td></tr>';
}

$('#retry').addEventListener('click', async () => {
  const res = await fetch('/api/jobs/retry', { method: 'POST' });
  const r = await res.json();
  // Retrying is a write, so the server refuses it without --control. Say what
  // happened rather than rendering "Requeued undefined".
  $('#retry').textContent = res.ok ? 'Requeued ' + r.retried : r.error || 'Not allowed';
  if (!res.ok) return;
  loadIssues(); loadOverview();
});

$('#rescrape').addEventListener('click', async () => {
  if (!confirm('Put every finished search back in the queue, so its businesses are read again?\n\n' +
    'Use this once after an update that fixes how businesses are read. Existing businesses are ' +
    'corrected in place, not duplicated, and their leads are kept. It takes as long as those ' +
    'searches took the first time.')) return;
  const res = await fetch('/api/jobs/rescrape', { method: 'POST' });
  const r = await res.json();
  $('#rescrape').textContent = res.ok ? 'Queued ' + num(r.queued) + ' searches' : r.error || 'Not allowed';
  if (res.ok) loadOverview();
});

/** Disable the retry button when this dashboard cannot write. */
async function syncRetryButton() {
  const t = await get('/api/tasks').catch(() => ({ enabled: false }));
  canWrite = t.enabled;
  const button = $('#retry');
  button.disabled = !t.enabled;
  $('#rescrape').disabled = !t.enabled;
  button.title = t.enabled ? '' : 'Read-only. Restart with --control to retry from this page.';
}

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
// Route only once we know whether this dashboard can write, so the Cities and
// Services pages render their edit buttons on the first paint.
syncRetryButton().finally(routeFromHash);
</script>
</body>
</html>`;
