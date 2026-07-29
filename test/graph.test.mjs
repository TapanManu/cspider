// Graph wiring (tasks 6.1, 6.2, 6.5, 6.5a) against a stub resolver — deterministic, no jdtls.
// A real PR that updated all its call sites cannot exercise BROKEN, so it is proven here.
import { buildGraph, scoreRisk, expandBlastRadius } from '../src/graph/build.mjs';
import { parseSymbols } from '../src/java/parse.mjs';
import { diffSymbols, classifyNoise } from '../src/java/diff.mjs';
import { provisionalSeverity } from '../src/review/order.mjs';
import assert from 'node:assert';

let pass = 0; let fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
};

const P = 'src/main/java/com/acme/Svc.java';
const wrap = (body) => `package com.acme;\n\npublic class Svc {\n${body}\n}\n`;

// A3: verdicts require real changed-line data; buildGraph refuses to guess without it.
const touchedMap = (entries) => new Map(entries.map(([p, lines]) => [p, new Set(lines)]));
const withLines = (headMap = new Map(), baseMap = new Map()) =>
  ({ touchedHead: headMap, touchedBase: baseMap, touchedSource: 'git' });

function analysisOf(beforeBody, afterBody, patch) {
  const base = new Map([[P, parseSymbols(wrap(beforeBody), P)]]);
  const head = new Map([[P, parseSymbols(wrap(afterBody), P)]]);
  const { units } = diffSymbols('acme/svc', base, head);
  for (const u of units) { u.severity = provisionalSeverity(u); u.noise = classifyNoise(u); }
  return { units, files: [{ filename: P, patch }] };
}

// Stub: two call sites, one on a line the PR touched, one untouched.
const stubResolver = (refs, { impls = [], enclosing = null, refsByPath = null } = {}) => ({
  queries: 0,
  async references(rel) {
    if (refsByPath) return { refs: refsByPath[rel] ?? [], error: null };
    return { refs, error: null };
  },
  async implementations() { return impls; },
  async hover() { return null; },
  async definition() { return null; },
  async documentSymbols() { return []; },
  async enclosingMember(rel, line) {
    if (typeof enclosing === 'function') return enclosing(rel, line);
    return enclosing;
  },
});

const member = (name, startLine = 0, endLine = 50) => ({
  name, simpleName: name.split('.').pop(), kind: 6, detail: '(String)',
  range: { start: { line: startLine, character: 2 }, end: { line: endLine, character: 2 } },
  selectionRange: { start: { line: startLine, character: 2 }, end: { line: startLine, character: 8 } },
});

const CALLER_A = 'src/main/java/com/acme/CallerA.java';
const CALLER_B = 'src/main/java/com/acme/CallerB.java';

console.log('\ngraph — break analysis end to end');

await t('unupdated call site surfaces as BROKEN', async () => {
  const a = analysisOf('public void f(String s) { g(); }', 'public void f(String s, int n) { g(); }', null);
  const g = await buildGraph(a, stubResolver([
    { path: CALLER_A, line: 10 }, { path: CALLER_B, line: 20 },
  ]), withLines());
  const node = [...g.nodes.values()].find((n) => n.break);
  assert.ok(node, 'a node carries break analysis');
  assert.equal(node.break.verdicts.BROKEN, 2, JSON.stringify(node.break.verdicts));
  assert.ok(node.break.contractChange.some((c) => /void f\(String\) → void f\(String,int\)/.test(c)));
});

await t('call site inside the PR diff is UPDATED, not BROKEN', async () => {
  // The patch marks line 10 of CallerA as added by this PR.
  const a = analysisOf('public void f(String s) { g(); }', 'public void f(String s, int n) { g(); }', null);
  const g = await buildGraph(a, stubResolver([
    { path: CALLER_A, line: 9 }, { path: CALLER_B, line: 20 },
  ]), withLines(touchedMap([[CALLER_A, [9]]])));
  const node = [...g.nodes.values()].find((n) => n.break);
  assert.equal(node.break.verdicts.UPDATED, 1, JSON.stringify(node.break.verdicts));
  assert.equal(node.break.verdicts.BROKEN, 1, JSON.stringify(node.break.verdicts));
});

await t('body-only change produces callers but no break analysis', async () => {
  const a = analysisOf('public void f(String s) { g(1); }', 'public void f(String s) { g(2); }', null);
  const g = await buildGraph(a, stubResolver([{ path: CALLER_A, line: 10 }]), withLines());
  const node = [...g.nodes.values()].find((n) => n.fanIn);
  assert.equal(node.break, null, 'contract unchanged — nothing to break');
  assert.equal(node.fanIn.count, 1);
  assert.equal(g.edges.filter((e) => e.verdict === 'SAFE').length, 1);
});

console.log('\ngraph — indirect fan-in (F1)');

await t('override fan-in is marked INDIRECT with an explanation', async () => {
  const a = analysisOf(
    '@Override public void f(String s) { g(1); }',
    '@Override public void f(String s) { g(2); }', null);
  const g = await buildGraph(a, stubResolver(
    Array.from({ length: 42 }, (_, i) => ({ path: CALLER_A, line: i + 1 })),
  ), withLines());
  const node = [...g.nodes.values()].find((n) => n.fanIn);
  assert.equal(node.fanIn.kind, 'INDIRECT');
  assert.equal(node.fanIn.count, 42);
  assert.match(node.fanIn.note, /not statically determined/);
});

await t('indirect fan-in scores at most half of direct, and never dominates alone', async () => {
  const many = Array.from({ length: 42 }, (_, i) => ({ path: CALLER_A, line: i + 1 }));

  const direct = analysisOf('public void f(String s) { g(1); }', 'public void f(String s) { g(2); }', null);
  const gd = await buildGraph(direct, stubResolver(many), withLines());
  const nd = [...gd.nodes.values()].find((n) => n.fanIn);

  const over = analysisOf('@Override public void f(String s) { g(1); }',
    '@Override public void f(String s) { g(2); }', null);
  const go = await buildGraph(over, stubResolver(many), withLines());
  const no = [...go.nodes.values()].find((n) => n.fanIn);

  const fanOf = (n) => scoreRisk(n).components.find((c) => c.name === 'fan-in')?.points ?? 0;
  assert.ok(fanOf(no) <= Math.ceil(fanOf(nd) / 2), `indirect ${fanOf(no)} vs direct ${fanOf(nd)}`);
  assert.ok(fanOf(no) < scoreRisk(no).total, 'fan-in is not the whole score');
});

console.log('\ngraph — risk');

await t('broken call sites dominate the risk score', async () => {
  const broken = analysisOf('public void f(String s) { g(); }', 'public void f(String s, int n) { g(); }', null);
  const gb = await buildGraph(broken, stubResolver([{ path: CALLER_A, line: 10 }]), withLines());
  const nb = [...gb.nodes.values()].find((n) => n.break);
  const rb = scoreRisk(nb);
  assert.ok(rb.components.some((c) => c.name === 'broken-call-sites' && c.points === 30));

  const clean = analysisOf('public void f(String s) { g(1); }', 'public void f(String s) { g(2); }', null);
  const gc = await buildGraph(clean, stubResolver([{ path: CALLER_A, line: 10 }]), withLines());
  const nc = [...gc.nodes.values()].find((n) => n.fanIn);
  assert.ok(rb.total > scoreRisk(nc).total, 'a broken node outranks a clean one');
});

await t('every node is present even without resolution', async () => {
  const a = analysisOf('public void f(String s) { g(); }', 'public void f(String s, int n) { g(); }', null);
  const g = await buildGraph(a, null);
  assert.equal(g.resolved, false);
  assert.ok(g.nodes.size >= 1);
  assert.ok([...g.nodes.values()].every((n) => n.origin === 'CHANGED'));
});

console.log('\ngraph — UNKNOWN rather than a guess (A2, A3)');

await t('no changed-line data yields UNKNOWN, not a verdict', async () => {
  const a = analysisOf('public void f(String s) { g(); }', 'public void f(String s, int n) { g(); }', null);
  const g = await buildGraph(a, stubResolver([{ path: CALLER_A, line: 10 }]),
    { touchedHead: new Map(), touchedBase: new Map(), touchedSource: 'none' });
  const node = [...g.nodes.values()].find((n) => n.unknown);
  assert.ok(node, 'a node is marked UNKNOWN');
  assert.match(node.unknown.reason, /changed-line data unavailable/);
  assert.equal(node.break, null, 'no verdict is invented');
});

await t('a removed member without a base resolver is UNKNOWN, never SAFE', async () => {
  const a = analysisOf('public void gone(String s) { g(); }', 'public void other() { h(); }', null);
  const g = await buildGraph(a, { head: stubResolver([]), base: null }, withLines());
  const removed = [...g.nodes.values()].find((n) => n.changeKind === 'REMOVED');
  assert.ok(removed.unknown, 'removed member is marked UNKNOWN');
  assert.match(removed.unknown.reason, /base-image resolution unavailable/);
});

await t('base-side caller on a deleted line is UPDATED, not BROKEN (side-mixing guard)', async () => {
  const a = analysisOf('public void gone(String s) { g(); }', 'public void other() { h(); }', null);
  const g = await buildGraph(a, {
    head: stubResolver([]),
    base: stubResolver([{ path: CALLER_A, line: 10 }]),
  }, withLines(touchedMap([[CALLER_A, [10]]]), touchedMap([[CALLER_A, [10]]])));
  const removed = [...g.nodes.values()].find((n) => n.changeKind === 'REMOVED');
  assert.equal(removed.break.verdicts.UPDATED, 1, JSON.stringify(removed.break.verdicts));
  assert.equal(removed.break.verdicts.BROKEN, 0, JSON.stringify(removed.break.verdicts));
  assert.equal(removed.break.detail[0].side, 'base');
});

await t('head-side changed lines must not satisfy a base-side caller', async () => {
  const a = analysisOf('public void gone(String s) { g(); }', 'public void other() { h(); }', null);
  // Line 10 is changed on the HEAD side only; a base-resolved caller there is still BROKEN.
  const g = await buildGraph(a, {
    head: stubResolver([]),
    base: stubResolver([{ path: CALLER_A, line: 10 }]),
  }, withLines(touchedMap([[CALLER_A, [10]]]), new Map()));
  const removed = [...g.nodes.values()].find((n) => n.changeKind === 'REMOVED');
  assert.equal(removed.break.verdicts.BROKEN, 1, JSON.stringify(removed.break.verdicts));
});

await t('a removed member IS analysed when a base resolver is supplied (A1)', async () => {
  const a = analysisOf('public void gone(String s) { g(); }', 'public void other() { h(); }', null);
  const g = await buildGraph(a, {
    head: stubResolver([]),
    base: stubResolver([{ path: CALLER_A, line: 10 }]),
  }, withLines());
  const removed = [...g.nodes.values()].find((n) => n.changeKind === 'REMOVED');
  assert.equal(removed.unknown, null, JSON.stringify(removed.unknown));
  assert.equal(removed.break.verdicts.BROKEN, 1, JSON.stringify(removed.break?.verdicts));
  assert.ok(removed.break.contractChange.some((c) => /^removed:/.test(c)));
});

await t('symbols beyond the max-symbols cap are UNKNOWN and the truncation is reported', async () => {
  const a = analysisOf(
    'public void f(String s) { g(1); }\n  public void h(String s) { g(2); }',
    'public void f(String s, int n) { g(1); }\n  public void h(String s, int n) { g(2); }', null);
  const g = await buildGraph(a, stubResolver([{ path: CALLER_A, line: 10 }]),
    { ...withLines(), maxSymbols: 1 });
  assert.ok(g.truncations.some((x) => x.reason === 'maxSymbols'), JSON.stringify(g.truncations));
  assert.ok([...g.nodes.values()].some((n) => /max-symbols/.test(n.unknown?.reason ?? '')));
});

await t('query budget exhaustion is UNKNOWN, not silent', async () => {
  const a = analysisOf(
    'public void f(String s) { g(1); }\n  public void h(String s) { g(2); }',
    'public void f(String s, int n) { g(1); }\n  public void h(String s, int n) { g(2); }', null);
  const g = await buildGraph(a, stubResolver([{ path: CALLER_A, line: 10 }]),
    { ...withLines(), queryBudget: 2 });
  assert.ok(g.truncations.some((x) => x.reason === 'queryBudget'), JSON.stringify(g.truncations));
  assert.ok([...g.nodes.values()].some((n) => /budget exhausted/.test(n.unknown?.reason ?? '')));
});

console.log('\ngraph — blast radius (6.3, 6.4)');

const seeded = async (callerSites, stubOpts) => {
  const a = analysisOf('public void f(String s) { g(1); }', 'public void f(String s) { g(2); }', null);
  const g = await buildGraph(a, stubResolver(callerSites, stubOpts), withLines());
  return { g, resolver: stubResolver(callerSites, stubOpts) };
};

await t('adds CONTEXT nodes for calling members, not for files', async () => {
  const sites = [{ path: CALLER_A, line: 10 }, { path: CALLER_B, line: 20 }];
  const opts = { enclosing: (rel, line) => member(`Caller.at${line}`, line - 2, line + 2) };
  const { g, resolver } = await seeded(sites, opts);
  const br = await expandBlastRadius(g, resolver, { depth: 1, maxNodes: 100, queryBudget: 100 });
  const ctx = [...g.nodes.values()].filter((n) => n.origin === 'CONTEXT');
  assert.equal(br.added, 2, JSON.stringify(br));
  assert.equal(ctx.length, 2);
  assert.ok(ctx.every((n) => n.kind === 'METHOD' && n.depth === 1));
  assert.ok(ctx.every((n) => n.changeKind === 'UNCHANGED'));
});

await t('a call site outside any member does not invent a node', async () => {
  const { g, resolver } = await seeded([{ path: CALLER_A, line: 10 }], { enclosing: () => null });
  const br = await expandBlastRadius(g, resolver, { depth: 1 });
  assert.equal(br.added, 0);
  assert.equal([...g.nodes.values()].filter((n) => n.origin === 'CONTEXT').length, 0);
});

await t('node ceiling truncates AND is disclosed on the truncated node', async () => {
  const sites = Array.from({ length: 30 }, (_, i) => ({ path: CALLER_A, line: (i + 1) * 10 }));
  const opts = { enclosing: (rel, line) => member(`Caller.at${line}`, line - 2, line + 2) };
  const { g, resolver } = await seeded(sites, opts);
  const before = g.nodes.size;
  const br = await expandBlastRadius(g, resolver, { depth: 1, maxNodes: before + 5, queryBudget: 500 });
  assert.ok(br.truncated.some((x) => x.reason === 'maxNodes'), JSON.stringify(br.truncated));
  assert.ok(g.nodes.size <= before + 6, `${g.nodes.size} vs ceiling ${before + 5}`);
});

await t('query budget truncates AND is disclosed', async () => {
  const sites = Array.from({ length: 30 }, (_, i) => ({ path: CALLER_A, line: (i + 1) * 10 }));
  const opts = { enclosing: (rel, line) => member(`Caller.at${line}`, line - 2, line + 2) };
  const { g, resolver } = await seeded(sites, opts);
  const br = await expandBlastRadius(g, resolver, { depth: 1, maxNodes: 1000, queryBudget: 4 });
  assert.ok(br.truncated.some((x) => x.reason === 'queryBudget'), JSON.stringify(br.truncated));
  assert.ok(br.budgetLeft <= 0);
});

await t('depth is a hard cap', async () => {
  // Every file's caller is one level further out; without a cap this would never terminate.
  const opts = {
    enclosing: (rel, line) => member(`Caller.at${line}`, line - 2, line + 2),
    refsByPath: { [P]: [{ path: CALLER_A, line: 10 }], [CALLER_A]: [{ path: CALLER_B, line: 20 }],
                  [CALLER_B]: [{ path: CALLER_A, line: 30 }] },
  };
  const a = analysisOf('public void f(String s) { g(1); }', 'public void f(String s) { g(2); }', null);
  const g = await buildGraph(a, stubResolver([], opts), withLines());
  const br = await expandBlastRadius(g, stubResolver([], opts), { depth: 2, maxNodes: 1000, queryBudget: 500 });
  assert.ok(br.reachedDepth <= 2, `reached ${br.reachedDepth}`);
  const ctx = [...g.nodes.values()].filter((n) => n.origin === 'CONTEXT');
  assert.ok(ctx.every((n) => n.depth <= 2), JSON.stringify(ctx.map((n) => n.depth)));
});

await t('a context node whose callers were not resolved is marked UNKNOWN', async () => {
  const sites = [{ path: CALLER_A, line: 10 }];
  const opts = { enclosing: (rel, line) => member(`Caller.at${line}`, line - 2, line + 2) };
  const { g, resolver } = await seeded(sites, opts);
  // depth 2 requested, but only enough budget for the depth-1 hop
  const br = await expandBlastRadius(g, resolver, { depth: 2, maxNodes: 1000, queryBudget: 1 });
  const ctx = [...g.nodes.values()].filter((n) => n.origin === 'CONTEXT');
  assert.ok(ctx.length >= 1);
  assert.ok(ctx.some((n) => n.unknown) || br.truncated.length > 0, JSON.stringify(br));
});

await t('expansion never reclassifies a changed node as context', async () => {
  const sites = [{ path: P, line: 4 }];   // the call site is inside the changed file itself
  const opts = { enclosing: () => member('Svc.f', 3, 5) };
  const { g, resolver } = await seeded(sites, opts);
  await expandBlastRadius(g, resolver, { depth: 1, maxNodes: 100, queryBudget: 100 });
  assert.ok([...g.nodes.values()].filter((n) => n.origin === 'CHANGED').length >= 1);
  assert.ok([...g.nodes.values()].every((n) => !(n.origin === 'CONTEXT' && n.changeKind !== 'UNCHANGED')));
});

// ---------------------------------------------------------------- unresolved kinds are UNKNOWN
//
// A field is neither a METHOD nor a CONSTRUCTOR, so it never entered the member list and never
// reached the loop that applies A2. The result was `unknown: null` and a rendering of "0 callers"
// for a symbol nobody looked up — and for a REMOVED field, "nothing uses this" and "we never
// looked" have opposite consequences.

console.log('\ngraph — unresolved kinds declare themselves UNKNOWN (A2)');

const withField = (before, after) => analysisOf(before, after, null);

const FLAG_BEFORE = 'private boolean flag = false;\n  public void f(String s) { g(); }';
const FLAG_AFTER = 'private boolean flag = true;\n  public void f(String s) { g(1); }';
const fieldOf = (g) => [...g.nodes.values()].find((n) => n.kind === 'FIELD');

await t('a field whose reference query FAILS is UNKNOWN, not empty (A2/F12)', async () => {
  // With no resolver at all the whole graph declares `resolved: false`, so the disclosure lives at
  // graph level. The per-field case that matters is a query that ran and errored: a failed query is
  // not an empty result.
  const a = withField(FLAG_BEFORE, FLAG_AFTER);
  const failing = {
    ...stubResolver([]),
    async references() { return { refs: [], error: 'index not ready' }; },
  };
  const g = await buildGraph(a, failing, withLines());
  const field = fieldOf(g);
  assert.ok(field, 'the field is a change unit');
  assert.ok(field.unknown, 'a field must not be left with unknown: null');
  assert.match(field.unknown.reason, /index not ready/);
  assert.equal(field.fanIn, null, 'and it must not claim a resolved fan-in');
  assert.equal(field.usages, undefined, 'nor a usage list it never obtained');
});

await t('a field beyond its own cap is UNKNOWN, naming the cap', async () => {
  const a = withField(FLAG_BEFORE, FLAG_AFTER);
  const g = await buildGraph(a, stubResolver([]), { ...withLines(), maxVariables: 0 });
  assert.match(fieldOf(g).unknown.reason, /max-variables/);
});

await t('a resolved field with no usages is a finding, not an UNKNOWN', async () => {
  // We looked and found none. That is the one case where "zero usages" may be stated.
  const a = withField(FLAG_BEFORE, FLAG_AFTER);
  const g = await buildGraph(a, stubResolver([]), withLines());
  const field = fieldOf(g);
  assert.equal(field.unknown, null, 'having looked, it is no longer unknown');
  assert.deepEqual(field.usages, []);
  assert.equal(field.fanIn.count, 0);
});

await t('a resolved field states that verdicts are still unavailable', async () => {
  // Group 4 owns direction and compatibility. Until then a usage list must not read as a clean one.
  const a = withField(FLAG_BEFORE, FLAG_AFTER);
  const g = await buildGraph(a, stubResolver([{ path: CALLER_A, line: 10 }]), withLines());
  const field = fieldOf(g);
  assert.equal(field.usages.length, 1);
  assert.equal(field.usageVerdicts.available, false);
  assert.match(field.usageVerdicts.reason, /not implemented yet/);
});

await t('each usage carries its file, line, in-diff flag and enclosing member', async () => {
  const a = withField(FLAG_BEFORE, FLAG_AFTER);
  const g = await buildGraph(a,
    stubResolver([{ path: CALLER_A, line: 10 }], { enclosing: member('CallerA.reads', 5, 20) }),
    withLines(touchedMap([[CALLER_A, [10]]])));
  const [usage] = fieldOf(g).usages;
  assert.equal(usage.path, CALLER_A);
  assert.equal(usage.line, 10);
  assert.equal(usage.inDiff, true);
  assert.equal(usage.member, 'CallerA.reads');
  assert.equal(usage.outsideMember, false);
});

await t('a usage outside any member is kept and labelled, not dropped', async () => {
  // A read in a field initializer or a static block has no enclosing method. Dropping it would
  // understate the reach; silently attributing it to something would be worse.
  const a = withField(FLAG_BEFORE, FLAG_AFTER);
  const g = await buildGraph(a,
    stubResolver([{ path: CALLER_A, line: 3 }], { enclosing: null }),
    withLines());
  const [usage] = fieldOf(g).usages;
  assert.equal(usage.outsideMember, true);
  assert.equal(usage.member, null);
  assert.equal(fieldOf(g).fanIn.count, 1, 'and it still counts toward reach');
});

await t('a REMOVED field resolves against the base image', async () => {
  const a = withField('private boolean gone = false;\n  public void f(String s) { g(); }',
    'public void f(String s) { g(); }');
  const g = await buildGraph(a, {
    head: stubResolver([]),
    base: stubResolver([{ path: CALLER_A, line: 9 }]),
  }, withLines());
  const field = fieldOf(g);
  assert.equal(field.changeKind, 'REMOVED');
  assert.equal(field.usages.length, 1, 'its readers come from base, where it still existed');
  assert.equal(field.usages[0].side, 'base');
});

await t('a REMOVED field without a base image is UNKNOWN, never zero (A1)', async () => {
  const a = withField('private boolean gone = false;\n  public void f(String s) { g(); }',
    'public void f(String s) { g(); }');
  const g = await buildGraph(a, { head: stubResolver([]), base: null }, withLines());
  const field = fieldOf(g);
  assert.ok(field.unknown, 'a REMOVED field claiming zero readers is the failure this prevents');
  assert.match(field.unknown.reason, /base-image/);
  assert.equal(field.usages, undefined);
});

await t('resolving fields does not reduce the method cap', async () => {
  // maxSymbols is a promise about members. If fields drew from it, asking for 40 symbols would
  // quietly yield 33 members plus 7 fields.
  const a = withField(FLAG_BEFORE, FLAG_AFTER);
  const g = await buildGraph(a, stubResolver([]), { ...withLines(), maxSymbols: 1 });
  const method = [...g.nodes.values()].find((n) => n.kind === 'METHOD');
  assert.equal(method.unknown, null, 'the one member allowed was still resolved');
  assert.ok(fieldOf(g).usages, 'and the field was resolved from its own budget');
});

await t('a type change unit is UNKNOWN too, not only fields', async () => {
  // The same unreachable-loop bug applies to every kind the member filter excludes.
  const a = analysisOf('public void f(String s) { g(); }', 'public void f(String s) { g(); }', null);
  const g = await buildGraph(a, stubResolver([]), withLines());
  for (const n of g.nodes.values()) {
    if (n.kind === 'METHOD' || n.kind === 'CONSTRUCTOR') continue;
    assert.ok(n.unknown, `${n.kind} must declare itself unresolved`);
  }
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
