## Context

`build.mjs:73` selects resolution targets with
`.filter((u) => u.kind === 'METHOD' || u.kind === 'CONSTRUCTOR')`. Everything below follows from
widening that filter honestly rather than merely widening it.

Measured starting point on `sedai-simulation-server#244`: 44 change units — 36 METHOD, 1 CONSTRUCTOR,
**7 FIELD**. So 16% of the change set is currently unanalysed, and unanalysed without saying so.

## Decisions

### D1 — The UNKNOWN fix is not part of the feature

A capped-out method gets `unknown = { reason: 'not resolved — beyond the --max-symbols cap' }`. A
field gets `unknown = null`, because it never enters `members` and so never reaches the loop that
assigns the marker. The invariant is not weakly implemented for fields; it is structurally
unreachable.

That is a correctness bug in shipped behaviour, and it is fixed first, alone, in task 1.1: every
`FIELD` unit that is not resolved gets an explicit UNKNOWN with a reason. If the rest of this change
is never built, the tool stops claiming a removed field has no readers. **A feature that also fixes a
lie should not be the only way the lie gets fixed.**

### D2 — Read/write classification is Tier 1 plus local AST, and is declared

`design.md` in the parent change assigns the `READS_FIELD` / `WRITES_FIELD` distinction to Tier 2,
reasoning that LSP alone cannot answer it. That reasoning holds — but it does not follow that Tier 2
must exist first, because we already have tree-sitter in-process for exactly this file.

The split:

- **JDT LS** answers *where* the references are. It is the only authority for that; a grep for a field
  name matches locals, unrelated fields with the same name, and strings.
- **tree-sitter**, at each resolved position, answers *what kind* of reference it is, by inspecting the
  ancestor chain of the identifier at that offset.

Classification rules, all syntactic and all local to `src/java/`:

| site | classification |
|---|---|
| identifier is the left operand of `=` | `WRITE` |
| left operand of a compound assignment (`+=`, `|=`, …) | `BOTH` — a compound assignment reads before it writes |
| operand of `++` / `--` | `BOTH` |
| anything else in an expression | `READ` |
| cannot determine the ancestor chain | `UNKNOWN`, never a default of READ |

`BOTH` and `UNKNOWN` are real values, not degenerate cases to be collapsed. A field that is only ever
read is a materially different risk from one that is written in five places, and defaulting an
undetermined site to READ would understate exactly that.

Because `lsp-symbol-resolution` already specifies that an undeclared edge type is reported as
unavailable, the Java plugin **declares** `READS_FIELD` and `WRITES_FIELD`. A future plugin that
declares only `ACCESSES` yields a usage trace that says the direction is unavailable for that
language — which is the honest rendering and needs no host change.

### D3 — A variable needs its own verdict vocabulary

Break analysis for methods asks one question: does the call site still compile against the new
signature. For a field that question misses the most common real change. `VclusterProperties.defaultVersion`
in this PR has a `BODY` delta and nothing else — a changed initializer. Every read compiles; every read
returns something different.

Verdicts for a usage site of a changed variable:

| verdict | when |
|---|---|
| `BROKEN` | the declaration is gone, renamed, or narrowed out of the usage's scope, and the usage was not updated |
| `TYPE_BROKEN` | the type changed and the usage is not assignment-compatible with the new type |
| `VALUE_CHANGED` | declaration and type intact; the initializer or assigned value changed. Compiles, behaves differently |
| `UPDATED` | the usage site is itself inside this PR's diff, so the author has already touched it |
| `SAFE` | reachable, compiles, and no value change is implied |
| `UNKNOWN` | not resolved, or resolved without a base image for a removed field (A1) |

`VALUE_CHANGED` is deliberately not folded into `SAFE`. A configuration default moving from `false` to
`true` is the kind of change that passes every test and changes production behaviour, and the tool's
job is to put it in front of the reviewer, not to certify it.

### D4 — REMOVED fields resolve against the base image, or they are UNKNOWN

Identical to A1 for methods, and the reason this matters more for fields is that three of the four
non-test field changes in the measured PR are removals. A removed field has no head-side position, so
`textDocument/references` against head cannot find its readers. With a base image, its readers are
resolved there. **Without one they are UNKNOWN — never SAFE, and never zero.** Reporting "0 usages"
for a field we could not look up is the precise failure this change exists to end.

### D5 — External bindings are disclosed, never resolved

`@Value("${REUSE_SESSION:false}")` binds a field to a key that lives in Helm charts, environment
config, and deployment pipelines. Two such fields are removed in this PR.

The tool extracts the key and states that its external consumers are outside the analysed reach. It
does not search for them. A name-match against other repositories would be a guess presented in the
same visual language as resolved edges, and R6 exists to prevent precisely that. The disclosure is
worth a great deal on its own: *this deletion retires the key `REUSE_SESSION`, whose consumers this
tool cannot see* is exactly the sentence a reviewer needs.

Annotations recognised initially: `@Value`, `@ConfigurationProperties`, `@JsonProperty`,
`@JsonAlias`, `@Column`, `@SerializedName`. The list is data, not logic, so extending it is a
one-line change and an unrecognised annotation simply produces no disclosure.

### D6 — The trace is a view over edges, not a second analysis

The usage trace renders `READS_FIELD` / `WRITES_FIELD` edges the same way the call-site list renders
`CALLS` edges: grouped by enclosing member, excerpted from the *using* file, each with a verdict and
an in-diff flag. `enclosingMember` already resolves a position to its containing method, and already
filters on LSP symbol kinds 6 and 9 — which is correct here and needs no change, because a field is
read *inside* a method.

Consequences worth stating:

- A usage in a **field initializer** or a static block has no enclosing method. Those already have a
  precedent: `orphanSites`, for call sites outside any member. They reuse it rather than being dropped.
- Fields share the `--max-symbols` budget with methods, and the cost of adding them is **repo-shaped,
  not uniform**. `references` measures ~11s/symbol on a monorepo (`sedai-core`) but ~0.4s/symbol on
  `sedai-simulation-server`. So the 7 fields in the measured PR add roughly **3 seconds** to a 34s cold
  run — cheap enough that field resolution needs no special pleading here. The same 7 fields on a
  monorepo would add over a minute.

  Task 2.4 therefore exists for the monorepo case, not this one: fields get their own share of the
  budget so they cannot silently evict methods, and per-kind omissions are reported. Sizing that share
  by the small-repo number would starve exactly the repositories where the budget binds.

### D7 — The lane, not a new pane

The impact graph already has lanes (`TESTS`, `CALLED BY`, `THIS CHANGE`, `CALLS`). A selected field
gets `READ BY` and `WRITTEN BY` lanes in the same computed layout. Writes are drawn distinctly from
reads because a write to a field you thought was read-only is the more interesting finding.

This reuses the lane machinery, the verdict colouring from F23, and the review checkboxes. A separate
pane would duplicate all three and give the reviewer a second place to look for the same kind of
answer.

## Risks

- **Field resolution is noisier than method resolution.** Common names (`log`, `name`, `id`) may
  resolve to many references. Mitigated by the existing node cap and by reporting truncation, never by
  silently trimming.
- **`this.x = x` in a constructor** is a write that says nothing. It is classified honestly as a WRITE
  and suppressed by the existing noise mechanism, which is disclosed and reversible with
  `--show-noise`, rather than being filtered out invisibly.
- **Budget contention with methods** (D6). The mitigation is disclosure plus a separate share, not a
  larger default.
- **Lombok-generated accessors** (F5b, still open) mean a field read through a generated getter may
  resolve to the getter rather than the field. This change does not fix F5b; where it applies, the
  trace says the reach is partial for that reason instead of presenting a short list as complete.
