## 1. Project Setup

- [ ] 1.1 Create the application repository skeleton: TypeScript monorepo with `host` (graph, risk, orchestration), `contract` (plugin contract types + conformance suite), `server` (local HTTP API), `ui` (React), and `plugins/java` packages
- [ ] 1.2 Add dependencies: `better-sqlite3`, a JSON-RPC/LSP client library, `octokit`, React, Monaco editor, and a canvas graph renderer
- [ ] 1.3 Define the SQLite schema for prs, change_units, nodes, edges, evidence, drafts, and reviewed_state, with migrations
- [ ] 1.4 Implement the local cache directory layout and the R4 retention policy: clones pruned only explicitly; worktrees and indexes on TTL plus LRU under a size cap; API payloads on a short TTL; SHA-keyed results never time-expired; drafts and reviewed state never evicted
- [ ] 1.5 Implement the explicit prune command that reports what will be removed and the space reclaimed before removing it
- [ ] 1.6 Add the CLI entry point that accepts PR URLs, runs the pipeline, and serves the local UI
- [ ] 1.7 Set up GitHub token loading from environment or a local config file, with a startup validation check

## 2. PR Ingestion

- [x] 2.1 Implement the GitHub client: PR metadata, changed files, unified diff, commits, review threads, and CI status
- [ ] 2.2 Batch multi-PR metadata retrieval via GraphQL and add ETag-based conditional requests
- [x] 2.3 Implement the ingestion cache keyed by `pr_id + head_sha`, with head-SHA revalidation and invalidation on advance
- [x] 2.4 Implement per-PR failure isolation so one bad URL or permission error does not abort the batch
- [x] 2.5 Implement repository checkout: bare blobless clone once per repo, fetch refs thereafter, create worktrees at merge-base and head
- [x] 2.5a Implement build-root detection from the changed files' nearest ancestor build file, with multi-root reporting of uncovered modules (F4)
- [ ] 2.5b Implement the misconfiguration guard: fast readiness plus high unresolved count is a fatal build-root error, not a degraded graph (F4)
- [x] 2.5c Derive changed lines from git on BOTH diff sides; treat GitHub `patch` as fallback only, and never mix base-side line numbers with head-side ones (A3)
- [ ] 2.6 Implement rate-limit tracking, threshold warning, and graceful halt with a report of un-ingested PRs
- [ ] 2.7 Write ingestion tests using recorded GitHub API fixtures

## 3. Language Plugin Contract and Host Orchestrator

- [ ] 3.1 Define the versioned JSON-RPC plugin contract — `capabilities`, `parseSymbols`, `diffSymbols`, `resolveEdges`, `signatureCompatibility`, `isTestSource`, `isPublicApi` — with shared type definitions in the `contract` package
- [ ] 3.2 Implement the host-side plugin orchestrator: process spawn, stdio JSON-RPC transport, lifecycle management, request batching, and crash-restart with one retry
- [ ] 3.3 Implement plugin registration and contract-version negotiation, refusing to load a plugin whose declared version is unsupported and reporting both versions
- [ ] 3.4 Implement capability declaration handling so undeclared edge types are reported as unavailable rather than absent, surfaced through to the UI
- [ ] 3.5 Implement per-language toolchain preflight naming the missing toolchain and required version before analysis starts, plus partial analysis when only some languages are supported
- [ ] 3.6 Implement unhandled-extension handling: mark such files unanalyzed and report which languages are unsupported for this analysis
- [ ] 3.7 Implement plugin request/response recording to fixtures, and host-side replay without the plugin process or the analyzed repository present
- [ ] 3.8 Build the shared conformance suite driven by a per-language fixture corpus, covering every change kind, delta type, rename/move, and break classification, reporting expected versus actual contract responses on failure
- [ ] 3.9 Verify the host contains no language-specific logic via a static check of the `host` package against a forbidden-import list

## 4. Java Plugin (Tier 1) — Semantic Diff

- [ ] 4.1 Scaffold the Tier 1 Java plugin as a separate process implementing the contract over `jdtls` plus tree-sitter, declaring its capabilities and contract version
- [x] 4.2 Implement the tree-sitter Java symbol parser producing FQN, range, signature, visibility, modifiers, annotations, and throws for every type and member
- [x] 4.3 Implement parse-failure handling that records the error location and excludes the file without aborting the run
- [x] 4.4 Implement base-versus-head symbol diffing producing ADDED, REMOVED, MODIFIED, and UNCHANGED change units
- [x] 4.5 Implement typed delta extraction — SIGNATURE, VISIBILITY, ANNOTATION, MODIFIER, THROWS, BODY — each with before and after values
- [x] 4.6 Implement rename and move detection via body-similarity plus signature matching, with a confidence threshold and a low-confidence suggested-link fallback
- [ ] 4.7 Implement synthetic change units for hunks outside any symbol range, and FILE-kind units for unanalyzed file types
- [x] 4.8 Implement stable change-unit identity from repo, FQN, and kind, and verify it is invariant to line movement
- [x] 4.9 Implement the Java `signatureCompatibility` rules covering parameter changes, visibility reduction, removal, checked exceptions, and overload addition
- [x] 4.10 Implement the Java `isTestSource` and `isPublicApi` predicates
- [x] 4.6a Pair parameter-list changes into a single MODIFIED unit with a SIGNATURE delta, leaving ambiguous overload sets unpaired (F10)
- [x] 4.2a Size the tree-sitter read buffer to the source; assert a non-trivial file never yields zero symbols (F8 — silent data loss above 32KB)
- [x] 4.4a Derive a type's identity from its own declaration only, so a member change does not mark the enclosing type MODIFIED (F9)
- [x] 4.2b Assert parser completeness: a file declaring a type that yields zero symbols is a hard failure (A4)
- [ ] 4.11 Build the Java fixture corpus covering each delta type, rename, move, generics, lambdas, records, and inner classes, and pass the conformance suite against it

## 5. Java Plugin (Tier 1) — Symbol Resolution

- [x] 5.1 Implement the JDT LS launcher: locate or download the distribution, start it headless over stdio, and send `initialize` against the head worktree
- [x] 5.2 Implement index-progress tracking and a readiness signal propagated to the host and UI
- [x] 5.3 Implement the server pool keyed by `repo + head_sha`, with reuse within a session and crash-restart with one retry
- [ ] 5.4 Detect the repository's required JDK from its build files and warn on mismatch before indexing
- [x] 5.4a Detect annotation-processor usage, attach the processor agent at the version declared by the project's build files, and refuse to analyze when no matching jar is found (F5a — BLOCKING for graph trustworthiness)
- [x] 5.4b Implement the post-index assertion that a known generated member resolves, treating failure as fatal (F5a)
- [ ] 5.4c Synthesise member nodes for generated members from fields plus annotations, anchored to the backing field range and marked `derivedFrom: GENERATED` (F5b)
- [x] 5.4d Resolve REMOVED members against a base-image index; without one they are UNKNOWN, never SAFE (A1)
- [ ] 5.5 Attempt a dependency-resolution-only build (Maven/Gradle) before indexing, warning and continuing on failure
- [x] 5.6 Implement the resolution queries: definition, references, implementation, type hierarchy, document symbol, and hover — position-anchored only, with no workspace-wide symbol query (F7)
- [ ] 5.7 Map query results into typed edges with mandatory evidence records, discarding evidence-less edges and logging each omission
- [ ] 5.8 Implement unresolved-reference markers carrying the JDT diagnostic, and external unresolved nodes for sourceless dependencies
- [x] 5.9 Implement the resolution-health metric — percentage of references in changed files that resolved — and the degraded-graph declaration below a configured threshold
- [ ] 5.10 Implement resolution caching keyed by `head_sha` plus symbol identity, reused across sessions and never time-expired
- [x] 5.11 Implement eager depth-1 resolution with lazy on-demand resolution for deeper expansion, budgeted against outstanding resolution requests rather than node count (Q1: ~11s/symbol on sedai-core)
- [ ] 5.12 Write resolution tests against a small multi-module Java fixture repository, including a deliberately non-compiling variant asserting unresolved markers and a degraded health reading

## 6. Graph Model and Enrichment

- [x] 6.1 Implement the node and edge model with origin, change kind, deltas, PR ids, and edge derivation source
- [x] 6.2 Implement graph construction from change units plus resolved edges, ensuring isolated changed nodes are retained
- [x] 6.3 Implement blast-radius expansion with a depth cap of 2, a node cap, and explicit truncation records per node
- [x] 6.4 Implement per-node manual expansion that triggers lazy resolution
- [x] 6.5 Implement break analysis classifying inbound call sites as UPDATED, BROKEN, or SAFE, delegating language-specific rules to the plugin
- [x] 6.5a Implement indirect fan-in for overriding members: attribute references to the supertype declaration, mark indirect, and prevent it alone from maximising risk (F1)
- [x] 6.5b Implement cross-repo provider correlation emitting CROSS_REPO_PROVIDES from unresolved-import to added-type matches across the ingested PR set, tagged NAME_MATCH (F6)
- [x] 6.5d Report UNKNOWN with a stated reason for every symbol not analysed — cap, budget, failed query, ambiguous overload, missing changed-line data (A2)
- [x] 6.5c Exclude cross-repo-explained unresolved imports from the resolution-health denominator (F6)
- [x] 6.6 Implement CO_CHANGED derivation from git history with a co-occurrence threshold, minimum sample size, and recorded ratio
- [x] 6.7 Implement structural TEST_COVERS derivation from test-source symbols reaching changed symbols within the blast radius
- [x] 6.8 Implement the risk scorer with the five default change-derived components and per-component contributions exposed
- [x] 6.9 Implement historical defect density as an opt-in per-repository scoring component, disabled by default
- [x] 6.10 Implement topological review ordering over CALLS edges with cycles broken by descending risk, plus a risk-order alternative
- [ ] 6.11 Implement reviewed-state persistence with retention across head advances for content-unchanged nodes
- [x] 6.12 Implement noise suppression for import-only, formatting-only, comment-only, and generated files, always reporting the suppressed count
- [ ] 6.13 Implement per-PR graph scoping with unconditional overlap disclosure on every affected PR, plus the opt-in merged view with cross-PR node merging and single-PR filtering
- [x] 6.14 Write graph tests covering bounds, truncation disclosure, break classification, and ordering determinism

## 7. Local Server API

- [ ] 7.1 Implement the analysis pipeline orchestrator with resumable, content-addressed stages
- [ ] 7.2 Expose read endpoints for graph, node detail, symbol source blocks, call-site excerpts, resolution health, and analysis status
- [ ] 7.3 Expose expansion, filtering, ordering, and reviewed-state endpoints
- [ ] 7.4 Expose draft CRUD and submission endpoints
- [ ] 7.5 Implement progress streaming so the UI can start on resolved nodes while indexing continues

## 8. Code View UI

- [ ] 8.1 Implement symbol-block decomposition of changed files from document-symbol ranges, including synthetic blocks for non-symbol hunks
- [ ] 8.2 Implement the node detail before/after view with Monaco per block, split and unified toggle, and intra-line highlighting
- [ ] 8.3 Implement ADDED and REMOVED node rendering with the correct empty-side treatment
- [ ] 8.4 Implement collapsed expandable context stubs above and below the selected symbol, plus a full-file view with a return path
- [ ] 8.5 Implement inline call-site excerpts with UPDATED/BROKEN/SAFE tags and navigation to the calling node with back-navigation
- [ ] 8.6 Implement the callee delta list with expansion into callee nodes
- [ ] 8.7 Implement the facts panel: deltas, test coverage, risk components, PR ids, and unresolved references
- [ ] 8.8 Implement the graph view with visual encoding of change kind, origin, risk, reviewed state, PR color, and truncation counts
- [ ] 8.9 Implement the ordered-list view with reviewed marking and progress count
- [ ] 8.10 Implement the file-tree view with per-file blocks
- [ ] 8.11 Implement shared selection state and synchronization across all three views
- [ ] 8.12 Implement edge-type filtering with visual distinction for CO_CHANGED and other non-resolved edges
- [ ] 8.13 Implement the resolution-health indicator, the degraded-graph banner, the unavailable-edge-type notice, and the cross-PR overlap banner

## 9. Review Write Path

- [ ] 9.1 Implement draft creation from a node or call-site excerpt with anchor resolution at draft time
- [ ] 9.2 Implement draft-time anchor rejection with a stated reason when the location is not commentable
- [ ] 9.3 Implement the PR-level comment fallback for locations outside the diff
- [ ] 9.4 Implement suggestion-block drafting for single-line and multi-line ranges
- [ ] 9.5 Implement local draft persistence and restoration across restarts, with no GitHub writes during drafting
- [ ] 9.6 Implement batch review assembly, one review per PR, with COMMENT, APPROVE, and REQUEST_CHANGES events
- [ ] 9.7 Implement shared-body comments applied across multiple PRs with per-PR anchors
- [ ] 9.8 Implement the confirmation step rendering the exact payload and requiring explicit approval
- [ ] 9.9 Implement the pre-submission stale-head check that blocks submission and prompts re-ingestion
- [ ] 9.10 Implement submission outcome reporting, per-PR partial-failure handling, and retention of failed drafts
- [ ] 9.11 Implement existing-thread display on matching nodes, replies, and thread resolution through the same confirmation flow
- [ ] 9.12 Write write-path tests against a mocked GitHub API asserting no writes occur before confirmation

## 10. Validation and Hardening

- [ ] 10.1 Run the full pipeline against a real large Java PR and record index time, resolution time, node count, memory, and resolution health
- [x] 10.2 Validate break analysis against a PR with a known unupdated call site and confirm it is classified BROKEN
- [ ] 10.3 Validate degraded operation against a repository that does not fully compile, confirming unresolved markers and a visible degraded-graph declaration rather than dropped edges
- [ ] 10.4 Validate graph legibility and interactivity at the node cap
- [ ] 10.5 Validate the cross-PR overlap path against two PRs touching the same method, in both per-PR and merged views
- [ ] 10.6 Prove the plugin contract holds by implementing a stub second-language plugin that passes the conformance suite with no host changes
- [ ] 10.7 Validate against the four SM-1182 PRs: assert zero unresolved-symbol errors with the processor agent attached, and a CROSS_REPO_PROVIDES edge linking sedai-models#4897's added type to sedai-simulation-server#244's import
- [ ] 10.8 Validate cache retention: confirm index TTL expiry retains the clone, size-cap eviction spares clones and reviewer data, and SHA-keyed results survive
- [ ] 10.9 Write the README covering setup, token scope, per-language toolchain requirements, cache location and retention, plugin tiers, and known limitations
