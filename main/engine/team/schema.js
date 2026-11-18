// Positions: the shapes of the team root's files and the rules every write (and every hand edit) must pass.
// Pure: no fs writes, no state. store.js calls validate*() on every read and write; tree.js uses the path helpers
// for effective powers; the MCP layer (mcp.js) uses slugify/limits for proposals. Spec: docs/POSITIONS.md 2, 6.4, 7.1, 9.1.
//
//   validateCompany(obj)                    -> { ok, errors: [string], value }   value = normalised copy (or null)
//   validatePosition(obj, { draft })        -> { ok, errors, value }             draft: fills parent/version defaults
//   validateDuty(obj) / validatePowers(obj, { coding }) -> { ok, errors, value }
//   validateBrief(text) / validateNotebook(text) / validateChats(list) -> { ok, errors, value }
//   slugify(name, taken?)                   -> a free id ('tax', 'tax-2', ...)
//   normPath(p) / pathKey(p) / isUnder(child, parent) / foldersOverlap(a, b)
//   expandPathTokens(list, ctx)             -> absolute, normalised patterns ($workspace, $company, $scope, ~)
//   defaultPowers({ coding }) / notebookTemplate(name) / capText / capStrings
// Errors are plain sentences that start with the field ("powers.bash: must be off, readonly or on"), so Team view
// and the proposal refusal can show them as they are.
'use strict';

const os = require('os');
const path = require('path');
const { nextCronFire } = require('../schedules');

const LIMITS = Object.freeze({
  maxDepth: 5,            // CEO = 0, top-level = 1 (6.4)
  maxReports: 10,         // direct reports per manager, the CEO included (6.4)
  maxPositions: 30,       // live (active + paused) positions per company (6.4)
  idMax: 40,
  nameMax: 60,
  departmentMax: 60,      // a department name (position.json `department`, heads only)
  remitMax: 300,          // one line in a manager's roster
  briefMax: 64_000,
  notebookMax: 200_000,   // the Log is trimmed to 200 lines, so a healthy notebook stays far below this
  notebookLogLines: 200,
  logTextMax: 20_000,     // every text field in a JSONL line (2.6, like handoff.js MAX_HANDOFF_CHARS)
  maxDuties: 20,
  dutyPromptMax: 20_000,
  dutyTitleMax: 120,
  maxPathEntries: 50,     // per powers.read / powers.write
  maxTools: 60,
  keepVersions: 10,       // position.json.v<N> copies kept (2.4)
  maxFolders: 20,         // per company
  chatsMax: 10_000,
});

const ID_RE = /^[a-z0-9-]{1,40}$/;
// Windows refuses these as folder names (any case, with or without an extension).
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
const STATUSES = ['active', 'paused', 'retired'];
const LIVE_STATUSES = ['active', 'paused'];
const BASH_LEVELS = ['off', 'readonly', 'on'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const NOTEBOOK_SECTIONS = ['Decisions', 'Facts', 'Open items', 'Log'];
const PATH_TOKENS = ['$workspace', '$company', '$scope'];
// Built-in tools a position never gets (7.1). Agent / Task only with agents: true.
const NEVER_TOOLS = ['CronCreate', 'CronDelete', 'ScheduleWakeup', 'SendMessage', 'ListAgents', 'SendToProject', 'Skill'];
const AGENT_TOOLS = ['Agent', 'Task'];
const DEFAULT_TOOLS = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'TodoWrite'];
const CODING_TOOLS = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'MultiEdit', 'Bash', 'WebSearch', 'WebFetch', 'TodoWrite'];

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function checkId(id, field = 'id') {
  if (!isStr(id) || !ID_RE.test(id)) return `${field}: must be 1 to 40 of a-z, 0-9 and "-" (got ${JSON.stringify(id)})`;
  if (WIN_RESERVED.test(id)) return `${field}: "${id}" is a name Windows reserves for devices; pick another`;
  if (/^-|-$/.test(id)) return `${field}: may not start or end with "-"`;
  return null;
}

// 'Tax Specialist' -> 'tax-specialist'; a taken id gets -2, -3, ... `taken` is a Set or array of ids.
function slugify(name, taken = []) {
  const set = taken instanceof Set ? taken : new Set(taken);
  let base = String(name == null ? '' : name)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.idMax).replace(/-+$/g, '');
  if (!base) base = 'position';
  if (WIN_RESERVED.test(base)) base = `${base}-team`;
  if (!set.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = base.slice(0, LIMITS.idMax - suffix.length).replace(/-+$/g, '') + suffix;
    if (!set.has(id)) return id;
  }
}

// ---------- paths ----------
// Stored form: forward slashes, no trailing slash (except a root), '.' and '..' folded, drive letter upper case.
// Compare with pathKey(): lower case on Windows (or when caseInsensitive is forced, for tests).
let CASE_INSENSITIVE = process.platform === 'win32';
function setCaseInsensitive(v) { CASE_INSENSITIVE = !!v; } // tests only

function expandHome(p, home = os.homedir()) {
  if (p === '~') return home;
  if (/^~[\\/]/.test(p)) return home.replace(/[\\/]+$/, '') + '/' + p.slice(2);
  return p;
}

function isAbsoluteAny(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]/.test(p);
}

function normPath(p) {
  if (!isStr(p) || !p) return '';
  let s = p.replace(/\\/g, '/');
  const drive = /^[a-zA-Z]:/.test(s) ? s.slice(0, 2).toUpperCase() : '';
  if (drive) s = s.slice(2);
  const unc = !drive && s.startsWith('//');
  s = path.posix.normalize(s || '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  if (unc) s = '/' + s.replace(/^\/+/, '/');
  return drive + s;
}

function pathKey(p) {
  const n = normPath(p);
  return CASE_INSENSITIVE ? n.toLowerCase() : n;
}

// child is parent or inside it (string containment on normalised keys; no fs access).
function isUnder(child, parent) {
  const c = pathKey(child), p = pathKey(parent);
  if (!c || !p) return false;
  if (c === p) return true;
  return c.startsWith(p.endsWith('/') ? p : p + '/');
}

function foldersOverlap(a, b) { return isUnder(a, b) || isUnder(b, a); }

const hasGlob = (p) => /[*?]/.test(p);

// One powers path entry: a token, or an absolute path (or ~/...) with optional * / ** / ? globs. No '..'.
function checkPathEntry(entry, field) {
  if (!isStr(entry) || !entry.trim()) return `${field}: must be a non-empty string`;
  if (PATH_TOKENS.includes(entry)) return null;
  if (entry.startsWith('$')) return `${field}: unknown token ${JSON.stringify(entry)} (use $workspace, $company or $scope)`;
  const raw = expandHome(entry, '/home');
  if (!isAbsoluteAny(raw)) return `${field}: ${JSON.stringify(entry)} must be absolute (or a $token)`;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(entry)) return `${field}: ${JSON.stringify(entry)} may not contain ".."`;
  if (/[\x00-\x1f]/.test(entry)) return `${field}: ${JSON.stringify(entry)} has control characters`;
  return null;
}

// Expand tokens into absolute, normalised patterns.
// ctx: { workspace, companyFolders: [], scopeFolder?: string|null, home? }
// '$scope' is the scope folder, or every company folder for a company-wide position.
// A trailing '/**' means the folder itself, so it is folded to the plain folder.
function expandPathTokens(list, ctx = {}) {
  const out = [];
  const seen = new Set();
  const push = (p) => {
    let n = normPath(expandHome(p, ctx.home || os.homedir()));
    if (n.endsWith('/**') && n.length > 3) n = n.slice(0, -3) || '/';
    const k = pathKey(n);
    if (n && !seen.has(k)) { seen.add(k); out.push(n); }
  };
  for (const e of Array.isArray(list) ? list : []) {
    if (e === '$workspace') { if (ctx.workspace) push(ctx.workspace); }
    else if (e === '$company') (ctx.companyFolders || []).forEach(push);
    else if (e === '$scope') (ctx.scopeFolder ? [ctx.scopeFolder] : ctx.companyFolders || []).forEach(push);
    else if (isStr(e) && !e.startsWith('$')) push(e);
  }
  return out;
}

// ---------- text caps ----------
function capText(s, n = LIMITS.logTextMax) {
  if (!isStr(s) || s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

// Deep copy of a log object with every string capped (2.6: "Every text field stored in a log is capped").
function capStrings(v, n = LIMITS.logTextMax, depth = 0) {
  if (isStr(v)) return capText(v, n);
  if (depth > 8 || v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => capStrings(x, n, depth + 1));
  const o = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = capStrings(x, n, depth + 1);
  return o;
}

// ---------- powers (7.1) ----------
function defaultPowers({ coding = false } = {}) {
  return coding
    ? { read: ['$workspace', '$scope'], write: ['$workspace', '$scope'], tools: CODING_TOOLS.slice(), bash: 'on', agents: false, worktree: true }
    : { read: ['$workspace', '$company'], write: ['$workspace'], tools: DEFAULT_TOOLS.slice(), bash: 'off', agents: false, worktree: false };
}

function validatePowers(p, { field = 'powers' } = {}) {
  const errors = [];
  if (p === undefined || p === null) return { ok: true, errors, value: defaultPowers() };
  if (!isObj(p)) return { ok: false, errors: [`${field}: must be an object`], value: null };
  const d = defaultPowers();
  const v = { ...p };
  for (const k of ['read', 'write']) {
    if (v[k] === undefined) { v[k] = d[k]; continue; }
    if (!Array.isArray(v[k])) { errors.push(`${field}.${k}: must be a list of paths or $tokens`); continue; }
    if (v[k].length > LIMITS.maxPathEntries) errors.push(`${field}.${k}: at most ${LIMITS.maxPathEntries} entries`);
    v[k].forEach((e, i) => { const er = checkPathEntry(e, `${field}.${k}[${i}]`); if (er) errors.push(er); });
    v[k] = [...new Set(v[k])];
  }
  if (v.tools === undefined) v.tools = d.tools;
  else if (!Array.isArray(v.tools)) errors.push(`${field}.tools: must be a list of tool names`);
  else {
    if (v.tools.length > LIMITS.maxTools) errors.push(`${field}.tools: at most ${LIMITS.maxTools} tools`);
    v.tools.forEach((t, i) => {
      if (isStr(t) && t.startsWith('mcp__')) errors.push(`${field}.tools[${i}]: "${t}": connector and MCP tools are off for positions (the team tools are added by Helm)`);
      else if (!isStr(t) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(t)) errors.push(`${field}.tools[${i}]: ${JSON.stringify(t)} is not a tool name`);
      else if (NEVER_TOOLS.includes(t)) errors.push(`${field}.tools[${i}]: "${t}" is never given to a position`);
    });
    v.tools = [...new Set(v.tools)];
  }
  if (v.bash === undefined) v.bash = d.bash;
  else if (!BASH_LEVELS.includes(v.bash)) errors.push(`${field}.bash: must be off, readonly or on`);
  for (const k of ['agents', 'worktree']) {
    if (v[k] === undefined) v[k] = false;
    else if (typeof v[k] !== 'boolean') errors.push(`${field}.${k}: must be true or false`);
  }
  if (Array.isArray(v.tools) && v.agents !== true) {
    const bad = v.tools.filter((t) => AGENT_TOOLS.includes(t));
    if (bad.length) errors.push(`${field}.tools: ${bad.join(', ')} needs ${field}.agents: true`);
  }
  if (Array.isArray(v.tools) && v.bash === 'off' && (v.tools.includes('Bash') || v.tools.includes('PowerShell'))) {
    errors.push(`${field}.tools: Bash/PowerShell is listed but ${field}.bash is "off"`);
  }
  return { ok: errors.length === 0, errors, value: errors.length ? null : v };
}

// ---------- duties (9.1) ----------
function checkFolderOrScope(v, field, { allowScope }) {
  if (allowScope && v === '$scope') return null;
  if (!isStr(v) || !v) return `${field}: must be ${allowScope ? '"$scope" or ' : ''}an absolute folder`;
  if (!isAbsoluteAny(expandHome(v, '/home'))) return `${field}: ${JSON.stringify(v)} must be absolute`;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(v)) return `${field}: may not contain ".."`;
  return null;
}

function validateDuty(d, { field = 'duty' } = {}) {
  const errors = [];
  if (!isObj(d)) return { ok: false, errors: [`${field}: must be an object`], value: null };
  const v = { ...d };
  const e = checkId(v.id, `${field}.id`); if (e) errors.push(e);
  if (!isStr(v.title) || !oneLine(v.title)) errors.push(`${field}.title: required`);
  else if (v.title.length > LIMITS.dutyTitleMax) errors.push(`${field}.title: at most ${LIMITS.dutyTitleMax} characters`);
  if (v.enabled === undefined) v.enabled = true;
  else if (typeof v.enabled !== 'boolean') errors.push(`${field}.enabled: must be true or false`);
  if (!isStr(v.prompt) || !v.prompt.trim()) errors.push(`${field}.prompt: required`);
  else if (v.prompt.length > LIMITS.dutyPromptMax) errors.push(`${field}.prompt: at most ${LIMITS.dutyPromptMax} characters`);
  if (v.output === undefined) v.output = 'report';
  else if (!['draft', 'report'].includes(v.output)) errors.push(`${field}.output: must be draft or report`);
  const t = v.trigger;
  const tf = `${field}.trigger`;
  if (!isObj(t)) errors.push(`${tf}: must be an object`);
  else if (t.kind === 'schedule') {
    if (nextCronFire(t.cron, Date.now()) == null) errors.push(`${tf}.cron: ${JSON.stringify(t.cron)} is not a 5-field cron that fires within 2 years`);
    if (t.catchUp !== undefined && !['once', 'skip'].includes(t.catchUp)) errors.push(`${tf}.catchUp: must be once or skip`);
    v.trigger = { ...t, catchUp: t.catchUp || 'once' };
  } else if (t.kind === 'event') {
    if (t.event === 'commit') {
      const er = checkFolderOrScope(t.repo, `${tf}.repo`, { allowScope: true }); if (er) errors.push(er);
      if (t.branch !== undefined && (!isStr(t.branch) || !/^[^\s~^:?*[\\]{1,200}$/.test(t.branch))) errors.push(`${tf}.branch: not a branch name`);
      if (t.paths !== undefined && (!Array.isArray(t.paths) || t.paths.length > 50 || t.paths.some((p) => !isStr(p) || !p.trim()))) errors.push(`${tf}.paths: must be a list of globs (at most 50)`);
    } else if (t.event === 'release') {
      const er = checkFolderOrScope(t.repo, `${tf}.repo`, { allowScope: true }); if (er) errors.push(er);
      if (t.tag !== undefined && (!isStr(t.tag) || !t.tag.trim())) errors.push(`${tf}.tag: must be a glob such as "v*"`);
    } else if (t.event === 'file') {
      const er = checkFolderOrScope(t.path, `${tf}.path`, { allowScope: false }); if (er) errors.push(er.replace('folder', 'file'));
    } else errors.push(`${tf}.event: must be commit, release or file`);
    if (v.cooldownMin !== undefined && !(Number.isInteger(v.cooldownMin) && v.cooldownMin >= 0 && v.cooldownMin <= 1440)) errors.push(`${field}.cooldownMin: a whole number of minutes, 0 to 1440`);
  } else errors.push(`${tf}.kind: must be schedule or event`);
  return { ok: errors.length === 0, errors, value: errors.length ? null : v };
}

// ---------- position.json (2.4) ----------
const iso = (v) => isStr(v) && !Number.isNaN(Date.parse(v));

function validatePosition(obj, { draft = false } = {}) {
  const errors = [];
  if (!isObj(obj)) return { ok: false, errors: ['position: must be a JSON object'], value: null };
  const v = clone(obj);
  const idErr = checkId(v.id); if (idErr) errors.push(idErr);
  if (!isStr(v.name) || !oneLine(v.name)) errors.push('name: required');
  else if (v.name.length > LIMITS.nameMax || /[\r\n]/.test(v.name)) errors.push(`name: one line, at most ${LIMITS.nameMax} characters`);
  if (!isStr(v.remit) || !oneLine(v.remit)) errors.push('remit: required (one line: what this position covers)');
  else if (v.remit.length > LIMITS.remitMax) errors.push(`remit: at most ${LIMITS.remitMax} characters`);
  if (v.parent === undefined && draft) v.parent = null;
  if (v.parent === undefined) errors.push('parent: required (a position id, or null to report to the CEO)');
  else if (v.parent !== null) {
    const pe = checkId(v.parent, 'parent'); if (pe) errors.push(pe);
    else if (v.parent === v.id) errors.push('parent: a position cannot report to itself');
  }
  // department: the group this position HEADS (docs/POSITIONS.md 2.4). Only a top-level position (parent null) heads
  // one; its reports are in that department by derivation (tree.js departmentOf), so they never store it. Unset =
  // none, and the key is dropped so positions without one stay byte-identical.
  if (v.department === undefined || v.department === null || (isStr(v.department) && !v.department.trim())) delete v.department;
  else if (!isStr(v.department) || /[\r\n]/.test(v.department) || v.department.trim().length > LIMITS.departmentMax) {
    errors.push(`department: one line, at most ${LIMITS.departmentMax} characters (or null for none)`);
  } else if (v.parent !== null && v.parent !== undefined) {
    errors.push('department: only a position that reports to the CEO (parent null) can head a department; its reports are in that department already');
  } else v.department = v.department.trim();
  if (v.scope === undefined) v.scope = { kind: 'company' };
  else if (!isObj(v.scope)) errors.push('scope: must be { "kind": "company" } or { "kind": "product", "folder": ... }');
  else if (v.scope.kind === 'company') v.scope = { kind: 'company' };
  else if (v.scope.kind === 'product') {
    const er = checkFolderOrScope(v.scope.folder, 'scope.folder', { allowScope: false }); if (er) errors.push(er);
    else v.scope = { kind: 'product', folder: normPath(v.scope.folder) };
  } else errors.push('scope.kind: must be company or product');
  if (v.status === undefined) v.status = 'active';
  else if (!STATUSES.includes(v.status)) errors.push('status: must be active, paused or retired');
  if (v.model === undefined || v.model === '') v.model = null;
  else if (v.model !== null && (!isStr(v.model) || !/^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,79}$/.test(v.model))) errors.push('model: null (Helm default) or a model id');
  if (v.effort === undefined || v.effort === null) v.effort = 'high';
  else if (!EFFORTS.includes(v.effort)) errors.push(`effort: must be one of ${EFFORTS.join(', ')}`);
  const pw = validatePowers(v.powers);
  if (!pw.ok) errors.push(...pw.errors); else v.powers = pw.value;
  // repoRules (options.js): append the repo's CLAUDE.md files under "Repo rules". Unset = on for coding positions,
  // so it stays unset unless given; null means unset too.
  if (v.repoRules === null) delete v.repoRules;
  else if (v.repoRules !== undefined && typeof v.repoRules !== 'boolean') errors.push('repoRules: must be true or false (or left out)');
  if (v.duties === undefined) v.duties = [];
  if (!Array.isArray(v.duties)) errors.push('duties: must be a list');
  else {
    if (v.duties.length > LIMITS.maxDuties) errors.push(`duties: at most ${LIMITS.maxDuties}`);
    const ids = new Set();
    v.duties = v.duties.map((d, i) => {
      const r = validateDuty(d, { field: `duties[${i}]` });
      if (!r.ok) { errors.push(...r.errors); return d; }
      if (ids.has(r.value.id)) errors.push(`duties[${i}].id: "${r.value.id}" is used twice`);
      ids.add(r.value.id);
      return r.value;
    });
  }
  if (v.version === undefined && draft) v.version = 0;
  if (!Number.isInteger(v.version) || v.version < 0) errors.push('version: must be a whole number');
  if (v.createdAt !== undefined && !iso(v.createdAt)) errors.push('createdAt: must be an ISO date');
  if (v.createdBy !== undefined && !isObj(v.createdBy)) errors.push('createdBy: must be an object');
  return { ok: errors.length === 0, errors, value: errors.length ? null : v };
}

// ---------- company.json (2.3) ----------
// home: the home folder a company folder may not be, or hold (os.homedir() unless given).
function validateCompany(obj, { draft = false, home = os.homedir() } = {}) {
  const errors = [];
  const homeN = isStr(home) && home ? normPath(home) : '';
  if (!isObj(obj)) return { ok: false, errors: ['company: must be a JSON object'], value: null };
  const v = clone(obj);
  const idErr = checkId(v.id); if (idErr) errors.push(idErr);
  if (!isStr(v.name) || !oneLine(v.name)) errors.push('name: required');
  else if (v.name.length > LIMITS.nameMax || /[\r\n]/.test(v.name)) errors.push(`name: one line, at most ${LIMITS.nameMax} characters`);
  if (!Array.isArray(v.folders) || !v.folders.length) errors.push('folders: at least one absolute folder');
  else {
    if (v.folders.length > LIMITS.maxFolders) errors.push(`folders: at most ${LIMITS.maxFolders}`);
    const norm = [];
    v.folders.forEach((f, i) => {
      const er = checkFolderOrScope(f, `folders[${i}]`, { allowScope: false });
      if (er) { errors.push(er); return; }
      if (hasGlob(f)) { errors.push(`folders[${i}]: no globs in company folders`); return; }
      const n = normPath(homeN ? expandHome(f, homeN) : expandHome(f));
      if (/^[A-Z]:\/?$/.test(n) || n === '/') { errors.push(`folders[${i}]: a whole drive cannot be a company folder`); return; }
      if (homeN && pathKey(n) === pathKey(homeN)) { errors.push(`folders[${i}]: a company folder can't be your home folder itself (${n}). Pick a folder inside it, such as ~/my-company.`); return; }
      if (homeN && isUnder(homeN, n)) { errors.push(`folders[${i}]: a company folder can't hold your home folder (${n} holds ${homeN}). Pick a folder inside your home folder.`); return; }
      const clash = norm.find((o) => foldersOverlap(o, n));
      if (clash) { errors.push(`folders[${i}]: ${n} overlaps ${clash} (nested folders are refused)`); return; }
      norm.push(n);
    });
    v.folders = norm;
  }
  if (v.version === undefined && draft) v.version = 0;
  if (!Number.isInteger(v.version) || v.version < 0) errors.push('version: must be a whole number');
  if (v.createdAt !== undefined && !iso(v.createdAt)) errors.push('createdAt: must be an ISO date');
  return { ok: errors.length === 0, errors, value: errors.length ? null : v };
}

// ---------- brief.md / notebook.md / chats.json ----------
function validateBrief(text) {
  if (!isStr(text)) return { ok: false, errors: ['brief.md: not text'], value: null };
  if (text.includes('\u0000')) return { ok: false, errors: ['brief.md: looks binary (has NUL bytes)'], value: null };
  if (!text.trim()) return { ok: false, errors: ['brief.md: is empty (a position needs its job description)'], value: null };
  if (text.length > LIMITS.briefMax) return { ok: false, errors: [`brief.md: ${text.length} characters, over the ${LIMITS.briefMax} cap`], value: null };
  return { ok: true, errors: [], value: text };
}

function validateNotebook(text) {
  if (!isStr(text)) return { ok: false, errors: ['notebook.md: not text'], value: null };
  if (text.includes('\u0000')) return { ok: false, errors: ['notebook.md: looks binary (has NUL bytes)'], value: null };
  if (text.length > LIMITS.notebookMax) return { ok: false, errors: [`notebook.md: ${text.length} characters, over the ${LIMITS.notebookMax} cap`], value: null };
  // Missing headings are not an error: notebookAdd puts a missing heading back (Helm keeps the four headings).
  return { ok: true, errors: [], value: text };
}

function notebookTemplate(name) {
  return `# ${oneLine(name) || 'Position'} · notebook\n` + NOTEBOOK_SECTIONS.map((s) => `## ${s}\n`).join('');
}

function validateChats(list) {
  if (!Array.isArray(list)) return { ok: false, errors: ['chats.json: must be a list'], value: null };
  if (list.length > LIMITS.chatsMax) return { ok: false, errors: ['chats.json: too many chats'], value: null };
  const errors = [];
  let last = 0;
  list.forEach((c, i) => {
    if (!isObj(c)) { errors.push(`chats[${i}]: must be an object`); return; }
    if (!Number.isInteger(c.n) || c.n <= last) errors.push(`chats[${i}].n: must be a whole number above the previous chat's`);
    else last = c.n;
    if (c.helmSessionId != null && !isStr(c.helmSessionId)) errors.push(`chats[${i}].helmSessionId: must be a string`);
  });
  return { ok: errors.length === 0, errors, value: errors.length ? null : list };
}

module.exports = {
  LIMITS, ID_RE, STATUSES, LIVE_STATUSES, BASH_LEVELS, EFFORTS, NOTEBOOK_SECTIONS, PATH_TOKENS,
  NEVER_TOOLS, AGENT_TOOLS, DEFAULT_TOOLS, CODING_TOOLS,
  checkId, slugify,
  normPath, pathKey, isUnder, foldersOverlap, hasGlob, expandHome, expandPathTokens, isAbsoluteAny, setCaseInsensitive,
  capText, capStrings,
  defaultPowers, validatePowers, validateDuty, validatePosition, validateCompany,
  validateBrief, validateNotebook, validateChats, notebookTemplate,
};
