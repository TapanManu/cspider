// Review ordering, provisional severity, and cross-repo correlation.
//
// Honest scope note: real risk (design D5) needs resolved callers, break analysis, and test
// coverage — none of which exist until Phase C. What is computed here is a *provisional
// severity* from change-derived facts only, and it is labelled as such everywhere it appears.
// Calling it "risk" before resolution exists would overstate what the tool knows.

const DELTA_WEIGHT = {
  SIGNATURE: 30,
  VISIBILITY: 25,
  THROWS: 15,
  ANNOTATION: 15,
  MODIFIER: 10,
  BODY: 5,
};
const KIND_WEIGHT = { REMOVED: 25, MOVED: 10, RENAMED: 10, ADDED: 5, MODIFIED: 0 };

export function provisionalSeverity(unit) {
  const components = [];
  const add = (name, points, detail) => { if (points) components.push({ name, points, detail }); };

  for (const d of unit.deltas) {
    add(`delta:${d.type}`, DELTA_WEIGHT[d.type] ?? 5, `${fmt(d.before)} → ${fmt(d.after)}`);
  }
  add(`changeKind:${unit.changeKind}`, KIND_WEIGHT[unit.changeKind] ?? 0);

  const vis = unit.symbol.visibility;
  if (vis === 'public' || vis === 'protected') {
    add('public-api-surface', 15, `${vis} member`);
  }

  const churn = unit.symbol.bodySize ?? 0;
  add('body-churn', Math.min(15, Math.round(churn / 200)), `${churn} chars`);

  const total = components.reduce((n, c) => n + c.points, 0);
  return { total, components };
}

function fmt(v) {
  if (Array.isArray(v)) return v.length ? v.join(' ') : '∅';
  return v === null || v === undefined ? '∅' : String(v);
}

// Ordering: without CALLS edges there is no topological order yet (Phase C). Until then the
// order is declaration-containment then severity — types before their members, so a reviewer
// still reads the declaration before its body changes.
export function orderUnits(units) {
  const depth = (u) => u.fqn.split(/[.#]/).length;
  return [...units].sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    if (depth(a) !== depth(b)) return depth(a) - depth(b);
    return b.severity.total - a.severity.total;
  });
}

export function bySeverity(units) {
  return [...units].sort((a, b) => b.severity.total - a.severity.total);
}

/**
 * F6 / R6: cross-repo producer↔consumer correlation.
 *
 * In Phase A this needs no language server at all: an import in PR A whose FQN equals a
 * top-level type ADDED by PR B is the same signal as an *unresolved* import matching an added
 * type, and it is available from the AST alone. Tagged NAME_MATCH because it is name-derived.
 */
export function correlateCrossRepo(analyses) {
  const addedTypes = new Map(); // fqn -> { prKey, unit }
  for (const a of analyses) {
    for (const u of a.units) {
      if (u.changeKind !== 'ADDED') continue;
      if (!['CLASS', 'INTERFACE', 'ENUM', 'RECORD', 'ANNOTATION_TYPE'].includes(u.kind)) continue;
      addedTypes.set(u.fqn, { prKey: a.key, unit: u });
    }
  }

  const edges = [];
  for (const consumer of analyses) {
    for (const imp of consumer.imports) {
      const producer = addedTypes.get(imp.fqn);
      if (!producer) continue;
      if (producer.prKey === consumer.key) continue; // same PR — ordinary intra-repo edge
      edges.push({
        type: 'CROSS_REPO_PROVIDES',
        derivedFrom: 'NAME_MATCH',
        from: { pr: producer.prKey, fqn: producer.unit.fqn, path: producer.unit.path,
                line: producer.unit.symbol.range.start.line + 1 },
        to: { pr: consumer.key, fqn: imp.fqn, path: imp.path, line: imp.line },
      });
    }
  }
  return edges;
}
