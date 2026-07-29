## ADDED Requirements

### Requirement: Variable usage trace
When the reviewer selects a changed variable, the system SHALL present every resolved usage grouped by
file and enclosing member, each showing its direction, its verdict, an excerpt taken from the using
file, and whether the site lies inside this PR's diff.

#### Scenario: Selecting a removed field
- **WHEN** the reviewer selects a REMOVED field with readers that the PR did not touch
- **THEN** each reader is listed with its excerpt, marked BROKEN, and marked as outside the diff

#### Scenario: Excerpt comes from the using file
- **WHEN** a usage lies in a file other than the one declaring the variable
- **THEN** the excerpt is taken from the using file at the usage line, not from the declaring file

#### Scenario: Usage with no enclosing member
- **WHEN** a usage occurs in a static initializer
- **THEN** it is listed with its file and line and labelled as outside any member

### Requirement: Reads are distinguished from writes
The usage trace SHALL distinguish reads from writes visibly, and SHALL label a site classified BOTH as
both rather than choosing one.

#### Scenario: Mixed usage
- **WHEN** a field has four reads and one write
- **THEN** the write is visibly distinct from the reads, and the counts are stated separately

#### Scenario: Direction unavailable
- **WHEN** the analysing plugin does not declare read/write classification
- **THEN** usages are shown with the direction stated as unavailable, and none is presented as a read

### Requirement: Usage lanes in the impact view
The impact view SHALL place a selected variable's usages in READ BY and WRITTEN BY lanes using the
existing computed lane layout, with each node carrying its verdict colour.

#### Scenario: Field selected in the impact view
- **WHEN** the reviewer selects a changed field with readers and writers
- **THEN** the impact view shows READ BY and WRITTEN BY lanes around the variable, and each node is coloured by its verdict

#### Scenario: Unresolved field selected
- **WHEN** the reviewer selects a field whose usages are UNKNOWN
- **THEN** the view states that the usages are unknown with the reason, and does not render empty lanes as a result

### Requirement: External binding disclosure in the view
When a changed variable carries an external binding, the view SHALL show the bound key and state that
its consumers lie outside the analysed reach.

#### Scenario: Removed configuration field
- **WHEN** the reviewer selects a removed field annotated with a configuration key
- **THEN** the view names the key and states that this analysis cannot see its external consumers

### Requirement: Unknown usages are never rendered as none
The system SHALL render an UNKNOWN usage result differently from an empty usage result, and SHALL
state the reason for the UNKNOWN.

#### Scenario: Unknown versus empty
- **WHEN** one field has no resolved usages and another was never resolved
- **THEN** the two render differently, and the unresolved one states why it is unknown
