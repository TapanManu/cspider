#!/usr/bin/env node
// cspider serve — local UI over the persisted analyses.
import { join, dirname, resolve as presolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiServer } from './server.mjs';

const ROOT = presolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = process.env.CSPIDER_CACHE || join(ROOT, '.cache');
const DB = process.env.CSPIDER_DB || join(CACHE, 'cspider.db');
const PORT = Number(process.env.PORT || process.argv.find((a) => /^\d+$/.test(a)) || 4173);

const { server, db } = createApiServer({ cacheDir: CACHE, dbPath: DB });
const prs = db.prepare('SELECT COUNT(*) c FROM prs').get().c;

server.listen(PORT, '127.0.0.1', () => {
  console.log(`cspider  http://127.0.0.1:${PORT}`);
  console.log(`  db     ${DB}`);
  console.log(`  cache  ${CACHE}`);
  console.log(`  ${prs} analysed PR(s) available` +
    (prs === 0 ? ' — run `npm run review -- <pr-url> --resolve` first' : ''));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); db.close(); process.exit(0); });
}
