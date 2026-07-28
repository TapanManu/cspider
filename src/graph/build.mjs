// Graph construction, break analysis, blast radius, and enrichment.
// Tasks 6.1, 6.2, 6.3, 6.5, 6.5a, 6.6, 6.7, 6.8, 6.10.
//
// Break analysis is the highest-value output: "this signature changed and N call sites were not
// updated" is a complete review finding. Its integrity rests on two rules:
//   - a call site's UPDATED/BROKEN verdict depends on real changed-line data (A3), never a guess
//   - anything not analysed is UNKNOWN with a stated reason, never silently absent (A2)

import { execFileSync } from 'node:child_process';
import { signatureCompatibility, isTestSource, isPublicApi } from '../java/compat.mjs';

export const VERDICTS = ['BROKEN', 'UNKNOWN', 'UPDATED', 'SAFE'];

/**
 * @param analysis  one PR analysis
 * @param resolvers { head, base }  started JavaResolvers; base may be null
 * @param opts      { maxSymbols, buildRootPrefix, touched, touchedSource, depth, queryBudget }
 */
export async function buildGraph(analysis, resolvers, opts = {}) {
  const head = resolvers?.head ?? resolvers ?? null;   // tolerate a bare resolver
  const base = resolvers?.base ?? null;
  const {
    maxSymbols = Infinity, buildRootPrefix = '',
    touchedHead = new Map(), touchedBase = new Map(),
    touchedSource = 'none', depth = 2, queryBudget = 400,
  } = opts;

  const nodes = new Map();
  const edges = [];
  const unresolved = [];
  const truncations = [];
  let budget = queryBudget;

  // One CALLS edge per (target, call site). Break analysis knows the site but not yet the
  // enclosing caller; expansion resolves that and fills `from` in on the SAME edge. Without this
  // index the two stages each created their own edge — 78 of 244 were duplicates.
  const edgeIndex = new Map();
  const edgeKey = (type, to, path, line) => `${type}|${to}|${path}:${line}`;
  const addEdge = (type, to, site, extra = {}) => {
    const k = edgeKey(type, to, site.path, site.line);
    const existing = edgeIndex.get(k);
    if (existing) {
      Object.assign(existing, extra);
      return existing;
    }
    const e = {
      type, from: null, to, derivedFrom: 'LSP',
      evidence: [{ path: site.path, line: site.line }], ...extra,
    };
    edgeIndex.set(k, e);
    edges.push(e);
    return e;
  };
  const addCallEdge = (to, site, extra = {}) => addEdge('CALLS', to, site, extra);

  const strip = (p) => (buildRootPrefix && p.startsWith(`${buildRootPrefix}/`)
    ? p.slice(buildRootPrefix.length + 1) : p);
  const unstrip = (p) => (buildRootPrefix ? `${buildRootPrefix}/${p}` : p);

  for (const u of analysis.units) {
    nodes.set(u.id, {
      id: u.id, fqn: u.fqn, kind: u.kind, path: u.path, changeKind: u.changeKind,
      deltas: u.deltas, severity: u.severity, origin: 'CHANGED',
      publicApi: isPublicApi(u.symbol), test: isTestSource(u.path),
      callers: null, break: null, fanIn: null, unknown: null,
    });
  }

  if (!head) return { nodes, edges, unresolved, truncations, resolved: false };

  const members = analysis.units
    .filter((u) => u.noise.length === 0)
    .filter((u) => u.kind === 'METHOD' || u.kind === 'CONSTRUCTOR')
    .sort((a, b) => b.severity.total - a.severity.total);

  const selected = members.slice(0, maxSymbols);
  if (members.length > selected.length) {
    truncations.push({ reason: 'maxSymbols', omitted: members.length - selected.length });
  }
  // A2: symbols we chose not to resolve are UNKNOWN, not SAFE.
  for (const u of members.slice(maxSymbols)) {
    nodes.get(u.id).unknown = { reason: `not resolved — beyond the --max-symbols cap` };
  }

  for (const u of selected) {
    const node = nodes.get(u.id);

    // A1: a REMOVED member has no head-side position. Its callers must come from the BASE image.
    const removed = u.changeKind === 'REMOVED';
    const resolver = removed ? base : head;
    if (!resolver) {
      node.unknown = {
        reason: removed
          ? 'removed member — base-image resolution unavailable, so its callers are unknown'
          : 'no resolver available',
      };
      continue;
    }
    if (budget <= 0) {
      node.unknown = { reason: 'resolution query budget exhausted' };
      truncations.push({ reason: 'queryBudget', fqn: u.fqn });
      continue;
    }

    const rel = strip(u.path);
    const pos = u.symbol.selectionRange.start;

    const impls = await resolver.implementations(rel, pos);
    budget--;
    const isOverride = (u.symbol.annotations || []).some((a) => /@Override\b/.test(a))
      || impls.some((i) => strip(i.path) !== rel || i.line !== pos.line + 1);

    const { refs, error } = await resolver.references(rel, pos);
    budget--;
    if (error) {
      // A2/F12: a failed query is not an empty result.
      node.unknown = { reason: `resolution failed: ${error}` };
      unresolved.push({ fqn: u.fqn, reason: error });
      continue;
    }

    // A caller resolved against the BASE image carries base-side line numbers, so it must be
    // checked against base-side deletions. Mixing the two sides yields garbage verdicts.
    const sideMap = removed ? touchedBase : touchedHead;
    const side = removed ? 'base' : 'head';
    const callers = refs
      .filter((r) => !(strip(r.path) === rel && r.line === pos.line + 1))
      .map((r) => {
        const full = unstrip(r.path);
        return { path: full, line: r.line, side, inDiff: sideMap.get(full)?.has(r.line) ?? false };
      });

    node.callers = callers;
    // F1: an override's references resolve to the supertype declaration, so this fan-in cannot be
    // attributed to this implementation. Mark it indirect; never let it alone dominate risk.
    node.fanIn = {
      count: callers.length,
      kind: isOverride ? 'INDIRECT' : 'DIRECT',
      note: isOverride
        ? 'callers of the supertype declaration; dispatch to this implementation is not statically determined'
        : null,
    };
    node.testCovered = callers.some((c) => isTestSource(c.path));

    for (const c of callers) {
      addCallEdge(u.id, c);
      // A test's coverage edge needs a caller endpoint too, or it can never be drawn and the
      // "test-covers" filter would silently do nothing.
      if (isTestSource(c.path)) addEdge('TEST_COVERS', u.id, c);
    }

    const contractChanged = removed || u.deltas.some((d) =>
      ['SIGNATURE', 'VISIBILITY', 'THROWS', 'ANNOTATION'].includes(d.type));
    if (!contractChanged) {
      for (const c of callers) addCallEdge(u.id, c, { verdict: 'SAFE' });
      continue;
    }

    // A3: without real changed-line data every verdict would be a guess. Say so instead.
    if (touchedSource === 'none' && callers.length) {
      node.unknown = {
        reason: 'changed-line data unavailable, so UPDATED cannot be distinguished from BROKEN',
      };
      continue;
    }

    const before = u.from || removed
      ? {
          ...u.symbol,
          signature: u.signatureChange?.before ?? u.symbol.signature,
          visibility: prevDelta(u, 'VISIBILITY') ?? u.symbol.visibility,
          throws: prevDelta(u, 'THROWS') ?? u.symbol.throws,
          annotations: prevDelta(u, 'ANNOTATION') ?? u.symbol.annotations,
        }
      : { ...u.symbol,
          visibility: prevDelta(u, 'VISIBILITY') ?? u.symbol.visibility,
          throws: prevDelta(u, 'THROWS') ?? u.symbol.throws,
          annotations: prevDelta(u, 'ANNOTATION') ?? u.symbol.annotations };

    const verdicts = { UPDATED: 0, BROKEN: 0, SAFE: 0 };
    const detail = [];
    for (const c of callers) {
      const r = signatureCompatibility(before, removed ? null : u.symbol, { inDiff: c.inDiff });
      verdicts[r.verdict]++;
      detail.push({ ...c, verdict: r.verdict, reasons: r.reasons });
      addCallEdge(u.id, c, { verdict: r.verdict });
    }
    node.break = { verdicts, detail, contractChange: describeContract(u, removed) };
  }

  // A2: ambiguous overload sets that the differ deliberately left unpaired.
  for (const s of analysis.suggestions ?? []) {
    const n = [...nodes.values()].find((x) => x.fqn === s.addedFqn);
    if (n && !n.break && !n.unknown) {
      n.unknown = { reason: `possible rename/move of ${s.removedFqn} (${s.confidence}% — below threshold), so its contract change is unclassified` };
    }
  }

  return {
    nodes, edges, edgeIndex, unresolved, truncations, resolved: true,
    queries: (head?.queries ?? 0) + (base?.queries ?? 0),
    budgetLeft: budget,
    touchedSource,
  };
}

const prevDelta = (u, type) => u.deltas.find((d) => d.type === type)?.before;

function describeContract(u, removed) {
  const out = [];
  if (removed) out.push(`removed: ${u.symbol.signature}`);
  if (u.signatureChange) out.push(`${u.signatureChange.before} → ${u.signatureChange.after}`);
  for (const d of u.deltas) {
    if (d.type === 'BODY' || d.type === 'SIGNATURE') continue;
    out.push(`${d.type.toLowerCase()}: ${fmt(d.before)} → ${fmt(d.after)}`);
  }
  return out;
}
const fmt = (v) => (Array.isArray(v) ? (v.length ? v.join(' ') : '∅') : String(v ?? '∅'));

// Task 6.8 — five change-derived components. Defect density excluded by default (R3).
export function scoreRisk(node) {
  const c = [];
  const add = (name, points, detail) => { if (points) c.push({ name, points, detail }); };

  const broken = node.break?.verdicts.BROKEN ?? 0;
  add('broken-call-sites', broken ? 30 : 0, broken ? `${broken} call site(s) not updated` : null);
  add('public-api-change',
    node.publicApi && node.deltas.some((d) => ['SIGNATURE', 'VISIBILITY'].includes(d.type)) ? 20 : 0);

  const fan = node.fanIn?.count ?? 0;
  const fanPoints = Math.min(15, Math.round(Math.log2(fan + 1) * 4));
  add('fan-in', node.fanIn?.kind === 'INDIRECT' ? Math.round(fanPoints / 2) : fanPoints,
    `${fan} caller(s)${node.fanIn?.kind === 'INDIRECT' ? ' (indirect)' : ''}`);

  if (!node.test && node.callers && !node.testCovered) {
    add('no-test-coverage', 15, 'no test source reaches this symbol');
  }
  add('body-churn', node.deltas.some((d) => d.type === 'BODY') ? 10 : 0);

  return { total: c.reduce((n, x) => n + x.points, 0), components: c };
}

// Task 6.6 — CO_CHANGED from git history. A correlation, never presented as a fact.
export function coChangedEdges(clonePath, paths, { window = 200, minSample = 5, threshold = 0.5 } = {}) {
  const counts = new Map();
  const commitsOf = new Map();
  for (const p of paths) {
    try {
      const log = execFileSync('git', ['log', `-n${window}`, '--format=%H', '--', p],
        { cwd: clonePath, encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'] });
      const set = new Set(log.trim().split('\n').filter(Boolean));
      commitsOf.set(p, set);
      counts.set(p, set.size);
    } catch { commitsOf.set(p, new Set()); counts.set(p, 0); }
  }

  const edges = [];
  const list = [...paths];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]; const b = list[j];
      const ca = commitsOf.get(a); const cb = commitsOf.get(b);
      if (!ca || !cb) continue;
      if (Math.min(ca.size, cb.size) < minSample) continue;
      let both = 0;
      for (const h of ca) if (cb.has(h)) both++;
      const union = ca.size + cb.size - both;
      const ratio = union ? both / union : 0;
      if (ratio >= threshold) {
        edges.push({ type: 'CO_CHANGED', derivedFrom: 'GIT_HISTORY', from: a, to: b,
          ratio: +ratio.toFixed(2), sample: union, coCommits: both });
      }
    }
  }
  return edges.sort((x, y) => y.ratio - x.ratio);
}

/**
 * Task 6.10 — review order. Callers before callees over CALLS edges; cycles broken by descending
 * risk. Falls back to risk order when no edges exist (unresolved runs).
 */
export function topologicalOrder(nodes, edges) {
  const byFqn = new Map();
  for (const n of nodes.values()) byFqn.set(n.path + '|' + n.fqn, n);

  // CALLS edges carry a target node id and caller evidence paths; build node→node edges where
  // the caller is itself a changed node in this PR.
  const nodeAtPath = new Map();
  for (const n of nodes.values()) {
    if (!nodeAtPath.has(n.path)) nodeAtPath.set(n.path, []);
    nodeAtPath.get(n.path).push(n);
  }

  const out = new Map();  // caller -> Set(callee)
  const indeg = new Map();
  for (const n of nodes.values()) { out.set(n.id, new Set()); indeg.set(n.id, 0); }

  for (const e of edges) {
    if (e.type !== 'CALLS') continue;
    const site = e.evidence?.[0];
    if (!site) continue;
    const candidates = nodeAtPath.get(site.path) ?? [];
    // Attribute the call site to the enclosing changed node when one exists at that path.
    const caller = candidates.find((n) => n.id !== e.to);
    if (!caller) continue;
    if (out.get(caller.id).has(e.to)) continue;
    out.get(caller.id).add(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
  }

  const risk = (n) => (n.risk?.total ?? n.severity?.total ?? 0);
  const ready = [...nodes.values()].filter((n) => indeg.get(n.id) === 0)
    .sort((a, b) => risk(b) - risk(a));
  const ordered = [];
  const seen = new Set();

  while (ready.length) {
    const n = ready.shift();
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    ordered.push(n);
    for (const next of out.get(n.id)) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) {
        const node = [...nodes.values()].find((x) => x.id === next);
        if (node && !seen.has(next)) ready.push(node);
      }
    }
    ready.sort((a, b) => risk(b) - risk(a));
  }

  // Whatever remains is in a cycle — append by descending risk, and say so.
  const cyclic = [...nodes.values()].filter((n) => !seen.has(n.id)).sort((a, b) => risk(b) - risk(a));
  return { ordered: [...ordered, ...cyclic], cyclic: cyclic.map((n) => n.fqn) };
}

/**
 * Task 6.3 / 6.4 — blast-radius expansion.
 *
 * Adds CONTEXT nodes for the symbols that call the changed ones, out to `depth` hops. Bounded
 * three ways, and every bound that bites is recorded on the node that was truncated:
 *
 *   depth      hard cap (default 2). Depth 3 on a service-layer method with high fan-in produces
 *              thousands of nodes and a hairball no reviewer can use.
 *   maxNodes   total node ceiling.
 *   budget     outstanding resolution requests. This is the real constraint, not node count —
 *              `references` measured ~11s/symbol on a monorepo versus ~0.4s on a small repo.
 *
 * Silent truncation is the one thing this must never do: "nothing else is affected" is the most
 * dangerous possible lie for a review tool.
 */
export async function expandBlastRadius(graph, resolver, opts = {}) {
  const {
    depth = 2, maxNodes = 400, queryBudget = 300,
    buildRootPrefix = '', onlyFrom = null,
  } = opts;
  if (!resolver) return { added: 0, truncated: [], budgetLeft: 0, reachedDepth: 0 };

  const strip = (p) => (buildRootPrefix && p.startsWith(`${buildRootPrefix}/`)
    ? p.slice(buildRootPrefix.length + 1) : p);
  const unstrip = (p) => (buildRootPrefix ? `${buildRootPrefix}/${p}` : p);

  let budget = queryBudget;
  const truncated = [];
  const contextId = (path, name) => `ctx:${path}#${name}`;
  let added = 0;
  let reachedDepth = 0;

  // Seed: changed nodes that already have resolved callers.
  let frontier = [...graph.nodes.values()]
    .filter((n) => n.origin === 'CHANGED' && n.callers?.length)
    .filter((n) => !onlyFrom || n.id === onlyFrom);

  for (let d = 1; d <= depth; d++) {
    const next = [];
    for (const node of frontier) {
      for (const site of node.callers ?? []) {
        if (graph.nodes.size >= maxNodes) {
          truncated.push({ nodeId: node.id, fqn: node.fqn, reason: 'maxNodes', depth: d });
          break;
        }
        if (budget <= 0) {
          truncated.push({ nodeId: node.id, fqn: node.fqn, reason: 'queryBudget', depth: d });
          break;
        }

        const rel = strip(site.path);
        const encl = await resolver.enclosingMember(rel, site.line);
        budget--;
        if (!encl) {
          // A call site outside any member (field initialiser, static block) is still real —
          // record it on the edge rather than dropping the relationship.
          continue;
        }

        const id = contextId(site.path, encl.name);
        // If this caller is itself a changed node, link to that instead of duplicating it.
        const existingChanged = [...graph.nodes.values()].find(
          (n) => n.origin === 'CHANGED' && n.path === site.path && n.fqn.endsWith(`#${encl.simpleName}${paramsOf(encl)}`));
        const fromId = existingChanged?.id ?? id;

        if (!existingChanged && !graph.nodes.has(id)) {
          const enclOwner = encl.name.includes('.')
            ? encl.name.split('.').slice(0, -1).join('.') : '';
          const enclSimple = encl.name.split('.').pop();
          graph.nodes.set(id, {
            id,
            fqn: `${enclOwner ? `${enclOwner}#` : ''}${enclSimple}${paramsOf(encl)}`,
            kind: encl.kind === 9 ? 'CONSTRUCTOR' : 'METHOD',
            path: site.path,
            changeKind: 'UNCHANGED',
            origin: 'CONTEXT',
            depth: d,
            deltas: [],
            severity: { total: 0, components: [] },
            publicApi: false,
            test: isTestSource(site.path),
            callers: null,
            break: null,
            fanIn: null,
            unknown: null,
            range: encl.range,
          });
          added++;
        }

        // Fill `from` in on every edge break analysis already created for this call site —
        // CALLS and, when the caller is a test, TEST_COVERS.
        let filled = 0;
        for (const type of ['CALLS', 'TEST_COVERS']) {
          const key = `${type}|${node.id}|${site.path}:${site.line}`;
          const existing = graph.edgeIndex?.get(key);
          if (!existing) continue;
          existing.from = fromId;
          existing.depth = d;
          filled++;
        }
        if (filled === 0) {
          const key = `CALLS|${node.id}|${site.path}:${site.line}`;
          const e = { type: 'CALLS', from: fromId, to: node.id, derivedFrom: 'LSP', depth: d,
            evidence: [{ path: site.path, line: site.line }] };
          graph.edgeIndex?.set(key, e);
          graph.edges.push(e);
        }

        if (d < depth && !existingChanged) next.push(graph.nodes.get(id));
      }
    }
    reachedDepth = d;
    if (next.length === 0) break;

    // Resolve the next ring's own callers so depth d+1 has something to walk.
    frontier = [];
    for (const ctx of next) {
      if (budget <= 1 || graph.nodes.size >= maxNodes) {
        truncated.push({ nodeId: ctx.id, fqn: ctx.fqn, reason: budget <= 1 ? 'queryBudget' : 'maxNodes', depth: d + 1 });
        ctx.unknown = { reason: `callers not resolved — expansion bound reached at depth ${d + 1}` };
        continue;
      }
      const rel = strip(ctx.path);
      const { refs, error } = await resolver.references(rel, ctx.range.start);
      budget--;
      if (error) {
        ctx.unknown = { reason: `resolution failed: ${error}` };
        continue;
      }
      ctx.callers = refs.map((r) => ({ path: unstrip(r.path), line: r.line, side: 'head', inDiff: false }));
      for (const c of ctx.callers) {
        const k = `CALLS|${ctx.id}|${c.path}:${c.line}`;
        if (graph.edgeIndex?.has(k)) continue;
        const e = { type: 'CALLS', from: null, to: ctx.id, derivedFrom: 'LSP', depth: d + 1,
          evidence: [{ path: c.path, line: c.line }] };
        graph.edgeIndex?.set(k, e);
        graph.edges.push(e);
      }
      ctx.fanIn = { count: ctx.callers.length, kind: 'DIRECT', note: null };
      frontier.push(ctx);
    }
  }

  graph.blastRadius = { depth, reachedDepth, added, maxNodes, truncated, budgetLeft: budget };
  return graph.blastRadius;
}

const paramsOf = (encl) => {
  const m = /\(([^)]*)\)/.exec(encl.detail || '');
  return m ? `(${m[1].replace(/\s+/g, '')})` : '';
};
