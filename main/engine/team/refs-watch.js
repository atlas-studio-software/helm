// Event triggers for duties (docs/POSITIONS.md 9.4): cheap watchers on git refs and single files.
//
// Only the targets handed in by duties.js are ever looked at (repos and files named by ENABLED event duties).
//   Repo    -> the folder's `.git` (a folder, or a worktree's `gitdir:` file + `commondir`) resolves to ONE common git
//              dir; several folders / worktrees of the same repo share one watcher set. Non-recursive fs.watch
//              (ReadDirectoryChangesW on Windows: 0 CPU while nothing changes) on:
//                <common>/refs/heads, <common>/refs/tags, <common>/refs/heads/<dir> for a watched "a/b" branch,
//                <common> itself filtered to `packed-refs` and `HEAD`, and each worktree's own git dir filtered
//                to `HEAD` (its checked-out branch is the default branch of a commit target).
//              A change arms ONE debounce (30 s); then ONE `git for-each-ref` is compared with the last-seen refs.
//              Only a moved branch a target cares about costs one more `git log --name-only old..new`; only a new
//              or moved tag matching a target's glob costs a `git describe` + `git log` for its commits.
//   File    -> a non-recursive watch on the file's folder, filtered to that name; after a short debounce a
//              stat (mtime + size) and, when those moved, a sha1 confirms a real content change.
// There is no polling loop over folders. checkAll() re-checks every target once (one git call per repo, one stat
// per file); duties.js calls it on window focus / system resume (poke, throttled) and the 15-min safety timer.
// A folder that is deleted, renamed or not a git repo is never fatal: its watchers close, its status says why, and
// the next check re-resolves it.
//
// Last-seen refs and file hashes live in the injected state (team-state.json, keys 'refs' and 'files'). The first
// check of a repo with no stored refs only records a baseline (no event for history). The first check after start
// of a repo whose refs WERE stored reports what happened while Helm was closed, flagged `catchUp: true`.
// A repo / file that stops being a target has its stored baseline dropped, so re-watching it later starts fresh.
//
// createRefsWatch({ onEvent, state?, git?, now?, timers?, debounceMs?, fileDebounceMs?, recheckMs?, pokeMs?, log? })
//   -> { setTargets(targets), checkAll({ reason }) -> Promise, poke(reason), status(), stop() }
// targets: [{ id, kind: 'commit', folder, branch?, paths? }
//           | { id, kind: 'release', folder, tag? }
//           | { id, kind: 'file', path }]
// onEvent(ev):
//   { id, kind: 'commit', folder, branch, old, new, commits: [{ sha, at, subject }], count, files, truncated, catchUp, newestAt }
//   { id, kind: 'release', folder, tag, sha, prevTag, commits, count, files, truncated, catchUp, newestAt }
//   { id, kind: 'file', path, hash, catchUp, newestAt }
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DEBOUNCE_MS = 30_000;
const FILE_DEBOUNCE_MS = 5_000;
const RECHECK_MS = 15 * 60_000;
const POKE_MS = 60_000; // focus fires often: at most one poke-driven re-check a minute
const MAX_SUBJECTS = 50;
const MAX_FILES = 200;
const LOG_MAX = 500; // commits parsed per range; the event says `truncated` beyond it
const GIT_TIMEOUT_MS = 20_000;
const HASH_MAX_BYTES = 32 * 1024 * 1024; // bigger files: mtime + size stand in for the hash
const SUBJECT_MAX = 300;

const isWin = process.platform === 'win32';
const slash = (p) => String(p).replace(/\\/g, '/');
const keyOf = (p) => { const s = slash(path.resolve(p)); return isWin ? s.toLowerCase() : s; };

// ---------- globs (tag "v*", paths "**/privacy*") ----------
function globToRegExp(glob) {
  let re = '';
  const g = slash(glob);
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', isWin ? 'i' : '');
}
const globMatcher = (globs) => {
  const list = (Array.isArray(globs) ? globs : globs ? [globs] : []).filter((x) => typeof x === 'string' && x);
  if (!list.length) return null;
  const res = list.map(globToRegExp);
  return (s) => res.some((r) => r.test(s));
};

// ---------- git dir resolution (no git call) ----------
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };

// folder -> { gitDir, commonDir } | { problem: 'missing' | 'not-a-repo' }. The folder itself must hold `.git` (a
// company folder is a repo root); we never walk up, so a non-repo folder inside some other repo is not mistaken.
function resolveRepo(folder) {
  const dir = path.resolve(folder);
  if (!isDir(dir)) return { problem: 'missing' };
  const dotgit = path.join(dir, '.git');
  let st = null;
  try { st = fs.statSync(dotgit); } catch { return { problem: 'not-a-repo' }; }
  let gitDir = dotgit;
  if (!st.isDirectory()) {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotgit) || '');
    if (!m) return { problem: 'not-a-repo' };
    gitDir = path.resolve(dir, m[1]);
  }
  let commonDir = gitDir;
  const c = (readText(path.join(gitDir, 'commondir')) || '').trim();
  if (c) commonDir = path.resolve(gitDir, c);
  if (!isDir(gitDir) || !isDir(path.join(commonDir, 'refs'))) return { problem: 'not-a-repo' };
  // one spelling per directory: a worktree's gitdir file holds git's long path, while a folder may come in by an
  // 8.3 short name (C:\Users\RUNNER~1) or through a junction; unresolved, one repo would get two watchers
  return { gitDir: real(gitDir), commonDir: real(commonDir) };
}

// The branch checked out in a git dir ("ref: refs/heads/x"), or null when detached / unreadable.
function headBranch(gitDir) {
  const m = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(readText(path.join(gitDir, 'HEAD')) || '');
  return m ? m[1] : null;
}

// ---------- git ----------
function defaultGit(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

function parseRefs(out) {
  const refs = {};
  for (const line of String(out).split(/\r?\n/)) {
    const m = /^([0-9a-f]{7,64}) (refs\/\S+)$/.exec(line.trim());
    if (m) refs[m[2]] = m[1];
  }
  return refs;
}

// `git log --name-only --format=%x1e%H%x1f%ct%x1f%s` -> [{ sha, at, subject, files }] (newest first)
function parseLog(out) {
  const commits = [];
  for (const chunk of String(out).split('\x1e')) {
    if (!chunk.trim()) continue;
    const lines = chunk.split(/\r?\n/);
    const [sha, ct, ...rest] = lines[0].split('\x1f');
    if (!/^[0-9a-f]{7,64}$/.test(sha || '')) continue;
    const subject = rest.join('\x1f');
    commits.push({
      sha, at: Number(ct) * 1000 || null,
      subject: subject.length > SUBJECT_MAX ? subject.slice(0, SUBJECT_MAX - 1) + '…' : subject,
      files: lines.slice(1).map((l) => l.trim()).filter(Boolean),
    });
  }
  return commits;
}

// commits (already filtered) -> the event's capped summary
function summarise(commits, filesOf) {
  const files = [];
  const seen = new Set();
  let moreFiles = false;
  for (const c of commits) for (const f of filesOf(c)) {
    if (seen.has(f)) continue;
    seen.add(f);
    if (files.length < MAX_FILES) files.push(f); else moreFiles = true;
  }
  return {
    commits: commits.slice(0, MAX_SUBJECTS).map(({ sha, at, subject }) => ({ sha, at, subject })),
    count: commits.length,
    files,
    newestAt: commits.reduce((m, c) => Math.max(m, c.at || 0), 0) || null,
    moreFiles,
  };
}

function createRefsWatch(opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const git = opts.git || defaultGit;
  const now = opts.now || Date.now;
  const T = { setTimeout, clearTimeout, setInterval, clearInterval, ...(opts.timers || {}) };
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const fileDebounceMs = opts.fileDebounceMs ?? FILE_DEBOUNCE_MS;
  const recheckMs = opts.recheckMs ?? RECHECK_MS;
  const pokeMs = opts.pokeMs ?? POKE_MS;
  const log = opts.log || (() => {});
  const watchFn = opts.watch || ((p, o, cb) => fs.watch(p, o, cb));
  const mem = new Map();
  const state = opts.state || { get: (k) => mem.get(k), set: (k, v) => mem.set(k, v) };

  const storedRefs = () => state.get('refs') || {};
  const storedFiles = () => state.get('files') || {};
  // Repos / files whose baseline was on disk when we started: their first check reports what happened while closed.
  const fromDisk = new Set([...Object.keys(storedRefs()), ...Object.keys(storedFiles())]);

  const repos = new Map(); // commonKey -> repo entry
  const folderRepo = new Map(); // folderKey -> commonKey (current resolution)
  const dirs = new Map(); // dirKey -> file-dir entry
  let targets = [];
  let stopped = false;
  let interval = null;
  let lastPoke = -Infinity;
  let gitChain = Promise.resolve(); // one git process at a time, machine is short on CPU
  const runGit = (args) => { const p = gitChain.then(() => git(args)); gitChain = p.catch(() => {}); return p; };

  // ----- watchers -----
  function watchDir(dir, names, onChange, onError) {
    try {
      const w = watchFn(dir, { persistent: false }, (_ev, name) => {
        if (names && name && !names.has(isWin ? String(name).toLowerCase() : String(name))) return;
        onChange();
      });
      // dir deleted / access lost: close it, mark the set for a rebuild, re-check (an unhandled 'error' would throw)
      w.on('error', () => { try { w.close(); } catch {} onError(); });
      return w;
    } catch { return null; } // ENOENT etc.: the next check re-resolves
  }
  const closeAll = (list) => { for (const w of list.splice(0)) { try { w.close(); } catch {} } };

  // ----- repos -----
  function repoFor(commonDir) {
    const key = keyOf(commonDir);
    let r = repos.get(key);
    if (!r) {
      r = { key, commonDir, folders: new Map(), watchers: [], watchSig: '', timer: null, checking: null, dirty: false,
        problem: null, firstCheck: true, checkedAt: null, error: null };
      repos.set(key, r);
    }
    return r;
  }

  function armRepo(r) {
    if (stopped || r.timer) return;
    r.timer = T.setTimeout(() => { r.timer = null; checkRepo(r); }, debounceMs);
    r.timer?.unref?.();
  }

  // (Re)build the watcher set when the set of dirs changes (new slash-branch, new worktree, repo came back).
  function rewatch(r) {
    const branchDirs = new Set();
    const gitDirs = new Set();
    for (const f of r.folders.values()) {
      if (keyOf(f.gitDir) !== r.key) gitDirs.add(f.gitDir);
      for (const t of f.targets) {
        if (t.kind !== 'commit') continue;
        const b = t.branch || headBranch(f.gitDir); // the default branch is the folder's checked-out one
        if (b && b.includes('/')) branchDirs.add(path.join(r.commonDir, 'refs', 'heads', path.dirname(b)));
      }
    }
    const sig = JSON.stringify([[...gitDirs].sort(), [...branchDirs].sort()]);
    if (r.watchSig && sig === r.watchSig) return;
    closeAll(r.watchers);
    r.watchSig = sig;
    const on = () => armRepo(r);
    const broke = () => { r.watchSig = ''; armRepo(r); };
    const add = (w) => { if (w) r.watchers.push(w); };
    add(watchDir(r.commonDir, new Set(['packed-refs', isWin ? 'head' : 'HEAD']), on, broke));
    add(watchDir(path.join(r.commonDir, 'refs', 'heads'), null, on, broke));
    add(watchDir(path.join(r.commonDir, 'refs', 'tags'), null, on, broke));
    for (const d of branchDirs) add(watchDir(d, null, on, broke));
    for (const d of gitDirs) add(watchDir(d, new Set([isWin ? 'head' : 'HEAD']), on, broke));
  }

  function dropRepo(r, problem) {
    closeAll(r.watchers);
    r.watchSig = '';
    if (problem) r.problem = problem;
  }

  async function logRange(r, from, to) {
    const out = await runGit(['-c', 'core.quotePath=false', '--git-dir=' + r.commonDir, 'log', '--name-only',
      '--format=%x1e%H%x1f%ct%x1f%s', '--max-count=' + LOG_MAX, from ? `${from}..${to}` : to, '--']);
    return parseLog(out);
  }

  async function checkRepo(r, { catchUpOk = true } = {}) {
    if (stopped) return;
    // A check asked for while one runs makes that one go round again; the promise covers the re-run too.
    if (r.checking) { r.dirty = true; return r.checking; }
    r.checking = (async () => {
      do {
        r.dirty = false;
        try { await checkRepoOnce(r, catchUpOk); } catch (e) { r.error = e.message; log('refs-watch: ' + e.message); }
      } while (r.dirty && !stopped && repos.get(r.key) === r);
    })().finally(() => { r.checking = null; });
    return r.checking;
  }

  async function checkRepoOnce(r, catchUpOk) {
    // Re-resolve every folder: a folder deleted / renamed / turned into a non-repo since the last check.
    for (const [fk, f] of [...r.folders]) {
      const res = resolveRepo(f.folder);
      if (res.problem || keyOf(res.commonDir) !== r.key) {
        r.folders.delete(fk);
        folderRepo.delete(fk);
        const moved = placeFolder(f.folder, f.targets, res); // now another repo (re-cloned), or a problem
        if (moved) armRepo(moved);
      }
      else f.gitDir = res.gitDir;
    }
    if (!r.folders.size) { dropRepo(r); repos.delete(r.key); return; }
    if (!isDir(path.join(r.commonDir, 'refs'))) { dropRepo(r, 'missing'); return; }
    let out;
    try {
      out = await runGit(['--git-dir=' + r.commonDir, 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags']);
    } catch (e) {
      r.problem = isDir(r.commonDir) ? 'git-error' : 'missing';
      r.error = String(e.message || e).split('\n')[0];
      if (r.problem === 'missing') dropRepo(r);
      return;
    }
    if (stopped) return;
    r.problem = null;
    r.error = null;
    rewatch(r);
    const refs = parseRefs(out);
    const all = storedRefs();
    const prev = all[r.key]?.refs;
    const catchUp = r.firstCheck && fromDisk.has(r.key) && catchUpOk;
    r.firstCheck = false;
    r.checkedAt = now();
    if (prev) await diffRefs(r, prev, refs, catchUp);
    if (stopped || !repos.has(r.key)) return;
    state.set('refs', { ...storedRefs(), [r.key]: { refs, at: now() } });
  }

  async function diffRefs(r, prev, refs, catchUp) {
    const ranges = new Map(); // "old..new" -> commits (shared by targets on the same branch)
    const range = async (from, to) => {
      const k = `${from || ''}..${to}`;
      if (!ranges.has(k)) {
        let commits;
        try { commits = await logRange(r, from, to); } catch {
          // `old` is gone (gc after a force-push): report the tip commit alone
          commits = await logRange(r, null, to).then((c) => c.slice(0, 1)).catch(() => []);
        }
        ranges.set(k, commits);
      }
      return ranges.get(k);
    };
    const releases = new Map(); // tag -> { prevTag, commits }
    const releaseOf = async (tag) => {
      if (!releases.has(tag)) {
        let prevTag = null;
        try {
          prevTag = (await runGit(['--git-dir=' + r.commonDir, 'describe', '--tags', '--abbrev=0', `refs/tags/${tag}^`])).trim() || null;
        } catch { /* first tag, or a tag on the root commit */ }
        let commits = [];
        try { commits = await logRange(r, prevTag ? `refs/tags/${prevTag}` : null, `refs/tags/${tag}`); } catch {}
        releases.set(tag, { prevTag, commits });
      }
      return releases.get(tag);
    };
    for (const f of [...r.folders.values()]) {
      for (const t of f.targets) {
        if (stopped) return;
        if (t.kind === 'commit') {
          const branch = t.branch || headBranch(f.gitDir) || headBranch(r.commonDir);
          if (!branch) continue;
          const ref = 'refs/heads/' + branch;
          const old = prev[ref], nw = refs[ref];
          if (!old || !nw || old === nw) continue; // new / deleted branch: baseline only
          const match = globMatcher(t.paths);
          const all = await range(old, nw);
          const commits = match ? all.filter((c) => c.files.some((x) => match(x))) : all;
          if (!commits.length) continue;
          const s = summarise(commits, (c) => (match ? c.files.filter((x) => match(x)) : c.files));
          emit({ id: t.id, kind: 'commit', folder: f.folder, branch, old, new: nw, commits: s.commits, count: s.count,
            files: s.files, truncated: all.length >= LOG_MAX || s.count > MAX_SUBJECTS || s.moreFiles, catchUp, newestAt: s.newestAt });
        } else if (t.kind === 'release') {
          const match = globMatcher(t.tag || '*');
          for (const [ref, sha] of Object.entries(refs)) {
            if (!ref.startsWith('refs/tags/') || prev[ref] === sha) continue;
            const tag = ref.slice('refs/tags/'.length);
            if (!match(tag)) continue;
            const rel = await releaseOf(tag);
            const s = summarise(rel.commits, (c) => c.files);
            emit({ id: t.id, kind: 'release', folder: f.folder, tag, sha, prevTag: rel.prevTag, commits: s.commits,
              count: s.count, files: s.files, truncated: rel.commits.length >= LOG_MAX || s.count > MAX_SUBJECTS || s.moreFiles,
              catchUp, newestAt: s.newestAt });
          }
        }
      }
    }
  }

  function emit(ev) {
    try { onEvent(ev); } catch (e) { log('refs-watch: onEvent threw: ' + e.message); }
  }

  // ----- files -----
  function dirFor(dir) {
    const key = keyOf(dir);
    let d = dirs.get(key);
    if (!d) { d = { key, dir, files: new Map(), watcher: null, names: null, timer: null, problem: null }; dirs.set(key, d); }
    return d;
  }

  function rewatchDir(d) {
    const names = [...d.files.values()].map((f) => (isWin ? path.basename(f.path).toLowerCase() : path.basename(f.path))).sort();
    const sig = names.join('\n');
    if (d.watcher && d.names === sig) return;
    if (d.watcher) { try { d.watcher.close(); } catch {} d.watcher = null; }
    d.names = sig;
    if (!isDir(d.dir)) { d.problem = 'missing'; return; }
    d.problem = null;
    d.watcher = watchDir(d.dir, new Set(names), () => armDir(d), () => { d.watcher = null; d.names = null; armDir(d); });
    if (!d.watcher) d.problem = 'missing';
  }

  function armDir(d) {
    if (stopped || d.timer) return;
    d.timer = T.setTimeout(() => { d.timer = null; checkDir(d, { force: true }); }, fileDebounceMs);
    d.timer?.unref?.();
  }

  function fileSig(p) {
    let st;
    try { st = fs.statSync(p); } catch { return null; }
    if (!st.isFile()) return null;
    let hash;
    return { mtimeMs: st.mtimeMs, size: st.size, get hash() {
      if (hash === undefined) {
        if (st.size > HASH_MAX_BYTES) hash = `size:${st.size}:mtime:${st.mtimeMs}`;
        else { try { hash = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch { hash = null; } }
      }
      return hash;
    } };
  }

  // force: the watcher saw something (or first sight), so hash even when mtime + size look the same (a quick
  // rewrite can keep both); the periodic re-check trusts mtime + size and hashes only when they moved.
  function checkDir(d, { catchUpOk = true, force = false } = {}) {
    if (stopped) return;
    rewatchDir(d);
    const all = { ...storedFiles() };
    let changed = false;
    for (const f of d.files.values()) {
      const prev = all[f.key];
      const sig = fileSig(f.path);
      const first = f.firstCheck;
      const catchUp = first && fromDisk.has(f.key) && catchUpOk;
      f.firstCheck = false;
      if (!sig) { // gone: not an event; remember so it re-appearing with new content fires
        if (!prev || prev.hash !== null) { all[f.key] = { hash: null, at: now() }; changed = true; }
        continue;
      }
      if (!force && !first && prev && prev.hash != null && prev.mtimeMs === sig.mtimeMs && prev.size === sig.size) continue;
      const hash = sig.hash;
      if (prev && prev.hash === hash) { all[f.key] = { ...prev, mtimeMs: sig.mtimeMs, size: sig.size }; changed = true; continue; }
      all[f.key] = { hash, mtimeMs: sig.mtimeMs, size: sig.size, at: now() };
      changed = true;
      if (!prev) continue; // first sight: baseline
      for (const t of f.targets) emit({ id: t.id, kind: 'file', path: f.path, hash, catchUp, newestAt: sig.mtimeMs });
    }
    if (changed) state.set('files', all);
  }

  // ----- targets -----
  const problems = new Map(); // folderKey -> { folder, problem } for folders that do not resolve
  function placeFolder(folder, tlist, res = resolveRepo(folder)) {
    const fk = keyOf(folder);
    if (res.problem) { problems.set(fk, { folder, problem: res.problem }); return null; }
    problems.delete(fk);
    const r = repoFor(res.commonDir);
    r.folders.set(fk, { folder, gitDir: res.gitDir, targets: tlist });
    folderRepo.set(fk, r.key);
    return r;
  }
  function setTargets(list) {
    if (stopped) return;
    targets = (Array.isArray(list) ? list : []).filter((t) => t && t.id && (t.kind === 'file' ? t.path : t.folder));
    const byFolder = new Map();
    const byFile = new Map();
    for (const t of targets) {
      if (t.kind === 'file') {
        const k = keyOf(t.path);
        if (!byFile.has(k)) byFile.set(k, { path: path.resolve(t.path), targets: [] });
        byFile.get(k).targets.push(t);
      } else if (t.kind === 'commit' || t.kind === 'release') {
        const k = keyOf(t.folder);
        if (!byFolder.has(k)) byFolder.set(k, { folder: path.resolve(t.folder), targets: [] });
        byFolder.get(k).targets.push(t);
      }
    }
    // repos: rebuild folder membership, keep entries (and their watchers) that still have folders
    const before = new Set(repos.keys());
    for (const r of repos.values()) r.folders.clear();
    folderRepo.clear();
    problems.clear();
    const fresh = [];
    for (const { folder, targets: tl } of byFolder.values()) {
      const r = placeFolder(folder, tl);
      if (r && !before.has(r.key) && !fresh.includes(r)) fresh.push(r);
    }
    const storedR = { ...storedRefs() };
    let prunedR = false;
    for (const [key, r] of [...repos]) {
      if (r.folders.size) continue;
      dropRepo(r);
      if (r.timer) { T.clearTimeout(r.timer); r.timer = null; }
      repos.delete(key);
    }
    for (const key of Object.keys(storedR)) if (!repos.has(key)) { delete storedR[key]; prunedR = true; }
    if (prunedR) state.set('refs', storedR);
    for (const r of repos.values()) if (!fresh.includes(r)) rewatch(r);
    for (const r of fresh) checkRepo(r); // baseline, or what changed while Helm was closed

    // files: update entries in place (a file already watched keeps its firstCheck), check dirs that gained a file
    const touched = new Set();
    for (const d of dirs.values()) for (const k of [...d.files.keys()]) if (!byFile.has(k)) d.files.delete(k);
    for (const [k, f] of byFile) {
      const d = dirFor(path.dirname(f.path));
      const had = d.files.get(k);
      if (had) had.targets = f.targets;
      else { d.files.set(k, { key: k, path: f.path, targets: f.targets, firstCheck: true }); touched.add(d); }
    }
    for (const [key, d] of [...dirs]) {
      if (d.files.size) continue;
      if (d.watcher) { try { d.watcher.close(); } catch {} }
      if (d.timer) T.clearTimeout(d.timer);
      dirs.delete(key);
    }
    const storedF = { ...storedFiles() };
    let prunedF = false;
    for (const key of Object.keys(storedF)) if (!byFile.has(key)) { delete storedF[key]; prunedF = true; }
    if (prunedF) state.set('files', storedF);
    for (const d of dirs.values()) { if (touched.has(d)) checkDir(d); else rewatchDir(d); }

    if (!interval && recheckMs > 0 && (repos.size || dirs.size || problems.size)) {
      interval = T.setInterval(() => { checkAll({ reason: 'timer' }); }, recheckMs);
      interval?.unref?.();
    }
  }

  // One cheap pass over every target: one for-each-ref per repo, one stat per file; folders that did not resolve
  // are tried again (a repo cloned / restored since).
  async function checkAll({ reason } = {}) {
    if (stopped) return;
    if (problems.size) {
      for (const [fk, p] of [...problems]) {
        const tl = targets.filter((t) => t.kind !== 'file' && keyOf(t.folder) === fk);
        const r = placeFolder(p.folder, tl);
        if (r) rewatch(r);
      }
    }
    for (const d of dirs.values()) if (d.timer) { T.clearTimeout(d.timer); d.timer = null; }
    for (const d of dirs.values()) checkDir(d);
    const jobs = [];
    for (const r of repos.values()) {
      if (r.timer) { T.clearTimeout(r.timer); r.timer = null; }
      jobs.push(checkRepo(r));
    }
    await Promise.all(jobs);
    if (reason) log(`refs-watch: checked ${repos.size} repo(s), ${dirs.size} folder(s) (${reason})`);
  }

  function poke(reason) {
    const t = now();
    if (t - lastPoke < pokeMs) return Promise.resolve();
    lastPoke = t;
    return checkAll({ reason });
  }

  function status() {
    const out = [];
    for (const r of repos.values()) for (const f of r.folders.values()) {
      out.push({ kind: 'repo', folder: f.folder, commonDir: slash(r.commonDir), watching: r.watchers.length > 0,
        problem: r.problem, error: r.error || undefined, checkedAt: r.checkedAt });
    }
    for (const p of problems.values()) out.push({ kind: 'repo', folder: p.folder, watching: false, problem: p.problem });
    for (const d of dirs.values()) for (const f of d.files.values()) {
      out.push({ kind: 'file', path: f.path, watching: !!d.watcher, problem: d.problem });
    }
    return out;
  }

  // Resolves once every check in flight (and the git queue) has settled; for tests and a clean quit.
  async function idle() {
    for (let i = 0; i < 20; i++) {
      const busy = [...repos.values()].map((r) => r.checking).filter(Boolean);
      if (!busy.length) break;
      await Promise.all(busy);
    }
    await gitChain;
  }

  function stop() {
    stopped = true;
    if (interval) { T.clearInterval(interval); interval = null; }
    for (const r of repos.values()) { dropRepo(r); if (r.timer) T.clearTimeout(r.timer); }
    for (const d of dirs.values()) { if (d.watcher) { try { d.watcher.close(); } catch {} } if (d.timer) T.clearTimeout(d.timer); }
    repos.clear();
    dirs.clear();
  }

  return { setTargets, checkAll, poke, status, stop, idle };
}

module.exports = { createRefsWatch, resolveRepo, headBranch, globToRegExp, globMatcher, parseRefs, parseLog,
  DEBOUNCE_MS, RECHECK_MS, MAX_SUBJECTS, MAX_FILES };
