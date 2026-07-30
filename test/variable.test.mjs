// Variable usage tracing: enum-constant units (2.1a), read/write classification (3.5), edges and
// the verdict vocabulary (4.10), and risk (4.8).
//
// The verdict table is tested against a stub resolver rather than a real PR for the same reason
// break analysis is: no single PR produces every verdict. A PR that updated all its readers cannot
// exercise BROKEN, and one whose field type changed compatibly cannot exercise TYPE_BROKEN.

import assert from 'node:assert';
import { buildGraph, scoreRisk, expandBlastRadius } from '../src/graph/build.mjs';
import { parseSymbols } from '../src/java/parse.mjs';
import { diffSymbols, classifyNoise } from '../src/java/diff.mjs';
import { provisionalSeverity } from '../src/review/order.mjs';
import { classifyAccess, selfAssignmentNoise } from '../src/java/access.mjs';
import { variableVerdict } from '../src/java/variableCompat.mjs';
import { JAVA_CAPABILITIES, classifiesDirection, accessEdgeTypes } from '../src/java/capabilities.mjs';

let pass = 0; let fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
};

const P = 'src/main/java/com/acme/Svc.java';
const USER = 'src/main/java/com/acme/User.java';
const FAR = 'src/main/java/com/other/Far.java';
const wrap = (body) => `package com.acme;\n\npublic class Svc {\n${body}\n}\n`;

const touchedMap = (entries) => new Map(entries.map(([p, lines]) => [p, new Set(lines)]));
const withLines = (headMap = new Map(), baseMap = new Map()) =>
  ({ touchedHead: headMap, touchedBase: baseMap, touchedSource: 'git' });

function analysisOf(beforeBody, afterBody) {
  const base = new Map([[P, parseSymbols(wrap(beforeBody), P)]]);
  const head = new Map([[P, parseSymbols(wrap(afterBody), P)]]);
  const { units } = diffSymbols('acme/svc', base, head);
  for (const u of units) { u.severity = provisionalSeverity(u); u.noise = classifyNoise(u); }
  return { units, files: [{ filename: P, patch: null }] };
}

/**
 * A resolver stub that also answers `sourceOf`, which is what direction classification needs. The
 * usage line is placed by index so a test can say "the reference is on the line holding `flag++`".
 */
const stubResolver = (refs, { enclosing = null, sources = {} } = {}) => ({
  queries: 0,
  lombok: { uses: false },
  async references() { return { refs, error: null }; },
  async implementations() { return []; },
  async hover() { return null; },
  async definition() { return null; },
  async documentSymbols() { return []; },
  sourceOf(rel) { return sources[rel] ?? null; },
  async enclosingMember(rel, line) {
    return typeof enclosing === 'function' ? enclosing(rel, line) : enclosing;
  },
});

const member = (name, kind = 6) => ({
  name, simpleName: name.split('.').pop(), kind, detail: '()',
  range: { start: { line: 0, character: 2 }, end: { line: 50, character: 2 } },
  selectionRange: { start: { line: 0, character: 2 }, end: { line: 0, character: 8 } },
});

// A using file whose line N is the statement under test. Line 1 is `package`, so statements start
// at line 4 inside the method — `at(4)` is the first.
const usingFile = (...statements) =>
  `package com.acme;\n\nclass User {\n  void m(int p) {\n${
    statements.map((s) => `    ${s}`).join('\n')}\n  }\n}\n`;
const stmtLine = (i) => 5 + i;   // 1-based line of statements[i]
const colOf = (source, line, needle) => source.split('\n')[line - 1].indexOf(needle);

// ---------------------------------------------------------------- 2.1a enum constants

console.log('\nvariables — enum constants are change units (2.1a)');

await t('an enum constant is extracted as an ENUM_CONSTANT symbol', async () => {
  const src = 'package com.acme;\npublic enum Plan {\n  FREE("free"), TRIAL("trial");\n}\n';
  const { symbols } = parseSymbols(src, P);
  const consts = symbols.filter((s) => s.kind === 'ENUM_CONSTANT');
  assert.equal(consts.length, 2, JSON.stringify(symbols.map((s) => `${s.kind} ${s.fqn}`)));
  assert.deepEqual(consts.map((s) => s.fqn), ['com.acme.Plan#FREE', 'com.acme.Plan#TRIAL']);
  // Implicitly public static final — reporting package-private would make it look narrower.
  assert.equal(consts[0].visibility, 'public');
  assert.equal(consts[0].initText, '("free")');
});

await t('an added enum constant becomes a change unit that gets resolved', async () => {
  const before = new Map([[P, parseSymbols('package com.acme;\npublic enum Plan { FREE }\n', P)]]);
  const after = new Map([[P, parseSymbols('package com.acme;\npublic enum Plan { FREE, PAID }\n', P)]]);
  const { units } = diffSymbols('acme/svc', before, after);
  for (const u of units) { u.severity = provisionalSeverity(u); u.noise = classifyNoise(u); }
  const added = units.find((u) => u.kind === 'ENUM_CONSTANT' && u.changeKind === 'ADDED');
  assert.ok(added, JSON.stringify(units.map((u) => `${u.changeKind} ${u.kind} ${u.fqn}`)));

  const g = await buildGraph({ units, files: [] },
    stubResolver([{ path: USER, line: 9, character: 4 }]), withLines());
  const node = [...g.nodes.values()].find((n) => n.kind === 'ENUM_CONSTANT');
  assert.equal(node.unknown, null, 'a constant that WAS looked up is not UNKNOWN');
  assert.equal(node.usages.length, 1, 'its references resolve like a field\'s');
});

await t('a changed constant argument list is an INITIALIZER delta with both values', async () => {
  const before = new Map([[P, parseSymbols('package com.acme;\npublic enum Plan { TRIAL(14) }\n', P)]]);
  const after = new Map([[P, parseSymbols('package com.acme;\npublic enum Plan { TRIAL(30) }\n', P)]]);
  const { units } = diffSymbols('acme/svc', before, after);
  const d = units.find((u) => u.kind === 'ENUM_CONSTANT').deltas.find((x) => x.type === 'INITIALIZER');
  assert.ok(d, 'the value change is reported as its own delta, not only as a body hash');
  assert.deepEqual([d.before, d.after], ['(14)', '(30)']);
});

// ---------------------------------------------------------------- 3.x direction

console.log('\nvariables — read/write classification (3.1, 3.2, 3.5)');

const dirOf = (statement, needle = 'flag') => {
  const src = usingFile(statement);
  const line = stmtLine(0);
  return classifyAccess(src, line, colOf(src, line, needle), needle);
};

await t('a plain read is READ', async () => {
  assert.equal(dirOf('if (flag) { return; }').direction, 'READ');
  assert.equal(dirOf('int x = flag + 1;').direction, 'READ');
  assert.equal(dirOf('use(flag);').direction, 'READ');
});

await t('simple assignment is WRITE, not BOTH', async () => {
  assert.equal(dirOf('flag = 3;').direction, 'WRITE');
  assert.equal(dirOf('this.flag = 3;').direction, 'WRITE');
});

await t('compound assignment is BOTH — it reads before it writes', async () => {
  for (const op of ['+=', '-=', '*=', '/=', '|=', '&=', '^=', '<<=', '>>=']) {
    assert.equal(dirOf(`flag ${op} 1;`).direction, 'BOTH', op);
  }
  assert.equal(dirOf('this.flag += 1;').direction, 'BOTH');
});

await t('increment and decrement are BOTH', async () => {
  assert.equal(dirOf('flag++;').direction, 'BOTH');
  assert.equal(dirOf('flag--;').direction, 'BOTH');
  assert.equal(dirOf('++flag;').direction, 'BOTH');
});

await t('the right-hand side of somebody else\'s assignment is a READ', async () => {
  assert.equal(dirOf('other = flag;').direction, 'READ');
});

await t('an unresolvable position is UNKNOWN with a reason, never READ (D2)', async () => {
  assert.equal(classifyAccess('', 1, 0, 'flag').direction, 'UNKNOWN');
  assert.match(classifyAccess('', 1, 0, 'flag').reason, /not available/);

  // A position past the end of the file, and one that lands on different text than expected: both
  // mean the position and the source disagree, which must never be reported as a read.
  const src = usingFile('use(flag);');
  const stale = classifyAccess(src, stmtLine(0), 0, 'flag');
  assert.equal(stale.direction, 'UNKNOWN', JSON.stringify(stale));
  assert.match(stale.reason, /position and source disagree|no identifier/);

  const off = classifyAccess(src, 9999, 0, 'flag');
  assert.equal(off.direction, 'UNKNOWN');
});

await t('nothing defaults to READ when the file will not parse', async () => {
  const r = classifyAccess('this is not java at all {{{', 1, 0, 'flag');
  assert.ok(r.direction === 'UNKNOWN', JSON.stringify(r));
  assert.ok(r.reason, 'and it says why');
});

await t('a reference through a generated accessor takes the accessor\'s direction (F5b)', async () => {
  // JDT resolves a call to a Lombok-generated setter back to the FIELD, so the position lands on
  // `setFlag`, not `flag`. Measured on sedai-simulation-server#244: 5 of one field's 9 references
  // arrive this way. A setter writes and a getter reads — that is a direction, not a mismatch.
  const set = usingFile('obj.setFlag(true);');
  const w = classifyAccess(set, stmtLine(0), colOf(set, stmtLine(0), 'setFlag'), 'flag');
  assert.equal(w.direction, 'WRITE', JSON.stringify(w));
  assert.equal(w.viaAccessor, 'setFlag');

  const get = usingFile('use(obj.getFlag());');
  assert.equal(classifyAccess(get, stmtLine(0), colOf(get, stmtLine(0), 'getFlag'), 'flag').direction, 'READ');
  const is = usingFile('if (obj.isFlag()) { }');
  assert.equal(classifyAccess(is, stmtLine(0), colOf(is, stmtLine(0), 'isFlag'), 'flag').direction, 'READ');

  // An unrelated method whose name merely starts the same way is NOT this field's accessor.
  const other = usingFile('obj.setFlagged(true);');
  const r = classifyAccess(other, stmtLine(0), colOf(other, stmtLine(0), 'setFlagged'), 'flag');
  assert.equal(r.direction, 'UNKNOWN', 'a loose prefix match would attribute the wrong direction');
});

await t('a Javadoc {@link} reference is UNKNOWN, and says it is documentation', async () => {
  const src = 'package com.acme;\nclass User {\n  /** See {@link #flag} for details. */\n  void m() { }\n}\n';
  const r = classifyAccess(src, 3, src.split('\n')[2].indexOf('flag'), 'flag');
  assert.equal(r.direction, 'UNKNOWN', 'a doc mention is neither a read nor a write');
  assert.match(r.reason, /documentation/);
});

await t('this.x = x in a constructor is detected as disclosed noise (4.9)', async () => {
  const src = usingFile('this.flag = flag;');
  assert.equal(selfAssignmentNoise(src, stmtLine(0), 'flag'), 'constructor-parameter-assignment');
  // ...and it is still classified as the write it genuinely is.
  assert.equal(dirOf('this.flag = flag;').direction, 'WRITE');
  // A write of something else to the same field is not noise.
  assert.equal(selfAssignmentNoise(usingFile('this.flag = other;'), stmtLine(0), 'flag'), null);
});

console.log('\nvariables — declared capability (3.3, 3.4)');

await t('the Java analyser declares READS_FIELD and WRITES_FIELD', async () => {
  assert.ok(JAVA_CAPABILITIES.edgeTypes.includes('READS_FIELD'));
  assert.ok(JAVA_CAPABILITIES.edgeTypes.includes('WRITES_FIELD'));
  assert.equal(classifiesDirection(JAVA_CAPABILITIES), true);
  assert.deepEqual(accessEdgeTypes('BOTH'), ['READS_FIELD', 'WRITES_FIELD']);
});

await t('an analyser that declares neither reports direction unavailable, not READ', async () => {
  const caps = { language: 'kotlin', edgeTypes: ['CALLS', 'ACCESSES_FIELD'] };
  assert.equal(classifiesDirection(caps), false);
  // Even a site this host could have classified is emitted undirected, because emitting an
  // undeclared edge type is the drift `capabilities` exists to prevent.
  assert.deepEqual(accessEdgeTypes('WRITE', caps), ['ACCESSES_FIELD']);

  const a = analysisOf('private boolean flag = false;', 'private boolean flag = true;');
  const src = usingFile('flag = true;');
  const g = await buildGraph(a, stubResolver(
    [{ path: USER, line: stmtLine(0), character: colOf(src, stmtLine(0), 'flag') }],
    { sources: { [USER]: src }, enclosing: member('User.m') },
  ), { ...withLines(), capabilities: caps });
  const field = [...g.nodes.values()].find((n) => n.kind === 'FIELD');
  assert.equal(field.usageVerdicts.directionAvailable, false);
  assert.match(field.usageVerdicts.directionReason, /kotlin/);
  assert.equal(field.usages[0].direction, 'UNKNOWN', 'no usage is presented as a read');
  assert.ok(g.edges.some((e) => e.type === 'ACCESSES_FIELD'));
  assert.ok(!g.edges.some((e) => e.type === 'READS_FIELD'));
});

// ---------------------------------------------------------------- 4.x edges and verdicts

console.log('\nvariables — access edges (4.1, 4.2)');

const fieldGraph = async (beforeBody, afterBody, statements, opts = {}) => {
  const a = analysisOf(beforeBody, afterBody);
  const src = usingFile(...statements);
  const refs = statements.map((s, i) => ({
    path: USER, line: stmtLine(i), character: Math.max(0, colOf(src, stmtLine(i), 'flag')),
  }));
  const g = await buildGraph(a, stubResolver(refs, {
    sources: { [USER]: src }, enclosing: opts.enclosing ?? member('User.m'),
  }), { ...withLines(opts.touched ?? new Map()), ...opts.build });
  return { g, field: [...g.nodes.values()].find((n) => n.kind === 'FIELD'), src };
};

// A field change that is neither a value change nor a type change nor a narrowing, so every usage
// comes out SAFE and the edge assertions are not entangled with the verdict table.
const ANNOTATED = ['private boolean flag = false;\n  void keep() { }',
  '@Deprecated private boolean flag = false;\n  void keep() { }'];

await t('a read and a write emit one READS_FIELD and one WRITES_FIELD, each with evidence', async () => {
  const { g } = await fieldGraph(...ANNOTATED, ['use(flag);', 'flag = true;']);
  const reads = g.edges.filter((e) => e.type === 'READS_FIELD');
  const writes = g.edges.filter((e) => e.type === 'WRITES_FIELD');
  assert.equal(reads.length, 1, JSON.stringify(g.edges.map((e) => e.type)));
  assert.equal(writes.length, 1);
  for (const e of [...reads, ...writes]) {
    assert.ok(e.evidence?.[0]?.path && e.evidence[0].line, 'evidence is mandatory');
  }
  assert.notEqual(reads[0].evidence[0].line, writes[0].evidence[0].line, 'each has its own site');
});

await t('a BOTH site emits both edges and counts once in the usage total', async () => {
  const { g, field } = await fieldGraph(...ANNOTATED, ['flag += 1;']);
  assert.equal(field.usages.length, 1, 'one site');
  assert.equal(field.fanIn.count, 1, 'counted once');
  assert.equal(field.usageVerdicts.counts.BOTH, 1);
  assert.equal(g.edges.filter((e) => e.type === 'READS_FIELD').length, 1);
  assert.equal(g.edges.filter((e) => e.type === 'WRITES_FIELD').length, 1);
});

await t('an evidence-less reference emits no edge and the omission is recorded', async () => {
  const a = analysisOf(...ANNOTATED);
  const g = await buildGraph(a, stubResolver([{ path: USER, line: null, character: 0 }],
    { enclosing: member('User.m') }), withLines());
  assert.ok(g.truncations.some((x) => x.reason === 'evidenceLessReference'), JSON.stringify(g.truncations));
  assert.equal(g.edges.filter((e) => /FIELD/.test(e.type)).length, 0);
});

await t('an access edge comes from the enclosing member, as a placeable node', async () => {
  const { g } = await fieldGraph(...ANNOTATED, ['use(flag);']);
  const e = g.edges.find((x) => x.type === 'READS_FIELD');
  assert.ok(e.from, 'the edge has a source endpoint, or no lane can draw it');
  assert.ok(g.nodes.has(e.from), 'and that endpoint is a real node');
  assert.equal(g.nodes.get(e.from).origin, 'CONTEXT');
});

await t('a usage outside any member is listed but invents no node', async () => {
  const { g, field } = await fieldGraph(...ANNOTATED, ['use(flag);'], { enclosing: () => null });
  assert.equal(field.usages.length, 1, 'still listed');
  assert.equal(field.usages[0].outsideMember, true);
  assert.equal(g.edges.find((x) => x.type === 'READS_FIELD').from, null);
  assert.equal([...g.nodes.values()].filter((n) => n.origin === 'CONTEXT').length, 0);
});

await t('a usage CONTEXT node survives blast-radius expansion', async () => {
  // Both this and expandBlastRadius mint `ctx:<path>#<member>` ids, so they can land on the SAME node.
  // Expansion reads `ctx.range.start` to resolve the next ring; a node created here without a range
  // threw and took the entire expansion with it — invisibly, because cli.mjs catches the resolve error
  // and carries on with the graph it already had. Caught only by a cold run against a real PR.
  const a = analysisOf(...ANNOTATED);
  const src = usingFile('use(flag);');
  const line = stmtLine(0);
  const resolver = stubResolver([{ path: USER, line, character: colOf(src, line, 'flag') }],
    { sources: { [USER]: src }, enclosing: member('User.m') });
  const g = await buildGraph(a, resolver, withLines());

  const ctx = [...g.nodes.values()].filter((n) => n.origin === 'CONTEXT');
  assert.ok(ctx.length >= 1, 'a usage produced a context node');
  for (const n of ctx) {
    assert.ok(n.range?.start, `${n.id} must carry a range, or expansion cannot walk it`);
  }
  // And prove it end to end rather than trusting the field is enough.
  await expandBlastRadius(g, resolver, { depth: 2, maxNodes: 100, queryBudget: 50 });
  assert.ok(g.blastRadius, 'expansion completed instead of throwing');
});

console.log('\nvariables — the verdict vocabulary, exhaustively (4.3–4.7, 4.10)');

// Every verdict against a stub unit. A real PR cannot produce all six.
const unit = (over = {}) => ({
  kind: 'FIELD', changeKind: 'MODIFIED', path: P, deltas: [],
  symbol: { simpleName: 'flag', visibility: 'public', signature: 'boolean flag' },
  ...over,
});

await t('BROKEN — a reader of a removed field, outside the diff', async () => {
  const r = variableVerdict(unit({ changeKind: 'REMOVED' }), { path: USER, inDiff: false });
  assert.equal(r.verdict, 'BROKEN');
  assert.match(r.reasons[0], /removed/);
});

await t('UPDATED — the author already touched that line', async () => {
  assert.equal(variableVerdict(unit({ changeKind: 'REMOVED' }), { path: USER, inDiff: true }).verdict, 'UPDATED');
  assert.equal(variableVerdict(unit(), { path: USER, inDiff: true }).verdict, 'UPDATED');
});

await t('TYPE_BROKEN — an incompatible type change at the usage site', async () => {
  const u = unit({ deltas: [{ type: 'SIGNATURE', before: 'String flag', after: 'int flag' }] });
  const r = variableVerdict(u, { path: USER, inDiff: false, direction: 'READ' });
  assert.equal(r.verdict, 'TYPE_BROKEN');
  assert.match(r.reasons[0], /String → int/);
});

await t('a widening type change is not TYPE_BROKEN', async () => {
  const u = unit({ deltas: [{ type: 'SIGNATURE', before: 'int n', after: 'long n' }] });
  assert.equal(variableVerdict(u, { path: USER, inDiff: false }).verdict, 'SAFE');
});

await t('VALUE_CHANGED — and never SAFE, nor absorbed by UPDATED (4.4)', async () => {
  const u = unit({ deltas: [{ type: 'INITIALIZER', before: 'false', after: 'true' }] });
  const out = variableVerdict(u, { path: USER, inDiff: false });
  assert.equal(out.verdict, 'VALUE_CHANGED');
  assert.deepEqual(out.values, { before: 'false', after: 'true' });
  assert.match(out.reasons[0], /false → true/);
  // Touching the line is not evidence that the reader accounted for the new value.
  assert.equal(variableVerdict(u, { path: USER, inDiff: true }).verdict, 'VALUE_CHANGED');
});

await t('BROKEN — visibility narrowed puts an existing usage out of scope (4.5)', async () => {
  const u = unit({ deltas: [{ type: 'VISIBILITY', before: 'public', after: 'private' }] });
  // Another file cannot see a private field.
  assert.equal(variableVerdict(u, { path: USER, inDiff: false }).verdict, 'BROKEN');
  // The declaring file still can.
  assert.equal(variableVerdict(u, { path: P, inDiff: false }).verdict, 'SAFE');

  const pkg = unit({ deltas: [{ type: 'VISIBILITY', before: 'public', after: 'package-private' }] });
  assert.equal(variableVerdict(pkg, { path: FAR, inDiff: false }).verdict, 'BROKEN');
  assert.equal(variableVerdict(pkg, { path: USER, inDiff: false }).verdict, 'SAFE', 'same package');
});

await t('protected narrowing out of package is UNKNOWN, not a guessed BROKEN', async () => {
  const u = unit({ deltas: [{ type: 'VISIBILITY', before: 'public', after: 'protected' }] });
  const r = variableVerdict(u, { path: FAR, inDiff: false });
  assert.equal(r.verdict, 'UNKNOWN', 'subtype knowledge is not available here');
  assert.match(r.reasons[0], /subclass/);
});

await t('SAFE — reachable, compiles, no value change implied', async () => {
  assert.equal(variableVerdict(unit({ deltas: [{ type: 'BODY', before: 'a', after: 'b' }] }),
    { path: USER, inDiff: false }).verdict, 'SAFE');
});

await t('a compile break outranks a value change', async () => {
  const u = unit({
    changeKind: 'REMOVED',
    deltas: [{ type: 'INITIALIZER', before: 'false', after: null }],
  });
  assert.equal(variableVerdict(u, { path: USER, inDiff: false }).verdict, 'BROKEN');
});

await t('every verdict emitted is in the declared vocabulary', async () => {
  const cases = [
    unit({ changeKind: 'REMOVED' }), unit({ changeKind: 'ADDED' }),
    unit({ changeKind: 'RENAMED', from: { simpleName: 'old' } }),
    unit({ deltas: [{ type: 'INITIALIZER', before: '1', after: '2' }] }),
    unit({ deltas: [{ type: 'SIGNATURE', before: 'String s', after: 'int s' }] }),
    unit({ deltas: [{ type: 'VISIBILITY', before: 'public', after: 'protected' }] }),
    unit(),
  ];
  for (const u of cases) {
    for (const inDiff of [true, false]) {
      const { verdict } = variableVerdict(u, { path: FAR, inDiff });
      assert.ok(JAVA_CAPABILITIES.verdicts.includes(verdict), `${verdict} is not declared`);
    }
  }
});

console.log('\nvariables — end to end through buildGraph');

await t('a removed field\'s untouched base-side readers come out BROKEN', async () => {
  const a = analysisOf('private boolean flag = false;\n  void keep() { }', '  void keep() { }');
  const src = usingFile('use(flag);');
  const g = await buildGraph(a, {
    head: stubResolver([]),
    base: stubResolver([{ path: USER, line: stmtLine(0), character: colOf(src, stmtLine(0), 'flag') }],
      { sources: { [USER]: src }, enclosing: member('User.m') }),
  }, withLines());
  const field = [...g.nodes.values()].find((n) => n.kind === 'FIELD');
  assert.equal(field.changeKind, 'REMOVED');
  assert.equal(field.usages.length, 1);
  assert.equal(field.usages[0].verdict, 'BROKEN');
  assert.equal(field.usages[0].side, 'base');
  assert.equal(field.usages[0].direction, 'READ', 'classified against the BASE image source');
});

await t('constructor self-assignment is suppressed but counted and reversible (4.9)', async () => {
  const args = ['this.flag = flag;', 'use(flag);'];
  const { field } = await fieldGraph(...ANNOTATED, args);
  assert.equal(field.usages.length, 1, 'the noisy write is not shown by default');
  assert.equal(field.usageNoise.suppressed, 1);
  assert.match(field.usageNoise.reversible, /show-noise/);

  const shown = await fieldGraph(...ANNOTATED, args, { build: { showNoise: true } });
  assert.equal(shown.field.usages.length, 2, '--show-noise brings it back');
  assert.equal(shown.field.usageVerdicts.counts.WRITE, 1);
});

await t('read and write counts are stated separately', async () => {
  const { field } = await fieldGraph(...ANNOTATED, ['use(flag);', 'if (flag) { }', 'flag = true;']);
  assert.equal(field.usageVerdicts.counts.READ, 2);
  assert.equal(field.usageVerdicts.counts.WRITE, 1);
});

console.log('\nvariables — risk (4.8)');

await t('field usage fan-in reaches the risk score, and writes weigh more than reads', async () => {
  const reads = await fieldGraph(...ANNOTATED, ['use(flag);', 'if (flag) { }']);
  const writes = await fieldGraph(...ANNOTATED, ['flag = true;', 'flag = false;']);
  const fanOf = (n) => scoreRisk(n).components.find((c) => c.name === 'usage-fan-in')?.points ?? 0;
  assert.ok(fanOf(reads.field) > 0, 'a read fan-in is not null');
  assert.ok(fanOf(writes.field) >= fanOf(reads.field),
    `writes ${fanOf(writes.field)} must weigh at least as much as reads ${fanOf(reads.field)}`);
});

await t('a value change carries risk of its own', async () => {
  const { field } = await fieldGraph('private boolean flag = false;\n  void keep() { }',
    'private boolean flag = true;\n  void keep() { }', ['use(flag);']);
  assert.ok(scoreRisk(field).components.some((c) => c.name === 'value-change'));
});

await t('an UNKNOWN field is not scored as low risk', async () => {
  const a = analysisOf('private boolean gone = false;\n  void keep() { }', '  void keep() { }');
  const g = await buildGraph(a, { head: stubResolver([]), base: null }, withLines());
  const field = [...g.nodes.values()].find((n) => n.kind === 'FIELD');
  assert.ok(field.unknown);
  const r = scoreRisk(field);
  assert.ok(r.components.some((c) => c.name === 'unknown-usages'),
    `absence of a usage list is not evidence of absent usage: ${JSON.stringify(r.components)}`);
  assert.ok(r.total > 0);
});

await t('a Lombok project declares partial reach rather than a complete short list (7.5)', async () => {
  const a = analysisOf(...ANNOTATED);
  const src = usingFile('use(flag);');
  const lombok = {
    ...stubResolver([{ path: USER, line: stmtLine(0), character: colOf(src, stmtLine(0), 'flag') }],
      { sources: { [USER]: src }, enclosing: member('User.m') }),
    lombok: { uses: true, version: '1.18.30' },
  };
  const g = await buildGraph(a, lombok, withLines());
  const field = [...g.nodes.values()].find((n) => n.kind === 'FIELD');
  assert.equal(field.usageVerdicts.reach.complete, false);
  assert.match(field.usageVerdicts.reach.reason, /generated/);
  assert.ok(scoreRisk(field).components.some((c) => c.name === 'partial-reach'));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
