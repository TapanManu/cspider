// Server contract (7.2, 7.3). Asserts the API cannot silently present a bounded analysis
// as complete, and that reviewed-state writes round-trip.
import { createApiServer } from '../src/server/server.mjs';
import { saveAnalysis, markReviewed } from '../src/store/persist.mjs';
import { parseSymbols } from '../src/java/parse.mjs';
import { diffSymbols, classifyNoise } from '../src/java/diff.mjs';
import { provisionalSeverity } from '../src/review/order.mjs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

let pass = 0; let fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
};

const P = 'src/main/java/com/acme/Svc.java';
const wrap = (b) => `package com.acme;\n\npublic class Svc {\n${b}\n}\n`;
const PRID = 'acme/svc#1';

function seed(db, { truncated = [], health = null, resolved = true } = {}) {
  const base = new Map([[P, parseSymbols(wrap('public void f(String s) { g(1); }'), P)]]);
  const head = new Map([[P, parseSymbols(wrap('public void f(String s, int n) { g(1); }'), P)]]);
  const { units } = diffSymbols('acme/svc', base, head);
  for (const u of units) { u.severity = provisionalSeverity(u); u.noise = classifyNoise(u); }
  const m = units.find((u) => u.kind === 'METHOD');

  const nodes = new Map(units.map((u) => [u.id, {
    id: u.id, fqn: u.fqn, kind: u.kind, path: u.path, origin: 'CHANGED',
    changeKind: u.changeKind, severity: u.severity,
    risk: u.id === m.id ? { total: 45, components: [{ name: 'broken-call-sites', points: 30 }] } : null,
    fanIn: u.id === m.id ? { count: 1, kind: 'DIRECT', note: null } : null,
    callers: u.id === m.id ? [{ path: 'A.java', line: 9, side: 'head', inDiff: false }] : null,
    testCovered: false,
    break: u.id === m.id
      ? { verdicts: { BROKEN: 1, UPDATED: 0, SAFE: 0 },
          detail: [{ path: 'A.java', line: 9, side: 'head', verdict: 'BROKEN', reasons: ['parameters changed'] }],
          contractChange: ['void f(String) → void f(String,int)'] }
      : null,
    unknown: null,
  }]));
  const analysis = {
    pr: { nwo: 'acme/svc', number: 1, repo: 'svc' },
    meta: { headRefOid: 'h1', title: 'T', url: 'u' },
    mergeBase: 'b1', buildRoots: { primary: '.' }, units,
    health, touchedSource: 'git', processor: { skipped: true },
    graph: resolved ? {
      nodes,
      edges: [{ type: 'CALLS', from: 'ctx:x', to: m.id, derivedFrom: 'LSP', verdict: 'BROKEN',
        evidence: [{ path: 'A.java', line: 9 }] }],
      blastRadius: { depth: 2, reachedDepth: 1, added: 1, maxNodes: 400, truncated, budgetLeft: 0 },
      truncations: truncated,
    } : null,
  };
  saveAnalysis(db, analysis);
  return { units, method: m };
}

const boot = (opts) => {
  const dir = mkdtempSync(join(tmpdir(), 'cspider-srv-'));
  const { server, db } = createApiServer({ cacheDir: dir, dbPath: join(dir, 'db.sqlite') });
  const seeded = seed(db, opts);
  return { server, db, seeded };
};

const call = (server, method, path, body) => new Promise((resolve, reject) => {
  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, body
        ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : { method });
      resolve({ status: r.status, body: await r.json() });
    } catch (e) { reject(e); } finally { server.close(); }
  });
});

const ENC = encodeURIComponent(PRID);

console.log('\nserver — read (7.2)');
await t('lists analysed PRs with progress', async () => {
  const { server } = boot();
  const { body } = await call(server, 'GET', '/api/prs');
  assert.equal(body.prs.length, 1);
  assert.equal(body.prs[0].id, PRID);
  assert.ok(body.prs[0].progress.total > 0);
});

await t('unknown PR is a 404, not an empty graph', async () => {
  const { server } = boot();
  const { status } = await call(server, 'GET', '/api/pr/nope%231');
  assert.equal(status, 404);
});

await t('graph exposes only drawable edges and counts the rest', async () => {
  const { server } = boot();
  const { body } = await call(server, 'GET', `/api/pr/${ENC}/graph`);
  assert.ok(body.edges.every((e) => e.source && e.target), 'no half-anchored edges served');
  assert.equal(typeof body.undrawableEdges, 'number');
});

await t('node detail inlines the call site with its verdict and reasons', async () => {
  const { server, seeded } = boot();
  const { body } = await call(server, 'GET', `/api/pr/${ENC}/node/${encodeURIComponent(seeded.method.id)}`);
  assert.equal(body.callers.length, 1);
  assert.equal(body.callers[0].verdict, 'BROKEN');
  assert.match(body.callers[0].reasons[0], /parameters changed/);
  assert.equal(body.callerSummary.BROKEN, 1);
});

console.log('\nserver — disclosures travel with the payload (8.13)');
await t('truncation is reported in status, not omitted', async () => {
  const { server } = boot({ truncated: [{ reason: 'maxNodes', fqn: 'x', depth: 2 }] });
  const { body } = await call(server, 'GET', `/api/pr/${ENC}`);
  assert.equal(body.status.blastRadius.truncated.length, 1);
  assert.equal(body.status.truncations.length, 1);
});

await t('degraded resolution health is reported', async () => {
  const { server } = boot({ health: { verdict: 'DEGRADED', unresolved: 40, errors: 42, topShapes: [] } });
  const { body } = await call(server, 'GET', `/api/pr/${ENC}`);
  assert.equal(body.status.health.verdict, 'DEGRADED');
});

await t('an unresolved PR reports resolved:false rather than an empty graph', async () => {
  const { server } = boot({ resolved: false });
  const { body } = await call(server, 'GET', `/api/pr/${ENC}`);
  assert.equal(body.status.resolved, false);
  const g = await call(boot({ resolved: false }).server, 'GET', `/api/pr/${ENC}/graph`);
  assert.equal(g.body.resolved, false);
});

await t('broken and unknown counts are surfaced at the top level', async () => {
  const { server } = boot();
  const { body } = await call(server, 'GET', `/api/pr/${ENC}`);
  assert.equal(body.counts.broken, 1);
  assert.equal(typeof body.counts.unknown, 'number');
});

console.log('\nserver — ordering');
await t('topological, severity and file orders all return every unit', async () => {
  for (const mode of ['file', 'severity', 'topo']) {
    const { server } = boot();
    const { body } = await call(server, 'GET', `/api/pr/${ENC}/order?mode=${mode}`);
    assert.equal(body.mode, mode);
    assert.ok(body.units.length > 0, mode);
  }
});

console.log('\nserver — write (7.3)');
await t('marking reviewed round-trips and updates progress', async () => {
  const { server, seeded } = boot();
  const { body } = await call(server, 'POST', `/api/pr/${ENC}/reviewed`, { unitId: seeded.method.id });
  assert.equal(body.ok, true);
  assert.equal(body.progress.done, 1);
});

await t('unmarking reviewed round-trips', async () => {
  const b1 = boot();
  await call(b1.server, 'POST', `/api/pr/${ENC}/reviewed`, { unitId: b1.seeded.method.id });
  const b2 = { server: createApiServer({ cacheDir: '/tmp', dbPath: b1.db.name }).server };
  const { body } = await call(b2.server, 'POST', `/api/pr/${ENC}/reviewed`,
    { unitId: b1.seeded.method.id, reviewed: false });
  assert.equal(body.progress.done, 0);
});

await t('marking an unknown unit is a 404', async () => {
  const { server } = boot();
  const { status } = await call(server, 'POST', `/api/pr/${ENC}/reviewed`, { unitId: 'nope' });
  assert.equal(status, 404);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
