// Persistence and retention (tasks 1.3, 1.4, 1.5, 6.11).
import { openDb } from '../src/store/db.mjs';
import { saveAnalysis, loadReviewed, markReviewed, unmarkReviewed, loadGraph, loadUnits,
  progress, contentHash } from '../src/store/persist.mjs';
import { scanCache, evictionPlan, applyEviction, POLICY, humanBytes } from '../src/store/retention.mjs';
import { parseSymbols } from '../src/java/parse.mjs';
import { diffSymbols, classifyNoise } from '../src/java/diff.mjs';
import { provisionalSeverity } from '../src/review/order.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

let pass = 0; let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
};

const tmp = () => mkdtempSync(join(tmpdir(), 'cspider-test-'));
const fresh = () => openDb(join(tmp(), 'db.sqlite'));

const P = 'src/main/java/com/acme/Svc.java';
const wrap = (body) => `package com.acme;\n\npublic class Svc {\n${body}\n}\n`;

function unitsOf(beforeBody, afterBody) {
  const base = new Map([[P, parseSymbols(wrap(beforeBody), P)]]);
  const head = new Map([[P, parseSymbols(wrap(afterBody), P)]]);
  const { units } = diffSymbols('acme/svc', base, head);
  for (const u of units) { u.severity = provisionalSeverity(u); u.noise = classifyNoise(u); }
  return units;
}

const PR = 'acme/svc#1';

console.log('\nstore — schema');
t('opens, migrates, and is idempotent', () => {
  const path = join(tmp(), 'db.sqlite');
  const a = openDb(path);
  const v1 = a.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value;
  a.close();
  const b = openDb(path);   // re-open must not fail or reset
  const v2 = b.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value;
  assert.equal(v1, v2);
  assert.ok(b.prepare("SELECT name FROM sqlite_master WHERE name='reviewed_state'").get());
});

console.log('\nstore — reviewed state (6.11)');
t('mark and reload across a fresh read', () => {
  const db = fresh();
  const units = unitsOf('void f() { g(1); }', 'void f() { g(2); }');
  const u = units.find((x) => x.kind === 'METHOD');
  markReviewed(db, PR, u);
  const r = loadReviewed(db, PR, units);
  assert.equal(r.state.get(u.id)?.reviewed, true);
  assert.equal(progress(units, r).done, 1);
});

t('unmark clears it', () => {
  const db = fresh();
  const units = unitsOf('void f() { g(1); }', 'void f() { g(2); }');
  const u = units.find((x) => x.kind === 'METHOD');
  markReviewed(db, PR, u);
  unmarkReviewed(db, PR, u.id);
  assert.equal(loadReviewed(db, PR, units).state.get(u.id), undefined);
});

t('reviewed state SURVIVES line movement elsewhere in the file', () => {
  const db = fresh();
  const before = unitsOf('void f() { g(1); }', 'void f() { g(2); }');
  const u = before.find((x) => x.kind === 'METHOD');
  markReviewed(db, PR, u);

  // Head advances: a field is added above f, shifting its lines. f itself is untouched.
  const after = unitsOf('void f() { g(1); }', 'int added = 1;\n  void f() { g(2); }');
  const uAfter = after.find((x) => x.fqn === u.fqn);
  assert.ok(uAfter, 'f is still identifiable');
  const r = loadReviewed(db, PR, after);
  assert.equal(r.state.get(uAfter.id)?.reviewed, true, 'still reviewed');
  assert.equal(r.stale, 0);
});

t('reviewed state goes STALE when the symbol itself changes', () => {
  const db = fresh();
  const before = unitsOf('void f() { g(1); }', 'void f() { g(2); }');
  const u = before.find((x) => x.kind === 'METHOD');
  markReviewed(db, PR, u);

  // The reviewer approved g(2); head now says g(3). That review no longer applies.
  const after = unitsOf('void f() { g(1); }', 'void f() { g(3); }');
  const uAfter = after.find((x) => x.fqn === u.fqn);
  const r = loadReviewed(db, PR, after);
  assert.equal(r.state.get(uAfter.id)?.reviewed, false, 'must NOT be carried forward');
  assert.equal(r.state.get(uAfter.id)?.stale, true);
  assert.equal(r.stale, 1);
  assert.equal(progress(after, r).done, 0);
});

t('a visibility change alone invalidates a review', () => {
  const db = fresh();
  const before = unitsOf('void f() { g(1); }', 'public void f() { g(1); }');
  const u = before.find((x) => x.kind === 'METHOD');
  markReviewed(db, PR, u);
  const after = unitsOf('void f() { g(1); }', 'private void f() { g(1); }');
  const uAfter = after.find((x) => x.fqn === u.fqn);
  assert.notEqual(contentHash(u), contentHash(uAfter));
  assert.equal(loadReviewed(db, PR, after).stale, 1);
});

t('marks for symbols no longer in the PR are counted as orphaned', () => {
  const db = fresh();
  const units = unitsOf('void f() { g(1); }', 'void f() { g(2); }');
  markReviewed(db, PR, units.find((x) => x.kind === 'METHOD'));
  const other = unitsOf('void h() { k(1); }', 'void h() { k(2); }');
  const r = loadReviewed(db, PR, other);
  assert.equal(r.orphaned, 1);
  assert.equal(progress(other, r).done, 0);
});

console.log('\nstore — analysis round trip');
t('saves and reloads a graph', () => {
  const db = fresh();
  const units = unitsOf('void f() { g(1); }', 'void f() { g(2); }');
  const analysis = {
    pr: { nwo: 'acme/svc', number: 1, repo: 'svc' },
    meta: { headRefOid: 'head1', title: 'T', url: 'u' },
    mergeBase: 'base1', buildRoots: { primary: '.' }, units,
    graph: {
      nodes: new Map(units.map((u) => [u.id, {
        id: u.id, fqn: u.fqn, kind: u.kind, path: u.path, origin: 'CHANGED',
        changeKind: u.changeKind, risk: { total: 7, components: [] },
        fanIn: { count: 2, kind: 'DIRECT' }, break: null, unknown: null,
      }])),
      edges: [{ type: 'CALLS', from: null, to: units[0].id, derivedFrom: 'LSP',
        verdict: 'SAFE', evidence: [{ path: 'A.java', line: 3 }] }],
    },
  };
  const prId = saveAnalysis(db, analysis);
  assert.equal(prId, PR);
  const g = loadGraph(db, PR, 'head1');
  assert.ok(g, 'graph reloaded');
  assert.equal(g.nodes.size, units.length);
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].evidence[0].line, 3);
  assert.equal([...g.nodes.values()][0].fanIn.count, 2);
});

t('re-saving the same head replaces rather than duplicating', () => {
  const db = fresh();
  const units = unitsOf('void f() { g(1); }', 'void f() { g(2); }');
  const analysis = {
    pr: { nwo: 'acme/svc', number: 1, repo: 'svc' },
    meta: { headRefOid: 'head1', title: 'T', url: 'u' },
    mergeBase: 'base1', buildRoots: { primary: '.' }, units, graph: null,
  };
  saveAnalysis(db, analysis);
  saveAnalysis(db, analysis);
  const n = db.prepare('SELECT COUNT(*) c FROM change_units WHERE pr_id=? AND head_sha=?')
    .get(PR, 'head1').c;
  assert.equal(n, units.length);
});

console.log('\nstore — reload fidelity (6b.4)');
// The point of caching a graph is that a reload must be indistinguishable from a fresh build.
// If it silently loses caller lists or edge endpoints, the UI renders a different graph than the
// CLI reported, and nobody would notice.
const richAnalysis = () => {
  const units = unitsOf('void f(String s) { g(1); }', 'void f(String s, int n) { g(2); }');
  const nodes = new Map();
  for (const u of units) {
    nodes.set(u.id, {
      id: u.id, fqn: u.fqn, kind: u.kind, path: u.path, origin: 'CHANGED',
      changeKind: u.changeKind, depth: null,
      severity: u.severity,
      risk: { total: 45, components: [{ name: 'broken-call-sites', points: 30 }] },
      fanIn: { count: 3, kind: 'INDIRECT', note: 'supertype dispatch' },
      callers: [
        { path: 'A.java', line: 10, side: 'head', inDiff: false },
        { path: 'B.java', line: 20, side: 'head', inDiff: true },
      ],
      testCovered: false,
      break: { verdicts: { BROKEN: 1, UPDATED: 1, SAFE: 0 }, detail: [], contractChange: ['x → y'] },
      unknown: null,
    });
  }
  nodes.set('ctx:A.java#Caller.calls', {
    id: 'ctx:A.java#Caller.calls', fqn: 'Caller.calls()', kind: 'METHOD', path: 'A.java',
    origin: 'CONTEXT', changeKind: 'UNCHANGED', depth: 1, severity: { total: 0, components: [] },
    risk: null, fanIn: { count: 1, kind: 'DIRECT', note: null },
    callers: [{ path: 'C.java', line: 5, side: 'head', inDiff: false }],
    testCovered: null, break: null, unknown: { reason: 'expansion bound reached' },
  });
  const first = [...nodes.values()][0];
  return {
    pr: { nwo: 'acme/svc', number: 1, repo: 'svc' },
    meta: { headRefOid: 'head9', title: 'T', url: 'u' },
    mergeBase: 'base9', buildRoots: { primary: '.' }, units,
    graph: {
      nodes,
      edges: [
        { type: 'CALLS', from: 'ctx:A.java#Caller.calls', to: first.id, derivedFrom: 'LSP',
          verdict: 'BROKEN', depth: 1, evidence: [{ path: 'A.java', line: 10 }] },
        { type: 'CALLS', from: null, to: first.id, derivedFrom: 'LSP',
          verdict: 'UPDATED', evidence: [{ path: 'B.java', line: 20 }] },
        { type: 'TEST_COVERS', from: null, to: first.id, derivedFrom: 'LSP',
          evidence: [{ path: 'BTest.java', line: 7 }] },
      ],
    },
  };
};

t('caller lists survive a reload for nodes with no contract change', () => {
  const db = fresh();
  const a = richAnalysis();
  saveAnalysis(db, a);
  const g = loadGraph(db, PR, 'head9');
  const ctx = g.nodes.get('ctx:A.java#Caller.calls');
  assert.ok(ctx, 'context node reloaded');
  assert.equal(ctx.break, null, 'it never had break analysis');
  assert.equal(ctx.callers.length, 1, 'its callers are still present');
  assert.equal(ctx.callers[0].path, 'C.java');
});

t('edge caller endpoints and verdicts survive a reload', () => {
  const db = fresh();
  const a = richAnalysis();
  saveAnalysis(db, a);
  const g = loadGraph(db, PR, 'head9');
  const calls = g.edges.filter((e) => e.type === 'CALLS');
  assert.equal(calls.length, 2);
  const drawable = calls.filter((e) => e.from && e.to);
  assert.equal(drawable.length, 1, 'the endpoint-filled edge is still drawable');
  assert.equal(drawable[0].verdict, 'BROKEN');
  assert.equal(drawable[0].depth, 1);
});

t('the edge index is rebuilt, so a reloaded graph can still take endpoint fills', () => {
  const db = fresh();
  saveAnalysis(db, richAnalysis());
  const g = loadGraph(db, PR, 'head9');
  assert.ok(g.edgeIndex instanceof Map, 'edgeIndex present');
  const key = [...g.edgeIndex.keys()].find((k) => k.includes('B.java:20'));
  assert.ok(key, `no index entry for B.java:20 — keys: ${[...g.edgeIndex.keys()].join(' | ')}`);
  g.edgeIndex.get(key).from = 'filled-later';
  assert.equal(g.edges.find((e) => e.evidence[0].path === 'B.java').from, 'filled-later',
    'the index points at the same object the array holds');
});

t('a reloaded graph is field-for-field equal to the one that was saved', () => {
  const db = fresh();
  const a = richAnalysis();
  saveAnalysis(db, a);
  const g = loadGraph(db, PR, 'head9');
  assert.equal(g.nodes.size, a.graph.nodes.size);
  for (const [id, orig] of a.graph.nodes) {
    const back = g.nodes.get(id);
    assert.ok(back, `node ${id} missing after reload`);
    for (const k of ['fqn', 'kind', 'path', 'origin', 'changeKind', 'depth', 'testCovered']) {
      assert.deepEqual(back[k] ?? null, orig[k] ?? null, `${id}.${k}`);
    }
    for (const k of ['risk', 'fanIn', 'callers', 'break', 'unknown', 'severity']) {
      assert.deepEqual(back[k] ?? null, orig[k] ?? null, `${id}.${k}`);
    }
  }
});

t('units reload with the symbol range needed to fetch source', () => {
  const db = fresh();
  const a = richAnalysis();
  saveAnalysis(db, a);
  const units = loadUnits(db, PR, 'head9');
  assert.equal(units.length, a.units.length);
  const withSig = units.find((u) => u.signatureChange);
  assert.ok(withSig, 'the signature change survived');
  assert.ok(withSig.symbol?.range, 'symbol range present, so before/after source is locatable');
  assert.ok(withSig.symbol.selectionRange, 'selection range present, so resolution can re-anchor');
});

console.log('\nretention — R4 policy');
t('clones are not evictable; worktrees and indexes are', () => {
  assert.equal(POLICY.clone.evictable, false);
  assert.equal(POLICY.clone.ttlMs, null);
  assert.ok(POLICY.worktree.evictable && POLICY.index.evictable);
});

const seedCache = () => {
  const dir = tmp();
  for (const [sub, name, bytes] of [
    ['clones', 'repo__a', 4000],
    ['worktrees', 'repo__a@aaa', 3000],
    ['jdtls-data', 'repo__a@aaa', 5000],
    ['payloads', 'repo__a', 100],
  ]) {
    const d = join(dir, sub, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'blob'), Buffer.alloc(bytes));
  }
  return dir;
};

t('scan records every kind with sizes', () => {
  const db = fresh();
  const dir = seedCache();
  const found = scanCache(db, dir);
  const kinds = new Set(found.map((f) => f.kind));
  assert.deepEqual([...kinds].sort(), ['clone', 'index', 'payload', 'worktree']);
  assert.ok(found.every((f) => f.bytes > 0), JSON.stringify(found));
});

t('TTL expiry evicts the index but never the clone', () => {
  const db = fresh();
  const dir = seedCache();
  scanCache(db, dir);
  // Age everything well past every TTL.
  const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
  db.prepare('UPDATE cache_entries SET last_used_at = ?').run(old);
  const { plan } = evictionPlan(db, { sizeCapBytes: 0 });
  const kinds = plan.map((r) => r.kind);
  assert.ok(kinds.includes('index'), JSON.stringify(kinds));
  assert.ok(kinds.includes('worktree'));
  assert.ok(!kinds.includes('clone'), 'the clone must never be planned for eviction');
});

t('size cap evicts least-recently-used evictables, sparing clones', () => {
  const db = fresh();
  const dir = seedCache();
  scanCache(db, dir);
  const { plan } = evictionPlan(db, { sizeCapBytes: 1000 });   // far under the seeded size
  assert.ok(plan.length > 0);
  assert.ok(plan.every((r) => POLICY[r.kind].evictable));
  assert.ok(!plan.some((r) => r.kind === 'clone'));
});

t('nothing is evicted while inside TTL and under the cap', () => {
  const db = fresh();
  scanCache(db, seedCache());
  const { plan } = evictionPlan(db, { sizeCapBytes: 10 * 1024 ** 3 });
  assert.equal(plan.length, 0, JSON.stringify(plan.map((r) => r.kind)));
});

console.log('\nretention — prune safety (1.5)');
t('dry run is the default and deletes nothing', () => {
  const db = fresh();
  const dir = seedCache();
  scanCache(db, dir);
  db.prepare('UPDATE cache_entries SET last_used_at = ?').run(0);
  const { plan } = evictionPlan(db, { sizeCapBytes: 0 });
  const res = applyEviction(db, plan);              // no options
  assert.equal(res.dryRun, true);
  assert.equal(res.removed, 0);
  assert.ok(plan.every((r) => existsSync(r.path)), 'files still present');
});

t('explicit apply removes the planned paths and reports the reclaim', () => {
  const db = fresh();
  const dir = seedCache();
  scanCache(db, dir);
  db.prepare('UPDATE cache_entries SET last_used_at = ?').run(0);
  const { plan, reclaim } = evictionPlan(db, { sizeCapBytes: 0 });
  const res = applyEviction(db, plan, { dryRun: false });
  assert.equal(res.removed, plan.length);
  assert.equal(res.bytes, reclaim);
  assert.ok(plan.every((r) => !existsSync(r.path)));
  assert.ok(existsSync(join(dir, 'clones', 'repo__a')), 'clone survived');
});

t('reviewer-authored data survives eviction', () => {
  const db = fresh();
  const dir = seedCache();
  const units = unitsOf('void f() { g(1); }', 'void f() { g(2); }');
  markReviewed(db, PR, units.find((x) => x.kind === 'METHOD'));
  scanCache(db, dir);
  db.prepare('UPDATE cache_entries SET last_used_at = ?').run(0);
  const { plan } = evictionPlan(db, { sizeCapBytes: 0 });
  applyEviction(db, plan, { dryRun: false });
  assert.equal(loadReviewed(db, PR, units).total, 1, 'reviewed state must be untouched');
});

t('humanBytes is readable', () => {
  assert.equal(humanBytes(0), '0B');
  assert.equal(humanBytes(2048), '2.0KB');
  assert.match(humanBytes(5 * 1024 ** 3), /GB$/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
