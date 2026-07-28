#!/usr/bin/env node
// cspider open <pr-url> — analyse if needed, serve, and open the browser on that PR.
//
// One command from a PR URL to the graph. The analysis is cached per head SHA, so the second run
// on the same PR skips resolution entirely (measured 34s cold, 1s warm).

import { spawn, execFile } from 'node:child_process';
import { join, dirname, resolve as presolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createApiServer } from './server/server.mjs';
import { parsePrUrl } from './ingest/pr.mjs';

const ROOT = presolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.CSPIDER_CACHE || join(ROOT, '.cache');
const DB = process.env.CSPIDER_DB || join(CACHE, 'cspider.db');

const argv = process.argv.slice(2);
const urls = argv.filter((a) => a.startsWith('http'));
const passthrough = argv.filter((a) => !a.startsWith('http'));
const has = (f) => argv.includes(`--${f}`);

if (urls.length === 0) {
  console.error(`cspider open — analyse one or more PRs and open the graph in a browser

usage:  npm start -- <pr-url> [<pr-url> ...] [options]

options:
  --depth N         blast-radius depth (default 2)
  --max-symbols N   symbols resolved per PR (default 40)
  --no-base         skip base-image resolution (removed members stay UNKNOWN)
  --no-cache        re-resolve even if a graph is cached for this head SHA
  --no-open         serve but do not launch a browser
  --port N          listen on a specific port
  --skip-analysis   serve whatever is already in the store
`);
  process.exit(2);
}

const freePort = (preferred) => new Promise((resolve) => {
  const s = createServer();
  s.once('error', () => resolve(freePort(0)));
  s.listen(preferred ?? 0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

// ------------------------------------------------------------------ 1. analyse
async function analyse() {
  const args = [join(ROOT, 'src', 'cli.mjs'), ...urls, '--resolve'];
  if (!passthrough.some((a) => a.startsWith('--depth'))) args.push('--depth', '2');
  for (const a of passthrough) {
    if (['--no-open', '--skip-analysis'].includes(a)) continue;
    args.push(a);
  }
  // Strip the value that follows --port, which belongs to this command not the CLI.
  const portIdx = args.indexOf('--port');
  if (portIdx !== -1) args.splice(portIdx, 2);

  console.log('› analysing…\n');
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`analysis exited ${code}`))));
    p.on('error', reject);
  });
}

// ------------------------------------------------------------------ 2. serve + open
async function serve() {
  const portArg = argv[argv.indexOf('--port') + 1];
  const port = await freePort(has('port') ? Number(portArg) : 4173);
  const { server, db } = createApiServer({ cacheDir: CACHE, dbPath: DB });

  // Deep-link to the first PR given, so the browser lands on the graph rather than a picker.
  const first = parsePrUrl(urls[0]);
  const prId = `${first.nwo}#${first.number}`;
  const known = db.prepare('SELECT 1 FROM prs WHERE id = ?').get(prId);
  const target = `http://127.0.0.1:${port}/${known ? `?pr=${encodeURIComponent(prId)}` : ''}`;

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const count = db.prepare('SELECT COUNT(*) c FROM prs').get().c;
  console.log(`\n› ${target}`);
  console.log(`  ${count} analysed PR(s) in ${DB}`);
  if (!known) console.log('  ⚠ that PR is not in the store — the picker will open instead');
  console.log('  ctrl-c to stop\n');

  if (!has('no-open')) {
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start' : 'xdg-open';
    execFile(opener, [target], (err) => {
      if (err) console.log(`  (could not launch a browser: ${err.message} — open the URL above)`);
    });
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { server.close(); db.close(); process.exit(0); });
  }
}

if (!has('skip-analysis')) await analyse();
await serve();
