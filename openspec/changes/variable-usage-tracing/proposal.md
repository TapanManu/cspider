## Why

Select a changed **method** today and the tool answers the question the whole design exists to
answer: who calls this, and did the PR update them. Select a changed **field** and it answers
nothing — and worse, it answers nothing *silently*.

Measured on `sedai-simulation-server#244`, which has 7 field change units:

| field | change | what the UI shows |
|---|---|---|
| `SessionService.reuseSession` | REMOVED | `0 callers · 0 callees` |
| `SessionService.resetCore` | REMOVED | `0 callers · 0 callees` |
| `DeploymentManagementService.reuseSession` | REMOVED | `0 callers · 0 callees` |
| `VclusterProperties.defaultVersion` | MODIFIED (BODY) | `0 callers · 0 callees` |
| 3 added fields | ADDED | `0 callers · 0 callees` |

All seven carry `fanIn: null`, `risk: null`, and — critically — `unknown: null`. `build.mjs`
restricts resolution to `u.kind === 'METHOD' || u.kind === 'CONSTRUCTOR'`, so fields never enter the
member list, and therefore never receive the "not resolved" marker that a capped-out method gets.

**That is a silent false negative, and it breaks the project's central invariant.** A1/A2 exist so
that a symbol we did not analyse renders as UNKNOWN rather than as SAFE. For fields the invariant is
not merely unimplemented — it is bypassed, because the code path that applies it is never reached.
A removed field reading `0 callers` says *nothing uses this*. For a removed field, nothing-uses-it
and we-never-looked have opposite consequences: the first means the deletion is clean, the second
means every unupdated reader is a compile error the tool just hid.

This is also **specified-but-unbuilt**, not a new idea. `change-graph-model` already requires
`READS_FIELD` and `WRITES_FIELD` edges; `lsp-symbol-resolution` already has a scenario for a plugin
that cannot distinguish reads from writes; `design.md` already assigns the distinction to Tier 2. The
implementation shipped `CALLS` and `TEST_COVERS` and quietly stopped. This change closes that gap and
gives the reviewer a view built for it.

The `@Value` fields above show why it matters beyond compilation. `reuseSession` and `resetCore` were
annotated `@Value("${REUSE_SESSION:false}")` and `@Value("${RESET_CORE:false}")`. Deleting them
retires two deployment configuration keys — a fact that exists nowhere in the diff, in the call graph,
or in any test, and that no reviewer reading hunks will reliably notice.

## What Changes

- **Field resolution.** Change units of kind `FIELD` and `ENUM_CONSTANT` are resolved like members
  are: position-anchored `textDocument/references` against the head image, and against the **base**
  image for REMOVED fields, which have no head-side position (A1).
- **`READS_FIELD` / `WRITES_FIELD` edges**, each carrying `file:line` evidence like every other edge.
  The read/write classification comes from tree-sitter at the reference position, inside
  `src/java/`, and is **declared as a capability** so a language that cannot make the distinction
  reports `ACCESSES` with `access: UNKNOWN` rather than guessing.
- **A usage-trace view** — the reviewer selects a changed variable and sees every read and write,
  grouped by enclosing member and file, each marked with its verdict and whether the usage site is
  inside this PR's diff or outside it. Outside-the-diff usages are the valuable ones, exactly as with
  break analysis.
- **Field-specific verdicts.** `BROKEN / UPDATED / SAFE` is the wrong vocabulary for a variable.
  `VclusterProperties.defaultVersion` changed only its initializer: every read still compiles and
  every read now returns a different value. That is neither broken nor safe, and is added as
  `VALUE_CHANGED`. Full vocabulary in `design.md`.
- **External-contract disclosure.** When a changed field carries an annotation that binds it to
  something outside the codebase — `@Value`, `@ConfigurationProperties`, `@JsonProperty`, `@Column`
  — the bound key is extracted and reported as an unresolvable consumer. The tool states that the
  key's external consumers are outside its reach; it does not attempt to find them.
- **The silent gap is fixed first, and separately.** Marking unresolved fields UNKNOWN is a
  correctness fix to the existing behaviour, not a feature of this view. It ships as task 1.1 and is
  valuable even if nothing else here is built.

### Non-goals

- **Local variables and parameters.** A local's usages cannot leave the method that declares it, so
  "trace across the PR" is not a question it has. A parameter change is already a `SIGNATURE` delta on
  its method, with the existing call-site machinery behind it. Tracing locals would add cost and
  imply a reach that does not exist.
- **Resolving external consumers** of a config key, JSON property, or column. The tool discloses the
  binding and stops. Grepping deployment repositories for `REUSE_SESSION` would produce
  name-matched guesses, and R6 forbids presenting those as resolution.
- **Dataflow.** Where a value *flows* after being read is not attempted. Reads and writes are edges,
  not a taint graph.

## Capabilities

### Modified Capabilities

- `lsp-symbol-resolution`: extend resolution to field and enum-constant declarations, including
  base-image resolution for removed fields, and declare read/write classification as a capability.
- `change-graph-model`: implement the already-specified `READS_FIELD` / `WRITES_FIELD` edge types,
  add the variable verdict vocabulary, and include field fan-in in risk scoring.
- `change-code-view`: the usage-trace view, and its lane in the impact graph.
- `java-semantic-diff`: classify a reference position as read, write, or both, and extract
  external-binding keys from field annotations.
