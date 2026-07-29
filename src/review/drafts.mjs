// Review write path (tasks 9.1–9.12).
//
// Three rules, all from design D8:
//   - LOCAL FIRST. A draft never leaves the machine until an explicit, confirmed submit.
//   - ANCHORS RESOLVE AT DRAFT TIME. An unanchorable comment fails when it is written, not when it
//     is submitted — discovering it at submit time means losing a whole review's worth of work.
//   - NOTHING POSTS TO A STALE HEAD. If the PR moved, line numbers mean something else now.

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { changedLines } from '../ingest/changedLines.mjs';

export const EVENTS = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];

const defaultGh = (args, { input } = {}) =>
  execFileSync('gh', args, {
    encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });

/**
 * Can GitHub anchor an inline comment here? Only lines that appear in the PR diff are commentable:
 * RIGHT side needs an added/context line at head, LEFT side a deleted line at base.
 */
export function anchorable(clonePath, { mergeBase, headSha, files }, path, line, side = 'RIGHT') {
  const cl = changedLines(clonePath, mergeBase, headSha, files ?? []);
  if (cl.source === 'none') {
    return { ok: false, reason: 'no changed-line data — cannot tell whether this line is in the diff' };
  }
  const map = side === 'LEFT' ? cl.base : cl.head;
  const lines = map.get(path);
  if (!lines) return { ok: false, reason: `${path} is not part of this pull request's diff` };
  if (!lines.has(line)) {
    return { ok: false, reason: `line ${line} of ${path} is not in the diff, so GitHub cannot anchor a comment there` };
  }
  return { ok: true };
}

/** Wrap replacement source in a GitHub suggestion block. */
export const suggestionBody = (body, replacement) =>
  `${body ? `${body}\n\n` : ''}\`\`\`suggestion\n${replacement.replace(/\n$/, '')}\n\`\`\``;

/**
 * Create a draft. `scope` is inline when the anchor resolves, and pr-level otherwise — a caller
 * outside the diff is exactly the case break analysis cares most about, so refusing the comment
 * outright would silence the tool's most valuable finding.
 */
export function createDraft(db, { prId, pr, unitId, path, line, endLine, side = 'RIGHT', body, suggestion }, opts = {}) {
  if (!body && !suggestion) throw new Error('a draft needs a body or a suggestion');

  const check = opts.clonePath
    ? anchorable(opts.clonePath, pr, path, line, side)
    : { ok: false, reason: 'no checkout available to verify the anchor' };

  const scope = check.ok ? 'inline' : 'pr';
  const finalBody = suggestion
    ? suggestionBody(body, suggestion)
    : (scope === 'pr' ? `**${path}:${line}** — ${body}` : body);

  if (suggestion && scope === 'pr') {
    // A suggestion block only means anything anchored to the lines it replaces.
    throw new Error(`cannot suggest a change at ${path}:${line} — ${check.reason}`);
  }

  const draftId = randomUUID();
  db.prepare(`
    INSERT INTO drafts (draft_id, pr_id, unit_id, path, line, end_line, side, commit_sha, body, suggestion, created_at, group_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(draftId, prId, unitId ?? null, path, line ?? null, endLine ?? null,
    scope === 'inline' ? side : null, pr.headSha, finalBody, suggestion ?? null, Date.now(),
    opts.groupId ?? null);

  return { draftId, scope, reason: check.ok ? null : check.reason, groupId: opts.groupId ?? null };
}

/**
 * Task 9.7 — one finding, several PRs.
 *
 * "The same finding" means the same symbol, so a target is a PR whose own change units declare the
 * same FQN. A PR that does not touch that symbol is NOT a target: applying the comment there would
 * mean inventing a location, and a made-up anchor is worse than no comment. Such PRs are returned
 * as skipped with the reason, never silently dropped.
 *
 * Each target carries its OWN anchor. Line numbers are meaningless across repositories, and the
 * side follows the same rule as everywhere else (F19) — a REMOVED symbol exists only at base.
 */
export function sharedTargets(db, { fqn, sourcePrId, prs }) {
  const targets = [];
  const skipped = [];
  for (const pr of prs) {
    if (pr.prId === sourcePrId) continue;
    const match = (pr.units ?? []).find((u) => u.fqn === fqn);
    if (!match) {
      skipped.push({ prId: pr.prId, reason: `does not change ${fqn}` });
      continue;
    }
    const line = match.symbol?.range?.start?.line != null ? match.symbol.range.start.line + 1 : null;
    if (line == null) {
      skipped.push({ prId: pr.prId, reason: `no line range recorded for ${fqn}` });
      continue;
    }
    targets.push({
      prId: pr.prId, unitId: match.id, path: match.path, line,
      side: match.changeKind === 'REMOVED' ? 'LEFT' : 'RIGHT',
      changeKind: match.changeKind,
    });
  }
  return { targets, skipped };
}

/**
 * Apply one body to a finding in several PRs. Every PR's anchor is resolved independently and its
 * outcome reported per PR — one PR anchoring inline while another falls back to pr-level is normal
 * and must be visible, not averaged into a single "saved" message.
 *
 * A partial result is kept, not rolled back: the drafts that did resolve are worth having, and
 * nothing has reached GitHub yet anyway.
 */
export function createSharedDraft(db, { targets, body, suggestion }, opts = {}) {
  if (!body && !suggestion) throw new Error('a draft needs a body or a suggestion');
  if (!targets?.length) throw new Error('no target PRs for a shared comment');

  const groupId = randomUUID();
  const results = [];
  for (const t of targets) {
    try {
      const out = createDraft(db, {
        prId: t.prId, pr: t.pr, unitId: t.unitId, path: t.path,
        line: t.line, side: t.side ?? 'RIGHT', body, suggestion,
      }, { clonePath: t.clonePath ?? opts.clonePath, groupId });
      results.push({ prId: t.prId, ok: true, ...out, path: t.path, line: t.line, side: t.side });
    } catch (e) {
      // A suggestion refused outside the diff is the common case here, and it is per-PR.
      results.push({ prId: t.prId, ok: false, error: e.message, path: t.path, line: t.line });
    }
  }
  return {
    groupId,
    results,
    created: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
}

/** Every draft sharing one body, across all PRs — the finding as the reviewer conceived it. */
export const listGroup = (db, groupId) =>
  db.prepare('SELECT * FROM drafts WHERE group_id = ? ORDER BY pr_id, created_at').all(groupId).map(shape);

/** Editing a shared finding edits it everywhere it has not already been sent. */
export const updateGroup = (db, groupId, body) =>
  db.prepare('UPDATE drafts SET body = ? WHERE group_id = ? AND submitted_at IS NULL')
    .run(body, groupId).changes;

export const deleteGroup = (db, groupId) =>
  db.prepare('DELETE FROM drafts WHERE group_id = ? AND submitted_at IS NULL')
    .run(groupId).changes;

export const listDrafts = (db, prId) =>
  db.prepare('SELECT * FROM drafts WHERE pr_id = ? ORDER BY created_at').all(prId).map(shape);

const shape = (r) => ({
  draftId: r.draft_id, prId: r.pr_id, unitId: r.unit_id, path: r.path, line: r.line,
  endLine: r.end_line, side: r.side, commitSha: r.commit_sha, body: r.body,
  suggestion: r.suggestion, createdAt: r.created_at,
  submittedAt: r.submitted_at, reviewId: r.submitted_review_id,
  scope: r.side ? 'inline' : 'pr',
  groupId: r.group_id ?? null,
});

export const deleteDraft = (db, prId, draftId) =>
  db.prepare('DELETE FROM drafts WHERE pr_id = ? AND draft_id = ? AND submitted_at IS NULL')
    .run(prId, draftId).changes > 0;

export const updateDraft = (db, prId, draftId, body) =>
  db.prepare('UPDATE drafts SET body = ? WHERE pr_id = ? AND draft_id = ? AND submitted_at IS NULL')
    .run(body, prId, draftId).changes > 0;

/**
 * Task 9.8 — the exact payload, rendered for approval. This is what the reviewer confirms; it is
 * not a summary of it. Anything that would be sent and is not shown here is a bug.
 */
export function previewReview(db, prId, pr, event = 'COMMENT', reviewBody = '') {
  if (!EVENTS.includes(event)) throw new Error(`event must be one of ${EVENTS.join(', ')}`);
  const pending = listDrafts(db, prId).filter((d) => !d.submittedAt);
  const inline = pending.filter((d) => d.scope === 'inline');
  const prLevel = pending.filter((d) => d.scope === 'pr');

  const comments = inline.map((d) => ({
    path: d.path,
    line: d.line,
    ...(d.endLine && d.endLine !== d.line ? { start_line: d.line, line: d.endLine } : {}),
    side: d.side ?? 'RIGHT',
    body: d.body,
  }));

  // PR-level drafts cannot be inline comments, so they are folded into the review body where they
  // are still visible to the author, with their location stated.
  const bodyParts = [reviewBody, ...prLevel.map((d) => d.body)].filter(Boolean);

  return {
    endpoint: `POST /repos/${pr.nwo}/pulls/${pr.number}/reviews`,
    payload: {
      commit_id: pr.headSha,
      event,
      body: bodyParts.join('\n\n---\n\n'),
      comments,
    },
    counts: { inline: comments.length, prLevel: prLevel.length, total: pending.length },
    drafts: pending,
  };
}

/** Task 9.9 — the head must not have moved, or every line number means something else. */
export function headMoved(pr, gh = defaultGh) {
  const out = JSON.parse(gh(['pr', 'view', String(pr.number), '--repo', pr.nwo, '--json', 'headRefOid']));
  const current = out.headRefOid;
  return current === pr.headSha ? { moved: false, current } : { moved: true, current, was: pr.headSha };
}

/**
 * Task 9.6, 9.10 — submit. `confirmed` must be explicitly true: the default is a refusal, so a
 * missing flag can never post by accident.
 */
export function submitReview(db, prId, pr, { event = 'COMMENT', body = '', confirmed = false } = {}, gh = defaultGh) {
  if (confirmed !== true) {
    return { submitted: false, reason: 'not confirmed — nothing was sent' };
  }

  const head = headMoved(pr, gh);
  if (head.moved) {
    return {
      submitted: false,
      reason: `the pull request head moved from ${pr.headSha.slice(0, 12)} to ${head.current.slice(0, 12)}` +
        ' — re-analyse before submitting, because the line numbers in these drafts refer to the old head',
      headMoved: head,
    };
  }

  const preview = previewReview(db, prId, pr, event, body);
  if (preview.counts.total === 0 && !body) {
    return { submitted: false, reason: 'no drafts and no review body — nothing to send' };
  }

  let result;
  try {
    result = JSON.parse(gh(
      ['api', '--method', 'POST', `/repos/${pr.nwo}/pulls/${pr.number}/reviews`, '--input', '-'],
      { input: JSON.stringify(preview.payload) },
    ));
  } catch (e) {
    // Drafts are deliberately retained: a failed submit must not destroy the work.
    return {
      submitted: false,
      reason: `GitHub rejected the review: ${String(e.stderr ?? e.message).split('\n')[0]}`,
      retainedDrafts: preview.counts.total,
    };
  }

  const now = Date.now();
  const mark = db.prepare('UPDATE drafts SET submitted_at = ?, submitted_review_id = ? WHERE draft_id = ?');
  const tx = db.transaction(() => {
    for (const d of preview.drafts) mark.run(now, String(result.id ?? ''), d.draftId);
  });
  tx();

  return {
    submitted: true,
    reviewId: result.id,
    url: result.html_url,
    event,
    counts: preview.counts,
  };
}

/** Task 9.11 — existing review threads, so a node shows the conversation it already has. */
export function fetchThreads(pr, gh = defaultGh) {
  let comments;
  try {
    comments = JSON.parse(
      gh(['api', '--paginate', `/repos/${pr.nwo}/pulls/${pr.number}/comments?per_page=100`])
        .replace(/\]\s*\[/g, ','),
    );
  } catch (e) {
    return { threads: [], error: String(e.stderr ?? e.message).split('\n')[0] };
  }

  const byThread = new Map();
  for (const c of comments) {
    const key = String(c.in_reply_to_id ?? c.id);
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push({
      id: c.id, author: c.user?.login, body: c.body, path: c.path,
      line: c.line ?? c.original_line, side: c.side, createdAt: c.created_at,
      url: c.html_url,
    });
  }
  return {
    threads: [...byThread.entries()].map(([rootId, items]) => ({
      rootId: Number(rootId),
      path: items[0].path,
      line: items[0].line,
      comments: items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
    })),
    error: null,
  };
}

/** Reply to an existing thread — same confirmation discipline as a new review. */
export function replyToThread(pr, { rootId, body, confirmed = false }, gh = defaultGh) {
  if (confirmed !== true) return { sent: false, reason: 'not confirmed — nothing was sent' };
  try {
    const out = JSON.parse(gh(
      ['api', '--method', 'POST',
        `/repos/${pr.nwo}/pulls/${pr.number}/comments/${rootId}/replies`, '--input', '-'],
      { input: JSON.stringify({ body }) },
    ));
    return { sent: true, id: out.id, url: out.html_url };
  } catch (e) {
    return { sent: false, reason: String(e.stderr ?? e.message).split('\n')[0] };
  }
}
