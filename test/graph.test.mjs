// Graph wiring (tasks 6.1, 6.2, 6.5, 6.5a) against a stub resolver — deterministic, no jdtls.
// A real PR that updated all its call sites cannot exercise BROKEN, so it is proven here.
import { buildGraph, scoreRisk } from '../src/graph/build.mjs';
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
const stubResolver = (refs, { impls = [] } = {}) => ({
  queries: 0,
  async references() { return { refs, error: null }; },
  async implementations() { return impls; },
  async hover() { return null; },
  async definition() { return null; },
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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
