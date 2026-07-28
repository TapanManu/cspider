// JDT LS resolution (tasks 5.1–5.11). Position-anchored requests only — F7 measured
// workspace/symbol at a 60s timeout on sedai-core while definition/hover returned instantly.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve as presolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchJdtls, initializeParams, findLombokJar } from '../lsp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const JDTLS_HOME = process.env.JDTLS_HOME || presolve(HERE, '..', '..', 'vendor', 'jdtls');

const UNRESOLVED_RE = /cannot be resolved|is not defined|undefined for the type|does not exist|is undefined/i;

// F5a: a project using an annotation processor must have the agent attached, or generated
// members are invisible to resolution — silently. Detect, attach, assert, or refuse.
export function detectLombok(projectRoot) {
  const buildFiles = ['pom.xml', 'build.gradle', 'build.gradle.kts']
    .map((f) => join(projectRoot, f)).filter(existsSync);
  let uses = false;
  let version = null;
  for (const bf of buildFiles) {
    const txt = readFileSync(bf, 'utf8');
    if (/projectlombok|['"\s]lombok[:'"\s<]/.test(txt)) uses = true;
    const v = /<lombok\.version>([^<]+)</.exec(txt) || /lombok[:-]([0-9]+\.[0-9]+\.[0-9]+)/.exec(txt);
    if (v) version = v[1];
  }
  if (!uses) {
    try {
      const hit = execFileSync('grep', ['-rlq', '--include=*.java', '-e', 'lombok.', join(projectRoot, 'src')],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      uses = hit !== undefined;
    } catch { /* grep exits non-zero on no match */ }
  }
  return { uses, version };
}

export class JavaResolver {
  constructor({ projectRoot, dataDir, trace = false }) {
    this.projectRoot = projectRoot;
    this.dataDir = dataDir;
    this.trace = trace;
    this.diagnostics = new Map();
    this.opened = new Set();
    this.ready = false;
    this.queries = 0;
  }

  async start() {
    if (!existsSync(JDTLS_HOME)) {
      throw new Error(`jdtls not found at ${JDTLS_HOME} — run: npm run jdtls`);
    }
    const lombok = detectLombok(this.projectRoot);
    this.lombokJar = lombok.uses ? findLombokJar(lombok.version) : null;
    if (lombok.uses && !this.lombokJar) {
      throw new Error(
        'project uses Lombok but no matching lombok.jar was found — refusing to analyze, ' +
        'because generated members would be silently unresolvable. Set LOMBOK_JAR=/path/to/lombok.jar',
      );
    }
    this.lombok = lombok;

    const { client, rootUri } = launchJdtls({
      jdtlsHome: JDTLS_HOME,
      projectRoot: this.projectRoot,
      dataDir: this.dataDir,
      lombokJar: this.lombokJar,
      trace: this.trace,
      onNotification: (m) => this.#onNotification(m),
    });
    this.client = client;
    await client.request('initialize', initializeParams(rootUri, this.projectRoot), 15 * 60 * 1000);
    client.notify('initialized', {});
    return this;
  }

  #onNotification(m) {
    if (m.method === 'textDocument/publishDiagnostics') {
      this.diagnostics.set(m.params.uri, m.params.diagnostics || []);
    } else if (m.method === 'language/status' && m.params?.type === 'ServiceReady') {
      this.ready = true;
    }
  }

  async waitReady(ceilingMs = 15 * 60 * 1000) {
    const t0 = Date.now();
    while (!this.ready && Date.now() - t0 < ceilingMs) {
      await new Promise((r) => setTimeout(r, 500));
    }
    this.readyMs = Date.now() - t0;
    return this.ready;
  }

  open(relPath) {
    const abs = join(this.projectRoot, relPath);
    const uri = pathToFileURL(abs).href;
    if (this.opened.has(uri)) return uri;
    if (!existsSync(abs)) return null;
    this.client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'java', version: 1, text: readFileSync(abs, 'utf8') },
    });
    this.opened.add(uri);
    return uri;
  }

  async #req(method, uri, position, timeout = 60000, extra = {}) {
    this.queries++;
    try {
      return await this.client.request(method, { textDocument: { uri }, position, ...extra }, timeout);
    } catch (e) {
      return { __error: e.message };
    }
  }

  // Inbound callers of the symbol at `position`.
  async references(relPath, position) {
    const uri = this.open(relPath);
    if (!uri) return { refs: [], error: 'file absent' };
    // The `context` member is REQUIRED by the LSP spec; jdtls answers -32603 without it.
    const res = await this.#req('textDocument/references', uri, position, 60000,
      { context: { includeDeclaration: false } });
    if (res?.__error) return { refs: [], error: res.__error };
    const refs = (res || []).map((r) => ({
      path: this.#rel(r.uri),
      line: r.range.start.line + 1,
      character: r.range.start.character,
    }));
    return { refs, error: null };
  }

  // F5b/D4c: hover resolves members that have no source declaration (Lombok accessors),
  // which is how a generated target still gets a real signature.
  async hover(relPath, position) {
    const uri = this.open(relPath);
    if (!uri) return null;
    const res = await this.#req('textDocument/hover', uri, position);
    if (!res || res.__error) return null;
    const c = res.contents;
    const parts = Array.isArray(c) ? c : [c];
    for (const p of parts) {
      const v = typeof p === 'string' ? p : (p?.value ?? '');
      if (v && !v.startsWith('*')) return v.split('\n')[0].trim();
    }
    return null;
  }

  async definition(relPath, position) {
    const uri = this.open(relPath);
    if (!uri) return null;
    const res = await this.#req('textDocument/definition', uri, position);
    if (!res || res.__error) return null;
    const arr = Array.isArray(res) ? res : [res];
    if (!arr[0]) return null;
    return { path: this.#rel(arr[0].uri), line: arr[0].range.start.line + 1 };
  }

  async implementations(relPath, position) {
    const uri = this.open(relPath);
    if (!uri) return [];
    const res = await this.#req('textDocument/implementation', uri, position);
    if (!res || res.__error) return [];
    return (Array.isArray(res) ? res : [res]).filter(Boolean)
      .map((r) => ({ path: this.#rel(r.uri), line: r.range.start.line + 1 }));
  }

  #rel(uri) {
    return fileURLToPath(uri).replace(`${this.projectRoot}/`, '');
  }

  /**
   * Resolution health (R2) — the share of error diagnostics in the given files that are
   * unresolved-symbol errors. `explained` holds FQNs accounted for by a cross-repo provider
   * edge (R6); those are excluded so a multi-repo change does not read permanently DEGRADED.
   */
  health(relPaths, explained = new Set()) {
    const wanted = new Set(relPaths);
    let errors = 0;
    let unresolved = 0;
    let explainedCount = 0;
    const shapes = new Map();

    for (const [uri, diags] of this.diagnostics) {
      const rel = this.#rel(uri);
      if (!wanted.has(rel)) continue;
      for (const d of diags) {
        if (d.severity !== 1) continue;
        const isUnresolved = UNRESOLVED_RE.test(d.message);
        const explainedHere = isUnresolved &&
          [...explained].some((fqn) => d.message.includes(fqn) || d.message.includes(fqn.split('.').pop()));
        if (explainedHere) { explainedCount++; continue; }
        errors++;
        if (isUnresolved) unresolved++;
        const key = d.message.replace(/[A-Za-z_$][\w$.<>,[\] ]*/g, (t) => (t.length > 2 ? 'X' : t)).slice(0, 80);
        if (!shapes.has(key)) shapes.set(key, { count: 0, example: d.message.slice(0, 140) });
        shapes.get(key).count++;
      }
    }

    const verdict = unresolved === 0 ? 'clean' : unresolved < 10 ? 'minor gaps' : 'DEGRADED';
    return {
      errors, unresolved, explainedByCrossRepo: explainedCount, verdict,
      topShapes: [...shapes.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    };
  }

  // F5a assertion: prove a generated accessor actually resolves. Failure is fatal, because
  // the alternative is a graph that is quietly missing every edge into generated code.
  async assertProcessorWorking(relPaths) {
    if (!this.lombok?.uses) return { skipped: true };
    const h = this.health(relPaths);
    const generatedShape = h.topShapes.find((s) => /is undefined for the type/.test(s.example));
    if (generatedShape && generatedShape.count > 5) {
      throw new Error(
        `annotation processor assertion FAILED: ${generatedShape.count} "undefined for the type" ` +
        `errors remain with the agent attached (${this.lombokJar}). ` +
        `Example: ${generatedShape.example}. Refusing to produce a silently sparse graph.`,
      );
    }
    return { skipped: false, ok: true, agent: this.lombokJar };
  }

  async stop() { await this.client?.shutdown(); }
}

export function jdtlsAvailable() {
  return existsSync(JDTLS_HOME) && readdirSync(JDTLS_HOME).includes('plugins');
}
