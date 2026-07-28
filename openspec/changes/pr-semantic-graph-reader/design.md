## Context

GitHub's review UI is file-oriented and line-oriented. A reviewer receives an alphabetical list of file diffs with no indication of which change is the *cause* and which changes are its *consequences*, no view of who calls a modified method, and no cross-PR view when several PRs land in the same area. Reviewers compensate by opening the IDE alongside the browser and manually chasing call sites — which is exactly the work a language server already does mechanically.

The tool being designed reconstructs that missing structure. Its central asset is a graph whose nodes are semantic change units and whose edges are resolved code relationships. The credibility of the whole product rests on those edges being *true*, which drives the single most consequential decision below: edges come from a language server, never from heuristics or an LLM.

Constraints:
- Single reviewer, local machine, local-first. No hosted service, no shared state, no multi-tenant concerns in this change.
- Java only in this change. The model must not bake in Java assumptions that block Go later.
- Analysis requires a real checkout — resolution cannot be done from the diff text alone.
- Write operations touch a real GitHub PR that other people see; they must be explicitly confirmed.

## Goals / Non-Goals

**Goals:**
- Represent a PR as a graph of semantic change units with typed, evidence-backed edges.
- Answer, for any changed method: who calls it, what it now calls, what implements/overrides it, which tests reach it, and which call sites this PR failed to update.
- Present code as symbol blocks with cross-file call-site excerpts inline, never as a monolithic file diff.
- Let the reviewer accumulate comments across nodes and PRs and submit one review, with a confirmation step.
- Keep all language-specific work behind a versioned out-of-process plugin contract, so Go and Python are additive and require no host changes.

**Non-Goals:**
- Go, Kotlin, or any non-Java language support.
- Cross-language edges (yaml → code, proto → code, IaC → code). Cross-*repo* producer/consumer edges ARE in scope — see R6.
- LLM-generated narration, clustering, or summaries.
- Hosted/multi-user deployment, team review workflows, or a GitHub App.
- Reproducing GitHub's full review feature set (reactions, review requests, merge actions).
- Whole-repo call graphs — only change-scoped subgraphs.

## Decisions

### D1: Edges come from Eclipse JDT LS, not from tree-sitter or an LLM

Tree-sitter is used to *find* symbols and compute structural deltas; it cannot tell you that `service.process()` at line 40 resolves to `BillingServiceImpl.process`. Resolving that requires a type-aware index.

Chosen: **Eclipse JDT Language Server, driven headlessly over LSP stdio** against a real checkout of the PR head.

- `textDocument/definition` → resolve call targets
- `textDocument/references` → inbound callers
- `textDocument/implementation` + `typeHierarchy/*` → override and implement edges
- `textDocument/documentSymbol` → symbol ranges for block decomposition
- `textDocument/hover` → resolved signature for members with no source declaration (D4c)

`workspace/symbol` is **deliberately absent**: measured at a 60s timeout for a single identifier on `sedai-core`, while position-anchored requests on the same workspace returned in well under a second. All resolution is position-anchored (see D6).

Alternatives considered:
- *SCIP/LSIF index (scip-java)*: produces a queryable index without keeping a server alive, and would be faster to query. Rejected as the primary engine because generating a SCIP index still requires a successful build, and the tooling gives less control over incremental/partial-build fallback. Retained as a **future optimization** — the resolver interface is defined so a SCIP backend can be swapped in.
- *javaparser + manual symbol solving*: full control, no external process, but reimplementing Java type resolution is a large project on its own and will be wrong at the edges (generics, lambdas, annotation processors).
- *LLM inference of call relationships*: rejected outright. A graph that is 90% right is worse than no graph, because the reviewer cannot tell which 10% is fabricated.

**Consequence**: the tool needs a checkout and a JDK. This is accepted, and the cost is mitigated in D6.

### D2: Two-image analysis — the base and head are both indexed

A change unit is a *diff between two symbol states*, so the analyzer needs both. The tool creates two worktrees from a single clone: one at the PR merge-base, one at the PR head. Tree-sitter parses both to compute structural deltas. **Only the head worktree is indexed by JDT LS** — impact analysis asks "who calls this now", which is a question about head state. Base-side resolution is used only for one purpose: finding call sites that existed before and *should* have been updated but were not (D4).

### D3: The graph model

Nodes are **change units**, not files and not raw AST nodes.

```
Node {
  id            // stable: sha256(repo, fqn, kind) — survives line movement
  kind          // CLASS | INTERFACE | ENUM | METHOD | CONSTRUCTOR | FIELD | FILE
  fqn           // com.acme.billing.BillingServiceImpl#process(java.lang.String)
  file, range   // head-side location; base-side range for REMOVED
  origin        // CHANGED (in the diff) | CONTEXT (pulled in as blast radius)
  changeKind    // ADDED | REMOVED | MODIFIED | MOVED | RENAMED | UNCHANGED
  deltas[]      // SIGNATURE | VISIBILITY | ANNOTATION | BODY | THROWS | MODIFIER
  prIds[]       // which PR(s) touched it — enables cross-PR overlap
  risk          // computed, see D5
  derivedFrom   // SOURCE | GENERATED (D4c: synthesised from annotations)
}
```

Edges are typed and every edge carries **evidence** — a concrete `file:line` the reviewer can click through to. An edge with no evidence is a bug.

```
Edge {
  from, to, type, evidence[] {file, line, snippet}, derivedFrom  // LSP | AST | GIT_HISTORY | NAME_MATCH
}
```

Edge types in this change: `CALLS`, `OVERRIDES`, `IMPLEMENTS`, `EXTENDS`, `CONSTRUCTS`, `READS_FIELD`, `WRITES_FIELD`, `THROWS_TO`, `TEST_COVERS`, `CO_CHANGED`, `CROSS_REPO_PROVIDES` (R6).

`CO_CHANGED` is the one statistical edge, derived from `git log` co-occurrence over the last N commits. It is visually distinguished from resolved edges precisely because it is a correlation, not a fact — it catches coupling static analysis misses (a constant and its consumer, a serializer and its schema) without being presented as ground truth.

`TEST_COVERS` is derived structurally (a test-source method transitively reaching the target within the blast radius), not from a coverage run. This is stated in the spec as an approximation.

**Blast radius**: default depth 2 from any `CHANGED` node, expandable per node on demand. Depth is capped and node-count-capped because depth 3 on a service-layer method with high fan-in produces thousands of nodes and a hairball the reviewer cannot use. When a cap truncates expansion the UI says so explicitly — silent truncation would read as "nothing else is affected", which is the most dangerous possible lie for a review tool.

### D4: Break analysis — the feature that justifies the graph

For every `MODIFIED` method with a `SIGNATURE` delta, the analyzer classifies each inbound call site:

| Verdict | Condition |
|---|---|
| `UPDATED` | Call site is itself inside the PR diff and matches the new signature |
| `BROKEN` | Call site is not in the diff and does not match the new signature |
| `SAFE` | Call site is compatible with the new signature (e.g. widened param, added overload) |

`BROKEN` is the highest-value output of the entire tool and the primary driver of node risk. The same classification applies to visibility reductions, removed methods, added checked exceptions, and removed annotations that alter behavior (`@Transactional`, `@Nullable`).

### D4b: Override fan-in must not use raw reference counts

Measured on `google/gson#3067`: five distinct anonymous `TypeAdapter` subclasses each reported **exactly 42 callers, and identical callers** — the call sites of the base `TypeAdapter.read(JsonReader)`, not of each override.

This is correct LSP behaviour; a call through a supertype reference is not statically attributable to one override. It is nevertheless wrong for our purposes, and it means the risk formula in D5 is **defective if fan-in is taken from a raw `references` count**: every override of a hot interface would score maximum risk.

Resolution, entirely in the graph layer — no tooling change, since `references` is behaving correctly:

- When a node has an `OVERRIDES` or `IMPLEMENTS` edge, its inbound reference set is attributed to the **supertype declaration**, not to the override.
- Risk uses that fan-in but marks it **indirect**, so it cannot alone drive a node to maximum risk.
- The UI states the situation rather than implying precision: *"42 callers of `TypeAdapter.read`; dispatch to this implementation is not statically determined."*
- **Break analysis is unaffected and uses the full set** — a signature change on an override genuinely does affect every one of those call sites.

Precise per-override dispatch attribution requires binding information `references` does not expose, and is Tier 2 work — now with measured justification rather than speculation.

### D4c: Generated members are synthesised nodes, not missing nodes

Attaching the Lombok agent fixes *resolution* but not *enumeration*: `documentSymbol` reports only source-declared members. Measured consequence — `ExtendSessionRequest.java`, the DTO added by `sedai-models#4897`, reports **zero methods**, because all of its members are Lombok-generated. The graph would render an empty node for the very change under review.

A direct test settled how severe this is. On a real call site of a generated accessor in `sedai-core` (`request.isAggressive()` at `SimulationServer.java:748`):

- `textDocument/definition` **resolves**, to the backing `aggressive` field at `CoreProfilingConfigDto.java:24`
- `textDocument/hover` **resolves**, to `boolean …CoreProfilingConfigDto.isAggressive()` with its javadoc

So edges *into* generated accessors are formable with genuine evidence. This is a **node-synthesis problem, not an edge-loss problem** — materially cheaper than the Tier 2 work first assumed:

> For an annotated type, Tier 1 synthesises member nodes from the fields plus class/field annotations — `@Getter` → `getX()`/`isX()`, `@Setter` → `setX()`, `@Builder` → `builder()`, `@AllArgsConstructor` → the constructor — each anchored to the backing field's range, which is exactly where `definition` points.

Synthesised nodes carry `derivedFrom: GENERATED` so a reviewer is never shown generated code as if it were hand-written, and so a comment is never anchored to a line the author did not write.

### D5: Risk score and review order

Score is a transparent weighted sum, shown to the reviewer as its components rather than a bare number — an opaque score is not actionable.

```
risk = 30·has_broken_callsites
     + 20·is_public_api_change
     + 15·normalize(inbound_fanin)      // indirect for overrides — see D4b, never alone maximal
     + 15·no_test_covers
     + 10·normalize(body_churn)
     // historical_bug_density deferred behind a per-repo flag — see R3
```

Review order is **topological over `CALLS` edges** — entry points and interfaces first, leaves last — so the reviewer reads cause before effect. Cycles are broken by descending risk. The reviewer can override to risk order. Per-node reviewed state persists so a review can be resumed.

**Noise suppression**, on by default and always disclosed with a count: import-only changes, formatting/whitespace-only bodies, generated files (path patterns plus `@Generated`), and `MODIFIED` nodes whose only delta is a comment or javadoc.

### D6: Analysis pipeline and caching

```
PR URLs
  → ingest        GitHub API: metadata, files, diff, threads     [cache: pr_id+head_sha]
  → checkout      clone/fetch once per repo; worktrees @base @head
  → parse         tree-sitter Java → symbol table + change units [cache: blob sha]
  → index         JDT LS init + workspace index @head            [cache: head_sha]
  → resolve       LSP queries per changed symbol → edges         [cache: head_sha+fqn]
  → enrich        break analysis, co-change, tests, risk
  → persist       SQLite graph store
  → serve         local HTTP + web UI
```

Every stage is content-addressed and resumable, and each cached artifact is governed by the retention policy in R4.

**Measured cost model (revised — see `FINDINGS.md`).** The original assumption that indexing dominates is **wrong on a developer machine**. Against four real PRs across `sedai-simulation-server`, `sedai-tests`, `sedai-models`, and `sedai-core`, with a warm `~/.m2`, JDT LS reached `ServiceReady` in **2–9 seconds**, including a genuine multi-module Maven import on `sedai-core`. The real costs are:

| Cost | Measured | Consequence |
|---|---|---|
| Initial clone | 143s for `sedai-core` (bare, blobless) | One-off per repo; justifies R4's never-evict-clones rule |
| `references` latency | ~11s/symbol on `sedai-core` vs ~0.4s on `sedai-simulation-server` | **The dominant cost.** Scales with workspace size, not index age |
| `workspace/symbol` | **timed out at 60s** on `sedai-core` | Unusable at monorepo scale; excluded from the contract |
| Index to ready | 2–9s warm `~/.m2`; 56s cold (dependency download) | Not the bottleneck |

So lazy resolution remains correct, but for a different reason: **query latency, not index time**. Blast-radius expansion is therefore budgeted against a **query budget** (a cap on outstanding resolution requests) rather than only a node count, and the depth-2 cap in D3 is generous rather than conservative on a monorepo. Index-progress streaming is de-prioritised accordingly.

The corollary is a hard constraint on the resolver: **position-anchored requests only** (`definition`, `references`, `hover`, `documentSymbol`, `implementation`, `typeHierarchy`). Workspace-wide queries are excluded from the plugin contract entirely.

Build failures are expected and handled: if the project does not fully compile, JDT LS still resolves what it can. Unresolvable references become explicit `UNRESOLVED` markers on the node — never silently dropped edges.

**Project root detection is mandatory.** Two of the four measured repos build from a subdirectory (`backend`, `integration`) with no `pom.xml` at the repo root. Initialising JDT LS on the repo root causes it to silently skip the Maven import and report ready in ~2s having resolved nothing external — the probe's first run produced entirely misleading numbers this way. The build root is detected from the changed files' nearest ancestor build file. The signature "ready in a few seconds **and** a high unresolved count" is treated as a **hard error**, not a warning, because it is the fingerprint of exactly this misconfiguration.

**Annotation processors must be attached, asserted, or refused.** JDT LS does not run annotation processors unless the agent is attached to the server JVM. Without `-javaagent:<lombok.jar>`, every Lombok-generated accessor is invisible to resolution — and invisibly so. Measured impact across the four repos: **393 phantom "method is undefined" errors, 100% of `sedai-core`'s**. Attaching the agent, with the version read from the project's own build files and matched against `~/.m2`, reduced totals from 528→2 and 43→0, leaving only the genuine cross-repo dependency of R6. Version matching is load-bearing: `sedai-core` declares `1.18.42` and a mismatched newer agent silently no-ops.

The rule generalises to any processor (MapStruct, AutoValue, immutables): **detect it, attach it, assert it resolves, or refuse to analyse.** A silent partial graph is the one outcome the design must never produce, so a failed assertion is fatal rather than a warning.

### D7: Code display model

This is a deliberate departure from GitHub's file-pane rendering. The reviewer selects a *node*, not a file.

**Symbol-block decomposition.** Each changed file is split by `documentSymbol` ranges into blocks. A file diff is therefore presented as an ordered list of symbol blocks, each labeled with its change kind, rather than one continuous diff. Hunks that fall outside any symbol (imports, package decl, class-level fields) become synthetic blocks.

**The node detail view has four regions:**

1. **Before/After for the selected symbol only.** Split view by default, unified toggle. Word-level intra-line highlighting. The surrounding file is collapsed to a one-line stub above and below (`▸ 3 unchanged methods`) that expands in place — so the reviewer can always reach full file context without leaving the node.
2. **Call sites, inlined.** For each inbound `CALLS` edge, a 5-line excerpt from the *calling* file rendered directly in the node view, tagged `UPDATED` / `BROKEN` / `SAFE`. This is the thing GitHub cannot do: seeing the caller's code without opening another tab.
3. **Callees added/removed** — what this symbol now calls that it did not before, each expandable into the callee's own node.
4. **Facts panel** — signature delta, annotation delta, visibility delta, `TEST_COVERS` list, risk components, and which PRs touch this node.

**Three view modes**, switchable, sharing one selection state:
- *Graph* — the node/edge canvas, the default entry point.
- *Ordered list* — nodes in topological or risk order; a linear "work the queue" mode, which is how most reviews will actually be driven.
- *File* — a conventional file tree with per-file blocks, as an escape hatch for reviewers who want the familiar shape.

Selecting a node in any mode selects it in all three.

### D8: Write path

Comments are drafted against a **node**, and resolved to a GitHub anchor (`path`, `line`/`start_line`, `side`, `commit_id = head_sha`) at draft time, so an anchor that can no longer be resolved fails loudly at draft time rather than at submit time. Drafts live in SQLite; nothing is sent to GitHub until submit.

Submit assembles one `POST /pulls/{n}/reviews` per PR with all draft comments and an event of `COMMENT` / `APPROVE` / `REQUEST_CHANGES`. The confirmation step renders the **exact payload** — every comment body, its file and line, and the event type — and requires explicit approval. If the PR head has advanced since ingestion, submission is blocked and the reviewer is prompted to re-ingest, because posting to a stale SHA silently misplaces comments.

### D9: Two-tier language plugin contract (so Go and Python are additive)

The language boundary is a **process contract**, not an in-process interface. Each language is analyzed by a separate plugin process, written in whatever language analyzes that language best, speaking JSON-RPC over stdio to a language-agnostic host.

```
Host (graph model, risk, ordering, UI, GitHub write path, plugin orchestration)
   │  JSON-RPC over stdio — one versioned contract
   ├── Tier 1: stock language server    jdtls | gopls | pyright     (upstream-maintained)
   └── Tier 2: optional native sidecar  Java | Go | Python          (ours, only when Tier 1 falls short)
```

**Why a process boundary rather than a library interface.** LSP is already this architecture: `jdtls` is written in Java, `gopls` in Go, `pyright` in TypeScript. Adopting the process boundary means the host never needs to understand any language's type system, and the deepest, best-maintained analysis for each language comes from upstream for free. It also removes the host language from the quality equation entirely — choosing a non-JVM host costs nothing in Java analysis fidelity, because Java analysis happens in a Java process either way.

**The contract**, identical for both tiers:

```
capabilities()                          -> supported extensions, edge types, tier
parseSymbols(file, image)               -> SymbolTable
diffSymbols(baseTable, headTable)       -> ChangeUnit[]      // incl. rename/move detection
resolveEdges(symbol, depth)             -> Edge[]            // every edge carries evidence
signatureCompatibility(before, after,
                       callSite)        -> UPDATED | BROKEN | SAFE
isTestSource(path)                      -> boolean
isPublicApi(symbol)                     -> boolean
```

**Tier 1** is the default and the only tier built in this change for Java. It is a thin adapter that maps the contract onto stock LSP requests (`documentSymbol`, `definition`, `references`, `implementation`, `typeHierarchy`) plus tree-sitter for structural diffing. A new language starts here and ships in days.

**Tier 2** exists because LSP is designed for editors and cannot answer everything the graph wants: the `READS_FIELD` / `WRITES_FIELD` distinction, annotation semantics (that `@Transactional` was removed and what transaction boundary that changed), and language-specific signature-compatibility rules all need full AST and binding access. When Tier 1 proves insufficient for a language, a native sidecar is added for that language — JDT or javaparser for Java, `go/packages` for Go, `ast` for Python — answering the *same* contract. The host does not change.

`capabilities()` is what makes the tiers interchangeable: a plugin declares which edge types it can produce, and the host degrades explicitly for the rest rather than silently emitting an incomplete graph. A Tier 1 Java plugin that cannot distinguish field reads from writes says so, and the UI reports that edge type as unavailable rather than absent.

**Conformance suite.** N implementations of one contract drift. Every plugin, at either tier, must pass a shared conformance suite run against a per-language fixture corpus covering each change kind, each delta type, rename/move, and each break classification. The contract is versioned; a plugin declares the contract version it implements and the host refuses to load a mismatched one.

**Recordability.** Every plugin request and response can be dumped to fixtures, so a wrong edge is reproducible and debuggable in the host without the sidecar or the analyzed repository present. This is the mitigation for cross-process debugging cost.

**Accepted costs**: the reviewer needs the real toolchain for each analyzed language (a JDK for Java PRs, Go for Go PRs) — unavoidable, since static analysis needs it; the host performs a per-language preflight check and reports what is missing. Symbols cross a process boundary as JSON, mitigated by request batching and the existing `head_sha` caching.

**Scope in this change**: the contract, the host-side plugin orchestrator, the conformance suite, and one Tier 1 Java plugin. Go, Python, and all Tier 2 sidecars are out of scope and require no host changes.

### D10: Stack

**Host in TypeScript/Node.** It owns the graph model, storage, risk engine, ordering, plugin orchestration, the local HTTP API, and the GitHub write path — everything language-agnostic. TypeScript because the host shares its language with the UI, so the graph and edge model is defined exactly once and crosses to the browser without a schema-generation step; and because the JSON-RPC/LSP client tooling is mature there. Under D9 this choice carries no analysis-quality cost: Java semantics are resolved by a Java process regardless of the host.

**Plugins in the language they analyze.** Tier 1 Java is `jdtls` plus a thin adapter; any future Tier 2 sidecar is written in its own language with its own native tooling.

**Storage**: SQLite via `better-sqlite3` for the graph, drafts, and reviewed state.

**UI**: React, with a WebGL/canvas graph renderer (Cytoscape.js or Sigma.js) — SVG renderers degrade past a few hundred nodes, and the node cap is above that. Monaco diff editor per symbol block, which provides syntax highlighting and intra-line diffs directly.

## Risks / Trade-offs

- **JDT LS index time on large repos (minutes, first run)** → Content-addressed cache keyed by `head_sha`; warm server pool per session; lazy resolution beyond depth 2; a progress UI that lets the reviewer start on already-resolved nodes while indexing continues.
- **Repo does not compile (missing deps, wrong JDK, generated sources absent)** → Degrade explicitly, never silently. Partial index still yields most edges; unresolvable references surface as `UNRESOLVED` markers with the JDT diagnostic attached. Detect the required JDK from the build files and warn on mismatch.
- **Graph becomes an unreadable hairball** → Hard depth cap (2) and node cap, with truncation always disclosed; noise suppression on by default; the ordered-list mode as the primary driving surface, with the graph as the orientation view rather than the only view.
- **Reviewer trusts a wrong edge** → Every edge carries clickable evidence; `CO_CHANGED` is visually and semantically separated from resolved edges; `TEST_COVERS` is documented as a structural approximation, not measured coverage.
- **Posting comments to a stale commit** → Anchors bound to `head_sha` at draft time; submission blocked if the PR head has moved; confirmation renders the exact payload before any write.
- **GitHub API rate limits across multi-PR ingestion** → GraphQL for batched metadata, conditional requests with ETags, aggressive local caching; surface remaining quota in the UI.
- **Rename/move detection is heuristic** → Body-similarity plus signature matching above a threshold; when confidence is low, present as separate `ADDED` + `REMOVED` nodes with a suggested-link affordance rather than asserting a false `MOVED`.
- **Plugin contract drift across languages/tiers** → One shared conformance suite every plugin must pass against a per-language fixture corpus; a versioned contract that the host refuses to load on mismatch; `capabilities()` so a plugin's gaps are declared rather than discovered.
- **Cross-process debugging of a wrong edge** → Plugin requests and responses are recordable to fixtures, making a bad edge reproducible in the host without the sidecar or the analyzed repository.
- **Missing toolchain for an analyzed language** → Per-language preflight check that names exactly what is missing before analysis starts, rather than degrading mid-run.
- **Scope**: this design deliberately excludes the LLM narration layer that would make the tool feel "smart". That is the right order — a trustworthy graph is the prerequisite, and narration grounded on a wrong graph is worse than no narration.

## Migration Plan

Greenfield application; no migration. Rollout is by phase (see `tasks.md`), each phase independently usable:
1. Ingest + Java change units + ordered list view (no graph) — already useful, proves extraction.
2. JDT LS resolution + graph + blast radius.
3. Node detail view with inlined call sites + break analysis.
4. Review write path.
5. Multi-PR merge and overlap detection.

Rollback at any phase is discarding the local cache directory.

## Resolved Decisions

### R6: Cross-repo producer/consumer edges via unresolved-import correlation

**This reverses a non-goal, on evidence.** The four PRs used to validate the design are *one logical change* — `SM-1182` — split across four repositories. That is not an edge case; it is how changes in this workspace normally exist.

After the Lombok fix, the *only* remaining unresolved reference across all four repos was `sedai-simulation-server` importing `org.sedai.models.simulation.session.ExtendSessionRequest` — a class **added by `sedai-models#4897`**, one of the other three PRs. The published `sedai-models` artifact on the classpath predates the change, so the type genuinely does not exist; no amount of JDT LS configuration fixes it.

The consequence is that **the single most important relationship in the change set was invisible**: nothing connected the consumer in one PR to the producer in another. The original design merged PRs within one repo and detected overlapping symbols, and explicitly excluded cross-repo edges. That exclusion is wrong for the primary use case.

**Chosen mechanism — textual correlation, no cross-repo classpath:**

1. Each plugin reports two sets per PR: **unresolved imports** (FQNs the language server could not resolve) and **added top-level types** (FQNs of `ADDED` class/interface/enum/record change units).
2. Across the whole ingested PR set, the host matches them: an unresolved import in PR A equal to a type added by PR B yields a `CROSS_REPO_PROVIDES` edge from B's node to A's node.
3. Evidence is the import statement in A and the declaration in B — both real `file:line`, satisfying the no-edge-without-evidence rule.

On `SM-1182` this fires immediately and would have surfaced the producer/consumer link with no classpath work at all.

Two constraints keep it honest. It is derived from name matching, so it is tagged `derivedFrom: NAME_MATCH` and rendered distinctly from resolved edges, as `CO_CHANGED` is. And once such an edge fires, the unresolved-import errors it explains are **reclassified out of the resolution-health denominator** — they are a known cross-repo dependency, not a broken classpath. Without that, health reads DEGRADED on every multi-repo change, and a metric that is permanently red gets ignored.

Alternatives considered: *sibling-source classpath injection* (point the language server at the sibling repo's changed sources, so real `CALLS` edges form) is stronger but needs the sibling worktree on the classpath and a resolution re-run; *full multi-repo workspace* is stronger still and much more expensive. Name matching captures the relationship that was missing, which was the actual failure. The other two remain available as later increments.

### R1: Per-PR graph by default, with unmissable overlap disclosure

Each PR gets its own graph. Merging N PRs into one canvas inflates node count and makes topological ordering ambiguous, since independent PRs have no single causal order. Overlap is surfaced instead as a persistent banner on every affected PR ("3 symbols also changed by PR #102"), so the reviewer learns about a conflict without opting in; the merged view remains available for exploring one.

### R2: Dependency-resolution-only build, with a visible resolution-health metric

The tool attempts `mvn dependency:resolve` or the Gradle equivalent before indexing, warns and continues on failure. A full build is often impossible (missing credentials, code generation, profiles) and requiring a pre-built repo adds a manual prerequisite.

The failure mode this must not have is silence: without resolved dependencies JDT LS produces a *sparser but plausible-looking* graph, which is worse than an obviously broken one. So the host computes and prominently displays a **resolution-health metric** — the percentage of references in changed files that resolved. Below a configured threshold the UI states that the graph is degraded and why. This converts a silent quality loss into a visible one.

### R3: Historical defect density deferred out of the risk score

The risk score ships with five components: broken call sites, public-API contract change, inbound fan-in, absence of structural test coverage, and body churn — all derived from the change itself. Defect density is the weakest and most repo-dependent signal: it requires a consistent commit convention linking issue keys and a way to separate bugfix from feature commits. Where that convention is inconsistent it contributes noise while appearing authoritative. It is deferred behind a config flag, to be enabled per repository once the commit history is confirmed to support it.

### R4: TTL plus size cap, split by artifact class

A single LRU pool over all cached artifacts is wrong, because the artifacts have very different rebuild costs. Anything keyed by a commit SHA is content-addressed and can never go stale, so a TTL on it is pure waste; TTL belongs only on mutable or bulky artifacts.

| Artifact | Policy | Rationale |
|---|---|---|
| Clone (per repo) | No TTL; explicit prune only | Re-cloning is the most expensive loss |
| Worktree (per SHA) | TTL 7d + LRU under a size cap | Cheap to recreate from the clone |
| Language-server index (per SHA) | TTL 7d + LRU under a size cap | Minutes to rebuild, large on disk |
| GitHub API payloads | TTL 24h, revalidated by head SHA | Small; correctness already bounded by SHA |
| Resolution results | No TTL — keyed by `head_sha` | Immutable for a given SHA |
| Drafts and reviewed state | Never evicted | Reviewer-authored data |

Note that an in-heap cache library is not the right instrument here: what is being evicted is multi-gigabyte on-disk state, so eviction is a policy over a disk manifest, not over cached objects.

## Open Questions

None outstanding. R1–R4 above resolve the questions raised during design review.
