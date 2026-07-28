# Walking skeleton findings

Probe: `node probe/probe.mjs <pr-url>`. Throwaway harness — its output is decisions, not code we keep.

Runs: `google/gson#3067` (smoke test) and the four `SM-1182` PRs across
`sedai-simulation-server`, `sedai-tests`, `sedai-models`, `sedai-core`.

## Verdict: build it. No blocking feasibility problem, one blocking prerequisite (Lombok).

## Measurements

| Repo / PR | Java files | Project root | Clone | Index → ServiceReady | Errors in changed files | Verdict |
|---|---|---|---|---|---|---|
| gson#3067 | 2 | `.` | 13s | 56s (cold `~/.m2`) | 4 | minor gaps |
| sedai-simulation-server#244 | 9 | `backend` | 19s | **2s** | 528 | DEGRADED |
| sedai-tests#236 | 6 | `integration` | 11s | **9s** | **0** | clean |
| sedai-models#4897 | 1 | `.` | 46s | **2s** | **0** | clean |
| sedai-core#18710 | 1 | `.` | **143s** | **8s** | 43 | DEGRADED |

## Q1 — Index time is not the bottleneck. The clone is.

**Answered, and better than assumed.** With a warm `~/.m2`, jdtls imports and reaches
`ServiceReady` in **2–9 seconds**, even on `sedai-core` — the status trace confirms a genuine
multi-module Maven import (`Importing Maven project(s) → Project 'parent' → Project 'config' →
ProjectStatus OK`), not a skipped one. The 56s gson figure was dependency *downloading*, not
indexing.

This materially changes D6. The design treats the index as "the expensive stage (minutes on a large
repo)" and builds lazy resolution and progress-streaming around that premise. On a developer machine
with a populated `~/.m2` that premise is false.

- **Real cost is the initial clone**: 143s for `sedai-core`, even bare + `--filter=blob:none`. It is
  one-off per repo and already cached, so this vindicates R4's "clones pruned only explicitly".
- **Second real cost is `references` throughput**: 115s to resolve 10 symbols in `sedai-core`
  (~11s/symbol) versus ~0.4s/symbol in `sedai-simulation-server`. Query latency scales with
  workspace size, not index time. **This**, not indexing, is what lazy resolution must be designed
  around — and it makes the D3 depth-2 cap look generous rather than conservative on a monorepo.

## Q2 — Resolution health: two causes, and only two.

**Answered.** Across every error diagnostic in all four repos, the causes bucket cleanly:

| Cause | Count | Where |
|---|---|---|
| Lombok-generated accessors | 350 | sim-server (`VclusterProperties.VersionEntry.getVersion/setVersion`) |
| Lombok-generated accessors | 43 | sedai-core (`CoreProfilingConfigDto.isAggressive`, `CoreOperationDto.setActionName`) — **100% of its errors** |
| Cross-repo type not yet published | 172 | sim-server importing `org.sedai.models.simulation.session.ExtendSessionRequest` |

`sedai-tests` and `sedai-models` were **completely clean**. There is no third cause. Nothing here is
a generic classpath problem — `ProjectStatus: OK` in every run.

Also note `mvn dependency:go-offline` made **no difference** to any figure. With a warm `~/.m2` it is
a no-op, so R2's "attempt a dependency-resolution-only build" is not load-bearing on a developer
machine. Keep it for cold environments, but it is not the lever.

## Finding F5 — RESOLVED (F5a) and REDUCED (F5b) by attaching the Lombok agent

Adding `-javaagent:<lombok.jar>` to the jdtls launcher, with the version read from the project's own
build files and matched against `~/.m2`:

| Repo | Errors before | Errors after | Remaining cause |
|---|---|---|---|
| sedai-simulation-server#244 | 528 | **2** | cross-repo `ExtendSessionRequest` import (F6) |
| sedai-core#18710 | 43 | **0** | — clean |
| sedai-tests#236 | 0 | 0 | — clean |
| sedai-models#4897 | 0 | 0 | — clean |

Version matching works and matters: `sedai-core` declares `1.18.42` and the probe selected exactly
that jar rather than the newest available (`1.18.46`).

**F5a — resolution: fixed.** All 393 phantom "method is undefined" errors are gone. Every remaining
error across all four repos is the genuine cross-repo dependency in F6. The probe now refuses to
analyze a Lombok project when no jar can be found, rather than silently degrading.

**F5b — symbol enumeration: still broken, but narrower than feared.** `documentSymbol` reports only
source-declared members, so `ExtendSessionRequest.java` *still* reports 0 methods — correctly, since
its source declares none:

```java
@Setter @Getter @Builder @NoArgsConstructor @AllArgsConstructor
public class ExtendSessionRequest {
    @NotBlank private String duration;
}
```

A direct test (`probe/lombok-edge-test.mjs`) settles how bad this is. On a real call site of a
generated accessor in `sedai-core` — `request.isAggressive()` at `SimulationServer.java:748`:

- `textDocument/definition` → **resolves**, to `CoreProfilingConfigDto.java:24:20-30`, the backing
  `aggressive` field.
- `textDocument/hover` → **resolves**, to the full signature
  `boolean …CoreProfilingConfigDto.isAggressive()` plus its javadoc.

So **`CALLS` edges into generated accessors are formable with real evidence** — the target has a
usable source location (the field) and a resolvable signature. This is a *node-synthesis* problem,
not an edge-loss problem, which is a much cheaper fix than the Tier 2 work previously assumed:

> For a Lombok-annotated type, synthesise member nodes from the fields plus the class/field
> annotations — `@Getter` → `getX()`/`isX()`, `@Setter` → `setX()`, `@Builder` → `builder()`,
> `@AllArgsConstructor` → the constructor — each anchored to the backing field's range, which is
> exactly where `definition` points. Tier 1 can do this; no JDT binding access required.

Nodes so synthesised must be marked `derivedFrom: GENERATED` so a reviewer is never shown a
generated accessor as if it were hand-written code.

## Finding F7 — `workspace/symbol` is unusable at monorepo scale

`workspace/symbol` for a single identifier **timed out at 60s** on `sedai-core`, while
`definition` and `hover` on the same workspace returned in well under a second. Combined with
`references` costing ~11s/symbol there, the pattern is clear: **position-anchored queries are cheap,
workspace-wide queries are not.** The resolver must be built exclusively on position-anchored
requests, and `workspace/symbol` should not appear in the Tier 1 adapter at all.

## Original F5 statement (superseded by the above, kept for the record)

This was the flagged risk, and it is real and larger than expected.

jdtls does not run the Lombok annotation processor unless `lombok.jar` is passed as a `-javaagent`
to the server JVM. Without it, every `@Data` / `@Getter` / `@Setter` accessor **does not exist** as
far as resolution is concerned. Consequences observed:

1. **393 phantom errors** across two repos, all "method is undefined".
2. **`sedai-models#4897` reported 0 methods** for the added `ExtendSessionRequest.java`. It is a
   Lombok DTO, so it has no explicitly declared methods. The graph would show "a class was added"
   with no members, no accessors, and no callers — an *empty node for the very change under review*.
3. Any `CALLS` edge into a generated accessor is missing entirely. Not marked unresolved — **absent**.

That third point is the dangerous one, and it is precisely the failure mode D6 and R2 exist to
prevent: a sparse-but-plausible graph. The resolution-health metric catches (1), but (2) and (3)
produce *no diagnostic at all* in the consuming file.

**Required before any real build**: pass `-javaagent:/path/to/lombok.jar` in the jdtls launcher and
re-measure. This is a small change to `src/lsp.mjs` but it gates the trustworthiness of everything
above it. It becomes a blocking prerequisite task, not a nice-to-have.

## Finding F6 (design gap) — the real review unit is cross-repo, and the design is single-repo

All four PRs are **one logical change**, `SM-1182`, split across four repositories. This is not an
edge case; it is how the change actually exists.

The 172 unresolved-import errors in `sedai-simulation-server` are `ExtendSessionRequest` — a class
**added by `sedai-models#4897`**, one of the other three PRs. So:

- The dependency is a *published artifact version* that predates the change, so the type genuinely
  does not exist on the classpath. This is not a tooling failure and no amount of jdtls
  configuration fixes it.
- No single-repo analysis can connect `sedai-simulation-server#244`'s consumer to
  `sedai-models#4897`'s producer. The most important edge in this entire change set is invisible.

The design's multi-PR support (FR-1, R1) merges PRs from the **same** repo and detects overlapping
symbols. It has no concept of a producer/consumer edge **across** repos, and cross-language /
cross-repo edges are explicitly a non-goal.

That non-goal now looks wrong for the primary use case. Options, in rough cost order:

1. **Unresolved-import correlation (cheap, high value).** When an unresolved import in PR A matches
   a type *added* by PR B in the ingested set, emit a `CROSS_REPO_PROVIDES` edge. Purely textual —
   no cross-repo classpath needed — and it would have surfaced the single most important
   relationship in SM-1182.
2. **Sibling-source classpath injection (moderate).** Point jdtls at the sibling repo's changed
   sources so the type resolves properly and real `CALLS` edges form.
3. **Full multi-repo workspace (expensive).** Import all four as one workspace.

Recommend (1) for the first build. It is nearly free and captures most of the value.

## Finding F4 — repo root ≠ project root

Two of four repos build from a subdirectory (`backend`, `integration`). Initialising jdtls on the
repo root silently skips the Maven import: it reports `ServiceReady` in ~2s having resolved nothing.
Project-root detection from the changed files' nearest build file is mandatory, and the probe's first
run produced entirely misleading numbers before this was fixed. A "ready quickly with many
unresolved symbols" signature should be treated as a hard error, not a warning.

## Finding F1 — `references` on an override collapses to the supertype binding

From the gson run: five anonymous `TypeAdapter` subclasses each reported **exactly 42 callers, and
identical ones** — the call sites of the base `TypeAdapter.read(JsonReader)`, not of each override.
Correct LSP behaviour (a call through a supertype reference is not statically attributable to one
override) but wrong for our purposes.

- **D5 risk scoring has a defect as specified**: naive `references` count as fan-in scores every
  override of a hot interface at maximum risk. Fan-in for overrides must be attributed through the
  `OVERRIDES`/`IMPLEMENTS` edge and displayed honestly — "42 callers of the interface method;
  dispatch to this implementation not statically determined".
- **D4 break analysis is unaffected**, and arguably strengthened: a signature change on an override
  genuinely does affect all those call sites.
- Concrete justification for D9's Tier 2: separating "direct call to this declaration" from "virtual
  dispatch that may reach it" needs binding information `references` does not expose.

## Finding F2 — probe resolves all methods in changed files, not changed methods

No base-vs-head symbol diffing in the skeleton, so per-symbol counts above are "methods in touched
files", not change units. Expected for a skeleton; noted so the numbers are not over-read.

## Finding F3 — zero-caller ratio is not a health signal on its own

Ranged 0.17–0.48, dominated by test methods and entry points, which correctly have no callers. Any
metric built on it must exclude test sources first — the design already has `isTestSource` for this.

## Design changes these findings imply

| Finding | Change |
|---|---|
| F5a Lombok resolution | **Done in the probe, must be a required launcher step**: attach `-javaagent:lombok.jar` with the version read from the project's build files; refuse to analyze a Lombok project without it. |
| F5b Lombok members | Tier 1 synthesises member nodes from fields + Lombok annotations, anchored to the field range, marked `derivedFrom: GENERATED`. Cheaper than the Tier 2 work first assumed. |
| F7 query cost | Resolver uses position-anchored requests only. Drop `workspace/symbol` from the Tier 1 adapter — it times out at 60s on `sedai-core`. |
| F6 cross-repo | Add `CROSS_REPO_PROVIDES` via unresolved-import correlation. Revisit the cross-repo non-goal — it conflicts with the primary use case. |
| F4 project root | Project-root detection is a required ingestion step; treat "fast ready + many unresolved" as a hard error. |
| F1 override fan-in | Fix D5: attribute override fan-in through `OVERRIDES`/`IMPLEMENTS`, never raw `references` count. |
| Q1 | Rewrite D6's cost model: clone and `references` latency are the costs, not indexing. Lazy resolution is still right, for a different reason. |
| Q2 | R2's dependency-resolve step is not load-bearing with a warm `~/.m2`; keep for cold environments, do not rely on it. |

---

# Phase A findings (implementation)

Phase A is built: ingestion, Java symbol parsing, base-vs-head change units with typed deltas,
cross-repo correlation, and an ordered review list. 23/23 unit tests pass. Run with
`npm run review -- <pr-url> [...]`.

## Finding F8 (silent data loss) — node-tree-sitter's 32KB read buffer

`parser.parse(source)` with a source larger than **32,768 bytes** returns an **empty tree with no
error raised**. `CatalystClient.java` (33,867 bytes) yielded **0 symbols** and was silently treated
as unchanged; three of four PRs "failed" with an opaque `Invalid argument` downstream.

Fix: always pass an explicit buffer size — `parser.parse(src, undefined, { bufferSize: src.length + 4096 })`.
After the fix that file yields 54 symbols.

This is the same failure class as F5b and R2: a plausible-looking result that is quietly incomplete.
It argues for a **completeness assertion in the parser itself** — a file with a non-trivial byte
count that yields zero symbols should be a hard error, not a valid empty table.

## Finding F9 (correctness) — a type must not be MODIFIED because a member changed

Hashing a type's whole body meant every enclosing class was reported MODIFIED whenever any member
changed — noise on literally every PR. A type's identity is now its **own declaration** (kind, name,
type parameters, extends/implements/permits) and nothing else. Member changes are reported as their
own units, which is the entire point of change units.

## Finding F10 (correctness) — a parameter-list change is one unit, not two

Because an FQN embeds the parameter list, `resetSession(UUID)` → `resetSession(UUID, boolean)`
appeared as REMOVED + ADDED. That splits and buries the most valuable signal in a review — a
signature changed, so callers may now be broken — and it would have been invisible to Phase C's
break analysis.

Now paired into a single MODIFIED unit carrying a SIGNATURE delta. On
`sedai-simulation-server#244` this collapses 47 units to 44 and lifts three real signature changes
to the top of the severity order:

```
~ MODIFIED sev 54  SessionService#resetSession(UUID,String,boolean)
           signature: void resetSession(UUID,String) → void resetSession(UUID,String,boolean)
~ MODIFIED sev 54  DeploymentManagementService#DeploymentManagementService(…,SessionClusterResolver)
~ MODIFIED sev 54  DeploymentManagementService#resetSession(UUID,boolean)
```

Ambiguous cases are deliberately left unpaired: when several overloads of one name are both added
and removed, any pairing would be invented, so both units stand.

## Finding F11 — two IEEE-754 rounding traps in confidence scoring

`0.7 + 0.2` evaluates to `0.8999999999999999`, which fell below a `0.9` rename threshold and
suppressed **every** rename detection. Scoring is now integer points out of 100.

Separately, an empty method body hashes identically to any other empty body, so `void a() {}` →
`void b() {}` paired as a rename. Body similarity now only counts as evidence when the body carries
at least a minimum of identifying content.

## F6 confirmed end-to-end, with no language server involved

The cross-repo edge fires on the real change set, with exact evidence on both ends:

```
sedai-models#4897 provides o.s.m.s.s.ExtendSessionRequest
  declared  src/main/java/org/sedai/models/simulation/session/ExtendSessionRequest.java:10
  consumed  sedai-simulation-server#244  backend/src/main/java/org/sedai/controller/SessionController.java:31
```

Better than R6 assumed: in Phase A this needs **no resolution at all**. An import whose FQN equals a
type ADDED by another PR in the set is the same signal as an *unresolved* import matching an added
type, and it is available from the AST alone. R6's design can drop its dependency on unresolved-import
reporting for the common case.

## Deliberately not built in Phase A

No graph, no resolution, no callers, no break analysis, no test coverage, no UI, no comments.
Severity is labelled **provisional** everywhere it appears and is derived from the change alone;
ordering is file/containment or severity, because topological ordering needs CALLS edges (Phase C).

## Finding F12 — `textDocument/references` silently fails without `context`

The LSP spec makes `context` a required member of `ReferenceParams`. Omitting it does not produce a
validation error from jdtls — it answers `-32603: Internal error.` for every request. The resolver
returned zero callers for every symbol while reporting a healthy index and 50 successful queries.

Caught only because the graph layer records *why* a symbol was unresolved rather than treating an
empty caller list as "no callers". That distinction — unresolved versus genuinely zero — is worth
keeping everywhere: an empty result and a failed result must never render the same.

## Break analysis validated

`sedai-simulation-server#244` resolves clean (health `clean`, agent attached, 0 unresolved) and
reports **"9 updated"** for `resetSession` — the author did update every call site. A true negative,
which cannot exercise `BROKEN`, so the verdict logic is proven separately against a stub resolver:
17 rule cases plus 7 graph-wiring cases covering arity, widening/narrowing, return type, visibility,
removal, checked versus unchecked exceptions, behavioural annotations, and in-diff attribution.

## Finding F13 (confidently wrong) — base-side and head-side line numbers are not interchangeable

Implementing A1 (base-image resolution for `REMOVED` members) immediately produced **7 BROKEN
verdicts** on `sedai-simulation-server#244` — all false.

Callers of a removed member are resolved against the **base** image, so they carry base-side line
numbers. Those were being checked against the set of **head-side** added lines. The two coordinate
spaces are unrelated, so the "was this call site updated?" test was meaningless: heavily-rewritten
test files, whose callers had in fact been deleted alongside the method, were reported as unupdated.

Fix: `changedLines` now returns both sides — head-side additions and base-side deletions — and the
verdict is checked against the side matching the image the caller was resolved from. Each call site
records which side it came from. After the fix the same PR reports **no unupdated call sites**, which
is correct: the author removed the methods and their callers together.

This is the worst failure class the tool can have. An absent finding is a missed opportunity; a
false BROKEN sends a reviewer to demand changes to correct code. Two regression tests now pin it:
a base-side caller on a deleted line must be UPDATED, and head-side changed lines must never satisfy
a base-side caller.

## A1–A4 complete

| Change | Effect |
|---|---|
| **A3** changed lines from git, both sides | verdicts no longer depend on GitHub's optional `patch`; `source` is reported (`git`/`patch`/`none`) |
| **A2** `UNKNOWN` verdict | cap, budget exhaustion, failed query, ambiguous overload, and missing line data all render as UNKNOWN with a reason — never as SAFE or silence |
| **A1** base-image resolution | `REMOVED` members get real callers and verdicts; a second index costs 2–9s, which Q1 is what makes it affordable |
| **A4** parser completeness assertion | a file declaring a type that yields zero symbols is now a hard failure (the F8 class) |

Also landed from group 6: `CO_CHANGED` from git history (correlation, labelled as such),
`TEST_COVERS` from test-source callers, and topological review ordering with cycles broken by
descending risk.

Test suites: **54 cases** — 23 diff, 17 compat, 14 graph.

## Blast radius (6.3, 6.4)

Expansion adds CONTEXT nodes for the *members* that call the changed ones — resolved via
`documentSymbol` and an innermost-range lookup, so a context node is a symbol rather than a file.
A call site outside any member (field initialiser, static block) does not invent a node.

Bounded three ways, and every bound that bites is recorded on the node it truncated:

| Bound | Default | Why |
|---|---|---|
| depth | 2 | depth 3 on a high-fan-in service method produces a hairball no reviewer can use |
| node ceiling | 400 | keeps the canvas interactive |
| query budget | 300 | the real constraint — `references` measured ~11s/symbol on a monorepo vs ~0.4s on a small one |

On `sedai-simulation-server#244`: **63 context nodes** (41 at depth 1, 22 at depth 2) and **244
CALLS edges**, no truncation. That is an impact graph rather than a change list.

Seven regression tests pin the bounds, including that depth terminates on a cyclic caller chain
that would otherwise expand forever, and that a context node whose own callers were not resolved is
marked UNKNOWN rather than appearing to be a leaf. A leaf that is really an unexplored frontier is
the same lie as a silent truncation.

## Persistence (group 1) and reviewed state (6.11)

SQLite at `.cache/cspider.db`. The design decision that matters is **what is keyed by what**:

| Data | Key | Retention |
|---|---|---|
| PR facts, change units, nodes, edges | pr + `head_sha` | derived and rebuildable; cached to skip re-resolution |
| reviewed state, drafts | pr + **unit_id** (not `head_sha`) | never evicted, never rebuilt |

Reviewed state is keyed by change-unit id, which excludes path and line, so a mark survives a
rebase or an edit elsewhere in the file. It is retained only while the unit's **content hash**
still matches — signature, visibility, modifiers, annotations, throws, body. If the symbol itself
changed, the mark is reported **stale** rather than carried forward.

That asymmetry is the whole point. Losing a mark costs a re-read; carrying one forward tells the
reviewer they have already checked code they have never seen. Marks for symbols no longer in the PR
are counted as **orphaned** rather than silently dropped.

### Cache retention measured

`--prune` on the working cache after analysing four PRs:

```
  index       7 entries     1.9GB
  clone       5 entries     174MB  (never evicted)
  worktree    7 entries     113MB
  payload     4 entries     108KB
  total                     2.1GB
```

Language-server indexes are **90% of the footprint** while clones — the most expensive thing to
lose at 143s to re-clone — are 8%. That is exactly the asymmetry R4 split on, and a single LRU pool
over both would have evicted the wrong thing. Prune is dry-run by default and reports what would go
and how much it would reclaim before deleting anything.

18 store tests, including: a mark survives line movement, a mark goes stale on a visibility change
alone, TTL expiry evicts the index but never the clone, the size cap spares clones, and reviewer
state survives an eviction that clears every evictable artefact.

## Rendering prerequisites — two data gaps found while scoping the UI

### Gap 2 (correctness) — CALLS edges were duplicated and half-anchored

Break analysis created a CALLS edge per call site, and blast-radius expansion later created its own
edge for the same site. On `sedai-simulation-server#244` that produced **244 edges of which only 166
were distinct — 78 duplicates** — and 74 carried no caller endpoint at all, because break analysis
knows the call *site* but not the enclosing caller.

An edge with one endpoint cannot be drawn, and duplicates would have double-weighted every
fan-in-derived visual. Fixed by giving edges an identity — `(target, path, line)` — so break
analysis creates the edge and expansion fills `from` in on the *same* edge. After the fix:

```
CALLS edges: 172   distinct: 172   duplicated: 0
with caller endpoint: 164 / 172     drawable: 164
```

The remaining 8 are call sites outside any member (field initialisers, static blocks). They keep
their site evidence and are deliberately not given a synthetic enclosing node.

This was worth fixing before writing any renderer. A UI built on the old edge set would have looked
correct while over-counting relationships.

### Gap 1 (missing capability) — no source text was served

The graph stored `path` and `range` but no source, so nothing could render a before/after.
`src/ingest/source.mjs` now reads both images straight out of the bare clone — no worktree needed:

- `beforeAfter` — the pair for a change unit. ADDED and REMOVED return an **explicitly absent** side
  with a reason, so "did not exist" is never rendered as "was blank".
- `callSiteExcerpt` — lines around a call site in the *calling* file, with the call line marked.
  This is the thing GitHub structurally cannot show, since the caller is usually not in the diff.
- `symbolBlocks` (task 8.1) — a file decomposed into ordered, non-overlapping member blocks plus
  synthetic blocks for the regions between them. A test asserts every non-blank line of the file is
  accounted for by some block, so no part of a file can go silently unrendered.

11 new tests, run against a real two-commit git repo rather than a stub, so retrieval is exercised
the way it runs in production.

## Reload fidelity (6b.4, 6b.5) — the cache must not quietly disagree with a fresh run

Persisting the graph exposed two ways a cached run could differ from the run that produced it.

**Lost caller lists.** Schema v1 stored callers only inside `break_json`, which exists solely for
contract-changed nodes. On `sedai-simulation-server#244` that is 11 of 22 nodes with callers, so
**half the caller lists vanished on reload** — and inline call-site excerpts (8.5) need them for
every node. Schema v2 persists node caller lists, test-coverage flags, severity, and the parsed
symbol range so before/after source is locatable without re-parsing.

**Lost disclosures — the more serious one.** The blast-radius summary was not persisted, so a
cache-served run omitted the truncation warnings. A graph *known to be incomplete* would have been
re-presented as complete. That is exactly the failure the truncation disclosure exists to prevent,
reintroduced through the cache — and invisible, because the cached run simply printed less.

Schema v3 persists the graph's own summary: blast-radius bounds, truncations, resolution health,
changed-line source, processor status. Cold and warm runs are now verified to emit identical
disclosures:

```
warm: health clean · blast radius 63 context nodes at depth ≤ 2 · d1 41 · d2 22
cold: health clean · blast radius 63 context nodes at depth ≤ 2 · d1 41 · d2 22
PARITY
```

Cache payoff, same PR: **34s cold → 1s warm**, 107 nodes and 226 edges restored intact.

Five new store tests, including a field-for-field equality assertion between a saved graph and its
reload. A caching layer that silently drops fields is worse than no cache, because the UI would
render a different graph than the CLI reported and nothing would flag the difference.

## Server and canvas (7.2, 7.3, 8.5, 8.7–8.13)

`npm run serve` reads only from SQLite, so it never starts a language server — the expensive work
happened in the CLI run and a graph keyed by head SHA is safe to reuse. Three synchronised panes:
ordered units, the blast-radius canvas, and a node facts panel with inline call-site excerpts.

The design rule carried into the UI: **anything the analysis did not establish must look
unestablished.** UNKNOWN renders as a labelled box with its reason, not as an empty section. An
absent side of a diff states why ("did not exist at the merge base") rather than showing blank. The
banner strip above everything reports degraded resolution, expansion truncation, unresolved symbols,
missing changed-line data, and stale review marks, and the server sends those disclosures inside the
same payload as the graph so a client cannot render one without the other.

### Finding F14 — TEST_COVERS edges were never drawable

Building the canvas revealed that all 54 `TEST_COVERS` edges had no caller endpoint. Only `CALLS`
edges were registered in the edge index, so only they got `from` filled in during expansion. The
edge-type filter for test coverage would have existed in the UI and done **nothing**, while the
legend implied it worked.

Fixed by keying the index on `(type, target, site)` and filling every edge kind for a resolved call
site. Undrawable edges on `sedai-simulation-server#244` fell from **62 to 8**, and the remaining 8
are call sites outside any member — reported in the legend rather than hidden.

The pattern is now familiar enough to name: three of the last four findings (F12, F13, F14) were
cases where a feature appeared to work while producing nothing or producing something wrong. Each
was caught only by checking a count against what it should have been, never by the code failing.

Server tests assert the contract that matters most: a truncated or degraded analysis is reported as
such, an unresolved PR returns `resolved: false` rather than an empty graph, and only edges with both
endpoints are served while the rest are counted.

## Finding F15 — the graph cache ignored the bounds the analysis ran under

Running the one-command flow on `sedai-simulation-server#244` with `--max-symbols 40` returned the
graph cached from an earlier `--max-symbols 20` run — **17 symbols still UNKNOWN**, silently, because
the cache was keyed on `head_sha` alone.

A graph built at `maxSymbols=20` is not an answer to a request for 40. The bounds are part of the
analysis's identity, in the same way the head SHA is: both determine what the result actually
contains. Reusing across them returns a more bounded answer than the caller asked for, and the
UNKNOWN markers make it look like a property of the code rather than of the request.

Fixed by recording `{maxSymbols, depth, base}` in the graph summary and reusing a cached graph only
when its bounds are **at least as wide** as the ones now requested; otherwise it re-resolves and says
why. Re-run at 40: 74 queries, 189 CALLS edges, **zero UNKNOWN**.

This is the fifth finding of the same shape (F12, F13, F14, F15, and the v3 disclosure loss). Every
one was a case where the tool produced a confident-looking answer that was quietly narrower or wrong,
and none surfaced as an error. The recurring lesson is that for this kind of tool, correctness
includes *the identity of the question asked* — caching, truncating, or degrading without carrying
that identity forward is indistinguishable from lying.

## UI v1 was unusable — what the screenshots showed, and the redesign

Opened on `sedai-simulation-server#244` the first UI failed in four ways at once:

1. **The graph was a hairball.** A `cose` force layout over 107 nodes produced overlapping labels
   and drifting clusters. It answered no question a reviewer has.
2. **The node panel showed “Failed to fetch”** for most nodes — a real bug, below.
3. **No indication of what changed.** The list showed truncated fully-qualified names and a bare
   number. Whether a signature moved was invisible until something was clicked.
4. **No files.** A review starts from “which files changed”, and the flat symbol list never said.

### Finding F16 — node ids contain slashes, so they can never be a URL path segment

Context node ids are of the form
`ctx:backend/src/main/java/org/sedai/controller/SessionController.java#SessionController.createSession(CreateSessionRequest)`.
The router split the path on `/` and compared segment counts, so **every context node 404'd** — which
is what "Failed to fetch" was. Moved to `?id=`, with a regression test using an id containing both
slashes and parentheses.

### The redesign

**Ego lanes instead of a global graph.** The question a reviewer asks on clicking something is "who
calls this, and what does it reach". That is a one-hop question, and a whole-PR layout is the wrong
instrument for it. Selecting a change now lays out four fixed lanes — TESTS · CALLED BY · THIS
CHANGE · CALLS — at computed positions. Nothing is simulated, so labels never collide and the
picture is *stable between selections*, which is what makes two symbols comparable. Clicking any
node re-centres. With nothing selected, a file-level overview sized by risk.

**Files first.** The left pane groups by file with per-kind counts (`+2 −3 ~6`), a broken badge, and
a reviewed fraction. Each change carries chips for its delta types, so the *kind* of change is
legible without interaction.

**A real diff.** v1 showed two raw panes of source and left the reader to spot the difference —
the one job the tool exists to do for them. Now an LCS unified diff with runs of unchanged lines
collapsed to `⋯ N unchanged lines`.

**Parameter-level signature changes.** A 16-argument constructor rendered twice in full is noise.
Long signatures now show only what moved (`+ SessionClusterResolver`, `− …`) with the full text on
hover.

Also fixed: context node FQNs were built as `name + LSP detail`, producing
`createSession(CreateSessionRequest) : ResponseEntity<…>.SessionController.createSession` once
parsed. They now use the same `Owner#name(params)` shape as change units, so every consumer parses
them uniformly.

## Finding F17 — the graph was rebuilt three times before admitting the wrong tool

The impact graph rendered tiny and stranded at the bottom of its pane. Three fixes were attempted
against the canvas library: fitting after `ready`, adding a `ResizeObserver`, then replacing
`fit()/zoom()/center()` with explicit viewport maths. Each looked correct and each failed the same
way in the browser.

Two real causes, found only from a screenshot of the settled state:

1. **The document was scrolling.** `body` was `100vh` but `main` and the panes did not contain
   overflow, so the graph container grew far taller than the window. The graph *was* centred — in a
   canvas whose middle sat below the fold.
2. **Chained viewport calls fight each other.** `fit()` frames the whole extent (a wide ego view
   shrinks to a dot), `zoom(level)` preserves pan and can push content off-screen, and `center()`
   then races the resize observer.

The third attempt fixed both and still did not behave. At that point the honest conclusion was that
an imperative viewport is the wrong instrument for this view. The lane layout has fixed positions
and a handful of nodes — it needs no zoom, pan, or fit at all.

**Replaced with hand-rolled SVG using `viewBox` + `preserveAspectRatio="xMidYMid meet"`.** The
content is always fully visible and centred in whatever space the pane has, by construction. Zoom,
pan, fit, resize handling and the observer are all deleted — roughly 60 lines of framing logic
removed, along with a 435KB dependency from the page.

Measured content for the worst case on `sedai-simulation-server#244` (10 tests, 12 callers, 2
callees): 1052×600, aspect 1.75, which scales to a legible ~0.8 in a wide top pane.

The lesson is about tool choice, not about the bug: three rounds of patching a general-purpose graph
engine cost more than writing the 80 lines of SVG the actual layout needed. A fixed-position layout
does not want a viewport.

## Layout, as requested

Two columns rather than three: modified files on the left; the right column split by a draggable
divider into the impact graph above and the change detail below. The graph gets the full width of
the right column, which is what makes the lanes legible — the previous middle column was too narrow
for four lanes at any readable scale.

## Write path (group 9)

Comments are drafted locally and submitted as one review per PR. The whole design rests on a single
rule from D8: **nothing reaches GitHub without an explicit confirmation of the exact payload.**

Three choices worth recording:

**Anchors resolve at draft time, not submit time.** GitHub can only anchor an inline comment to a
line that appears in the PR diff. Checking that when the comment is written means an unanchorable
comment fails immediately; checking it at submit time would mean losing a whole review's work to a
422. The check runs against `git diff` on both sides — RIGHT needs an added line at head, LEFT a
deleted line at base.

**A caller outside the diff is the most valuable comment the tool can produce, so it is never
refused.** Break analysis exists precisely to find call sites the PR did *not* touch — and those are
by definition outside the diff, which is exactly where GitHub cannot anchor. Such a draft becomes a
pull-request level comment with its location preserved in the body, and the reviewer is told why.
Verified on `sedai-simulation-server#244`: a draft on `SessionController.java:241` correctly fell
back with `line 241 … is not in the diff, so GitHub cannot anchor a comment there`.

Suggestions are the exception — they are refused outside the diff rather than downgraded, because a
suggestion block only means anything attached to the lines it replaces.

**`confirmed: true` is required, and its absence is a refusal.** Not a warning, not a prompt — the
submit function returns `{submitted: false}` and issues no HTTP call at all, not even the head check.
A missing flag therefore cannot post by accident. Live check against the real PR returned
`409 · not confirmed — nothing was sent`.

23 write tests against a mock that records every call. The assertions that matter:
- creating, editing, previewing and deleting drafts produce **zero** GitHub calls
- the previewed payload is `deepEqual` to what submit actually sends
- a moved head blocks submission and retains the drafts
- a rejected submit retains every draft, and a second submit posts nothing because nothing is pending
- replies to existing threads follow the same confirmation discipline
