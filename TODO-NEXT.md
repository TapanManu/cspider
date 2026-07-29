# Open issues — picked up 2026-07-30

Two things found while reviewing PR 244 in the UI. Issue 2 is **partly diagnosed**; the measurements
below are the point of this note, so tomorrow does not start by re-measuring.

---

## 1. The `Usages` heading is clipped by the sticky header

**Symptom** (screenshot): selecting `DeploymentManagementService#reuseSession`, the
`USAGES 1 · 1 in this PR` heading renders half-hidden behind the sticky title block — you see the
bottom of the glyphs only.

**Cause, unconfirmed but likely:** `renderDetail` wraps the title in `<div class="stick">`
(`position: sticky`), and `usagesHtml()` emits a plain `<h4>`. The `h4` scrolls under the sticky block
because the sticky element has no opaque backdrop covering the full row height, or the `h4` lacks
`scroll-margin-top`. Note the same `<h4>` pattern is used by *Call sites*, *Conversation*, *Facts* and
*Deltas*, so if those are also clipped this is a general fix in `.stick` / `#detail h4`, not something
specific to Usages.

**Where:** `src/server/public/style.css` (`.stick`, `#detail h4`), `src/server/public/app.js`
(`usagesHtml`, ~line 700).

**Suggested fix:** give `.stick` a solid `background: var(--panel)` and a `z-index` above the content,
and add `scroll-margin-top` to `#detail h4` equal to the sticky block's height. Verify against a long
`Usages` list where scrolling actually happens.

---

## 2. Reported 10–20s before the UI is interactive

**The request was "can we paginate the APIs". On the evidence so far, pagination would fix nothing —
the API is not where the time goes.** Measured on the running server, PR 244 (44 units, 107 nodes,
256 edges):

| endpoint | time | size |
|---|---|---|
| `/api/prs` | 1.5 ms | 0.5 KB |
| `/api/pr/:id` | 2 ms | 1 KB |
| `/api/pr/:id/files` | 2 ms | 20 KB |
| `/api/pr/:id/graph` | 2 ms | 145 KB |
| `/api/pr/:id/order` | 11 ms | 18 KB |
| `/api/pr/:id/ego?id=` | 2 ms | 10 KB |
| `/api/pr/:id/node?id=` | 53 ms cold, 3 ms warm | 27 KB |
| `/api/pr/:id/threads` | **1100 ms** | 0.6 KB |

Other phases measured:

- `ingestPr` with a warm payload cache: **1040 ms** (one `gh pr view` call, then a cache hit)
- `git fetch` on the clone: **2.1 s** (clone is only 4.4 MB)
- cache-hit graph load: instant, and it correctly `continue`s **before** constructing `JavaResolver`,
  so a cached run does **not** start jdtls — ruled out as the cause
- warm `npm start` end to end: roughly **2–3 s** to serving

So a warm start is seconds and every endpoint is milliseconds. **The 10–20 s was not reproduced.**

### Candidates still unchecked

1. **Stale payload cache.** `ingestPr` keys on `pr_id + head_sha` and always runs `gh pr view` first
   (~1 s). On a miss it adds a paginated `pulls/:n/files` call plus a `compare` call, and `ensureClone`
   may `git fetch` (2 s here). Plausibly 5–10 s combined on a first run of the day. **Check
   `src/ingest/pr.mjs:22-45`.**
2. **The re-resolve path.** If the cached graph's params are narrower than the flags asked for,
   `cli.mjs:254-281` re-resolves — that is the ~90 s cold path, and it prints a yellow
   "re-resolving" line to stderr. **Ask which command was run, and check for that line.** Running
   `npm start` *without* `--resolve` after a resolved run is worth testing specifically.
3. **Browser-side.** Not measured at all — no DOM harness. `renderFiles()` rebuilds the whole tree on
   every checkbox toggle and every expand/collapse, and `setReviewed` triggers a `/files` refetch plus
   `renderFiles` + `renderBanners` + `focus()` (which refetches `/ego` and `/node`). Each request is
   milliseconds, but the render work is unmeasured. Also check for a render loop:
   `renderFiles()` → `markSelectedRow()` → `renderFiles()` is guarded, but the guard has not been
   verified under real interaction.
4. **`/threads` at 1.1 s** is the one genuinely slow endpoint (a `gh api --paginate` network call). It
   is already fired non-blocking after first paint and re-renders the detail pane on arrival, so it
   should not delay interactivity — worth confirming it is not awaited anywhere.

### How to resume

Get the actual reproduction first: **the exact command, and whether the console shows
`graph from cache` or `resolving …`.** That single line separates candidate 1/3 from candidate 2 and
decides whether any of this is an API problem at all.

If it turns out to be ingest (candidate 1), the fix is not pagination but avoiding the work: the
`gh pr view` call on every start is what makes even a fully cached run cost a second, and the head-SHA
check it performs could be skipped or backgrounded when a graph for that SHA already exists. If it
turns out to be browser-side (candidate 3), the fix is incremental DOM updates instead of full
`renderFiles()` rebuilds.

**Do not paginate on the current evidence.** It would add a bounded-result disclosure obligation (per
the project's own invariants, a truncated list must say so) in exchange for shaving milliseconds off
calls that are already fast.

---

## Also still open, from the plan

`openspec/changes/variable-usage-tracing` is at 16/42. Groups 3, 4 and 6 remain: read/write direction,
the verdict vocabulary (including `VALUE_CHANGED`, which `VclusterProperties.defaultVersion` is waiting
on — 9 usages, 6 outside the diff), and the grouped trace view with lanes. Task 2.1a is new: enum
constants are not change units at all, because `enum_constant` is absent from the parser's node map.
