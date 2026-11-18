'use strict';
// Positions (docs/POSITIONS.md section 3): which company a session's folder belongs to, i.e. whether a normal
// Helm session is that company's CEO.
//
//   companyFor(cwd, companies, { teamRoot })   -> the company object, or null
//   matchCompany(cwd, companies, { teamRoot }) -> { company, folder, via: 'folder'|'worktree', path } or null
//
// Rules:
// - Paths are resolved (realpath, so junctions and symlinks are followed), written with forward slashes and, on
//   Windows, compared in lower case. Matching is on whole path segments: C:/you/helm never matches C:/you/helm-wt.
// - The company whose folder is the LONGEST prefix of cwd wins.
// - No match, and cwd is inside a git worktree (a `.git` FILE saying `gitdir: <main>/.git/worktrees/<name>`):
//   the same place in the main repo is matched instead. One small file is read; git is never spawned.
// - A cwd inside the team root is never a CEO session (it is a position or nothing): null.
// Called at every CLI start, so nothing is cached.

const fs = require('fs');
const path = require('path');

const MAX_WALK = 64; // folder levels walked up looking for `.git`

function isWin(opts) {
  const p = (opts && opts.platform) || process.platform;
  return p === 'win32';
}

function caseless(opts) {
  if (opts && typeof opts.caseInsensitive === 'boolean') return opts.caseInsensitive;
  return isWin(opts);
}

// The path module for the platform being matched (tests pass { platform: 'win32' } on any OS).
function pathFor(opts) { return isWin(opts) ? path.win32 : path.posix; }

// Real path when it exists (junctions and symlinks followed); else the path itself. Never throws.
function real(p, opts) {
  if (opts && opts.realpath === false) return p;
  // a Windows-shaped path is only looked up on Windows (tests of win32 rules run on any OS)
  if (isWin(opts) !== (process.platform === 'win32')) return p;
  try { return fs.realpathSync.native(p); } catch {}
  // a folder that does not exist yet: resolve its nearest existing ancestor and keep the rest
  const P = pathFor(opts);
  let head = p;
  const tail = [];
  for (let i = 0; i < MAX_WALK; i++) {
    const up = P.dirname(head);
    if (up === head) break;
    tail.unshift(P.basename(head));
    head = up;
    try { return P.join(fs.realpathSync.native(head), ...tail); } catch {}
  }
  return p;
}

// Absolute and resolved (realpath where it exists), in the platform's own separators. '' when unusable.
function resolvedPath(p, opts = {}) {
  if (typeof p !== 'string' || !p.trim()) return '';
  let s = p.trim();
  if (s.startsWith('\\\\?\\') || s.startsWith('//?/')) s = s.slice(4); // \\?\C:\x long-path prefix
  const P = pathFor(opts);
  if (isWin(opts)) s = s.replace(/\//g, '\\');
  s = real(P.resolve(s), opts);
  if (s.startsWith('\\\\?\\')) s = s.slice(4);
  return s;
}

// One comparable form: absolute, resolved, forward slashes, no trailing slash (but `c:/` and `/` stay), lower
// case where the file system is case-insensitive. '' for anything unusable.
function normPath(p, opts = {}) {
  let s = resolvedPath(p, opts);
  if (!s) return '';
  s = s.replace(/\\/g, '/');
  if (s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s)) s = s.replace(/\/+$/, '');
  if (/^[A-Za-z]:$/.test(s)) s += '/';
  return caseless(opts) ? s.toLowerCase() : s;
}

// Is `child` the folder `parent` or inside it? Both are normalised first unless { normed: true }.
function isInside(child, parent, opts = {}) {
  const c = opts.normed ? child : normPath(child, opts);
  const p = opts.normed ? parent : normPath(parent, opts);
  if (!c || !p) return false;
  if (c === p) return true;
  return c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

// cwd inside a git worktree -> { root, main, mapped } where `mapped` is the same place in the main repo; else null.
// Only `.git` FILES whose gitdir is `<main>/.git/worktrees/<name>` count (submodules and bare repos do not).
function worktreeOf(cwd, opts = {}) {
  const P = pathFor(opts);
  const start = resolvedPath(cwd, opts);
  if (!start) return null;
  let dir = start;
  for (let i = 0; i < MAX_WALK; i++) {
    const dotgit = P.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotgit); } catch {}
    if (st) {
      if (!st.isFile()) return null; // a normal repo root: not a worktree
      let text = '';
      try {
        const fd = fs.openSync(dotgit, 'r');
        try {
          const buf = Buffer.alloc(4096);
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          text = buf.slice(0, n).toString('utf8');
        } finally { fs.closeSync(fd); }
      } catch { return null; }
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      if (!m) return null;
      let gitdir = m[1];
      if (!P.isAbsolute(gitdir) && !/^[A-Za-z]:[\\/]/.test(gitdir)) gitdir = P.resolve(dir, gitdir);
      const g = gitdir.replace(/\\/g, '/').replace(/\/+$/, '');
      const w = /^(.*)\/\.git\/worktrees\/[^/]+$/i.exec(g);
      if (!w || !w[1]) return null;
      const main = isWin(opts) ? w[1].replace(/\//g, '\\') : w[1];
      const rel = P.relative(dir, start);
      const mapped = rel ? P.join(main, rel) : main;
      return { root: dir, main, mapped };
    }
    const up = P.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

function listCompanies(companies) {
  const list = typeof companies === 'function' ? companies() : companies;
  return Array.isArray(list) ? list.filter((c) => c && typeof c === 'object') : [];
}

// The company whose folder is the longest prefix of an already-normalised path, as { company, folder }.
function longestPrefix(p, companies, opts) {
  let best = null;
  for (const company of companies) {
    for (const f of Array.isArray(company.folders) ? company.folders : []) {
      const nf = normPath(f, opts);
      if (!nf || !isInside(p, nf, { ...opts, normed: true })) continue;
      if (!best || nf.length > best.norm.length) best = { company, folder: f, norm: nf };
    }
  }
  return best;
}

function matchCompany(cwd, companies, opts = {}) {
  const p = normPath(cwd, opts);
  if (!p) return null;
  if (opts.teamRoot) {
    const tr = normPath(opts.teamRoot, opts);
    if (tr && isInside(p, tr, { ...opts, normed: true })) return null;
  }
  const list = listCompanies(companies);
  if (!list.length) return null;
  const direct = longestPrefix(p, list, opts);
  if (direct) return { company: direct.company, folder: direct.folder, via: 'folder', path: p };
  const wt = worktreeOf(cwd, opts);
  if (!wt) return null;
  const mp = normPath(wt.mapped, opts);
  const viaMain = mp && longestPrefix(mp, list, opts);
  if (!viaMain) return null;
  return { company: viaMain.company, folder: viaMain.folder, via: 'worktree', path: mp, worktree: normPath(wt.root, opts) };
}

function companyFor(cwd, companies, opts = {}) {
  const m = matchCompany(cwd, companies, opts);
  return m ? m.company : null;
}

module.exports = { companyFor, matchCompany, normPath, isInside, worktreeOf };
