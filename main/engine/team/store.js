// Positions: the team root on disk (docs/POSITIONS.md 2). Plain JSON + markdown that the owner can read and hand-edit.
//
//   const store = createTeamStore({ root?, now?, houseRulesDefault? })    root defaults to ~/helm-team
//   store.root / store.ensureRoot() / store.checkRoot() / store.houseRules()
//   companies: listCompanies() getCompany(cid) createCompany(draft, { createdBy }) updateCompany(cid, patch|fn, { expectVersion })
//   positions: listPositions(cid, { retired }) getPosition(cid, pid) takenIds(cid) tree(cid) workspaceOf(cid, pid)
//              effectivePowers(cid, pid) createPosition(cid, draft, { brief, seed, createdBy })
//              updatePosition(cid, pid, patch|fn, { expectVersion }) retirePosition(cid, pid, { mode, openTickets })
//              versions(cid, pid) readVersion(cid, pid, n) sweepRetired(cid)
//   files:     readBrief/writeBrief  readNotebook/writeNotebook/notebookAdd  readChats/writeChats/addChat/updateChat
//   logs:      append(cid, log, obj) readLog(cid, log, { since, limit, filter })   log: proposals|crosstalk|grants|inbox|duty-runs
//   problems(cid?) -> [{ company, position?, file, errors, usingVersion? }]   hand edits that failed validation
//   watch() / close() / on('change', fn)   fs.watch on the root; events: { kind, company, position?, file, ok, errors?, ... }
//
// Rules:
// - Every write is atomic (unique temp file + fsync + rename). Read-modify-write runs under a lock file (`.lock` in the
//   company folder, or the root for company create/update), so two writers (two Helm processes, a test and Helm)
//   never interleave. `expectVersion` turns a stale write into a 'conflict' error instead of a lost update.
// - position.json and company.json are versioned: version +1 on every Helm write, and a copy `<file>.v<N>` of each
//   written version (the last 10 kept). The copy of the current version is what keeps a last good value in force
//   after a restart when a hand edit broke the file.
// - Hand edits are re-validated whenever the file's mtime/size changes (on every read, and on fs.watch events). A file
//   that fails (bad JSON, schema, an id that is not its folder name, a tree problem such as a cycle) leaves the last
//   good value in force; problems() and the change event say why. Helm never overwrites a broken hand edit: writes to
//   it are refused with 'invalid' until it is fixed.
// - JSONL logs are append-only: one write per line, a torn last line from a crash is fenced off with a newline, and
//   readers skip lines that do not parse (counted as `bad`).
// - Positions are flat folders under positions/; retiring moves the folder to retired/ (if Windows holds it open, the
//   position stays retired in place and sweepRetired() moves it later).
// Errors are TeamStoreError { code: 'invalid'|'conflict'|'not-found'|'exists'|'tree'|'busy'|'locked'|'root', errors }.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const S = require('./schema');
const { createTree } = require('./tree');

const LOGS = ['proposals', 'crosstalk', 'grants', 'inbox', 'duty-runs'];
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const WATCH_DEBOUNCE_MS = 120;
const NOTE_MAX = 4_000;

class TeamStoreError extends Error {
  constructor(code, message, errors) {
    super(message);
    this.name = 'TeamStoreError';
    this.code = code;
    this.errors = errors || [message];
  }
}
const fail = (code, message, errors) => { throw new TeamStoreError(code, message, errors); };

const defaultTeamRoot = () => path.join(os.homedir(), 'helm-team');

const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };

function sigOf(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
  } catch { return 'missing'; }
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    try { fs.fsyncSync(fd); } catch {}
  } finally { fs.closeSync(fd); }
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
      }
      sleep(20 * (i + 1)); // Windows: antivirus / indexer / an editor holding the target for a moment
    }
  }
}

function renameRetry(from, to, tries = 5) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return true; } catch (e) {
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) return e;
      sleep(40 * (i + 1));
    }
  }
}

const json = (v) => JSON.stringify(v, null, 2) + '\n';

function readParsed(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { ok: false, missing: e.code === 'ENOENT', errors: [e.code === 'ENOENT' ? `${path.basename(file)}: missing` : `${path.basename(file)}: ${e.message}`] };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // Notepad's BOM
  try { return { ok: true, value: JSON.parse(text) }; } catch (e) {
    return { ok: false, errors: [`${path.basename(file)}: not valid JSON (${e.message})`] };
  }
}

function readTextFile(file) {
  try {
    let t = fs.readFileSync(file, 'utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return { ok: true, text: t };
  } catch (e) {
    return { ok: false, missing: e.code === 'ENOENT', errors: [`${path.basename(file)}: ${e.code === 'ENOENT' ? 'missing' : e.message}`] };
  }
}

// Refuse a team root inside a git work tree, inside (or around) a company folder, or that is the home folder itself.
function checkTeamRoot(root, { companies = [], home = os.homedir() } = {}) {
  const r = S.normPath(path.resolve(root));
  if (!r) return { ok: false, reason: 'no team root folder given' };
  if (S.pathKey(r) === S.pathKey(S.normPath(home)) || /^[A-Z]:\/?$/.test(r) || r === '/') {
    return { ok: false, reason: `${r} is a whole home folder or drive; pick a folder of its own such as ~/helm-team` };
  }
  let dir = path.resolve(root);
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return { ok: false, reason: `${r} is inside a git work tree (${S.normPath(dir)}); team files must never be committed by accident` };
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const c of companies) {
    for (const f of c.folders || []) {
      if (S.isUnder(r, f)) return { ok: false, reason: `${r} is inside ${c.name}'s folder ${f}` };
      if (S.isUnder(f, r)) return { ok: false, reason: `${c.name}'s folder ${f} is inside ${r}` };
    }
  }
  return { ok: true, reason: null };
}

const README = `# Helm team root

Helm keeps your Positions here: the AI staff of each company, as plain files you may read and edit.

- house-rules.md: the rules every position gets in its prompt. Edit freely.
- <company>/company.json: the company's name and folders.
- <company>/positions/<id>/position.json: one position (name, remit, who it reports to, powers, duties).
  Helm re-checks a hand edit when you save. If it does not pass, the last good version stays in force and
  Team view says why. position.json.v<N> are the last versions Helm wrote.
- <company>/positions/<id>/brief.md: the job description. notebook.md: the position's memory.
- <company>/positions/<id>/work/: the position's drafts and outputs.
- <company>/*.jsonl: append-only logs (proposals, asks, access grants, inbox, duty runs).
- <company>/retired/: retired positions, unchanged.

Helm never runs git here and never pushes anything from here. Back it up however you like.
`;

function createTeamStore(opts = {}) {
  const root = path.resolve(opts.root || defaultTeamRoot());
  const now = opts.now || Date.now;
  const iso = () => new Date(now()).toISOString();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  // caches: file -> state. Positions: cid -> Map(pid -> { sig, inForce, errors, usingVersion })
  const companyCache = new Map(); // cid -> { sig, inForce, errors, usingVersion }
  const posCache = new Map();
  const textCache = new Map();    // file -> { sig, good, errors }
  const chatsCache = new Map();   // file -> { sig, good, errors }
  const logSig = new Map();       // file -> sig after our own append (watch echo suppression)
  const held = new Set();         // lock dirs this process holds (re-entrant)
  let watcher = null;
  const timers = new Map();

  const companyDir = (cid) => path.join(root, cid);
  const posDir = (cid, pid) => path.join(root, cid, 'positions', pid);
  const retiredDir = (cid, pid) => path.join(root, cid, 'retired', pid);
  const posFile = (cid, pid) => path.join(posDir(cid, pid), 'position.json');
  const logFile = (cid, log) => path.join(companyDir(cid), `${log}.jsonl`);

  function assertId(id, what) {
    const e = S.checkId(id, what);
    if (e) fail('invalid', e);
  }

  // ---------- locking ----------
  function withLock(dir, fn) {
    const key = S.pathKey(S.normPath(dir));
    if (held.has(key)) return fn();
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, '.lock');
    const deadline = Date.now() + LOCK_WAIT_MS;
    let fd;
    for (;;) {
      try { fd = fs.openSync(lock, 'wx'); break; } catch (e) {
        if (!['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        try {
          const st = fs.statSync(lock);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; }
        } catch {}
        if (Date.now() > deadline) fail('locked', `another writer holds ${S.normPath(lock)}; try again`);
        sleep(15);
      }
    }
    try { fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`); } catch {}
    try { fs.closeSync(fd); } catch {}
    held.add(key);
    try { return fn(); } finally {
      held.delete(key);
      try { fs.unlinkSync(lock); } catch {}
    }
  }

  // ---------- versioned JSON ----------
  function versionNumbers(file) {
    const dir = path.dirname(file), base = path.basename(file) + '.v';
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    return names.filter((n) => n.startsWith(base) && /^\d+$/.test(n.slice(base.length)))
      .map((n) => Number(n.slice(base.length))).sort((a, b) => a - b);
  }

  function writeVersioned(file, value) {
    const text = json(value);
    writeAtomic(`${file}.v${value.version}`, text);
    writeAtomic(file, text);
    const all = versionNumbers(file);
    for (const n of all.slice(0, Math.max(0, all.length - S.LIMITS.keepVersions))) {
      try { fs.unlinkSync(`${file}.v${n}`); } catch {}
    }
  }

  // newest written copy that validates (used when the live file is broken and nothing is in force yet)
  function fallbackVersion(file, validate) {
    for (const n of versionNumbers(file).reverse()) {
      const r = readParsed(`${file}.v${n}`);
      if (!r.ok) continue;
      const v = validate(r.value);
      if (v.ok) return { n, value: v.value };
    }
    return null;
  }

  // ---------- root ----------
  function checkRoot() { return checkTeamRoot(root, { companies: listCompanies() }); }

  function ensureRoot() {
    const c = checkTeamRoot(root, { companies: fs.existsSync(root) ? listCompanies() : [] });
    if (!c.ok) fail('root', c.reason);
    fs.mkdirSync(root, { recursive: true });
    const readme = path.join(root, 'README.md');
    if (!fs.existsSync(readme)) writeAtomic(readme, README);
    const rules = path.join(root, 'house-rules.md');
    if (!fs.existsSync(rules)) {
      const def = defaultHouseRules();
      if (def) writeAtomic(rules, def);
    }
    return { root: S.normPath(root) };
  }

  function defaultHouseRules() {
    if (typeof opts.houseRulesDefault === 'string') return opts.houseRulesDefault;
    const r = readTextFile(path.join(__dirname, 'house-rules.default.md'));
    return r.ok ? r.text : '';
  }

  // house-rules.md as the owner last left it (last good: non-empty text under the brief cap), else the shipped default.
  function houseRules() {
    const file = path.join(root, 'house-rules.md');
    const r = readValidatedText(file, (t) => {
      const v = S.validateBrief(t);
      return v.ok ? v : { ...v, errors: v.errors.map((e) => e.replace('brief.md', 'house-rules.md')) };
    });
    return { text: r.text != null ? r.text : defaultHouseRules(), ok: r.ok, errors: r.errors, fromDefault: r.text == null };
  }

  // ---------- companies ----------
  function companyIds() {
    let ents = [];
    try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
    return ents.filter((d) => d.isDirectory() && !d.name.startsWith('.') && !S.checkId(d.name) && fs.existsSync(path.join(root, d.name, 'company.json')))
      .map((d) => d.name).sort();
  }

  function validateCompanyFile(cid) {
    return (raw) => {
      const v = S.validateCompany(raw);
      if (v.ok && v.value.id !== cid) return { ok: false, errors: [`id: the file says "${v.value.id}" but its folder is "${cid}" (ids never change)`], value: null };
      return v;
    };
  }

  function loadCompanies() {
    const ids = companyIds();
    const changed = [];
    for (const cid of ids) {
      const file = path.join(companyDir(cid), 'company.json');
      const sig = sigOf(file);
      const e = companyCache.get(cid);
      if (e && e.sig === sig) continue;
      const r = readParsed(file);
      const v = r.ok ? validateCompanyFile(cid)(r.value) : r;
      const next = { sig, inForce: e ? e.inForce : null, errors: null, usingVersion: null, pending: null };
      if (v.ok) { next.pending = v.value; changed.push(cid); }
      else {
        next.errors = v.errors;
        if (!next.inForce) {
          const fb = fallbackVersion(file, validateCompanyFile(cid));
          if (fb) { next.inForce = fb.value; next.usingVersion = fb.n; }
        }
      }
      companyCache.set(cid, next);
    }
    for (const cid of [...companyCache.keys()]) if (!ids.includes(cid)) companyCache.delete(cid);
    // a hand edit that makes two companies share a folder (or wraps the team root) is refused
    for (const cid of changed) {
      const e = companyCache.get(cid);
      const errs = [];
      for (const [other, o] of companyCache) {
        if (other === cid) continue;
        const of = o.inForce || o.pending;
        if (!of) continue;
        for (const f of e.pending.folders) for (const g of of.folders) if (S.foldersOverlap(f, g)) errs.push(`folders: ${f} overlaps ${of.name}'s folder ${g} (a folder belongs to one company)`);
      }
      for (const f of e.pending.folders) if (S.foldersOverlap(f, root)) errs.push(`folders: ${f} overlaps the team root ${S.normPath(root)}`);
      if (errs.length && e.inForce) { e.errors = errs; e.pending = null; }
      else { e.inForce = e.pending; e.pending = null; e.errors = errs.length ? errs : null; e.usingVersion = null; }
    }
  }

  function listCompanies() {
    loadCompanies();
    return [...companyCache.values()].map((e) => e.inForce).filter(Boolean);
  }

  function getCompany(cid) {
    loadCompanies();
    const e = companyCache.get(cid);
    return e ? e.inForce : null;
  }

  function mustCompany(cid) {
    const c = getCompany(cid);
    if (!c) fail('not-found', `no company "${cid}" in ${S.normPath(root)}`);
    return c;
  }

  function folderClashes(folders, exceptCid) {
    const errs = [];
    for (const c of listCompanies()) {
      if (c.id === exceptCid) continue;
      for (const f of folders) for (const g of c.folders) if (S.foldersOverlap(f, g)) errs.push(`folders: ${f} overlaps ${c.name}'s folder ${g} (a folder belongs to one company)`);
    }
    for (const f of folders) if (S.foldersOverlap(f, root)) errs.push(`folders: ${f} overlaps the team root ${S.normPath(root)}`);
    return errs;
  }

  function createCompany(draft, { createdBy } = {}) {
    ensureRoot();
    return withLock(root, () => {
      const v = S.validateCompany({ ...draft, version: 1, createdAt: (draft && draft.createdAt) || iso(), ...(createdBy ? { createdBy } : {}) });
      if (!v.ok) fail('invalid', `company draft is not valid: ${v.errors.join('; ')}`, v.errors);
      const cid = v.value.id;
      if (fs.existsSync(companyDir(cid))) fail('exists', `a company folder "${cid}" already exists in the team root`);
      const clash = folderClashes(v.value.folders, null);
      if (clash.length) fail('invalid', clash.join('; '), clash);
      fs.mkdirSync(path.join(companyDir(cid), 'positions'), { recursive: true });
      fs.mkdirSync(path.join(companyDir(cid), 'retired'), { recursive: true });
      const file = path.join(companyDir(cid), 'company.json');
      writeVersioned(file, v.value);
      companyCache.set(cid, { sig: sigOf(file), inForce: v.value, errors: null, usingVersion: null, pending: null });
      return v.value;
    });
  }

  function updateCompany(cid, patch, { expectVersion } = {}) {
    assertId(cid, 'company');
    return withLock(root, () => {
      const cur = mustCompany(cid);
      const e = companyCache.get(cid);
      if (e.errors) fail('invalid', `company.json has a hand edit that does not validate (${e.errors.join('; ')}); fix it first`, e.errors);
      if (expectVersion != null && cur.version !== expectVersion) fail('conflict', `company "${cid}" is at version ${cur.version}, not ${expectVersion}`);
      const next = typeof patch === 'function' ? patch(JSON.parse(JSON.stringify(cur))) : { ...cur, ...patch };
      if (next.id !== undefined && next.id !== cid) fail('invalid', 'id: a company id never changes');
      const v = S.validateCompany({ ...next, id: cid, createdAt: cur.createdAt, createdBy: cur.createdBy, version: cur.version + 1 });
      if (!v.ok) fail('invalid', `company edit is not valid: ${v.errors.join('; ')}`, v.errors);
      const clash = folderClashes(v.value.folders, cid);
      if (clash.length) fail('invalid', clash.join('; '), clash);
      const file = path.join(companyDir(cid), 'company.json');
      writeVersioned(file, v.value);
      companyCache.set(cid, { sig: sigOf(file), inForce: v.value, errors: null, usingVersion: null, pending: null });
      return v.value;
    });
  }

  // ---------- positions ----------
  function validatePositionFile(pid) {
    return (raw) => {
      const v = S.validatePosition(raw);
      if (v.ok && v.value.id !== pid) return { ok: false, errors: [`id: the file says "${v.value.id}" but its folder is "${pid}" (ids never change)`], value: null };
      return v;
    };
  }

  function livePids(cid) {
    let ents = [];
    try { ents = fs.readdirSync(path.join(companyDir(cid), 'positions'), { withFileTypes: true }); } catch { return []; }
    return ents.filter((d) => d.isDirectory() && !d.name.startsWith('.') && !S.checkId(d.name)).map((d) => d.name).sort();
  }

  function retiredPids(cid) {
    let ents = [];
    try { ents = fs.readdirSync(path.join(companyDir(cid), 'retired'), { withFileTypes: true }); } catch { return []; }
    return ents.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort();
  }

  // Re-read changed position.json files; accept the valid ones unless they break the tree; keep last good otherwise.
  function loadPositions(cid) {
    let st = posCache.get(cid);
    if (!st) { st = new Map(); posCache.set(cid, st); }
    const pids = livePids(cid);
    const changed = new Set();
    for (const pid of pids) {
      const file = posFile(cid, pid);
      const sig = sigOf(file);
      const e = st.get(pid);
      if (e && e.sig === sig) continue;
      const r = readParsed(file);
      const v = r.ok ? validatePositionFile(pid)(r.value) : r;
      const next = { sig, inForce: e ? e.inForce : null, errors: null, usingVersion: null, pending: null };
      if (v.ok) { next.pending = v.value; changed.add(pid); }
      else {
        next.errors = v.errors;
        if (!next.inForce) {
          const fb = fallbackVersion(file, validatePositionFile(pid));
          if (fb) { next.inForce = fb.value; next.usingVersion = fb.n; }
        }
      }
      st.set(pid, next);
    }
    for (const pid of [...st.keys()]) if (!pids.includes(pid)) st.delete(pid);
    if (!changed.size) return st;
    // tree check: a changed file that causes a cycle, a dangling parent or a broken cap is reverted to its last good
    for (let round = 0; round < 4 && changed.size; round++) {
      const values = [...st.entries()].map(([pid, e]) => (changed.has(pid) ? e.pending : e.inForce)).filter(Boolean);
      const t = createTree(values);
      const blame = new Map(); // pid -> [reasons]
      for (const pr of t.problems()) {
        const suspects = pr.id == null ? [...changed] : [pr.id, ...t.ancestors(pr.id), ...t.reports(pr.id)];
        for (const s of suspects) {
          if (!changed.has(s)) continue;
          if (!blame.has(s)) blame.set(s, []);
          blame.get(s).push(pr.reason);
        }
      }
      const revert = [...blame.keys()].filter((pid) => st.get(pid).inForce);
      if (!revert.length) {
        for (const pid of changed) {
          const e = st.get(pid);
          e.inForce = e.pending; e.pending = null; e.usingVersion = null;
          e.errors = blame.has(pid) ? blame.get(pid) : null; // nothing to fall back to: in force, with the problem shown
        }
        changed.clear();
        break;
      }
      for (const pid of revert) {
        const e = st.get(pid);
        e.errors = [...new Set(blame.get(pid))];
        e.pending = null;
        changed.delete(pid);
      }
    }
    for (const pid of changed) { const e = st.get(pid); e.inForce = e.pending; e.pending = null; e.errors = null; e.usingVersion = null; }
    return st;
  }

  function readRetired(cid, pid) {
    const r = readParsed(path.join(retiredDir(cid, pid), 'position.json'));
    if (!r.ok || !r.value || typeof r.value !== 'object') return { id: pid, name: pid, status: 'retired', parent: null, remit: '' };
    return { ...r.value, status: 'retired' };
  }

  function listPositions(cid, { retired = false } = {}) {
    const st = loadPositions(cid);
    const live = [...st.values()].map((e) => e.inForce).filter(Boolean);
    if (!retired) return live.filter((p) => p.status !== 'retired');
    const ids = new Set(live.map((p) => p.id));
    return [...live, ...retiredPids(cid).filter((pid) => !ids.has(pid)).map((pid) => readRetired(cid, pid))];
  }

  function getPosition(cid, pid) {
    if (S.checkId(pid)) return null;
    const e = loadPositions(cid).get(pid);
    if (e && e.inForce) return e.inForce;
    return fs.existsSync(path.join(retiredDir(cid, pid), 'position.json')) ? readRetired(cid, pid) : null;
  }

  function takenIds(cid) {
    return new Set([...livePids(cid), ...retiredPids(cid)]);
  }

  function tree(cid) { return createTree(listPositions(cid)); }

  function workspaceOf(cid, pid) {
    const live = posDir(cid, pid);
    if (!fs.existsSync(live) && fs.existsSync(retiredDir(cid, pid))) return S.normPath(retiredDir(cid, pid));
    return S.normPath(live);
  }

  function powersCtx(cid) {
    const c = getCompany(cid);
    return { companyFolders: c ? c.folders : [], workspaceOf: (pid) => S.normPath(posDir(cid, pid)) };
  }

  function effectivePowers(cid, pid) { return tree(cid).effective(pid, powersCtx(cid)); }

  function positionErrors(cid, pid) {
    const e = loadPositions(cid).get(pid);
    return e && e.errors ? e.errors : null;
  }

  function seedNotebook(name, seed, by) {
    let nb = S.notebookTemplate(name);
    const notes = seed && typeof seed.notes === 'string' ? seed.notes.trim() : '';
    if (notes) {
      const day = iso().slice(0, 10);
      const block = notes.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim())
        .map((l) => (/^\s*[-*] /.test(l) ? l : `- ${l}`)).join('\n');
      nb = nb.replace('## Facts\n', `## Facts\n(seeded by ${by || 'the proposer'}, ${day})\n${S.capText(block, S.LIMITS.logTextMax)}\n`);
    }
    return nb;
  }

  // 6.5 step 1: the folder with position.json (version 1), brief.md, notebook.md, chats.json [] and work/drafts/.
  // Built in a hidden temp folder and renamed into place, so a crash never leaves half a position.
  function createPosition(cid, draft, { brief, seed, createdBy } = {}) {
    assertId(cid, 'company');
    return withLock(companyDir(cid), () => {
      const company = mustCompany(cid);
      const v = S.validatePosition({ ...draft, status: (draft && draft.status) || 'active' }, { draft: true });
      if (!v.ok) fail('invalid', `position draft is not valid: ${v.errors.join('; ')}`, v.errors);
      if (v.value.status === 'retired') fail('invalid', 'status: a new position cannot start retired');
      const b = S.validateBrief(brief);
      if (!b.ok) fail('invalid', b.errors.join('; '), b.errors);
      if (v.value.scope.kind === 'product' && !company.folders.some((f) => S.isUnder(v.value.scope.folder, f))) {
        fail('invalid', `scope.folder: ${v.value.scope.folder} is not inside ${company.name}'s folders`);
      }
      const st = loadPositions(cid);
      for (const [pid, e] of st) if (e.errors && !e.inForce) fail('invalid', `positions/${pid}/position.json does not validate and has no good version (${e.errors.join('; ')}); fix it first`, e.errors);
      const t = createTree([...st.values()].map((e) => e.inForce).filter(Boolean));
      const terr = t.checkCreate({ id: v.value.id, parent: v.value.parent }, { taken: takenIds(cid) });
      if (terr.length) fail('tree', terr.join('; '), terr);
      const pid = v.value.id;
      const value = { ...v.value, version: 1, createdAt: iso(), ...(createdBy ? { createdBy } : {}) };
      const tmp = path.join(companyDir(cid), 'positions', `.new-${pid}-${crypto.randomBytes(3).toString('hex')}`);
      try {
        fs.mkdirSync(path.join(tmp, 'work', 'drafts'), { recursive: true });
        writeAtomic(path.join(tmp, 'brief.md'), b.value.endsWith('\n') ? b.value : b.value + '\n');
        writeAtomic(path.join(tmp, 'notebook.md'), seedNotebook(value.name, seed, createdBy && (createdBy.by || createdBy.proposer)));
        writeAtomic(path.join(tmp, 'chats.json'), json([]));
        writeVersioned(path.join(tmp, 'position.json'), value);
        const r = renameRetry(tmp, posDir(cid, pid));
        if (r !== true) throw r;
      } catch (e) {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
        if (e instanceof TeamStoreError) throw e;
        fail('invalid', `could not create positions/${pid}: ${e.message}`);
      }
      st.set(pid, { sig: sigOf(posFile(cid, pid)), inForce: value, errors: null, usingVersion: null, pending: null });
      return value;
    });
  }

  // patch: an object merged over the current value, or fn(current) -> next. id, createdAt, createdBy and version are
  // Helm's. A parent change is a re-parent (tree checks); status 'retired' only through retirePosition.
  function updatePosition(cid, pid, patch, { expectVersion } = {}) {
    return updateInner(cid, pid, patch, { expectVersion }, {});
  }

  // planned: the caller (retirePosition) already checked the whole plan, so per-step tree caps are skipped.
  function updateInner(cid, pid, patch, { expectVersion } = {}, { allowRetired = false, planned = false } = {}) {
    assertId(cid, 'company');
    assertId(pid, 'position');
    return withLock(companyDir(cid), () => {
      mustCompany(cid);
      const st = loadPositions(cid);
      const e = st.get(pid);
      if (!e || !e.inForce) fail('not-found', `no live position "${pid}" in ${cid}`);
      if (e.errors) fail('invalid', `positions/${pid}/position.json has a hand edit that does not pass (${e.errors.join('; ')}); fix it first`, e.errors);
      const cur = e.inForce;
      if (cur.status === 'retired' && !allowRetired) fail('not-found', `"${pid}" is retired`);
      if (expectVersion != null && cur.version !== expectVersion) fail('conflict', `"${pid}" is at version ${cur.version}, not ${expectVersion} (it changed meanwhile)`);
      const next = typeof patch === 'function' ? patch(JSON.parse(JSON.stringify(cur))) : { ...cur, ...patch };
      if (!next || typeof next !== 'object') fail('invalid', 'the edit produced no position');
      if (next.id !== undefined && next.id !== pid) fail('invalid', 'id: a position id never changes');
      if (next.status === 'retired' && cur.status !== 'retired' && !allowRetired) fail('invalid', 'status: retire through retirePosition (it moves reports and the folder)');
      const v = validatePositionFile(pid)({ ...next, id: pid, createdAt: cur.createdAt, createdBy: cur.createdBy, version: cur.version + 1 });
      if (!v.ok) fail('invalid', `position edit is not valid: ${v.errors.join('; ')}`, v.errors);
      const newParent = v.value.parent == null ? null : v.value.parent;
      const oldParent = cur.parent == null ? null : cur.parent;
      if (newParent !== oldParent && v.value.status !== 'retired' && !planned) {
        const t = createTree([...st.values()].map((x) => x.inForce).filter(Boolean));
        const terr = t.checkReparent(pid, newParent);
        if (terr.length) fail('tree', terr.join('; '), terr);
      }
      if (v.value.scope.kind === 'product') {
        const company = getCompany(cid);
        if (!company.folders.some((f) => S.isUnder(v.value.scope.folder, f))) fail('invalid', `scope.folder: ${v.value.scope.folder} is not inside ${company.name}'s folders`);
      }
      writeVersioned(posFile(cid, pid), v.value);
      st.set(pid, { sig: sigOf(posFile(cid, pid)), inForce: v.value, errors: null, usingVersion: null, pending: null });
      return v.value;
    });
  }

  // 6.4: retire; a manager's reports move up to its manager (move-up, default) or retire with it (retire-too).
  // openTickets(pid) -> count of open tickets to or from pid (the runtime's); any > 0 refuses with 'busy'.
  // -> { retired: [ids], moved: [{ id, from, to }], pendingMove: [ids] (folder still in positions/: Windows held it) }
  function retirePosition(cid, pid, { mode = 'move-up', openTickets } = {}) {
    assertId(cid, 'company');
    assertId(pid, 'position');
    return withLock(companyDir(cid), () => {
      mustCompany(cid);
      const t = tree(cid);
      if (!t.has(pid)) fail('not-found', `no live position "${pid}" in ${cid}`);
      const plan = t.planRetire(pid, mode);
      if (!plan.ok) fail('tree', plan.errors.join('; '), plan.errors);
      if (typeof openTickets === 'function') {
        const busy = plan.retire.filter((id) => (openTickets(id) || 0) > 0);
        if (busy.length) fail('busy', `open tickets to or from ${busy.join(', ')}; let them settle (or cancel them) first`);
      }
      const bad = [...plan.retire, ...plan.moves.map((m) => m.id)].filter((id) => positionErrors(cid, id));
      if (bad.length) fail('invalid', `fix the hand edits of ${bad.join(', ')} first`);
      for (const m of plan.moves) updateInner(cid, m.id, { parent: m.to }, {}, { planned: true });
      const at = iso();
      for (const id of plan.retire) updateInner(cid, id, (p) => ({ ...p, status: 'retired', retiredAt: at }), {}, { allowRetired: true, planned: true });
      const pendingMove = [];
      for (const id of plan.retire) if (!moveToRetired(cid, id)) pendingMove.push(id);
      return { retired: plan.retire, moved: plan.moves, pendingMove };
    });
  }

  function moveToRetired(cid, pid) {
    fs.mkdirSync(path.join(companyDir(cid), 'retired'), { recursive: true });
    if (fs.existsSync(retiredDir(cid, pid))) return false;
    const r = renameRetry(posDir(cid, pid), retiredDir(cid, pid));
    if (r !== true) return false;
    const st = posCache.get(cid);
    if (st) st.delete(pid);
    for (const k of [...textCache.keys(), ...chatsCache.keys()]) if (S.isUnder(k, posDir(cid, pid))) { textCache.delete(k); chatsCache.delete(k); }
    return true;
  }

  // Move positions marked retired (by Helm while Windows held the folder, or by a hand edit) into retired/.
  function sweepRetired(cid) {
    return withLock(companyDir(cid), () => {
      const moved = [];
      for (const [pid, e] of loadPositions(cid)) if (e.inForce && e.inForce.status === 'retired' && moveToRetired(cid, pid)) moved.push(pid);
      return moved;
    });
  }

  function versions(cid, pid) { return versionNumbers(posFile(cid, pid)); }
  function readVersion(cid, pid, n) {
    const r = readParsed(`${posFile(cid, pid)}.v${n}`);
    return r.ok ? r.value : null;
  }

  // ---------- brief.md / notebook.md ----------
  function readValidatedText(file, validate) {
    const sig = sigOf(file);
    let e = textCache.get(file);
    if (e && e.sig === sig) return { text: e.good, ok: !e.errors, errors: e.errors };
    const r = readTextFile(file);
    const v = r.ok ? validate(r.text) : r;
    e = { sig, good: e ? e.good : null, errors: null };
    if (v.ok) e.good = v.value; else e.errors = v.errors;
    textCache.set(file, e);
    return { text: e.good, ok: !e.errors, errors: e.errors };
  }

  function fileOf(cid, pid, name) {
    assertId(cid, 'company'); assertId(pid, 'position');
    const live = path.join(posDir(cid, pid), name);
    if (fs.existsSync(posDir(cid, pid))) return live;
    const ret = path.join(retiredDir(cid, pid), name);
    if (fs.existsSync(retiredDir(cid, pid))) return ret;
    fail('not-found', `no position "${pid}" in ${cid}`);
  }

  // -> { text (last good, or null), ok, errors }
  const readBrief = (cid, pid) => readValidatedText(fileOf(cid, pid, 'brief.md'), S.validateBrief);
  const readNotebook = (cid, pid) => readValidatedText(fileOf(cid, pid, 'notebook.md'), S.validateNotebook);

  function writeText(cid, pid, name, text, validate, { expectText } = {}) {
    return withLock(companyDir(cid), () => {
      const file = fileOf(cid, pid, name);
      const v = validate(text);
      if (!v.ok) fail('invalid', v.errors.join('; '), v.errors);
      if (expectText !== undefined) {
        const cur = readTextFile(file);
        if ((cur.ok ? cur.text : null) !== expectText) fail('conflict', `${name} changed meanwhile`);
      }
      writeAtomic(file, v.value);
      textCache.set(file, { sig: sigOf(file), good: v.value, errors: null });
      return v.value;
    });
  }
  const writeBrief = (cid, pid, text, o) => writeText(cid, pid, 'brief.md', text, S.validateBrief, o);
  const writeNotebook = (cid, pid, text, o) => writeText(cid, pid, 'notebook.md', text, S.validateNotebook, o);

  // notebook_add: one dated entry at the end of `section` (the heading is put back if a hand edit removed it).
  // The Log keeps its newest 200 lines; older ones move to notebook-log-archive.md.
  // -> { section, entry, archived: n }
  function notebookAdd(cid, pid, section, text) {
    if (!S.NOTEBOOK_SECTIONS.includes(section)) fail('invalid', `section: must be one of ${S.NOTEBOOK_SECTIONS.join(', ')}`);
    const body = String(text == null ? '' : text).trim();
    if (!body) fail('invalid', 'text: empty');
    if (body.length > NOTE_MAX) fail('invalid', `text: at most ${NOTE_MAX} characters per entry`);
    return withLock(companyDir(cid), () => {
      const file = fileOf(cid, pid, 'notebook.md');
      const cur = readNotebook(cid, pid);
      if (!cur.ok && cur.text == null) {
        if (!readTextFile(file).missing) fail('invalid', `notebook.md does not pass (${cur.errors.join('; ')}); fix it first`, cur.errors);
      } else if (!cur.ok) fail('invalid', `notebook.md does not pass (${cur.errors.join('; ')}); fix it first`, cur.errors);
      const p = getPosition(cid, pid);
      let nb = cur.text != null ? cur.text : S.notebookTemplate(p ? p.name : pid);
      const day = iso().slice(0, 10);
      const lines = body.split(/\r?\n/);
      const first = section === 'Open items' ? `- [ ] ${lines[0]} (${day})` : `- ${day}: ${lines[0]}`;
      const entry = [first, ...lines.slice(1).map((l) => (l.trim() ? `  ${l}` : ''))].join('\n');
      nb = insertUnder(nb, section, entry);
      let archived = 0;
      if (section === 'Log') {
        const r = trimLog(nb);
        if (r.moved.length) {
          const arch = path.join(path.dirname(file), 'notebook-log-archive.md');
          const old = readTextFile(arch);
          const head = old.ok ? old.text.replace(/\s*$/, '\n') : `# ${p ? p.name : pid} · notebook log archive\n`;
          writeAtomic(arch, head + r.moved.join('\n') + '\n');
          archived = r.moved.length;
          nb = r.text;
        }
      }
      const v = S.validateNotebook(nb);
      if (!v.ok) fail('invalid', v.errors.join('; '), v.errors);
      writeAtomic(file, nb);
      textCache.set(file, { sig: sigOf(file), good: nb, errors: null });
      return { section, entry, archived };
    });
  }

  const headingRe = (name) => new RegExp(`^##[ \\t]+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'im');

  function insertUnder(nb, section, entry) {
    const lines = nb.replace(/\r\n/g, '\n').split('\n');
    const isHead = (l) => /^##[ \t]+\S/.test(l);
    let h = lines.findIndex((l) => headingRe(section).test(l));
    if (h < 0) {
      // put the heading back where it belongs: before the next canonical section that is present, else at the end
      const later = S.NOTEBOOK_SECTIONS.slice(S.NOTEBOOK_SECTIONS.indexOf(section) + 1);
      let at = lines.length;
      for (const s of later) { const i = lines.findIndex((l) => headingRe(s).test(l)); if (i >= 0) { at = i; break; } }
      while (at === lines.length && at > 0 && lines[at - 1] === '') { lines.pop(); at = lines.length; }
      lines.splice(at, 0, `## ${section}`);
      h = at;
    }
    let end = h + 1;
    while (end < lines.length && !isHead(lines[end])) end++;
    let ins = end;
    while (ins > h + 1 && lines[ins - 1].trim() === '') ins--;
    lines.splice(ins, 0, entry);
    let out = lines.join('\n');
    if (!out.endsWith('\n')) out += '\n';
    return out;
  }

  function trimLog(nb) {
    const lines = nb.split('\n');
    const h = lines.findIndex((l) => headingRe('Log').test(l));
    if (h < 0) return { text: nb, moved: [] };
    let end = h + 1;
    while (end < lines.length && !/^##[ \t]+\S/.test(lines[end])) end++;
    const idx = [];
    for (let i = h + 1; i < end; i++) if (lines[i].trim()) idx.push(i);
    const over = idx.length - S.LIMITS.notebookLogLines;
    if (over <= 0) return { text: nb, moved: [] };
    const drop = new Set(idx.slice(0, over));
    return { text: lines.filter((_, i) => !drop.has(i)).join('\n'), moved: idx.slice(0, over).map((i) => lines[i]) };
  }

  // ---------- chats.json ----------
  function readChats(cid, pid) {
    const file = fileOf(cid, pid, 'chats.json');
    const sig = sigOf(file);
    let e = chatsCache.get(file);
    if (e && e.sig === sig) return { chats: e.good || [], ok: !e.errors, errors: e.errors };
    const r = readParsed(file);
    const v = r.ok ? S.validateChats(r.value) : (r.missing ? { ok: true, value: [] } : r);
    e = { sig, good: e ? e.good : null, errors: null };
    if (v.ok) e.good = v.value; else e.errors = v.errors;
    chatsCache.set(file, e);
    return { chats: e.good || [], ok: !e.errors, errors: e.errors };
  }

  function writeChats(cid, pid, list) {
    return withLock(companyDir(cid), () => {
      const file = fileOf(cid, pid, 'chats.json');
      const v = S.validateChats(list);
      if (!v.ok) fail('invalid', v.errors.join('; '), v.errors);
      writeAtomic(file, json(v.value));
      chatsCache.set(file, { sig: sigOf(file), good: v.value, errors: null });
      return v.value;
    });
  }

  function chatsForWrite(cid, pid) {
    const r = readChats(cid, pid);
    if (!r.ok) fail('invalid', `chats.json does not pass (${r.errors.join('; ')}); fix it first`, r.errors);
    return r.chats.map((c) => ({ ...c }));
  }

  // -> the new entry ({ n: last + 1, startedAt: now, ...entry })
  function addChat(cid, pid, entry = {}) {
    return withLock(companyDir(cid), () => {
      const list = chatsForWrite(cid, pid);
      const n = list.length ? list[list.length - 1].n + 1 : 1;
      const c = { n, helmSessionId: null, claudeSessionId: null, startedAt: iso(), ...entry, n };
      writeChats(cid, pid, [...list, c]);
      return c;
    });
  }

  function updateChat(cid, pid, n, patch) {
    return withLock(companyDir(cid), () => {
      const list = chatsForWrite(cid, pid);
      const i = list.findIndex((c) => c.n === n);
      if (i < 0) fail('not-found', `no chat ${n} for "${pid}"`);
      const next = typeof patch === 'function' ? patch({ ...list[i] }) : { ...list[i], ...patch };
      list[i] = { ...next, n };
      if (typeof list[i].handoff === 'string') list[i].handoff = S.capText(list[i].handoff);
      writeChats(cid, pid, list);
      return list[i];
    });
  }

  // ---------- JSONL logs ----------
  function append(cid, log, obj) {
    if (!LOGS.includes(log)) fail('invalid', `log: must be one of ${LOGS.join(', ')}`);
    assertId(cid, 'company');
    if (!fs.existsSync(companyDir(cid))) fail('not-found', `no company "${cid}"`);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail('invalid', 'a log line must be an object');
    const line = S.capStrings({ at: iso(), ...obj });
    const text = JSON.stringify(line);
    const file = logFile(cid, log);
    let lead = '';
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        if (size > 0) {
          const b = Buffer.alloc(1);
          fs.readSync(fd, b, 0, 1, size - 1);
          if (b[0] !== 0x0a) lead = '\n'; // a torn last line (crash mid-write, or a hand edit): fence it off
        }
      } finally { fs.closeSync(fd); }
    } catch {}
    fs.appendFileSync(file, lead + text + '\n', 'utf8'); // one write: O_APPEND keeps concurrent lines whole
    logSig.set(file, sigOf(file));
    return line;
  }

  // -> { lines: [objects, oldest first], bad: n }. since: ISO string or ms (lines with at >= since).
  // filter(line) -> bool. limit: the newest N after filtering.
  function readLog(cid, log, { since, limit, filter } = {}) {
    if (!LOGS.includes(log)) fail('invalid', `log: must be one of ${LOGS.join(', ')}`);
    assertId(cid, 'company');
    let text = '';
    try { text = fs.readFileSync(logFile(cid, log), 'utf8'); } catch { return { lines: [], bad: 0 }; }
    const sinceMs = since == null ? null : typeof since === 'number' ? since : Date.parse(since);
    let bad = 0;
    const out = [];
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      let o;
      try { o = JSON.parse(raw); } catch { bad++; continue; }
      if (!o || typeof o !== 'object') { bad++; continue; }
      if (sinceMs != null && !(Date.parse(o.at) >= sinceMs)) continue;
      if (filter && !filter(o)) continue;
      out.push(o);
    }
    return { lines: limit != null && limit >= 0 ? out.slice(Math.max(0, out.length - limit)) : out, bad };
  }

  // ---------- problems ----------
  function problems(cidOrNull) {
    loadCompanies();
    const out = [];
    for (const [cid, e] of companyCache) {
      if (cidOrNull && cid !== cidOrNull) continue;
      if (e.errors) out.push({ company: cid, file: `${cid}/company.json`, errors: e.errors, ...(e.usingVersion ? { usingVersion: e.usingVersion } : {}), inForce: !!e.inForce });
      for (const [pid, p] of loadPositions(cid)) {
        if (p.errors) out.push({ company: cid, position: pid, file: `${cid}/positions/${pid}/position.json`, errors: p.errors, ...(p.usingVersion ? { usingVersion: p.usingVersion } : {}), inForce: !!p.inForce });
        for (const [name, read] of [['brief.md', readBrief], ['notebook.md', readNotebook], ['chats.json', null]]) {
          const r = read ? read(cid, pid) : readChats(cid, pid);
          if (!r.ok) out.push({ company: cid, position: pid, file: `${cid}/positions/${pid}/${name}`, errors: r.errors, inForce: read ? r.text != null : true });
        }
      }
    }
    return out;
  }

  // ---------- fs.watch ----------
  function classify(rel) {
    const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
    if (!parts.length) return null;
    const base = parts[parts.length - 1];
    if (base === '.lock' || base.endsWith('.tmp') || /\.v\d+$/.test(base) || parts.some((p) => p.startsWith('.new-'))) return null;
    if (parts.length === 1 && base === 'house-rules.md') return { kind: 'house-rules', file: path.join(root, base) };
    const cid = parts[0];
    if (S.checkId(cid)) return null;
    if (parts.length === 2 && base === 'company.json') return { kind: 'company', company: cid };
    if (parts.length === 2 && base.endsWith('.jsonl') && LOGS.includes(base.slice(0, -6))) return { kind: 'log', company: cid, log: base.slice(0, -6) };
    if (parts.length === 4 && parts[1] === 'positions' && !S.checkId(parts[2])) {
      const pid = parts[2];
      if (base === 'position.json') return { kind: 'position', company: cid, position: pid };
      if (base === 'brief.md') return { kind: 'brief', company: cid, position: pid };
      if (base === 'notebook.md') return { kind: 'notebook', company: cid, position: pid };
      if (base === 'chats.json') return { kind: 'chats', company: cid, position: pid };
    }
    if (parts.length >= 2 && parts[1] === 'positions' && parts.length <= 3) return { kind: 'roster', company: cid }; // folder added / removed
    return null;
  }

  function onWatched(c) {
    const emit = (ev) => { try { emitter.emit('change', { source: 'external', ...ev }); } catch {} };
    try {
      if (c.kind === 'house-rules') {
        const before = textCache.get(c.file);
        const prev = before ? before.good : null, prevErr = before ? before.errors : null;
        const r = houseRules();
        if (r.text !== prev || JSON.stringify(r.errors) !== JSON.stringify(prevErr)) emit({ kind: 'house-rules', file: 'house-rules.md', ok: r.ok, errors: r.errors, text: r.text, prev });
      } else if (c.kind === 'company') {
        const before = companyCache.get(c.company);
        const prev = before ? before.inForce : null, prevErr = before ? before.errors : null;
        loadCompanies();
        const e = companyCache.get(c.company);
        const value = e ? e.inForce : null, errors = e ? e.errors : null;
        if (value !== prev || JSON.stringify(errors) !== JSON.stringify(prevErr)) emit({ kind: 'company', company: c.company, file: `${c.company}/company.json`, ok: !errors, errors, value });
      } else if (c.kind === 'position' || c.kind === 'roster') {
        const st0 = posCache.get(c.company) || new Map();
        const snap = new Map([...st0].map(([k, e]) => [k, { inForce: e.inForce, errors: e.errors }]));
        const st = loadPositions(c.company);
        for (const pid of new Set([...snap.keys(), ...st.keys()])) {
          const a = snap.get(pid), b = st.get(pid);
          const va = a ? a.inForce : null, vb = b ? b.inForce : null;
          const ea = a ? a.errors : null, eb = b ? b.errors : null;
          if (va !== vb || JSON.stringify(ea) !== JSON.stringify(eb)) {
            emit({ kind: 'position', company: c.company, position: pid, file: `${c.company}/positions/${pid}/position.json`, ok: !eb, errors: eb, value: vb, prev: va, removed: !b });
          }
        }
      } else if (c.kind === 'brief' || c.kind === 'notebook') {
        const file = path.join(posDir(c.company, c.position), `${c.kind}.md`);
        if (!fs.existsSync(posDir(c.company, c.position))) return;
        const before = textCache.get(file);
        if (before && before.sig === sigOf(file)) return; // our own write
        const prev = before ? before.good : null, prevErr = before ? before.errors : null;
        const r = c.kind === 'brief' ? readBrief(c.company, c.position) : readNotebook(c.company, c.position);
        if (r.text !== prev || JSON.stringify(r.errors) !== JSON.stringify(prevErr)) {
          emit({ kind: c.kind, company: c.company, position: c.position, file: `${c.company}/positions/${c.position}/${c.kind}.md`, ok: r.ok, errors: r.errors, text: r.text, prev });
        }
      } else if (c.kind === 'chats') {
        const file = path.join(posDir(c.company, c.position), 'chats.json');
        const before = chatsCache.get(file);
        if (before && before.sig === sigOf(file)) return;
        const r = readChats(c.company, c.position);
        emit({ kind: 'chats', company: c.company, position: c.position, file: `${c.company}/positions/${c.position}/chats.json`, ok: r.ok, errors: r.errors, value: r.chats });
      } else if (c.kind === 'log') {
        const file = logFile(c.company, c.log);
        if (logSig.get(file) === sigOf(file)) return; // our own append
        emit({ kind: 'log', company: c.company, log: c.log, file: `${c.company}/${c.log}.jsonl`, ok: true });
      }
    } catch (e) {
      emit({ kind: 'error', file: c.file || null, ok: false, errors: [e.message] });
    }
  }

  function watch() {
    if (watcher) return true;
    fs.mkdirSync(root, { recursive: true });
    try {
      watcher = fs.watch(root, { recursive: true, persistent: false }, (_ev, name) => {
        if (!name) return;
        const c = classify(String(name));
        if (!c) return;
        const key = `${c.kind}|${c.company || ''}|${c.position || ''}|${c.log || ''}`;
        clearTimeout(timers.get(key));
        timers.set(key, setTimeout(() => { timers.delete(key); onWatched(c); }, WATCH_DEBOUNCE_MS));
      });
      watcher.on('error', (e) => {
        try { emitter.emit('change', { source: 'external', kind: 'error', ok: false, errors: [`watch stopped: ${e.message}`] }); } catch {}
        close();
      });
      return true;
    } catch (e) {
      watcher = null;
      return false;
    }
  }

  function close() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
  }

  return {
    root: S.normPath(root),
    LOGS,
    checkRoot, ensureRoot, houseRules,
    listCompanies, getCompany, createCompany, updateCompany, companyDir: (cid) => S.normPath(companyDir(cid)),
    listPositions, getPosition, takenIds, tree, workspaceOf, powersCtx, effectivePowers, positionErrors,
    createPosition, updatePosition, retirePosition, sweepRetired, versions, readVersion,
    readBrief, writeBrief, readNotebook, writeNotebook, notebookAdd,
    readChats, writeChats, addChat, updateChat,
    append, readLog, problems,
    watch, close,
    on: (ev, fn) => { emitter.on(ev, fn); return () => emitter.off(ev, fn); },
    off: (ev, fn) => emitter.off(ev, fn),
  };
}

module.exports = { createTeamStore, checkTeamRoot, defaultTeamRoot, TeamStoreError, LOGS, writeAtomic };
