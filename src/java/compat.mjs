// Java-specific contract rules (tasks 4.9, 4.10): signature compatibility and source predicates.
// Everything here is Java knowledge and moves into the Java plugin in Phase B.

const WIDENING = {
  byte: ['short', 'int', 'long', 'float', 'double'],
  short: ['int', 'long', 'float', 'double'],
  char: ['int', 'long', 'float', 'double'],
  int: ['long', 'float', 'double'],
  long: ['float', 'double'],
  float: ['double'],
};

const params = (sig) => {
  const m = /\(([^)]*)\)/.exec(sig || '');
  if (!m || !m[1].trim()) return [];
  return m[1].split(',').map((s) => s.trim());
};

const simple = (t) => t.replace(/<.*>/, '').replace(/^.*\./, '');

// Can a call site written against `before` still compile against `after`?
function paramsCompatible(before, after) {
  const b = params(before);
  const a = params(after);

  if (a.length === b.length) {
    // Every position must accept the old argument type: identical, or a widening/boxing target.
    return b.every((bt, i) => {
      const at = a[i];
      if (simple(bt) === simple(at)) return true;
      const widensTo = WIDENING[simple(bt)] || [];
      if (widensTo.includes(simple(at))) return true;
      // Narrowing a parameter to a subtype, or to an unrelated type, breaks callers.
      return false;
    });
  }

  // A trailing varargs parameter absorbs the old fixed arity.
  const last = a[a.length - 1];
  if (last && last.endsWith('...') && a.length === b.length + 1) {
    return b.every((bt, i) => simple(bt) === simple(a[i]));
  }

  // Any other arity change breaks every existing call site.
  return false;
}

const VIS_RANK = { 'private': 0, 'package-private': 1, 'protected': 2, 'public': 3 };

const UNCHECKED = /(^|\.)(RuntimeException|Error|IllegalArgumentException|IllegalStateException|NullPointerException|UnsupportedOperationException|IndexOutOfBoundsException|ClassCastException|NumberFormatException|ArithmeticException)$/;

/**
 * Classify a change to one member against a call site.
 *
 * @param before  symbol at the merge base (null when the member is new)
 * @param after   symbol at head (null when the member was removed)
 * @param site    { inDiff } — was the call site itself modified by this PR?
 * @returns { verdict: UPDATED|BROKEN|SAFE, reasons[] }
 */
export function signatureCompatibility(before, after, site = {}) {
  const reasons = [];

  if (before && !after) {
    reasons.push('member removed');
    return { verdict: site.inDiff ? 'UPDATED' : 'BROKEN', reasons };
  }
  if (!before || !after) return { verdict: 'SAFE', reasons };

  if (!paramsCompatible(before.signature, after.signature)) {
    reasons.push(`parameters changed: ${before.signature} → ${after.signature}`);
  }

  const bRet = /^(\S+)\s/.exec(before.signature)?.[1];
  const aRet = /^(\S+)\s/.exec(after.signature)?.[1];
  if (bRet && aRet && simple(bRet) !== simple(aRet)) {
    reasons.push(`return type changed: ${bRet} → ${aRet}`);
  }

  if (VIS_RANK[after.visibility] < VIS_RANK[before.visibility]) {
    reasons.push(`visibility reduced: ${before.visibility} → ${after.visibility}`);
  }

  // A newly declared checked exception forces every caller to handle or declare it.
  const newChecked = (after.throws || [])
    .filter((t) => !(before.throws || []).includes(t))
    .filter((t) => !UNCHECKED.test(t));
  if (newChecked.length) reasons.push(`checked exception(s) added: ${newChecked.join(', ')}`);

  // Removing @Transactional/@Nullable/@Async changes behaviour without changing the signature —
  // it cannot break compilation, so it is never BROKEN, but it must be surfaced.
  const behavioural = /@(Transactional|Nullable|NonNull|Async|Cacheable|Retryable|PreAuthorize|Scheduled)\b/;
  const lost = (before.annotations || [])
    .filter((x) => behavioural.test(x) && !(after.annotations || []).includes(x));

  if (reasons.length === 0) {
    return {
      verdict: 'SAFE',
      reasons: lost.length ? [`behavioural annotation removed: ${lost.join(', ')} (compiles, but semantics changed)`] : [],
      behaviouralOnly: lost.length > 0,
    };
  }
  return { verdict: site.inDiff ? 'UPDATED' : 'BROKEN', reasons };
}

// Task 4.10
export function isTestSource(path) {
  return /(^|\/)src\/test\/|(^|\/)test\/|(Test|Tests|IT|ITCase|Spec|Steps)\.java$|(^|\/)integration\//.test(path);
}

export function isPublicApi(symbol) {
  return symbol.visibility === 'public' || symbol.visibility === 'protected';
}
