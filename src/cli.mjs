#!/usr/bin/env node
// cspider — Phase A: semantic change units for one or more PRs, as an ordered review list.
//
// Deliberately no graph, no resolution, no comments yet. What it gives you that GitHub does not:
// the change expressed as symbols and typed deltas rather than text hunks, and producer↔consumer
// links across the PRs in the set.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve as presolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestPr, ensureClone, detectBuildRoots, readAtRev } from './ingest/pr.mjs';
import { parseSymbols, parseImports } from './java/parse.mjs';
import { diffSymbols, classifyNoise } from './java/diff.mjs';
import { provisionalSeverity, orderUnits, bySeverity, correlateCrossRepo } from './review/order.mjs';
import { JavaResolver, jdtlsAvailable } from './java/resolve.mjs';
import { buildGraph, scoreRisk, coChangedEdges, topologicalOrder, expandBlastRadius } from './graph/build.mjs';
import { changedLines, filesWithoutPatch } from './ingest/changedLines.mjs';
import { openDb } from './store/db.mjs';
import { saveAnalysis, loadReviewed, markReviewed, unmarkReviewed, loadGraph, loadGraphMeta, progress } from './store/persist.mjs';
import { scanCache, evictionPlan, applyEviction, humanBytes } from './store/retention.mjs';
import { ensureWorktree } from './ingest/pr.mjs';

const ROOT = presolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.CSPIDER_CACHE || join(ROOT, '.cache');

const argv = process.argv.slice(2);
const urls = argv.filter((a) => a.startsWith('http'));
const has = (f) => argv.includes(`--${f}`);
const flag = (f, d) => { const i = argv.indexOf(`--${f}`); return i === -1 ? d : argv[i + 1]; };

const DB_PATH = process.env.CSPIDER_DB || join(CACHE, 'cspider.db');

if (argv.includes('--prune')) {
  const db = openDb(DB_PATH);
  const found = scanCache(db, CACHE);
  const { plan, reclaim, protectedKinds } = evictionPlan(db, {
    sizeCapBytes: Number(process.env.CSPIDER_CACHE_CAP ?? 20 * 1024 ** 3),
  });

  const byKind = new Map();
  for (const f of found) {
    const cur = byKind.get(f.kind) ?? { n: 0, bytes: 0 };
    byKind.set(f.kind, { n: cur.n + 1, bytes: cur.bytes + f.bytes });
  }
  console.log(`cache at ${CACHE}`);
  for (const [kind, v] of [...byKind].sort((a, b) => b[1].bytes - a[1].bytes)) {
    const prot = protectedKinds.includes(kind) ? '  (never evicted)' : '';
    console.log(`  ${kind.padEnd(9)} ${String(v.n).padStart(3)} entr(ies)  ${humanBytes(v.bytes).padStart(8)}${prot}`);
  }
  const total = [...byKind.values()].reduce((n, v) => n + v.bytes, 0);
  console.log(`  ${'total'.padEnd(9)} ${''.padStart(3)}            ${humanBytes(total).padStart(8)}\n`);

  if (plan.length === 0) {
    console.log('nothing to reclaim — all evictable entries are within TTL and under the size cap.');
  } else {
    console.log(`${plan.length} cache entr(ies), ${humanBytes(reclaim)} reclaimable:`);
    for (const r of plan) console.log(`  ${r.kind.padEnd(9)} ${humanBytes(r.bytes).padStart(7)}  ${r.key}  — ${r.reason}`);
    console.log(`\nnever evicted: ${protectedKinds.join(', ')}, reviewed state, drafts`);
    if (argv.includes('--yes')) {
      const res = applyEviction(db, plan, { dryRun: false });
      console.log(`\nremoved ${res.removed} entr(ies), reclaimed ${humanBytes(res.bytes)}`);
    } else {
      console.log('\nnothing deleted. re-run with --prune --yes to apply.');
    }
  }
  process.exit(0);
}

if (urls.length === 0) {
  console.error(`cspider — PR semantic change reader (Phase A)

usage:  node src/cli.mjs <pr-url> [<pr-url> ...] [options]

options:
  --by-severity     order by provisional severity instead of file/containment
  --show-noise      include suppressed low-signal units
  --resolve         resolve callers and run break analysis (starts jdtls; slower)
  --no-cache        ignore any cached graph for this head SHA and re-resolve
  --no-base         skip base-image resolution (removed members stay UNKNOWN, faster)
  --topo            order by callers-before-callees instead of file/containment
  --depth N         blast-radius depth (default 2, 0 disables expansion)
  --max-nodes N     total node ceiling for expansion (default 400)
  --max-symbols N   cap symbols resolved per PR (default 40)
  --reviewed <fqn>  mark matching change unit(s) reviewed (substring match) and exit
  --unreviewed <fqn> clear the reviewed mark for matching unit(s) and exit
  --progress        show review progress only
  --prune           report reclaimable cache, then delete with --yes
  --json <path>     write the full analysis as JSON
`);
  process.exit(2);
}

const C = process.stdout.isTTY
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`,
      mag: (s) => `\x1b[35m${s}\x1b[0m` }
  : Object.fromEntries(['dim', 'bold', 'red', 'green', 'yellow', 'cyan', 'mag'].map((k) => [k, (s) => s]));

const KIND_TAG = {
  ADDED: C.green('+ ADDED   '),
  REMOVED: C.red('- REMOVED '),
  MODIFIED: C.yellow('~ MODIFIED'),
  MOVED: C.cyan('→ MOVED   '),
  RENAMED: C.cyan('→ RENAMED '),
};

const db = openDb(DB_PATH);
const analyses = [];
const failures = [];

for (const url of urls) {
  // Task 2.4: one bad PR must not abort the batch.
  try {
    analyses.push(analyzeOne(url));
  } catch (e) {
    failures.push({ url, error: e.message.split("\n")[0], stack: e.stack });
    console.error(C.red(`FAILED ${url}: ${e.message.split('\n')[0]}`));
    if (has('debug')) console.error(e.stack);
  }
}

function analyzeOne(url) {
  const { pr, meta, files, mergeBase, fromCache } = ingestPr(CACHE, url);
  const key = `${pr.repo}#${pr.number}`;
  const clone = ensureClone(CACHE, pr.nwo);

  const javaFiles = files.filter((f) => f.filename.endsWith('.java'));
  const otherFiles = files.filter((f) => !f.filename.endsWith('.java'));
  const buildRoots = detectBuildRoots(
    ensureWorktreeLite(clone, meta.headRefOid), javaFiles.map((f) => f.filename),
  );

  // Both images are read straight out of git — no second worktree needed.
  const baseTables = new Map();
  const headTables = new Map();
  const imports = [];
  const parseErrors = [];

  for (const f of javaFiles) {
    if (f.status !== 'added') {
      const src = readAtRev(clone, mergeBase, f.filename);
      if (src !== null) {
        const t = parseSymbols(src, f.filename);
        baseTables.set(f.filename, t);
        if (t.parseError) parseErrors.push({ image: 'base', ...t.parseError });
        if (t.completeness) parseErrors.push({ image: 'base', fatal: true, ...t.completeness });
      }
    }
    if (f.status !== 'removed') {
      const src = readAtRev(clone, meta.headRefOid, f.filename);
      if (src !== null) {
        const t = parseSymbols(src, f.filename);
        headTables.set(f.filename, t);
        if (t.parseError) parseErrors.push({ image: 'head', ...t.parseError });
        if (t.completeness) parseErrors.push({ image: 'head', fatal: true, ...t.completeness });
        for (const imp of parseImports(src)) imports.push({ ...imp, path: f.filename });
      }
    }
  }

  const { units, suggestions } = diffSymbols(pr.nwo, baseTables, headTables);
  for (const u of units) {
    u.severity = provisionalSeverity(u);
    u.noise = classifyNoise(u);
  }

  return {
    key, pr, meta, mergeBase, fromCache, buildRoots,
    files: javaFiles.map((f) => ({ filename: f.filename, patch: f.patch, status: f.status })),
    clone,
    counts: { changedFiles: files.length, javaFiles: javaFiles.length, otherFiles: otherFiles.length },
    otherFiles: otherFiles.map((f) => ({ path: f.filename, status: f.status })),
    units, suggestions, imports, parseErrors,
  };
}

// A worktree is only needed so build-file detection can stat the tree; reuse an existing one.
function ensureWorktreeLite(clone, sha) {
  const dir = join(CACHE, 'worktrees', `${clone.split('/').pop()}@${sha.slice(0, 12)}`);
  if (existsSync(dir)) return dir;
  mkdirSync(join(CACHE, 'worktrees'), { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: clone, stdio: 'ignore' });
  try { git(['cat-file', '-e', `${sha}^{commit}`]); } catch { git(['fetch', 'origin', sha]); }
  git(['worktree', 'add', '--detach', dir, sha]);
  return dir;
}

// ---------------------------------------------------- persist + reviewed state (1.3, 6.11)
for (const a of analyses) {
  a.prId = `${a.pr.nwo}#${a.pr.number}`;
  a.reviewed = loadReviewed(db, a.prId, a.units);
  a.progress = progress(a.units, a.reviewed);
}

// --reviewed / --unreviewed act on the ingested units and exit; no resolution needed.
for (const [fl, fn] of [['reviewed', markReviewed], ['unreviewed', null]]) {
  if (!has(fl)) continue;
  const needle = flag(fl, '');
  if (!needle || needle.startsWith('--')) {
    console.error(`--${fl} needs a substring to match against change-unit FQNs`);
    process.exit(2);
  }
  let n = 0;
  for (const a of analyses) {
    for (const u of a.units) {
      if (!u.fqn.toLowerCase().includes(needle.toLowerCase())) continue;
      if (fn) markReviewed(db, a.prId, u); else unmarkReviewed(db, a.prId, u.id);
      console.log(`${fn ? 'reviewed' : 'cleared '}  ${u.fqn}  [${a.key}]`);
      n++;
    }
  }
  if (n === 0) console.log(`no change unit matched "${needle}"`);
  else {
    for (const a of analyses) {
      const r = loadReviewed(db, a.prId, a.units);
      const pg = progress(a.units, r);
      console.log(`\n${a.key}: ${pg.done}/${pg.total} reviewed`);
    }
  }
  process.exit(0);
}

if (has('progress')) {
  for (const a of analyses) {
    const pg = a.progress;
    console.log(`${a.key.padEnd(32)} ${pg.done}/${pg.total} reviewed` +
      (pg.stale ? `  ${pg.stale} stale (symbol changed since review)` : '') +
      (pg.orphaned ? `  ${pg.orphaned} orphaned (symbol no longer in the PR)` : ''));
  }
  process.exit(0);
}

// ------------------------------------------------------------------ resolve
const crossRepo = correlateCrossRepo(analyses);
const explainedFqns = new Set(crossRepo.map((e) => e.to.fqn));

if (has('resolve')) {
  if (!jdtlsAvailable()) {
    console.error(C.red('jdtls not installed — run: npm run jdtls'));
    process.exit(1);
  }
  for (const a of analyses) {
    // A graph cached for this exact head SHA is content-addressed, so reusing it is safe — and
    // it is the difference between seconds and minutes on a monorepo.
    if (!has('no-cache')) {
      const cached = loadGraph(db, a.prId, a.meta.headRefOid);
      if (cached) {
        a.graph = cached;
        a.fromGraphCache = true;
        // Restore the disclosures too, or a cached run would present an incomplete graph as complete.
        const gm = loadGraphMeta(db, a.prId, a.meta.headRefOid);
        if (gm) {
          a.graph.blastRadius = gm.blastRadius;
          a.graph.truncations = gm.truncations ?? [];
          a.health = gm.health;
          a.touchedSource = gm.touchedSource;
          a.processor = gm.processor;
        }
        process.stderr.write(C.dim(`${a.key}: graph from cache (${cached.nodes.size} nodes, ${cached.edges.length} edges)\n`));
        continue;
      }
    }
    const root = join(CACHE, 'worktrees',
      `${a.pr.nwo.replace('/', '__')}@${a.meta.headRefOid.slice(0, 12)}`);
    const projectRoot = a.buildRoots.primary === '.' ? root : join(root, a.buildRoots.primary);
    const prefix = a.buildRoots.primary === '.' ? '' : a.buildRoots.primary;
    const relPaths = a.files.map((f) => (prefix ? f.filename.slice(prefix.length + 1) : f.filename));

    // A3: changed lines from git, not from GitHub's optional `patch` field.
    const cl = changedLines(a.clone, a.mergeBase, a.meta.headRefOid, a.files);
    a.touchedSource = cl.source;
    a.missingPatch = filesWithoutPatch(a.files);

    process.stderr.write(C.dim(`resolving ${a.key} (lines from ${cl.source}) …`));
    const dataKey = `${a.pr.nwo.replace('/', '__')}@${a.meta.headRefOid.slice(0, 12)}`;
    const resolver = new JavaResolver({
      projectRoot,
      dataDir: join(CACHE, 'jdtls-data', dataKey),
      trace: has('debug'),
    });

    // A1: REMOVED members have no head-side position, so their callers need the BASE image.
    // Q1 measured indexing at 2–9s, which is what makes a second index affordable.
    const needsBase = !has('no-base') && a.units.some((u) => u.changeKind === 'REMOVED'
      && (u.kind === 'METHOD' || u.kind === 'CONSTRUCTOR') && u.noise.length === 0);
    let baseResolver = null;

    try {
      await resolver.start();
      const ready = await resolver.waitReady();
      for (const rp of relPaths) resolver.open(rp);
      await new Promise((r) => setTimeout(r, 2500)); // let diagnostics publish
      a.processor = await resolver.assertProcessorWorking(relPaths);
      a.health = resolver.health(relPaths, explainedFqns);

      if (needsBase) {
        process.stderr.write(C.dim(' +base'));
        const baseWt = ensureWorktree(CACHE, a.pr.nwo, a.clone, a.mergeBase);
        const baseRoot = a.buildRoots.primary === '.' ? baseWt : join(baseWt, a.buildRoots.primary);
        baseResolver = new JavaResolver({
          projectRoot: baseRoot,
          dataDir: join(CACHE, 'jdtls-data', `${a.pr.nwo.replace('/', '__')}@base-${a.mergeBase.slice(0, 12)}`),
          trace: has('debug'),
        });
        await baseResolver.start();
        await baseResolver.waitReady();
        for (const rp of relPaths) baseResolver.open(rp);
        await new Promise((r) => setTimeout(r, 1500));
      }

      a.graph = await buildGraph(a, { head: resolver, base: baseResolver }, {
        maxSymbols: Number(flag('max-symbols', 40)),
        buildRootPrefix: prefix,
        touchedHead: cl.head,
        touchedBase: cl.base,
        touchedSource: cl.source,
        queryBudget: Number(flag('query-budget', 400)),
      });
      for (const n of a.graph.nodes.values()) if (n.callers) n.risk = scoreRisk(n);

      // Task 6.3: expand the blast radius after break analysis, so the seeds already have callers.
      const depth = Number(flag('depth', 2));
      if (depth > 0) {
        process.stderr.write(C.dim(` expanding d${depth}`));
        await expandBlastRadius(a.graph, resolver, {
          depth,
          maxNodes: Number(flag('max-nodes', 400)),
          queryBudget: Number(flag('expand-budget', 300)),
          buildRootPrefix: prefix,
        });
      }
      a.coChanged = coChangedEdges(a.clone, a.files.map((f) => f.filename));
      a.topo = topologicalOrder(a.graph.nodes, a.graph.edges);
      a.resolveReady = ready;
      process.stderr.write(C.dim(` ${a.graph.queries} queries, health ${a.health.verdict}\n`));
    } catch (e) {
      a.resolveError = e.message;
      process.stderr.write(C.red(` FAILED: ${e.message.split('\n')[0]}\n`));
    } finally {
      await resolver.stop();
      await baseResolver?.stop();
    }
  }
}

// 6.13: overlap is disclosed on every affected PR's own view, not only in a merged view.
{
  const byFqn = new Map();
  for (const a of analyses) {
    for (const u of a.units) {
      if (!byFqn.has(u.fqn)) byFqn.set(u.fqn, new Set());
      byFqn.get(u.fqn).add(a.key);
    }
  }
  for (const a of analyses) {
    a.overlaps = a.units
      .filter((u) => (byFqn.get(u.fqn)?.size ?? 0) > 1)
      .map((u) => ({ fqn: u.fqn, others: [...byFqn.get(u.fqn)].filter((k) => k !== a.key) }));
  }
}

// ------------------------------------------------------------------ report

for (const a of analyses) {
  const shown = has('show-noise') ? a.units : a.units.filter((u) => u.noise.length === 0);
  const suppressed = a.units.length - shown.length;
  let ordered = has('by-severity') ? bySeverity(shown) : orderUnits(shown);
  if (has('topo') && a.topo) {
    const rank = new Map(a.topo.ordered.map((n, i) => [n.id, i]));
    ordered = [...shown].sort((x, y) => (rank.get(x.id) ?? 1e9) - (rank.get(y.id) ?? 1e9));
  }

  console.log(`\n${C.bold(`━━ ${a.key}`)}  ${a.meta.title}`);
  console.log(C.dim(`   ${a.meta.url}`));
  console.log(C.dim(`   head ${a.meta.headRefOid.slice(0, 12)}  base ${a.mergeBase.slice(0, 12)}` +
    `  ${a.fromCache ? '(cached)' : '(fetched)'}`));
  console.log(C.dim(`   ${a.counts.javaFiles} java of ${a.counts.changedFiles} changed files` +
    `  ·  build root: ${a.buildRoots.primary}`));

  if (a.overlaps?.length) {
    console.log(C.yellow(`   ⚠ ${a.overlaps.length} symbol(s) also changed by another ingested PR:`));
    for (const o of a.overlaps.slice(0, 5)) {
      console.log(C.yellow(`     ${shortFqn(o.fqn)} ${C.dim(`— also in ${o.others.join(', ')}`)}`));
    }
  }
  if (a.buildRoots.uncovered.length) {
    console.log(C.yellow(`   ⚠ not covered by the primary build root: ${a.buildRoots.uncovered.join(', ')}`));
  }
  const fatalParse = a.parseErrors.filter((e) => e.fatal);
  const softParse = a.parseErrors.filter((e) => !e.fatal);
  if (fatalParse.length) {
    console.log(C.red(`   ✗ ${fatalParse.length} file(s) FAILED to parse completely — results are incomplete:`));
    for (const e of fatalParse.slice(0, 4)) {
      console.log(C.red(`     ${e.path} (${e.image}, ${e.bytes} bytes): ${e.message}`));
    }
  }
  if (softParse.length) {
    console.log(C.yellow(`   ⚠ ${softParse.length} syntax error(s): ` +
      softParse.slice(0, 3).map((e) => `${e.path}:${e.line} (${e.image})`).join(', ')));
  }
  // A3: verdicts are only trustworthy with real changed-line data.
  if (a.touchedSource === 'patch') {
    console.log(C.yellow(`   ⚠ changed lines from GitHub patch (git unavailable)` +
      (a.missingPatch?.length ? `; ${a.missingPatch.length} file(s) had no patch` : '')));
  } else if (a.touchedSource === 'none') {
    console.log(C.red('   ✗ no changed-line data — UPDATED cannot be distinguished from BROKEN'));
  }

  if (a.resolveError) {
    console.log(C.red(`   ✗ resolution failed: ${a.resolveError.split('\n')[0]}`));
  } else if (a.health) {
    const v = a.health.verdict;
    const tag = v === 'clean' ? C.green(v) : v === 'minor gaps' ? C.yellow(v) : C.red(v);
    console.log(C.dim(`   resolution health: `) + tag +
      C.dim(` (${a.health.unresolved} unresolved of ${a.health.errors} error(s)` +
        (a.health.explainedByCrossRepo ? `, ${a.health.explainedByCrossRepo} explained by cross-repo` : '') +
        `)  processor agent: ${a.processor?.skipped ? 'n/a' : 'attached'}`));
    if (v === 'DEGRADED') {
      console.log(C.red('   ⚠ graph is DEGRADED — edges are missing. Top causes:'));
      for (const sh of a.health.topShapes.slice(0, 3)) console.log(C.dim(`     ${sh.count}× ${sh.example}`));
    }
  }

  const pg = a.progress;
  if (pg.total) {
    const bar = '█'.repeat(Math.round((pg.done / pg.total) * 20)).padEnd(20, '·');
    console.log(C.dim(`   reviewed: ${bar} ${pg.done}/${pg.total}`) +
      (pg.stale ? C.yellow(`  ${pg.stale} stale`) : '') +
      (pg.orphaned ? C.dim(`  ${pg.orphaned} orphaned`) : ''));
  }

  console.log(`\n   ${C.bold(`${shown.length} change unit(s)`)}` +
    (suppressed ? C.dim(`  (${suppressed} low-signal suppressed — --show-noise to see)`) : ''));

  let lastPath = null;
  for (const u of ordered) {
    if (u.path !== lastPath && !has('by-severity')) {
      console.log(C.dim(`\n   ${u.path}`));
      lastPath = u.path;
    }
    const sev = String(u.severity.total).padStart(3);
    const rv = a.reviewed?.state.get(u.id);
    const mark = rv?.reviewed ? C.green('✓') : rv?.stale ? C.yellow('~') : ' ';
    console.log(`  ${mark}${KIND_TAG[u.changeKind]} ${C.dim(`sev ${sev}`)}  ${shortFqn(u.fqn)} ${C.dim(u.kind.toLowerCase())}`);
    if (u.from) console.log(C.dim(`               from ${shortFqn(u.from.fqn)} @ ${u.from.path} ${u.confidence ? `(confidence ${u.confidence}%)` : ''}`));
    for (const d of u.deltas) {
      if (d.type === 'BODY') { console.log(C.dim('               body changed')); continue; }
      console.log(`               ${C.mag(d.type.toLowerCase())}: ${fmtDelta(d)}`);
    }
    if (u.noise.length) console.log(C.dim(`               low-signal: ${u.noise.join(', ')}`));

    // Resolved impact, when --resolve ran.
    const n = a.graph?.nodes.get(u.id);
    if (n?.fanIn) {
      const fi = n.fanIn.kind === 'INDIRECT' ? C.yellow(`${n.fanIn.count} indirect`) : `${n.fanIn.count}`;
      console.log(C.dim(`               callers: ${fi}`) + (n.risk ? C.dim(`  risk ${n.risk.total}`) : ''));
      if (n.fanIn.note) console.log(C.dim(`               ⓘ ${n.fanIn.note}`));
    }
    if (n?.unknown) {
      console.log(C.yellow(`               UNKNOWN`) + C.dim(` — ${n.unknown.reason}`));
    }
    if (n?.break) {
      const v = n.break.verdicts;
      const parts = [];
      if (v.BROKEN) parts.push(C.red(`${v.BROKEN} BROKEN`));
      if (v.UPDATED) parts.push(C.green(`${v.UPDATED} updated`));
      if (v.SAFE) parts.push(C.dim(`${v.SAFE} safe`));
      if (parts.length) console.log(`               ${parts.join(C.dim(' · '))}`);
      for (const d of n.break.detail.filter((x) => x.verdict === 'BROKEN').slice(0, 6)) {
        console.log(C.red(`                 ✗ ${d.path}:${d.line}`) +
          (d.reasons[0] ? C.dim(`  — ${d.reasons[0]}`) : ''));
      }
    }
  }

  if (a.graph?.truncations?.length) {
    for (const t2 of a.graph.truncations) {
      if (t2.reason === 'maxSymbols') {
        console.log(C.yellow(`\n   ⚠ ${t2.omitted} symbol(s) not resolved (--max-symbols cap) — reported as UNKNOWN`));
      } else {
        console.log(C.yellow(`   ⚠ query budget exhausted at ${shortFqn(t2.fqn)}`));
      }
    }
  }
  if (a.fromGraphCache) {
    console.log(C.dim('   graph served from cache for this head SHA — pass --no-cache to re-resolve'));
  }
  const br = a.graph?.blastRadius;
  if (br) {
    const ctx = [...a.graph.nodes.values()].filter((n) => n.origin === 'CONTEXT');
    console.log(C.dim(`\n   blast radius: ${ctx.length} context node(s) at depth ≤ ${br.reachedDepth}` +
      ` of ${br.depth} requested  ·  ${a.graph.edges.filter((e) => e.type === 'CALLS').length} CALLS edge(s)`));
    if (br.truncated.length) {
      // Never let a bound pass silently: "nothing else is affected" is the worst possible lie.
      const byReason = new Map();
      for (const t2 of br.truncated) byReason.set(t2.reason, (byReason.get(t2.reason) ?? 0) + 1);
      console.log(C.yellow(`   ⚠ expansion truncated — the graph is INCOMPLETE beyond these points:`));
      for (const [r, n2] of byReason) console.log(C.yellow(`     ${n2}× ${r === 'maxNodes' ? 'node ceiling reached' : 'query budget exhausted'}`));
      for (const t2 of br.truncated.slice(0, 4)) {
        console.log(C.dim(`       at ${shortFqn(t2.fqn)} (depth ${t2.depth})`));
      }
    }
    const byDepth = new Map();
    for (const n2 of ctx) byDepth.set(n2.depth, (byDepth.get(n2.depth) ?? 0) + 1);
    for (const [d2, n2] of [...byDepth].sort()) console.log(C.dim(`     depth ${d2}: ${n2} node(s)`));
  }
  if (a.coChanged?.length) {
    console.log(C.dim(`\n   ${a.coChanged.length} CO_CHANGED pair(s)  [correlation from git history, NOT resolution]`));
    for (const e of a.coChanged.slice(0, 5)) {
      console.log(C.dim(`     ${(e.ratio * 100).toFixed(0)}% of ${e.sample} commits: ${e.from.split('/').pop()} ↔ ${e.to.split('/').pop()}`));
    }
  }
  if (a.topo?.cyclic?.length) {
    console.log(C.dim(`\n   ${a.topo.cyclic.length} node(s) in call cycles — ordered by risk within the cycle`));
  }
  if (a.suggestions.length) {
    console.log(C.dim(`\n   ${a.suggestions.length} possible rename/move link(s) below the confidence threshold:`));
    for (const s of a.suggestions.slice(0, 5)) {
      console.log(C.dim(`     ${shortFqn(s.removedFqn)} → ${shortFqn(s.addedFqn)} (${s.confidence}%)`));
    }
  }
  if (a.counts.otherFiles) {
    console.log(C.dim(`\n   ${a.counts.otherFiles} non-Java file(s) changed, not analyzed:`));
    for (const f of a.otherFiles.slice(0, 8)) console.log(C.dim(`     ${f.status.padEnd(8)} ${f.path}`));
    if (a.otherFiles.length > 8) console.log(C.dim(`     … ${a.otherFiles.length - 8} more`));
  }
}

if (analyses.length > 1) {
  console.log(`\n${C.bold('━━ cross-PR')}`);
  if (crossRepo.length === 0) {
    console.log(C.dim('   no producer↔consumer links found across the ingested PRs'));
  } else {
    const seen = new Set();
    console.log(C.dim(`   ${crossRepo.length} CROSS_REPO_PROVIDES edge(s)  [derived from NAME_MATCH, not resolution]`));
    for (const e of crossRepo) {
      const k = `${e.from.pr}|${e.from.fqn}|${e.to.pr}`;
      if (seen.has(k)) continue;
      seen.add(k);
      console.log(`   ${C.green(e.from.pr)} provides ${C.bold(shortFqn(e.from.fqn))}`);
      console.log(C.dim(`     declared  ${e.from.path}:${e.from.line}`));
      console.log(C.dim(`     consumed  ${e.to.pr}  ${e.to.path}:${e.to.line}`));
    }
  }

  // Overlap (task 2.5 / R1): the same symbol touched by more than one PR.
  const byFqn = new Map();
  for (const a of analyses) for (const u of a.units) {
    if (!byFqn.has(u.fqn)) byFqn.set(u.fqn, new Set());
    byFqn.get(u.fqn).add(a.key);
  }
  const overlaps = [...byFqn].filter(([, prs]) => prs.size > 1);
  console.log(overlaps.length
    ? C.yellow(`   ⚠ ${overlaps.length} symbol(s) changed by more than one PR: ` +
        overlaps.slice(0, 5).map(([f, p]) => `${shortFqn(f)} (${[...p].join(', ')})`).join('; '))
    : C.dim('   no overlapping symbols'));
}

const allBroken = [];
for (const a of analyses) {
  for (const n of (a.graph?.nodes.values() ?? [])) {
    for (const d of (n.break?.detail ?? [])) {
      if (d.verdict === 'BROKEN') allBroken.push({ pr: a.key, fqn: n.fqn, contract: n.break.contractChange, ...d });
    }
  }
}
for (const a of analyses) {
  try { saveAnalysis(db, a); } catch (e) {
    console.error(C.yellow(`   ⚠ could not persist ${a.key}: ${e.message.split('\n')[0]}`));
  }
}
scanCache(db, CACHE);

const allUnknown = [];
for (const a of analyses) {
  for (const n of (a.graph?.nodes.values() ?? [])) {
    if (n.unknown) allUnknown.push({ pr: a.key, fqn: n.fqn, reason: n.unknown.reason });
  }
}
if (has('resolve')) {
  console.log(`\n${C.bold('━━ break analysis')}`);
  if (allBroken.length === 0) {
    console.log(C.green('   no unupdated call sites found'));
  } else {
    console.log(C.red(`   ${allBroken.length} call site(s) may not have been updated:`));
    const byFqn = new Map();
    for (const b of allBroken) {
      if (!byFqn.has(b.fqn)) byFqn.set(b.fqn, { contract: b.contract, pr: b.pr, sites: [] });
      byFqn.get(b.fqn).sites.push(b);
    }
    for (const [fqn, g] of byFqn) {
      console.log(`\n   ${C.bold(shortFqn(fqn))} ${C.dim(`[${g.pr}]`)}`);
      for (const c of g.contract) console.log(C.mag(`     ${c}`));
      for (const s2 of g.sites.slice(0, 10)) console.log(C.red(`     ✗ ${s2.path}:${s2.line}`));
      if (g.sites.length > 10) console.log(C.dim(`     … ${g.sites.length - 10} more`));
    }
  }

  // A2: never let "not analysed" read as "nothing to report".
  if (allUnknown.length) {
    console.log(C.yellow(`\n   ${allUnknown.length} symbol(s) UNKNOWN — not analysed, so no verdict:`));
    const byReason = new Map();
    for (const u of allUnknown) {
      const k = u.reason.replace(/\d+/g, 'N');
      if (!byReason.has(k)) byReason.set(k, []);
      byReason.get(k).push(u);
    }
    for (const [reason, list] of byReason) {
      console.log(C.dim(`     ${list.length}×  ${reason}`));
      for (const u of list.slice(0, 3)) console.log(C.dim(`          ${shortFqn(u.fqn)} [${u.pr}]`));
    }
  }
}

if (failures.length) {
  console.log(`\n${C.red(`${failures.length} PR(s) failed to ingest:`)}`);
  for (const f of failures) console.log(`   ${f.url} — ${f.error}`);
}

if (has('resolve')) {
  console.log(C.dim('\nnote: BROKEN means a call site was not touched by this PR and the contract change'));
  console.log(C.dim('      is source-incompatible. UNKNOWN means it was not analysed — never assume SAFE.'));
  console.log(C.dim('      CO_CHANGED is a git-history correlation, not a resolved relationship.\n'));
} else {
  console.log(C.dim('\nnote: severity is provisional — derived from the change alone.'));
  console.log(C.dim('      run with --resolve for callers, break analysis, and risk.\n'));
}

if (has('json')) {
  const out = flag('json');
  writeFileSync(out, JSON.stringify({ analyses, crossRepo, failures }, (k, v) =>
    (v instanceof Map ? Object.fromEntries(v) : v), 2));
  console.log(C.dim(`full analysis written to ${out}`));
}

function shortFqn(fqn) {
  return fqn.replace(/^([a-z0-9_]+\.)+/, (m) => m.split('.').filter(Boolean).map((s) => s[0]).join('.') + '.');
}
function fmtDelta(d) {
  const f = (v) => Array.isArray(v) ? (v.length ? v.join(' ') : C.dim('∅')) : (v ?? C.dim('∅'));
  return `${f(d.before)} ${C.dim('→')} ${f(d.after)}`;
}
