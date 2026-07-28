// Gap 1: the graph stores path + range but no source text, so nothing can render a before/after.
// Everything here reads straight out of the bare clone — no worktree needed for either image.

import { execFileSync } from 'node:child_process';

const cache = new Map();   // `${sha}:${path}` -> lines[]

function fileLines(clonePath, sha, path) {
  const key = `${sha}:${path}`;
  if (cache.has(key)) return cache.get(key);
  let lines = null;
  try {
    lines = execFileSync('git', ['show', `${sha}:${path}`], {
      cwd: clonePath, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n');
  } catch {
    lines = null;   // absent at this revision
  }
  cache.set(key, lines);
  return lines;
}

/**
 * Source of one symbol at one revision.
 * @param range 0-based LSP-style { start:{line}, end:{line} }
 * @returns { text, startLine, endLine, absent } — startLine/endLine are 1-based, for display
 */
export function symbolSource(clonePath, sha, path, range) {
  const lines = fileLines(clonePath, sha, path);
  if (!lines) return { text: null, absent: true };
  const from = Math.max(0, range.start.line);
  const to = Math.min(lines.length - 1, range.end.line);
  return {
    text: lines.slice(from, to + 1).join('\n'),
    startLine: from + 1,
    endLine: to + 1,
    absent: false,
  };
}

/**
 * Before/after pair for a change unit. ADDED has no before, REMOVED has no after — the caller
 * renders an explicit empty side rather than an empty string, so "did not exist" is not confused
 * with "was blank".
 */
export function beforeAfter(clonePath, { mergeBase, headSha }, unit) {
  const headRange = unit.symbol.range;
  const baseRange = unit.from?.range ?? unit.symbol.range;
  const basePath = unit.from?.path ?? unit.path;

  const before = unit.changeKind === 'ADDED'
    ? { text: null, absent: true, reason: 'did not exist at the merge base' }
    : symbolSource(clonePath, mergeBase, basePath, baseRange);

  const after = unit.changeKind === 'REMOVED'
    ? { text: null, absent: true, reason: 'removed at head' }
    : symbolSource(clonePath, headSha, unit.path, headRange);

  return { before, after, basePath, headPath: unit.path };
}

/**
 * A call-site excerpt from the *calling* file — the thing GitHub cannot show, because the caller
 * usually is not part of the PR diff at all.
 */
export function callSiteExcerpt(clonePath, sha, path, line, context = 2) {
  const lines = fileLines(clonePath, sha, path);
  if (!lines) return { lines: [], absent: true };
  const idx = line - 1;
  const from = Math.max(0, idx - context);
  const to = Math.min(lines.length - 1, idx + context);
  return {
    absent: false,
    lines: lines.slice(from, to + 1).map((text, i) => ({
      line: from + i + 1,
      text,
      isCallSite: from + i === idx,
    })),
  };
}

/**
 * Task 8.1 — decompose a file into symbol blocks, so a file diff is an ordered list of labelled
 * blocks rather than one continuous diff. Regions between symbols become synthetic blocks, so no
 * part of the file is silently unaccounted for.
 */
export function symbolBlocks(clonePath, sha, path, symbols) {
  const lines = fileLines(clonePath, sha, path);
  if (!lines) return { blocks: [], absent: true };

  const members = symbols
    .filter((s) => s.path === path)
    .filter((s) => s.kind !== 'CLASS' && s.kind !== 'INTERFACE' && s.kind !== 'ENUM'
      && s.kind !== 'RECORD' && s.kind !== 'ANNOTATION_TYPE')
    .sort((a, b) => a.range.start.line - b.range.start.line);

  const blocks = [];
  let cursor = 0;
  const pushSynthetic = (from, to) => {
    if (to < from) return;
    const text = lines.slice(from, to + 1).join('\n');
    if (!text.trim()) return;
    blocks.push({ kind: 'SYNTHETIC', fqn: null, startLine: from + 1, endLine: to + 1, text });
  };

  for (const s of members) {
    pushSynthetic(cursor, s.range.start.line - 1);
    blocks.push({
      kind: s.kind,
      fqn: s.fqn,
      startLine: s.range.start.line + 1,
      endLine: s.range.end.line + 1,
      text: lines.slice(s.range.start.line, s.range.end.line + 1).join('\n'),
    });
    cursor = s.range.end.line + 1;
  }
  pushSynthetic(cursor, lines.length - 1);

  return { blocks, absent: false, totalLines: lines.length };
}

export const clearSourceCache = () => cache.clear();
