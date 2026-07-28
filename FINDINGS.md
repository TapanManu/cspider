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
