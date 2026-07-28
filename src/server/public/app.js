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

const S = { prId: null, pr: null, files: null, selected: null, mode: 'overview' };

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
  splitter();
  $('#overviewBtn').onclick = () => { S.selected = null; renderFiles(); overview(); };
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

// ------------------------------------------------- impact graph (SVG)
//
// Rendered as an SVG with a viewBox and preserveAspectRatio="xMidYMid meet". That single choice
// removes zoom, pan, fit and resize handling entirely: the content is always fully visible and
// centred in whatever space the pane has. Three attempts at making a canvas library frame itself
// correctly inside a flex pane all failed in the same way — a tiny graph stranded at the bottom.

const NW = 176;          // node width
const NH = 34;           // node height
const VGAP = 12;         // vertical gap between nodes in a lane
const HGAP = 108;        // horizontal gap between lanes

const svgEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));

function svgNode(n, x, y, cls) {
  const classes = ['gNode', cls, n.origin === 'CONTEXT' ? 'ctx' : '', n.broken ? 'broken' : '',
    n.reviewed ? 'reviewed' : ''].filter(Boolean).join(' ');
  // Transparent fill with a coloured border: a solid block made the owner line unreadable, and an
  // outline reads as a state (added / modified / removed) rather than as decoration.
  const col = n.origin === 'CONTEXT' ? '#5d6674' : (COLOR[n.changeKind] ?? '#5d6674');
  const halo = cls === 'centre'
    ? `<rect class="gHalo" x="${x - 5}" y="${y - 5}" width="${NW + 10}" height="${NH + 10}" rx="9"/>` : '';
  const badge = n.origin === 'CONTEXT' ? '' :
    `<text class="gBadge" x="${x + NW - 9}" y="${y + 14}" text-anchor="end" fill="${col}">${svgEsc(n.changeKind[0])}</text>`;
  return `<g class="${classes}" data-id="${svgEsc(n.id)}" tabindex="0">
    ${halo}
    <rect x="${x}" y="${y}" width="${NW}" height="${NH}" fill="${col}" fill-opacity="0.12" stroke="${col}"/>
    <text class="owner" x="${x + 9}" y="${y + 13}" fill="${col}">${svgEsc(clip(n.owner || '—', 24))}</text>
    <text class="name" x="${x + 9}" y="${y + 27}">${svgEsc(clip(bare(n.name), 23))}</text>
    ${badge}
    <title>${svgEsc(n.fqn)}${n.unknown ? `\nUNKNOWN: ${svgEsc(n.unknown)}` : ''}</title>
  </g>`;
}

// Right edge of the source to left edge of the target, as a flat cubic — readable at any scale.
const svgEdge = (x1, y1, x2, y2, cls) => {
  const dx = Math.max(30, (x2 - x1) / 2);
  return `<path class="gEdge ${cls}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}"
    marker-end="url(#arrow-${cls || 'plain'})"/>`;
};

const MARKERS = ['plain', 'broken', 'updated', 'test'].map((k) => {
  const col = { plain: '#4a5464', broken: 'var(--broken)', updated: 'var(--added)', test: 'var(--moved)' }[k];
  return `<marker id="arrow-${k}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6"
    orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${col}"/></marker>`;
}).join('');

function paint(inner, bb) {
  const pad = 26;
  const vb = `${bb.x1 - pad} ${bb.y1 - pad} ${bb.x2 - bb.x1 + pad * 2} ${bb.y2 - bb.y1 + pad * 2}`;
  $('#graph').innerHTML =
    `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid meet"><defs>${MARKERS}</defs>${inner}</svg>`;
  for (const g of $('#graph').querySelectorAll('.gNode')) {
    g.onclick = () => focus(g.dataset.id);
  }
}

function overview() {
  S.mode = 'overview';
  S.selected = null;
  $('#impactTitle').textContent = 'Impact — files';
  $('#impactSub').textContent = 'pick a change to see what calls it';
  $('#overviewBtn').classList.add('on');

  const files = S.files.files;
  if (!files.length) { $('#graph').innerHTML = '<div class="emptyImpact">No changes.</div>'; return; }

  const cols = Math.min(4, Math.ceil(Math.sqrt(files.length)));
  const rows = Math.ceil(files.length / cols);
  const CW = NW + 30;
  const CH = NH + 26;
  let inner = '';
  files.forEach((f, i) => {
    const x = (i % cols) * CW;
    const y = Math.floor(i / cols) * CH;
    const kind = f.broken ? 'REMOVED' : f.added > f.removed ? 'ADDED' : 'MODIFIED';
    const name = f.path.split('/').pop();
    const col = COLOR[kind];
    inner += `<g class="gNode" data-file="${svgEsc(f.path)}" tabindex="0">
      <rect x="${x}" y="${y}" width="${NW}" height="${NH}" fill="${col}" fill-opacity="0.12" stroke="${col}"/>
      <text class="owner" x="${x + 9}" y="${y + 13}" fill="${col}">+${f.added} −${f.removed} ~${f.modified}${f.broken ? ` · ${f.broken}✗` : ''}</text>
      <text class="name" x="${x + 9}" y="${y + 27}">${svgEsc(clip(name.replace(/\.java$/, ''), 21))}</text>
      <title>${svgEsc(f.path)}</title>
    </g>`;
  });

  paint(inner, { x1: 0, y1: 0, x2: cols * CW - 30, y2: rows * CH - 26 });
  for (const g of $('#graph').querySelectorAll('[data-file]')) {
    g.onclick = () => {
      const f = S.files.files.find((x) => x.path === g.dataset.file);
      if (f?.units.length) focus(f.units[0].id);
    };
  }
}

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
    $('#graph').innerHTML = `<div class="emptyImpact">Could not load impact: ${esc(e.message)}</div>`;
    return;
  }

  const tests = $('#showTests').checked ? ego.tests : [];
  const c = ego.counts;
  $('#impactTitle').textContent = 'Impact — focus';
  $('#impactSub').textContent =
    `${c.callers} caller${c.callers === 1 ? '' : 's'} · ${c.callees} callee${c.callees === 1 ? '' : 's'}` +
    `${c.tests ? ` · ${c.tests} test${c.tests === 1 ? '' : 's'}` : ''}` +
    `${c.orphanSites ? ` · ${c.orphanSites} outside any member` : ''}` +
    `${c.fanInKind === 'INDIRECT' ? ' · fan-in indirect' : ''}`;

  // Lanes, left to right: tests, callers, this change, callees. Only populated lanes take space.
  const lanes = [];
  if (tests.length) lanes.push({ key: 'test', label: `TESTS · ${tests.length}`, items: tests });
  lanes.push({ key: 'caller', label: `CALLED BY · ${ego.callers.length}`, items: ego.callers });
  lanes.push({ key: 'centre', label: 'THIS CHANGE', items: [ego.centre] });
  if (ego.callees.length) lanes.push({ key: 'callee', label: `CALLS · ${ego.callees.length}`, items: ego.callees });

  const tallest = Math.max(...lanes.map((l) => l.items.length), 1);
  const laneH = tallest * (NH + VGAP);
  const pos = new Map();
  let inner = '';
  let x = 0;

  for (const l of lanes) {
    const h = l.items.length * (NH + VGAP) - VGAP;
    const y0 = (laneH - h) / 2;                    // each lane is vertically centred
    inner += `<rect class="gLane" x="${x - 12}" y="${-34}" width="${NW + 24}" height="${laneH + 40}" rx="8"/>`;
    inner += `<text class="gLaneLabel" x="${x}" y="${-16}">${svgEsc(l.label)}</text>`;
    l.items.forEach((n, i) => {
      const y = y0 + i * (NH + VGAP);
      pos.set(n.id, { x, y, cx: x + NW, cy: y + NH / 2 });
      inner += svgNode(n, x, y, l.key === 'centre' ? 'centre' : '');
    });
    x += NW + HGAP;
  }

  // Edges last so they sit above the lane bands but below nothing important.
  let edges = '';
  const cp = pos.get(ego.centre.id);
  for (const n of ego.callers) {
    const p = pos.get(n.id);
    if (!p || !cp) continue;
    const cls = n.verdict === 'BROKEN' ? 'broken' : n.verdict === 'UPDATED' ? 'updated' : '';
    edges += svgEdge(p.cx, p.cy, cp.x, cp.cy, cls);
  }
  for (const n of ego.callees) {
    const p = pos.get(n.id);
    if (!p || !cp) continue;
    edges += svgEdge(cp.cx, cp.cy, p.x, p.cy, '');
  }
  for (const n of tests) {
    const p = pos.get(n.id);
    if (!p || !cp) continue;
    edges += svgEdge(p.cx, p.cy, cp.x, cp.cy, 'test');
  }

  paint(edges + inner, { x1: -12, y1: -40, x2: x - HGAP + NW + 12, y2: laneH + 8 });

  if (!ego.callers.length && !ego.callees.length) {
    $('#impactSub').textContent += ' — no resolved callers or callees';
  }
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
  const ps = params(name);
  out.push(`<div class="dTitle" title="${esc(n.fqn)}">
      ${u ? `<span class="ck ${esc(u.changeKind)}">${esc(u.changeKind[0])}</span>` : ''}
      <span class="sym">${esc(owner)}<span class="hash">#</span>${esc(bare(name))}</span>
      ${ps ? `<span class="prm">(${esc(ps.length > 48 ? `${ps.split(',').length} params` : ps)})</span>` : '<span class="prm">()</span>'}
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

// Drag the divider between graph and detail; the graph re-fits automatically because the SVG
// scales with its box.
function splitter() {
  const el = $('#splitter');
  const col = $('#rightCol');
  let dragging = false;
  el.onmousedown = (e) => { dragging = true; e.preventDefault(); document.body.style.userSelect = 'none'; };
  window.addEventListener('mouseup', () => { dragging = false; document.body.style.userSelect = ''; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const box = col.getBoundingClientRect();
    const pct = Math.min(78, Math.max(18, ((e.clientY - box.top) / box.height) * 100));
    col.style.setProperty('--graphH', `${pct}%`);
  });
}

const cssEsc = (s) => (window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
