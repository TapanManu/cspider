// The variable verdict vocabulary (tasks 4.3–4.7). Java knowledge; moves into the plugin in Phase B.
//
// Break analysis for a method asks one question: does the call site still compile. For a field that
// question misses the most common real change. `VclusterProperties.defaultVersion` in the measured
// PR has a changed initializer and nothing else — every read compiles, and every read returns
// something different. So a variable needs its own vocabulary (D3):
//
//   BROKEN         the declaration is gone, renamed, or narrowed out of the usage's scope
//   TYPE_BROKEN    the type changed and the usage is not assignment-compatible with the new type
//   VALUE_CHANGED  declaration and type intact; the value changed. Compiles, behaves differently
//   UPDATED        the usage site is itself inside this PR's diff — the author has touched it
//   SAFE           reachable, compiles, and no value change is implied
//   UNKNOWN        not resolved, or resolved without a base image for a removed field
//
// VALUE_CHANGED is deliberately not folded into SAFE. A configuration default moving from false to
// true passes every test and changes production behaviour; the job is to put that in front of the
// reviewer, not to certify it.

export const VARIABLE_VERDICTS = ['BROKEN', 'TYPE_BROKEN', 'VALUE_CHANGED', 'UPDATED', 'SAFE', 'UNKNOWN'];

const VIS_RANK = { 'private': 0, 'package-private': 1, 'protected': 2, 'public': 3 };

// Widening is the only implicit conversion a *reader* of a field survives. `int n` → `long n` keeps
// every read compiling; the reverse does not.
const WIDENING = {
  byte: ['short', 'int', 'long', 'float', 'double'],
  short: ['int', 'long', 'float', 'double'],
  char: ['int', 'long', 'float', 'double'],
  int: ['long', 'float', 'double'],
  long: ['float', 'double'],
  float: ['double'],
};

const simple = (t) => String(t ?? '').replace(/<.*>/, '').replace(/^.*\./, '').trim();

/** `boolean flag` → `boolean`. A field signature is `<type> <name>` from parse.mjs. */
const typeOf = (sig) => {
  const m = /^(.*)\s+\S+$/.exec(String(sig ?? '').trim());
  return m ? m[1].trim() : null;
};

const packageOf = (path) => String(path ?? '').split('/').slice(0, -1).join('/');

/**
 * Is a usage still in scope after visibility narrowed?
 *
 * Syntactic and deliberately conservative. `private` reaches only the declaring file; anything
 * narrower than `public` stops at the package, approximated by the directory, which is exactly what
 * the Java package/directory correspondence guarantees for source trees. `protected` additionally
 * reaches subclasses in other packages, and subtype knowledge is not available here — so a
 * protected narrowing with an out-of-package usage is reported UNKNOWN rather than BROKEN.
 */
function scopeAfterNarrowing(after, declPath, usagePath) {
  if (after === 'public') return { inScope: true };
  const sameFile = declPath === usagePath;
  if (after === 'private') {
    return { inScope: sameFile, why: sameFile ? null : 'private now — reachable only inside the declaring file' };
  }
  const samePackage = packageOf(declPath) === packageOf(usagePath);
  if (samePackage) return { inScope: true };
  if (after === 'protected') {
    return {
      inScope: null,
      why: 'protected now, and the usage is in another package — in scope only if its type is a subclass, which is not resolved here',
    };
  }
  return { inScope: false, why: 'package-private now — reachable only inside the declaring package' };
}

/**
 * Classify one usage site of a changed variable.
 *
 * @param unit  the change unit: { changeKind, kind, path, deltas[], symbol }
 * @param site  { path, line, inDiff, direction }
 * @returns { verdict, reasons[] }
 *
 * Precedence, and why: a compile break outranks a value change, because code that does not build
 * makes the value moot. UPDATED absorbs BROKEN and TYPE_BROKEN — the author has already been at that
 * line — but it does NOT absorb VALUE_CHANGED. Editing the line a value is read on is not evidence
 * that the reader accounted for the new value, and a changed default that reads as UPDATED is the
 * same false reassurance as one that reads as SAFE.
 */
export function variableVerdict(unit, site = {}) {
  const reasons = [];
  const inDiff = !!site.inDiff;

  if (unit.changeKind === 'REMOVED') {
    reasons.push('declaration removed');
    return { verdict: inDiff ? 'UPDATED' : 'BROKEN', reasons };
  }
  if (unit.changeKind === 'RENAMED') {
    reasons.push(`renamed: ${unit.from?.simpleName ?? '?'} → ${unit.symbol?.simpleName ?? '?'}`);
    return { verdict: inDiff ? 'UPDATED' : 'BROKEN', reasons };
  }
  // An ADDED variable has no pre-existing usage to break. Any usage of it is new code.
  if (unit.changeKind === 'ADDED') return { verdict: inDiff ? 'UPDATED' : 'SAFE', reasons };

  const delta = (type) => (unit.deltas ?? []).find((d) => d.type === type);

  const vis = delta('VISIBILITY');
  if (vis && VIS_RANK[vis.after] < VIS_RANK[vis.before]) {
    const scope = scopeAfterNarrowing(vis.after, unit.path, site.path);
    if (scope.inScope === false) {
      reasons.push(`visibility reduced: ${vis.before} → ${vis.after} — ${scope.why}`);
      return { verdict: inDiff ? 'UPDATED' : 'BROKEN', reasons };
    }
    if (scope.inScope === null) {
      reasons.push(`visibility reduced: ${vis.before} → ${vis.after} — ${scope.why}`);
      return { verdict: 'UNKNOWN', reasons };
    }
  }

  const sig = delta('SIGNATURE');
  if (sig) {
    const b = typeOf(sig.before);
    const a = typeOf(sig.after);
    if (b && a && simple(b) !== simple(a)) {
      const widens = (WIDENING[simple(b)] ?? []).includes(simple(a));
      if (!widens) {
        reasons.push(`type changed: ${b} → ${a} — an existing ${
          site.direction === 'WRITE' || site.direction === 'BOTH' ? 'assignment' : 'read'
        } is not assignment-compatible with the new type`);
        return { verdict: inDiff ? 'UPDATED' : 'TYPE_BROKEN', reasons };
      }
      reasons.push(`type widened: ${b} → ${a} — existing reads still compile`);
    }
  }

  const init = delta('INITIALIZER');
  if (init) {
    reasons.push(`value changed: ${init.before ?? '∅'} → ${init.after ?? '∅'}`);
    // Not downgraded to UPDATED even when the site is in the diff. See the note above.
    return { verdict: 'VALUE_CHANGED', reasons, values: { before: init.before, after: init.after } };
  }

  if (inDiff) return { verdict: 'UPDATED', reasons };
  return { verdict: 'SAFE', reasons };
}

/**
 * The one fact about a variable change that applies to every usage at once, for the header of the
 * trace. Kept separate from the per-site verdict so the view can state "the value changed" once
 * rather than repeating it on twelve rows.
 */
export function valueChange(unit) {
  const init = (unit?.deltas ?? []).find((d) => d.type === 'INITIALIZER');
  return init ? { before: init.before, after: init.after } : null;
}
