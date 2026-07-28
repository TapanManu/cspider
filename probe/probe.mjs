#!/usr/bin/env node
// Walking skeleton: one PR URL -> clone -> jdtls index -> resolve callers of changed methods.
//
// Purpose is to answer three questions before any real building starts:
//   Q1  How long does jdtls take to index this repo?
//   Q2  What is resolution health without a full build?
//   Q3  Do references resolve for the Java constructs this codebase actually uses?
//
// Throwaway by design. Do not grow features here.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve as presolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePrUrl, fetchPr, mergeBase, cloneUrl } from '../src/github.mjs';
import { ensureClone, ensureWorktree } from '../src/checkout.mjs';
import { launchJdtls, initializeParams, findLombokJar } from '../src/lsp.mjs';

const ROOT = presolve(dirname(fileURLToPath(import.meta.url)), '..');  // repo root
const CACHE = process.env.CSPIDER_CACHE || join(ROOT, '.cache');
const JDTLS_HOME = process.env.JDTLS_HOME || join(ROOT, 'vendor', 'jdtls');

const argv = process.argv.slice(2);
const prUrl = argv.find((a) => a.startsWith('http'));
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const has = (n) => argv.includes(`--${n}`);

if (!prUrl) {
  console.error('usage: node probe/probe.mjs <pr-url> [--resolve-build] [--max-symbols N] [--trace]');
  process.exit(2);
}

const MAX_SYMBOLS = Number(flag('max-symbols', 25));
const TRACE = has('trace');
const t0 = Date.now();
const timings = {};
const mark = (name, from) => { timings[name] = Date.now() - from; };
const log = (...a) => console.log(`[${String((Date.now() - t0) / 1000).padStart(6)}s]`, ...a);

// ---------------------------------------------------------------- 1. ingest
const pr = parsePrUrl(prUrl);
log(`PR ${pr.nwo}#${pr.number}`);
let s = Date.now();
const { meta, files } = fetchPr(pr);
const javaFiles = files.filter((f) => f.filename.endsWith('.java') && f.status !== 'removed');
mark('ingest_ms', s);
log(`"${meta.title}"`);
log(`head=${meta.headRefOid.slice(0, 12)} files=${files.length} java=${javaFiles.length} +${meta.additions}/-${meta.deletions}`);

if (javaFiles.length === 0) {
  console.error('no changed .java files — pick a Java PR for this probe');
  process.exit(1);
}

s = Date.now();
const base = mergeBase({ nwo: pr.nwo, base: meta.baseRefOid, head: meta.headRefOid });
mark('mergebase_ms', s);

// ---------------------------------------------------------------- 2. checkout
s = Date.now();
const clone = ensureClone(CACHE, pr.nwo, cloneUrl(pr.nwo));
const headWt = ensureWorktree(CACHE, pr.nwo, clone, meta.headRefOid);
mark('checkout_ms', s);
log(`worktree ${headWt}`);

// --------------------------------- 3. project root detection (F4: repo root != project root)
// jdtls must be initialised on the build root, not the repo root. Without this it silently
// skips the Maven import, reports ready in seconds, and resolves nothing external.
function detectProjectRoot(repoRoot, changed) {
  const candidates = new Set();
  for (const f of changed) {
    let dir = dirname(f.filename);
    while (dir && dir !== '.' && dir !== '/') {
      if (existsSync(join(repoRoot, dir, 'pom.xml')) ||
          existsSync(join(repoRoot, dir, 'build.gradle')) ||
          existsSync(join(repoRoot, dir, 'build.gradle.kts'))) {
        candidates.add(dir);
        break;
      }
      dir = dirname(dir);
    }
  }
  if (existsSync(join(repoRoot, 'pom.xml')) || existsSync(join(repoRoot, 'build.gradle')) ||
      existsSync(join(repoRoot, 'build.gradle.kts'))) return { root: repoRoot, rel: '.' };
  if (candidates.size === 0) return { root: repoRoot, rel: '.', warn: 'no build file found' };
  // Shallowest candidate — closest thing to a reactor root covering the changed files.
  const rel = [...candidates].sort((a, b) => a.split('/').length - b.split('/').length)[0];
  return { root: join(repoRoot, rel), rel, multi: candidates.size > 1, all: [...candidates] };
}

const proj = detectProjectRoot(headWt, javaFiles);
log(`project root: ${proj.rel}${proj.multi ? ` (WARNING: ${proj.all.length} build roots span the changed files: ${proj.all.join(', ')})` : ''}`);
if (proj.warn) log(`WARNING: ${proj.warn} — jdtls will run without a build import`);

// --------------------------------- 3a. Lombok detection (F5)
function detectLombok(projRoot) {
  const buildFiles = ['pom.xml', 'build.gradle', 'build.gradle.kts']
    .map((f) => join(projRoot, f)).filter(existsSync);
  let uses = false; let version = null;
  for (const bf of buildFiles) {
    const txt = readFileSync(bf, 'utf8');
    if (/projectlombok|['"\s]lombok[:'"\s<]/.test(txt)) uses = true;
    const v = /<lombok\.version>([^<]+)</.exec(txt) || /lombok[:-]([0-9]+\.[0-9]+\.[0-9]+)/.exec(txt);
    if (v) version = v[1];
  }
  // Inherited/managed versions are common; a source scan is the reliable "is it used" signal.
  if (!uses) {
    try {
      const hit = execFileSync('grep', ['-rl', '--include=*.java', '-e', 'lombok.', join(projRoot, 'src')],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (hit.trim()) uses = true;
    } catch { /* grep exits 1 on no match */ }
  }
  return { uses, version };
}
const lombok = detectLombok(proj.root);
const lombokJar = lombok.uses ? findLombokJar(lombok.version) : null;
log(`lombok: used=${lombok.uses} declaredVersion=${lombok.version || 'managed'} agent=${lombokJar || 'NONE'}`);
if (lombok.uses && !lombokJar) {
  console.error('FATAL: project uses Lombok but no lombok.jar found — refusing to analyze (F5).');
  console.error('       set LOMBOK_JAR=/path/to/lombok.jar');
  process.exit(1);
}

// ------------------------------------------------- 3b. optional dependency resolve (design R2)
if (has('resolve-build')) {
  s = Date.now();
  const isMaven = existsSync(join(proj.root, 'pom.xml'));
  try {
    if (isMaven) {
      log(`mvn dependency:go-offline in ${proj.rel} …`);
      execFileSync('mvn', ['-q', '-B', '-DskipTests', 'dependency:go-offline'], {
        cwd: proj.root, stdio: TRACE ? 'inherit' : 'ignore', timeout: 30 * 60 * 1000,
      });
      timings.dep_resolve_ok = true;
    } else {
      log('no pom.xml at project root — dependency resolve SKIPPED');
      timings.dep_resolve_ok = null;
    }
  } catch (e) {
    timings.dep_resolve_ok = false;
    log(`dependency resolve FAILED (continuing, as designed): ${e.message.split('\n')[0]}`);
  }
  mark('dep_resolve_ms', s);
}

// ---------------------------------------------------------------- 4. index
const diagnostics = new Map();
const statusLog = [];
let ready = false;
const onNotification = (msg) => {
  if (msg.method === 'textDocument/publishDiagnostics') {
    diagnostics.set(msg.params.uri, msg.params.diagnostics || []);
  } else if (msg.method === 'language/status') {
    if (TRACE) log(`status ${msg.params?.type}: ${String(msg.params?.message).slice(0, 100)}`);
    statusLog.push({ t: Date.now() - t0, type: msg.params?.type, message: String(msg.params?.message || '').slice(0, 120) });
    if (msg.params?.type === 'ServiceReady') ready = true;
  } else if (msg.method === 'language/progressReport') {
    statusLog.push({ t: Date.now() - t0, type: 'progress', message: String(msg.params?.status || '').slice(0, 120), complete: msg.params?.complete });
    if (TRACE) log(`progress ${msg.params?.status || ''}`);
  } else if (msg.method === '$/progress') {
    const v = msg.params?.value || {};
    statusLog.push({ t: Date.now() - t0, type: `$/progress:${v.kind}`, message: String(v.title || v.message || '').slice(0, 120) });
  }
};

if (!existsSync(JDTLS_HOME)) {
  console.error(`jdtls not found at ${JDTLS_HOME} — run: npm run jdtls`);
  process.exit(1);
}

s = Date.now();
const dataDir = join(CACHE, 'jdtls-data', `${pr.nwo.replace('/', '__')}@${meta.headRefOid.slice(0, 12)}`);
const warmIndex = existsSync(dataDir);
log(`starting jdtls (index ${warmIndex ? 'WARM' : 'COLD'}) …`);
const { client, rootUri } = launchJdtls({
  jdtlsHome: JDTLS_HOME, projectRoot: proj.root, dataDir, trace: TRACE, onNotification, lombokJar,
});

await client.request('initialize', initializeParams(rootUri, proj.root), 15 * 60 * 1000);
client.notify('initialized', {});
mark('lsp_initialize_ms', s);
log(`initialize returned in ${(timings.lsp_initialize_ms / 1000).toFixed(1)}s — waiting for index …`);

// jdtls signals readiness asynchronously; poll with a ceiling.
s = Date.now();
const INDEX_CEILING_MS = Number(flag('index-timeout', 20 * 60 * 1000));
while (!ready && Date.now() - s < INDEX_CEILING_MS) {
  await new Promise((r) => setTimeout(r, 1000));
}
mark('index_wait_ms', s);
timings.index_ready = ready;
log(`index ${ready ? 'READY' : 'NOT READY (ceiling hit — results below are partial)'} after ${(timings.index_wait_ms / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------- 5. resolve
const openDoc = (abs) => {
  const uri = pathToFileURL(abs).href;
  client.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'java', version: 1, text: readFileSync(abs, 'utf8') },
  });
  return uri;
};

const flatten = (syms, out = [], parent = null) => {
  for (const sym of syms || []) {
    const name = parent ? `${parent}.${sym.name}` : sym.name;
    out.push({ name, kind: sym.kind, range: sym.selectionRange || sym.range, raw: sym });
    if (sym.children) flatten(sym.children, out, name);
  }
  return out;
};

// LSP SymbolKind: 6 = Method, 9 = Constructor
const METHODISH = new Set([6, 9]);

s = Date.now();
const results = [];
let resolvedCount = 0;
let zeroRefCount = 0;

for (const f of javaFiles) {
  const abs = join(headWt, f.filename);
  if (!existsSync(abs)) { log(`skip (not on disk): ${f.filename}`); continue; }
  const uri = openDoc(abs);
  await new Promise((r) => setTimeout(r, 250)); // let jdtls parse the opened doc

  let syms;
  try {
    syms = await client.request('textDocument/documentSymbol', { textDocument: { uri } }, 60000);
  } catch (e) {
    log(`documentSymbol failed for ${f.filename}: ${e.message}`);
    continue;
  }

  const methods = flatten(syms).filter((x) => METHODISH.has(x.kind)).slice(0, MAX_SYMBOLS);
  log(`${f.filename}: ${methods.length} methods`);

  for (const m of methods) {
    let refs = null;
    try {
      refs = await client.request('textDocument/references', {
        textDocument: { uri },
        position: m.range.start,
        context: { includeDeclaration: false },
      }, 60000);
    } catch (e) {
      results.push({ file: f.filename, symbol: m.name, error: e.message });
      continue;
    }
    const callers = (refs || []).map((r) => ({
      file: fileURLToPath(r.uri).replace(`${headWt}/`, ''),
      line: r.range.start.line + 1,
    }));
    if (callers.length > 0) resolvedCount++; else zeroRefCount++;
    results.push({ file: f.filename, symbol: m.name, callerCount: callers.length, callers: callers.slice(0, 10) });
  }
}
mark('resolve_ms', s);

// ------------------------------------------- 6. resolution health (design R2 proxy)
// Proxy metric: JDT "cannot be resolved" errors in changed files. A high count means the
// classpath is incomplete and the graph would be sparse-but-plausible — the dangerous case.
let errCount = 0;
let unresolvedErrCount = 0;
const diagSamples = new Map();
for (const [uri, diags] of diagnostics) {
  if (!uri.endsWith('.java')) continue;
  const rel = fileURLToPath(uri).replace(`${headWt}/`, '');
  if (!javaFiles.some((f) => f.filename === rel)) continue;
  for (const d of diags) {
    if (d.severity !== 1) continue;
    errCount++;
    if (/cannot be resolved|is not defined|undefined for the type|does not exist/i.test(d.message)) {
      unresolvedErrCount++;
    }
    // Normalise identifiers out so distinct message shapes collapse into buckets.
    const shape = d.message.replace(/[A-Za-z_$][\w$.<>,\[\] ]*/g, (t) => (t.length > 2 ? 'X' : t)).slice(0, 80);
    if (!diagSamples.has(shape)) diagSamples.set(shape, { count: 0, example: d.message.slice(0, 120) });
    diagSamples.get(shape).count++;
  }
}
const topDiagShapes = [...diagSamples.values()].sort((a, b) => b.count - a.count).slice(0, 8);

const symbolsProbed = resolvedCount + zeroRefCount;
const report = {
  pr: { url: meta.url, title: meta.title, head: meta.headRefOid, mergeBase: base },
  scale: { changedFiles: files.length, changedJavaFiles: javaFiles.length, symbolsProbed },
  projectRoot: { rel: proj.rel, multipleBuildRoots: !!proj.multi, buildRoots: proj.all || [proj.rel] },
  Q1_index: {
    cold: !warmIndex,
    initializeSeconds: +(timings.lsp_initialize_ms / 1000).toFixed(1),
    indexWaitSeconds: +(timings.index_wait_ms / 1000).toFixed(1),
    reachedReady: ready,
  },
  lombok: { used: lombok.uses, declaredVersion: lombok.version, agentJar: lombokJar },
  Q2_resolutionHealth: {
    dependencyResolveAttempted: has('resolve-build'),
    dependencyResolveOk: timings.dep_resolve_ok ?? null,
    errorDiagnosticsInChangedFiles: errCount,
    unresolvedSymbolErrors: unresolvedErrCount,
    verdict: unresolvedErrCount === 0 ? 'clean'
      : unresolvedErrCount < 10 ? 'minor gaps' : 'DEGRADED — classpath incomplete',
    topErrorShapes: topDiagShapes,
  },
  Q3_referenceResolution: {
    symbolsWithCallers: resolvedCount,
    symbolsWithZeroCallers: zeroRefCount,
    zeroCallerRatio: symbolsProbed ? +(zeroRefCount / symbolsProbed).toFixed(2) : null,
    note: 'A high zero-caller ratio is expected for entry points and tests, and suspicious otherwise.',
  },
  timings,
  statusLog,
  results,
};

mkdirSync(join(ROOT, 'out'), { recursive: true });
const outFile = join(ROOT, 'out', `probe-${pr.repo}-${pr.number}.json`);
writeFileSync(outFile, JSON.stringify(report, null, 2));

console.log('\n================ PROBE REPORT ================');
console.log(JSON.stringify({ ...report, results: `${results.length} entries -> ${outFile}` }, null, 2));

const top = results.filter((r) => r.callerCount > 0).sort((a, b) => b.callerCount - a.callerCount).slice(0, 5);
if (top.length) {
  console.log('\nHighest fan-in changed symbols (the blast-radius candidates):');
  for (const r of top) {
    console.log(`  ${r.callerCount.toString().padStart(3)}  ${r.symbol}   [${r.file}]`);
    for (const c of r.callers.slice(0, 3)) console.log(`         ← ${c.file}:${c.line}`);
  }
}

await client.shutdown();
process.exit(0);
