'use strict';
// Positions: the team guard (docs/POSITIONS.md 7.3). A PreToolUse hook, in prod-guard's pattern: no matcher, runs in
// every permission mode (positions run bypassPermissions, so this hook IS the gate), never throws, denies on error.
//
//   createHook({ getEffectivePowers, consumeGrant, requestApproval, handedReads?, noteOwnWrite?, log, sessionId?, targets?, home?, waitMs?, teamRoot?,
//                ownerName? (string or () => string; 'the owner' when empty, read per message) })
//   (teamRoot: optional; without it the team root is read from the workspace, <root>/<company>/positions/<id>)
//     -> { hooks: [callback], timeout }   (the SDK HookCallbackMatcher shape, like prod-guard.createHook)
//
//   getEffectivePowers(sessionId)  -> (sync or async) the position's effective powers, read LIVE on every call:
//        { read: [..], write: [..], tools: [..], bash: 'off'|'readonly'|'on', agents: bool,
//          workspace, cwd?, companyFolders?, scopeFolder?,          (only needed if read/write still hold $tokens)
//          worktreePath?, worktreeOf? }                              (worktree positions, see "Worktree" below)
//        tree.effective(id, ctx) output is accepted as is. null / undefined = not a position: denied.
//   consumeGrant(sessionId, need)  -> (sync or async) truthy when a once-grant covering `need` was found AND used up.
//        need: { kind: 'read'|'write'|'tool'|'bash'|'outward', target, toolName, matches(grant) -> bool }
//        grant: { kind, target } as request_access stores it (read/write: absolute path; tool: name;
//        bash: 'bash:readonly'|'bash:on'; outward: the command text). need.matches does the matching.
//        Called only when the call would otherwise be refused, so a grant is never spent on an allowed call.
//   requestApproval({ kind: 'outward', sessionId, toolName, toolInput, toolUseID, signal, command, what: [..], title, waitMs })
//        -> (async) true | { behavior: 'allow' } | { decision: 'once' } to allow; anything else denies
//        ({ note } / { message } is passed on). Outward is Approve once / Deny only: an 'always' answer is treated as once.
//        The guard also gives up after waitMs (30 min, as prod-guard) and on the turn's abort signal.
//   handedReads(sessionId)         -> optional, (sync or async) [absPath]: files / folders handed to the position with
//        the ask it is answering (runtime.handedReads). They are READABLE for that call (as if in powers.read: read
//        tools and read-only Bash), never writable. A failure hands nothing.
//   noteOwnWrite(sessionId, absPath) -> optional, called (fire and forget, never throws into the hook) after the guard
//        ALLOWS a Write / Edit / MultiEdit / NotebookEdit whose real-pathed target is the position's own
//        <workspace>/notebook.md (case-insensitive on Windows), so the engine marks it as its own edit. absPath = the
//        real-pathed target. Called before the tool runs (PreToolUse).
//   log(level, msg)                -> optional
//
// What it decides, per tool call (allow = {} so the next hook / the mode decides; deny = a reason the model reads):
//   - mcp__team__* allowed; any other mcp__* denied. NEVER tools denied. Agent / Task only with agents: true.
//   - Every other tool must be in powers.tools (AskUserQuestion always; Bash whenever bash is not off, as options.js).
//   - File tools (Read, Grep, Glob, NotebookRead -> read; Write, Edit, MultiEdit, NotebookEdit -> write): the target
//     (absolute, or relative to the call's cwd) is normalised, the nearest existing ancestor real-pathed (junctions and
//     symlinks followed), and compared case-insensitively on Windows with the real-pathed roots. Grep / Glob with no
//     path use cwd; an absolute Glob pattern is checked by its literal base.
//   - Definition files (fix 1): position.json (+ .v<N>), brief.md and chats.json in ANY position's folder are never
//     written, deleted, moved or linked by a position, whatever its powers or grants (Write tools exactly; shell
//     commands best-effort, at every Bash level, before any grant is spent). notebook.md stays its own.
//   - Bash / PowerShell / Monitor: off -> denied. readonly -> every command in the chain must be on a short read
//     list, no redirects to files, no variables, and absolute / ~ / .. paths must be in read. on -> allowed, except
//     outward commands (asked) and best-effort: delete / move / copy / write commands naming paths outside write.
//   - Outward (bash on): prod-guard's assess() (Railway, protected pushes), prod-guard's collect() for ANY git push /
//     gh ship-write (scripts followed, as prod-guard), plus a short list here: npm / pnpm / yarn publish, gh writes
//     (issue / pr / release / repo / gist ...), curl / wget / Invoke-WebRequest / Invoke-RestMethod with a write
//     method or a body, mail CLIs, Send-MailMessage, stripe, twilio, a few deploy CLIs.
//   - Worktree: when worktreePath is given (a `worktree: true` position), the worktree is readable and writable and
//     the live checkout it came from (worktreeOf, else read from the worktree's .git file, plus scopeFolder) is
//     read-only for this position, whatever `write` says.
// Bash checks are best-effort by design (spec 7.1): coding positions work in their own worktree as the containment.

const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('./schema');
const PG = require('../prod-guard');
const { ownerWords } = require('./owner');

let worktreeOf = null;
try { ({ worktreeOf } = require('./match')); } catch { worktreeOf = null; }

const WAIT_MS = 30 * 60 * 1000;
const HOOK_TIMEOUT_S = Math.ceil(WAIT_MS / 1000) + 60;
const MAX_DEPTH = 4;

const READ_FILE_TOOLS = { Read: 'file_path', NotebookRead: 'notebook_path', Grep: 'path', Glob: 'path' };
const WRITE_FILE_TOOLS = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };
const SHELL_TOOLS = ['Bash', 'PowerShell', 'Monitor'];
const AGENT_TOOLS = ['Agent', 'Task'];
const ALWAYS_TOOLS = ['AskUserQuestion'];
const NEVER_TOOLS = new Set([...S.NEVER_TOOLS, 'SendToProjectContext', 'Workflow', 'CronList', 'RemoteTrigger',
  'PushNotification', 'EnterWorktree', 'ExitWorktree']);
const BASH_RANK = { off: 0, readonly: 1, on: 2 };

const ASK_MORE = 'If you need it, call request_access with the reason; do not try another way.';
const ERROR_TEXT = (m) => `Helm could not check this call (${m}); denied to be safe.`;

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const ALLOW = {};

// ---------------------------------------------------------------- paths

// Absolute, normalised, the nearest existing ancestor real-pathed. Returns the stored form (forward slashes).
function realResolve(p, base) {
  let abs = path.resolve(base || process.cwd(), p);
  const rest = [];
  for (let i = 0; i < 256; i++) {
    let real = null;
    try { real = (fs.realpathSync.native || fs.realpathSync)(abs); } catch { real = null; }
    if (real) return S.normPath(rest.length ? path.join(real, ...rest.reverse()) : real);
    const up = path.dirname(abs);
    if (up === abs) break;
    rest.push(path.basename(abs));
    abs = up;
  }
  return S.normPath(path.resolve(base || process.cwd(), p));
}

function globRe(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { re += '.*'; i++; if (pattern[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' || S.pathKey('A') === 'a' ? 'i' : '');
}

const globBase = (p) => {
  const segs = p.split('/');
  const i = segs.findIndex((s) => S.hasGlob(s));
  return i < 0 ? p : segs.slice(0, i).join('/') || '/';
};

// A root as a matcher over real paths. A plain root covers itself and everything under it; a glob root matches the
// path or any ancestor of it (an entry that names a folder brings what is inside it).
function rootMatcher(root, home) {
  const n = S.normPath(S.expandHome(root, home));
  if (!S.hasGlob(n)) {
    const real = realResolve(n);
    return (p) => S.isUnder(p, real) || S.isUnder(p, n);
  }
  const base = globBase(n);
  const realBase = realResolve(base);
  const rx = globRe(realBase + n.slice(base.length));
  const rxRaw = globRe(n);
  return (p) => {
    if (!S.isUnder(p, realBase) && !S.isUnder(p, base)) return false;
    for (let cur = p; ; ) {
      if (rx.test(cur) || rxRaw.test(cur)) return true;
      const up = S.normPath(path.posix.dirname(cur.replace(/^([A-Z]:)$/i, '$1/')));
      if (!up || up === cur) return false;
      cur = up;
    }
  };
}

// The roots, with any $token still in them expanded (tree.effective has already expanded them; own powers have not).
function expandRoots(list, powers, home) {
  return S.expandPathTokens(Array.isArray(list) ? list : [], {
    workspace: powers.workspace, companyFolders: powers.companyFolders || [], scopeFolder: powers.scopeFolder || null, home,
  });
}

// The worktree rule: { path, live: [folders read-only for this position] } or null.
function worktreeInfo(powers) {
  const w = powers.worktree && typeof powers.worktree === 'object' ? powers.worktree : null;
  const wt = powers.worktreePath || (w && w.path) || null;
  if (!wt || typeof wt !== 'string') return null;
  const live = [];
  const of = powers.worktreeOf || (w && w.of) || null;
  if (of) live.push(of);
  else if (worktreeOf) { try { const r = worktreeOf(wt); if (r && r.main) live.push(r.main); } catch {} }
  if (powers.scopeFolder) live.push(powers.scopeFolder);
  return { path: S.normPath(wt), live: live.map((x) => S.normPath(x)) };
}

// The path area of one call: { read(p), write(p) -> null | deny reason }.
function area(powers, home) {
  const ws = powers.workspace ? [powers.workspace] : [];
  const wt = worktreeInfo(powers);
  const readRoots = [...ws, ...expandRoots(powers.read, powers, home), ...(wt ? [wt.path] : [])];
  const writeRoots = [...ws, ...expandRoots(powers.write, powers, home), ...(wt ? [wt.path] : [])];
  const R = readRoots.map((r) => rootMatcher(r, home));
  const W = writeRoots.map((r) => rootMatcher(r, home));
  const wtM = wt ? rootMatcher(wt.path, home) : null;
  const liveM = wt ? wt.live.map((r) => rootMatcher(r, home)) : [];
  const wsM = ws.map((r) => rootMatcher(r, home));
  return {
    canRead: (p) => R.some((m) => m(p)),
    canWrite: (p) => {
      if (wtM && wtM(p)) return true;
      if (wsM.some((m) => m(p))) return true;
      if (liveM.some((m) => m(p))) return false;
      return W.some((m) => m(p));
    },
    inLive: (p) => !!wt && !(wtM && wtM(p)) && !wsM.some((m) => m(p)) && liveM.some((m) => m(p)),
    worktree: wt,
  };
}

// ---------------------------------------------------------------- grants

function grantMatches(grant, need) {
  if (!grant || !need) return false;
  const gk = String(grant.kind || '');
  const target = grant.target == null ? '' : String(grant.target);
  if (need.kind === 'read' || need.kind === 'write') {
    if (!(gk === need.kind || (gk === 'write' && need.kind === 'read'))) return false;
    if (!target || !S.isAbsoluteAny(S.expandHome(target))) return false;
    const m = rootMatcher(target);
    return m(need.target);
  }
  if (gk !== need.kind) return false;
  if (need.kind === 'tool') return target === need.target;
  if (need.kind === 'bash') {
    const rank = (t) => BASH_RANK[String(t).replace(/^bash:/, '')] ?? -1;
    return rank(target) >= rank(need.target) && rank(need.target) >= 0;
  }
  if (need.kind === 'outward') return oneLine(target) !== '' && oneLine(target) === oneLine(need.target);
  return false;
}

// ---------------------------------------------------------------- shell commands

function oneLine(s, max = 0) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return max && t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function cmdName(t) {
  const base = String(t || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/, '');
}

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'case', 'esac', '!',
  '{', '}', 'function', 'select', 'elseif', 'foreach', 'try', 'catch', 'finally', 'switch', 'begin', 'process', 'end']);
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'sudo', 'winpty', 'time', 'stdbuf', 'unbuffer', 'call', 'nice']);

// Leading assignments, keywords and wrappers off: the words of the command that really runs.
function strip(words) {
  let k = 0;
  while (k < words.length) {
    const w = words[k];
    const low = w.t.toLowerCase();
    if (!w.q && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.t) && k + 1 < words.length) { k++; continue; }
    if (!w.q && KEYWORDS.has(low)) { k++; continue; }
    const nm = cmdName(w.t);
    if (nm === 'env') { k++; while (words[k] && (words[k].t.startsWith('-') || /^[A-Za-z_]\w*=/.test(words[k].t))) k++; continue; }
    if (WRAPPERS.has(nm)) { k++; while (words[k] && /^-./.test(words[k].t)) k++; continue; }
    if (nm === 'timeout') { k++; while (words[k] && /^-./.test(words[k].t)) k++; k++; continue; }
    if (nm === 'xargs') { k++; while (words[k] && /^-./.test(words[k].t)) { if (/^-[IinLPdaEs]$/.test(words[k].t)) k++; k++; } continue; }
    break;
  }
  return words.slice(k);
}

// Every command in the text, nested ones included; shell re-entry (bash -c, powershell -Command, cmd /c) followed.
// -> [{ words: [{ t, dyn, q }], dialect }]. srcs (optional) collects every text scanned: [{ src, dialect }].
function commands(src, dialect, depth = 0, out = [], srcs = null) {
  if (depth > MAX_DEPTH) return out;
  if (srcs) srcs.push({ src: String(src || ''), dialect });
  for (const ev of PG.scan(src, dialect)) {
    if (ev.type !== 'cmd') continue;
    const words = strip(ev.words);
    if (!words.length) continue;
    out.push({ words, dialect });
    const nm = cmdName(words[0].t);
    const rest = words.slice(1);
    let inner = null;
    let innerD = dialect;
    if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'git-bash'].includes(nm)) {
      const i = rest.findIndex((w) => /^-[a-z]*c$/i.test(w.t));
      if (i >= 0 && rest[i + 1]) { inner = rest[i + 1].t; innerD = 'bash'; }
    } else if (['powershell', 'pwsh'].includes(nm)) {
      const i = rest.findIndex((w) => /^-(c|command)$/i.test(w.t));
      if (i >= 0 && rest[i + 1]) { inner = rest.slice(i + 1).map((w) => w.t).join(' '); innerD = 'ps'; }
    } else if (nm === 'cmd') {
      const i = rest.findIndex((w) => /^\/[ck]$/i.test(w.t));
      if (i >= 0 && rest[i + 1]) { inner = rest.slice(i + 1).map((w) => w.t).join(' '); innerD = 'bash'; }
    } else if (['invoke-expression', 'iex', 'eval'].includes(nm) && rest.length) {
      inner = rest.map((w) => w.t).join(' ');
    }
    for (const h of ev.heredocs || []) if (['bash', 'sh', 'zsh', 'powershell', 'pwsh'].includes(nm)) commands(h, nm.startsWith('p') ? 'ps' : 'bash', depth + 1, out, srcs);
    if (inner) commands(inner, innerD, depth + 1, out, srcs);
  }
  return out;
}

// Redirects into a file (anything but another stream or the null device), outside quotes: the first target.
function writesRedirect(src, dialect) {
  return redirectTargets(src, dialect, true)[0] || null;
}
// Every such redirect target ('>' when the target could not be read), or only the first with first = true.
function redirectTargets(src, dialect, first = false) {
  const out = [];
  const s = String(src || '');
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (q === '"' && (c === (dialect === 'ps' ? '`' : '\\'))) i++;
      continue;
    }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === (dialect === 'ps' ? '`' : '\\')) { i++; continue; }
    if (c !== '>') continue;
    let j = i + 1;
    if (s[j] === '>' || s[j] === '|') j++;
    if (s[j] === '&') { j++; if (/[0-9-]/.test(s[j] || '')) { i = j; continue; } }
    while (s[j] === ' ' || s[j] === '\t') j++;
    const m = /^("[^"]*"|'[^']*'|(?:\$\([^)]*\)|\$\{[^}]*\}|[^\s;&|)])+)/.exec(s.slice(j));
    const target = m ? m[1].replace(/^["']|["']$/g, '') : '';
    if (/^(\/dev\/null|nul|\$null)$/i.test(target)) { i = j + (m ? m[1].length : 0) - 1; continue; }
    out.push(target || '>');
    if (first) return out;
    i = j + (m ? m[1].length : 0) - 1;
  }
  return out;
}

// A word that may point outside the folder the command runs in: absolute, ~, or with a '..' segment.
function pathLike(t) {
  const v = String(t || '');
  return S.isAbsoluteAny(v) || /^~([\\/]|$)/.test(v) || /(^|[\\/])\.\.([\\/]|$)/.test(v);
}
function pathArgs(words) {
  const out = [];
  for (const w of words) {
    if (w.dyn) continue;
    let v = w.t;
    if (/^-/.test(v)) { const eq = v.indexOf('='); if (eq < 0) continue; v = v.slice(eq + 1); }
    if (v && pathLike(v)) out.push(v);
  }
  return out;
}

// The read-only list. A value of true = any arguments; a function = (args) -> null | why refused.
const NO_FIND_ACTIONS = (args) => (args.some((w) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(w.t)) ? 'find may not run or delete anything' : null);
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'shortlog', 'cat-file', 'grep', 'rev-list', 'whatchanged', 'reflog']);
function gitReadonly(args) {
  let k = 0;
  for (; k < args.length; k++) {
    const a = args[k].t;
    if (a === '-C') { k++; continue; }
    if (a === '--no-pager' || a === '-P' || a === '--no-optional-locks') continue;
    if (/^-/.test(a)) return `git ${a} is not allowed read-only`;
    break;
  }
  const sub = args[k] ? args[k].t.toLowerCase() : '';
  const rest = args.slice(k + 1);
  if (rest.some((w) => /^--output(=|$)/.test(w.t) || /^--ext-diff$/.test(w.t))) return 'git output to a file is not allowed read-only';
  if (sub === 'branch') return rest.every((w) => /^(-a|-r|-v|-vv|--all|--list|-l|--show-current|--remotes|--no-color|--color)$/.test(w.t)) ? null : 'git branch may only list read-only';
  if (sub === 'reflog' && rest.length && !/^(show|-)/.test(rest[0].t)) return 'git reflog may only show read-only';
  return GIT_READ.has(sub) ? null : `git ${sub || '(nothing)'} is not a read-only git command`;
}
function nodeReadonly(args) {
  if (args.length === 1 && /^(--version|-v)$/.test(args[0].t)) return null;
  if (args.length && args[0].t === '--test' && !args.some((w) => /destination|--watch|--eval|^-e$|^-p$|--require|^-r$|--import|--loader/.test(w.t))) return null;
  return 'node may only run --version or --test read-only';
}
const READ_CMDS = new Map(Object.entries({
  ls: true, dir: true, cat: true, type: true, head: true, tail: true, wc: true, pwd: true, echo: true, grep: true, egrep: true,
  rg: true, findstr: true, tree: true, stat: true, file: true, du: true, df: true, which: true, where: true, whoami: true,
  date: true, sort: true, uniq: true, cut: true, diff: true, cmp: true, basename: true, dirname: true, realpath: true,
  true: true, cd: true, pushd: true, popd: true, find: NO_FIND_ACTIONS, git: gitReadonly, node: nodeReadonly,
  // PowerShell
  'get-childitem': true, gci: true, 'get-content': true, gc: true, 'get-location': true, gl: true, 'select-string': true,
  sls: true, 'get-item': true, gi: true, 'test-path': true, 'resolve-path': true, 'measure-object': true, measure: true,
  'select-object': true, select: true, 'where-object': true, '?': true, 'sort-object': true, 'format-table': true, ft: true,
  'format-list': true, fl: true, 'out-string': true, 'write-output': true, 'write-host': true, 'split-path': true,
  'join-path': true, 'get-date': true, 'get-command': true, gcm: true, 'set-location': true, sl: true, chdir: true,
  'push-location': true, 'pop-location': true, 'get-filehash': true, 'compare-object': true, 'group-object': true,
  'foreach-object': true, '%': true,
}));
const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);

// Read-only Bash: null when every command is a read inside the read area, else the reason.
function readonlyWhy(command, dialect, cwd, A) {
  const r = writesRedirect(command, dialect);
  if (r) return `it writes to a file (> ${r})`;
  let dir = cwd;
  for (const c of commands(command, dialect)) {
    const [w0, ...args] = c.words;
    if (w0.dyn) return `the command name is built at run time (${oneLine(w0.t, 40)})`;
    const nm = cmdName(w0.t);
    const rule = READ_CMDS.get(nm);
    if (!rule) return `${w0.t} is not on the read-only list`;
    const dyn = args.find((w) => w.dyn);
    if (dyn) return `it uses a variable or substitution (${oneLine(dyn.t.replace(/\0/g, '$(…)'), 40)})`;
    if (typeof rule === 'function') { const why = rule(args); if (why) return why; }
    const list = [...pathArgs(args)];
    if (CD.has(nm) && args[0] && !/^-/.test(args[0].t)) list.push(args[0].t);
    if (nm === 'git') { const i = args.findIndex((w) => w.t === '-C'); if (i >= 0 && args[i + 1]) list.push(args[i + 1].t); }
    for (const p of list) {
      const real = realResolve(S.expandHome(p), dir);
      if (!A.canRead(real)) return `it reads outside your area (${real})`;
    }
    if (CD.has(nm) && args[0] && !/^-/.test(args[0].t)) dir = realResolve(S.expandHome(args[0].t), dir);
  }
  return null;
}

// Bash on: commands that change files, naming paths outside write (best-effort; variables are not followed).
const WRITE_ALL = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'mkdir', 'md', 'touch', 'truncate', 'shred', 'chmod', 'chown',
  'remove-item', 'ri', 'set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content', 'clc', 'new-item', 'ni',
  'mv', 'move', 'move-item', 'mi', 'rename-item', 'rni', 'ren', 'tee', 'tee-object']);
const WRITE_LAST = new Set(['cp', 'copy', 'copy-item', 'cpi', 'robocopy', 'xcopy', 'rsync', 'ln']);
function writeOutsideWhy(command, dialect, cwd, A) {
  const r = writesRedirect(command, dialect);
  if (r && r !== '>' && pathLike(r) && !/^\$/.test(r)) {
    const real = realResolve(S.expandHome(r), cwd);
    if (!A.canWrite(real)) return real;
  }
  let dir = cwd;
  for (const c of commands(command, dialect)) {
    const [w0, ...args] = c.words;
    const nm = cmdName(w0.t);
    let list = [];
    if (WRITE_ALL.has(nm)) list = pathArgs(args);
    else if (WRITE_LAST.has(nm)) { const ps = args.filter((w) => !/^-/.test(w.t) && !w.dyn); if (ps.length) list = pathArgs([ps[ps.length - 1]]); }
    else if (nm === 'git') { const i = args.findIndex((w) => w.t === '-C'); if (i >= 0 && args[i + 1] && !args[i + 1].dyn && pathLike(args[i + 1].t)) list = [args[i + 1].t]; }
    for (const p of list) {
      const real = realResolve(S.expandHome(p), dir);
      if (!A.canWrite(real)) return real;
    }
    if (CD.has(nm) && args[0] && !args[0].dyn && !/^-/.test(args[0].t)) dir = realResolve(S.expandHome(args[0].t), dir);
  }
  return null;
}

// ---------------------------------------------------------------- a position's definition files

// A position's folder (<teamRoot>/<company>/positions/<id>/, its always-writable workspace) also holds what defines
// it: position.json (+ the position.json.v<N> copies), brief.md and chats.json. Only the owner (Team view, hand
// edits) and Helm's approval flow change those, so no position may write, delete, move or link them: its own or any
// other position's (retired/ too). notebook.md stays the position's own. The team root is taken from the workspace
// (<root>/<co>/positions/<id>), or deps.teamRoot when given. Write tools are denied exactly; shell commands best-effort
// (redirects, the usual write / delete / move / copy / link commands, sed -i, dd of=, .NET File calls).
const DEF_RE = /^(position\.json(\.v\d+)?|brief\.md|chats\.json)$/;
const DEF_SAMPLES = ['position.json', 'position.json.v1', 'brief.md', 'chats.json'];
const POS_PARENTS = new Set(['positions', 'retired']);
const caseFold = () => S.pathKey('A') === 'a';
// The name Windows really opens: no NTFS stream suffix (brief.md::$DATA), no trailing dots or spaces (brief.md.).
function defName(base) {
  let b = String(base || '');
  if (process.platform === 'win32' || caseFold()) b = b.replace(/:.*$/, '').replace(/[. ]+$/, '');
  return caseFold() ? b.toLowerCase() : b;
}
const isDefName = (base) => DEF_RE.test(defName(base));
function globHitsDef(base) {
  const b = defName(base);
  if (!/[*?[]/.test(b)) return false;
  let re = '';
  for (const c of b) re += c === '*' ? '.*' : c === '?' ? '.' : c === '[' || c === ']' ? c : c.replace(/[.+^${}()|\\]/g, '\\$&');
  try { const rx = new RegExp(`^${re}$`); return DEF_SAMPLES.some((n) => rx.test(n)); } catch { return true; }
}
const posixDir = (p) => S.normPath(path.posix.dirname(String(p).replace(/^([A-Z]:)$/i, '$1/')));

// -> { isDef(real), isPositionDir(real), holdsDef(real) } over real-pathed, normalised paths.
function definitions(powers, deps, home) {
  const ws = powers.workspace ? realResolve(S.expandHome(String(powers.workspace), home)) : null;
  let root = deps.teamRoot ? realResolve(S.expandHome(String(deps.teamRoot), home)) : null;
  if (!root && ws) {
    const parent = posixDir(ws);
    if (defName(path.posix.basename(parent)) === 'positions') root = posixDir(posixDir(parent));
  }
  const rel = (p) => (root && S.isUnder(p, root) ? S.pathKey(p).slice(S.pathKey(root).length).split('/').filter(Boolean) : null);
  const isPositionDir = (p) => {
    if (ws && S.pathKey(p) === S.pathKey(ws)) return true;
    const r = rel(p);
    return !!r && r.length === 3 && POS_PARENTS.has(r[1]);
  };
  // the path is a position folder or a folder above one (deleting / moving it takes definition files with it)
  const holdsDef = (p) => {
    if (ws && S.isUnder(ws, p)) return true;
    if (root && S.isUnder(root, p)) return true;
    const r = rel(p);
    return !!r && (r.length <= 1 || (POS_PARENTS.has(r[1]) && r.length <= 3));
  };
  const isDef = (p) => isDefName(path.posix.basename(p)) && isPositionDir(posixDir(p));
  return { isDef, isPositionDir, holdsDef, ws, root };
}

const DEF_DENY = (what) => `${what} is part of a position's definition (position.json, brief.md, chats.json): only the owner and Helm's approval flow change it, never a position. Your notebook.md and the rest of your folder are yours to write. If your brief or powers should change, say so in your reply or report.`;

// Shell commands (any Bash level, any dialect) that would write, delete, move or hard-link a definition file: the
// first such path, else null. Static paths are resolved against the call's cwd and every folder a cd in the chain
// moves to; a variable path is refused only when its last segment is a definition file name.
const DEF_REMOVE = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'ri', 'shred', 'unlink']);
const DEF_MOVE = new Set(['mv', 'move', 'move-item', 'mi', 'rename-item', 'rni', 'ren', 'rename']); // sources: removed; dest: as a copy
const DEF_WRITE = new Set(['touch', 'truncate', 'chmod', 'chown', 'chattr', 'attrib', 'icacls', 'cacls', 'takeown',
  'set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content', 'clc', 'new-item', 'ni', 'tee', 'tee-object',
  'set-itemproperty', 'sp', 'set-acl', 'export-csv', 'export-clixml']);
const DEF_CONTENT_CMDS = new Set(['set-content', 'sc', 'add-content', 'ac', 'out-file', 'tee-object']);
const DEF_COPY = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'rsync', 'install', 'scp']);
const DEF_LINK = new Set(['ln', 'link', 'mklink']);
const DEF_INPLACE = new Set(['sed', 'perl', 'ruby']);
const PS_CONTENT_PARAMS = /^-(value|inputobject|encoding|stream|delimiter|width)$/i;
const DOTNET_WRITE = /\[(?:System\.)?IO\.(?:File|FileInfo|Directory)\]::(Write\w*|Append\w*|Delete|Move|Copy|Replace|Create\w*|Open(?:Write)?|SetAttributes|SetAccessControl|Encrypt|Decrypt)\s*\(([^)]*)\)/gi;
function defWriteWhy(command, dialect, cwd, D, home) {
  const srcs = [];
  const cmds = commands(command, dialect, 0, [], srcs);
  const dirs = [cwd];
  let dir = cwd;
  for (const c of cmds) {
    const [w0, ...args] = c.words;
    if (CD.has(cmdName(w0.t)) && args[0] && !args[0].dyn && !/^-/.test(args[0].t)) { dir = realResolve(S.expandHome(args[0].t, home), dir); dirs.push(dir); }
  }
  const lastSeg = (t) => String(t).replace(/["'`]/g, '').replace(/\\/g, '/').split('/').pop();
  // a target as written -> the definition path it hits, or null. remove: a folder holding definitions counts too.
  const hit = (raw, from, remove = false) => {
    const t = String(raw || '');
    if (!t || t === '>') return null;
    if (/[$`\0]/.test(t)) return isDefName(lastSeg(t)) ? t.replace(/\0/g, '$(…)') : null;
    for (const d of from) {
      const real = realResolve(S.expandHome(t, home), d);
      if (D.isDef(real)) return real;
      const base = path.posix.basename(real);
      if (/[*?[]/.test(base)) {
        const up = posixDir(real);
        if (D.isPositionDir(up) ? globHitsDef(base) : (remove && D.holdsDef(up))) return real;
      } else if (remove && D.holdsDef(real)) return real;
    }
    return null;
  };
  for (const { src, dialect: d } of srcs) {
    for (const r of redirectTargets(src, d)) { const h = hit(r, dirs); if (h) return h; }
    DOTNET_WRITE.lastIndex = 0;
    for (let m; (m = DOTNET_WRITE.exec(src)); ) {
      for (const q of m[2].match(/"[^"]*"|'[^']*'/g) || []) { const h = hit(q.slice(1, -1), dirs, /^(delete|move|replace)$/i.test(m[1])); if (h) return h; }
    }
  }
  // words that name files: not flags (a -Param:value / --opt=value gives its value); a dynamic word keeps its $ mark
  const names = (list, skipContent = false) => {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      let v = w.t;
      if (/^-/.test(v)) {
        if (skipContent && PS_CONTENT_PARAMS.test(v)) { i++; continue; }
        const eq = v.search(/[=:]/);
        if (eq < 0) continue;
        v = v.slice(eq + 1);
      }
      if (v) out.push(w.dyn ? `$${v}` : v);
    }
    return out;
  };
  dir = cwd;
  for (const c of cmds) {
    const [w0, ...args] = c.words;
    const nm = cmdName(w0.t);
    const at = [dir];
    const any = (list, remove = false) => { for (const v of list) { const h = hit(v, at, remove); if (h) return h; } return null; };
    let why = null;
    if (DEF_REMOVE.has(nm)) why = any(names(args), true);
    else if (DEF_WRITE.has(nm)) why = any(names(args, DEF_CONTENT_CMDS.has(nm)));
    else if (DEF_LINK.has(nm) || (nm === 'fsutil' && args.some((w) => /^hardlink$/i.test(w.t)))) why = any(names(args));
    else if (DEF_INPLACE.has(nm) && args.some((w) => /^(-[a-z]*i\S*|--in-place\S*)$/i.test(w.t))) why = any(names(args));
    else if (nm === 'dd') why = any(args.filter((w) => /^of=/i.test(w.t)).map((w) => w.t.slice(3)));
    else if (DEF_COPY.has(nm) || DEF_MOVE.has(nm) || nm === 'robocopy') {
      const pos = [];
      let dest = null;
      for (let i = 0; i < args.length; i++) {
        const v = args[i].t;
        if (/^(-destination|-newname|--target-directory|-t)$/i.test(v) && args[i + 1]) { dest = args[++i]; continue; }
        if (/^--target-directory=/i.test(v)) { dest = { t: v.slice(v.indexOf('=') + 1), dyn: args[i].dyn }; continue; }
        if (/^-/.test(v) || (/^\/[A-Za-z0-9:]*$/.test(v) && /^(robocopy|xcopy|copy)$/.test(nm))) continue; // flags, cmd /switches
        pos.push(args[i]);
      }
      let sources;
      if (nm === 'robocopy') { dest = pos[1] || null; sources = pos.slice(2); }
      else { if (!dest) dest = pos.pop() || null; sources = pos; }
      if (DEF_MOVE.has(nm)) why = any(sources.map((w) => (w.dyn ? `$${w.t}` : w.t)), true);
      if (!why && dest) {
        const dv = dest.dyn ? `$${dest.t}` : dest.t;
        why = hit(dv, at);
        if (!why && !dest.dyn) {
          const real = realResolve(S.expandHome(dv, home), dir);
          // copying INTO a position folder: refused when a copied name is a definition file (robocopy with no file
          // list copies, and with /MIR deletes, everything)
          const copied = sources.map((w) => lastSeg(w.t));
          if (D.isPositionDir(real) && ((nm === 'robocopy' && !copied.length) || copied.some((n) => isDefName(n) || globHitsDef(n)))) why = real;
        }
      }
    }
    if (why) return why;
    if (CD.has(nm) && args[0] && !args[0].dyn && !/^-/.test(args[0].t)) dir = realResolve(S.expandHome(args[0].t, home), dir);
  }
  return null;
}

// ---------------------------------------------------------------- outward

const GH_READ_SUBS = new Set(['view', 'list', 'ls', 'status', 'checks', 'diff', 'search', 'watch', 'download', 'browse', 'verify']);
const GH_FREE_GROUPS = new Set(['auth', 'config', 'alias', 'extension', 'completion', 'help', 'browse', 'status', 'search', 'version', '--version']);
const WRITE_METHOD = /^(post|put|patch|delete)$/i;
const MAIL = new Set(['sendmail', 'mutt', 'mail', 'mailx', 'msmtp', 'swaks', 'send-mailmessage', 'neomutt', 'ssmtp']);
const ALWAYS_OUTWARD = new Set(['stripe', 'twilio', 'vercel', 'netlify', 'heroku', 'wrangler', 'firebase', 'flyctl', 'fly', 'twine', 'gem', 'cargo', 'docker', 'nuget']);
const OUTWARD_SUB = { vercel: null, netlify: /^(deploy|publish)$/, heroku: /^(deploy|releases:|config:set|apps:create)/, wrangler: /^(deploy|publish)$/,
  firebase: /^deploy$/, flyctl: /^deploy$/, fly: /^deploy$/, twine: /^upload$/, gem: /^push$/, cargo: /^publish$/, docker: /^push$/, nuget: /^push$/ };

// curl / wget with a write method or a body (bash flags).
function bashHttp(nm, a) {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if ((x === '-X' || x === '--request') && WRITE_METHOD.test(a[i + 1] || '')) return `${nm} ${a[i + 1].toUpperCase()}`;
    if (/^-X(post|put|patch|delete)$/i.test(x) || /^--request=(post|put|patch|delete)$/i.test(x)) return `${nm} ${x.replace(/^(-X|--request=)/i, '').toUpperCase()}`;
    if (nm === 'curl' && /^(-d|--data|--data-raw|--data-binary|--data-urlencode|--json|-F|--form|--form-string|-T|--upload-file)(=|$)/.test(x)) return `curl with a body (${x.replace(/=.*/, '')})`;
    if (nm === 'curl' && /^-[dFT]./.test(x)) return `curl with a body (${x.slice(0, 2)})`;
    if (nm === 'wget' && /^--(post-data|post-file|body-data|body-file|method)(=|$)/.test(x)) {
      if (/^--method/.test(x)) { const m = x.includes('=') ? x.split('=')[1] : a[i + 1]; if (WRITE_METHOD.test(m || '')) return `wget ${String(m).toUpperCase()}`; continue; }
      return `wget with a body (${x.replace(/=.*/, '')})`;
    }
  }
  return null;
}

// One command's words -> a short label when it leaves the machine, else null.
function outwardOf(words) {
  const [w0, ...args] = words;
  const nm = cmdName(w0.t);
  const a = args.map((w) => w.t);
  const lo = a.map((x) => x.toLowerCase());
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(nm)) {
    const sub = lo.find((x) => !x.startsWith('-'));
    if (sub === 'publish' || sub === 'unpublish' || (nm === 'yarn' && sub === 'npm' && lo.includes('publish'))) return `${nm} ${sub === 'npm' ? 'npm publish' : sub}`;
    if (nm === 'npm' && sub === 'deprecate') return 'npm deprecate';
    return null;
  }
  if (nm === 'gh') {
    const pos = lo.filter((x) => !x.startsWith('-'));
    const [grp, sub] = pos;
    if (!grp || GH_FREE_GROUPS.has(grp)) return null;
    if (grp === 'api') {
      const mi = lo.findIndex((x) => x === '-x' || x === '--method');
      const method = mi >= 0 ? lo[mi + 1] : (lo.find((x) => /^(-x|--method=)/.test(x) && x.length > 2) || '').replace(/^(-x|--method=)/, '');
      if (WRITE_METHOD.test(method || '')) return `gh api ${method.toUpperCase()}`;
      if (lo.some((x) => /^(-f|-F|--field|--raw-field|--input)(=|$)/i.test(x) || /^-[fF].+/.test(x))) return 'gh api with fields (a write)';
      return null;
    }
    if (sub && GH_READ_SUBS.has(sub)) return null;
    if (!sub && grp !== 'gist') return null;
    return `gh ${grp}${sub ? ' ' + sub : ''}`;
  }
  if (nm === 'curl' || nm === 'wget') {
    const hit = bashHttp(nm, a);
    if (hit) return hit;
  }
  if (['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'curl', 'wget'].includes(nm)) {
    for (let i = 0; i < a.length; i++) {
      const x = lo[i];
      if (/^-(method|m)$/.test(x) && WRITE_METHOD.test(a[i + 1] || '')) return `${w0.t} ${a[i + 1].toUpperCase()}`;
      if (/^-(method|m):(post|put|patch|delete)$/.test(x)) return `${w0.t} ${x.split(':')[1].toUpperCase()}`;
      if (/^-(body|infile|form)(:|$)/.test(x)) return `${w0.t} with a body`;
    }
    return null;
  }
  if (MAIL.has(nm)) return `sending mail (${w0.t})`;
  if (nm === 'git' && lo.includes('send-email')) return 'git send-email';
  if (ALWAYS_OUTWARD.has(nm)) {
    const re = OUTWARD_SUB[nm];
    if (re === undefined) return nm;
    const sub = lo.find((x) => !x.startsWith('-')) || '';
    if (re === null) return ['dev', 'env', 'whoami', 'ls', 'list', 'logs', 'inspect', 'help', '--version', 'login', 'link', 'pull'].includes(sub) ? null : `${nm}${sub ? ' ' + sub : ''}`;
    return re.test(sub) ? `${nm} ${sub}` : null;
  }
  return null;
}

// Every outward thing in the command -> [labels].
async function outwardHits(toolName, toolInput, command, dialect, cwd, o) {
  const hits = [];
  const add = (x) => { if (x && !hits.includes(x)) hits.push(x); };
  const v = await PG.assess(toolName, toolInput, { cwd, targets: o.targets || [], home: o.home, git: o.git, gh: o.gh });
  if (v) add(v.short || v.title);
  const acts = PG.collect(command, dialect, cwd ? path.resolve(cwd) : null, o.home || os.homedir(), [], 0);
  for (const a of acts.slice(0, 40)) {
    if (a.kind === 'git') add(a.unknownSub ? 'a git command chosen at run time (could push)' : 'git push');
    else if (a.kind === 'gh') add(`gh ${a.what || 'write'}`);
    else if (a.kind === 'railway') add(`railway ${a.sub}`);
    else if (a.kind === 'gitAlias' && a.dir) {
      const r = await (o.git || PG.runGit)(a.dir, ['config', '--get', `alias.${a.sub}`]);
      if (r && r.ok && /(^|[\s;&|!])push(\s|$)|send-email/.test(r.out || '')) add(`git ${a.sub} (an alias that pushes)`);
    }
  }
  for (const c of commands(command, dialect)) add(outwardOf(c.words));
  return hits;
}

// ---------------------------------------------------------------- the decision

// deps.handedReads(sid) -> [abs paths] (sync or async); anything that is not an absolute path is dropped. A failure
// hands nothing (the call is then checked against powers alone).
async function handedPaths(deps, sid, home) {
  if (typeof deps.handedReads !== 'function') return [];
  try {
    const list = await deps.handedReads(sid);
    if (!Array.isArray(list)) return [];
    return list.filter((x) => typeof x === 'string' && x && S.isAbsoluteAny(S.expandHome(x, home)))
      .map((x) => S.normPath(S.expandHome(x, home)));
  } catch (e) {
    deps.log('warn', `team-guard: handedReads failed for ${sid}: ${e && e.message}`);
    return [];
  }
}

// After an allowed write: tell the engine when the target is the position's own <workspace>/notebook.md.
function noteNotebook(deps, sid, powers, real) {
  if (typeof deps.noteOwnWrite !== 'function' || !powers.workspace) return;
  try {
    const nb = realResolve(path.join(String(powers.workspace), 'notebook.md'));
    if (S.pathKey(real) !== S.pathKey(nb)) return;
    const r = deps.noteOwnWrite(sid, real);
    if (r && typeof r.catch === 'function') r.catch((e) => deps.log('warn', `team-guard: noteOwnWrite failed: ${e && e.message}`));
  } catch (e) {
    deps.log('warn', `team-guard: noteOwnWrite failed: ${e && e.message}`);
  }
}

async function decide(input, deps, sid, toolUseID, signal) {
  const toolName = input && input.tool_name;
  if (!toolName || typeof toolName !== 'string') throw new Error('no tool name');
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const powers = await deps.getEffectivePowers(sid);
  if (!powers || typeof powers !== 'object') return deny(ERROR_TEXT('no powers for this position'));
  const home = deps.home || os.homedir();
  const tools = Array.isArray(powers.tools) ? powers.tools : [];
  const cwd = input.cwd || powers.cwd || (worktreeInfo(powers) || {}).path || powers.workspace || process.cwd();

  // Unmet needs are tried against once-grants in order; one missing = denied with its reason.
  const grant = async (need, reason) => {
    if (typeof deps.consumeGrant !== 'function') return reason;
    const n = { ...need, toolName, matches: (g) => grantMatches(g, n) };
    const got = await deps.consumeGrant(sid, n);
    if (got) { deps.log('info', `team-guard: ${sid} used a once-grant (${need.kind} ${oneLine(need.target, 120)}) for ${toolName}`); return null; }
    return reason;
  };

  // 1. MCP and the tool list
  if (/^mcp__/i.test(toolName)) {
    if (/^mcp__team__/.test(toolName)) return ALLOW;
    return deny(`Not in your powers (${toolName}): positions only use the team tools. ${ASK_MORE}`);
  }
  if (NEVER_TOOLS.has(toolName)) return deny(`${toolName} is never available to positions.`);
  const notInPowers = (what) => `Not in your powers (${what}). ${ASK_MORE}`;
  if (AGENT_TOOLS.includes(toolName)) {
    if (powers.agents === true) return ALLOW;
    const why = await grant({ kind: 'tool', target: toolName }, notInPowers(`${toolName}: this position may not use subagents`));
    return why ? deny(why) : ALLOW;
  }
  const shell = SHELL_TOOLS.includes(toolName);
  let level = powers.bash === 'on' || powers.bash === 'readonly' ? powers.bash : 'off';
  if (!shell && !ALWAYS_TOOLS.includes(toolName) && !tools.includes(toolName)) {
    const why = await grant({ kind: 'tool', target: toolName }, notInPowers(toolName));
    if (why) return deny(why);
  }

  // 2. Files (paths handed with the ask this position is answering are readable for this call, never writable)
  const handed = await handedPaths(deps, sid, home);
  const D = definitions(powers, deps, home);
  const A = area(handed.length ? { ...powers, read: [...(Array.isArray(powers.read) ? powers.read : []), ...handed] } : powers, home);
  const fileCheck = async (raw, write) => {
    const real = realResolve(S.expandHome(String(raw), home), cwd);
    if (write ? A.canWrite(real) : A.canRead(real)) return null;
    let why;
    if (write && A.inLive(real)) why = `You work in your own worktree at ${A.worktree.path}; the live folder is read-only for you (${real}). Make the change in your worktree.`;
    else if (write && A.canRead(real)) why = `Outside your write area: ${real} (you may read it, not change it). If you need to change it, call request_access with kind "write" and the reason.`;
    else why = `Outside your area: ${real}. If you need it, call request_access with the reason.`;
    if (write && A.inLive(real)) return why; // the worktree rule is not a grant question
    return grant({ kind: write ? 'write' : 'read', target: real }, why);
  };
  if (READ_FILE_TOOLS[toolName] || WRITE_FILE_TOOLS[toolName]) {
    const write = !!WRITE_FILE_TOOLS[toolName];
    const key = write ? WRITE_FILE_TOOLS[toolName] : READ_FILE_TOOLS[toolName];
    let target = toolInput[key];
    if (target == null || target === '') {
      if (toolName === 'Grep' || toolName === 'Glob') target = cwd;
      else return deny(`${toolName} has no ${key}; denied.`);
    }
    if (typeof target !== 'string') return deny(`${toolName}: ${key} must be a path; denied.`);
    const list = [target];
    if (toolName === 'Glob' && typeof toolInput.pattern === 'string') {
      const pat = S.expandHome(toolInput.pattern.replace(/\\/g, '/'), home);
      if (S.isAbsoluteAny(pat) || /(^|\/)\.\.(\/|$)/.test(pat)) list.push(globBase(S.normPath(path.resolve(path.resolve(cwd, target), pat))));
    }
    if (write) {
      const real = realResolve(S.expandHome(String(target), home), cwd);
      if (D.isDef(real)) return deny(DEF_DENY(real));
    }
    for (const p of list) { const why = await fileCheck(p, write); if (why) return deny(why); }
    if (write) noteNotebook(deps, sid, powers, realResolve(S.expandHome(String(target), home), cwd));
    return ALLOW;
  }

  // 3. Shells
  if (shell) {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    const dialect = toolName === 'PowerShell' ? 'ps' : 'bash';
    if (toolName !== 'Bash' && !tools.includes(toolName)) {
      const why = await grant({ kind: 'tool', target: toolName }, notInPowers(toolName));
      if (why) return deny(why);
    }
    const def = defWriteWhy(command, dialect, cwd, D, home);
    if (def) return deny(DEF_DENY(`This command would change ${def}; that`));
    if (level === 'off') {
      const why = await grant({ kind: 'bash', target: 'bash:readonly' }, `Not in your powers (Bash is off for this position). ${ASK_MORE}`);
      if (why) return deny(why);
      level = 'readonly';
    }
    if (level === 'readonly') {
      const r = readonlyWhy(command, dialect, cwd, A);
      if (!r) return ALLOW;
      const why = await grant({ kind: 'bash', target: 'bash:on' }, `Your Bash is read-only, and this command is not: ${r}. ${ASK_MORE}`);
      if (why) return deny(why);
      level = 'on';
    }
    const outside = writeOutsideWhy(command, dialect, cwd, A);
    if (outside) {
      let why;
      if (A.inLive(outside)) why = `You work in your own worktree at ${A.worktree.path}; the live folder is read-only for you (${outside}).`;
      else why = await grant({ kind: 'write', target: outside }, `Outside your write area: ${outside}. If you need it, call request_access with the reason.`);
      if (why) return deny(why);
    }
    const hits = await outwardHits(toolName, toolInput, command, dialect, cwd, deps);
    if (!hits.length) return ALLOW;
    return outward(hits, { toolName, toolInput, command, toolUseID, signal }, deps, sid, grant);
  }
  return ALLOW;
}

async function outward(hits, call, deps, sid, grant) {
  const { owner, Owner } = ownerWords(deps.ownerName);
  const title = `Outward action · ${hits.join(', ')}`;
  if (!(await grant({ kind: 'outward', target: call.command }, 'no grant'))) return ALLOW;
  if (typeof deps.requestApproval !== 'function') return deny(`This leaves the machine (${hits.join(', ')}), and Helm could not ask ${owner}; it was NOT run.`);
  if (call.signal && call.signal.aborted) return deny(`Cancelled before ${owner} answered; the command was NOT run.`);
  deps.log('info', `team-guard: ${sid} asking ${owner}: ${title}: ${oneLine(call.command, 160)}`);
  const waitMs = deps.waitMs || WAIT_MS;
  let timer = null, onAbort = null;
  const r = await Promise.race([
    Promise.resolve().then(() => deps.requestApproval({ kind: 'outward', sessionId: sid, toolName: call.toolName, toolInput: call.toolInput,
      toolUseID: call.toolUseID, signal: call.signal, command: call.command, what: hits, title, waitMs })).catch((e) => ({ error: e })),
    new Promise((res) => { timer = setTimeout(() => res({ timedOut: true }), waitMs); if (timer.unref) timer.unref(); }),
    new Promise((res) => { if (call.signal && call.signal.addEventListener) { onAbort = () => res({ aborted: true }); call.signal.addEventListener('abort', onAbort, { once: true }); } }),
  ]);
  clearTimeout(timer);
  if (onAbort) try { call.signal.removeEventListener('abort', onAbort); } catch {}
  const ok = r === true || (r && (r.behavior === 'allow' || ['once', 'always', 'allow', 'approved'].includes(r.decision)));
  if (ok) { deps.log('info', `team-guard: ${sid} ${owner} allowed ${title} (once)`); return ALLOW; }
  if (r && r.error) return deny(`Helm could not ask ${owner} about this outward action (${r.error && r.error.message}); it was NOT run.`);
  if (r && r.timedOut) return deny(`${Owner} did not answer the outward approval (${hits.join(', ')}) within ${Math.round(waitMs / 60000)} minutes, so it was NOT run. Do not retry it or work around it; record it as an Open item.`);
  if (r && r.aborted) return deny(`The turn was stopped before ${owner} answered; the command was NOT run.`);
  const msg = r && (r.note || r.message) ? String(r.note || r.message) : '';
  deps.log('info', `team-guard: ${sid} ${owner} declined ${title}`);
  return deny(`${Owner} declined this outward action (${hits.join(', ')}). It was NOT run. Do not retry it or work around it in this turn; a later need may ask again.${msg ? ` Note from ${owner}: "${msg}"` : ''}`);
}

function createHook(opts = {}) {
  const logFn = typeof opts.log === 'function' ? opts.log : () => {};
  const deps = { ...opts, log: (level, msg) => { try { logFn(level, msg); } catch {} } };
  const callback = async (input, toolUseID, ctx = {}) => {
    try {
      if (typeof deps.getEffectivePowers !== 'function') throw new Error('no getEffectivePowers');
      const sid = opts.sessionId || (input && input.session_id) || null;
      return await decide(input, deps, sid, toolUseID, ctx && ctx.signal);
    } catch (e) {
      deps.log('error', `team-guard: check failed, denying: ${e && (e.stack || e.message)}`);
      return deny(ERROR_TEXT((e && e.message) || 'error'));
    }
  };
  return { hooks: [callback], timeout: HOOK_TIMEOUT_S };
}

module.exports = { createHook, decide, grantMatches, realResolve, area, outwardOf, readonlyWhy, writesRedirect, WAIT_MS, HOOK_TIMEOUT_S };
