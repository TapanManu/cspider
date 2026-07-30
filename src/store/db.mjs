// SQLite schema and migrations (task 1.3).
//
// What is persisted, and why each thing is keyed the way it is:
//   - PR payload facts, keyed by pr + head_sha (content-addressed, never time-expired)
//   - change units, nodes, edges — derived, so safely rebuildable, cached to avoid re-resolving
//   - reviewed state and drafts — REVIEWER-AUTHORED. Never evicted, never rebuilt. This is the
//     only data in the system that cannot be recovered by re-running the analysis.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS = [
  // v1
  `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prs (
    id          TEXT PRIMARY KEY,          -- owner/repo#number
    nwo         TEXT NOT NULL,
    number      INTEGER NOT NULL,
    title       TEXT,
    url         TEXT,
    head_sha    TEXT NOT NULL,
    merge_base  TEXT NOT NULL,
    build_root  TEXT,
    analysed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS change_units (
    unit_id      TEXT NOT NULL,
    pr_id        TEXT NOT NULL,
    head_sha     TEXT NOT NULL,
    fqn          TEXT NOT NULL,
    kind         TEXT NOT NULL,
    path         TEXT NOT NULL,
    change_kind  TEXT NOT NULL,
    content_hash TEXT NOT NULL,            -- body + signature; drives reviewed-state retention
    deltas       TEXT NOT NULL,
    severity     TEXT NOT NULL,
    noise        TEXT NOT NULL,
    from_json    TEXT,
    PRIMARY KEY (pr_id, head_sha, unit_id)
  );

  CREATE TABLE IF NOT EXISTS nodes (
    node_id     TEXT NOT NULL,
    pr_id       TEXT NOT NULL,
    head_sha    TEXT NOT NULL,
    fqn         TEXT NOT NULL,
    kind        TEXT,
    path        TEXT,
    origin      TEXT NOT NULL,             -- CHANGED | CONTEXT
    change_kind TEXT,
    depth       INTEGER,
    risk        TEXT,
    fan_in      TEXT,
    break_json  TEXT,
    unknown     TEXT,
    PRIMARY KEY (pr_id, head_sha, node_id)
  );

  CREATE TABLE IF NOT EXISTS edges (
    pr_id        TEXT NOT NULL,
    head_sha     TEXT NOT NULL,
    type         TEXT NOT NULL,
    from_id      TEXT,
    to_id        TEXT,
    derived_from TEXT NOT NULL,
    verdict      TEXT,
    depth        INTEGER,
    evidence     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS edges_by_pr ON edges (pr_id, head_sha, type);

  -- Reviewer-authored. Keyed by unit_id (stable across line movement) and NOT by head_sha, so
  -- progress survives a force-push; content_hash decides whether it still applies.
  CREATE TABLE IF NOT EXISTS reviewed_state (
    pr_id        TEXT NOT NULL,
    unit_id      TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    reviewed_at  INTEGER NOT NULL,
    note         TEXT,
    PRIMARY KEY (pr_id, unit_id)
  );

  CREATE TABLE IF NOT EXISTS drafts (
    draft_id   TEXT PRIMARY KEY,
    pr_id      TEXT NOT NULL,
    unit_id    TEXT,
    path       TEXT NOT NULL,
    line       INTEGER,
    end_line   INTEGER,
    side       TEXT,
    commit_sha TEXT NOT NULL,
    body       TEXT NOT NULL,
    suggestion TEXT,
    created_at INTEGER NOT NULL,
    submitted_at INTEGER,
    submitted_review_id TEXT
  );

  -- Retention bookkeeping for on-disk artefacts (R4). Eviction is a policy over this manifest,
  -- not over cached objects in memory.
  CREATE TABLE IF NOT EXISTS cache_entries (
    path         TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,            -- clone | worktree | index | payload
    key          TEXT,
    bytes        INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS cache_by_kind ON cache_entries (kind, last_used_at);
  `,
  // v2 — persist everything a renderer needs, so a reload does not have to re-resolve.
  //
  // v1 lost two things: a node's caller list (only contract-changed nodes kept callers, inside
  // break_json) and the parsed symbol (so before/after source could not be located). Both are
  // required by the node-detail view, and re-resolving to recover them costs ~11s/symbol on a
  // monorepo — the whole reason the cache exists.
  `
  ALTER TABLE nodes ADD COLUMN callers TEXT;
  ALTER TABLE nodes ADD COLUMN test_covered INTEGER;
  ALTER TABLE nodes ADD COLUMN severity TEXT;
  ALTER TABLE change_units ADD COLUMN symbol_json TEXT;
  ALTER TABLE change_units ADD COLUMN signature_change TEXT;
  `,
  // v3 — persist the graph's own summary: blast-radius bounds and truncations, resolution health,
  // changed-line source, processor status.
  //
  // Without this, a cache-served run silently omitted its truncation warnings — so a graph that
  // was known to be incomplete would have been re-presented as complete. That is precisely the
  // failure the truncation disclosure exists to prevent, reintroduced through the cache.
  `
  ALTER TABLE prs ADD COLUMN graph_meta TEXT;
  `,
  // v4 — shared-body comments (9.7). One finding that spans several PRs is still one comment per
  // PR, each anchored to its own location, because a line number means nothing outside its repo.
  // The group id is what lets those siblings be listed, edited and withdrawn as the single finding
  // the reviewer thinks of them as.
  `
  ALTER TABLE drafts ADD COLUMN group_id TEXT;
  CREATE INDEX IF NOT EXISTS drafts_by_group ON drafts (group_id);
  `,
  // v5 — resolved variable usages, and the statement that their verdicts are not yet computed.
  //
  // Without persisting these, a cache-served run would show a field with no usages while a fresh run
  // showed twelve — the cache quietly disagreeing with a fresh analysis, which is exactly what F15
  // was about. The verdict-availability note has to persist for the same reason: restoring the
  // usages without it would turn "12 usages, verdicts unknown" into "12 usages, apparently fine".
  `
  ALTER TABLE nodes ADD COLUMN usages TEXT;
  ALTER TABLE nodes ADD COLUMN usage_verdicts TEXT;
  `,
  // v6 — the suppressed-usage disclosure (4.9).
  //
  // Same reasoning as v5, one level down. A cached run that restored the shown usages but not the
  // count of suppressed ones would present a filtered list as the whole list — the disclosure is the
  // only thing that makes the filtering legitimate, so it cannot be the part that fails to persist.
  `
  ALTER TABLE nodes ADD COLUMN usage_noise TEXT;
  `,
];

// Derived, never declared. A hand-maintained constant beside this array is a second source of
// truth, and when the two drift the stored version stops advancing — so every later `openDb` re-runs
// the last migration and dies on `duplicate column name`. Adding a migration is now one edit.
const SCHEMA_VERSION = MIGRATIONS.length;

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // meta must exist before it can be queried for the version it holds.
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const current = Number(
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 0,
  ) || 0;

  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec(MIGRATIONS[v]);
  }
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    .run('schema_version', String(SCHEMA_VERSION));

  return db;
}

export { SCHEMA_VERSION };
