## ADDED Requirements

### Requirement: Change-scoped graph construction
The system SHALL construct a graph whose primary nodes are the change units of the ingested PRs and whose secondary nodes are unchanged symbols reached by blast-radius expansion, with each node marked as CHANGED or CONTEXT origin.

#### Scenario: Graph built from a PR
- **WHEN** analysis completes for a PR with 12 change units
- **THEN** the graph contains 12 CHANGED nodes plus any CONTEXT nodes reached by expansion, and every CHANGED node is reachable in the graph

#### Scenario: Isolated change
- **WHEN** a changed symbol has no resolved callers or callees
- **THEN** it appears as an isolated CHANGED node rather than being omitted

### Requirement: Typed edges
The graph SHALL support the edge types CALLS, OVERRIDES, IMPLEMENTS, EXTENDS, CONSTRUCTS, READS_FIELD, WRITES_FIELD, THROWS_TO, TEST_COVERS, CO_CHANGED, and CROSS_REPO_PROVIDES, each recording the derivation source as LSP, AST, GIT_HISTORY, or NAME_MATCH.

#### Scenario: Edge type filtering
- **WHEN** the reviewer disables the CO_CHANGED edge type
- **THEN** the graph re-renders with those edges hidden and all other edges retained

#### Scenario: Statistical edges are distinguished
- **WHEN** the graph displays a CO_CHANGED edge alongside a CALLS edge
- **THEN** the CO_CHANGED edge is visually distinct and labeled as derived from history rather than from resolution

### Requirement: Co-change edges from git history
The system SHALL derive CO_CHANGED edges between files that historically change together above a configured co-occurrence threshold over a configured commit window.

#### Scenario: Strongly coupled files
- **WHEN** two changed files have co-occurred in at least the threshold fraction of commits touching either file
- **THEN** the system emits a CO_CHANGED edge annotated with the co-occurrence ratio and sample size

#### Scenario: Insufficient history
- **WHEN** a file has fewer commits than the configured minimum sample size
- **THEN** no CO_CHANGED edge is emitted for that file

### Requirement: Structural test coverage edges
The system SHALL emit TEST_COVERS edges from test-source symbols that transitively reach a changed symbol within the blast radius, and SHALL present these as a structural approximation rather than measured coverage.

#### Scenario: Test reaches a changed method
- **WHEN** a method in a test source directory transitively calls a changed method within the expansion depth
- **THEN** the system emits a TEST_COVERS edge and the node reports that test

#### Scenario: No test reaches a changed method
- **WHEN** no test-source symbol reaches a changed method within the expansion depth
- **THEN** the node is flagged as having no structural test coverage

### Requirement: Bounded blast radius with disclosed truncation
The system SHALL expand the graph to a default depth of 2 hops from each CHANGED node, SHALL enforce a configurable maximum node count, and SHALL explicitly report when expansion was truncated by either bound.

#### Scenario: Expansion within bounds
- **WHEN** depth-2 expansion produces fewer nodes than the cap
- **THEN** the full depth-2 neighbourhood is present and no truncation is reported

#### Scenario: Node cap reached
- **WHEN** expansion from a high-fan-in node would exceed the node cap
- **THEN** the system truncates expansion and displays the count of omitted nodes on the node that was truncated

#### Scenario: Per-node manual expansion
- **WHEN** the reviewer expands a truncated node
- **THEN** the system resolves and adds that node's further neighbours regardless of the default depth

### Requirement: Signature break analysis
For each changed symbol whose contract changed, the system SHALL classify every inbound call site as UPDATED, BROKEN, or SAFE.

#### Scenario: Call site not updated
- **WHEN** a method gains a required parameter and an inbound call site outside the PR diff still passes the old argument list
- **THEN** that call site is classified BROKEN

#### Scenario: Call site updated in the PR
- **WHEN** an inbound call site is itself part of the PR diff and matches the new signature
- **THEN** that call site is classified UPDATED

#### Scenario: Compatible change
- **WHEN** the contract change cannot break the call site, such as an added overload
- **THEN** the call site is classified SAFE

#### Scenario: Visibility reduction breaks an external caller
- **WHEN** a method's visibility is reduced and an inbound call site is outside the new visibility scope
- **THEN** that call site is classified BROKEN

### Requirement: Indirect fan-in for overriding members
For a member that overrides or implements another, the system SHALL attribute its inbound reference set to the supertype declaration, mark that fan-in as indirect, and prevent indirect fan-in alone from driving a node to maximum risk.

#### Scenario: Override of a widely-called interface method
- **WHEN** a changed method overrides an interface method that has many call sites
- **THEN** the node reports the fan-in as callers of the interface method, marked indirect, and states that dispatch to this implementation is not statically determined

#### Scenario: Indirect fan-in does not dominate risk
- **WHEN** two nodes are identical except that one has high indirect fan-in and no other risk factors
- **THEN** that node does not score maximum risk on indirect fan-in alone

#### Scenario: Break analysis still uses the full set
- **WHEN** an overriding method's signature changes
- **THEN** break analysis classifies every call site of the supertype declaration, not a reduced subset

### Requirement: Transparent risk scoring
The system SHALL compute a risk score per node from broken call sites, public-API contract change, inbound fan-in, absence of structural test coverage, and body churn, and SHALL display the contributing components alongside the score. Historical defect density SHALL be excluded by default and available only behind a per-repository configuration flag.

#### Scenario: Default scoring components
- **WHEN** a risk score is computed with default configuration
- **THEN** it comprises exactly the five change-derived components and excludes historical defect density

#### Scenario: Defect density enabled for a repository
- **WHEN** historical defect density is enabled for a repository whose commits reference issue keys
- **THEN** it appears as an additional named component in the score breakdown

#### Scenario: Score components shown
- **WHEN** the reviewer inspects a node's risk score
- **THEN** the system displays each contributing component and its contribution, not only the total

#### Scenario: Broken call sites dominate
- **WHEN** a node has at least one BROKEN call site
- **THEN** its risk score ranks it above any node with no broken call sites and otherwise identical components

### Requirement: Review ordering and progress tracking
The system SHALL provide a topological ordering of nodes over CALLS edges with cycles broken by descending risk, SHALL allow the reviewer to switch to risk ordering, and SHALL persist per-node reviewed state.

#### Scenario: Topological order presented
- **WHEN** the reviewer opens the ordered view
- **THEN** callers appear before the symbols they call, and cyclic groups are ordered by descending risk

#### Scenario: Progress persists across sessions
- **WHEN** the reviewer marks nodes reviewed, closes the tool, and reopens the same PR at the same `head_sha`
- **THEN** the reviewed state and progress count are restored

#### Scenario: Head advances
- **WHEN** the PR head advances after some nodes were marked reviewed
- **THEN** reviewed state is retained for nodes whose content is unchanged and cleared for nodes whose content changed

### Requirement: Disclosed noise suppression
The system SHALL suppress import-only, formatting-only, comment-only, and generated-file changes by default, and SHALL always display the count of suppressed changes with a control to reveal them.

#### Scenario: Formatting-only change suppressed
- **WHEN** a changed method differs only in whitespace
- **THEN** it is hidden from the default view and counted in the suppressed total

#### Scenario: Suppressed changes revealed
- **WHEN** the reviewer chooses to reveal suppressed changes
- **THEN** those nodes appear in the graph and ordered list, marked as low-signal

### Requirement: Per-PR graph with unconditional overlap disclosure
The system SHALL present one graph per PR by default. When a symbol is changed by more than one ingested PR, the system SHALL disclose the overlap on every affected PR's view without requiring the reviewer to opt into a merged view.

#### Scenario: Overlap disclosed in the per-PR view
- **WHEN** the reviewer opens PR #101 and a symbol in it is also changed by PR #102
- **THEN** the per-PR view displays a persistent notice naming the overlapping symbols and the other PR

#### Scenario: Merged view is opt-in
- **WHEN** the reviewer chooses the merged view
- **THEN** the system renders all ingested PRs on one canvas with nodes colored by originating PR

#### Scenario: No overlap present
- **WHEN** the ingested PRs share no changed symbols
- **THEN** no overlap notice is displayed

### Requirement: Cross-PR node merging
When multiple PRs are viewed together, the system SHALL represent a symbol changed by more than one PR as a single node carrying all contributing PR ids and marked as overlapping.

#### Scenario: Overlapping node highlighted
- **WHEN** two PRs modify the same method and the merged view is open
- **THEN** the graph shows one node listing both PR ids and marks it as a conflict risk

#### Scenario: Filtering to one PR
- **WHEN** the reviewer filters the merged graph to a single PR
- **THEN** only nodes carrying that PR id remain as CHANGED, and the rest are shown as CONTEXT or hidden
