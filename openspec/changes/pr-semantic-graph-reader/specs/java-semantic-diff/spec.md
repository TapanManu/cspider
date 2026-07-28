## ADDED Requirements

### Requirement: Symbol extraction from Java sources
The system SHALL parse each changed `.java` file at both the merge-base and head images into a symbol table containing classes, interfaces, enums, records, methods, constructors, and fields, each with its fully-qualified name, source range, signature, visibility, modifiers, annotations, and declared exceptions.

#### Scenario: Parsing a well-formed Java file
- **WHEN** a changed `.java` file is parsed at the head image
- **THEN** the system produces a symbol table entry for every declared type and member with its fully-qualified name and source range

#### Scenario: File added in the PR
- **WHEN** a `.java` file exists at head but not at merge-base
- **THEN** the system produces an empty base symbol table and a populated head symbol table for that file

#### Scenario: Unparseable source
- **WHEN** a file cannot be parsed due to a syntax error
- **THEN** the system records the file as a parse failure with the error location and excludes it from change-unit extraction without aborting the run

### Requirement: Change unit derivation
The system SHALL derive change units by comparing base and head symbol tables, classifying each unit as ADDED, REMOVED, MODIFIED, MOVED, RENAMED, or UNCHANGED.

#### Scenario: Method body modified
- **WHEN** a method exists in both images with the same signature but a different body
- **THEN** the system emits one MODIFIED change unit carrying a BODY delta

#### Scenario: Method added
- **WHEN** a method exists at head but not at base
- **THEN** the system emits one ADDED change unit

#### Scenario: Method removed
- **WHEN** a method exists at base but not at head
- **THEN** the system emits one REMOVED change unit retaining the base-side source range

#### Scenario: Unchanged members are not emitted as changes
- **WHEN** a file changes but a given method within it is byte-identical in both images
- **THEN** that method is not emitted as a changed unit

### Requirement: Typed deltas on modified units
For each MODIFIED change unit, the system SHALL record every applicable delta type: SIGNATURE, VISIBILITY, ANNOTATION, MODIFIER, THROWS, and BODY, each with its before and after values.

#### Scenario: Signature change
- **WHEN** a method changes from `process(String)` to `process(String, int)`
- **THEN** the change unit carries a SIGNATURE delta with both the before and after signatures

#### Scenario: Visibility reduction
- **WHEN** a method changes from `public` to `private`
- **THEN** the change unit carries a VISIBILITY delta recording `public` → `private`

#### Scenario: Annotation removed
- **WHEN** `@Transactional` is removed from a method
- **THEN** the change unit carries an ANNOTATION delta recording the removal

#### Scenario: Multiple concurrent deltas
- **WHEN** a method changes visibility, adds a parameter, and changes its body in the same PR
- **THEN** the single change unit carries all three deltas

### Requirement: Rename and move detection
The system SHALL detect a symbol that has been renamed or relocated and represent it as a single change unit rather than an unrelated ADDED and REMOVED pair, when detection confidence exceeds a configured threshold.

#### Scenario: Method moved between files
- **WHEN** a method with an identical body is removed from one file and added to another in the same PR
- **THEN** the system emits one MOVED change unit recording both the base and head locations

#### Scenario: Method renamed in place
- **WHEN** a method's name changes while its body and parameter list remain highly similar
- **THEN** the system emits one RENAMED change unit recording the old and new names

#### Scenario: Low-confidence match
- **WHEN** a removed and an added symbol are similar but below the confidence threshold
- **THEN** the system emits them as separate REMOVED and ADDED units and offers the reviewer a suggested link rather than asserting a MOVED unit

### Requirement: Non-symbol change capture
The system SHALL represent diff hunks that fall outside any symbol range as synthetic change units so that no change in the PR is silently omitted.

#### Scenario: Import-only change
- **WHEN** the only change to a file is in its import block
- **THEN** the system emits a synthetic change unit for the import region attributed to that file

#### Scenario: Non-Java file changed
- **WHEN** the PR changes a file whose extension has no registered language adapter
- **THEN** the system emits a FILE-kind change unit with no symbol decomposition and marks it as unanalyzed

### Requirement: Stable change unit identity
The system SHALL assign each change unit an identifier derived from repository, fully-qualified name, and kind, such that the identifier is unchanged by line movement within a file.

#### Scenario: Symbol shifted by an edit above it
- **WHEN** a method's line range shifts because lines were inserted above it, with no change to the method itself
- **THEN** the method's change unit identifier is unchanged and the method is not reported as modified
