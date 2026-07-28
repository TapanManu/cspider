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

**Not built yet:** the plugin contract extraction (Phase B), blast-radius expansion, co-change and
test-coverage edges, topological ordering, persistence, the UI, and comment posting.

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
  --max-symbols N   cap symbols resolved per PR (default 40)
  --json <path>     write the full analysis
  --debug           stack traces on ingest failure
```

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
npm test    # 47 cases across three suites:
            #   diff    — parsing, delta types, change kinds, rename/move, noise
            #   compat  — signature compatibility and BROKEN/UPDATED/SAFE verdicts
            #   graph   — break analysis and indirect fan-in wired end to end (stub resolver)
```

A real PR that updated all of its call sites cannot exercise `BROKEN`, so the verdict logic is
proven against a stub resolver rather than only against live repositories.

## Layout

| Path | Purpose |
|---|---|
| `src/ingest/` | GitHub via `gh`, clone/worktree, payload cache, build-root detection |
| `src/java/` | tree-sitter symbol extraction and the change-unit differ |
| `src/review/` | provisional severity, ordering, cross-repo correlation |
| `src/graph/` | nodes and edges, break analysis, indirect fan-in, risk |
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
- Resolution is depth-1 only; blast-radius expansion is not implemented.
- `REMOVED` members are not resolved: there is no head-side position to query, so their callers
  need base-image resolution (not yet wired). Their break verdict is therefore unknown, not SAFE.
- Nothing is persisted between runs except the payload/clone caches.
