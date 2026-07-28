// Local read/write API for the UI (tasks 7.2, 7.3). Node's http only — no framework.
//
// Everything is served from the store, so the server never starts a language server. That is what
// makes the UI instant: the expensive work happened in the CLI run, and a graph keyed by head SHA
// is content-addressed and safe to reuse.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname, resolve as presolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../store/db.mjs';
import { loadGraph, loadGraphMeta, loadUnits, loadReviewed, markReviewed, unmarkReviewed, progress }
  from '../store/persist.mjs';
import { beforeAfter, callSiteExcerpt, symbolBlocks } from '../ingest/source.mjs';
import { orderUnits, bySeverity } from '../review/order.mjs';
import { topologicalOrder } from '../graph/build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const CYTOSCAPE = presolve(HERE, '..', '..', 'node_modules', 'cytoscape', 'dist', 'cytoscape.min.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

const readBody = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
});

const clonePathFor = (cacheDir, nwo) => join(cacheDir, 'clones', nwo.replace('/', '__'));

const dedupeById = (list) => {
  const seen = new Map();
  for (const x of list) if (!seen.has(x.id)) seen.set(x.id, x);
  return [...seen.values()];
};

export function createApiServer({ cacheDir, dbPath }) {
  const db = openDb(dbPath);

  const prRow = (prId) => db.prepare('SELECT * FROM prs WHERE id = ?').get(prId);

  /** Everything the UI needs about one PR, assembled from the store alone. */
  function loadPr(prId) {
    const pr = prRow(prId);
    if (!pr) return null;
    const units = loadUnits(db, prId, pr.head_sha) ?? [];
    const graph = loadGraph(db, prId, pr.head_sha);
    const meta = loadGraphMeta(db, prId, pr.head_sha);
    const reviewed = loadReviewed(db, prId, units);
    return { pr, units, graph, meta, reviewed };
  }

  const handlers = {
    // ---------------------------------------------------------------- read (7.2)
    'GET /api/prs': () => ({
      prs: db.prepare('SELECT id, nwo, number, title, url, head_sha, merge_base, build_root, analysed_at FROM prs ORDER BY analysed_at DESC')
        .all()
        .map((r) => {
          const units = loadUnits(db, r.id, r.head_sha) ?? [];
          const rev = loadReviewed(db, r.id, units);
          return { ...r, units: units.length, progress: progress(units, rev) };
        }),
    }),

    'GET /api/pr/:prId': ({ params }) => {
      const data = loadPr(params.prId);
      if (!data) return { __status: 404, error: 'unknown PR — analyse it with the CLI first' };
      const { pr, units, graph, meta, reviewed } = data;
      return {
        pr: {
          id: pr.id, nwo: pr.nwo, number: pr.number, title: pr.title, url: pr.url,
          headSha: pr.head_sha, mergeBase: pr.merge_base, buildRoot: pr.build_root,
          analysedAt: pr.analysed_at,
        },
        // Disclosures travel with the payload, so the UI cannot render a graph as complete
        // when the analysis that produced it was bounded.
        status: {
          resolved: !!graph?.resolved,
          health: meta?.health ?? null,
          blastRadius: meta?.blastRadius ?? null,
          truncations: meta?.truncations ?? [],
          touchedSource: meta?.touchedSource ?? null,
          processor: meta?.processor ?? null,
          queries: meta?.queries ?? null,
        },
        progress: progress(units, reviewed),
        counts: {
          units: units.length,
          nodes: graph?.nodes.size ?? 0,
          edges: graph?.edges.length ?? 0,
          unknown: graph ? [...graph.nodes.values()].filter((n) => n.unknown).length : 0,
          broken: graph
            ? [...graph.nodes.values()].reduce((n, x) => n + (x.break?.verdicts?.BROKEN ?? 0), 0) : 0,
        },
      };
    },

    'GET /api/pr/:prId/files': ({ params }) => {
      const data = loadPr(params.prId);
      if (!data) return { __status: 404, error: 'unknown PR' };
      const { units, graph, reviewed } = data;
      const byPath = new Map();
      for (const u of units) {
        if (!byPath.has(u.path)) {
          byPath.set(u.path, {
            path: u.path, units: [], added: 0, removed: 0, modified: 0, moved: 0,
            risk: 0, broken: 0, unknown: 0, reviewed: 0, noise: 0,
          });
        }
        const f = byPath.get(u.path);
        const n = graph?.nodes.get(u.id);
        const rv = reviewed.state.get(u.id);
        if (u.noise.length) f.noise++;
        else {
          f.units.push({
            id: u.id, fqn: u.fqn, name: u.fqn.split('#').pop() || u.fqn,
            owner: (u.fqn.split('#')[0] || '').split('.').pop(),
            kind: u.kind, changeKind: u.changeKind,
            deltaTypes: u.deltas.map((d) => d.type),
            signatureChange: u.signatureChange ?? null,
            severity: u.severity?.total ?? 0, risk: n?.risk?.total ?? null,
            fanIn: n?.fanIn?.count ?? null, fanInKind: n?.fanIn?.kind ?? null,
            broken: n?.break?.verdicts?.BROKEN ?? 0,
            unknown: n?.unknown?.reason ?? null,
            reviewed: !!rv?.reviewed, stale: !!rv?.stale,
          });
          f[{ ADDED: 'added', REMOVED: 'removed', MODIFIED: 'modified', MOVED: 'moved', RENAMED: 'moved' }[u.changeKind] ?? 'modified']++;
          f.risk = Math.max(f.risk, n?.risk?.total ?? u.severity?.total ?? 0);
          f.broken += n?.break?.verdicts?.BROKEN ?? 0;
          if (n?.unknown) f.unknown++;
          if (rv?.reviewed) f.reviewed++;
        }
      }
      const files = [...byPath.values()]
        .filter((f) => f.units.length > 0)
        .sort((a, b) => b.broken - a.broken || b.risk - a.risk || a.path.localeCompare(b.path));
      for (const f of files) f.units.sort((a, b) => b.broken - a.broken || (b.risk ?? b.severity) - (a.risk ?? a.severity));
      return { files, totalFiles: files.length, suppressed: [...byPath.values()].reduce((n2, f) => n2 + f.noise, 0) };
    },

    /**
     * Ego network for one node: who calls it, what it reaches, one hop each way. This is what a
     * reviewer actually asks when they click something — a whole-PR force layout cannot answer it.
     */
    'GET /api/pr/:prId/ego': ({ params, query }) => {
      const data = loadPr(params.prId);
      if (!data) return { __status: 404, error: 'unknown PR' };
      const { units, graph, reviewed } = data;
      if (!query.id) return { __status: 400, error: 'id query parameter required' };
      const centre = graph?.nodes.get(query.id);
      if (!centre) return { __status: 404, error: 'unknown node' };

      const unitById = new Map(units.map((u) => [u.id, u]));
      const brief = (n, role) => {
        const u = unitById.get(n.id);
        const rv = reviewed.state.get(n.id);
        return {
          id: n.id, role,
          fqn: n.fqn,
          name: (n.fqn.includes('#') ? n.fqn.split('#').pop() : n.fqn).replace(/\s*:.*$/, ''),
          owner: n.fqn.includes('#') ? n.fqn.split('#')[0].split('.').pop() : '',
          path: n.path, kind: n.kind, origin: n.origin, changeKind: n.changeKind,
          risk: n.risk?.total ?? u?.severity?.total ?? 0,
          broken: n.break?.verdicts?.BROKEN ?? 0,
          unknown: n.unknown?.reason ?? null,
          reviewed: !!rv?.reviewed,
          test: !!n.test,
        };
      };

      const verdictAt = new Map((centre.break?.detail ?? []).map((d) => [`${d.path}:${d.line}`, d.verdict]));
      const callers = [];
      const callees = [];
      for (const e of graph.edges) {
        if (e.type !== 'CALLS') continue;
        if (e.to === centre.id && e.from && graph.nodes.has(e.from)) {
          callers.push({
            ...brief(graph.nodes.get(e.from), 'caller'),
            via: e.evidence?.[0] ?? null,
            verdict: e.verdict ?? verdictAt.get(`${e.evidence?.[0]?.path}:${e.evidence?.[0]?.line}`) ?? null,
          });
        } else if (e.from === centre.id && e.to && graph.nodes.has(e.to)) {
          callees.push({ ...brief(graph.nodes.get(e.to), 'callee'), via: e.evidence?.[0] ?? null });
        }
      }
      const tests = graph.edges
        .filter((e) => e.type === 'TEST_COVERS' && e.to === centre.id && e.from && graph.nodes.has(e.from))
        .map((e) => ({ ...brief(graph.nodes.get(e.from), 'test'), via: e.evidence?.[0] ?? null }));

      // Call sites with no enclosing member still exist and must be visible, just not as nodes.
      const orphanSites = (centre.callers ?? []).filter((c) =>
        !callers.some((k) => k.via?.path === c.path && k.via?.line === c.line));

      return {
        centre: brief(centre, 'centre'),
        callers: dedupeById(callers),
        callees: dedupeById(callees),
        tests: dedupeById(tests),
        orphanSites,
        counts: {
          callers: dedupeById(callers).length,
          callees: dedupeById(callees).length,
          tests: dedupeById(tests).length,
          orphanSites: orphanSites.length,
          resolvedCallers: centre.fanIn?.count ?? null,
          fanInKind: centre.fanIn?.kind ?? null,
        },
      };
    },

    'GET /api/pr/:prId/graph': ({ params }) => {
      const data = loadPr(params.prId);
      if (!data) return { __status: 404, error: 'unknown PR' };
      const { units, graph, reviewed } = data;
      if (!graph) return { nodes: [], edges: [], resolved: false };

      const unitById = new Map(units.map((u) => [u.id, u]));
      return {
        resolved: true,
        nodes: [...graph.nodes.values()].map((n) => {
          const u = unitById.get(n.id);
          const rv = reviewed.state.get(n.id);
          return {
            id: n.id, fqn: n.fqn, kind: n.kind, path: n.path,
            origin: n.origin, changeKind: n.changeKind, depth: n.depth,
            risk: n.risk?.total ?? n.severity?.total ?? 0,
            fanIn: n.fanIn, testCovered: n.testCovered,
            broken: n.break?.verdicts?.BROKEN ?? 0,
            unknown: n.unknown?.reason ?? null,
            reviewed: !!rv?.reviewed, stale: !!rv?.stale,
            deltaTypes: (u?.deltas ?? []).map((d) => d.type),
            noise: (u?.noise ?? []).length > 0,
          };
        }),
        // Only edges with both endpoints can be drawn; the rest are reported so the count is honest.
        edges: graph.edges
          .filter((e) => e.from && e.to)
          .map((e, i) => ({
            id: `e${i}`, source: e.from, target: e.to, type: e.type,
            derivedFrom: e.derivedFrom, verdict: e.verdict, depth: e.depth,
            evidence: e.evidence?.[0] ?? null,
          })),
        undrawableEdges: graph.edges.filter((e) => !(e.from && e.to)).length,
      };
    },

    // Node ids embed a file path (e.g. ctx:backend/src/.../Foo.java#Bar.baz(X, Y)), so they can
    // never be a URL path segment — the router split on '/' and every context node 404'd.
    'GET /api/pr/:prId/node': ({ params, query }) => {
      params = { ...params, nodeId: query.id };
      const data = loadPr(params.prId);
      if (!data) return { __status: 404, error: 'unknown PR' };
      const { pr, units, graph, reviewed } = data;
      if (!params.nodeId) return { __status: 400, error: 'id query parameter required' };
      const node = graph?.nodes.get(params.nodeId);
      if (!node) return { __status: 404, error: `unknown node: ${params.nodeId}` };
      const unit = units.find((u) => u.id === params.nodeId) ?? null;
      const clone = clonePathFor(cacheDir, pr.nwo);

      let source = null;
      if (unit?.symbol?.range) {
        source = beforeAfter(clone, { mergeBase: pr.merge_base, headSha: pr.head_sha }, unit);
      } else if (node.path && node.range) {
        source = { after: { text: null, absent: true, reason: 'context node — open the file view' } };
      }

      // Call-site excerpts come from the CALLING file, which is usually not in the PR diff at all.
      const verdictByLine = new Map(
        (node.break?.detail ?? []).map((d) => [`${d.path}:${d.line}`, d]),
      );
      const callers = (node.callers ?? []).map((c) => {
        const d = verdictByLine.get(`${c.path}:${c.line}`);
        const rev = c.side === 'base' ? pr.merge_base : pr.head_sha;
        return {
          ...c,
          verdict: d?.verdict ?? null,
          reasons: d?.reasons ?? [],
          excerpt: callSiteExcerpt(clone, rev, c.path, c.line, 2),
        };
      });

      return {
        node: {
          ...node,
          reviewed: !!reviewed.state.get(node.id)?.reviewed,
          stale: !!reviewed.state.get(node.id)?.stale,
        },
        unit: unit ? {
          fqn: unit.fqn, kind: unit.kind, path: unit.path, changeKind: unit.changeKind,
          deltas: unit.deltas, signatureChange: unit.signatureChange, noise: unit.noise,
          from: unit.from,
          symbol: unit.symbol ? {
            signature: unit.symbol.signature, visibility: unit.symbol.visibility,
            annotations: unit.symbol.annotations, modifiers: unit.symbol.modifiers,
            throws: unit.symbol.throws, range: unit.symbol.range,
          } : null,
        } : null,
        source,
        callers,
        callerSummary: node.break?.verdicts ?? null,
      };
    },

    'GET /api/pr/:prId/blocks': ({ params, query }) => {
      const data = loadPr(params.prId);
      if (!data) return { __status: 404, error: 'unknown PR' };
      const { pr, units } = data;
      if (!query.path) return { __status: 400, error: 'path required' };
      const rev = query.rev === 'base' ? pr.merge_base : pr.head_sha;
      const symbols = units
        .filter((u) => u.path === query.path && u.symbol)
        .map((u) => ({ ...u.symbol, fqn: u.fqn, kind: u.kind, path: u.path }));
      return { path: query.path, rev: query.rev ?? 'head', ...symbolBlocks(clonePathFor(cacheDir, pr.nwo), rev, query.path, symbols) };
    },

    'GET /api/pr/:prId/order': ({ params, query }) => {
      const data = loadPr(params.prId);
      if (!data) return { __status: 404, error: 'unknown PR' };
      const { units, graph, reviewed } = data;
      const shown = query.noise === '1' ? units : units.filter((u) => u.noise.length === 0);

      let ordered;
      let cyclic = [];
      if (query.mode === 'topo' && graph) {
        const topo = topologicalOrder(graph.nodes, graph.edges);
        const rank = new Map(topo.ordered.map((n, i) => [n.id, i]));
        ordered = [...shown].sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
        cyclic = topo.cyclic;
      } else if (query.mode === 'severity') {
        ordered = bySeverity(shown);
      } else {
        ordered = orderUnits(shown);
      }

      return {
        mode: query.mode ?? 'file',
        cyclic,
        units: ordered.map((u) => {
          const n = graph?.nodes.get(u.id);
          const rv = reviewed.state.get(u.id);
          return {
            id: u.id, fqn: u.fqn, kind: u.kind, path: u.path, changeKind: u.changeKind,
            severity: u.severity?.total ?? 0, risk: n?.risk?.total ?? null,
            deltaTypes: u.deltas.map((d) => d.type),
            broken: n?.break?.verdicts?.BROKEN ?? 0,
            unknown: n?.unknown?.reason ?? null,
            fanIn: n?.fanIn ?? null,
            reviewed: !!rv?.reviewed, stale: !!rv?.stale,
            noise: u.noise,
          };
        }),
      };
    },

    // ---------------------------------------------------------------- write (7.3)
    'POST /api/pr/:prId/reviewed': async ({ params, req }) => {
      const data = loadPr(params.prId);
      if (!data) return { __status: 404, error: 'unknown PR' };
      const body = await readBody(req);
      const unit = data.units.find((u) => u.id === body.unitId);
      if (!unit) return { __status: 404, error: 'unknown unit' };
      if (body.reviewed === false) unmarkReviewed(db, params.prId, unit.id);
      else markReviewed(db, params.prId, unit, body.note ?? null);
      const reviewed = loadReviewed(db, params.prId, data.units);
      return { ok: true, progress: progress(data.units, reviewed) };
    },
  };

  function match(method, path) {
    for (const key of Object.keys(handlers)) {
      const [m, pattern] = key.split(' ');
      if (m !== method) continue;
      const pk = pattern.split('/');
      const pp = path.split('/');
      if (pk.length !== pp.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < pk.length; i++) {
        if (pk[i].startsWith(':')) { params[pk[i].slice(1)] = decodeURIComponent(pp[i]); continue; }
        if (pk[i] !== pp[i]) { ok = false; break; }
      }
      if (ok) return { handler: handlers[key], params };
    }
    return null;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      const hit = match(req.method, path);
      if (!hit) return json(res, 404, { error: `no route for ${req.method} ${path}` });
      try {
        const query = Object.fromEntries(url.searchParams);
        const out = await hit.handler({ params: hit.params, query, req });
        const status = out?.__status ?? 200;
        if (out) delete out.__status;
        return json(res, status, out);
      } catch (e) {
        return json(res, 500, { error: e.message, stack: e.stack?.split('\n').slice(0, 4) });
      }
    }

    if (path === '/vendor/cytoscape.min.js') {
      if (!existsSync(CYTOSCAPE)) return json(res, 500, { error: 'cytoscape not installed — npm install' });
      res.writeHead(200, { 'content-type': MIME['.js'] });
      return res.end(readFileSync(CYTOSCAPE));
    }

    const file = join(PUBLIC, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
    if (!file.startsWith(PUBLIC) || !existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    return res.end(readFileSync(file));
  });

  return { server, db };
}
