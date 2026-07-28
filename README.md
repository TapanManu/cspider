# cspider

PR semantic change reader. Presents a pull request as **change units and typed deltas** instead of
text hunks, and links producers to consumers across the PRs you give it.

Design lives in the workspace OpenSpec change `pr-semantic-graph-reader`. Measurements and every
correction the implementation forced on that design are in [`FINDINGS.md`](./FINDINGS.md).

## Status: Phase A complete, break analysis working

**Works:** multi-PR ingestion (cached by `pr_id + head_sha`), build-root detection, Java symbol
extraction, base-vs-head change units with typed deltas, signature-change pairing, rename/move
detection, noise suppression, cross-repo producer↔consumer correlation, ordered review list —
and with `--resolve`: JDT LS resolution with the annotation-processor agent attached and asserted,
resolved callers, resolution health, **break analysis** (UPDATED / BROKEN / SAFE), indirect fan-in
for overrides, and risk scoring.

and with `--resolve`: **blast-radius expansion** to depth 2 with disclosed truncation, `CO_CHANGED`
history correlation, `TEST_COVERS`, and topological review ordering.

**Not built yet:** the plugin contract extraction (Phase B), persistence, the local server API,
the UI, and comment posting.

## Setup

Node 20+, a JDK 21+, and an authenticated `gh` CLI. No token handling — it shells out to `gh`.

```bash
npm install
npm run jdtls     # only needed for the probe
```

## Use

```bash
npm run review -- https://github.com/<owner>/<repo>/pull/<n> [more PR urls...]

  --by-severity     order by provisional severity instead of file/containment
  --show-noise      include suppressed low-signal units
  --resolve         resolve callers and run break analysis (starts jdtls)
  --no-cache        ignore the cached graph for this head SHA and re-resolve
  --max-symbols N   cap symbols resolved per PR (default 40)
  --no-base         skip base-image resolution (removed members stay UNKNOWN)
  --topo            order by callers-before-callees
  --depth N         blast-radius depth (default 2, 0 disables)
  --max-nodes N     node ceiling for expansion (default 400)
  --reviewed <fqn>  mark matching change unit(s) reviewed (substring match)
  --unreviewed <fqn> clear the reviewed mark
  --progress        show review progress only
  --json <path>     write the full analysis
  --debug           stack traces on ingest failure

node src/cli.mjs --prune            # report reclaimable cache
node src/cli.mjs --prune --yes      # apply it
```

### UI

```bash
npm run serve            # http://127.0.0.1:4173
```

Three synchronised panes over the persisted analyses — the server never starts a language server,
so it is instant:

- **change units** — ordered by file, severity, or callers-first (topological), with broken and
  unknown badges and a reviewed toggle
- **blast radius** — a canvas where colour is change kind, size is risk, dashed outlines are
  unchanged context nodes, red edges are broken calls and dashed blue are test-covers; filter by
  edge type, hide context nodes
- **node facts** — signature, visibility, annotations, deltas, risk components, before/after source,
  and **call-site excerpts pulled from the calling file** with UPDATED/BROKEN/SAFE verdicts

Selecting in either the list or the graph selects in both. Disclosure banners sit above everything:
degraded resolution, expansion truncation, unresolved symbols, missing changed-line data, stale
review marks. A bounded analysis is never shown as a complete one.

### Graph cache

A graph is cached per head SHA, which is content-addressed and therefore safe to reuse:

```
cold  34s   (jdtls index, base index, resolution, expansion)
warm   1s   graph from cache (107 nodes, 226 edges)
```

A cache-served run restores the graph's own summary too — blast-radius bounds, truncations,
resolution health, processor status — so its disclosures are identical to a fresh run's. `--no-cache`
forces re-resolution.

### Review progress

Progress persists in SQLite at `.cache/cspider.db`, keyed by change-unit id — which is stable
across line movement, so a rebase or an edit elsewhere in the file does not lose it:

```
   reviewed: ████████████████████ 2/2
  ✓+ ADDED    sev  20  o.s.m.s.s.ExtendSessionRequest class
```

A mark is retained only while the symbol's own content hash matches. If the symbol itself changed,
the mark is reported **stale** rather than carried forward — telling you that you had already
reviewed code you have never seen would be worse than losing the mark.

With `--resolve` the report gains a break-analysis section listing call sites that may not have
been updated — the highest-value output of the tool:

```
━━ break analysis
   3 call site(s) may not have been updated:

   SessionService#resetSession(UUID,String,boolean)  [sedai-simulation-server#244]
     void resetSession(UUID,String) → void resetSession(UUID,String,boolean)
     ✗ backend/src/main/java/org/sedai/controller/SessionController.java:412
```

Give it every PR of one logical change and the cross-PR section will link them:

```
━━ cross-PR
   1 CROSS_REPO_PROVIDES edge(s)  [derived from NAME_MATCH, not resolution]
   sedai-models#4897 provides o.s.m.s.s.ExtendSessionRequest
     declared  src/main/java/.../ExtendSessionRequest.java:10
     consumed  sedai-simulation-server#244  backend/src/main/java/.../SessionController.java:31
```

## Tests

```bash
npm test    # 107 cases across six suites:
            #   diff    — parsing, delta types, change kinds, rename/move, noise
            #   compat  — signature compatibility and BROKEN/UPDATED/SAFE verdicts
            #   graph   — break analysis, indirect fan-in, UNKNOWN handling, and
            #             blast-radius bounds, all against a stub resolver
            #   store   — reviewed-state retention across head advances, and the
            #             per-artifact-class cache eviction policy
            #   source  — before/after retrieval, call-site excerpts, symbol
            #             blocks, and CALLS edge identity, against a real git repo
            #   server  — API contract, including that a bounded or degraded
            #             analysis cannot be served as if it were complete
```

A real PR that updated all of its call sites cannot exercise `BROKEN`, so the verdict logic is
proven against a stub resolver rather than only against live repositories.

## Layout

| Path | Purpose |
|---|---|
| `src/ingest/` | GitHub via `gh`, clone/worktree, payload cache, build-root detection, changed lines, source retrieval |
| `src/java/` | tree-sitter symbol extraction and the change-unit differ |
| `src/review/` | provisional severity, ordering, cross-repo correlation |
| `src/graph/` | nodes and edges, break analysis, indirect fan-in, risk, blast radius |
| `src/store/` | SQLite schema, analysis persistence, reviewed state, cache retention |
| `src/server/` | local HTTP API and the UI it serves (`public/`) |
| `src/cli.mjs` | the review command |
| `src/lsp.mjs` | JDT LS client + launcher, with annotation-processor agent attachment |
| `probe/` | the feasibility walking skeleton — answered Q1–Q3, kept for reference |
| `.cache/` | clones, worktrees, payloads, jdtls data (gitignored) |

**Boundary to respect:** nothing outside `src/java/` may import tree-sitter. That package moves
behind the out-of-process plugin contract in Phase B, which is what makes Go and Python additive.

## Known limits

- Java only.
- Only the primary build root is analyzed; others are reported as uncovered, not silently skipped.
- Non-Java changed files are listed but not analyzed.
- Lombok-generated members are not yet synthesised as nodes (F5b) — the agent makes them *resolve*,
  but `documentSymbol` still does not enumerate them.
- Blast radius is capped at depth 2 with a node ceiling and a query budget. Whenever a bound
  bites it is reported — the graph is never quietly presented as complete.
- Cache retention is split by artifact class: clones are pruned only explicitly, worktrees and
  indexes expire on a 7-day TTL plus an LRU size cap, and reviewer-authored data is never evicted.
  `--prune` reports before it deletes; `--yes` applies.
- The design lives in `openspec/changes/pr-semantic-graph-reader/`; `openspec validate` covers it.
