// What the Java analyser can actually produce (tasks 3.3, 3.4).
//
// The parent design puts `capabilities()` on the plugin contract so a plugin's gaps are *declared*
// rather than discovered: the host degrades explicitly for an edge type nobody claimed, instead of
// emitting an incomplete graph that looks complete. Phase A has no plugin process yet, so the
// declaration lives here and is read through the same seam — `buildGraph({ capabilities })` — that
// the plugin's answer will arrive on in Phase B. Nothing outside src/java/ hard-codes these names.

export const EDGE_TYPES = {
  CALLS: 'CALLS',
  TEST_COVERS: 'TEST_COVERS',
  READS_FIELD: 'READS_FIELD',
  WRITES_FIELD: 'WRITES_FIELD',
  // The fallback for an analyser that can locate a reference but not orient it. Kept distinct from
  // READS_FIELD on purpose: an undirected access must never be drawn in the same language as a read.
  ACCESSES_FIELD: 'ACCESSES_FIELD',
};

export const JAVA_CAPABILITIES = {
  language: 'java',
  tier: 1,
  extensions: ['.java'],
  edgeTypes: [
    EDGE_TYPES.CALLS,
    EDGE_TYPES.TEST_COVERS,
    // Declared because src/java/access.mjs classifies direction from the tree-sitter ancestor
    // chain. A tier-1 plugin for a language without an in-process parser would omit these two and
    // declare ACCESSES_FIELD instead, and the trace would then state the direction as unavailable.
    EDGE_TYPES.READS_FIELD,
    EDGE_TYPES.WRITES_FIELD,
  ],
  verdicts: ['BROKEN', 'TYPE_BROKEN', 'VALUE_CHANGED', 'UPDATED', 'SAFE', 'UNKNOWN'],
};

/** Does this analyser distinguish a field read from a field write? */
export function classifiesDirection(caps = JAVA_CAPABILITIES) {
  const types = caps?.edgeTypes ?? [];
  return types.includes(EDGE_TYPES.READS_FIELD) && types.includes(EDGE_TYPES.WRITES_FIELD);
}

/**
 * The edge type to use for one classified site. An analyser that declared only the undirected type
 * gets ACCESSES_FIELD for everything — including sites this one happened to classify — because
 * emitting an edge type a plugin did not declare is the drift `capabilities` exists to prevent.
 */
export function accessEdgeTypes(direction, caps = JAVA_CAPABILITIES) {
  if (!classifiesDirection(caps)) return [EDGE_TYPES.ACCESSES_FIELD];
  if (direction === 'READ') return [EDGE_TYPES.READS_FIELD];
  if (direction === 'WRITE') return [EDGE_TYPES.WRITES_FIELD];
  // A compound assignment reads before it writes. Both edges are emitted, and usage totals count
  // the site once — the site is one place in the code, however many relationships it creates.
  if (direction === 'BOTH') return [EDGE_TYPES.READS_FIELD, EDGE_TYPES.WRITES_FIELD];
  return [EDGE_TYPES.ACCESSES_FIELD];
}
