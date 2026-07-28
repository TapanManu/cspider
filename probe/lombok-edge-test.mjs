// F5b: the agent fixes type-checking of generated accessors, but documentSymbol reports only
// source-declared members. Question this answers: can we still form a CALLS edge INTO a
// generated accessor — i.e. does `definition` from a call site resolve to something usable?
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve as presolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchJdtls, initializeParams, findLombokJar } from '../src/lsp.mjs';

const ROOT = presolve(dirname(fileURLToPath(import.meta.url)), '..');  // repo root
const wt = readdirSync(join(ROOT, '.cache', 'worktrees')).find((d) => d.includes('sedai-core'));
const projRoot = join(ROOT, '.cache', 'worktrees', wt);
const lombokJar = findLombokJar('1.18.42');

// Find a real call site of a Lombok-generated accessor: CoreProfilingConfigDto.isAggressive()
const hit = execFileSync('grep', ['-rn', '--include=*.java', '-m', '1', '-e', '\\.isAggressive()', join(projRoot, 'core', 'src')],
  { encoding: 'utf8' }).trim().split('\n')[0];
const [file, lineNo] = [hit.split(':')[0], Number(hit.split(':')[1])];
const text = readFileSync(file, 'utf8');
const lineText = text.split('\n')[lineNo - 1];
const col = lineText.indexOf('isAggressive') + 2;
console.log(`call site: ${file.replace(projRoot + '/', '')}:${lineNo}`);
console.log(`  ${lineText.trim().slice(0, 100)}`);

let ready = false;
const { client, rootUri } = launchJdtls({
  jdtlsHome: join(ROOT, 'vendor', 'jdtls'),
  projectRoot: projRoot,
  dataDir: join(ROOT, '.cache', 'jdtls-data', 'lombok-edge-test'),
  lombokJar,
  onNotification: (m) => {
    if (m.method === 'language/status' && m.params?.type === 'ServiceReady') ready = true;
  },
});
await client.request('initialize', initializeParams(rootUri, projRoot), 15 * 60 * 1000);
client.notify('initialized', {});
const t = Date.now();
while (!ready && Date.now() - t < 600000) await new Promise((r) => setTimeout(r, 500));
console.log(`index ready=${ready} (${((Date.now() - t) / 1000).toFixed(1)}s), lombok agent=${!!lombokJar}`);

const uri = pathToFileURL(file).href;
client.notify('textDocument/didOpen', {
  textDocument: { uri, languageId: 'java', version: 1, text },
});
await new Promise((r) => setTimeout(r, 1500));

const pos = { line: lineNo - 1, character: col };
for (const method of ['textDocument/definition', 'textDocument/typeDefinition', 'textDocument/hover']) {
  try {
    const res = await client.request(method, { textDocument: { uri }, position: pos }, 60000);
    const summary = method === 'textDocument/hover'
      ? JSON.stringify(res?.contents).slice(0, 200)
      : JSON.stringify(res).slice(0, 400);
    console.log(`\n${method}:\n  ${summary || 'null'}`);
  } catch (e) {
    console.log(`\n${method}: ERROR ${e.message}`);
  }
}

// And the reverse direction: enumerate members of the generated type.
try {
  const syms = await client.request('workspace/symbol', { query: 'isAggressive' }, 60000);
  console.log(`\nworkspace/symbol "isAggressive": ${(syms || []).length} results`);
  for (const s of (syms || []).slice(0, 5)) {
    console.log(`  ${s.name} @ ${fileURLToPath(s.location.uri).replace(projRoot + '/', '')}:${s.location.range.start.line + 1}`);
  }
} catch (e) {
  console.log(`workspace/symbol: ERROR ${e.message}`);
}

await client.shutdown();
process.exit(0);
