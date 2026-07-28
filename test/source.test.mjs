// Source retrieval for rendering (gap 1) and edge identity (gap 2).
import { symbolSource, beforeAfter, callSiteExcerpt, symbolBlocks, clearSourceCache }
  from '../src/ingest/source.mjs';
import { parseSymbols } from '../src/java/parse.mjs';
import { diffSymbols, classifyNoise } from '../src/java/diff.mjs';
import { provisionalSeverity } from '../src/review/order.mjs';
import { buildGraph, expandBlastRadius } from '../src/graph/build.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

let pass = 0; let fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
};

// A real git repo with two commits, so source retrieval is exercised the way it runs in production.
function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'cspider-src-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');

  const rel = 'src/main/java/com/acme/Svc.java';
  mkdirSync(join(dir, 'src/main/java/com/acme'), { recursive: true });

  const v1 = `package com.acme;

public class Svc {
  private int count;

  public void alpha(String s) {
    log(s);
  }

  public void beta() {
    alpha("x");
  }
}
`;
  writeFileSync(join(dir, rel), v1);
  git('add', '-A'); git('commit', '-qm', 'v1');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  const v2 = v1
    .replace('public void alpha(String s) {\n    log(s);', 'public void alpha(String s, int n) {\n    log(s);\n    log(n);')
    .replace('  public void beta() {\n    alpha("x");\n  }\n', '');
  writeFileSync(join(dir, rel), v2);
  git('add', '-A'); git('commit', '-qm', 'v2');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  return { dir, rel, base, head, v1, v2 };
}

const F = fixtureRepo();
clearSourceCache();

const unitsFor = () => {
  const baseTables = new Map([[F.rel, parseSymbols(F.v1, F.rel)]]);
  const headTables = new Map([[F.rel, parseSymbols(F.v2, F.rel)]]);
  const { units } = diffSymbols('acme/svc', baseTables, headTables);
  for (const u of units) { u.severity = provisionalSeverity(u); u.noise = classifyNoise(u); }
  return units;
};

console.log('\nsource — retrieval');
await t('reads a symbol at a revision from the bare-clone style repo', () => {
  const syms = parseSymbols(F.v2, F.rel).symbols;
  const alpha = syms.find((s) => s.simpleName === 'alpha');
  const src = symbolSource(F.dir, F.head, F.rel, alpha.range);
  assert.equal(src.absent, false);
  assert.match(src.text, /public void alpha\(String s, int n\)/);
  assert.ok(src.startLine >= 1 && src.endLine >= src.startLine);
});

await t('a path absent at a revision reports absent rather than empty text', () => {
  const src = symbolSource(F.dir, F.head, 'src/main/java/com/acme/Nope.java',
    { start: { line: 0 }, end: { line: 3 } });
  assert.equal(src.absent, true);
  assert.equal(src.text, null);
});

console.log('\nsource — before/after pairing');
await t('a MODIFIED symbol yields both sides, with the old signature on the left', () => {
  const u = unitsFor().find((x) => x.signatureChange);
  assert.ok(u, 'the fixture has a signature change');
  const ba = beforeAfter(F.dir, { mergeBase: F.base, headSha: F.head }, u);
  assert.match(ba.before.text, /alpha\(String s\)/);
  assert.match(ba.after.text, /alpha\(String s, int n\)/);
});

await t('REMOVED has an explicit empty after-side with a reason, not blank text', () => {
  const u = unitsFor().find((x) => x.changeKind === 'REMOVED' && x.kind === 'METHOD');
  assert.ok(u, 'the fixture removes beta()');
  const ba = beforeAfter(F.dir, { mergeBase: F.base, headSha: F.head }, u);
  assert.match(ba.before.text, /beta/);
  assert.equal(ba.after.absent, true);
  assert.match(ba.after.reason, /removed at head/);
});

await t('ADDED has an explicit empty before-side with a reason', () => {
  const fake = {
    changeKind: 'ADDED', path: F.rel,
    symbol: { range: { start: { line: 0 }, end: { line: 2 } }, path: F.rel },
  };
  const ba = beforeAfter(F.dir, { mergeBase: F.base, headSha: F.head }, fake);
  assert.equal(ba.before.absent, true);
  assert.match(ba.before.reason, /did not exist/);
  assert.ok(ba.after.text);
});

console.log('\nsource — call-site excerpts');
await t('excerpt marks the call-site line and includes context', () => {
  const ex = callSiteExcerpt(F.dir, F.base, F.rel, 11, 2);
  assert.equal(ex.absent, false);
  const marked = ex.lines.filter((l) => l.isCallSite);
  assert.equal(marked.length, 1);
  assert.equal(marked[0].line, 11);
  assert.ok(ex.lines.length > 1, 'context lines included');
});

await t('excerpt near the start of a file does not go out of bounds', () => {
  const ex = callSiteExcerpt(F.dir, F.base, F.rel, 1, 5);
  assert.equal(ex.lines[0].line, 1);
  assert.ok(ex.lines.every((l) => l.line >= 1));
});

console.log('\nsource — symbol blocks (8.1)');
await t('decomposes a file into member blocks plus synthetic regions', () => {
  const syms = parseSymbols(F.v1, F.rel).symbols;
  const { blocks } = symbolBlocks(F.dir, F.base, F.rel, syms);
  const kinds = blocks.map((b) => b.kind);
  assert.ok(kinds.includes('METHOD'), JSON.stringify(kinds));
  assert.ok(kinds.includes('SYNTHETIC'), 'package/class header becomes a synthetic block');
  // blocks must be ordered and non-overlapping
  for (let i = 1; i < blocks.length; i++) {
    assert.ok(blocks[i].startLine > blocks[i - 1].endLine,
      `block ${i} overlaps: ${JSON.stringify(blocks.map((b) => [b.startLine, b.endLine]))}`);
  }
});

await t('every line of the file is accounted for by some block or is blank', () => {
  const syms = parseSymbols(F.v1, F.rel).symbols;
  const { blocks, totalLines } = symbolBlocks(F.dir, F.base, F.rel, syms);
  const covered = new Set();
  for (const b of blocks) for (let l = b.startLine; l <= b.endLine; l++) covered.add(l);
  const fileLines = F.v1.split('\n');
  const missed = [];
  for (let l = 1; l <= totalLines; l++) {
    if (!covered.has(l) && (fileLines[l - 1] ?? '').trim()) missed.push(l);
  }
  assert.deepEqual(missed, [], `unaccounted non-blank lines: ${missed.join(', ')}`);
});

console.log('\ngraph — edge identity (gap 2)');
const stub = (refsByPath, enclosing) => ({
  queries: 0,
  async references(rel) { return { refs: refsByPath[rel] ?? [], error: null }; },
  async implementations() { return []; },
  async documentSymbols() { return []; },
  async enclosingMember(rel, line) { return enclosing(rel, line); },
});

await t('one CALLS edge per target and call site — no duplicates after expansion', async () => {
  const units = unitsFor();
  const analysis = { units, files: [{ filename: F.rel, patch: null }] };
  const CALLER = 'src/main/java/com/acme/Other.java';
  const refsByPath = { [F.rel]: [{ path: CALLER, line: 12 }], [CALLER]: [] };
  const encl = (rel, line) => ({
    name: 'Other.callsIt', simpleName: 'callsIt', kind: 6, detail: '()',
    range: { start: { line: line - 3, character: 2 }, end: { line: line + 3, character: 2 } },
  });

  const g = await buildGraph(analysis, stub(refsByPath, encl),
    { touchedHead: new Map(), touchedBase: new Map(), touchedSource: 'git' });
  const before = g.edges.filter((e) => e.type === 'CALLS').length;

  await expandBlastRadius(g, stub(refsByPath, encl), { depth: 1, maxNodes: 100, queryBudget: 100 });
  const calls = g.edges.filter((e) => e.type === 'CALLS');

  const keys = calls.map((e) => `${e.to}|${e.evidence[0].path}:${e.evidence[0].line}`);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate (target, site) edges');
  assert.ok(calls.length >= before, 'expansion did not lose edges');
});

await t('expansion fills the caller endpoint in on the existing edge', async () => {
  const units = unitsFor();
  const analysis = { units, files: [{ filename: F.rel, patch: null }] };
  const CALLER = 'src/main/java/com/acme/Other.java';
  const refsByPath = { [F.rel]: [{ path: CALLER, line: 12 }], [CALLER]: [] };
  const encl = (rel, line) => ({
    name: 'Other.callsIt', simpleName: 'callsIt', kind: 6, detail: '()',
    range: { start: { line: line - 3, character: 2 }, end: { line: line + 3, character: 2 } },
  });

  const g = await buildGraph(analysis, stub(refsByPath, encl),
    { touchedHead: new Map(), touchedBase: new Map(), touchedSource: 'git' });
  const seeded = g.edges.filter((e) => e.type === 'CALLS' && e.evidence[0].path === CALLER);
  assert.ok(seeded.length >= 1);
  assert.equal(seeded[0].from, null, 'break analysis knows only the site');

  await expandBlastRadius(g, stub(refsByPath, encl), { depth: 1, maxNodes: 100, queryBudget: 100 });
  const after = g.edges.filter((e) => e.type === 'CALLS' && e.evidence[0].path === CALLER);
  assert.ok(after.some((e) => e.from), 'a caller endpoint is now set — the edge is drawable');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
