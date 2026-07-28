// Clone once per repo, then create a worktree per SHA. Mirrors the design's checkout stage.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const run = (cwd, args, timeout = 30 * 60 * 1000) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });

export function ensureClone(cacheDir, nwo, url) {
  const clonesDir = join(cacheDir, 'clones');
  mkdirSync(clonesDir, { recursive: true });
  const dest = join(clonesDir, nwo.replace('/', '__'));
  if (!existsSync(join(dest, 'HEAD')) && !existsSync(join(dest, '.git'))) {
    run(clonesDir, ['clone', '--bare', '--filter=blob:none', url, dest]);
  }
  return dest;
}

export function fetchSha(clonePath, sha) {
  try {
    run(clonePath, ['cat-file', '-e', `${sha}^{commit}`]);
    return;
  } catch { /* not present yet */ }
  run(clonePath, ['fetch', 'origin', sha]);
}

export function ensureWorktree(cacheDir, nwo, clonePath, sha) {
  const wtDir = join(cacheDir, 'worktrees', `${nwo.replace('/', '__')}@${sha.slice(0, 12)}`);
  if (existsSync(wtDir)) return wtDir;
  mkdirSync(join(cacheDir, 'worktrees'), { recursive: true });
  fetchSha(clonePath, sha);
  run(clonePath, ['worktree', 'add', '--detach', wtDir, sha]);
  return wtDir;
}
