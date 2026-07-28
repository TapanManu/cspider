// A3: which lines did this PR touch — on BOTH sides of the diff?
//
// UPDATED vs BROKEN hinges on this. Two traps:
//
//  1. GitHub's `patch` field is OMITTED for very large diffs. Relying on it alone would make every
//     call site in such a file read as not-updated — confident false BROKEN. So git is the source
//     of truth (we already have the clone) and `patch` is only a fallback.
//
//  2. Head-side and base-side line numbers are NOT interchangeable. Callers of a REMOVED member are
//     resolved against the base image and therefore carry base-side line numbers. Checking those
//     against head-side changed lines produces garbage verdicts, so both sides are tracked.

import { execFileSync } from 'node:child_process';

function parseUnifiedDiff(diffText) {
  const head = new Map();
  const base = new Map();
  let file = null;
  let headLine = 0;
  let baseLine = 0;

  for (const line of diffText.split('\n')) {
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fileMatch) {
      file = fileMatch[1] === '/dev/null' ? null : fileMatch[1];
      if (file) {
        if (!head.has(file)) head.set(file, new Set());
        if (!base.has(file)) base.set(file, new Set());
      }
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { baseLine = Number(hunk[1]); headLine = Number(hunk[2]); continue; }
    if (!file) continue;
    if (line.startsWith('\\')) continue;                       // "\ No newline at end of file"
    if (line.startsWith('+') && !line.startsWith('+++')) {
      head.get(file).add(headLine); headLine++; continue;      // added head line
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      base.get(file).add(baseLine); baseLine++; continue;      // deleted base line
    }
    headLine++; baseLine++;                                    // context on both sides
  }
  return { head, base };
}

/**
 * @returns { head: Map<path, Set<line>>, base: Map<path, Set<line>>, source: 'git'|'patch'|'none' }
 *
 * `head` — lines added at head. A caller resolved against the HEAD image that sits on one of these
 *          was itself edited by this PR, so a contract change there is UPDATED.
 * `base` — lines deleted from base. A caller resolved against the BASE image that sits on one of
 *          these no longer exists as written, so it was dealt with: also UPDATED.
 */
export function changedLines(clonePath, mergeBase, headSha, files) {
  try {
    const diff = execFileSync('git', [
      'diff', '--unified=0', '--no-color', '--no-ext-diff', `${mergeBase}..${headSha}`,
    ], { cwd: clonePath, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return { ...parseUnifiedDiff(diff), source: 'git' };
  } catch {
    const head = new Map();
    const base = new Map();
    let anyPatch = false;
    for (const f of files) {
      if (!f.patch) continue;
      anyPatch = true;
      const sub = parseUnifiedDiff(`+++ b/${f.filename}\n${f.patch}`);
      head.set(f.filename, sub.head.get(f.filename) ?? new Set());
      base.set(f.filename, sub.base.get(f.filename) ?? new Set());
    }
    return { head, base, source: anyPatch ? 'patch' : 'none' };
  }
}

export const filesWithoutPatch = (files) => files.filter((f) => !f.patch).map((f) => f.filename);
