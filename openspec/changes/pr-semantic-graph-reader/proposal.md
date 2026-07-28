## Why

Reviewing a pull request on GitHub means reading a flat, alphabetical list of file diffs. The reviewer has to rebuild the causal picture in their head — which method actually changed, who calls it, what breaks downstream, which of the 40 changed files are consequences of the one real change. This gets worse across multiple related PRs, where GitHub offers no cross-PR view at all and cannot show that two PRs touch the same method.

We need a reviewer tool that presents a PR as a **graph of semantic changes with resolved impact**, not a pile of text hunks — so the reviewer sees cause before effect, understands blast radius per change, and can comment and request changes without leaving that view.

## What Changes

- **New standalone application** (not part of any existing `sedai-*` service): a local-first PR review tool, CLI-launched with a local web UI.
- **Multi-PR ingestion** from GitHub REST/GraphQL, cached locally by `pr_id + head_sha`, with an overlap detector that flags symbols changed by more than one PR.
- **Java semantic diff**: parse pre-image and post-image of each changed `.java` file into ASTs and emit *change units* (method/class/field/annotation/signature/visibility deltas) instead of line hunks. Rename and move detection so a relocated method is one node, not a delete plus an add.
- **LSP-backed symbol resolution**: run Eclipse JDT Language Server headless against a checkout of the PR head to resolve real call targets, overrides, implementations, and references. Static edges come from the LSP — never from an LLM.
- **Change-scoped graph**: changed symbols as primary nodes, plus a bounded blast-radius ring (default depth 2) of untouched callers/callees as secondary nodes. Typed edges (`calls`, `overrides`, `implements`, `reads-writes`, `throws`, `test-covers`, `co-changed`) each carrying an evidence reference.
- **Block-scoped code view**: the reader never renders a whole file as one diff. Each changed file is decomposed into symbol blocks; the reviewer sees the selected symbol's before/after with surrounding context collapsed and expandable, plus caller call-site snippets pulled from other files inline.
- **Risk scoring and traversal order**: nodes ordered topologically (entry points first) and scored by fan-in, public-API breakage, missing test coverage, and churn, with reviewed/unreviewed progress tracking.
- **Review write path**: draft inline comments anchored to a graph node, GitHub `suggestion` blocks, batch them locally, then submit once as `COMMENT`, `APPROVE`, or `REQUEST_CHANGES`. Nothing is posted to GitHub until an explicit confirm step that shows exactly what will be sent.
- **Two-tier language plugin contract**: all language-specific analysis runs out-of-process behind one versioned JSON-RPC contract. Tier 1 wraps a stock language server (`jdtls`, later `gopls`, `pyright`); Tier 2 is an optional native sidecar written in the analyzed language, added only where Tier 1 cannot answer an edge type. A shared conformance suite keeps implementations from drifting. Only the contract, the host orchestrator, the conformance suite, and one Tier 1 Java plugin are built here.
- **Non-goal for this change**: Go and Python plugins, any Tier 2 sidecar, cross-language edges (yaml/IaC/proto nodes), and LLM-generated impact narration. The contract and graph model are designed to admit them later, but they are not built here.

## Capabilities

### New Capabilities
- `pr-ingestion`: Fetching, normalizing, and caching one or more GitHub pull requests, including diffs, review threads, and the head checkout used for analysis; cross-PR overlap detection.
- `java-semantic-diff`: Turning pre/post file images into typed Java change units (added/removed/modified/moved symbols with signature, visibility, and annotation deltas).
- `lsp-symbol-resolution`: The language plugin contract and host orchestrator, headless Eclipse JDT LS lifecycle, workspace indexing, and the resolution queries (definition, references, implementations, type hierarchy) that produce authoritative graph edges.
- `change-graph-model`: The node and edge schema, blast-radius expansion rules, risk scoring, topological review ordering, and noise suppression.
- `change-code-view`: How code is presented — symbol-block decomposition, before/after rendering, collapsed context, inline call-site excerpts, and cross-file navigation.
- `pr-review-write`: Draft comment management, suggestion blocks, batch review assembly, and confirmed submission to GitHub.

### Modified Capabilities
None — `openspec/specs/` is currently empty; all capabilities here are new.

## Impact

- **New codebase**, no existing `sedai-*` repo is modified.
- **External dependencies**: GitHub API (PAT with `repo` scope), Eclipse JDT Language Server distribution, a JDK matching each analyzed repo's build, tree-sitter Java grammar, a local graph/state store (SQLite), and a browser-based graph renderer.
- **Operational cost**: analysis requires a real clone and a JDT LS index of the PR head. Index time on a large Java repo is minutes on first run; the cache keyed by `head_sha` makes repeat opens fast. This is the dominant performance risk and is addressed in design.
- **Security**: GitHub token handled locally only; write operations gated behind an explicit confirmation that renders the exact payload.
