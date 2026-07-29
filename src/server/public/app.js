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
// Break verdicts, for context nodes that have no change kind of their own. Grey stays the answer for
// a null verdict: "we do not know" must not be able to look like "safe".
const VERDICT_COLOR = { BROKEN: '#ef5f6d', UPDATED: '#e3b341', SAFE: '#46c97a' };

const DELTA_CHIP = {
  SIGNATURE: ['sig', 'signature'], VISIBILITY: ['vis', 'visibility'],
  THROWS: ['thr', 'throws'], ANNOTATION: ['ann', 'annotation'],
  MODIFIER: ['', 'modifier'], BODY: ['', 'body'],
};

const S = {
  prId: null, pr: null, files: null, selected: null, mode: 'overview', drafts: [],
  // null means "not loaded yet", which must render differently from an empty list.
  threads: null, threadsError: null,
  allPrs: [],
  // Tree disclosure. Folders are open unless explicitly closed; files track both directions so an
  // auto-open default can still be overridden either way.
  closedDirs: new Set(), openFiles: new Set(), closedFiles: new Set(),
  // The selected node's file. A CONTEXT node has no change unit, so its path is the only way to
  // locate it in the tree.
  selectedPath: null, selectedName: null,
};

init().catch((e) => { $('#banners').innerHTML = banner('bad', 'Failed to load', esc(e.message)); });

async function init() {
  const { prs } = await api('/api/prs');
  if (prs.length === 0) {
    $('#banners').innerHTML = banner('info', 'Nothing analysed yet',
      'Run <code>npm start -- &lt;pr-url&gt;</code> first.');
    return;
  }
  S.allPrs = prs;
  const picker = $('#prPicker');
  picker.innerHTML = prs.map((p) => `<option value="${esc(p.id)}">${esc(p.id)} — ${esc(p.title ?? '')}</option>`).join('');
  picker.onchange = () => {
    history.replaceState(null, '', `?pr=${encodeURIComponent(picker.value)}`);
    selectPr(picker.value);
  };

  $('#filter').oninput = renderFiles;
  $('#showTests').onchange = () => (S.selected ? focus(S.selected) : null);
  splitter();
  $('#overviewBtn').onclick = () => {
    S.selected = null; S.selectedPath = null; S.selectedName = null;
    renderFiles(); overview();
  };
  $('#markBtn').onclick = toggleReviewed;
  $('#draftsBtn').onclick = openDrawer;
  $('#drawerClose').onclick = () => { $('#drawer').hidden = true; };
  $('#drawer').onclick = (e) => { if (e.target.id === 'drawer') $('#drawer').hidden = true; };
  $('#previewBtn').onclick = preview;

  const wanted = new URLSearchParams(location.search).get('pr');
  picker.value = prs.some((p) => p.id === wanted) ? wanted : prs[0].id;
  await selectPr(picker.value);
}

async function selectPr(prId) {
  S.prId = prId;
  S.selected = null;
  S.selectedPath = null;
  S.selectedName = null;
  S.threads = null;
  S.threadsError = null;
  S.pr = await api(`/api/pr/${encodeURIComponent(prId)}`);
  S.files = await api(`/api/pr/${encodeURIComponent(prId)}/files`);
  await loadDrafts();
  // Existing threads come from a paginated GitHub call, so it must not hold up first paint.
  loadThreads(prId);
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
/**
 * The left pane is a directory tree, not a flat file list. A review is navigated the way the code is
 * organised, so folders nest and each file carries its own changed methods.
 *
 * Runs of single-child directories are collapsed into one row (`main/java/org/sedai`). Six nested
 * rows before reaching a file wastes the whole width of a 330px pane and hides the structure that
 * the nesting was supposed to reveal.
 */
function buildTree(files) {
  const root = { name: '', key: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    const name = parts.pop();
    let node = root;
    for (const p of parts) {
      const key = node.key ? `${node.key}/${p}` : p;
      if (!node.dirs.has(p)) node.dirs.set(p, { name: p, key, dirs: new Map(), files: [] });
      node = node.dirs.get(p);
    }
    node.files.push({ ...f, name });
  }

  const collapse = (d) => {
    let { name } = d;
    let cur = d;
    while (cur.dirs.size === 1 && cur.files.length === 0) {
      const only = [...cur.dirs.values()][0];
      name = `${name}/${only.name}`;
      cur = only;
    }
    const dirs = [...cur.dirs.values()].map(collapse);
    const fileList = [...cur.files].sort((a, b) => b.broken - a.broken || b.risk - a.risk || a.name.localeCompare(b.name));
    // Every unit beneath this folder, which is what its aggregate checkbox acts on.
    const units = [...dirs.flatMap((x) => x.units), ...fileList.flatMap((x) => x.units)];
    return { kind: 'dir', name, key: cur.key, dirs, files: fileList, units };
  };

  return {
    dirs: [...root.dirs.values()].map(collapse),
    files: [...root.files],
  };
}

/** Aggregate review state for a set of units. `partial` is a state of its own, never rounded. */
function aggregate(units) {
  const total = units.length;
  const done = units.filter((u) => u.reviewed).length;
  const stale = units.filter((u) => u.stale).length;
  return { total, done, stale, state: done === 0 ? 'none' : done === total ? 'all' : 'partial' };
}

const box = (agg, ids) => {
  const cls = agg.state === 'all' ? 'ckAll' : agg.state === 'partial' ? 'ckSome' : '';
  return `<span class="revBox ${cls}${agg.stale ? ' ckStale' : ''}" role="checkbox"
    aria-checked="${agg.state === 'all' ? 'true' : agg.state === 'partial' ? 'mixed' : 'false'}"
    data-ids="${esc(ids.join(','))}" data-next="${agg.state === 'all' ? 'false' : 'true'}"
    title="${agg.stale ? `${agg.stale} mark(s) stale — the symbol changed after review` : 'mark reviewed'}"></span>`;
};

function renderFiles() {
  const q = $('#filter').value.trim().toLowerCase();
  const el = $('#fileList');
  const files = S.files.files
    .map((f) => ({ ...f, units: q ? f.units.filter((u) => (u.fqn + f.path).toLowerCase().includes(q)) : f.units }))
    .filter((f) => f.units.length);

  $('#filesTitle').textContent = `Files (${files.length})`;
  if (!files.length) {
    el.innerHTML = '<div class="emptyImpact">Nothing matches that filter.</div>';
    return;
  }

  // A filter is a search: the matches must be visible without hunting for them.
  const autoOpen = !!q || files.length <= 12;
  const tree = buildTree(files);
  const out = [];

  const fileRow = (f, depth) => {
    const agg = aggregate(f.units);
    const open = S.openFiles.has(f.path) || (autoOpen && !S.closedFiles.has(f.path));
    out.push(`
      <div class="tRow tFile ${open ? 'open' : ''}" data-path="${esc(f.path)}" style="--d:${depth}">
        <span class="caret">${open ? '▾' : '▸'}</span>
        ${box(agg, f.units.map((u) => u.id))}
        <span class="fname mono">${esc(f.name)}</span>
        <span class="counts-mini">
          ${f.added ? `<span class="a">+${f.added}</span>` : ''}
          ${f.removed ? `<span class="r">−${f.removed}</span>` : ''}
          ${f.modified ? `<span class="m">~${f.modified}</span>` : ''}
        </span>
        ${f.broken ? `<span class="chip broken">${f.broken}✗</span>` : ''}
        ${f.unknown ? `<span class="chip unknown">${f.unknown}?</span>` : ''}
        <span class="prog">${agg.done}/${agg.total}</span>
      </div>`);
    const base = f.name.replace(/\.[a-z]+$/i, '');
    if (open) out.push(`<div class="units">${f.units.map((u) => unitRow(u, depth + 1, base)).join('')}</div>`);
  };

  const dirRow = (d, depth) => {
    const agg = aggregate(d.units);
    const open = !S.closedDirs.has(d.key);
    out.push(`
      <div class="tRow tDir ${open ? 'open' : ''}" data-dir="${esc(d.key)}" style="--d:${depth}">
        <span class="caret">${open ? '▾' : '▸'}</span>
        ${box(agg, d.units.map((u) => u.id))}
        <span class="dirName">${esc(d.name)}</span>
        <span class="prog">${agg.done}/${agg.total}</span>
      </div>`);
    if (!open) return;
    for (const sub of d.dirs) dirRow(sub, depth + 1);
    for (const f of d.files) fileRow(f, depth + 1);
  };

  for (const d of tree.dirs) dirRow(d, 0);
  for (const f of tree.files) fileRow(f, 0);
  el.innerHTML = out.join('');

  for (const row of el.querySelectorAll('.tDir')) {
    row.onclick = (e) => {
      if (e.target.classList.contains('revBox')) return;
      const k = row.dataset.dir;
      if (S.closedDirs.has(k)) S.closedDirs.delete(k); else S.closedDirs.add(k);
      renderFiles();
    };
  }
  for (const row of el.querySelectorAll('.tFile')) {
    row.onclick = (e) => {
      if (e.target.classList.contains('revBox')) return;
      const p = row.dataset.path;
      if (row.classList.contains('open')) { S.openFiles.delete(p); S.closedFiles.add(p); }
      else { S.openFiles.add(p); S.closedFiles.delete(p); }
      renderFiles();
    };
  }
  for (const row of el.querySelectorAll('.unit')) {
    row.onclick = (e) => {
      if (e.target.classList.contains('revBox')) return;
      focus(row.dataset.id);
    };
  }
  for (const b of el.querySelectorAll('.revBox')) {
    b.onclick = async (e) => {
      e.stopPropagation();
      const ids = b.dataset.ids.split(',').filter(Boolean);
      if (ids.length) await setReviewed(ids, b.dataset.next === 'true');
    };
  }
  if (S.selected) markSelectedRow(S.selected);
  else renderCrumb(null);
}

function unitRow(u, depth = 1, fileBase = null) {
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
  // A stale mark is NOT a reviewed mark. Showing a plain tick for a symbol that changed after it was
  // reviewed would tell the reviewer they had already read code they have never seen.
  const agg = { total: 1, done: u.reviewed ? 1 : 0, stale: u.stale ? 1 : 0, state: u.reviewed ? 'all' : 'none' };
  return `
    <div class="unit ${u.reviewed ? 'done' : ''} ${u.stale ? 'stale' : ''}" data-id="${esc(u.id)}"
         style="--d:${depth}" title="${esc(u.fqn)}${u.stale ? ' — mark is stale, the symbol changed after review' : ''}">
      ${box(agg, [u.id])}
      <span class="ck ${esc(u.changeKind)}">${esc(u.changeKind[0])}</span>
      <span class="nm k${esc(u.changeKind)}">${
        // The owner is repeated on every row under a file that already names that class — 44 of 44
        // on the measured PR — and at 19 characters it truncated away the method name, the only part
        // that tells two rows apart. It is kept only where it differs, i.e. an inner class.
        u.owner && u.owner !== fileBase ? `<span class="owner">${esc(u.owner)}.</span>` : ''
      }${esc(bare(u.name))}<span class="owner">(${esc(params(u.name))})</span></span>
      <span class="right">
        <span class="riskbar ${risk >= 40 ? 'hi' : ''}"><i style="width:${Math.min(100, risk * 1.6)}%"></i></span>
        <span class="risk">${risk}</span>
      </span>
      ${chips.length ? `<span class="meta">${chips.join('')}</span>` : ''}
    </div>`;
}

/**
 * Selecting a change from the graph must reveal it in the tree, not merely mark a row that is
 * collapsed out of sight. Ancestor folders and the owning file are opened first, then the row is
 * scrolled into view — otherwise the two views silently disagree about where you are.
 *
 * The whole path is highlighted, not just the row: knowing *where* you are in the hierarchy is the
 * point of having a hierarchy.
 *
 * A caller or test node is CONTEXT — it has no change unit, so no method row can exist for it. It
 * still has a file, and if that file is part of the PR the trail is shown to it. Leaving the tree
 * blank would make a graph click look like it had failed.
 */
function markSelectedRow(id) {
  const byUnit = S.files?.files?.find((f) => f.units.some((u) => u.id === id));
  const owner = byUnit
    ?? (S.selectedPath ? S.files?.files?.find((f) => f.path === S.selectedPath) : null);
  if (owner) {
    let changed = false;
    // Any collapsed ancestor of the owning file, at any depth of the collapsed-chain keys.
    for (const k of [...S.closedDirs]) {
      if (owner.path === k || owner.path.startsWith(`${k}/`)) { S.closedDirs.delete(k); changed = true; }
    }
    if (S.closedFiles.has(owner.path)) { S.closedFiles.delete(owner.path); changed = true; }
    if (!S.openFiles.has(owner.path)) { S.openFiles.add(owner.path); changed = true; }
    if (changed) { renderFiles(); return; }   // renderFiles re-enters here once the row exists
  }

  const el = $('#fileList');
  for (const r of el.querySelectorAll('.unit')) r.classList.toggle('sel', r.dataset.id === id);

  // The trail: the owning file, and every folder that contains it.
  const under = (dirKey) => !!owner && (owner.path === dirKey || owner.path.startsWith(`${dirKey}/`));
  for (const r of el.querySelectorAll('.tFile')) {
    r.classList.toggle('onPath', !!owner && r.dataset.path === owner.path);
    // A context node's file is on the trail but holds no selected method of its own.
    r.classList.toggle('onPathOnly', !!owner && !byUnit && r.dataset.path === owner.path);
  }
  for (const r of el.querySelectorAll('.tDir')) r.classList.toggle('onPath', under(r.dataset.dir));

  // Scroll to the method when there is one, otherwise to the file that stands in for it.
  (el.querySelector('.unit.sel') ?? el.querySelector('.tFile.onPath'))
    ?.scrollIntoView({ block: 'nearest' });

  renderCrumb(id, owner, !!byUnit);
}

/**
 * The tree only contains files this PR changed, so most callers and tests have no row in it at all —
 * on the measured PR, 1 of 12. Clicking one and seeing nothing move looks like a broken click, so the
 * crumb states what is selected and, when it is not in the tree, why.
 */
function renderCrumb(id, owner, isUnit) {
  const box = $('#treeCrumb');
  if (!id) { box.hidden = true; box.innerHTML = ''; return; }
  const name = S.selectedName ?? '';
  box.hidden = false;
  if (isUnit && owner) {
    box.className = '';
    box.innerHTML = `<span class="cLbl">in tree</span>
      <span class="cPath">${esc(owner.path.split('/').slice(-1)[0])}</span>`;
    return;
  }
  if (owner) {
    box.className = 'ctxSel';
    box.innerHTML = `<span class="cLbl">context</span>
      <span class="cPath">${esc(name || owner.path.split('/').slice(-1)[0])}</span>
      <span class="cNote">unchanged by this PR — its file is highlighted, but it has no method row</span>`;
    return;
  }
  box.className = 'ctxSel';
  box.innerHTML = `<span class="cLbl">context</span>
    <span class="cPath">${esc(name || 'selected node')}</span>
    <span class="cNote">this PR does not change its file, so it has no row in the tree</span>`;
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
  //
  // A CONTEXT node has no change kind — this PR did not touch it — so colouring it by change kind
  // says nothing. What it does have is a break VERDICT, which is the most valuable fact in the view.
  // Change kind and verdict share a palette, but CONTEXT nodes are drawn with a dashed stroke and
  // CHANGED ones solid, so dashed-green (SAFE) never reads as solid-green (ADDED).
  const col = n.origin === 'CONTEXT'
    ? (VERDICT_COLOR[n.verdict] ?? '#5d6674')
    : (COLOR[n.changeKind] ?? '#5d6674');
  const halo = cls === 'centre'
    ? `<rect class="gHalo" x="${x - 5}" y="${y - 5}" width="${NW + 10}" height="${NH + 10}" rx="9"/>` : '';
  const badge = n.origin === 'CONTEXT' ? '' :
    `<text class="gBadge" x="${x + NW - 9}" y="${y + 14}" text-anchor="end" fill="${col}">${svgEsc(n.changeKind[0])}</text>`;
  // A reviewed change is still part of the change set, so it stays fully legible and gets an explicit
  // tick. Dimming it would read as CONTEXT, which is already drawn faded and dashed.
  const tick = n.reviewed ? `<text class="gTick" x="${x + NW - 9}" y="${y + NH - 7}" text-anchor="end">✓</text>` : '';
  return `<g class="${classes}" data-id="${svgEsc(n.id)}" tabindex="0">
    ${halo}
    <rect x="${x}" y="${y}" width="${NW}" height="${NH}" fill="${col}" fill-opacity="0.12" stroke="${col}"/>
    <text class="owner" x="${x + 9}" y="${y + 13}" fill="${col}">${svgEsc(clip(n.owner || '—', 24))}</text>
    <text class="name" x="${x + 9}" y="${y + 27}">${svgEsc(clip(bare(n.name), 23))}</text>
    ${badge}
    ${tick}
    <title>${svgEsc(n.fqn)}${n.verdict ? `\ncall site: ${svgEsc(n.verdict)}` : ''}${
      n.role === 'test' && n.alsoCalls ? '\nalso a direct caller' : ''}${
      n.reviewed ? '\nreviewed' : ''}${n.unknown ? `\nUNKNOWN: ${svgEsc(n.unknown)}` : ''}</title>
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
  // A change unit resolves from what is already loaded; a CONTEXT node needs its path from the ego
  // payload below, so the trail is drawn once now and refined once that arrives.
  S.selectedPath = S.files?.files?.find((f) => f.units.some((u) => u.id === id))?.path ?? null;
  markSelectedRow(id);
  renderDetail(id);

  let ego;
  try {
    ego = await api(`/api/pr/${encodeURIComponent(S.prId)}/ego?id=${encodeURIComponent(id)}`);
  } catch (e) {
    $('#graph').innerHTML = `<div class="emptyImpact">Could not load impact: ${esc(e.message)}</div>`;
    return;
  }

  // Now the centre's file is known, so a CONTEXT node can take its place on the trail too.
  if (ego.centre && S.selected === id) {
    S.selectedName = `${ego.centre.owner ? `${ego.centre.owner}.` : ''}${bare(ego.centre.name ?? '')}`;
    if (!S.selectedPath && ego.centre.path) S.selectedPath = ego.centre.path;
    markSelectedRow(id);
  }

  const tests = $('#showTests').checked ? ego.tests : [];
  const c = ego.counts;
  $('#impactTitle').textContent = 'Impact — focus';
  // `callers` is now production reach only. Tests that also call the member are counted in the test
  // figure and named there, so the smaller caller count cannot read as lost reach.
  $('#impactSub').textContent =
    `${c.callers} caller${c.callers === 1 ? '' : 's'} · ${c.callees} callee${c.callees === 1 ? '' : 's'}` +
    `${c.tests ? ` · ${c.tests} test${c.tests === 1 ? '' : 's'}${
      c.testCallers ? ` (${c.testCallers} calling)` : ''}` : ''}` +
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
    let i = -1;
    for (const c of sorted) {
      i++;
      const lines = (c.excerpt?.lines ?? []).map((l) =>
        `<div class="${l.isCallSite ? 'del' : 'ctx'}"><span class="ln">${l.line}</span>${esc(l.text)}</div>`).join('');
      const aid = `s${i}`;
      const mine = draftsFor(c.path, c.line);
      out.push(`
        <div class="site ${c.verdict === 'BROKEN' ? 'brokenSite' : ''} ${mine.length ? 'hasDraft' : ''}">
          <div class="hd">
            ${c.verdict ? `<span class="v ${esc(c.verdict)}">${esc(c.verdict)}</span>` : ''}
            <span class="loc">${esc(c.path.split('/').slice(-2).join('/'))}:${c.line}</span>
            ${c.side === 'base' ? '<span class="note">base image</span>' : ''}
            ${mine.length ? `<span class="draftMark">${mine.length} draft${mine.length === 1 ? '' : 's'}</span>` : ''}
          </div>
          ${c.excerpt?.absent ? '<div class="absent" style="padding:5px 7px">source unavailable at this revision</div>'
            : `<pre class="diff">${lines}</pre>`}
          ${c.reasons?.length ? `<div class="note" style="padding:0 7px 5px">${esc(c.reasons.join('; '))}</div>` : ''}
          <div class="siteFoot">
            <button data-comment="${aid}">comment</button>
            <div class="spacer"></div>
          </div>
          ${commentBox(c.path, c.line, aid).replace('<div class="cmtBox"',
            `<div class="cmtBox" data-path="${esc(c.path)}" data-line="${c.line}" data-side="${esc(c.side ?? 'head')}"`)}
        </div>`);
    }
  }

  if (d.source) {
    // The anchor's side must come from whichever revision supplied the line. A REMOVED member has
    // no head line at all, so anchoring it takes the base line and LEFT — sending a base line as
    // RIGHT mixes the two numbering spaces (A3) and costs the deleted code its inline anchor.
    const anchor = d.source.after?.startLine
      ? { line: d.source.after.startLine, side: 'head' }
      : d.source.before?.startLine
        ? { line: d.source.before.startLine, side: 'base' }
        : u?.symbol?.range?.start?.line != null
          ? { line: u.symbol.range.start.line + 1, side: u.changeKind === 'REMOVED' ? 'base' : 'head' }
          : null;
    const anchorLine = anchor?.line;
    const mine = anchorLine ? draftsFor(n.path, anchorLine) : [];
    out.push(`<h4>Diff
      ${anchorLine ? `<span class="n"><button data-comment="chg">comment on this change${
        anchor.side === 'base' ? ' (deleted code)' : ''}</button></span>` : ''}
      ${u && S.allPrs.length > 1 ? '<span class="n"><button data-shared="1">…and on other PRs</button></span>' : ''}
      ${mine.length ? `<span class="draftMark">${mine.length} draft${mine.length === 1 ? '' : 's'}</span>` : ''}</h4>`);
    if (u && S.allPrs.length > 1) out.push('<div id="sharedPanel" hidden></div>');
    if (anchorLine) {
      out.push(commentBox(n.path, anchorLine, 'chg').replace('<div class="cmtBox"',
        `<div class="cmtBox" data-path="${esc(n.path)}" data-line="${anchorLine}" data-side="${anchor.side}"`));
    }
    out.push('<div class="hintSm" style="padding:0 0 4px">click any line number to comment on that line</div>');
    out.push(renderDiff(d.source.before, d.source.after, n.path));
  }

  out.push(threadsHtml(n, u));

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
  wireCommentBoxes(el);
  wireDiffLines(el);
  wireThreads(el);
  if (u) wireShared(el, u.id);
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
function renderDiff(before, after, path) {
  // A row is commentable only when we know both its line and which revision it came from.
  const anchor = (line, side) => (path && line
    ? ` data-cp="${esc(path)}" data-cl="${line}" data-cs="${side}" title="comment on ${side} line ${line}"` : '');
  const mark = (line, side) => (path && draftsFor(path, line, side).length ? '<span class="lineDraft">●</span>' : '');
  const row = (cls, line, side, text) =>
    `<div class="${cls}"${anchor(line, side)}><span class="ln">${line}</span>${mark(line, side)}${text}</div>`;

  if (!before && !after) return '<div class="absent">no source</div>';
  if (before?.absent && after?.absent) return `<div class="absent">${esc(before.reason ?? 'absent')}</div>`;
  if (before?.absent) {
    return `<div class="absent">${esc(before.reason ?? 'did not exist before')}</div>
      <pre class="diff">${(after.text ?? '').split('\n').map((l, i) =>
        row('add', (after.startLine ?? 1) + i, 'head', esc(l))).join('')}</pre>`;
  }
  if (after?.absent) {
    return `<div class="absent">${esc(after.reason ?? 'removed')}</div>
      <pre class="diff">${(before.text ?? '').split('\n').map((l, i) =>
        row('del', (before.startLine ?? 1) + i, 'base', esc(l))).join('')}</pre>`;
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
    // A deleted line exists only at base; added and context lines are addressed at head.
    rows.push(row(cls, ln, op.t === '-' ? 'base' : 'head', `${sign} ${esc(op.line)}`));
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

// ------------------------------------------------------------------ review drafts (9.x)
//
// Everything here is local. A draft is stored on this machine and shown in the drawer; nothing
// reaches GitHub until the payload has been rendered and explicitly confirmed.

async function loadDrafts() {
  try {
    const r = await api(`/api/pr/${encodeURIComponent(S.prId)}/drafts`);
    S.drafts = r.drafts ?? [];
    $('#draftCount').textContent = String(r.pending ?? 0);
  } catch { S.drafts = []; }
}

// Side matters: base line 40 and head line 40 of one file are different code, so a draft on one
// must not be counted against the other. An omitted side matches either, for callers that have
// only one anchor to offer.
const draftsFor = (path, line, side) =>
  S.drafts.filter((d) => !d.submittedAt && d.path === path && d.line === line
    && (side === undefined || d.side === (side === 'base' ? 'LEFT' : 'RIGHT')));

function commentBox(path, line, anchorId) {
  return `
    <div class="cmtBox" id="box-${anchorId}" hidden>
      <textarea placeholder="comment on ${esc(path.split('/').pop())}:${line}…"></textarea>
      <textarea class="sugg" placeholder="optional: replacement source, posted as a GitHub suggestion" hidden></textarea>
      <div class="row">
        <span class="hintSm">stays local until you submit the review</span>
        <button data-act="toggleSugg">suggest…</button>
        <button data-act="save" class="go">save draft</button>
        <button data-act="cancel">cancel</button>
      </div>
    </div>`;
}

function wireCommentBoxes(scope) {
  for (const btn of scope.querySelectorAll('[data-comment]')) {
    btn.onclick = () => {
      const box = scope.querySelector(`#box-${btn.dataset.comment}`);
      if (box) box.hidden = !box.hidden;
      box?.querySelector('textarea')?.focus();
    };
  }
  for (const box of scope.querySelectorAll('.cmtBox')) wireBox(box);
}

/** One box's behaviour, split out so a box created on demand for a diff line reuses it verbatim. */
function wireBox(box, { onCancel } = {}) {
  const [body, sugg] = box.querySelectorAll('textarea');
  box.querySelector('[data-act=toggleSugg]').onclick = () => {
    sugg.hidden = !sugg.hidden;
    if (!sugg.hidden) sugg.focus();
  };
  box.querySelector('[data-act=cancel]').onclick = () => {
    if (onCancel) onCancel();
    else box.hidden = true;
  };
  box.querySelector('[data-act=save]').onclick = async () => {
    const payload = {
      unitId: S.selected,
      path: box.dataset.path,
      line: Number(box.dataset.line),
      side: box.dataset.side === 'base' ? 'LEFT' : 'RIGHT',
      body: body.value.trim(),
      suggestion: sugg.hidden ? undefined : sugg.value.trim() || undefined,
    };
    if (!payload.body && !payload.suggestion) { body.focus(); return; }
    const r = await fetch(`/api/pr/${encodeURIComponent(S.prId)}/drafts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((x) => x.json());
    if (r.error) { alert(r.error); return; }
    await loadDrafts();
    // A pr-level fallback is worth stating: the reviewer should know GitHub cannot anchor it.
    if (r.scope === 'pr') {
      alert(`Saved as a pull-request level comment.\n\n${r.reason}\n\nIt will appear in the review body with its location.`);
    }
    renderDetail(S.selected);
  };
}

/**
 * Task 3 — comment on any line of the diff, not just the symbol's first line. Every row carries
 * the line AND the revision it belongs to (a `-` row is base, a `+` or context row is head), so
 * the anchor's side is read off the row rather than assumed.
 */
function wireDiffLines(scope) {
  for (const row of scope.querySelectorAll('.diff > [data-cl]')) {
    row.querySelector('.ln').onclick = () => {
      const existing = row.nextElementSibling;
      if (existing?.classList.contains('lineBox')) { existing.remove(); return; }
      const path = row.dataset.cp;
      const line = Number(row.dataset.cl);
      const side = row.dataset.cs;
      const holder = document.createElement('div');
      holder.className = 'lineBox';
      holder.innerHTML = commentBox(path, line, `l${side}${line}`)
        .replace('<div class="cmtBox"', `<div class="cmtBox" data-path="${esc(path)}" data-line="${line}" data-side="${side}"`)
        .replace(' hidden>', '>');
      row.after(holder);
      wireBox(holder.querySelector('.cmtBox'), { onCancel: () => holder.remove() });
      holder.querySelector('textarea').focus();
    };
  }
}

// ------------------------------------------------------------------ shared findings (9.7)
// One body, several PRs, each anchored to its own location. A PR that does not change this symbol
// is listed as skipped with the reason — inventing an anchor there would be worse than omitting it.

function wireShared(scope, unitId) {
  const btn = scope.querySelector('[data-shared]');
  if (!btn) return;
  const panel = scope.querySelector('#sharedPanel');
  btn.onclick = async () => {
    if (!panel.hidden) { panel.hidden = true; return; }
    panel.hidden = false;
    panel.innerHTML = '<div class="absent">looking for this symbol in the other PRs…</div>';
    let t;
    try {
      t = await api(`/api/shared/targets?prId=${encodeURIComponent(S.prId)}&unitId=${encodeURIComponent(unitId)}`);
    } catch (e) { panel.innerHTML = `<div class="unknownBox">${esc(e.message)}</div>`; return; }

    const rows = t.targets.map((x) => `
      <label class="shTarget">
        <input type="checkbox" checked data-t='${esc(JSON.stringify(x))}'>
        <span class="shPr">${esc(x.prId)}</span>
        <span class="loc">${esc(x.path.split('/').pop())}:${x.line}${x.side === 'LEFT' ? ' (base side)' : ''}</span>
        <span class="ck ${esc(x.changeKind)}">${esc(x.changeKind[0])}</span>
      </label>`).join('');
    const skips = t.skipped.map((s) =>
      `<div class="shSkip">${esc(s.prId)} — ${esc(s.reason)}</div>`).join('');

    panel.innerHTML = `
      <div class="sharedBox">
        <div class="shHd">Apply one comment to <code>${esc(t.fqn.split('#').pop())}</code> in other PRs</div>
        ${t.targets.length ? rows
          : '<div class="absent">No other analysed PR changes this symbol.</div>'}
        ${skips ? `<div class="shSkips"><b>not applicable</b>${skips}</div>` : ''}
        ${t.targets.length ? `
          <textarea placeholder="one body, posted to each PR above at its own location…"></textarea>
          <div class="row">
            <span class="hintSm">each PR gets its own draft and its own anchor — still nothing is sent until you submit that PR's review</span>
            <button data-act="shSave" class="go">save to selected PRs</button>
          </div>` : ''}
        <div class="shResult" hidden></div>
      </div>`;

    const save = panel.querySelector('[data-act=shSave]');
    if (!save) return;
    save.onclick = async () => {
      const ta = panel.querySelector('textarea');
      const body = ta.value.trim();
      if (!body) { ta.focus(); return; }
      const targets = [...panel.querySelectorAll('input[type=checkbox]:checked')]
        .map((c) => JSON.parse(c.dataset.t));
      if (!targets.length) return;
      const r = await fetch('/api/shared/drafts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body, targets }),
      }).then((x) => x.json());
      const out = panel.querySelector('.shResult');
      out.hidden = false;
      if (r.error) { out.innerHTML = `<div class="unknownBox">${esc(r.error)}</div>`; return; }
      // Per-PR outcomes, never a single averaged "saved". One PR anchoring inline while another
      // falls back to pr-level is normal, and the reviewer has to be able to see which is which.
      out.innerHTML = `<div class="shOut"><b>${r.created} saved${r.failed ? `, ${r.failed} refused` : ''}</b>${
        r.results.map((x) => `<div class="shRow">
          <span class="shPr">${esc(x.prId)}</span>
          ${x.ok ? `<span class="scopeTag ${x.scope}">${x.scope === 'pr' ? 'PR-LEVEL' : 'INLINE'}</span>`
            : '<span class="scopeTag refused">REFUSED</span>'}
          <span class="sm">${esc(x.ok ? (x.reason ?? `${x.path.split('/').pop()}:${x.line}`) : x.error)}</span>
        </div>`).join('')}</div>`;
      ta.value = '';
      await loadDrafts();
      renderDrawer();
    };
  };
}

// ------------------------------------------------------------------ existing threads (9.11)
// These are comments already on GitHub. Unlike a draft, a reply here is NOT local — it posts as
// soon as it is confirmed, so the UI says so rather than implying the drawer will hold it.

async function loadThreads(prId) {
  try {
    const r = await api(`/api/pr/${encodeURIComponent(prId)}/threads`);
    if (S.prId !== prId) return;             // the reviewer moved on while we were fetching
    S.threads = r.threads ?? [];
    S.threadsError = r.error ?? null;
  } catch (e) {
    if (S.prId !== prId) return;
    S.threads = [];
    S.threadsError = e.message;
  }
  if (S.selected) renderDetail(S.selected);
}

/** Threads on this symbol: same file, and within the symbol's own line range when we know it. */
function threadsForNode(n, u) {
  if (!S.threads || !n.path) return { list: [], scoped: false };
  const same = S.threads.filter((t) => t.path === n.path);
  const r = u?.symbol?.range;
  if (!r) return { list: same, scoped: false };
  const lo = r.start.line + 1;
  const hi = r.end.line + 1;
  return { list: same.filter((t) => t.line >= lo && t.line <= hi), scoped: true };
}

function threadsHtml(n, u) {
  if (S.threads === null) {
    return '<h4>Conversation</h4><div class="absent">loading existing comments from GitHub…</div>';
  }
  if (S.threadsError) {
    return `<h4>Conversation</h4><div class="unknownBox"><b>could not load existing comments</b> — ${esc(S.threadsError)}
      <span class="sm">This is not the same as there being none.</span></div>`;
  }
  const { list, scoped } = threadsForNode(n, u);
  if (!list.length) return '';
  const out = [`<h4>Conversation <span class="n">${list.length} thread${list.length === 1 ? '' : 's'}${
    scoped ? ' on this symbol' : ' in this file'}</span></h4>`];
  for (const t of list) {
    out.push(`<div class="thread" data-root="${t.rootId}">
      <div class="thHd">
        <span class="loc">${esc(t.path.split('/').pop())}:${t.line ?? '?'}</span>
        <div class="spacer"></div>
        ${t.comments[0]?.url ? `<a href="${esc(t.comments[0].url)}" target="_blank" rel="noreferrer">on GitHub ↗</a>` : ''}
      </div>
      ${t.comments.map((c) => `<div class="thCmt">
        <div class="thWho"><b>${esc(c.author ?? 'unknown')}</b>
          <span class="sm">${esc(String(c.createdAt ?? '').slice(0, 10))}</span></div>
        <div class="thBody">${esc(c.body)}</div>
      </div>`).join('')}
      <div class="thReply">
        <textarea placeholder="reply to ${esc(t.comments[0]?.author ?? 'this thread')}…"></textarea>
        <div class="row">
          <span class="hintSm">a reply is posted to GitHub on confirm — it is not held as a draft</span>
          <button data-act="reply">reply…</button>
        </div>
        <div class="thConfirm" hidden></div>
      </div>
    </div>`);
  }
  return out.join('');
}

function wireThreads(scope) {
  for (const th of scope.querySelectorAll('.thread')) {
    const rootId = Number(th.dataset.root);
    const ta = th.querySelector('.thReply textarea');
    const confirm = th.querySelector('.thConfirm');
    th.querySelector('[data-act=reply]').onclick = () => {
      const body = ta.value.trim();
      if (!body) { ta.focus(); return; }
      // Same discipline as a review submit: show the exact payload, then require an explicit yes.
      confirm.hidden = false;
      confirm.innerHTML = `<div class="confirmBar">
        <b>POST</b> /pulls/${S.pr.pr.number}/comments/${rootId}/replies
        <pre class="payload">${esc(JSON.stringify({ body }, null, 2))}</pre>
        <div class="row"><button data-act="go" class="go">confirm & post</button>
          <button data-act="no">cancel</button></div></div>`;
      confirm.querySelector('[data-act=no]').onclick = () => { confirm.hidden = true; confirm.innerHTML = ''; };
      confirm.querySelector('[data-act=go]').onclick = async () => {
        const r = await fetch(`/api/pr/${encodeURIComponent(S.prId)}/threads/reply`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rootId, body, confirmed: true }),
        }).then((x) => x.json());
        if (!r.sent) { confirm.innerHTML = `<div class="confirmBar bad"><b>not sent</b> — ${esc(r.reason ?? r.error ?? 'unknown')}</div>`; return; }
        confirm.innerHTML = `<div class="confirmBar"><b>posted</b> ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noreferrer">view ↗</a>` : ''}</div>`;
        ta.value = '';
        await loadThreads(S.prId);
      };
    };
  }
}

function openDrawer() {
  $('#drawer').hidden = false;
  renderDrawer();
}

function renderDrawer(extra = '') {
  const pending = S.drafts.filter((d) => !d.submittedAt);
  const sent = S.drafts.filter((d) => d.submittedAt);
  const rows = [];

  if (!pending.length) rows.push('<div class="absent">No drafts yet. Comment on a call site or on the change itself.</div>');
  for (const d of pending) {
    rows.push(`
      <div class="draftRow ${d.scope === 'pr' ? 'prLevel' : ''}">
        <div class="loc">
          <span class="scopeTag ${d.scope}">${d.scope === 'pr' ? 'PR-LEVEL' : 'INLINE'}</span>
          ${d.groupId ? '<span class="scopeTag shared" title="one finding, also drafted on other PRs">SHARED</span>' : ''}
          ${esc(d.path)}${d.line ? `:${d.line}` : ''}${d.side === 'LEFT' ? ' (base side)' : ''}
        </div>
        <div class="bd">${esc(d.body)}</div>
        <div class="acts">
          <button data-del="${esc(d.draftId)}">delete</button>
        </div>
      </div>`);
  }
  if (sent.length) {
    rows.push(`<h4>Submitted <span class="n">${sent.length}</span></h4>`);
    for (const d of sent) {
      rows.push(`<div class="draftRow sent"><div class="loc">${esc(d.path)}${d.line ? `:${d.line}` : ''} · review ${esc(d.reviewId ?? '')}</div>
        <div class="bd">${esc(d.body)}</div></div>`);
    }
  }

  $('#drawerBody').innerHTML = rows.join('') + extra;
  for (const b of $('#drawerBody').querySelectorAll('[data-del]')) {
    b.onclick = async () => {
      await fetch(`/api/pr/${encodeURIComponent(S.prId)}/drafts/delete`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftId: b.dataset.del }),
      });
      await loadDrafts();
      renderDrawer();
      if (S.selected) renderDetail(S.selected);
    };
  }
}

/**
 * Task 9.8 — show the exact payload, then require an explicit confirmation. The reviewer approves
 * what will be sent, not a description of it.
 */
async function preview() {
  const event = $('#reviewEvent').value;
  const body = $('#reviewBody').value;
  const p = await fetch(`/api/pr/${encodeURIComponent(S.prId)}/review/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event, body }),
  }).then((x) => x.json());
  if (p.error) { renderDrawer(`<div class="confirmBar"><b>${esc(p.error)}</b></div>`); return; }

  const head = await api(`/api/pr/${encodeURIComponent(S.prId)}/head`).catch(() => null);
  const stale = head?.moved
    ? `<div class="confirmBar"><b>Head moved</b><span>The pull request is now at
        ${esc((head.current ?? '').slice(0, 12))}, analysed at ${esc((head.was ?? '').slice(0, 12))}.
        Submitting is blocked — re-analyse first, because these line numbers refer to the old head.</span></div>`
    : '';

  const extra = `
    <h4>Exactly this will be sent <span class="n">${esc(p.endpoint)}</span></h4>
    <div class="payload">${esc(JSON.stringify(p.payload, null, 2))}</div>
    ${stale}
    ${stale ? '' : `<div class="confirmBar">
      <b>${esc(event.replace('_', ' '))}</b>
      <span>${p.counts.inline} inline · ${p.counts.prLevel} in the review body</span>
      <div class="spacer"></div>
      <button id="confirmBtn" class="${event === 'REQUEST_CHANGES' ? 'danger' : 'go'}">confirm and post to GitHub</button>
    </div>`}`;

  renderDrawer(extra);
  const btn = $('#confirmBtn');
  if (btn) {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'posting…';
      const res = await fetch(`/api/pr/${encodeURIComponent(S.prId)}/review/submit`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event, body, confirmed: true }),
      }).then((x) => x.json());
      await loadDrafts();
      renderDrawer(res.submitted
        ? `<div class="confirmBar" style="border-color:var(--added);background:rgba(70,201,122,.1)">
             <b style="color:var(--added)">Posted</b>
             <span>review ${esc(String(res.reviewId))} · ${esc(res.event)}
             ${res.url ? `· <a href="${esc(res.url)}" target="_blank" style="color:var(--accent)">open on GitHub</a>` : ''}</span></div>`
        : `<div class="confirmBar"><b>Not submitted</b><span>${esc(res.reason ?? 'unknown error')}
             ${res.retainedDrafts ? `· ${res.retainedDrafts} draft(s) kept` : ''}</span></div>`);
    };
  }
}

// ------------------------------------------------------------------ reviewed
/**
 * One path for every review mark, whether it came from a method checkbox, a file, a whole folder, or
 * the header button. The tree, the progress figure and the graph are all re-derived from the server's
 * answer rather than patched in place, so they cannot drift out of agreement with the store.
 */
async function setReviewed(unitIds, reviewed) {
  const r = await fetch(`/api/pr/${encodeURIComponent(S.prId)}/reviewed`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ unitIds, reviewed }),
  }).then((x) => x.json());
  if (r.error) { alert(r.error); return; }
  if (r.progress) { renderProgress(r.progress); S.pr.progress = r.progress; }
  S.files = await api(`/api/pr/${encodeURIComponent(S.prId)}/files`);
  renderFiles();
  renderBanners();
  if (unitIds.includes(S.selected)) {
    $('#markBtn').textContent = reviewed ? 'unmark reviewed' : 'mark reviewed';
  }
  // The graph carries the same mark, so it has to be redrawn or it would contradict the tree.
  if (S.mode === 'focus' && S.selected) await focus(S.selected);
  else overview();
}

async function toggleReviewed() {
  if (!S.selected) return;
  const row = $('#fileList').querySelector(`.unit[data-id="${cssEsc(S.selected)}"]`);
  await setReviewed([S.selected], !row?.classList.contains('done'));
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
