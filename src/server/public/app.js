// cspider UI.
//
// Two design decisions drive everything here, both learned from the first version being unusable:
//
//  1. A whole-PR force layout is a hairball. 107 nodes with overlapping labels answers no question.
//     The graph is therefore EGO-CENTRIC: pick a change, and see its callers, itself, and its
//     callees as fixed lanes. Positions are computed, never simulated, so labels never collide.
//  2. A review starts from files, not from a flat symbol list. The left pane groups by file and
//     shows what kind of change each symbol carries as chips, so nothing needs to be clicked to
//     find out whether a signature moved.
//
// The invariant from the analysis layer still holds: anything not established must LOOK
// unestablished. UNKNOWN is rendered with its reason, truncation is rendered, an absent side of a
// diff says why.

const $ = (s) => document.querySelector(s);
const api = async (p) => {
  const r = await fetch(p);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
  return r.json();
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const params = (s) => (s.match(/\(([^)]*)\)/)?.[1] ?? '');
const bare = (name) => String(name ?? '').replace(/\(.*/, '');

const COLOR = {
  ADDED: '#46c97a', REMOVED: '#ef5f6d', MODIFIED: '#e3b341',
  MOVED: '#4aa8e0', RENAMED: '#4aa8e0', UNCHANGED: '#4a5260',
};
const DELTA_CHIP = {
  SIGNATURE: ['sig', 'signature'], VISIBILITY: ['vis', 'visibility'],
  THROWS: ['thr', 'throws'], ANNOTATION: ['ann', 'annotation'],
  MODIFIER: ['', 'modifier'], BODY: ['', 'body'],
};

const S = { prId: null, pr: null, files: null, selected: null, cy: null, mode: 'overview' };

init().catch((e) => { $('#banners').innerHTML = banner('bad', 'Failed to load', esc(e.message)); });

async function init() {
  const { prs } = await api('/api/prs');
  if (prs.length === 0) {
    $('#banners').innerHTML = banner('info', 'Nothing analysed yet',
      'Run <code>npm start -- &lt;pr-url&gt;</code> first.');
    return;
  }
  const picker = $('#prPicker');
  picker.innerHTML = prs.map((p) => `<option value="${esc(p.id)}">${esc(p.id)} — ${esc(p.title ?? '')}</option>`).join('');
  picker.onchange = () => {
    history.replaceState(null, '', `?pr=${encodeURIComponent(picker.value)}`);
    selectPr(picker.value);
  };

  $('#filter').oninput = renderFiles;
  $('#showTests').onchange = () => (S.selected ? focus(S.selected) : null);
  $('#overviewBtn').onclick = () => { S.selected = null; renderFiles(); overview(); };
  $('#fit').onclick = () => S.cy?.fit(undefined, 40);
  $('#markBtn').onclick = toggleReviewed;

  const wanted = new URLSearchParams(location.search).get('pr');
  picker.value = prs.some((p) => p.id === wanted) ? wanted : prs[0].id;
  await selectPr(picker.value);
}

async function selectPr(prId) {
  S.prId = prId;
  S.selected = null;
  S.pr = await api(`/api/pr/${encodeURIComponent(prId)}`);
  S.files = await api(`/api/pr/${encodeURIComponent(prId)}/files`);
  renderHead();
  renderBanners();
  renderFiles();
  overview();
  $('#detail').className = 'empty';
  $('#detail').innerHTML = '<p>Pick a change on the left.</p>';
  $('#markBtn').hidden = true;
}

// ------------------------------------------------------------------ header / banners
function renderHead() {
  const c = S.pr.counts;
  $('#counts').innerHTML =
    `<b>${S.files.totalFiles}</b> files · <b>${c.units}</b> changes` +
    (c.broken ? ` · <b class="bad">${c.broken} broken</b>` : '') +
    (c.unknown ? ` · <b class="warn">${c.unknown} unknown</b>` : '');
  renderProgress(S.pr.progress);
}
function renderProgress(p) {
  $('#progress').textContent = `reviewed ${p.done}/${p.total}` + (p.stale ? ` · ${p.stale} stale` : '');
}
const banner = (cls, t, b) => `<div class="banner ${cls}"><b>${t}</b><span>${b}</span></div>`;

function renderBanners() {
  const s = S.pr.status;
  const out = [];
  if (!s.resolved) out.push(banner('warn', 'Not resolved', 'No callers or break analysis — re-run with <code>--resolve</code>.'));
  if (s.health && s.health.verdict !== 'clean') {
    out.push(banner(s.health.verdict === 'DEGRADED' ? 'bad' : 'warn', `Resolution ${s.health.verdict}`,
      `${s.health.unresolved} unresolved of ${s.health.errors} error(s) — edges are missing.`));
  }
  if (s.blastRadius?.truncated?.length) {
    out.push(banner('warn', 'Expansion truncated',
      `${s.blastRadius.truncated.length} point(s) hit a bound — nodes beyond them were never explored.`));
  }
  const cap = (s.truncations ?? []).filter((t) => t.reason === 'maxSymbols').reduce((a, t) => a + (t.omitted ?? 0), 0);
  if (cap) out.push(banner('warn', `${cap} symbols unresolved`, 'Beyond the resolution cap — reported UNKNOWN, not safe.'));
  if (s.touchedSource && s.touchedSource !== 'git') {
    out.push(banner(s.touchedSource === 'none' ? 'bad' : 'warn', 'Changed-line data',
      s.touchedSource === 'none' ? 'Unavailable — UPDATED cannot be told from BROKEN.' : 'From GitHub patch, not git.'));
  }
  if (S.pr.progress.stale) out.push(banner('warn', 'Stale marks', `${S.pr.progress.stale} reviewed symbol(s) changed since.`));
  $('#banners').innerHTML = out.join('');
}

// ------------------------------------------------------- files + changes (left)
function renderFiles() {
  const q = $('#filter').value.trim().toLowerCase();
  const el = $('#fileList');
  const files = S.files.files
    .map((f) => ({ ...f, units: q ? f.units.filter((u) => (u.fqn + f.path).toLowerCase().includes(q)) : f.units }))
    .filter((f) => f.units.length);

  $('#filesTitle').textContent = `Files (${files.length})`;
  el.innerHTML = files.map((f) => {
    const parts = f.path.split('/');
    const name = parts.pop();
    const open = files.length <= 12 || f.broken || q;
    return `
      <div class="file ${open ? 'open' : ''}" data-path="${esc(f.path)}">
        <div class="fileHd">
          <span class="caret">${open ? '▾' : '▸'}</span>
          <span class="fname mono">${esc(name)}</span>
          <span class="fdir">${esc(parts.slice(-2).join('/'))}</span>
          <span class="counts-mini">
            ${f.added ? `<span class="a">+${f.added}</span>` : ''}
            ${f.removed ? `<span class="r">−${f.removed}</span>` : ''}
            ${f.modified ? `<span class="m">~${f.modified}</span>` : ''}
          </span>
          ${f.broken ? `<span class="chip broken">${f.broken}✗</span>` : ''}
          ${f.unknown ? `<span class="chip unknown">${f.unknown}?</span>` : ''}
          <span class="risk">${f.reviewed}/${f.units.length}</span>
        </div>
        <div class="units">${f.units.map(unitRow).join('')}</div>
      </div>`;
  }).join('') || '<div class="emptyImpact">Nothing matches that filter.</div>';

  for (const hd of el.querySelectorAll('.fileHd')) {
    hd.onclick = () => {
      const f = hd.closest('.file');
      f.classList.toggle('open');
      f.querySelector('.caret').textContent = f.classList.contains('open') ? '▾' : '▸';
    };
  }
  for (const row of el.querySelectorAll('.unit')) row.onclick = () => focus(row.dataset.id);
  if (S.selected) markSelectedRow(S.selected);
}

function unitRow(u) {
  const chips = [];
  // The kind of change is visible without clicking — that was the biggest gap in v1.
  for (const t of u.deltaTypes) {
    const [cls, label] = DELTA_CHIP[t] ?? ['', t.toLowerCase()];
    chips.push(`<span class="chip ${cls}">${esc(label)}</span>`);
  }
  if (u.fanIn !== null && u.fanIn !== undefined) {
    chips.push(`<span class="chip fan">${u.fanIn} caller${u.fanIn === 1 ? '' : 's'}${u.fanInKind === 'INDIRECT' ? '*' : ''}</span>`);
  }
  if (u.broken) chips.push(`<span class="chip broken">${u.broken} broken</span>`);
  if (u.unknown) chips.push('<span class="chip unknown">unknown</span>');

  const risk = u.risk ?? u.severity ?? 0;
  return `
    <div class="unit ${u.reviewed ? 'done' : ''}" data-id="${esc(u.id)}" title="${esc(u.fqn)}">
      <span class="ck ${esc(u.changeKind)}">${esc(u.changeKind[0])}</span>
      <span class="nm"><span class="owner">${esc(u.owner ?? '')}.</span>${esc(bare(u.name))}<span class="owner">(${esc(params(u.name))})</span></span>
      <span class="right">
        <span class="riskbar ${risk >= 40 ? 'hi' : ''}"><i style="width:${Math.min(100, risk * 1.6)}%"></i></span>
        <span class="risk">${risk}</span>
      </span>
      ${chips.length ? `<span class="meta">${chips.join('')}</span>` : ''}
    </div>`;
}

function markSelectedRow(id) {
  for (const r of $('#fileList').querySelectorAll('.unit')) r.classList.toggle('sel', r.dataset.id === id);
  const sel = $('#fileList').querySelector('.unit.sel');
  if (sel) { sel.closest('.file').classList.add('open'); sel.scrollIntoView({ block: 'nearest' }); }
}

// ------------------------------------------------- impact: file overview (default)
function overview() {
  S.mode = 'overview';
  $('#impactTitle').textContent = 'Impact — overview';
  $('#impactSub').textContent = 'files, sized by highest risk. Pick a change to see its callers.';
  $('#overviewBtn').classList.add('on');

  const files = S.files.files;
  if (!files.length) { $('#cy').innerHTML = '<div class="emptyImpact">No changes to show.</div>'; return; }

  const els = files.map((f, i) => ({
    data: {
      id: `f:${f.path}`, label: f.path.split('/').pop().replace(/\.java$/, ''),
      risk: f.risk, broken: f.broken,
      size: Math.max(30, Math.min(76, 30 + f.risk * 0.7)),
      kind: f.broken ? 'REMOVED' : f.added > f.removed ? 'ADDED' : 'MODIFIED',
    },
    position: ringPos(i, files.length, 230),
  }));

  render(els, 'preset');
  S.cy.on('tap', 'node', (ev) => {
    const path = ev.target.id().slice(2);
    const f = S.files.files.find((x) => x.path === path);
    if (f?.units.length) focus(f.units[0].id);
  });
  $('#legend').innerHTML = [
    '<i>each node is a changed file · size = highest risk in it</i>',
    '<i style="color:var(--broken)">red = has broken call sites</i>',
    '<i>click a file to focus its riskiest change</i>',
  ].join('');
}

const ringPos = (i, n, r) => {
  const a = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2;
  return { x: Math.cos(a) * r, y: Math.sin(a) * r * 0.72 };
};

// --------------------------------------------- impact: ego lanes (on selection)
async function focus(id) {
  S.selected = id;
  S.mode = 'focus';
  $('#overviewBtn').classList.remove('on');
  markSelectedRow(id);
  renderDetail(id);

  let ego;
  try {
    ego = await api(`/api/pr/${encodeURIComponent(S.prId)}/ego?id=${encodeURIComponent(id)}`);
  } catch (e) {
    $('#cy').innerHTML = `<div class="emptyImpact">Could not load impact: ${esc(e.message)}</div>`;
    return;
  }

  const showTests = $('#showTests').checked;
  const tests = showTests ? ego.tests : [];
  const c = ego.counts;

  $('#impactTitle').textContent = 'Impact — focus';
  $('#impactSub').textContent =
    `${c.callers} caller${c.callers === 1 ? '' : 's'} · ${c.callees} callee${c.callees === 1 ? '' : 's'}` +
    `${c.tests ? ` · ${c.tests} test${c.tests === 1 ? '' : 's'}` : ''}` +
    `${c.orphanSites ? ` · ${c.orphanSites} site(s) outside any member` : ''}` +
    `${c.fanInKind === 'INDIRECT' ? ' · fan-in is indirect' : ''}`;

  // Fixed lanes, sized to the viewport. Nothing is simulated, so labels never overlap and the
  // picture is stable between selections — two symbols stay comparable.
  const box = $('#cy').getBoundingClientRect();
  const usableH = Math.max(300, box.height - 96);
  const laneCount = 2 + (ego.callees.length ? 1 : 0) + (tests.length ? 1 : 0);
  // Lanes are sized so the whole picture fits at a LEGIBLE zoom. Fitting a wide spread into the
  // pane is what made the graph shrink to a dot — better to keep it tight and readable.
  const laneW = Math.max(170, Math.min(250, (box.width - 90) / laneCount));

  const els = [];
  const laneX = {};
  // A lane taller than the viewport wraps into sub-columns rather than running off-screen.
  const lane = (list, x, role) => {
    laneX[role] = x;
    if (!list.length) return { height: 0, cols: 0 };
    const perCol = Math.max(1, Math.floor(usableH / 48));
    const cols = Math.ceil(list.length / perCol);
    const rows = Math.ceil(list.length / cols);
    const gap = rows > 1 ? Math.min(52, usableH / rows) : 52;
    const colGap = 120;
    list.forEach((n, i) => {
      const col = Math.floor(i / rows);
      const row = i % rows;
      const inCol = Math.min(rows, list.length - col * rows);
      const y0 = -((inCol - 1) * gap) / 2;
      els.push({
        data: {
          id: n.id, label: `${n.owner ?? ''}\n${bare(n.name)}`, role,
          kind: n.origin === 'CONTEXT' ? 'UNCHANGED' : n.changeKind,
          origin: n.origin, broken: n.broken, unknown: !!n.unknown, reviewed: n.reviewed,
          size: role === 'centre' ? 46 : Math.max(18, Math.min(32, 18 + (n.risk ?? 0) * 0.25)),
          changed: n.origin !== 'CONTEXT',
          mark: n.origin === 'CONTEXT' ? '' : (n.changeKind?.[0] ?? ''),
        },
        position: { x: x + (col - (cols - 1) / 2) * colGap, y: y0 + row * gap },
      });
    });
    return { height: rows * gap, cols };
  };

  const xTests = tests.length ? -laneW * (ego.callees.length ? 2 : 2) : null;
  lane(tests, xTests ?? -laneW * 2, 'test');
  lane(ego.callers, -laneW, 'caller');
  lane([ego.centre], 0, 'centre');
  lane(ego.callees, laneW, 'callee');

  const present = new Set(els.map((e) => e.data.id));
  for (const n of ego.callers) if (present.has(n.id)) {
    els.push({ data: { id: `c-${n.id}`, source: n.id, target: ego.centre.id, verdict: n.verdict, type: 'CALLS' } });
  }
  for (const n of ego.callees) if (present.has(n.id)) {
    els.push({ data: { id: `o-${n.id}`, source: ego.centre.id, target: n.id, type: 'CALLS' } });
  }
  for (const n of tests) if (present.has(n.id)) {
    els.push({ data: { id: `t-${n.id}`, source: n.id, target: ego.centre.id, type: 'TEST_COVERS' } });
  }

  // Lane captions as unclickable label nodes, placed just above the tallest lane.
  const ys = els.filter((e) => e.position).map((e) => e.position.y);
  const top = Math.min(...ys, 0) - 46;
  const caption = (x, text, n) => {
    if (x === undefined) return;
    els.push({
      data: { id: `lbl:${text}`, label: n === null ? text : `${text} · ${n}`, isLabel: true },
      position: { x, y: top }, selectable: false, grabbable: false,
    });
  };
  if (tests.length) caption(laneX.test, 'TESTS', tests.length);
  caption(laneX.caller, 'CALLED BY', ego.callers.length);
  caption(laneX.centre, 'THIS CHANGE', null);
  if (ego.callees.length) caption(laneX.callee, 'CALLS', ego.callees.length);

  render(els, 'preset');
  S.cy.getElementById(ego.centre.id).addClass('centre');
  S.cy.on('tap', 'node', (ev) => {
    if (ev.target.data('isLabel')) return;
    const nid = ev.target.id();
    if (nid !== S.selected) focus(nid);
  });

  $('#legend').innerHTML = [
    '<i><span class="sw" style="background:#46c97a"></span>added</i>',
    '<i><span class="sw" style="background:#ef5f6d"></span>removed</i>',
    '<i><span class="sw" style="background:#e3b341"></span>modified</i>',
    '<i><span class="sw" style="background:#4a5260"></span>unchanged context</i>',
    '<i style="color:var(--broken)">▬ broken call</i>',
    '<i style="color:var(--moved)">╌ test covers</i>',
    ego.orphanSites.length ? `<i style="color:var(--unknown)">${ego.orphanSites.length} call site(s) outside any member — listed on the right, not drawn</i>` : '',
    '<i>click any node to re-centre</i>',
  ].join('');
}

function render(elements, layoutName) {
  const host = $('#cy');
  host.innerHTML = '';
  S.cy = cytoscape({
    container: host,
    elements,
    layout: { name: layoutName, fit: false },
    minZoom: 0.18,
    maxZoom: 2.5,
    wheelSensitivity: 0.25,
    style: [
      { selector: 'node', style: {
        'background-color': (n) => COLOR[n.data('kind')] ?? '#4a5260',
        width: 'data(size)', height: 'data(size)',
        label: 'data(label)', 'font-size': 10, 'font-family': 'ui-monospace, monospace',
        color: '#c3cad6', 'text-valign': 'bottom', 'text-margin-y': 5,
        'text-wrap': 'wrap', 'text-max-width': 150, 'line-height': 1.25,
        'border-width': 2, 'border-color': 'rgba(0,0,0,.35)',
        'text-background-color': '#0e1014', 'text-background-opacity': 0.72,
        'text-background-padding': 2, 'text-background-shape': 'roundrectangle',
      } },
      { selector: 'node[?isLabel]', style: {
        'background-opacity': 0, 'border-width': 0, width: 1, height: 1,
        label: 'data(label)', 'font-size': 10, 'font-weight': 'bold',
        color: '#7f8a9b', 'text-valign': 'center', 'letter-spacing': 1.5,
        'text-background-opacity': 0, events: 'no',
      } },
      // Unchanged context is deliberately quiet; a changed symbol must read as changed at a glance.
      { selector: 'node[origin = "CONTEXT"]', style: {
        'background-color': '#39414f', 'background-opacity': 0.85,
        'border-style': 'dashed', 'border-color': '#4d5666', 'border-width': 1,
        shape: 'round-rectangle', color: '#8d97a8', 'font-size': 9,
      } },
      { selector: 'node[?changed]', style: {
        'border-width': 3, 'border-color': '#0e1014',
        color: '#e8edf6', 'font-size': 10, 'font-weight': 'bold',
      } },
      { selector: 'node.centre', style: {
        'border-width': 6, 'border-color': '#7aa2f7', 'border-opacity': 1,
        'font-size': 13, 'font-weight': 'bold', color: '#eaf0ff',
        'overlay-color': '#7aa2f7', 'overlay-opacity': 0.18, 'overlay-padding': 14,
        'text-background-color': '#1a2540', 'text-background-opacity': 0.95,
        'z-index': 100,
      } },
      { selector: 'node[?broken]', style: { 'border-color': '#ff4d5a', 'border-width': 3 } },
      { selector: 'node[?unknown]', style: { 'border-style': 'dotted', 'border-color': '#e0a02b', 'border-width': 3 } },
      { selector: 'node[?reviewed]', style: { opacity: 0.5 } },

      { selector: 'edge', style: {
        width: 1.6, 'line-color': '#4a5464', 'curve-style': 'bezier',
        'target-arrow-shape': 'triangle', 'target-arrow-color': '#4a5464', 'arrow-scale': 0.85,
      } },
      { selector: 'edge[verdict = "BROKEN"]', style: { 'line-color': '#ff4d5a', 'target-arrow-color': '#ff4d5a', width: 3 } },
      { selector: 'edge[verdict = "UPDATED"]', style: { 'line-color': '#46c97a', 'target-arrow-color': '#46c97a' } },
      { selector: 'edge[type = "TEST_COVERS"]', style: { 'line-style': 'dashed', 'line-color': '#4aa8e0', 'target-arrow-color': '#4aa8e0' } },
    ],
  });

  // A flex/grid child has no measured size at construction time, so fitting here silently used a
  // 0×0 viewport — which is why the graph appeared tiny in a corner. Fit after layout, and again
  // whenever the pane is actually resized.
  // Fitting to the full extent is what shrank the graph to a dot. Legibility comes first: clamp
  // the zoom into a readable band and centre on the focus. If the content is wider than that
  // allows, the reviewer pans — which is far better than reading 6px labels.
  const MIN_Z = 0.7;
  const MAX_Z = 1.25;
  const settle = () => {
    if (!S.cy || S.cy.destroyed()) return;
    S.cy.resize();
    S.cy.fit(S.cy.elements(':visible'), 40);
    const z = S.cy.zoom();
    if (z < MIN_Z) S.cy.zoom(MIN_Z);
    else if (z > MAX_Z) S.cy.zoom(MAX_Z);
    const c = S.cy.$('.centre');
    S.cy.center(c.nonempty() ? c : S.cy.elements(':visible'));
  };
  S.cy.ready(() => requestAnimationFrame(settle));
  requestAnimationFrame(settle);
  setTimeout(settle, 120);

  S.ro?.disconnect();
  S.ro = new ResizeObserver(() => settle());
  S.ro.observe(host);
}

// ------------------------------------------------------------------ detail (right)
async function renderDetail(id) {
  const el = $('#detail');
  el.className = '';
  el.innerHTML = '<span class="absent">loading…</span>';

  let d;
  try {
    d = await api(`/api/pr/${encodeURIComponent(S.prId)}/node?id=${encodeURIComponent(id)}`);
  } catch (e) { el.innerHTML = `<span class="absent">${esc(e.message)}</span>`; return; }

  const n = d.node;
  const u = d.unit;
  const btn = $('#markBtn');
  btn.hidden = !u;
  btn.textContent = n.reviewed ? 'unmark reviewed' : 'mark reviewed';

  const out = [];
  const name = (n.fqn.split('#').pop() || n.fqn);
  const owner = (n.fqn.split('#')[0] || '').split('.').pop();
  out.push('<div class="stick">');
  out.push(`<div class="dTitle">
      ${u ? `<span class="ck ${esc(u.changeKind)}">${esc(u.changeKind[0])}</span>` : ''}
      ${esc(owner)}<span style="color:var(--faint)">#</span>${esc(bare(name))}<span style="color:var(--faint)">(${esc(params(name))})</span>
    </div>`);
  out.push(`<div class="dPath">${esc(n.path ?? '')}</div>`);
  if (u?.signatureChange) out.push(sigChangeHtml(u.signatureChange));
  else if (u?.deltas?.length) {
    out.push(`<div class="deltaRow">${u.deltas.map((d) => {
      const [cls, label] = DELTA_CHIP[d.type] ?? ['', d.type.toLowerCase()];
      return `<span class="chip ${cls}">${esc(label)}</span>`;
    }).join('')}</div>`);
  }
  out.push('</div>');

  if (n.unknown) {
    out.push(`<div class="unknownBox"><b>UNKNOWN</b> — ${esc(n.unknown.reason ?? n.unknown)}
      <span class="sm">Not analysed. That is not the same as “no impact”.</span></div>`);
  }

  const v = d.callerSummary;
  if (v && (v.BROKEN || v.UPDATED || v.SAFE)) {
    out.push(`<h4>Call sites <span class="n">${v.BROKEN ? `${v.BROKEN} broken · ` : ''}${v.UPDATED} updated · ${v.SAFE} safe</span></h4>`);
  } else if (d.callers?.length) {
    out.push(`<h4>Call sites <span class="n">${d.callers.length}</span></h4>`);
  }
  if (d.callers?.length) {
    const sorted = [...d.callers].sort((a, b) => (b.verdict === 'BROKEN') - (a.verdict === 'BROKEN'));
    for (const c of sorted) {
      const lines = (c.excerpt?.lines ?? []).map((l) =>
        `<div class="${l.isCallSite ? 'del' : 'ctx'}"><span class="ln">${l.line}</span>${esc(l.text)}</div>`).join('');
      out.push(`
        <div class="site ${c.verdict === 'BROKEN' ? 'brokenSite' : ''}">
          <div class="hd">
            ${c.verdict ? `<span class="v ${esc(c.verdict)}">${esc(c.verdict)}</span>` : ''}
            <span class="loc">${esc(c.path.split('/').slice(-2).join('/'))}:${c.line}</span>
            ${c.side === 'base' ? '<span class="note">base image</span>' : ''}
          </div>
          ${c.excerpt?.absent ? '<div class="absent" style="padding:5px 7px">source unavailable at this revision</div>'
            : `<pre class="diff">${lines}</pre>`}
          ${c.reasons?.length ? `<div class="note" style="padding:0 7px 5px">${esc(c.reasons.join('; '))}</div>` : ''}
        </div>`);
    }
  }

  if (d.source) {
    out.push('<h4>Diff</h4>');
    out.push(renderDiff(d.source.before, d.source.after));
  }

  const kv = [];
  if (u?.symbol) {
    kv.push(['signature', esc(u.symbol.signature)]);
    kv.push(['visibility', esc(u.symbol.visibility)]);
    if (u.symbol.annotations?.length) kv.push(['annotations', esc(u.symbol.annotations.join(' '))]);
    if (u.symbol.throws?.length) kv.push(['throws', esc(u.symbol.throws.join(', '))]);
  }
  if (n.fanIn) kv.push(['callers', `${n.fanIn.count}${n.fanIn.kind === 'INDIRECT' ? ' (indirect)' : ''}`]);
  kv.push(['tests reach', n.testCovered == null ? '<span class="absent">unknown</span>'
    : (n.testCovered ? 'yes' : '<span style="color:var(--unknown)">no</span>')]);
  out.push(`<h4>Facts</h4><dl class="kv">${kv.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('')}</dl>`);
  if (n.fanIn?.note) out.push(`<div class="note">ⓘ ${esc(n.fanIn.note)}</div>`);

  if (u?.deltas?.length) {
    out.push('<h4>Deltas</h4>');
    for (const dl of u.deltas) {
      if (dl.type === 'BODY') { out.push('<div class="comp"><span>body changed</span></div>'); continue; }
      out.push(`<div class="comp"><span>${esc(dl.type.toLowerCase())}</span><span>${esc(fmt(dl.before))} → ${esc(fmt(dl.after))}</span></div>`);
    }
  }
  if (n.risk?.components?.length) {
    out.push(`<h4>Risk <span class="n">${n.risk.total}</span></h4>`);
    for (const c of n.risk.components) {
      out.push(`<div class="comp"><span>${esc(c.name)} +${c.points}</span><span>${esc(c.detail ?? '')}</span></div>`);
    }
  }

  el.innerHTML = out.join('');
}

const fmt = (x) => (Array.isArray(x) ? (x.length ? x.join(' ') : '∅') : (x ?? '∅'));

/**
 * A 15-parameter constructor rendered twice in full is noise. Diff the parameter lists and show
 * only what moved, with the full signatures available on hover.
 */
function sigChangeHtml(sc) {
  const split = (s) => (s.match(/\(([^)]*)\)/)?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const a = split(sc.before);
  const b = split(sc.after);
  const ret = (s) => (s.match(/^(\S+)\s/)?.[1] ?? '');
  const nameOf = (s) => (s.match(/([\w$]+)\s*\(/)?.[1] ?? '');

  const added = b.filter((x) => !a.includes(x));
  const removed = a.filter((x) => !b.includes(x));
  const retChanged = ret(sc.before) !== ret(sc.after);

  // Small lists are clearer shown whole.
  if (a.length <= 4 && b.length <= 4) {
    return `<div class="sigChange" title="${esc(sc.before)} → ${esc(sc.after)}">
      <span class="was">${esc(sc.before)}</span><span class="arrow">→</span>
      <span class="now">${esc(sc.after)}</span></div>`;
  }

  const bits = [];
  if (retChanged) bits.push(`<div>returns <span class="was">${esc(ret(sc.before))}</span>
    <span class="arrow">→</span><span class="now">${esc(ret(sc.after))}</span></div>`);
  for (const x of added) bits.push(`<div><span class="now">+ ${esc(x)}</span></div>`);
  for (const x of removed) bits.push(`<div><span class="was">− ${esc(x)}</span></div>`);
  if (!bits.length) bits.push('<div>parameter order changed</div>');

  return `<div class="sigChange" title="${esc(sc.before)}&#10;→&#10;${esc(sc.after)}">
    <div style="color:var(--dim);margin-bottom:4px">${esc(nameOf(sc.after))}(…) · ${a.length} → ${b.length} params</div>
    ${bits.join('')}</div>`;
}

/**
 * Unified line diff with collapsed context. Two raw panes of source, which is what v1 showed, made
 * the reader find the change themselves — the one job the tool exists to do for them.
 */
function renderDiff(before, after) {
  if (!before && !after) return '<div class="absent">no source</div>';
  if (before?.absent && after?.absent) return `<div class="absent">${esc(before.reason ?? 'absent')}</div>`;
  if (before?.absent) {
    return `<div class="absent">${esc(before.reason ?? 'did not exist before')}</div>
      <pre class="diff">${(after.text ?? '').split('\n').map((l, i) =>
        `<div class="add"><span class="ln">${(after.startLine ?? 1) + i}</span>${esc(l)}</div>`).join('')}</pre>`;
  }
  if (after?.absent) {
    return `<div class="absent">${esc(after.reason ?? 'removed')}</div>
      <pre class="diff">${(before.text ?? '').split('\n').map((l, i) =>
        `<div class="del"><span class="ln">${(before.startLine ?? 1) + i}</span>${esc(l)}</div>`).join('')}</pre>`;
  }

  const a = (before.text ?? '').split('\n');
  const b = (after.text ?? '').split('\n');
  const ops = lcsDiff(a, b);

  // Collapse runs of unchanged lines longer than 2×context.
  const CTX = 3;
  const keep = new Set();
  ops.forEach((op, i) => {
    if (op.t === '=') return;
    for (let k = Math.max(0, i - CTX); k <= Math.min(ops.length - 1, i + CTX); k++) keep.add(k);
  });

  const rows = [];
  let hidden = 0;
  ops.forEach((op, i) => {
    if (!keep.has(i)) { hidden++; return; }
    if (hidden) { rows.push(`<div class="gap">    ⋯ ${hidden} unchanged line${hidden === 1 ? '' : 's'}</div>`); hidden = 0; }
    const cls = op.t === '+' ? 'add' : op.t === '-' ? 'del' : 'ctx';
    const ln = op.t === '-' ? (before.startLine ?? 1) + op.ai : (after.startLine ?? 1) + op.bi;
    const sign = op.t === '=' ? ' ' : op.t;
    rows.push(`<div class="${cls}"><span class="ln">${ln}</span>${sign} ${esc(op.line)}</div>`);
  });
  if (hidden) rows.push(`<div class="gap">    ⋯ ${hidden} unchanged line${hidden === 1 ? '' : 's'}</div>`);
  if (!ops.some((o) => o.t !== '=')) rows.push('<div class="gap">    identical — the change is elsewhere in the file</div>');

  return `<pre class="diff">${rows.join('')}</pre>`;
}

// Classic LCS table; symbol bodies are small enough that O(n·m) is irrelevant here.
function lcsDiff(a, b) {
  const n = a.length; const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: '=', line: a[i], ai: i, bi: j }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', line: a[i], ai: i, bi: j }); i++; }
    else { out.push({ t: '+', line: b[j], ai: i, bi: j }); j++; }
  }
  while (i < n) { out.push({ t: '-', line: a[i], ai: i, bi: j }); i++; }
  while (j < m) { out.push({ t: '+', line: b[j], ai: i, bi: j }); j++; }
  return out;
}

// ------------------------------------------------------------------ reviewed
async function toggleReviewed() {
  if (!S.selected) return;
  const row = $('#fileList').querySelector(`.unit[data-id="${cssEsc(S.selected)}"]`);
  const was = row?.classList.contains('done');
  const r = await fetch(`/api/pr/${encodeURIComponent(S.prId)}/reviewed`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ unitId: S.selected, reviewed: !was }),
  }).then((x) => x.json());
  if (r.progress) { renderProgress(r.progress); S.pr.progress = r.progress; }
  row?.classList.toggle('done', !was);
  $('#markBtn').textContent = !was ? 'unmark reviewed' : 'mark reviewed';
  S.files = await api(`/api/pr/${encodeURIComponent(S.prId)}/files`);
}

const cssEsc = (s) => (window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
