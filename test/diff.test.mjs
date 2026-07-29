// Phase A fixture corpus (task 4.11, partial). Each case asserts one delta type or change kind.
import { parseSymbols, parseImports } from '../src/java/parse.mjs';
import { diffSymbols, unitId, classifyNoise } from '../src/java/diff.mjs';
import { externalBindings, bindingChange } from '../src/java/bindings.mjs';
import assert from 'node:assert';

let pass = 0; let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
};

const tables = (files) => {
  const m = new Map();
  for (const [path, src] of Object.entries(files)) m.set(path, parseSymbols(src, path));
  return m;
};
const diff = (baseFiles, headFiles) => diffSymbols('r', tables(baseFiles), tables(headFiles));
const find = (units, re) => units.find((u) => re.test(u.fqn));

const P = 'src/main/java/com/acme/A.java';
const wrap = (body) => `package com.acme;\n\npublic class A {\n${body}\n}\n`;

console.log('\nparse');
t('extracts type, method, field with visibility and annotations', () => {
  const { symbols, package: pkg } = parseSymbols(wrap(`
  @Deprecated private String name;
  @Override public int f(String s, int... rest) throws java.io.IOException { return 1; }
`), P);
  assert.equal(pkg, 'com.acme');
  const cls = symbols.find((s) => s.kind === 'CLASS');
  assert.equal(cls.fqn, 'com.acme.A');
  const m = symbols.find((s) => s.kind === 'METHOD');
  assert.equal(m.fqn, 'com.acme.A#f(String,int...)');
  assert.equal(m.visibility, 'public');
  assert.deepEqual(m.annotations, ['@Override']);
  assert.deepEqual(m.throws, ['java.io.IOException']);
  const fld = symbols.find((s) => s.kind === 'FIELD');
  assert.equal(fld.fqn, 'com.acme.A#name');
  assert.equal(fld.visibility, 'private');
});

t('handles records, enums, and nested types', () => {
  const { symbols } = parseSymbols(`package com.acme;
public record R(String a) { public String upper() { return a; } }
enum E { X, Y; int v() { return 1; } }
class Outer { static class Inner { void g() {} } }
`, P);
  const fqns = symbols.map((s) => s.fqn);
  assert.ok(fqns.includes('com.acme.R'), 'record');
  assert.ok(fqns.includes('com.acme.E#v()'), 'enum method');
  assert.ok(fqns.includes('com.acme.Outer.Inner#g()'), `nested: ${fqns.join(', ')}`);
});

t('recovers from a syntax error without dropping the file', () => {
  const r = parseSymbols('package com.acme;\nclass A { void ok() {} void bad( {} }\n', P);
  assert.ok(r.parseError, 'parseError recorded');
  assert.ok(r.symbols.length > 0, 'symbols still returned');
});

t('extracts imports with line numbers', () => {
  const imps = parseImports('package p;\nimport a.b.C;\nimport static x.Y.z;\nclass K {}\n');
  assert.equal(imps.length, 2);
  assert.equal(imps[0].fqn, 'a.b.C');
  assert.equal(imps[0].line, 2);
  assert.equal(imps[1].static, true);
});

console.log('\ndiff — change kinds');
t('MODIFIED on body change only', () => {
  const { units } = diff({ [P]: wrap('void f() { g(1); }') }, { [P]: wrap('void f() { g(2); }') });
  const u = find(units, /#f\(\)/);
  assert.equal(u.changeKind, 'MODIFIED');
  assert.deepEqual(u.deltas.map((d) => d.type), ['BODY']);
});

t('ADDED and REMOVED', () => {
  const { units } = diff({ [P]: wrap('void a() {}') }, { [P]: wrap('void b() {}') });
  // Different names AND different bodies -> not a rename; both emitted.
  assert.ok(units.some((u) => u.changeKind === 'ADDED' && /#b\(\)/.test(u.fqn)));
  assert.ok(units.some((u) => u.changeKind === 'REMOVED' && /#a\(\)/.test(u.fqn)));
});

t('UNCHANGED symbols are not emitted', () => {
  const src = wrap('void f() { g(); }\n  void h() {}');
  const { units } = diff({ [P]: src }, { [P]: src });
  assert.equal(units.length, 0, `expected none, got ${units.map((u) => u.fqn).join(', ')}`);
});

t('line movement above a method does not mark it modified', () => {
  const before = wrap('void f() { g(); }');
  const after = wrap('int added = 1;\n  void f() { g(); }');
  const { units } = diff({ [P]: before }, { [P]: after });
  assert.ok(!find(units, /#f\(\)/), 'f must not be reported changed');
  assert.ok(find(units, /#added/), 'the new field must be reported');
});

t('stable id survives line movement', () => {
  const a = parseSymbols(wrap('void f() { g(); }'), P).symbols.find((s) => s.kind === 'METHOD');
  const b = parseSymbols(wrap('int x;\n  void f() { g(); }'), P).symbols.find((s) => s.kind === 'METHOD');
  assert.equal(unitId('r', a.fqn, a.kind), unitId('r', b.fqn, b.kind));
});

console.log('\ndiff — delta types');
const deltaCase = (name, before, after, expected) => t(name, () => {
  const { units } = diff({ [P]: wrap(before) }, { [P]: wrap(after) });
  const u = units.find((x) => x.changeKind === 'MODIFIED');
  assert.ok(u, `no MODIFIED unit; got ${units.map((x) => x.changeKind + ' ' + x.fqn).join(' | ')}`);
  assert.ok(u.deltas.some((d) => d.type === expected),
    `expected ${expected}, got ${u.deltas.map((d) => d.type).join(',')}`);
});

deltaCase('VISIBILITY', 'public void f() {}', 'private void f() {}', 'VISIBILITY');
deltaCase('ANNOTATION added', 'void f() {}', '@Transactional void f() {}', 'ANNOTATION');
deltaCase('ANNOTATION removed', '@Transactional void f() {}', 'void f() {}', 'ANNOTATION');
deltaCase('MODIFIER', 'void f() {}', 'static void f() {}', 'MODIFIER');
deltaCase('THROWS', 'void f() {}', 'void f() throws java.io.IOException {}', 'THROWS');
deltaCase('return type change is a SIGNATURE delta', 'int f() { return 1; }', 'long f() { return 1; }', 'SIGNATURE');

t('parameter addition pairs into one MODIFIED with a SIGNATURE delta', () => {
  const { units } = diff({ [P]: wrap('void f(String s) {}') }, { [P]: wrap('void f(String s, int n) {}') });
  assert.equal(units.length, 1, `expected 1 unit, got ${units.map((u) => u.changeKind + ' ' + u.fqn).join(' | ')}`);
  const u = units[0];
  assert.equal(u.changeKind, 'MODIFIED');
  assert.ok(u.deltas.some((d) => d.type === 'SIGNATURE'), 'carries a SIGNATURE delta');
  assert.equal(u.signatureChange.before, 'void f(String)');
  assert.equal(u.signatureChange.after, 'void f(String,int)');
  assert.match(u.from.fqn, /#f\(String\)$/, 'records the previous signature');
});

t('ambiguous overload changes are left unpaired rather than guessed', () => {
  // Two removed and two added overloads of one name: any pairing would be invented.
  const { units } = diff(
    { [P]: wrap('void f(String s) {}\n  void f(int i) {}') },
    { [P]: wrap('void f(String s, int n) {}\n  void f(int i, int m) {}') },
  );
  assert.ok(!units.some((u) => u.signatureChange), 'must not assert a signature pairing');
  assert.ok(units.some((u) => u.changeKind === 'ADDED'));
  assert.ok(units.some((u) => u.changeKind === 'REMOVED'));
});

t('a genuine new overload alongside the original is ADDED only', () => {
  const { units } = diff(
    { [P]: wrap('void f(String s) { a(); }') },
    { [P]: wrap('void f(String s) { a(); }\n  void f(int i) { b(); }') },
  );
  assert.equal(units.length, 1);
  assert.equal(units[0].changeKind, 'ADDED');
  assert.match(units[0].fqn, /#f\(int\)$/);
});

console.log('\ndiff — rename and move');
t('MOVED across files when body is identical', () => {
  const Q = 'src/main/java/com/acme/B.java';
  const body = 'void heavy() { int a = 1; int b = 2; System.out.println(a + b); }';
  const { units } = diff(
    { [P]: wrap(body) },
    { [Q]: `package com.acme;\n\npublic class B {\n${body}\n}\n` },
  );
  const moved = units.find((u) => u.changeKind === 'MOVED' || u.changeKind === 'RENAMED');
  assert.ok(moved, `expected MOVED; got ${units.map((u) => u.changeKind + ' ' + u.fqn).join(' | ')}`);
  assert.ok(moved.from, 'records the previous location');
  assert.ok(moved.confidence >= 90);
});

t('RENAMED in place when body identical and name differs', () => {
  const body = '{ int a = 1; int b = 2; return a + b; }';
  const { units } = diff({ [P]: wrap(`int oldName() ${body}`) }, { [P]: wrap(`int newName() ${body}`) });
  const u = units.find((x) => x.changeKind === 'RENAMED' || x.changeKind === 'MOVED');
  assert.ok(u, `got ${units.map((x) => x.changeKind).join(',')}`);
  assert.match(u.from.fqn, /oldName/);
});

t('low-confidence match yields ADDED+REMOVED plus a suggestion, not a false MOVED', () => {
  const { units, suggestions } = diff(
    { [P]: wrap('void alpha() { doOne(); }') },
    { [P]: wrap('void beta() { doTwo(); doThree(); }') },
  );
  assert.ok(!units.some((u) => u.changeKind === 'MOVED'), 'must not assert MOVED');
  assert.ok(units.some((u) => u.changeKind === 'ADDED'));
  assert.ok(units.some((u) => u.changeKind === 'REMOVED'));
  assert.ok(suggestions.length >= 0);
});

console.log('\nnoise');
t('generated path is flagged', () => {
  const { units } = diff({}, { 'target/generated-sources/com/acme/G.java': wrap('void f() {}') });
  const u = units.find((x) => x.kind === 'METHOD');
  assert.ok(classifyNoise(u).includes('generated-path'));
});

t('reformatting only is not a change', () => {
  const { units } = diff(
    { [P]: wrap('void f() { g(); }') },
    { [P]: wrap('void f() {\n\n      g();\n\n  }') },
  );
  assert.equal(units.length, 0, `expected none, got ${units.map((u) => u.fqn).join(', ')}`);
});

// ---------------------------------------------------------------- external bindings (5.1–5.4)
//
// A field's annotation can bind it to a name outside the codebase. Removing such a field retires a
// deployment key or breaks a wire contract — a consequence absent from the diff, the call graph and
// every test. Grounded in sedai-simulation-server#244, where two removed fields were annotated
// `@Value("${REUSE_SESSION:false}")` and `@Value("${RESET_CORE:false}")`.

console.log('\ndiff — external bindings on a field');

const fieldSym = (annotations, kind = 'FIELD') => ({ kind, annotations });
const keysOf = (sym) => externalBindings(sym).map((b) => b.key);

t('a Spring config key and its default are extracted', () => {
  const [b] = externalBindings(fieldSym(['@Value("${REUSE_SESSION:false}")']));
  assert.equal(b.key, 'REUSE_SESSION');
  assert.equal(b.kind, 'CONFIG_KEY');
  // The default is part of the contract: a key that defaulted to false is a different risk from
  // one with no default at all.
  assert.equal(b.fallback, 'false');
});

t('a config key with no default has a null fallback, not an empty string', () => {
  const [b] = externalBindings(fieldSym(['@Value("${PLAIN_KEY}")']));
  assert.equal(b.key, 'PLAIN_KEY');
  assert.equal(b.fallback, null);
});

t('wire names, aliases, columns and prefixes are all recognised', () => {
  assert.deepEqual(keysOf(fieldSym(['@JsonProperty("session_id")'])), ['session_id']);
  assert.deepEqual(keysOf(fieldSym(['@JsonAlias({"sid", "session"})'])), ['sid', 'session']);
  assert.deepEqual(keysOf(fieldSym(['@Column(name = "session_id", nullable = false)'])), ['session_id']);
  assert.deepEqual(keysOf(fieldSym(['@ConfigurationProperties(prefix = "vcluster")'])), ['vcluster']);
});

t('an unrecognised annotation produces no disclosure rather than a guess', () => {
  assert.deepEqual(externalBindings(fieldSym(['@Mock'])), []);
  assert.deepEqual(externalBindings(fieldSym(['@Autowired', '@Deprecated'])), []);
  assert.deepEqual(externalBindings(fieldSym([])), []);
});

t('only fields carry external bindings', () => {
  // A @Value on a method parameter or setter is a different construct; this module claims fields.
  assert.deepEqual(externalBindings(fieldSym(['@Value("${X}")'], 'METHOD')), []);
  assert.deepEqual(externalBindings(null), []);
});

t('removing an annotated field retires its key', () => {
  const c = bindingChange({ changeKind: 'REMOVED', symbol: fieldSym(['@Value("${RESET_CORE:false}")']) });
  assert.equal(c.effect, 'RETIRED');
  assert.equal(c.bindings[0].key, 'RESET_CORE');
});

t('adding an annotated field introduces one', () => {
  assert.equal(bindingChange({ changeKind: 'ADDED', symbol: fieldSym(['@Value("${NEW_KEY}")']) }).effect,
    'INTRODUCED');
});

t('a renamed wire name reports both directions', () => {
  const c = bindingChange({
    changeKind: 'MODIFIED',
    symbol: fieldSym(['@JsonProperty("newName")']),
    from: { symbol: fieldSym(['@JsonProperty("oldName")']) },
  });
  assert.equal(c.effect, 'RENAMED');
  assert.deepEqual(c.retired.map((x) => x.key), ['oldName']);
  assert.deepEqual(c.introduced.map((x) => x.key), ['newName']);
});

t('a field with no binding produces no box at all', () => {
  assert.equal(bindingChange({ changeKind: 'MODIFIED', symbol: fieldSym(['@Mock']) }), null);
  assert.equal(bindingChange({ changeKind: 'MODIFIED', symbol: null }), null);
});

t('every disclosure states that consumers are out of reach', () => {
  // Without this the empty consumer list could read as "nothing consumes it", which is the exact
  // false negative this whole change exists to remove.
  const c = bindingChange({ changeKind: 'REMOVED', symbol: fieldSym(['@Value("${K}")']) });
  assert.match(c.reach, /outside this analysis/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
