// GitHub access via the already-authenticated `gh` CLI. No token handling in the probe.
import { execFileSync } from 'node:child_process';

const gh = (args, maxBuffer = 64 * 1024 * 1024) =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer });

export function parsePrUrl(url) {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!m) throw new Error(`not a PR url: ${url}`);
  return { owner: m[1], repo: m[2], number: Number(m[3]), nwo: `${m[1]}/${m[2]}` };
}

export function fetchPr({ nwo, number }) {
  const meta = JSON.parse(gh([
    'pr', 'view', String(number), '--repo', nwo,
    '--json', 'number,title,headRefOid,baseRefOid,baseRefName,headRefName,changedFiles,additions,deletions,url',
  ]));

  // Paginated file list — a large PR exceeds one page.
  const files = JSON.parse(gh([
    'api', '--paginate', `repos/${nwo}/pulls/${number}/files?per_page=100`,
  ]).replace(/\]\s*\[/g, ','));

  return { meta, files };
}

export function mergeBase({ nwo, base, head }) {
  const cmp = JSON.parse(gh(['api', `repos/${nwo}/compare/${base}...${head}`]));
  return cmp.merge_base_commit?.sha || base;
}

export function cloneUrl(nwo) {
  return `https://github.com/${nwo}.git`;
}
