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

**Not built yet:** the plugin contract extraction (Phase B) and Monaco-based before/after blocks.

## Quick start

```bash
npm install
npm run jdtls                                       # one-off: fetch Eclipse JDT LS
npm start -- https://github.com/OWNER/REPO/pull/123 # analyse, serve, open the browser
```

That single command analyses the PR, starts the local server, and opens the graph in your browser
deep-linked to that PR. Second run on the same PR is served from cache (~1s instead of ~35s).

Give it every PR of one logical change and they all load, with the cross-PR producer/consumer links:

```bash
npm start -- \
  https://github.com/SedaiEngineering/sedai-simulation-server/pull/244 \
  https://github.com/SedaiEngineering/sedai-models/pull/4897
```

Options: `--depth N`, `--max-symbols N`, `--no-base`, `--no-cache`, `--no-open`, `--port N`,
`--skip-analysis` (serve what is already stored).

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

`npm start -- <pr-url>` does analyse + serve + open in one step. To serve what is already stored
without re-analysing anything:

```bash
npm run serve            # http://127.0.0.1:4173
```

Three panes, in the order a review actually happens:

**1. Files** — a **directory tree**: folders nest, each file carries its own changed methods, and
runs of single-child directories collapse into one row (`main/java/org/sedai`) so the nesting shows
structure instead of consuming the pane. Method names are coloured by change kind, and each row
shows what *kind* of change it is as chips (`signature`, `visibility`, `annotation`, `throws`,
`body`), its caller count, a risk bar, and a broken badge. You can see whether a signature moved
without clicking anything.

Every row carries a **review checkbox**, at all three levels. Ticking a method marks it; ticking a
file or folder marks everything beneath it in one request. Parents show a **partial** state when only
some of their children are done — never rounded to done or not-done. The mark also appears on the
node in the graph, so the tree and the graph cannot disagree about what you have read.

A **stale** mark renders as its own state (amber `!`, not a tick), because `loadReviewed` reports a
symbol that changed after review as `reviewed: false, stale: true`. A tick there would claim you had
read code you have never seen.

Selecting anything — a method row, or a node in the graph — **lights the whole trail**: the method, its
file, and every folder containing it, with collapsed folders opened and the row scrolled into view.
Knowing *where* you are is the point of having a hierarchy.

Callers and tests are a different case. They are unchanged code, so most live in files this PR never
touched and therefore have **no row in the tree** — on the measured PR, only 1 of 12. Clicking one and
seeing nothing move would look like a broken click, so a crumb above the tree always names what is
selected and says when it is context that the tree cannot hold.

**2. Impact** — an **ego view**, not a whole-PR graph. Selecting a change lays out fixed lanes:

```
   TESTS        CALLED BY        THIS CHANGE        CALLS
   (10)            (2)                              (0)
```

Positions are computed rather than force-simulated, so labels never collide and the picture is
stable between selections. Click any node to re-centre on it. With nothing selected you get a
file-level overview sized by risk. Red edges are broken calls, dashed blue are test coverage,
dashed outlines are unchanged context pulled in for reach.

**Each node is drawn once.** A test that calls the changed member emits both a `CALLS` and a
`TEST_COVERS` edge; it belongs in TESTS, and `CALLED BY` is production reach only. Counting it in
both made `CALLED BY · 12` out of two real callers and ten test methods. The overlap is stated
rather than hidden — the subtitle reads `10 tests (10 calling)` — and the total resolved fan-in is
still reported separately.

**A context node is coloured by its break verdict**, not by change kind: red BROKEN, amber UPDATED,
green SAFE, grey when unknown. This PR did not change those methods, so they have no change kind to
show; what they have is a verdict, which is the most valuable fact in the view. Change kind and
verdict share a palette, but CHANGED nodes are drawn with a solid stroke and CONTEXT nodes dashed, so
dashed-green (SAFE) never reads as solid-green (ADDED). A `null` verdict stays grey — *unknown* must
not be able to look like *safe*.

**3. Change** — signature change first (parameter-level for long lists, so a 16-argument
constructor shows `+ SessionClusterResolver` rather than two unreadable walls), then every call site
inlined **from the calling file** with its UPDATED/BROKEN/SAFE verdict, then a unified diff with
runs of unchanged lines collapsed, then facts, deltas and risk components.

Disclosure banners sit above everything: degraded resolution, expansion truncation, unresolved
symbols, missing changed-line data, stale review marks. A bounded analysis is never shown as a
complete one.

### Commenting and submitting a review

Comment on any call site, on the change itself, or **on any single line of the diff** — click a line
number in the diff and the box opens against that line. Drafts are stored locally in SQLite and
shown in the **drafts** drawer; nothing reaches GitHub until you preview the payload and confirm it.

- **The anchor's side comes from the line, never from an assumption.** A deleted (`-`) line is
  addressed at base/`LEFT`, an added or context line at head/`RIGHT`. This holds for every change
  kind, so a REMOVED member is commentable inline on the code that was deleted rather than
  degrading to a PR-level comment. Sending a base line as `RIGHT` is the F13/F19 trap.
- **Anchors resolve when you write the comment**, not at submit time. A line GitHub can anchor
  becomes an inline comment; a line outside the diff becomes a pull-request level comment with its
  location preserved in the body, and the reason is stated. Discovering an unanchorable comment at
  submit time would mean losing a review's worth of work.
- **Suggestions** produce a GitHub ```suggestion``` block. A suggestion outside the diff is refused
  rather than silently downgraded, because a suggestion only means something anchored to the lines
  it replaces.
- **Preview shows the exact payload** — endpoint, `commit_id`, event, body and every comment — and a
  test asserts what was previewed is byte-for-byte what gets sent.
- **Submission requires `confirmed: true`.** The default is a refusal, so a missing flag can never
  post by accident.
- **A moved head blocks submission** and keeps every draft, because the line numbers in those drafts
  refer to the old head.
- **A rejected submit retains every draft**, and already-submitted drafts are never resent.

Events: `COMMENT`, `REQUEST_CHANGES`, `APPROVE`.

**Existing conversations** already on GitHub appear in a **Conversation** section on the change,
matched to the selected symbol's own line range (and labelled *in this file* when the range is not
known). They load after first paint, because the paginated GitHub call must not delay the graph. A
failure to load says so — an empty thread list and an unreachable API must not look alike.

Replying is the one write that is **not** a draft: it posts as soon as it is confirmed, so the reply
box says that outright, and the confirmation still renders the exact endpoint and JSON body first.

**One finding across several PRs.** When the same symbol is changed by more than one ingested PR,
*…and on other PRs* applies a single body to each of them — **one comment per PR, each anchored to
its own location**, because a line number means nothing outside its own repository. Each PR's anchor
resolves independently and the per-PR outcome is shown, so one PR anchoring inline while another
falls back to pr-level is visible rather than averaged into "saved".

A PR that does *not* change that symbol is listed as **not applicable** with the reason. Inventing a
location there would be worse than omitting the comment. Siblings share a group id, so the finding
can be edited or withdrawn everywhere at once, and each still submits inside its own PR's single
review pinned to that PR's own head SHA.

### Graph cache

A graph is cached per head SHA, which is content-addressed and therefore safe to reuse:

```
cold  34s   (jdtls index, base index, resolution, expansion)
warm   1s   graph from cache (107 nodes, 226 edges)
```

A cache-served run restores the graph's own summary too — blast-radius bounds, truncations,
resolution health, processor status — so its disclosures are identical to a fresh run's.

The bounds an analysis ran under are part of its cache identity. Asking for a wider analysis than
the cached one (`--max-symbols 40` against a graph built at 20) re-resolves and says so, rather than
handing back a more bounded result than you asked for. `--no-cache` always re-resolves.

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
npm test    # 146 cases across seven suites:
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
            #   write   — drafts, anchoring, suggestions, stale-head blocking, threads,
            #             shared findings with per-PR anchors, and that NOTHING reaches
            #             GitHub without explicit confirmation
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
