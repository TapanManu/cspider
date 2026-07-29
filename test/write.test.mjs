// Review write path (tasks 9.1–9.12), against a mocked GitHub.
//
// The assertion that matters most: NOTHING reaches GitHub before an explicit confirmation. Every
// mock records every call, and the tests check the recorder is empty where it must be.

import { openDb } from '../src/store/db.mjs';
import { saveAnalysis, loadUnits } from '../src/store/persist.mjs';
import { createApiServer } from '../src/server/server.mjs';
import {
  createDraft, listDrafts, deleteDraft, updateDraft, previewReview, submitReview,
  headMoved, fetchThreads, replyToThread, suggestionBody, anchorable, EVENTS,
  sharedTargets, createSharedDraft, listGroup, updateGroup, deleteGroup,
} from '../src/review/drafts.mjs';
import { parseSymbols } from '../src/java/parse.mjs';
import { diffSymbols, classifyNoise } from '../src/java/diff.mjs';
import { provisionalSeverity } from '../src/review/order.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

let pass = 0; let fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
};

const PRID = 'acme/svc#7';
const REL = 'src/main/java/com/acme/Svc.java';

// A real two-commit repo laid out exactly as the cache does it — <cache>/clones/<owner>__<repo> —
// so the server's clone-path resolution is exercised rather than bypassed.
function fixture() {
  const cache = mkdtempSync(join(tmpdir(), 'cspider-write-'));
  const dir = join(cache, 'clones', 'acme__svc');
  mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@e.com'); git('config', 'user.name', 'T');
  mkdirSync(join(dir, 'src/main/java/com/acme'), { recursive: true });

  const v1 = `package com.acme;

public class Svc {
  public void f(String s) {
    log(s);
  }
}
`;
  writeFileSync(join(dir, REL), v1);
  git('add', '-A'); git('commit', '-qm', 'v1');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  const v2 = v1.replace('public void f(String s) {\n    log(s);', 'public void f(String s, int n) {\n    log(s);\n    log(n);');
  writeFileSync(join(dir, REL), v2);
  git('add', '-A'); git('commit', '-qm', 'v2');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  return { cache, dir, base, head, v1, v2 };
}

const F = fixture();
const PR = { nwo: 'acme/svc', number: 7, headSha: F.head, mergeBase: F.base, files: [{ filename: REL }] };

// Records every call; returns canned responses. If a test finds entries here that it did not
// expect, something posted without confirmation.
function mockGh(responses = {}) {
  const calls = [];
  const fn = (args, opts) => {
    calls.push({ args, input: opts?.input });
    const key = args.join(' ');
    for (const [match, body] of Object.entries(responses)) {
      if (key.includes(match)) {
        if (body instanceof Error) throw body;
        return typeof body === 'string' ? body : JSON.stringify(body);
      }
    }
    return '{}';
  };
  fn.calls = calls;
  fn.writes = () => calls.filter((c) => c.args.includes('--method') || c.args.includes('POST'));
  return fn;
}

function freshDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'cspider-wdb-')), 'db.sqlite'));
  const baseT = new Map([[REL, parseSymbols(F.v1, REL)]]);
  const headT = new Map([[REL, parseSymbols(F.v2, REL)]]);
  const { units } = diffSymbols('acme/svc', baseT, headT);
  for (const u of units) { u.severity = provisionalSeverity(u); u.noise = classifyNoise(u); }
  saveAnalysis(db, {
    pr: { nwo: 'acme/svc', number: 7, repo: 'svc' },
    meta: { headRefOid: F.head, title: 'T', url: 'u' },
    mergeBase: F.base, buildRoots: { primary: '.' }, units, graph: null,
  });
  return { db, units };
}

console.log('\nwrite — anchoring at draft time (9.1, 9.2, 9.3)');

await t('a line inside the diff anchors inline', async () => {
  const { db } = freshDb();
  // v2 adds `log(n);` — an added line, so it is in the diff on the RIGHT side.
  const lineNo = F.v2.split('\n').findIndex((l) => l.includes('log(n)')) + 1;
  const chk = anchorable(F.dir, PR, REL, lineNo, 'RIGHT');
  assert.ok(chk.ok, chk.reason);
  const out = createDraft(db, { prId: PRID, pr: PR, path: REL, line: lineNo, body: 'why twice?' },
    { clonePath: F.dir });
  assert.equal(out.scope, 'inline');
});

await t('a line outside the diff falls back to a PR-level comment with its location', async () => {
  const { db } = freshDb();
  const out = createDraft(db, { prId: PRID, pr: PR, path: 'src/main/java/com/acme/Other.java', line: 40, body: 'stale caller' },
    { clonePath: F.dir });
  assert.equal(out.scope, 'pr');
  assert.match(out.reason, /not part of this pull request's diff|not in the diff/);
  const d = listDrafts(db, PRID)[0];
  assert.match(d.body, /Other\.java:40/, 'the location survives into the body');
  assert.equal(d.side, null, 'a pr-level draft carries no side');
});

await t('a draft with neither body nor suggestion is refused', async () => {
  const { db } = freshDb();
  assert.throws(() => createDraft(db, { prId: PRID, pr: PR, path: REL, line: 5 }, { clonePath: F.dir }),
    /needs a body or a suggestion/);
});

await t('a suggestion outside the diff is refused rather than silently downgraded', async () => {
  const { db } = freshDb();
  assert.throws(() => createDraft(db,
    { prId: PRID, pr: PR, path: 'src/main/java/com/acme/Other.java', line: 9, suggestion: 'x();' },
    { clonePath: F.dir }), /cannot suggest a change/);
});

console.log('\nwrite — suggestions (9.4)');

await t('suggestion bodies are well-formed GitHub suggestion blocks', () => {
  const b = suggestionBody('use the overload', 'foo(a, b);');
  assert.match(b, /```suggestion\nfoo\(a, b\);\n```/);
  assert.match(b, /^use the overload/);
});

await t('a suggestion-only draft still produces a valid body', async () => {
  const { db } = freshDb();
  const lineNo = F.v2.split('\n').findIndex((l) => l.includes('log(n)')) + 1;
  createDraft(db, { prId: PRID, pr: PR, path: REL, line: lineNo, suggestion: 'log(n, s);' },
    { clonePath: F.dir });
  assert.match(listDrafts(db, PRID)[0].body, /```suggestion/);
});

console.log('\nwrite — local first: NOTHING posts without confirmation (9.5, 9.8)');

await t('creating, editing and deleting drafts issues no GitHub call at all', async () => {
  const { db } = freshDb();
  const gh = mockGh();
  const lineNo = F.v2.split('\n').findIndex((l) => l.includes('log(n)')) + 1;
  const { draftId } = createDraft(db, { prId: PRID, pr: PR, path: REL, line: lineNo, body: 'a' }, { clonePath: F.dir });
  updateDraft(db, PRID, draftId, 'b');
  previewReview(db, PRID, PR, 'REQUEST_CHANGES', 'summary');
  deleteDraft(db, PRID, draftId);
  assert.equal(gh.calls.length, 0, JSON.stringify(gh.calls));
});

await t('submit without confirmed:true sends nothing', async () => {
  const { db } = freshDb();
  const gh = mockGh();
  const lineNo = F.v2.split('\n').findIndex((l) => l.includes('log(n)')) + 1;
  createDraft(db, { prId: PRID, pr: PR, path: REL, line: lineNo, body: 'a' }, { clonePath: F.dir });
  const res = submitReview(db, PRID, PR, { event: 'COMMENT' }, gh);
  assert.equal(res.submitted, false);
  assert.match(res.reason, /not confirmed/);
  assert.equal(gh.calls.length, 0, 'not even a head check');
  assert.equal(listDrafts(db, PRID)[0].submittedAt, null, 'the draft is untouched');
});

await t('the preview is the exact payload that would be sent', async () => {
  const { db } = freshDb();
  const lineNo = F.v2.split('\n').findIndex((l) => l.includes('log(n)')) + 1;
  createDraft(db, { prId: PRID, pr: PR, path: REL, line: lineNo, body: 'inline one' }, { clonePath: F.dir });
  createDraft(db, { prId: PRID, pr: PR, path: 'src/main/java/com/acme/Other.java', line: 3, body: 'outside' }, { clonePath: F.dir });

  const p = previewReview(db, PRID, PR, 'REQUEST_CHANGES', 'top level');
  assert.equal(p.endpoint, '/repos/acme/svc/pulls/7/reviews'.replace(/^/, 'POST '));
  assert.equal(p.payload.event, 'REQUEST_CHANGES');
  assert.equal(p.payload.commit_id, F.head);
  assert.equal(p.payload.comments.length, 1);
  assert.equal(p.payload.comments[0].path, REL);
  assert.equal(p.payload.comments[0].side, 'RIGHT');
  assert.match(p.payload.body, /top level/);
  assert.match(p.payload.body, /Other\.java:3/, 'the pr-level draft is folded into the body, still visible');
  assert.equal(p.counts.inline, 1);
  assert.equal(p.counts.prLevel, 1);

  const gh = mockGh({ 'pulls/7/reviews': { id: 1, html_url: 'u' }, 'headRefOid': { headRefOid: F.head } });
  submitReview(db, PRID, PR, { event: 'REQUEST_CHANGES', body: 'top level', confirmed: true }, gh);
  const sent = JSON.parse(gh.calls.find((c) => c.input).input);
  assert.deepEqual(sent, p.payload, 'what was previewed is byte-for-byte what was sent');
});

await t('an invalid event is refused', () => {
  const { db } = freshDb();
  assert.throws(() => previewReview(db, PRID, PR, 'LGTM'), /event must be one of/);
  assert.deepEqual(EVENTS, ['COMMENT', 'APPROVE', 'REQUEST_CHANGES']);
});

console.log('\nwrite — stale head protection (9.9)');

await t('a moved head blocks submission and keeps the drafts', async () => {
  const { db } = freshDb();
  const lineNo = F.v2.split('\n').findIndex((l) => l.includes('log(n)')) + 1;
  createDraft(db, { prId: PRID, pr: PR, path: REL, line: lineNo, body: 'a' }, { clonePath: F.dir });
  const gh = mockGh({ headRefOid: { headRefOid: 'f'.repeat(40) } });
  const res = submitReview(db, PRID, PR, { event: 'COMMENT', confirmed: true }, gh);
  assert.equal(res.submitted, false);
  assert.match(res.reason, /head moved/);
  assert.equal(gh.calls.filter((c) => c.input).length, 0, 'no review was posted');
  assert.equal(listDrafts(db, PRID)[0].submittedAt, null, 'drafts retained');
});

await t('headMoved reports both shas', () => {
  const gh = mockGh({ headRefOid: { headRefOid: 'abc' } });
  const r = headMoved(PR, gh);
  assert.equal(r.moved, true);
  assert.equal(r.current, 'abc');
  assert.equal(r.was, F.head);
});

console.log('\nwrite — submission outcome (9.6, 9.10)');

await t('a confirmed submit posts once and marks the drafts submitted', async () => {
  const { db } = freshDb();
  const lineNo = F.v2.split('\n').findIndex((l) => l.includes('log(n)')) + 1;
  createDraft(db, { prId: PRID, pr: PR, path: REL, line: lineNo, body: 'a' }, { clonePath: F.dir });
  const gh = mockGh({ 'pulls/7/reviews': { id: 42, html_url: 'https://x/1' }, headRefOid: { headRefOid: F.head } });
  const res = submitReview(db, PRID, PR, { event: 'APPROVE', confirmed: true }, gh);
  assert.equal(res.submitted, true);
  assert.equal(res.reviewId, 42);
  assert.equal(res.event, 'APPROVE');
  const posts = gh.calls.filter((c) => c.input);
  assert.equal(posts.length, 1, 'exactly one review posted');
  const d = listDrafts(db, PRID)[0];
  assert.ok(d.submittedAt, 'marked submitted');
  assert.equal(d.reviewId, '42');
});

await t('a rejected submit retains every draft', async () => {
  const { db } = freshDb();
  const lineNo = F.v2.split('\n').findIndex((l) => l.includes('log(n)')) + 1;
  createDraft(db, { prId: PRID, pr: PR, path: REL, line: lineNo, body: 'a' }, { clonePath: F.dir });
  const err = new Error('422'); err.stderr = 'HTTP 422: line must be part of the diff';
  const gh = mockGh({ 'pulls/7/reviews': err, headRefOid: { headRefOid: F.head } });
  const res = submitReview(db, PRID, PR, { event: 'COMMENT', confirmed: true }, gh);
  assert.equal(res.submitted, false);
  assert.match(res.reason, /GitHub rejected/);
  assert.equal(res.retainedDrafts, 1);
  assert.equal(listDrafts(db, PRID)[0].submittedAt, null);
});

await t('submitting with nothing to say is refused', async () => {
  const { db } = freshDb();
  const gh = mockGh({ headRefOid: { headRefOid: F.head } });
  const res = submitReview(db, PRID, PR, { event: 'COMMENT', confirmed: true }, gh);
  assert.equal(res.submitted, false);
  assert.match(res.reason, /nothing to send/);
});

await t('already-submitted drafts are not resent', async () => {
  const { db } = freshDb();
  const lineNo = F.v2.split('\n').findIndex((l) => l.includes('log(n)')) + 1;
  createDraft(db, { prId: PRID, pr: PR, path: REL, line: lineNo, body: 'a' }, { clonePath: F.dir });
  const gh = mockGh({ 'pulls/7/reviews': { id: 1 }, headRefOid: { headRefOid: F.head } });
  submitReview(db, PRID, PR, { event: 'COMMENT', confirmed: true }, gh);
  const second = submitReview(db, PRID, PR, { event: 'COMMENT', confirmed: true }, gh);
  assert.equal(second.submitted, false, 'nothing pending, so nothing to send');
  assert.equal(gh.calls.filter((c) => c.input).length, 1, 'still exactly one post');
});

console.log('\nwrite — existing threads (9.11)');

await t('threads group replies under their root comment', () => {
  const gh = mockGh({
    'pulls/7/comments': [
      { id: 1, user: { login: 'a' }, body: 'root', path: REL, line: 4, created_at: '1' },
      { id: 2, in_reply_to_id: 1, user: { login: 'b' }, body: 'reply', path: REL, line: 4, created_at: '2' },
      { id: 3, user: { login: 'c' }, body: 'other', path: REL, line: 9, created_at: '3' },
    ],
  });
  const { threads, error } = fetchThreads(PR, gh);
  assert.equal(error, null);
  assert.equal(threads.length, 2);
  const root = threads.find((x) => x.rootId === 1);
  assert.equal(root.comments.length, 2);
  assert.deepEqual(root.comments.map((c) => c.author), ['a', 'b']);
});

await t('a reply without confirmation sends nothing', () => {
  const gh = mockGh();
  const r = replyToThread(PR, { rootId: 1, body: 'ok' }, gh);
  assert.equal(r.sent, false);
  assert.equal(gh.calls.length, 0);
});

await t('a confirmed reply posts once', () => {
  const gh = mockGh({ replies: { id: 9, html_url: 'u' } });
  const r = replyToThread(PR, { rootId: 1, body: 'ok', confirmed: true }, gh);
  assert.equal(r.sent, true);
  assert.equal(r.id, 9);
  assert.equal(gh.calls.filter((c) => c.input).length, 1);
});

console.log('\nwrite — HTTP surface');

const call = (server, method, path, body) => new Promise((resolve, reject) => {
  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, body
        ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : { method });
      resolve({ status: r.status, body: await r.json() });
    } catch (e) { reject(e); } finally { server.close(); }
  });
});

const bootApi = (gh) => {
  const dir = mkdtempSync(join(tmpdir(), 'cspider-wapi-'));
  const dbPath = join(dir, 'db.sqlite');
  const { db } = freshDbAt(dbPath);
  const { server } = createApiServer({ cacheDir: F.cache, dbPath, gh });
  return { server, db, dbPath };
};
function freshDbAt(dbPath) {
  const db = openDb(dbPath);
  const baseT = new Map([[REL, parseSymbols(F.v1, REL)]]);
  const headT = new Map([[REL, parseSymbols(F.v2, REL)]]);
  const { units } = diffSymbols('acme/svc', baseT, headT);
  for (const u of units) { u.severity = provisionalSeverity(u); u.noise = classifyNoise(u); }
  saveAnalysis(db, {
    pr: { nwo: 'acme/svc', number: 7, repo: 'svc' },
    meta: { headRefOid: F.head, title: 'T', url: 'u' },
    mergeBase: F.base, buildRoots: { primary: '.' }, units, graph: null,
  });
  return { db, units };
}
const ENC = encodeURIComponent(PRID);

await t('POST /drafts then GET /drafts round-trips, with no GitHub call', async () => {
  const gh = mockGh();
  const dir = mkdtempSync(join(tmpdir(), 'cspider-wapi-'));
  const dbPath = join(dir, 'db.sqlite');
  freshDbAt(dbPath);
  const lineNo = F.v2.split('\n').findIndex((l) => l.includes('log(n)')) + 1;

  // Two separate server instances over the SAME db, to prove the draft is persisted rather than
  // held in memory by the process that created it.
  const made = await call(createApiServer({ cacheDir: F.cache, dbPath, gh }).server,
    'POST', `/api/pr/${ENC}/drafts`, { path: REL, line: lineNo, body: 'from http' });
  assert.equal(made.body.ok, true, JSON.stringify(made.body));
  assert.equal(made.body.scope, 'inline');

  const got = await call(createApiServer({ cacheDir: F.cache, dbPath, gh }).server,
    'GET', `/api/pr/${ENC}/drafts`);
  assert.equal(got.body.pending, 1, JSON.stringify(got.body));
  assert.equal(got.body.drafts[0].body, 'from http');
  assert.deepEqual(got.body.events, EVENTS);
  assert.equal(gh.calls.length, 0, 'drafting never touches GitHub');
});

await t('a draft survives delete and update through HTTP', async () => {
  const gh = mockGh();
  const dir = mkdtempSync(join(tmpdir(), 'cspider-wapi-'));
  const dbPath = join(dir, 'db.sqlite');
  freshDbAt(dbPath);
  const lineNo = F.v2.split('\n').findIndex((l) => l.includes('log(n)')) + 1;
  const made = await call(createApiServer({ cacheDir: F.cache, dbPath, gh }).server,
    'POST', `/api/pr/${ENC}/drafts`, { path: REL, line: lineNo, body: 'first' });
  const id = made.body.draftId;

  const upd = await call(createApiServer({ cacheDir: F.cache, dbPath, gh }).server,
    'POST', `/api/pr/${ENC}/drafts/update`, { draftId: id, body: 'second' });
  assert.equal(upd.body.ok, true);

  const del = await call(createApiServer({ cacheDir: F.cache, dbPath, gh }).server,
    'POST', `/api/pr/${ENC}/drafts/delete`, { draftId: id });
  assert.equal(del.body.ok, true);

  const after = await call(createApiServer({ cacheDir: F.cache, dbPath, gh }).server,
    'GET', `/api/pr/${ENC}/drafts`);
  assert.equal(after.body.pending, 0);
  assert.equal(gh.calls.length, 0);
});

await t('POST /review/submit without confirmed is a 409 and posts nothing', async () => {
  const gh = mockGh({ headRefOid: { headRefOid: F.head } });
  const { server } = bootApi(gh);
  const { status, body } = await call(server, 'POST', `/api/pr/${ENC}/review/submit`, { event: 'COMMENT' });
  assert.equal(status, 409);
  assert.match(body.reason, /not confirmed/);
  assert.equal(gh.calls.length, 0);
});

await t('unknown PR is a 404 on every write route', async () => {
  const gh = mockGh();
  for (const [m, p] of [['GET', '/drafts'], ['POST', '/drafts'], ['POST', '/review/preview'],
    ['POST', '/review/submit'], ['GET', '/threads'], ['GET', '/head']]) {
    const { server } = bootApi(gh);
    const { status } = await call(server, m, `/api/pr/nope%231${p}`, m === 'POST' ? { path: 'x' } : undefined);
    assert.equal(status, 404, `${m} ${p}`);
  }
});

// ---------------------------------------------------------------- shared findings (9.7)
//
// One body, several PRs, each anchored to its own location. The point of these tests is that the
// anchors are resolved PER PR: a line number from one repository must never be reused in another.

// A second repository declaring the SAME FQN, inside the same cache layout so the server's
// clone-path resolution is exercised for both.
function fixture2() {
  const dir = join(F.cache, 'clones', 'acme__lib');
  mkdirSync(join(dir, 'src/main/java/com/acme'), { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@e.com'); git('config', 'user.name', 'T');

  // Padded so f() sits at a different line number than it does in acme/svc — if the code ever
  // reused the source PR's line, these tests would catch it.
  const v1 = `package com.acme;

// padding
// padding
// padding
// padding
public class Svc {
  public void f(String s) {
    log(s);
  }
}
`;
  writeFileSync(join(dir, REL), v1);
  git('add', '-A'); git('commit', '-qm', 'v1');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const v2 = v1.replace('public void f(String s) {\n    log(s);', 'public void f(String s, int n) {\n    log(s);\n    log(n);');
  writeFileSync(join(dir, REL), v2);
  git('add', '-A'); git('commit', '-qm', 'v2');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, base, head, v1, v2 };
}

const F2 = fixture2();
const PRID2 = 'acme/lib#9';

/** Both PRs in one store, which is what sharedTargets searches. */
function twoPrDb(dbPath) {
  const db = dbPath ? openDb(dbPath) : openDb(join(mkdtempSync(join(tmpdir(), 'cspider-shdb-')), 'db.sqlite'));
  for (const [nwo, number, f, repo] of [['acme/svc', 7, F, 'svc'], ['acme/lib', 9, F2, 'lib']]) {
    const baseT = new Map([[REL, parseSymbols(f.v1, REL)]]);
    const headT = new Map([[REL, parseSymbols(f.v2, REL)]]);
    const { units } = diffSymbols(nwo, baseT, headT);
    for (const u of units) { u.severity = provisionalSeverity(u); u.noise = classifyNoise(u); }
    saveAnalysis(db, {
      pr: { nwo, number, repo },
      meta: { headRefOid: f.head, title: 'T', url: 'u' },
      mergeBase: f.base, buildRoots: { primary: '.' }, units, graph: null,
    });
  }
  return db;
}

const prsForTargets = (db) => db.prepare('SELECT * FROM prs').all()
  .map((r) => ({ prId: r.id, units: loadUnits(db, r.id, r.head_sha) ?? [] }));

const modifiedF = (db, prId, headSha) =>
  (loadUnits(db, prId, headSha) ?? []).find((u) => u.fqn.includes('#f(') && u.changeKind === 'MODIFIED')
  ?? (loadUnits(db, prId, headSha) ?? []).find((u) => u.fqn.includes('#f('));

console.log('\nwrite — shared findings across PRs (9.7)');

await t('the same symbol in another PR is found as a target, with that PR\'s own line', async () => {
  const db = twoPrDb();
  const src = modifiedF(db, PRID, F.head);
  const { targets } = sharedTargets(db, { fqn: src.fqn, sourcePrId: PRID, prs: prsForTargets(db) });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].prId, PRID2);
  const mine = modifiedF(db, PRID2, F2.head);
  assert.equal(targets[0].line, mine.symbol.range.start.line + 1);
  assert.notEqual(targets[0].line, src.symbol.range.start.line + 1,
    'acme/lib is padded, so reusing the source line would be a bug');
});

await t('the source PR is never its own target', async () => {
  const db = twoPrDb();
  const src = modifiedF(db, PRID, F.head);
  const { targets } = sharedTargets(db, { fqn: src.fqn, sourcePrId: PRID, prs: prsForTargets(db) });
  assert.ok(!targets.some((x) => x.prId === PRID), 'would double-comment the PR being reviewed');
});

await t('a PR that does not change the symbol is skipped WITH a reason, not dropped', async () => {
  const db = twoPrDb();
  const { targets, skipped } = sharedTargets(db,
    { fqn: 'com.acme.Nowhere#gone()', sourcePrId: PRID, prs: prsForTargets(db) });
  assert.equal(targets.length, 0);
  assert.equal(skipped.length, 1, 'the other PR must be accounted for, not omitted');
  assert.match(skipped[0].reason, /does not change/);
});

await t('a REMOVED symbol is targeted on the base side (F19)', async () => {
  const db = twoPrDb();
  const prs = prsForTargets(db);
  // Force the change kind, since both fixtures modify rather than delete.
  const unit = prs.find((p) => p.prId === PRID2).units.find((u) => u.fqn.includes('#f('));
  unit.changeKind = 'REMOVED';
  const { targets } = sharedTargets(db, { fqn: unit.fqn, sourcePrId: PRID, prs });
  assert.equal(targets[0].side, 'LEFT', 'deleted code exists only at base');
});

await t('one body becomes one draft per PR, sharing a group id', async () => {
  const db = twoPrDb();
  const t1 = modifiedF(db, PRID, F.head);
  const t2 = modifiedF(db, PRID2, F2.head);
  const out = createSharedDraft(db, {
    body: 'this pattern is wrong in both repos',
    targets: [
      { prId: PRID, unitId: t1.id, path: REL, line: F.v2.split('\n').findIndex((l) => l.includes('log(n)')) + 1, clonePath: F.dir, pr: { ...PR } },
      { prId: PRID2, unitId: t2.id, path: REL, line: F2.v2.split('\n').findIndex((l) => l.includes('log(n)')) + 1, clonePath: F2.dir, pr: { nwo: 'acme/lib', number: 9, headSha: F2.head, mergeBase: F2.base, files: [{ filename: REL }] } },
    ],
  });
  assert.equal(out.created, 2);
  const a = listDrafts(db, PRID);
  const b = listDrafts(db, PRID2);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].groupId, out.groupId);
  assert.equal(b[0].groupId, out.groupId);
  assert.equal(a[0].body, b[0].body, 'one body');
  assert.equal(a[0].commitSha, F.head);
  assert.equal(b[0].commitSha, F2.head, 'each draft pins its own PR\'s head');
  assert.equal(listGroup(db, out.groupId).length, 2);
});

await t('each PR resolves its own anchor, and a mixed outcome is reported per PR', async () => {
  const db = twoPrDb();
  const t1 = modifiedF(db, PRID, F.head);
  const out = createSharedDraft(db, {
    body: 'shared',
    targets: [
      { prId: PRID, unitId: t1.id, path: REL, line: F.v2.split('\n').findIndex((l) => l.includes('log(n)')) + 1, clonePath: F.dir, pr: { ...PR } },
      // Not in acme/lib's diff at all — must fall back on its own, not inherit PR 1's success.
      { prId: PRID2, path: 'src/main/java/com/acme/Elsewhere.java', line: 400, clonePath: F2.dir, pr: { nwo: 'acme/lib', number: 9, headSha: F2.head, mergeBase: F2.base, files: [{ filename: REL }] } },
    ],
  });
  const byPr = Object.fromEntries(out.results.map((r) => [r.prId, r]));
  assert.equal(byPr[PRID].scope, 'inline');
  assert.equal(byPr[PRID2].scope, 'pr');
  assert.ok(byPr[PRID2].reason, 'the fallback must state why');
  assert.equal(out.created, 2, 'a pr-level fallback is still a saved draft');
});

await t('editing a shared finding edits every unsubmitted sibling', async () => {
  const db = twoPrDb();
  const t1 = modifiedF(db, PRID, F.head);
  const t2 = modifiedF(db, PRID2, F2.head);
  const mk = (prId, f, dir, unitId) => ({
    prId, unitId, path: REL, line: f.v2.split('\n').findIndex((l) => l.includes('log(n)')) + 1,
    clonePath: dir, pr: { nwo: prId.split('#')[0], number: Number(prId.split('#')[1]), headSha: f.head, mergeBase: f.base, files: [{ filename: REL }] },
  });
  const out = createSharedDraft(db, { body: 'v1', targets: [mk(PRID, F, F.dir, t1.id), mk(PRID2, F2, F2.dir, t2.id)] });
  assert.equal(updateGroup(db, out.groupId, 'v2 everywhere'), 2);
  assert.equal(listDrafts(db, PRID)[0].body, 'v2 everywhere');
  assert.equal(listDrafts(db, PRID2)[0].body, 'v2 everywhere');
  assert.equal(deleteGroup(db, out.groupId), 2);
  assert.equal(listDrafts(db, PRID).length, 0);
  assert.equal(listDrafts(db, PRID2).length, 0);
});

await t('a shared finding still submits as one review per PR', async () => {
  const db = twoPrDb();
  const t1 = modifiedF(db, PRID, F.head);
  const t2 = modifiedF(db, PRID2, F2.head);
  const mk = (prId, f, dir, unitId) => ({
    prId, unitId, path: REL, line: f.v2.split('\n').findIndex((l) => l.includes('log(n)')) + 1,
    clonePath: dir, pr: { nwo: prId.split('#')[0], number: Number(prId.split('#')[1]), headSha: f.head, mergeBase: f.base, files: [{ filename: REL }] },
  });
  createSharedDraft(db, { body: 'shared finding', targets: [mk(PRID, F, F.dir, t1.id), mk(PRID2, F2, F2.dir, t2.id)] });

  const p1 = previewReview(db, PRID, { ...PR }, 'COMMENT');
  const p2 = previewReview(db, PRID2, { nwo: 'acme/lib', number: 9, headSha: F2.head }, 'COMMENT');
  assert.equal(p1.payload.comments.length, 1);
  assert.equal(p2.payload.comments.length, 1);
  assert.equal(p1.payload.commit_id, F.head);
  assert.equal(p2.payload.commit_id, F2.head, 'each review pins its own head, not the other PR\'s');
  assert.notEqual(p1.endpoint, p2.endpoint);
});

await t('a shared draft reaches GitHub only through the normal confirmed submit', async () => {
  const gh = mockGh({ headRefOid: { headRefOid: F.head }, reviews: { id: 555 } });
  const db = twoPrDb();
  const t1 = modifiedF(db, PRID, F.head);
  createSharedDraft(db, {
    body: 'shared',
    targets: [{ prId: PRID, unitId: t1.id, path: REL, line: F.v2.split('\n').findIndex((l) => l.includes('log(n)')) + 1, clonePath: F.dir, pr: { ...PR } }],
  }, {});
  assert.equal(gh.calls.length, 0, 'creating a shared draft must not touch GitHub');
  const r = submitReview(db, PRID, { ...PR }, { event: 'COMMENT', confirmed: false }, gh);
  assert.equal(r.submitted, false);
  assert.equal(gh.calls.length, 0);
  // And with confirmation it does go, so the refusal above is the flag's doing, not a broken call.
  const ok = submitReview(db, PRID, { ...PR }, { event: 'COMMENT', confirmed: true }, gh);
  assert.equal(ok.submitted, true);
  assert.equal(gh.writes().length, 1, 'exactly one review per PR, even for a shared finding');
});

console.log('\nwrite — shared findings over HTTP');

await t('GET /api/shared/targets reports targets and skips together', async () => {
  const gh = mockGh();
  const dir = mkdtempSync(join(tmpdir(), 'cspider-shapi-'));
  const dbPath = join(dir, 'db.sqlite');
  const db = twoPrDb(dbPath);
  const src = modifiedF(db, PRID, F.head);
  const { server } = createApiServer({ cacheDir: F.cache, dbPath, gh });
  const { status, body } = await call(server, 'GET',
    `/api/shared/targets?prId=${ENC}&unitId=${encodeURIComponent(src.id)}`);
  assert.equal(status, 200);
  assert.equal(body.targets.length, 1);
  assert.equal(body.targets[0].prId, PRID2);
  assert.equal(gh.calls.length, 0);
});

await t('POST /api/shared/drafts creates one draft per PR and returns per-PR outcomes', async () => {
  const gh = mockGh();
  const dir = mkdtempSync(join(tmpdir(), 'cspider-shapi2-'));
  const dbPath = join(dir, 'db.sqlite');
  const db = twoPrDb(dbPath);
  const src = modifiedF(db, PRID, F.head);
  const tgt = await call(createApiServer({ cacheDir: F.cache, dbPath, gh }).server, 'GET',
    `/api/shared/targets?prId=${ENC}&unitId=${encodeURIComponent(src.id)}`);
  const { status, body } = await call(createApiServer({ cacheDir: F.cache, dbPath, gh }).server,
    'POST', '/api/shared/drafts', { body: 'one finding, two PRs', targets: tgt.body.targets });
  assert.equal(status, 200);
  assert.equal(body.results.length, 1);
  assert.ok(body.groupId);
  assert.equal(gh.calls.length, 0, 'no GitHub call while drafting');

  const listed = await call(createApiServer({ cacheDir: F.cache, dbPath, gh }).server, 'GET',
    `/api/pr/${encodeURIComponent(PRID2)}/drafts`);
  assert.equal(listed.body.pending, 1);
  assert.equal(listed.body.drafts[0].groupId, body.groupId);
});

await t('a shared comment with no targets is refused', async () => {
  const gh = mockGh();
  const dir = mkdtempSync(join(tmpdir(), 'cspider-shapi3-'));
  const dbPath = join(dir, 'db.sqlite');
  twoPrDb(dbPath);
  const { status } = await call(createApiServer({ cacheDir: F.cache, dbPath, gh }).server,
    'POST', '/api/shared/drafts', { body: 'x', targets: [] });
  assert.equal(status, 400);
});

await t('a shared comment naming an unknown PR is a 404 and writes nothing', async () => {
  const gh = mockGh();
  const dir = mkdtempSync(join(tmpdir(), 'cspider-shapi4-'));
  const dbPath = join(dir, 'db.sqlite');
  const db = twoPrDb(dbPath);
  const { status } = await call(createApiServer({ cacheDir: F.cache, dbPath, gh }).server,
    'POST', '/api/shared/drafts', { body: 'x', targets: [{ prId: 'nope#1', path: REL, line: 1 }] });
  assert.equal(status, 404);
  assert.equal(listDrafts(db, PRID).length, 0, 'a bad target must not half-create the group');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
