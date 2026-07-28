## ADDED Requirements

### Requirement: Headless language server lifecycle
The system SHALL launch Eclipse JDT Language Server as a headless child process over LSP stdio, initialize it against the PR head worktree, wait for the workspace index to complete, and keep the process alive for the duration of the analysis session.

#### Scenario: Server starts and indexes
- **WHEN** analysis begins for a PR head worktree
- **THEN** the system launches JDT LS, sends `initialize` with the worktree as the root, and reports index progress until the server signals readiness

#### Scenario: Server reused within a session
- **WHEN** a second resolution request is made for the same repository and `head_sha` within one session
- **THEN** the system reuses the running server instance rather than launching a new one

#### Scenario: Server crashes mid-analysis
- **WHEN** the language server process exits unexpectedly
- **THEN** the system restarts it, replays initialization, and retries the in-flight request once before reporting the affected symbols as unresolved

#### Scenario: JDK mismatch
- **WHEN** the JDK available does not satisfy the version declared by the repository's build files
- **THEN** the system warns the reviewer with both versions before indexing and continues

### Requirement: Resolution queries produce graph edges
The system SHALL resolve, for each changed symbol, its call targets, inbound references, overridden and implemented members, and type hierarchy, using LSP definition, references, implementation, and type-hierarchy requests.

#### Scenario: Inbound callers resolved
- **WHEN** the reviewer's PR modifies a method
- **THEN** the system issues a references request for that method and produces one CALLS edge per resolved call site

#### Scenario: Override relationship resolved
- **WHEN** a changed method overrides a superclass method
- **THEN** the system produces an OVERRIDES edge from the changed method to the superclass method

#### Scenario: Interface implementation resolved
- **WHEN** a changed method implements an interface method
- **THEN** the system produces an IMPLEMENTS edge to the interface member and, for the interface member, edges to all other known implementors

#### Scenario: Callee change detected
- **WHEN** a modified method body calls a symbol it did not call at the base image
- **THEN** the system produces a CALLS edge marked as newly introduced

### Requirement: Every resolved edge carries evidence
The system SHALL attach to each resolved edge at least one evidence record containing a file path, a line number, and a source snippet, and SHALL NOT emit an edge without evidence.

#### Scenario: Call edge evidence
- **WHEN** a CALLS edge is produced from a resolved reference
- **THEN** the edge carries the calling file, the call-site line, and a snippet of the call site

#### Scenario: Evidence unavailable
- **WHEN** a relationship is reported by the language server but no source location can be attached
- **THEN** the system discards the edge and records the omission in the analysis report

### Requirement: Explicit handling of unresolvable references
The system SHALL surface references the language server cannot resolve as explicit unresolved markers on the owning node, rather than omitting them silently.

#### Scenario: Repository does not fully compile
- **WHEN** the workspace has compilation errors that prevent resolution of some references
- **THEN** the system emits the edges it can resolve and attaches an unresolved marker, with the language server diagnostic, for each reference it cannot

#### Scenario: Reference into a dependency without sources
- **WHEN** a changed method calls into a binary dependency whose sources are unavailable
- **THEN** the system records the target as an external unresolved node rather than dropping the relationship

### Requirement: Annotation processor attachment, assertion, or refusal
The system SHALL detect whether a project uses an annotation processor that generates members, SHALL attach that processor as an agent to the language server JVM using the version declared by the project's build files, SHALL assert that a known generated member resolves, and SHALL refuse to analyze the project when the assertion fails.

#### Scenario: Lombok project analyzed with the agent attached
- **WHEN** a project declaring Lombok is analyzed
- **THEN** the system attaches the Lombok agent at the version declared by the project and generated accessors resolve without unresolved-symbol errors

#### Scenario: Declared version preferred over newest available
- **WHEN** a project declares Lombok 1.18.42 and a newer version is also available locally
- **THEN** the system attaches 1.18.42

#### Scenario: Processor jar unavailable
- **WHEN** a project uses Lombok and no matching jar can be located
- **THEN** the system refuses to analyze the project and reports what is missing, rather than producing a graph with missing edges

#### Scenario: Assertion fails despite attachment
- **WHEN** the agent is attached but a known generated member still does not resolve
- **THEN** the system treats this as fatal and reports it, rather than continuing with a silently sparse graph

### Requirement: Synthesised nodes for generated members
For a type whose members are produced by an annotation processor, the system SHALL synthesise member nodes from the type's fields and annotations, anchor each to the backing field's source range, and mark them as generated.

#### Scenario: Lombok DTO with no declared methods
- **WHEN** a class declares only fields and carries `@Getter`, `@Setter`, `@Builder`, and `@AllArgsConstructor`
- **THEN** the system synthesises accessor, builder, and constructor nodes anchored to the backing fields, rather than reporting the class as having no members

#### Scenario: Generated nodes are distinguishable
- **WHEN** a synthesised member node is displayed
- **THEN** it is marked as generated so it is never presented as hand-written source

#### Scenario: Comment anchoring on a generated member
- **WHEN** the reviewer attempts to comment on a synthesised member node
- **THEN** the system does not anchor the comment to a line the author did not write, and offers the backing field instead

### Requirement: Position-anchored resolution only
The resolution layer SHALL use only position-anchored language server requests and SHALL NOT issue workspace-wide symbol queries.

#### Scenario: Workspace-wide query is not issued
- **WHEN** the system needs to locate a symbol
- **THEN** it resolves from a known source position rather than issuing a workspace-wide symbol query

#### Scenario: Query budget governs expansion
- **WHEN** blast-radius expansion would exceed the configured budget of outstanding resolution requests
- **THEN** the system stops expanding, reports the truncation, and allows per-node manual expansion

### Requirement: Cross-repo provider correlation
When multiple PRs are ingested, the system SHALL correlate unresolved imports in one PR against top-level types added by another PR in the set, emit a cross-repo provider edge for each match, and exclude the explained imports from the resolution-health calculation.

#### Scenario: Consumer and producer in different repositories
- **WHEN** a PR in one repository has an unresolved import whose fully-qualified name equals a type added by a PR in another repository in the ingested set
- **THEN** the system emits a cross-repo provider edge from the added type to the importing file, with the import statement and the declaration as evidence

#### Scenario: Explained imports do not degrade health
- **WHEN** an unresolved import is explained by a cross-repo provider edge
- **THEN** it is excluded from the resolution-health denominator and the graph is not declared degraded on its account

#### Scenario: Correlation is marked as name-derived
- **WHEN** a cross-repo provider edge is displayed
- **THEN** it is marked as derived from name matching and rendered distinctly from resolved edges

#### Scenario: No matching producer
- **WHEN** an unresolved import matches no type added by any ingested PR
- **THEN** no edge is emitted and the unresolved import continues to count against resolution health

### Requirement: Resolution result caching
The system SHALL cache resolution results keyed by `head_sha` and symbol identity, and reuse them across sessions.

#### Scenario: Re-analyzing the same head commit
- **WHEN** analysis is re-run for a `head_sha` already resolved
- **THEN** the system serves edges from cache and does not start the language server unless an uncached symbol is requested

### Requirement: Lazy resolution beyond the default depth
The system SHALL eagerly resolve only changed symbols and their immediate neighbours, and SHALL resolve deeper neighbours only when the reviewer requests expansion.

#### Scenario: Default analysis
- **WHEN** analysis completes for a PR
- **THEN** resolution requests have been issued only for changed symbols and their depth-1 neighbours

#### Scenario: Reviewer expands a node
- **WHEN** the reviewer requests expansion of a node beyond the resolved depth
- **THEN** the system issues the additional resolution requests on demand and adds the resulting nodes and edges to the graph

### Requirement: Out-of-process language plugin contract
All language-specific analysis SHALL run in a separate plugin process communicating with the host over a versioned JSON-RPC contract covering symbol parsing, symbol diffing, edge resolution, signature compatibility, test-source detection, and public-API detection. The host SHALL contain no language-specific logic.

#### Scenario: Java analysis runs out of process
- **WHEN** a Java file is analyzed
- **THEN** all parsing, diffing, and resolution is performed by the Java plugin process and the host receives only contract responses

#### Scenario: Contract version mismatch
- **WHEN** a plugin declares a contract version the host does not support
- **THEN** the host refuses to load that plugin and reports both versions

#### Scenario: Adding a language requires no host change
- **WHEN** a plugin for a new language that satisfies the contract is registered
- **THEN** the system analyzes that language's files with no modification to the host, graph model, or user interface

### Requirement: Declared plugin capabilities
Each plugin SHALL declare the file extensions it handles, the edge types it can produce, and its tier, and the host SHALL report undeclared edge types as unavailable rather than treating them as absent.

#### Scenario: Plugin cannot produce an edge type
- **WHEN** a plugin does not declare support for distinguishing field reads from field writes
- **THEN** the system reports that edge type as unavailable for that language rather than showing the graph as having no such relationships

#### Scenario: Unhandled file extension
- **WHEN** a changed file's extension is declared by no registered plugin
- **THEN** the file is marked unanalyzed and the reviewer is told which languages are unsupported in this analysis

### Requirement: Tier substitution without host change
The system SHALL accept either a language-server-backed plugin or a native sidecar plugin for the same language, provided both satisfy the same contract version.

#### Scenario: Sidecar replaces a language server plugin
- **WHEN** a native sidecar plugin for a language replaces the language-server-backed plugin
- **THEN** the system produces edges of the same types with the same evidence structure, and no consumer of the graph requires modification

### Requirement: Plugin conformance suite
The system SHALL provide a shared conformance suite that every plugin must pass, exercising each change kind, each delta type, rename and move detection, and each break classification against a per-language fixture corpus.

#### Scenario: Conforming plugin accepted
- **WHEN** a plugin passes the full conformance suite for its language corpus
- **THEN** it is considered contract-compliant and may be registered

#### Scenario: Non-conforming plugin
- **WHEN** a plugin fails any conformance case
- **THEN** the suite reports the failing case with expected and actual contract responses

### Requirement: Recordable plugin exchanges
The system SHALL support recording plugin requests and responses to fixtures and replaying them without the plugin process or the analyzed repository present.

#### Scenario: Reproducing a wrong edge
- **WHEN** recording is enabled and an incorrect edge is produced
- **THEN** the recorded exchange can be replayed against the host to reproduce that edge with neither the plugin nor the repository available

### Requirement: Per-language toolchain preflight
The system SHALL verify the toolchain required by each language present in the PR before analysis begins, and SHALL report precisely what is missing rather than degrading mid-run.

#### Scenario: Required toolchain absent
- **WHEN** a PR contains Java files and no suitable JDK is available
- **THEN** the system reports the missing toolchain and the required version before starting analysis

#### Scenario: Some languages available
- **WHEN** a PR contains files for two languages and only one toolchain is present
- **THEN** the system analyzes the supported language, and reports the other's files as unanalyzed with the missing toolchain named

### Requirement: Resolution health reporting
The system SHALL compute and display the percentage of references in changed files that resolved successfully, and SHALL declare the graph degraded when that percentage falls below a configured threshold.

#### Scenario: Dependencies unresolved
- **WHEN** the dependency-resolution build fails and a large share of references cannot be resolved
- **THEN** the system displays the resolution-health percentage and states that the graph is degraded, naming the build failure as the cause

#### Scenario: Healthy resolution
- **WHEN** resolution health is above the configured threshold
- **THEN** the system reports the percentage without a degradation warning
