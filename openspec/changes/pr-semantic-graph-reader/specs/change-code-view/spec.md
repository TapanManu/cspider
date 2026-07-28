## ADDED Requirements

### Requirement: Symbol-block decomposition of changed files
The system SHALL present each changed file as an ordered list of symbol blocks derived from the file's symbol ranges, rather than as a single continuous file diff, with each block labeled by its change kind.

#### Scenario: File with several changed methods
- **WHEN** a file has three modified methods and one added field
- **THEN** the file is presented as four labeled blocks, each independently selectable and collapsible

#### Scenario: Change outside any symbol
- **WHEN** a hunk falls outside every symbol range, such as an import block
- **THEN** it is presented as its own synthetic block in file order

#### Scenario: Block ordering
- **WHEN** blocks are listed for a file
- **THEN** they appear in source order and unchanged symbols between them are represented by a collapsed stub

### Requirement: Node detail before/after view
Selecting a node SHALL display the before and after source of that symbol only, with split and unified toggles and intra-line highlighting of changed tokens.

#### Scenario: Modified method selected
- **WHEN** the reviewer selects a MODIFIED method node
- **THEN** the system displays the base and head source of that method side by side with changed tokens highlighted within lines

#### Scenario: Added symbol selected
- **WHEN** the reviewer selects an ADDED node
- **THEN** the before pane indicates the symbol did not previously exist and the after pane shows the full new source

#### Scenario: Removed symbol selected
- **WHEN** the reviewer selects a REMOVED node
- **THEN** the before pane shows the base source and the after pane indicates removal

#### Scenario: Unified toggle
- **WHEN** the reviewer switches to unified mode
- **THEN** the same symbol renders as a single-column diff and the mode persists across node selections

### Requirement: Expandable surrounding context
The system SHALL collapse the unchanged remainder of a file into expandable stubs above and below the selected symbol so the reviewer can reach full file context without leaving the node view.

#### Scenario: Expanding neighbouring context
- **WHEN** the reviewer expands the stub above the selected symbol
- **THEN** the preceding unchanged source is revealed in place and the selected symbol remains in view

#### Scenario: Full file requested
- **WHEN** the reviewer requests the whole file
- **THEN** the complete head-side file is shown with all changed blocks marked, and the reviewer can return to the node view

### Requirement: Inline call-site excerpts
For each inbound CALLS edge on the selected node, the system SHALL render an excerpt of the calling code from the calling file directly within the node view, tagged with its break-analysis verdict.

#### Scenario: Callers displayed inline
- **WHEN** a selected method has four inbound call sites
- **THEN** the node view lists four excerpts, each showing the calling file, line, surrounding lines, and a verdict of UPDATED, BROKEN, or SAFE

#### Scenario: Navigating to a caller
- **WHEN** the reviewer activates a call-site excerpt
- **THEN** the system selects the calling symbol's node and preserves the ability to return to the previous node

#### Scenario: No inbound callers
- **WHEN** a selected method has no resolved inbound call sites
- **THEN** the node view states that no callers were resolved and indicates whether any references were unresolved

### Requirement: Callee delta display
The node view SHALL list the symbols the selected node calls that it did not call at the base image, and those it no longer calls, each expandable to the callee's node.

#### Scenario: New callee introduced
- **WHEN** a modified method body introduces a call to a symbol it did not previously call
- **THEN** that callee is listed as newly introduced and can be opened as its own node

#### Scenario: Callee removed
- **WHEN** a modified method no longer calls a symbol it previously called
- **THEN** that callee is listed as removed

### Requirement: Facts panel
The node view SHALL display a facts panel containing the signature, visibility, annotation, modifier, and throws deltas; the structural test coverage list; the risk score components; and the PR ids that touch the node.

#### Scenario: Contract change surfaced
- **WHEN** the selected node has a signature and an annotation delta
- **THEN** the facts panel shows both, with before and after values

#### Scenario: Missing coverage surfaced
- **WHEN** the selected node has no TEST_COVERS edges
- **THEN** the facts panel states that no tests structurally reach this symbol

#### Scenario: Unresolved references surfaced
- **WHEN** the selected node has unresolved references
- **THEN** the facts panel lists them with the reason resolution failed

### Requirement: Three synchronized view modes
The system SHALL provide graph, ordered-list, and file-tree views over the same analysis, sharing one selection state.

#### Scenario: Selection synchronized
- **WHEN** the reviewer selects a node in the graph view and switches to the ordered-list view
- **THEN** the same node is selected and scrolled into view

#### Scenario: Ordered-list driving
- **WHEN** the reviewer works through the ordered list marking nodes reviewed
- **THEN** progress is reflected in the graph view as reviewed-state styling on the corresponding nodes

#### Scenario: File-tree escape hatch
- **WHEN** the reviewer switches to the file-tree view
- **THEN** changed files are listed with their symbol blocks, and selecting a block selects the corresponding node

### Requirement: Graph rendering legibility
The graph view SHALL visually encode change kind, origin, risk, reviewed state, and originating PR, and SHALL remain interactive at the configured node cap.

#### Scenario: Visual encoding
- **WHEN** the graph is rendered
- **THEN** CHANGED and CONTEXT nodes are visually distinct, risk is encoded, reviewed nodes are marked, and in multi-PR mode nodes are colored by originating PR

#### Scenario: Truncation is visible
- **WHEN** expansion was truncated at a node
- **THEN** the graph marks that node with the count of omitted neighbours
