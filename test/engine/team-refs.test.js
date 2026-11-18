// Event triggers (main/engine/team/refs-watch.js, docs/POSITIONS.md 9.4) against REAL temp git repos: baseline,
// commits on the watched branch, paths filters, tags, worktrees, packed-refs, catch-up after a "restart", folders
// that vanish or are not repos, and single-file triggers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createRefsWatch, resolveRepo, globToRegExp, parseLog } = require('../../main/engine/team/refs-watch');

const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'helm-team-refs-'))); // long form (resolveRepo real-paths; CI TEMP is 8.3)
const HOOKS = path.join(ROOT, '_nohooks');
fs.mkdirSync(HOOKS);
test.after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 }); } catch {} });

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=' + HOOKS, '-c', 'commit.gpgsign=false',
  '-c', 'tag.gpgsign=false', '-c', 'init.defaultBranch=master', ...args], { cwd, env: ENV, encoding: 'utf8', windowsHide: true }).trim();
let n = 0;
function repo(name = 'r' + ++n) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  commit(dir, 'README.md', 'hello', 'first');
  return dir;
}
function commit(dir, file, text, msg) {
  const p = path.join(dir, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}
function memState(init = {}) {
  const m = new Map(Object.entries(JSON.parse(JSON.stringify(init))));
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, JSON.parse(JSON.stringify(v))), dump: () => Object.fromEntries(m) };
}
function watcher(opts = {}) {
  const events = [];
  const state = opts.state || memState();
  const w = createRefsWatch({ debounceMs: 40, fileDebounceMs: 40, recheckMs: 0, pokeMs: 0, state, onEvent: (e) => events.push(e), ...opts });
  return { w, events, state };
}
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
}

test('globs: tag and path patterns', () => {
  assert.ok(globToRegExp('v*').test('v1.3.0'));
  assert.ok(!globToRegExp('v*').test('release-1'));
  assert.ok(!globToRegExp('v*').test('v1/x'));
  const p = globToRegExp('**/privacy*');
  assert.ok(p.test('privacy.html'));
  assert.ok(p.test('site/legal/privacy.html'));
  assert.ok(!p.test('site/terms.html'));
  assert.ok(globToRegExp('site/**').test('site/a/b.css'));
  assert.ok(globToRegExp('*.md').test('README.md'));
  assert.ok(!globToRegExp('*.md').test('docs/README.md'));
  assert.ok(globToRegExp('a.b?').test('a.bc') && !globToRegExp('a.b?').test('axbc'));
});

test('parseLog: subjects, times and files', () => {
  const out = '\x1eaaaaaaa1\x1f1700000000\x1ffix: thing\nsite/a.html\nb.js\n\n\x1ebbbbbbb2\x1f1700000100\x1fsecond\x1fwith sep\n';
  const c = parseLog(out);
  assert.equal(c.length, 2);
  assert.deepEqual(c[0], { sha: 'aaaaaaa1', at: 1700000000000, subject: 'fix: thing', files: ['site/a.html', 'b.js'] });
  assert.equal(c[1].subject, 'second\x1fwith sep');
  assert.deepEqual(c[1].files, []);
});

test('resolveRepo: plain repo, worktree, not a repo, missing', () => {
  const dir = repo();
  const r = resolveRepo(dir);
  assert.equal(path.resolve(r.commonDir), path.resolve(dir, '.git'));
  const wt = path.join(ROOT, 'wt-' + n);
  git(dir, 'worktree', 'add', '-q', '-b', 'wk/x', wt);
  const w = resolveRepo(wt);
  assert.equal(path.resolve(w.commonDir).toLowerCase(), path.resolve(dir, '.git').toLowerCase());
  assert.notEqual(path.resolve(w.gitDir), path.resolve(w.commonDir));
  const plain = path.join(ROOT, 'plain-' + n);
  fs.mkdirSync(plain);
  assert.deepEqual(resolveRepo(plain), { problem: 'not-a-repo' });
  assert.deepEqual(resolveRepo(path.join(ROOT, 'nope')), { problem: 'missing' });
});

test('first sight is a baseline; a commit on the branch is one event with subjects and files', async () => {
  const dir = repo();
  const { w, events, state } = watcher();
  w.setTargets([{ id: 'c1', kind: 'commit', folder: dir }]);
  await w.idle();
  assert.equal(events.length, 0);
  assert.ok(state.get('refs'), 'baseline stored');
  const before = git(dir, 'rev-parse', 'HEAD');
  commit(dir, 'a.txt', '1', 'add a');
  const sha = commit(dir, 'site/b.txt', '2', 'add b');
  await w.checkAll();
  w.stop();
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.kind, 'commit');
  assert.equal(e.branch, 'master');
  assert.equal(e.old, before);
  assert.equal(e.new, sha);
  assert.equal(e.count, 2);
  assert.deepEqual(e.commits.map((c) => c.subject), ['add b', 'add a']);
  assert.deepEqual(e.files.sort(), ['a.txt', 'site/b.txt']);
  assert.equal(e.catchUp, false);
  assert.ok(e.newestAt > 0);
});

test('fs.watch on refs fires the check by itself (debounced to one event)', async () => {
  const dir = repo();
  const { w, events } = watcher();
  w.setTargets([{ id: 'c', kind: 'commit', folder: dir }]);
  await w.idle();
  commit(dir, 'x.txt', '1', 'one');
  commit(dir, 'y.txt', '2', 'two');
  assert.ok(await waitFor(() => events.length >= 1), 'event from the watcher');
  await new Promise((r) => setTimeout(r, 200));
  await w.idle();
  w.stop();
  const total = events.reduce((s, e) => s + e.count, 0);
  assert.equal(total, 2, 'both commits reported, none twice');
  assert.ok(events.length <= 2);
});

test('paths filter: only commits touching matching files fire, files filtered', async () => {
  const dir = repo();
  const { w, events } = watcher();
  w.setTargets([{ id: 'legal', kind: 'commit', folder: dir, paths: ['**/privacy*', '**/terms*'] }]);
  await w.idle();
  commit(dir, 'src/app.js', '1', 'code only');
  await w.checkAll();
  assert.equal(events.length, 0, 'unrelated commit: no event');
  commit(dir, 'src/app2.js', '1', 'more code');
  commit(dir, 'site/privacy.html', 'p', 'privacy update');
  await w.checkAll();
  w.stop();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].commits.map((c) => c.subject), ['privacy update']);
  assert.deepEqual(events[0].files, ['site/privacy.html']);
});

test("branch: the default is the folder's checked-out branch; another branch fires only an explicit target", async () => {
  const dir = repo();
  const other = path.join(ROOT, 'wtf-' + n);
  git(dir, 'worktree', 'add', '-q', '-b', 'feature/x', other);
  const { w, events } = watcher();
  w.setTargets([{ id: 'main', kind: 'commit', folder: dir }, { id: 'feat', kind: 'commit', folder: dir, branch: 'feature/x' }]);
  await w.idle();
  commit(other, 'f.txt', '1', 'on feature');
  await w.checkAll();
  assert.deepEqual(events.map((e) => [e.id, e.branch]), [['feat', 'feature/x']]);
  commit(dir, 'm.txt', '1', 'on master');
  await w.checkAll();
  w.stop();
  assert.deepEqual(events.map((e) => [e.id, e.branch]), [['feat', 'feature/x'], ['main', 'master']]);
});

test('worktree folder: its own checked-out branch, refs in the common dir', async () => {
  const dir = repo();
  const wt = path.join(ROOT, 'wt2-' + n);
  git(dir, 'worktree', 'add', '-q', '-b', 'wk/y', wt);
  const { w, events } = watcher();
  w.setTargets([{ id: 'wt', kind: 'commit', folder: wt }, { id: 'main', kind: 'commit', folder: dir }]);
  await w.idle();
  const st = w.status();
  assert.equal(st.length, 2);
  assert.equal(st[0].commonDir.toLowerCase(), st[1].commonDir.toLowerCase(), 'one common dir');
  commit(wt, 'w.txt', '1', 'in worktree');
  assert.ok(await waitFor(() => events.length >= 1), 'watcher on refs/heads/wk saw it');
  await w.idle();
  w.stop();
  assert.deepEqual(events.map((e) => [e.id, e.branch, e.commits[0].subject]), [['wt', 'wk/y', 'in worktree']]);
});

test('tags: a new tag matching the glob is a release with its commits since the previous tag', async () => {
  const dir = repo();
  git(dir, 'tag', 'v1.0.0');
  const { w, events } = watcher();
  w.setTargets([{ id: 'rel', kind: 'release', folder: dir, tag: 'v*' }]);
  await w.idle();
  commit(dir, 'a.txt', '1', 'feat: a');
  commit(dir, 'b.txt', '2', 'fix: b');
  git(dir, 'tag', '-a', 'v1.1.0', '-m', 'release 1.1');
  git(dir, 'tag', 'nightly-1');
  await w.checkAll();
  assert.equal(events.length, 1, 'only the v* tag');
  const e = events[0];
  assert.equal(e.kind, 'release');
  assert.equal(e.tag, 'v1.1.0');
  assert.equal(e.prevTag, 'v1.0.0');
  assert.deepEqual(e.commits.map((c) => c.subject), ['fix: b', 'feat: a']);
  assert.deepEqual(e.files.sort(), ['a.txt', 'b.txt']);
  // packed refs: packing changes no sha, so no event; a later tag is still seen
  git(dir, 'pack-refs', '--all');
  await w.checkAll();
  assert.equal(events.length, 1);
  commit(dir, 'c.txt', '3', 'feat: c');
  git(dir, 'tag', 'v1.2.0');
  git(dir, 'pack-refs', '--all');
  await w.checkAll();
  w.stop();
  assert.equal(events.length, 2);
  assert.equal(events[1].tag, 'v1.2.0');
  assert.equal(events[1].prevTag, 'v1.1.0');
  assert.deepEqual(events[1].commits.map((c) => c.subject), ['feat: c']);
});

test('first tag ever: commits from the start of history', async () => {
  const dir = repo();
  const { w, events } = watcher();
  w.setTargets([{ id: 'rel', kind: 'release', folder: dir }]);
  await w.idle();
  git(dir, 'tag', 'v0.1.0');
  await w.checkAll();
  w.stop();
  assert.equal(events.length, 1);
  assert.equal(events[0].prevTag, null);
  assert.deepEqual(events[0].commits.map((c) => c.subject), ['first']);
});

test('catch-up: stored refs from a previous run, commits made while closed are reported once with catchUp', async () => {
  const dir = repo();
  const a = watcher();
  a.w.setTargets([{ id: 'c', kind: 'commit', folder: dir }, { id: 'r', kind: 'release', folder: dir }]);
  await a.w.idle();
  a.w.stop();
  commit(dir, 'while-closed.txt', '1', 'made while closed');
  git(dir, 'tag', 'v2.0.0');
  const b = watcher({ state: memState(a.state.dump()) });
  b.w.setTargets([{ id: 'c', kind: 'commit', folder: dir }, { id: 'r', kind: 'release', folder: dir }]);
  await b.w.idle();
  assert.deepEqual(b.events.map((e) => [e.id, e.catchUp]).sort(), [['c', true], ['r', true]]);
  commit(dir, 'later.txt', '1', 'after start');
  await b.w.checkAll();
  b.w.stop();
  assert.equal(b.events.length, 3);
  assert.equal(b.events[2].catchUp, false);
});

test('a target that goes away drops its baseline; re-watching starts fresh (no flood of old commits)', async () => {
  const dir = repo();
  const { w, events, state } = watcher();
  w.setTargets([{ id: 'c', kind: 'commit', folder: dir }]);
  await w.idle();
  w.setTargets([]);
  assert.deepEqual(state.get('refs'), {});
  commit(dir, 'gap.txt', '1', 'while unwatched');
  w.setTargets([{ id: 'c', kind: 'commit', folder: dir }]);
  await w.idle();
  w.stop();
  assert.equal(events.length, 0);
});

test('a folder that is deleted, renamed or not a repo never throws, and recovers when it is back', async () => {
  const dir = repo();
  const plain = path.join(ROOT, 'notrepo-' + n);
  fs.mkdirSync(plain);
  const { w, events } = watcher();
  w.setTargets([{ id: 'c', kind: 'commit', folder: dir }, { id: 'p', kind: 'commit', folder: plain },
    { id: 'm', kind: 'commit', folder: path.join(ROOT, 'missing-' + n) }]);
  await w.idle();
  const byFolder = (f) => w.status().find((s) => path.resolve(s.folder) === path.resolve(f));
  assert.equal(byFolder(plain).problem, 'not-a-repo');
  assert.equal(byFolder(path.join(ROOT, 'missing-' + n)).problem, 'missing');
  assert.equal(byFolder(dir).watching, true);

  // rename away. Windows refuses to rename a folder while a watch handle is open INSIDE it (measured: EPERM),
  // so a watched main checkout cannot be renamed until its targets go (duty off / paused); dropping them frees it.
  const moved = dir + '-moved';
  if (process.platform === 'win32') {
    assert.throws(() => fs.renameSync(dir, moved), /EPERM|EBUSY|EACCES/);
    w.setTargets([{ id: 'p', kind: 'commit', folder: plain }]);
    fs.renameSync(dir, moved);
    w.setTargets([{ id: 'c', kind: 'commit', folder: dir }, { id: 'p', kind: 'commit', folder: plain }]);
  } else fs.renameSync(dir, moved);
  await w.checkAll();
  assert.equal(byFolder(dir).problem, 'missing');
  assert.equal(byFolder(dir).watching, false);
  fs.renameSync(moved, dir);
  commit(dir, 'back.txt', '1', 'back again');
  await w.checkAll();
  assert.equal(byFolder(dir).watching, true);
  if (process.platform !== 'win32') assert.equal(events.length, 1, 'the commit made while away is reported against the stored refs');

  // delete outright while watched: the delete succeeds and the watcher survives
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dir), false);
  await w.checkAll();
  assert.equal(byFolder(dir).problem, 'missing');

  // the non-repo becomes a repo
  git(plain, 'init', '-q');
  commit(plain, 'a.txt', '1', 'init');
  await w.checkAll();
  assert.equal(byFolder(plain).watching, true);
  assert.equal(byFolder(plain).problem, null);
  w.stop();
});

test('file trigger: baseline, same content is not a change, new content is; deletion is not an event', async () => {
  const dir = path.join(ROOT, 'files-' + ++n);
  fs.mkdirSync(dir);
  const f = path.join(dir, 'pricing.json');
  fs.writeFileSync(f, '{"a":1}');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'x');
  const { w, events } = watcher();
  w.setTargets([{ id: 'f', kind: 'file', path: f }]);
  await w.idle();
  assert.equal(events.length, 0);
  fs.writeFileSync(f, '{"a":1}'); // rewritten, same bytes
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(f, t, t);
  await w.checkAll();
  assert.equal(events.length, 0, 'same hash: no event');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'y');
  fs.writeFileSync(f, '{"a":2}');
  assert.ok(await waitFor(() => events.length >= 1), 'the folder watcher saw the change');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'file');
  assert.equal(path.resolve(events[0].path), path.resolve(f));
  fs.rmSync(f);
  await w.checkAll();
  assert.equal(events.length, 1, 'deleted: no event');
  fs.writeFileSync(f, '{"a":3}');
  await w.checkAll();
  w.stop();
  assert.equal(events.length, 2, 'it came back with new content');
});

test('file trigger catch-up: a change made while closed is reported with catchUp', async () => {
  const dir = path.join(ROOT, 'files-' + ++n);
  fs.mkdirSync(dir);
  const f = path.join(dir, 'terms.md');
  fs.writeFileSync(f, 'v1');
  const a = watcher();
  a.w.setTargets([{ id: 'f', kind: 'file', path: f }]);
  await a.w.idle();
  a.w.stop();
  fs.writeFileSync(f, 'v2');
  const b = watcher({ state: memState(a.state.dump()) });
  b.w.setTargets([{ id: 'f', kind: 'file', path: f }]);
  await b.w.idle();
  b.w.stop();
  assert.deepEqual(b.events.map((e) => [e.kind, e.catchUp]), [['file', true]]);
});

test('git failures are contained: a broken git never throws out of a check', async () => {
  const dir = repo();
  const { w, events } = watcher({ git: async () => { throw new Error('git exploded'); } });
  w.setTargets([{ id: 'c', kind: 'commit', folder: dir }]);
  await w.idle();
  await w.checkAll();
  const s = w.status()[0];
  assert.equal(s.problem, 'git-error');
  assert.match(s.error, /git exploded/);
  assert.equal(events.length, 0);
  w.stop();
});

test('a watched worktree folder can be renamed (handles sit in the common dir) and is re-found by path', async () => {
  const dir = repo();
  const wt = path.join(ROOT, 'wtr-' + n);
  git(dir, 'worktree', 'add', '-q', '-b', 'wk/r', wt);
  const { w, events } = watcher();
  w.setTargets([{ id: 'wt', kind: 'commit', folder: wt }]);
  await w.idle();
  fs.renameSync(wt, wt + '-mv');
  await w.checkAll();
  assert.equal(w.status()[0].problem, 'missing');
  fs.renameSync(wt + '-mv', wt);
  await w.checkAll();
  commit(wt, 'z.txt', '1', 'after the round trip');
  await w.checkAll();
  w.stop();
  assert.deepEqual(events.map((e) => e.commits[0].subject), ['after the round trip']);
});
