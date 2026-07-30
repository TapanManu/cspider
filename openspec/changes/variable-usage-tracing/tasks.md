## 1. Stop the silent false negative (ships alone, first)

- [x] 1.1 Mark every unresolved FIELD and ENUM_CONSTANT change unit UNKNOWN with a stated reason, so a field never renders as having zero usages when it was never looked up (D1)
- [x] 1.2 Render that UNKNOWN in the detail pane and the impact view, distinct from an empty result
- [x] 1.3 Test: a field in an unresolved run, a field beyond the budget, and a REMOVED field with no base image each report UNKNOWN with their own reason, and none reports zero usages

## 2. Field resolution

- [x] 2.1 Widen the resolution target filter to include FIELD, keeping the existing severity ordering
- [x] 2.1a Extract enum constants as change units — `enum_constant` is absent from the parser's node map, so ENUM_CONSTANT resolution cannot be reached until the parser emits them
- [x] 2.2 Resolve field references position-anchored against the head image
- [x] 2.3 Resolve REMOVED fields against the base image; without one, UNKNOWN and never SAFE or zero (D4, A1)
- [x] 2.4 Give fields their own share of the symbol budget so adding them cannot silently evict methods, and report per-kind omissions
- [x] 2.5 Attribute each reference to its enclosing member, reusing `enclosingMember`; references outside any member become usage sites without a member rather than being dropped (D6)
- [x] 2.6 Test against a fixture repository: a read-only field, a written field, a removed field with surviving readers, and a field used in a static initializer

## 3. Read/write classification (Java, in `src/java/`)

- [x] 3.1 Classify a reference position as READ, WRITE, BOTH, or UNKNOWN from the tree-sitter ancestor chain, with no default to READ (D2)
- [x] 3.2 Handle simple assignment, compound assignment, increment/decrement, and unresolvable syntax
- [x] 3.3 Declare READS_FIELD and WRITES_FIELD in the Java plugin's capabilities
- [x] 3.4 Report direction as unavailable for a plugin that does not declare it, rather than defaulting to read
- [x] 3.5 Test each classification against a fixture, including that an unresolvable site is UNKNOWN and is not counted as a read

## 4. Edges and verdicts

- [x] 4.1 Emit READS_FIELD and WRITES_FIELD edges with mandatory file-and-line evidence; discard and log evidence-less ones
- [x] 4.2 Emit both edges for a BOTH site while counting the site once in usage totals
- [x] 4.3 Implement the variable verdict vocabulary — BROKEN, TYPE_BROKEN, VALUE_CHANGED, UPDATED, SAFE, UNKNOWN (D3)
- [x] 4.4 Detect a changed initializer as VALUE_CHANGED across every usage, and never report it as SAFE
- [x] 4.5 Detect visibility narrowing that puts an existing usage out of scope, as BROKEN
- [x] 4.6 Detect an incompatible type change at a usage site, as TYPE_BROKEN
- [x] 4.7 Mark a usage inside this PR's diff as UPDATED
- [x] 4.8 Include field usage counts in risk, weighting writes at least as heavily as reads, and never scoring an UNKNOWN field as low risk
- [x] 4.9 Suppress `this.x = x` constructor assignments through the existing disclosed noise mechanism, reversible with `--show-noise`
- [x] 4.10 Test the verdict table exhaustively against a stub resolver, as break analysis is tested — a real PR cannot produce every verdict

## 5. External bindings

- [x] 5.1 Extract the bound key from `@Value`, `@ConfigurationProperties`, `@JsonProperty`, `@JsonAlias`, `@Column`, and `@SerializedName`, as a data table rather than logic (D5)
- [x] 5.2 Report a removed or renamed binding as an external contract change, separate from code usage
- [x] 5.3 State that external consumers lie outside the analysed reach, and emit no edge for them
- [x] 5.4 Test that no name-matched external consumer is ever presented as a resolved usage
- [x] 5.5 Validate against `sedai-simulation-server#244`: removing the `@Value("${REUSE_SESSION:false}")` and `@Value("${RESET_CORE:false}")` fields reports both keys as retired

## 6. The usage trace view

- [x] 6.1 Render the trace grouped by file and enclosing member, with direction, verdict, and an in-diff flag per site
- [x] 6.2 Take each excerpt from the using file at the usage line, not from the declaring file
- [x] 6.3 Distinguish reads from writes visibly, and label a BOTH site as both
- [x] 6.4 Add READ BY and WRITTEN BY lanes to the impact view, reusing the computed lane layout and the verdict colouring (D7, F23)
- [x] 6.5 Show the external-binding disclosure with the key named
- [x] 6.6 Render UNKNOWN distinctly from empty, with its reason, everywhere both can occur
- [x] 6.7 Let a usage site be commented on through the existing write path, with the side taken from the row as everywhere else (F19)

## 7. Validation

- [x] 7.1 Validate against `sedai-simulation-server#244`: all 7 field units resolve or state why not, and none reports zero usages without having been looked up
- [x] 7.2 Confirm `VclusterProperties.defaultVersion` reports VALUE_CHANGED with both initializer values, not SAFE
- [x] 7.3 Confirm the three REMOVED fields either list their base-image readers or state UNKNOWN with the missing-base reason
- [x] 7.4 Measure the added resolution cost per field and record it in FINDINGS, so the budget split in 2.4 rests on a number
- [x] 7.5 Confirm a field whose accessors are Lombok-generated declares partial reach rather than presenting a short list as complete (F5b)
