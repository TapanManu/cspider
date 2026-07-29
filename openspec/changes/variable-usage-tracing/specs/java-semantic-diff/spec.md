## ADDED Requirements

### Requirement: Reference direction classification
The system SHALL classify each resolved reference to a field as READ, WRITE, BOTH, or UNKNOWN by
inspecting the syntax at the reference position, and SHALL NOT default an undetermined site to READ.

#### Scenario: Plain read
- **WHEN** a field appears as an operand in an expression
- **THEN** the reference is classified READ

#### Scenario: Assignment target
- **WHEN** a field is the left operand of a simple assignment
- **THEN** the reference is classified WRITE

#### Scenario: Compound assignment
- **WHEN** a field is the left operand of a compound assignment such as `+=`
- **THEN** the reference is classified BOTH, because the value is read before it is written

#### Scenario: Increment
- **WHEN** a field is the operand of `++` or `--`
- **THEN** the reference is classified BOTH

#### Scenario: Syntax not determinable
- **WHEN** the syntax at a reference position cannot be resolved to an enclosing expression
- **THEN** the reference is classified UNKNOWN with the position recorded, and is not counted as a read

### Requirement: External binding extraction
The system SHALL extract the bound key from a changed field carrying an annotation that binds it to a
value outside the codebase, and SHALL report that key as an external consumer resolution cannot reach.

#### Scenario: Configuration property removed
- **WHEN** a field annotated `@Value("${REUSE_SESSION:false}")` is removed
- **THEN** the system reports that the key `REUSE_SESSION` is no longer consumed by this code, and states that its external consumers are outside the analysed reach

#### Scenario: Serialised name changed
- **WHEN** a field's `@JsonProperty` name changes
- **THEN** the system reports the old and new wire names as an external contract change, separately from any code usage

#### Scenario: Unrecognised annotation
- **WHEN** a changed field carries an annotation that is not a recognised external binding
- **THEN** no external-binding disclosure is produced for it, and the annotation delta is reported as an ordinary annotation change

### Requirement: External consumers are never resolved by name
The system SHALL NOT search other repositories or non-source files for consumers of an extracted
binding key, and SHALL NOT present any name-matched result as a resolved usage.

#### Scenario: Key used in deployment configuration
- **WHEN** a removed field's configuration key also appears in a chart or environment file
- **THEN** the system does not emit a usage edge for it, and the disclosure states only that external consumers exist outside the analysed reach
