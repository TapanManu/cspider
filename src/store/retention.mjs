// Cache retention (R4, tasks 1.4, 1.5).
//
// A single LRU pool over everything would be wrong, because the artefacts have very different
// rebuild costs. And anything keyed by a commit SHA is content-addressed, so a TTL on it is pure
// waste — it can never go stale.
//
//   clone     no TTL, explicit prune only   re-cloning is the most expensive loss (143s measured)
//   worktree  TTL + LRU under a size cap    cheap to recreate from the clone
//   index     TTL + LRU under a size cap    2–9s to rebuild, large on disk
//   payload   short TTL, revalidated by SHA small; correctness already bounded by the SHA
//   reviewed state / drafts                 NEVER evicted — reviewer-authored, unrecoverable

import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const DAY = 24 * 60 * 60 * 1000;

export const POLICY = {
  clone: { ttlMs: null, evictable: false },
  worktree: { ttlMs: 7 * DAY, evictable: true },
  index: { ttlMs: 7 * DAY, evictable: true },
  payload: { ttlMs: 1 * DAY, evictable: true },
};

const DIR_BY_KIND = {
  clone: 'clones',
  worktree: 'worktrees',
  index: 'jdtls-data',
  payload: 'payloads',
};

function dirBytes(path) {
  let total = 0;
  const walk = (p) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isFile()) { total += st.size; return; }
    if (!st.isDirectory()) return;
    let entries;
    try { entries = readdirSync(p); } catch { return; }
    for (const e of entries) walk(join(p, e));
  };
  walk(path);
  return total;
}

/** Scan the cache directory into the manifest, recording sizes and last-used times. */
export function scanCache(db, cacheDir, nowMs = Date.now()) {
  const upsert = db.prepare(`
    INSERT INTO cache_entries (path, kind, key, bytes, created_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET bytes = excluded.bytes, last_used_at = excluded.last_used_at
  `);

  const found = [];
  for (const [kind, sub] of Object.entries(DIR_BY_KIND)) {
    const root = join(cacheDir, sub);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const full = join(root, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      const bytes = st.isDirectory() ? dirBytes(full) : st.size;
      // atime is unreliable on many systems; mtime is a safe lower bound for "last touched".
      const lastUsed = Math.max(st.mtimeMs, st.ctimeMs);
      upsert.run(full, kind, entry, bytes, Math.min(st.birthtimeMs || lastUsed, lastUsed), lastUsed);
      found.push({ path: full, kind, key: entry, bytes, lastUsed });
    }
  }

  // Drop manifest rows for artefacts that no longer exist on disk.
  for (const row of db.prepare('SELECT path FROM cache_entries').all()) {
    if (!existsSync(row.path)) db.prepare('DELETE FROM cache_entries WHERE path = ?').run(row.path);
  }
  return found;
}

export function touch(db, path) {
  db.prepare('UPDATE cache_entries SET last_used_at = ? WHERE path = ?').run(Date.now(), path);
}

/**
 * Decide what to evict. Returns a plan; nothing is deleted here.
 * @param sizeCapBytes cap across evictable kinds (worktree + index). 0 disables the cap.
 */
export function evictionPlan(db, { sizeCapBytes = 20 * 1024 ** 3, nowMs = Date.now() } = {}) {
  const rows = db.prepare('SELECT * FROM cache_entries ORDER BY last_used_at ASC').all();
  const plan = [];
  const kept = [];

  for (const r of rows) {
    const policy = POLICY[r.kind];
    if (!policy?.evictable) { kept.push(r); continue; }
    if (policy.ttlMs && nowMs - r.last_used_at > policy.ttlMs) {
      plan.push({ ...r, reason: `TTL ${Math.round(policy.ttlMs / DAY)}d exceeded` });
    } else {
      kept.push(r);
    }
  }

  if (sizeCapBytes > 0) {
    const evictable = kept
      .filter((r) => POLICY[r.kind]?.evictable)
      .sort((a, b) => a.last_used_at - b.last_used_at);
    let total = evictable.reduce((n, r) => n + r.bytes, 0);
    for (const r of evictable) {
      if (total <= sizeCapBytes) break;
      plan.push({ ...r, reason: 'size cap (least recently used)' });
      total -= r.bytes;
    }
  }

  return {
    plan,
    reclaim: plan.reduce((n, r) => n + r.bytes, 0),
    protectedKinds: Object.entries(POLICY).filter(([, v]) => !v.evictable).map(([k]) => k),
  };
}

/**
 * Task 1.5 — apply a plan. `dryRun` is the default on purpose: the reviewer is told exactly what
 * would go and how much would be reclaimed before anything is deleted.
 */
export function applyEviction(db, plan, { dryRun = true } = {}) {
  if (dryRun) return { removed: 0, bytes: 0, dryRun: true };
  let removed = 0;
  let bytes = 0;
  for (const r of plan) {
    try {
      rmSync(r.path, { recursive: true, force: true });
      db.prepare('DELETE FROM cache_entries WHERE path = ?').run(r.path);
      removed++;
      bytes += r.bytes;
    } catch { /* leave the manifest row; the next scan reconciles */ }
  }
  return { removed, bytes, dryRun: false };
}

export const humanBytes = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)}${u[i]}`;
};
