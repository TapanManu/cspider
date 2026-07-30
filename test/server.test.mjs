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

function seed(db, { truncated = [], health = null, resolved = true, lanes = false, variable = false } = {}) {
  // With `variable`, the change set also holds a field whose default flipped — the case the READ BY /
  // WRITTEN BY lanes exist for (6.4).
  const fieldBefore = variable ? 'private boolean flag = false;\n  ' : '';
  const fieldAfter = variable ? 'private boolean flag = true;\n  ' : '';
  const base = new Map([[P, parseSymbols(wrap(`${fieldBefore}public void f(String s) { g(1); }`), P)]]);
  const head = new Map([[P, parseSymbols(wrap(`${fieldAfter}public void f(String s, int n) { g(1); }`), P)]]);
  const { units } = diffSymbols('acme/svc', base, head);
  for (const u of units) { u.severity = provisionalSeverity(u); u.noise = classifyNoise(u); }
  const m = units.find((u) => u.kind === 'METHOD');

  const nodes = new Map(units.map((u) => [u.id, {
    id: u.id, fqn: u.fqn, kind: u.kind, path: u.path, origin: 'CHANGED',
    changeKind: u.changeKind, severity: u.severity,
    risk: u.id === m.id ? { total: 45, components: [{ name: 'broken-call-sites', points: 30 }] } : null,
    fanIn: u.id === m.id ? { count: 1, kind: 'DIRECT', note: null } : null,
    callers: u.id === m.id
      ? [{ path: 'A.java', line: 9, side: 'head', inDiff: false },
        // The test's own call site, so orphanSites has something that WOULD be reported orphaned
        // if it were matched against the production callers alone.
        ...(lanes ? [{ path: 'SvcTest.java', line: 7, side: 'head', inDiff: false }] : [])]
      : null,
    testCovered: false,
    break: u.id === m.id
      ? { verdicts: { BROKEN: 1, UPDATED: 0, SAFE: 0 },
          detail: [{ path: 'A.java', line: 9, side: 'head', verdict: 'BROKEN', reasons: ['parameters changed'] }],
          contractChange: ['void f(String) → void f(String,int)'] }
      : null,
    unknown: null,
  }]));
  // Context nodes for the lane test: unchanged code, so neither carries a change kind of its own.
  if (lanes) {
    for (const [id, fqn, path] of [
      ['ctx:prod', 'com.acme.Caller#call()', 'src/main/java/com/acme/Caller.java'],
      ['ctx:test', 'com.acme.SvcTest#covers()', 'src/test/java/com/acme/SvcTest.java'],
    ]) {
      nodes.set(id, {
        id, fqn, kind: 'METHOD', path, origin: 'CONTEXT', changeKind: 'UNCHANGED',
        severity: null, risk: null, fanIn: null, callers: null, testCovered: false,
        break: null, unknown: null,
      });
    }
  }

  // A field with one reader and one writer, each in its own unchanged member.
  const field = variable ? units.find((u) => u.kind === 'FIELD') : null;
  const accessEdges = [];
  if (field) {
    for (const [id, fqn, path] of [
      ['ctx:reader', 'com.acme.Reader#reads()', 'src/main/java/com/acme/Reader.java'],
      ['ctx:writer', 'com.acme.Writer#writes()', 'src/main/java/com/acme/Writer.java'],
    ]) {
      nodes.set(id, {
        id, fqn, kind: 'METHOD', path, origin: 'CONTEXT', changeKind: 'UNCHANGED',
        severity: null, risk: null, fanIn: null, callers: null, testCovered: false,
        break: null, unknown: null,
      });
    }
    const node = nodes.get(field.id);
    node.usages = [
      { path: 'src/main/java/com/acme/Reader.java', line: 9, side: 'head', inDiff: false,
        member: 'Reader.reads', outsideMember: false, direction: 'READ', verdict: 'VALUE_CHANGED' },
      { path: 'src/main/java/com/acme/Writer.java', line: 4, side: 'head', inDiff: false,
        member: 'Writer.writes', outsideMember: false, direction: 'WRITE', verdict: 'VALUE_CHANGED' },
      { path: 'src/main/java/com/acme/Boot.java', line: 3, side: 'head', inDiff: false,
        member: null, outsideMember: true, direction: 'READ', verdict: 'VALUE_CHANGED' },
    ];
    node.usageVerdicts = {
      available: true, directionAvailable: true,
      counts: { READ: 2, WRITE: 1, BOTH: 0, UNKNOWN: 0 },
      verdicts: { VALUE_CHANGED: 3 },
      valueChange: { before: 'false', after: 'true' },
      reach: { complete: true, reason: null },
    };
    accessEdges.push(
      { type: 'READS_FIELD', from: 'ctx:reader', to: field.id, derivedFrom: 'LSP',
        verdict: 'VALUE_CHANGED', direction: 'READ',
        evidence: [{ path: 'src/main/java/com/acme/Reader.java', line: 9 }] },
      { type: 'WRITES_FIELD', from: 'ctx:writer', to: field.id, derivedFrom: 'LSP',
        verdict: 'VALUE_CHANGED', direction: 'WRITE',
        evidence: [{ path: 'src/main/java/com/acme/Writer.java', line: 4 }] },
    );
  }

  const analysis = {
    pr: { nwo: 'acme/svc', number: 1, repo: 'svc' },
    meta: { headRefOid: 'h1', title: 'T', url: 'u' },
    mergeBase: 'b1', buildRoots: { primary: '.' }, units,
    health, touchedSource: 'git', processor: { skipped: true },
    graph: resolved ? {
      nodes,
      edges: [{ type: 'CALLS', from: 'ctx:x', to: m.id, derivedFrom: 'LSP', verdict: 'BROKEN',
        evidence: [{ path: 'A.java', line: 9 }] },
      // A test that calls the changed member: it produces BOTH edge types from ONE node, which is
      // the case that used to draw it in two lanes and count it as production reach.
      ...(lanes ? [
        { type: 'CALLS', from: 'ctx:prod', to: m.id, derivedFrom: 'LSP', verdict: 'BROKEN',
          evidence: [{ path: 'Prod.java', line: 4 }] },
        { type: 'CALLS', from: 'ctx:test', to: m.id, derivedFrom: 'LSP', verdict: 'SAFE',
          evidence: [{ path: 'SvcTest.java', line: 7 }] },
        { type: 'TEST_COVERS', from: 'ctx:test', to: m.id, derivedFrom: 'LSP',
          evidence: [{ path: 'SvcTest.java', line: 7 }] },
      ] : []), ...accessEdges],
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

const fieldIdOf = (seeded) => seeded.units.find((u) => u.kind === 'FIELD').id;

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
  const { body } = await call(server, 'GET', `/api/pr/${ENC}/node?id=${encodeURIComponent(seeded.method.id)}`);
  assert.equal(body.callers.length, 1);
  assert.equal(body.callers[0].verdict, 'BROKEN');
  assert.match(body.callers[0].reasons[0], /parameters changed/);
  assert.equal(body.callerSummary.BROKEN, 1);
});

// A node id embeds a file path, so it can never be a URL path segment: the router split on '/'
// and every context node 404'd. This pins the query-parameter form.
await t('a node id containing slashes and parens resolves', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cspider-srv-'));
  const { server, db } = createApiServer({ cacheDir: dir, dbPath: join(dir, 'db.sqlite') });
  const s2 = seed(db);
  const ctxId = 'ctx:backend/src/main/java/org/acme/Caller.java#Caller.calls(UUID, Map<String,String>)';
  db.prepare(`INSERT INTO nodes (node_id, pr_id, head_sha, fqn, kind, path, origin, change_kind)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ctxId, PRID, 'h1', 'Caller#calls(UUID,Map)', 'METHOD',
      'backend/src/main/java/org/acme/Caller.java', 'CONTEXT', 'UNCHANGED');
  const { status, body } = await call(server, 'GET', `/api/pr/${ENC}/node?id=${encodeURIComponent(ctxId)}`);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.node.origin, 'CONTEXT');
});

await t('the ego endpoint returns callers, callees and tests around one node', async () => {
  const { server, seeded } = boot();
  const { body } = await call(server, 'GET', `/api/pr/${ENC}/ego?id=${encodeURIComponent(seeded.method.id)}`);
  assert.ok(body.centre, 'has a centre');
  assert.ok(Array.isArray(body.callers) && Array.isArray(body.callees) && Array.isArray(body.tests));
  assert.equal(typeof body.counts.callers, 'number');
});

// A test that calls the changed member emits both a CALLS and a TEST_COVERS edge. Drawn from both,
// it appeared in two lanes and inflated the caller count into "production reach" it is not.
await t('a test that also calls the member appears once, in the TESTS lane', async () => {
  const { server, seeded } = boot({ lanes: true });
  const { body } = await call(server, 'GET', `/api/pr/${ENC}/ego?id=${encodeURIComponent(seeded.method.id)}`);
  const ids = (a) => a.map((x) => x.id);
  assert.deepEqual(ids(body.tests), ['ctx:test']);
  assert.ok(!ids(body.callers).includes('ctx:test'), 'a test must not also be drawn as a caller');
  assert.deepEqual(ids(body.callers), ['ctx:prod'], 'callers is production reach only');
  assert.equal(body.counts.callers, 1);
  assert.equal(body.counts.tests, 1);
  assert.equal(body.counts.testCallers, 1, 'the overlap is stated, not hidden');
});

await t('a test keeps the verdict from its CALLS edge', async () => {
  const { server, seeded } = boot({ lanes: true });
  const { body } = await call(server, 'GET', `/api/pr/${ENC}/ego?id=${encodeURIComponent(seeded.method.id)}`);
  // Without carrying it across, the node would lose its verdict on the way to the TESTS lane and
  // render grey — indistinguishable from "we do not know".
  assert.equal(body.tests[0].verdict, 'SAFE');
  assert.equal(body.tests[0].alsoCalls, true);
  assert.equal(body.callers[0].verdict, 'BROKEN');
});

await t('routing tests out of callers does not orphan their call sites', async () => {
  const { server, seeded } = boot({ lanes: true });
  const { body } = await call(server, 'GET', `/api/pr/${ENC}/ego?id=${encodeURIComponent(seeded.method.id)}`);
  // orphanSites is matched against EVERY caller, tests included. Matching only the production
  // callers would report the test's own call site as belonging to no member at all.
  assert.ok(!body.orphanSites.some((s) => s.path === 'SvcTest.java'),
    'a test call site is not orphaned by being routed to the TESTS lane');
  // And the assertion is not vacuous: an unmatched site IS still reported.
  assert.ok(body.orphanSites.some((s) => s.path === 'A.java'),
    'a call site with no resolved caller node is still surfaced');
});

await t('a variable\'s ego separates READ BY from WRITTEN BY (6.4)', async () => {
  const { server, seeded } = boot({ variable: true });
  const { body } = await call(server, 'GET', `/api/pr/${ENC}/ego?id=${encodeURIComponent(fieldIdOf(seeded))}`);
  assert.equal(body.readers.length, 1, JSON.stringify(body.counts));
  assert.equal(body.writers.length, 1);
  assert.equal(body.readers[0].fqn, 'com.acme.Reader#reads()');
  assert.equal(body.writers[0].fqn, 'com.acme.Writer#writes()');
  // The verdict travels with the node so the lane can colour it (F23).
  assert.equal(body.writers[0].verdict, 'VALUE_CHANGED');
  assert.equal(body.counts.readers, 1);
  assert.equal(body.counts.writers, 1);
  // A read is never reported in the WRITTEN BY lane, and vice versa.
  assert.ok(!body.readers.some((r) => r.fqn.includes('Writer')));
});

await t('a usage with no enclosing member is reported, not silently dropped from the lanes', async () => {
  const { server, seeded } = boot({ variable: true });
  const { body } = await call(server, 'GET', `/api/pr/${ENC}/ego?id=${encodeURIComponent(fieldIdOf(seeded))}`);
  // It can never be a lane node — it has no member to be one — so the count is how it stays visible.
  assert.equal(body.counts.orphanUsages, 1, JSON.stringify(body.counts));
  assert.equal(body.orphanUsages[0].path, 'src/main/java/com/acme/Boot.java');
  assert.equal(body.usageVerdicts.valueChange.after, 'true', 'the value change reaches the view');
});

await t('files endpoint groups changes by file with per-kind counts', async () => {
  const { server } = boot();
  const { body } = await call(server, 'GET', `/api/pr/${ENC}/files`);
  assert.ok(body.files.length >= 1);
  const f = body.files[0];
  assert.ok(f.path.endsWith('.java'));
  assert.ok(f.units.length >= 1);
  assert.equal(typeof f.added + typeof f.removed + typeof f.modified, 'numbernumbernumber');
  assert.ok(f.units[0].deltaTypes, 'a unit carries its delta types for chips');
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

// A file or folder checkbox marks every unit beneath it, which has to be one request: N requests
// would each return a progress figure that was already stale by the time it arrived.
await t('unitIds marks a whole batch in one call', async () => {
  const { server, seeded } = boot();
  const ids = seeded.units.map((u) => u.id);
  const { body } = await call(server, 'POST', `/api/pr/${ENC}/reviewed`, { unitIds: ids, reviewed: true });
  assert.equal(body.ok, true);
  assert.equal(body.changed, ids.length);
  assert.equal(body.progress.done, body.progress.total, 'marking every unit completes the PR');
});

await t('a batch is atomic — one bad id marks nothing', async () => {
  const b = boot();
  const good = b.seeded.method.id;
  const { status } = await call(b.server, 'POST', `/api/pr/${ENC}/reviewed`,
    { unitIds: [good, 'nope'], reviewed: true });
  assert.equal(status, 404);
  // A half-applied sweep would leave the reviewer unable to tell what they had marked.
  const after = { server: createApiServer({ cacheDir: '/tmp', dbPath: b.db.name }).server };
  const { body } = await call(after.server, 'GET', `/api/pr/${ENC}`);
  assert.equal(body.progress.done, 0, 'the valid id in the batch must not have been marked');
});

await t('a batch unmarks as well as marks', async () => {
  const b = boot();
  const ids = b.seeded.units.map((u) => u.id);
  await call(b.server, 'POST', `/api/pr/${ENC}/reviewed`, { unitIds: ids, reviewed: true });
  const s2 = { server: createApiServer({ cacheDir: '/tmp', dbPath: b.db.name }).server };
  const { body } = await call(s2.server, 'POST', `/api/pr/${ENC}/reviewed`, { unitIds: ids, reviewed: false });
  assert.equal(body.progress.done, 0);
});

await t('a request naming no unit at all is a 400, not a silent no-op', async () => {
  const { server } = boot();
  const { status, body } = await call(server, 'POST', `/api/pr/${ENC}/reviewed`, { reviewed: true });
  assert.equal(status, 400);
  assert.match(body.error, /unitId/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
