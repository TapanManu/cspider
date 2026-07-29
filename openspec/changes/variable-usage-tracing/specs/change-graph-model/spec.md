## ADDED Requirements

### Requirement: Field access edges
The system SHALL emit READS_FIELD and WRITES_FIELD edges from the enclosing member of each resolved
reference to the changed field, each carrying file-and-line evidence and its derivation source, and
SHALL emit both for a reference classified BOTH.

#### Scenario: Read and write of one field
- **WHEN** a changed field is read in one method and assigned in another
- **THEN** the graph contains one READS_FIELD edge and one WRITES_FIELD edge, each with its own evidence

#### Scenario: Compound assignment
- **WHEN** a reference is classified BOTH
- **THEN** the graph contains both a READS_FIELD and a WRITES_FIELD edge for that single site, and the site is counted once in the usage total

#### Scenario: Evidence is mandatory
- **WHEN** a field reference resolves without a usable file and line
- **THEN** no edge is emitted and the omission is recorded, consistent with evidence-less edges being discarded

### Requirement: Usage outside any member
The system SHALL report a field reference that occurs outside any method or constructor — in a field
initializer, a static block, or an instance initializer — as a usage site without an enclosing member,
rather than omitting it.

#### Scenario: Read in a static initializer
- **WHEN** a changed field is read by a static initializer
- **THEN** the usage is reported with its file and line and no enclosing member, rather than being dropped

### Requirement: Variable usage verdicts
For each usage site of a changed variable the system SHALL assign exactly one verdict from BROKEN,
TYPE_BROKEN, VALUE_CHANGED, UPDATED, SAFE, or UNKNOWN.

#### Scenario: Reader of a removed field
- **WHEN** a field is removed and a usage site outside this PR's diff still references it
- **THEN** that usage is BROKEN

#### Scenario: Reader updated by the author
- **WHEN** a usage site of a changed field lies inside this PR's diff
- **THEN** that usage is UPDATED

#### Scenario: Initializer value changed
- **WHEN** a field's declaration and type are unchanged but its initializer changed
- **THEN** every usage is VALUE_CHANGED, and none is reported as SAFE

#### Scenario: Incompatible type change
- **WHEN** a field's type changes and a usage site is not assignment-compatible with the new type
- **THEN** that usage is TYPE_BROKEN

#### Scenario: Visibility narrowed out of reach
- **WHEN** a field's visibility is reduced and a usage site falls outside the new scope
- **THEN** that usage is BROKEN

#### Scenario: Unresolved usage
- **WHEN** a changed field's references were not resolved
- **THEN** its usages are UNKNOWN with a reason, and the field is not reported as unused

### Requirement: Value changes are not certified safe
The system SHALL NOT report a VALUE_CHANGED usage as SAFE, and SHALL present the before and after
values of the changed initializer alongside the usage list.

#### Scenario: Configuration default flipped
- **WHEN** a field's default changes from `false` to `true` and every usage still compiles
- **THEN** the usages are reported VALUE_CHANGED with both values shown, rather than as a clean result

### Requirement: Field fan-in contributes to risk
The system SHALL include resolved field usage counts in a changed field's risk score, weighting writes
at least as heavily as reads, and SHALL NOT score an UNKNOWN field as low risk.

#### Scenario: Widely read constant
- **WHEN** a changed field is read in 20 places
- **THEN** its risk score reflects that fan-in rather than remaining null

#### Scenario: Unresolved field is not low risk
- **WHEN** a changed field's usages are UNKNOWN
- **THEN** its risk is not reported as low on the basis of having no known usages
