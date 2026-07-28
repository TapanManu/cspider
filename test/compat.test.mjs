// Break-analysis rules (task 4.9) and the BROKEN/UPDATED/SAFE verdicts (task 6.5).
// Deterministic — a real PR that happens to update all its call sites cannot exercise BROKEN.
import { signatureCompatibility, isTestSource, isPublicApi } from '../src/java/compat.mjs';
import assert from 'node:assert';

let pass = 0; let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
};

const sym = (o = {}) => ({
  signature: 'void f(String)', visibility: 'public', throws: [], annotations: [], ...o,
});

console.log('\nbreak analysis — arity');
t('added required parameter breaks a call site outside the diff', () => {
  const r = signatureCompatibility(sym(), sym({ signature: 'void f(String,int)' }), { inDiff: false });
  assert.equal(r.verdict, 'BROKEN');
  assert.match(r.reasons[0], /parameters changed/);
});

t('same change is UPDATED when the call site is inside the diff', () => {
  const r = signatureCompatibility(sym(), sym({ signature: 'void f(String,int)' }), { inDiff: true });
  assert.equal(r.verdict, 'UPDATED');
});

t('removed parameter breaks callers', () => {
  const r = signatureCompatibility(sym({ signature: 'void f(String,int)' }), sym(), { inDiff: false });
  assert.equal(r.verdict, 'BROKEN');
});

t('trailing varargs absorbs the old fixed arity — SAFE', () => {
  const r = signatureCompatibility(sym(), sym({ signature: 'void f(String,int...)' }), { inDiff: false });
  assert.equal(r.verdict, 'SAFE', r.reasons.join('; '));
});

console.log('\nbreak analysis — types');
t('widening a parameter is SAFE', () => {
  const r = signatureCompatibility(sym({ signature: 'void f(int)' }), sym({ signature: 'void f(long)' }), { inDiff: false });
  assert.equal(r.verdict, 'SAFE', r.reasons.join('; '));
});

t('narrowing a parameter is BROKEN', () => {
  const r = signatureCompatibility(sym({ signature: 'void f(long)' }), sym({ signature: 'void f(int)' }), { inDiff: false });
  assert.equal(r.verdict, 'BROKEN');
});

t('changed return type is BROKEN', () => {
  const r = signatureCompatibility(sym({ signature: 'int f(String)' }), sym({ signature: 'long f(String)' }), { inDiff: false });
  assert.equal(r.verdict, 'BROKEN');
  assert.ok(r.reasons.some((x) => /return type/.test(x)));
});

t('identical signature is SAFE', () => {
  const r = signatureCompatibility(sym(), sym(), { inDiff: false });
  assert.equal(r.verdict, 'SAFE');
  assert.deepEqual(r.reasons, []);
});

console.log('\nbreak analysis — visibility, removal, exceptions');
t('visibility reduction is BROKEN', () => {
  const r = signatureCompatibility(sym(), sym({ visibility: 'private' }), { inDiff: false });
  assert.equal(r.verdict, 'BROKEN');
  assert.ok(r.reasons.some((x) => /visibility reduced/.test(x)));
});

t('visibility widening is SAFE', () => {
  const r = signatureCompatibility(sym({ visibility: 'protected' }), sym({ visibility: 'public' }), { inDiff: false });
  assert.equal(r.verdict, 'SAFE');
});

t('removed member is BROKEN for callers outside the diff', () => {
  const r = signatureCompatibility(sym(), null, { inDiff: false });
  assert.equal(r.verdict, 'BROKEN');
  assert.match(r.reasons[0], /removed/);
});

t('new checked exception is BROKEN', () => {
  const r = signatureCompatibility(sym(), sym({ throws: ['java.io.IOException'] }), { inDiff: false });
  assert.equal(r.verdict, 'BROKEN');
  assert.ok(r.reasons.some((x) => /checked exception/.test(x)));
});

t('new unchecked exception is SAFE — it does not force callers to change', () => {
  const r = signatureCompatibility(sym(), sym({ throws: ['IllegalStateException'] }), { inDiff: false });
  assert.equal(r.verdict, 'SAFE', r.reasons.join('; '));
});

console.log('\nbreak analysis — behavioural annotations');
t('removed @Transactional compiles but is surfaced, never BROKEN', () => {
  const r = signatureCompatibility(
    sym({ annotations: ['@Transactional'] }), sym({ annotations: [] }), { inDiff: false });
  assert.equal(r.verdict, 'SAFE');
  assert.equal(r.behaviouralOnly, true);
  assert.match(r.reasons[0], /behavioural annotation removed/);
});

t('removed non-behavioural annotation is silent', () => {
  const r = signatureCompatibility(
    sym({ annotations: ['@SuppressWarnings("x")'] }), sym({ annotations: [] }), { inDiff: false });
  assert.equal(r.verdict, 'SAFE');
  assert.deepEqual(r.reasons, []);
});

console.log('\npredicates');
t('isTestSource', () => {
  assert.ok(isTestSource('backend/src/test/java/org/sedai/FooTest.java'));
  assert.ok(isTestSource('integration/src/test/java/org/sedai/Steps.java'));
  assert.ok(!isTestSource('backend/src/main/java/org/sedai/Foo.java'));
});

t('isPublicApi', () => {
  assert.ok(isPublicApi({ visibility: 'public' }));
  assert.ok(isPublicApi({ visibility: 'protected' }));
  assert.ok(!isPublicApi({ visibility: 'private' }));
  assert.ok(!isPublicApi({ visibility: 'package-private' }));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
