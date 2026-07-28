// cspider UI — tasks 8.7 (facts panel), 8.8 (canvas), 8.9 (ordered list), 8.11 (shared
// selection), 8.12 (edge filtering), 8.13 (disclosure banners).
//
// One rule governs the whole surface: anything the analysis did not establish must LOOK
// unestablished. UNKNOWN is rendered, truncation is rendered, an absent side of a diff says why.

const $ = (s) => document.querySelector(s);
const api = async (p) => {
  const r = await fetch(p);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
  return r.json();
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const shortFqn = (f) => String(f ?? '').replace(/^([a-z0-9_]+\.)+/, (m) => m.split('.').filter(Boolean).map((s) => s[0]).join('.') + '.');

const COLOR = {
  ADDED: '#4ec97a', REMOVED: '#e5626f', MODIFIED: '#e0b341',
  MOVED: '#4aa8e0', RENAMED: '#4aa8e0', UNCHANGED: '#5a6474',
};

const state = { prId: null, pr: null, graph: null, order: null, selected: null, cy: null };

// ------------------------------------------------------------------ boot
init().catch((e) => { $('#banners').innerHTML = banner('bad', 'Failed to load', e.message); });

async function init() {
  const { prs } = await api('/api/prs');
  if (prs.length === 0) {
    $('#banners').innerHTML = banner('info', 'No analysed PRs yet',
      'Run <code>npm run review -- &lt;pr-url&gt; --resolve</code>, then reload.');
    return;
  }
  const picker = $('#prPicker');
  picker.innerHTML = prs.map((p) => `<option value="${esc(p.id)}">${esc(p.id)} — ${esc(p.title ?? '')}</option>`).join('');
  picker.onchange = () => selectPr(picker.value);

  $('#orderMode').onchange = () => loadOrder();
  $('#fit').onclick = () => state.cy?.fit(undefined, 30);
  for (const id of ['#edgeCalls', '#edgeTests', '#showContext']) $(id).onchange = applyFilters;
  $('#markBtn').onclick = toggleReviewed;

  await selectPr(prs[0].id);
}

async function selectPr(prId) {
  state.prId = prId;
  state.selected = null;
  $('#detail').className = 'empty';
  $('#detail').textContent = 'Select a node in the list or the graph.';
  $('#markBtn').hidden = true;

  state.pr = await api(`/api/pr/${encodeURIComponent(prId)}`);
  renderHead();
  renderBanners();
  await Promise.all([loadOrder(), loadGraph()]);
}

// ------------------------------------------------------------------ header + banners (8.13)
function renderHead() {
  const c = state.pr.counts;
  $('#counts').innerHTML =
    `<b>${c.units}</b> units · <b>${c.nodes}</b> nodes · <b>${c.edges}</b> edges` +
    (c.broken ? ` · <b style="color:var(--broken)">${c.broken} broken</b>` : '') +
    (c.unknown ? ` · <b style="color:var(--unknown)">${c.unknown} unknown</b>` : '');
  renderProgress(state.pr.progress);
}

function renderProgress(p) {
  const filled = p.total ? Math.round((p.done / p.total) * 16) : 0;
  $('#progress').innerHTML =
    `reviewed ${'█'.repeat(filled)}${'·'.repeat(16 - filled)} ${p.done}/${p.total}` +
    (p.stale ? ` <span style="color:var(--unknown)">${p.stale} stale</span>` : '');
}

const banner = (cls, title, body) => `<div class="banner ${cls}"><b>${title}</b><span>${body}</span></div>`;

function renderBanners() {
  const s = state.pr.status;
  const out = [];

  if (!s.resolved) {
    out.push(banner('warn', 'Not resolved',
      'This PR was analysed without <code>--resolve</code>: no callers, no break analysis, no blast radius.'));
  }
  if (s.health && s.health.verdict !== 'clean') {
    const cls = s.health.verdict === 'DEGRADED' ? 'bad' : 'warn';
    out.push(banner(cls, `Resolution ${s.health.verdict}`,
      `${s.health.unresolved} unresolved of ${s.health.errors} error(s). Edges are missing — the graph is incomplete.`));
  }
  if (s.blastRadius?.truncated?.length) {
    const reasons = [...new Set(s.blastRadius.truncated.map((t) => t.reason))].join(', ');
    out.push(banner('warn', 'Expansion truncated',
      `${s.blastRadius.truncated.length} point(s) hit a bound (${esc(reasons)}). Nodes beyond them were never explored.`));
  }
  if (s.truncations?.some((t) => t.reason === 'maxSymbols')) {
    const n = s.truncations.filter((t) => t.reason === 'maxSymbols').reduce((a, t) => a + (t.omitted ?? 0), 0);
    out.push(banner('warn', 'Symbols not resolved',
      `${n} symbol(s) were beyond the resolution cap and are reported UNKNOWN, not safe.`));
  }
  if (s.touchedSource && s.touchedSource !== 'git') {
    out.push(banner(s.touchedSource === 'none' ? 'bad' : 'warn', 'Changed-line data',
      s.touchedSource === 'none'
        ? 'Unavailable — UPDATED cannot be distinguished from BROKEN.'
        : 'Derived from GitHub patch rather than git; large diffs may be incomplete.'));
  }
  if (state.pr.progress.stale) {
    out.push(banner('warn', 'Stale review marks',
      `${state.pr.progress.stale} symbol(s) changed since they were marked reviewed.`));
  }
  $('#banners').innerHTML = out.join('');
}

// ------------------------------------------------------------------ ordered list (8.9)
async function loadOrder() {
  const mode = $('#orderMode').value;
  state.order = await api(`/api/pr/${encodeURIComponent(state.prId)}/order?mode=${mode}`);
  const list = $('#unitList');
  list.innerHTML = state.order.units.map((u) => `
    <li data-id="${esc(u.id)}" class="${u.reviewed ? 'done' : ''}">
      <span class="tag ${esc(u.changeKind)}">${esc(u.changeKind[0])}</span>
      <span class="uname" title="${esc(u.fqn)}">${esc(shortFqn(u.fqn))}
        <span class="upath">${esc(u.path.split('/').pop())}</span></span>
      ${u.broken ? `<span class="pill broken">${u.broken}✗</span>` : ''}
      ${u.unknown ? '<span class="pill unknown">?</span>' : ''}
      <span class="pill risk">${u.risk ?? u.severity}</span>
    </li>`).join('');
  for (const li of list.children) li.onclick = () => select(li.dataset.id, 'list');
  if (state.selected) highlight(state.selected);
}

// ------------------------------------------------------------------ canvas (8.8, 8.12)
async function loadGraph() {
  state.graph = await api(`/api/pr/${encodeURIComponent(state.prId)}/graph`);
  if (!state.graph.resolved) {
    $('#cy').innerHTML = '<div style="padding:20px;color:var(--faint)">No graph — this PR was analysed without --resolve.</div>';
    $('#legend').innerHTML = '';
    return;
  }

  const elements = [
    ...state.graph.nodes.map((n) => ({
      data: {
        id: n.id, label: shortFqn(n.fqn).split('#').pop() || shortFqn(n.fqn),
        changeKind: n.changeKind, origin: n.origin, risk: n.risk,
        broken: n.broken, unknown: !!n.unknown, reviewed: n.reviewed,
        // size encodes risk; a node is never smaller than legible
        size: Math.max(16, Math.min(46, 16 + (n.risk ?? 0) * 0.5)),
      },
    })),
    ...state.graph.edges.map((e) => ({
      data: { id: e.id, source: e.source, target: e.target, type: e.type, verdict: e.verdict },
    })),
  ];

  state.cy = cytoscape({
    container: $('#cy'),
    elements,
    layout: { name: 'cose', animate: false, nodeRepulsion: 9000, idealEdgeLength: 90, padding: 30 },
    style: [
      { selector: 'node', style: {
        'background-color': (n) => COLOR[n.data('changeKind')] ?? '#5a6474',
        width: 'data(size)', height: 'data(size)',
        label: 'data(label)', 'font-size': 9, 'font-family': 'ui-monospace, monospace',
        color: '#8b95a6', 'text-valign': 'bottom', 'text-margin-y': 3,
        'text-max-width': 120, 'text-wrap': 'ellipsis',
        'border-width': 2, 'border-color': 'transparent',
      } },
      // CONTEXT nodes are unchanged code pulled in for reach — visually secondary, never
      // mistakable for something the PR touched.
      { selector: 'node[origin = "CONTEXT"]', style: {
        'background-opacity': 0.25, 'border-width': 1, 'border-style': 'dashed',
        'border-color': '#5a6474', shape: 'round-rectangle',
      } },
      { selector: 'node[?broken]', style: { 'border-color': '#ff5f6b', 'border-width': 3 } },
      { selector: 'node[?unknown]', style: { 'border-color': '#d99a2b', 'border-width': 2, 'border-style': 'dotted' } },
      { selector: 'node[?reviewed]', style: { 'background-opacity': 0.35, opacity: 0.55 } },
      { selector: 'node.sel', style: { 'border-color': '#7aa2f7', 'border-width': 4, 'border-style': 'solid' } },
      { selector: 'node.dim', style: { opacity: 0.12 } },

      { selector: 'edge', style: {
        width: 1, 'line-color': '#3a4250', 'curve-style': 'bezier',
        'target-arrow-shape': 'triangle', 'target-arrow-color': '#3a4250', 'arrow-scale': 0.7,
      } },
      { selector: 'edge[verdict = "BROKEN"]', style: { 'line-color': '#ff5f6b', 'target-arrow-color': '#ff5f6b', width: 2 } },
      { selector: 'edge[verdict = "UPDATED"]', style: { 'line-color': '#4ec97a', 'target-arrow-color': '#4ec97a' } },
      // Non-resolved edge kinds must not look like resolved ones.
      { selector: 'edge[type = "TEST_COVERS"]', style: { 'line-style': 'dashed', 'line-color': '#4aa8e0', 'target-arrow-color': '#4aa8e0' } },
      { selector: 'edge.hidden', style: { display: 'none' } },
      { selector: 'edge.hl', style: { width: 3, 'line-color': '#7aa2f7', 'target-arrow-color': '#7aa2f7', 'z-index': 99 } },
    ],
  });

  state.cy.on('tap', 'node', (ev) => select(ev.target.id(), 'graph'));
  state.cy.on('tap', (ev) => { if (ev.target === state.cy) clearSelection(); });

  $('#legend').innerHTML = [
    ...['ADDED', 'REMOVED', 'MODIFIED', 'MOVED'].map((k) => `<i><span class="swatch" style="background:${COLOR[k]}"></span>${k.toLowerCase()}</i>`),
    '<i><span class="swatch" style="background:#5a6474;opacity:.4"></span>context (unchanged)</i>',
    '<i style="color:#ff5f6b">▬ broken call</i>',
    '<i style="color:#4aa8e0">╌ test-covers</i>',
    '<i>size = risk</i>',
    state.graph.undrawableEdges
      ? `<i style="color:var(--unknown)">${state.graph.undrawableEdges} edge(s) not drawable (call site outside any member)</i>`
      : '',
  ].join('');
  applyFilters();
}

function applyFilters() {
  if (!state.cy) return;
  const calls = $('#edgeCalls').checked;
  const tests = $('#edgeTests').checked;
  const ctx = $('#showContext').checked;
  state.cy.batch(() => {
    state.cy.edges().forEach((e) => {
      const t = e.data('type');
      const on = (t === 'CALLS' && calls) || (t === 'TEST_COVERS' && tests);
      e.toggleClass('hidden', !on);
    });
    state.cy.nodes().forEach((n) => {
      n.style('display', (!ctx && n.data('origin') === 'CONTEXT') ? 'none' : 'element');
    });
  });
}

// ------------------------------------------------------- shared selection (8.11)
function highlight(id) {
  for (const li of $('#unitList').children) li.classList.toggle('sel', li.dataset.id === id);
  if (!state.cy) return;
  state.cy.batch(() => {
    state.cy.elements().removeClass('sel hl dim');
    const n = state.cy.getElementById(id);
    if (!n || n.empty()) return;
    n.addClass('sel');
    const nbr = n.closedNeighborhood();
    state.cy.nodes().difference(nbr.nodes()).addClass('dim');
    nbr.edges().addClass('hl');
  });
}

function clearSelection() {
  state.selected = null;
  state.cy?.elements().removeClass('sel hl dim');
  for (const li of $('#unitList').children) li.classList.remove('sel');
  $('#markBtn').hidden = true;
  $('#detail').className = 'empty';
  $('#detail').textContent = 'Select a node in the list or the graph.';
}

async function select(id, from) {
  state.selected = id;
  highlight(id);
  if (from === 'list') {
    const n = state.cy?.getElementById(id);
    if (n && !n.empty()) state.cy.animate({ center: { eles: n } }, { duration: 180 });
  } else {
    const li = [...$('#unitList').children].find((x) => x.dataset.id === id);
    li?.scrollIntoView({ block: 'nearest' });
  }
  await renderDetail(id);
}

// ------------------------------------------------------------------ facts panel (8.7)
async function renderDetail(id) {
  const el = $('#detail');
  el.className = '';
  el.innerHTML = '<span class="absent">loading…</span>';

  let d;
  try {
    d = await api(`/api/pr/${encodeURIComponent(state.prId)}/node/${encodeURIComponent(id)}`);
  } catch (e) {
    el.innerHTML = `<span class="absent">${esc(e.message)}</span>`;
    return;
  }

  const n = d.node;
  const u = d.unit;
  const btn = $('#markBtn');
  btn.hidden = !u;
  btn.textContent = n.reviewed ? 'unmark reviewed' : 'mark reviewed';

  const parts = [];
  parts.push(`<h3>${esc(shortFqn(n.fqn))}</h3><div class="sub">${esc(n.path ?? '')}</div>`);

  if (n.unknown) {
    parts.push(`<div class="unknownBox"><b>UNKNOWN</b> — ${esc(n.unknown.reason ?? n.unknown)}<div class="note">Not analysed. This is not the same as “no impact”.</div></div>`);
  }

  // facts
  const kv = [];
  kv.push(['kind', `${esc(n.kind ?? '')} · ${esc(n.changeKind ?? '')}${n.origin === 'CONTEXT' ? ' · context' : ''}`]);
  if (u?.symbol) {
    kv.push(['signature', esc(u.symbol.signature)]);
    kv.push(['visibility', esc(u.symbol.visibility)]);
    if (u.symbol.annotations?.length) kv.push(['annotations', esc(u.symbol.annotations.join(' '))]);
    if (u.symbol.throws?.length) kv.push(['throws', esc(u.symbol.throws.join(', '))]);
  }
  if (n.fanIn) {
    kv.push(['callers', `${n.fanIn.count}${n.fanIn.kind === 'INDIRECT' ? ' <span style="color:var(--unknown)">(indirect)</span>' : ''}`]);
  }
  kv.push(['tests reach', n.testCovered === null || n.testCovered === undefined
    ? '<span class="absent">unknown</span>'
    : (n.testCovered ? 'yes' : '<span style="color:var(--unknown)">no</span>')]);
  parts.push(`<h4>Facts</h4><dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`);

  if (n.fanIn?.note) parts.push(`<div class="note">ⓘ ${esc(n.fanIn.note)}</div>`);

  if (u?.deltas?.length) {
    parts.push('<h4>Deltas</h4>');
    for (const dl of u.deltas) {
      if (dl.type === 'BODY') { parts.push('<div class="delta"><b>body</b> changed</div>'); continue; }
      parts.push(`<div class="delta"><b>${esc(dl.type.toLowerCase())}</b> ${esc(fmt(dl.before))} → ${esc(fmt(dl.after))}</div>`);
    }
  }

  if (n.risk?.components?.length) {
    parts.push(`<h4>Risk ${n.risk.total}</h4>`);
    for (const c of n.risk.components) {
      parts.push(`<div class="comp"><span>${esc(c.name)} +${c.points}</span><span>${esc(c.detail ?? '')}</span></div>`);
    }
  }

  // before/after (8.2 groundwork — plain, syntax-free rendering for now)
  if (d.source) {
    parts.push('<h4>Before → after</h4>');
    for (const [side, label] of [['before', 'before'], ['after', 'after']]) {
      const s = d.source[side];
      if (!s) continue;
      parts.push(`<div class="side">${label}${s.startLine ? ` · lines ${s.startLine}–${s.endLine}` : ''}</div>`);
      parts.push(s.absent
        ? `<div class="absent">${esc(s.reason ?? 'absent')}</div>`
        : `<pre>${esc(s.text)}</pre>`);
    }
  }

  // call sites, inlined from the CALLING file (8.5)
  if (d.callers?.length) {
    const v = d.callerSummary;
    parts.push(`<h4>Call sites (${d.callers.length})${v ? ` — ${v.BROKEN} broken · ${v.UPDATED} updated · ${v.SAFE} safe` : ''}</h4>`);
    const sorted = [...d.callers].sort((a, b) =>
      (b.verdict === 'BROKEN') - (a.verdict === 'BROKEN'));
    for (const c of sorted) {
      const lines = (c.excerpt?.lines ?? []).map((l) =>
        `<span class="${l.isCallSite ? 'cs' : ''}">${String(l.line).padStart(5)} ${esc(l.text)}</span>`).join('\n');
      parts.push(`
        <div class="caller">
          <div class="hd">
            ${c.verdict ? `<span class="v ${esc(c.verdict)}">${esc(c.verdict)}</span>` : ''}
            <span class="loc" title="${esc(c.path)}:${c.line}">${esc(c.path.split('/').slice(-2).join('/'))}:${c.line}</span>
            ${c.side === 'base' ? '<span class="note">base image</span>' : ''}
          </div>
          ${c.excerpt?.absent ? '<div class="absent" style="padding:4px 6px">source unavailable at this revision</div>' : `<pre>${lines}</pre>`}
          ${c.reasons?.length ? `<div class="note" style="padding:0 6px 4px">${esc(c.reasons.join('; '))}</div>` : ''}
        </div>`);
    }
  } else if (n.fanIn) {
    parts.push('<h4>Call sites</h4><div class="absent">No callers resolved.</div>');
  }

  el.innerHTML = parts.join('');
}

const fmt = (v) => (Array.isArray(v) ? (v.length ? v.join(' ') : '∅') : (v ?? '∅'));

// ------------------------------------------------------------------ reviewed toggle (7.3)
async function toggleReviewed() {
  if (!state.selected) return;
  const li = [...$('#unitList').children].find((x) => x.dataset.id === state.selected);
  const wasDone = li?.classList.contains('done');
  const r = await fetch(`/api/pr/${encodeURIComponent(state.prId)}/reviewed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ unitId: state.selected, reviewed: !wasDone }),
  }).then((x) => x.json());
  if (r.progress) renderProgress(r.progress);
  li?.classList.toggle('done', !wasDone);
  state.cy?.getElementById(state.selected)?.data('reviewed', !wasDone);
  $('#markBtn').textContent = !wasDone ? 'unmark reviewed' : 'mark reviewed';
}
