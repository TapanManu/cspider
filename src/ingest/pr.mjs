// PR ingestion (tasks 2.1, 2.3, 2.4, 2.5, 2.5a) — GitHub via the authenticated `gh` CLI.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const gh = (args, maxBuffer = 64 * 1024 * 1024) =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
const git = (cwd, args, timeout = 30 * 60 * 1000) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });

export function parsePrUrl(url) {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!m) throw new Error(`not a PR url: ${url}`);
  return { owner: m[1], repo: m[2], number: Number(m[3]), nwo: `${m[1]}/${m[2]}` };
}

// Task 2.3: content-addressed cache keyed by pr_id + head_sha. One cheap call resolves the
// head SHA; everything else is served from disk when it has not moved.
function cachePath(cache, nwo, number, sha) {
  return join(cache, 'payloads', nwo.replace('/', '__'), `${number}@${sha}.json`);
}

export function ingestPr(cache, url) {
  const pr = parsePrUrl(url);
  const meta = JSON.parse(gh([
    'pr', 'view', String(pr.number), '--repo', pr.nwo,
    '--json', 'number,title,headRefOid,baseRefOid,baseRefName,headRefName,changedFiles,additions,deletions,url,author',
  ]));

  const cp = cachePath(cache, pr.nwo, pr.number, meta.headRefOid);
  if (existsSync(cp)) {
    return { ...JSON.parse(readFileSync(cp, 'utf8')), fromCache: true };
  }

  const files = JSON.parse(
    gh(['api', '--paginate', `repos/${pr.nwo}/pulls/${pr.number}/files?per_page=100`])
      .replace(/\]\s*\[/g, ','),
  );
  const cmp = JSON.parse(gh(['api', `repos/${pr.nwo}/compare/${meta.baseRefOid}...${meta.headRefOid}`]));
  const mergeBase = cmp.merge_base_commit?.sha || meta.baseRefOid;

  const payload = { pr, meta, files, mergeBase };
  mkdirSync(dirname(cp), { recursive: true });
  writeFileSync(cp, JSON.stringify(payload));
  return { ...payload, fromCache: false };
}

export function ensureClone(cache, nwo) {
  const clonesDir = join(cache, 'clones');
  mkdirSync(clonesDir, { recursive: true });
  const dest = join(clonesDir, nwo.replace('/', '__'));
  if (!existsSync(join(dest, 'HEAD'))) {
    git(clonesDir, ['clone', '--bare', '--filter=blob:none', `https://github.com/${nwo}.git`, dest]);
  }
  return dest;
}

export function ensureWorktree(cache, nwo, clonePath, sha) {
  const dir = join(cache, 'worktrees', `${nwo.replace('/', '__')}@${sha.slice(0, 12)}`);
  if (existsSync(dir)) return dir;
  mkdirSync(join(cache, 'worktrees'), { recursive: true });
  try { git(clonePath, ['cat-file', '-e', `${sha}^{commit}`]); }
  catch { git(clonePath, ['fetch', 'origin', sha]); }
  git(clonePath, ['worktree', 'add', '--detach', dir, sha]);
  return dir;
}

// Task 2.5a (F4): the build root is not the repo root in most real repos. Two of the four
// SM-1182 repos build from a subdirectory, and initialising a language server on the repo
// root silently skips the project import.
export function detectBuildRoots(repoRoot, changedPaths) {
  const BUILD_FILES = ['pom.xml', 'build.gradle', 'build.gradle.kts'];
  const hasBuildFile = (dir) => BUILD_FILES.some((f) => existsSync(join(repoRoot, dir, f)));

  if (hasBuildFile('.')) return { primary: '.', all: ['.'], uncovered: [] };

  const roots = new Set();
  const orphans = [];
  for (const p of changedPaths) {
    let dir = dirname(p);
    let found = null;
    while (dir && dir !== '.' && dir !== '/') {
      if (hasBuildFile(dir)) { found = dir; break; }
      dir = dirname(dir);
    }
    if (found) roots.add(found); else orphans.push(p);
  }
  if (roots.size === 0) return { primary: '.', all: ['.'], uncovered: orphans, noBuildFile: true };

  const all = [...roots].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return {
    primary: all[0],
    all,
    // Everything outside the primary root is NOT analyzed. Say so rather than implying coverage.
    uncovered: [...all.slice(1), ...orphans],
  };
}

// Read a file at a given git revision without checking out a second worktree.
export function readAtRev(clonePath, sha, path) {
  try {
    return execFileSync('git', ['show', `${sha}:${path}`], {
      cwd: clonePath, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // absent at this revision — an added file
  }
}
