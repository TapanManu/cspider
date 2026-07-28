// Minimal LSP client over stdio. No dependencies — this is a probe, not a product.
import { spawn } from 'node:child_process';
import { readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export class LspClient {
  constructor(proc, { onNotification, trace = false } = {}) {
    this.proc = proc;
    this.trace = trace;
    this.seq = 0;
    this.pending = new Map();
    this.onNotification = onNotification || (() => {});
    this.buf = Buffer.alloc(0);
    proc.stdout.on('data', (chunk) => this.#onData(chunk));
    proc.stderr.on('data', (d) => { if (trace) process.stderr.write(`[jdtls] ${d}`); });
  }

  #onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buf.subarray(0, headerEnd).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.buf = this.buf.subarray(headerEnd + 4); continue; }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) return;
      const body = this.buf.subarray(start, start + len).toString('utf8');
      this.buf = this.buf.subarray(start + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else resolve(msg.result);
      return;
    }
    // Server-to-client request: answer the ones that would otherwise block indexing.
    if (msg.id !== undefined && msg.method) {
      const nullReplies = new Set([
        'workspace/configuration',
        'client/registerCapability',
        'client/unregisterCapability',
        'window/workDoneProgress/create',
      ]);
      const result = msg.method === 'workspace/configuration'
        ? (msg.params?.items || []).map(() => ({}))
        : null;
      if (nullReplies.has(msg.method)) this.#write({ jsonrpc: '2.0', id: msg.id, result });
      return;
    }
    if (msg.method) this.onNotification(msg);
  }

  #write(obj) {
    const json = JSON.stringify(obj);
    const payload = Buffer.from(json, 'utf8');
    this.proc.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    this.proc.stdin.write(payload);
  }

  request(method, params, timeoutMs = 120000) {
    const id = ++this.seq;
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
    this.#write({ jsonrpc: '2.0', id, method, params });
    return p;
  }

  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  async shutdown() {
    try { await this.request('shutdown', null, 10000); } catch { /* best effort */ }
    try { this.notify('exit'); } catch { /* best effort */ }
    setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch {} }, 3000).unref();
  }
}

function launcherJar(jdtlsHome) {
  const pluginsDir = join(jdtlsHome, 'plugins');
  const jar = readdirSync(pluginsDir).find(
    (f) => f.startsWith('org.eclipse.equinox.launcher_') && f.endsWith('.jar'),
  );
  if (!jar) throw new Error(`equinox launcher jar not found in ${pluginsDir}`);
  return join(pluginsDir, jar);
}

function configDir(jdtlsHome) {
  const candidates = process.platform === 'darwin'
    ? ['config_mac_arm', 'config_mac']
    : ['config_linux_arm', 'config_linux'];
  const present = readdirSync(jdtlsHome);
  for (const c of candidates) if (present.includes(c)) return join(jdtlsHome, c);
  throw new Error(`no jdtls config dir found in ${jdtlsHome} (looked for ${candidates.join(', ')})`);
}

// F5: jdtls does not run annotation processors unless the agent is attached. Without this,
// every Lombok-generated accessor is invisible to resolution — and invisibly so, which is worse
// than an error. Returns null when no jar can be found; the caller must treat that as fatal
// for a Lombok project rather than proceeding with a silently sparse graph.
export function findLombokJar(preferVersion) {
  if (process.env.LOMBOK_JAR) return existsSync(process.env.LOMBOK_JAR) ? process.env.LOMBOK_JAR : null;
  const base = join(process.env.HOME || '', '.m2', 'repository', 'org', 'projectlombok', 'lombok');
  if (!existsSync(base)) return null;
  const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  const versions = readdirSync(base)
    .filter((v) => existsSync(join(base, v, `lombok-${v}.jar`)))
    .sort(cmp);
  if (versions.length === 0) return null;
  const pick = (preferVersion && versions.includes(preferVersion))
    ? preferVersion
    : versions[versions.length - 1];
  return join(base, pick, `lombok-${pick}.jar`);
}

export function launchJdtls({
  jdtlsHome, projectRoot, dataDir, heap = '4G', trace = false, onNotification, lombokJar = null,
}) {
  mkdirSync(dataDir, { recursive: true });
  const args = [
    // Must precede -jar so the agent is attached before the JDT compiler loads.
    ...(lombokJar ? [`-javaagent:${lombokJar}`] : []),
    '-Declipse.application=org.eclipse.jdt.ls.core.id1',
    '-Dosgi.bundles.defaultStartLevel=4',
    '-Declipse.product=org.eclipse.jdt.ls.core.product',
    '-Dlog.level=ERROR',
    `-Xmx${heap}`,
    '--add-modules=ALL-SYSTEM',
    '--add-opens', 'java.base/java.util=ALL-UNNAMED',
    '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
    '-jar', launcherJar(jdtlsHome),
    '-configuration', configDir(jdtlsHome),
    '-data', dataDir,
  ];
  const proc = spawn('java', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const client = new LspClient(proc, { trace, onNotification });
  return { client, proc, rootUri: pathToFileURL(projectRoot).href };
}

export const initializeParams = (rootUri, rootPath) => ({
  processId: process.pid,
  rootUri,
  rootPath,
  workspaceFolders: [{ uri: rootUri, name: 'probe' }],
  capabilities: {
    workspace: {
      configuration: true,
      symbol: { dynamicRegistration: true },
      workspaceEdit: { documentChanges: true },
    },
    textDocument: {
      synchronization: { didSave: true, dynamicRegistration: true },
      documentSymbol: { hierarchicalDocumentSymbolSupport: true },
      references: { dynamicRegistration: true },
      definition: { dynamicRegistration: true },
      publishDiagnostics: { relatedInformation: true },
    },
    window: { workDoneProgress: true },
  },
  initializationOptions: {
    settings: {
      java: {
        // Import the project so dependencies resolve; this is the expensive part we are measuring.
        import: { maven: { enabled: true }, gradle: { enabled: true } },
        autobuild: { enabled: false },
        maxConcurrentBuilds: 4,
        errors: { incompleteClasspath: { severity: 'warning' } },
      },
    },
  },
});
