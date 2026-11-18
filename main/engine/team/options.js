'use strict';
// Positions (docs/POSITIONS.md sections 4.2, 7.1, 8.1, 8.3): what a position's chat runs with.
//
//   positionOptions(position, effectivePowers, chat, ctx) -> SDK options for query()
//   positionPrompt(position, effectivePowers, chat, ctx)  -> { text, repoRules, cwd }   (the systemPrompt append)
//   positionSeed({ ... }) / withSeed(seed, text)           -> the <position-seed> block in front of a first message
//   positionEnv(baseEnv)                                   -> the child env with owner-level setup scrubbed out
//   ROLLOVER_PROMPT, briefChangedNote(), notebookEditedNote()
//
// Isolation is by config, proven on the real claude.exe (section 4, tools/team-isolation-live.js):
// - settingSources [] : no ~/.claude/CLAUDE.md, no project CLAUDE.md, no settings hooks, plugins, user skills or
//   agents. NEVER 'project': its walk-up reaches the home folder and loads the global CLAUDE.md as a project file.
// - CLAUDE_CODE_PLUGIN_DIRS stripped from the env: else the mods load even with settingSources [].
// - strictMcpConfig + disableClaudeAiConnectors + ENABLE_CLAUDEAI_MCP_SERVERS=false: no user MCP servers, no
//   claude.ai connectors. The only MCP server is Helm's in-process `team` server.
// - a `tools` allowlist: the only switch that removes SendMessage / ListAgents / Task / Skill / Cron*.
// - auto-memory off: the notebook is the one memory, and the owner can read it.
// A coding position (its powers include a code repo) also gets that repo's ROOT CLAUDE.md, read here by Helm
// (no walk-up, never anything under ~/.claude) and appended under "Repo rules". position.repoRules switches it
// (true / false); unset = on for coding positions, off for the rest.
//
// ctx (from the engine wiring):
//   workspace     the position's folder (<teamRoot>/<company>/positions/<id>)          required
//   server        the position's `team` MCP server (mcp.js, createSdkMcpServer)          required
//   preToolUse    PreToolUse hook matchers, in order (prod-guard first, then team/guard)  required, non-empty
//   worktree      { path, branch?, of? } when effectivePowers.worktree: its git worktree (required then) and the
//                 live repo root it was made from (else read from the worktree's .git file)
//   company       company.json ({ id, name, folders })
//   manager       the manager's position.json, or null (reports to the CEO)
//   reports       the direct reports' position.json list
//   brief         brief.md text (else read from <workspace>/brief.md)
//   houseRules    house-rules text (else <teamRoot>/house-rules.md, else house-rules.default.md)
//   teamRoot, ownerName (string or () => string; 'the owner' when empty), baseEnv (engine.claudeEnv()), claudePath, model, effort,
//   canUseTool, stderr, home (os.homedir()), now (Date.now()) for tests

const fs = require('fs');
const os = require('os');
const path = require('path');
const { normPath, isInside, worktreeOf } = require('./match');
const { ownerWords } = require('./owner');

const DEFAULT_HOUSE_RULES_FILE = path.join(__dirname, 'house-rules.default.md');
const NOTEBOOK_HEADINGS = ['Decisions', 'Facts', 'Open items', 'Log'];

// Built-in tools a position never gets (7.1). The `tools` allowlist already leaves them out; disallowedTools
// repeats them as a second lock. Cross-session messaging would bypass the crosstalk log; duties live in Helm, not
// in a CLI the idle reaper closes; worktrees are Helm's (7.1), not the CLI's.
const NEVER_TOOLS = ['SendMessage', 'ListAgents', 'SendToProject', 'SendToProjectContext', 'Skill', 'Workflow',
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'PushNotification',
  'EnterWorktree', 'ExitWorktree'];
const AGENT_TOOLS = ['Agent', 'Task']; // only with powers.agents
const SHELL_TOOLS = ['Bash', 'PowerShell'];
// Every position has these. ToolSearch is NOT added (measured live by tools/team-isolation-live.js, claude.exe
// 2.1.x / SDK 0.3.293): without ToolSearch in the list the CLI defers nothing, so the team server's tools are in
// the prompt from turn 1 with or without alwaysLoad, and no built-in moves behind a search. With ToolSearch,
// ~440 tokens of tools are deferred and a server without alwaysLoad costs an extra ToolSearch round trip.
// A position whose powers.tools lists ToolSearch explicitly still gets it.
const ALWAYS_TOOLS = ['AskUserQuestion'];

// Env names a position's CLI must not inherit. The nested-session markers and the parent Claude Code session's
// identity / messaging channel (Helm may be launched from a Claude Code terminal), the mods' plugin dirs
// (finding 1), and the switch that would load CLAUDE.md files from additional directories.
const ENV_STRIP = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD'];
const ENV_STRIP_RE = /^CLAUDE_CODE_(PLUGIN|MESSAGING_|BRIDGE_)/i;
const ENV_SET = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };

// A position's claude.exe (and so every Bash / PowerShell it runs) gets a MINIMAL environment (review fix 7): only
// what the CLI and ordinary tools need to run and to sign in, never the owner's tokens and keys. Every position gets
// it, with a shell or without (the CLI itself is the same process either way). Names compare case-insensitively.
// ENV_KEEP: the OS, the user's folders, locale, terminal, proxy and TLS settings, toolchain homes.
const ENV_KEEP = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'OS', 'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'NUMBER_OF_PROCESSORS',
  'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'ALLUSERSPROFILE', 'PUBLIC', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'PSMODULEPATH', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'USER',
  'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'SSL_CERT_FILE',
  'SSL_CERT_DIR', 'JAVA_HOME', 'GOPATH', 'GOROOT', 'CARGO_HOME', 'RUSTUP_HOME', 'PNPM_HOME', 'NVM_HOME', 'NVM_SYMLINK',
  'VOLTA_HOME', 'DOTNET_ROOT', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'PYTHONIOENCODING', 'PYTHONUTF8',
  'NODEFAULTCURRENTDIRECTORYINEXEPATH'];
// Prefixes kept: locale, XDG folders, and the CLI's own settings (CLAUDE_CONFIG_DIR, CLAUDE_CODE_GIT_BASH_PATH,
// CLAUDE_AGENT_SDK_CLIENT_APP, CLAUDE_CODE_USE_*, ANTHROPIC_BASE_URL / _MODEL ...), still minus ENV_STRIP and ENV_DENY.
const ENV_KEEP_PREFIX = /^(LC_|XDG_|CLAUDE_|ANTHROPIC_)/i;
// Dropped even when kept above (deny wins): tokens, secrets, keys, passwords, credentials, and whole families that
// only carry them (cloud, registry, deploy and AI-provider accounts).
const ENV_DENY = /(_TOKEN|_SECRET|_KEY|_KEYS|_PAT|_APIKEY|_API_KEY|_CREDENTIALS?|_COOKIE)$|PASSWORD|PASSWD|SECRET|CREDENTIAL|PRIVATE|^(AWS|NPM|YARN|RAILWAY|GH|GITHUB|GITLAB|AZURE|ARM|GOOGLE|GCLOUD|GCP|OPENAI|GEMINI|STRIPE|TWILIO|VERCEL|NETLIFY|HEROKU|CLOUDFLARE|CF|DOCKER|SLACK|DISCORD|SENTRY|SUPABASE|FIREBASE)_/i;
// The CLI's sign-in carriers. Kept ONLY when the base env already has them, because then Helm's own chats (same
// engine.claudeEnv()) sign in with them: ANTHROPIC_API_KEY is there in Settings > Account API-key mode (account.js),
// or from the user's own environment (the CLI then uses it in place of the subscription). Dropping it would sign the
// position in differently from every other chat, or not at all. With subscription sign-in (the default) none is
// set and the CLI reads its own credentials file under CLAUDE_CONFIG_DIR or the home folder.
// The CLI's OAuth sign-in variables are matched as their family (ENV_AUTH_RE), never named one by one: Helm's code
// never handles the sign-in token itself (test/host/no-login.test.js); here it only passes through untouched, as
// it does into every other chat.
const ENV_AUTH = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const ENV_AUTH_RE = /^CLAUDE_CODE_OAUTH_\w*TOKEN$/;

const CAP = { brief: 12_000, houseRules: 6_000, repoRulesEach: 16_000, repoRulesTotal: 24_000, remit: 300,
  notebook: 30_000, handoff: 20_000, noteDiff: 4_000, noteFull: 30_000 };
const MAX_REPOS = 4;

const SEED_RE = /^\s*<position-seed>([\s\S]*?)<\/position-seed>\s*/;

const ROLLOVER_PROMPT = [
  'Your chat is full and a fresh one starts next.',
  'First record in notebook.md (notebook_add or Edit) every decision, fact and open item from this chat that is not there yet.',
  'Then reply with a handoff under 250 words: Done, In progress, Waiting on (tickets), Next.',
].join(' ');

// ---------------------------------------------------------------- small helpers

const fwd = (p) => String(p).replace(/\\/g, '/');
const oneLine = (s, cap) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return cap && t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
};
function capText(text, cap, where) {
  const t = String(text == null ? '' : text);
  if (t.length <= cap) return { text: t, cut: false };
  return { text: `${t.slice(0, cap)}\n[… cut at ${cap} characters${where ? `; the full text is ${where}` : ''}]`, cut: true };
}
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
// A display form of an absolute path: resolved, forward slashes, original case.
function shown(p) { return fwd(path.resolve(String(p))).replace(/(.)\/+$/, '$1'); }
function localDate(ms) {
  const d = new Date(ms);
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
function fail(code, message) { return Object.assign(new Error(message), { code }); }

// ---------------------------------------------------------------- env

// Markers the SDK sets for its own child (CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_SDK_*, the checkpointing switch): one
// inherited from a parent SDK process (Helm started from an SDK host) would stop the SDK setting the right value.
const ENV_SDK_OWN = /^(CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_SDK_\w*|CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING)$/i;
const KEEP_SET = new Set(ENV_KEEP);
const STRIP_SET = new Set(ENV_STRIP.map((k) => k.toUpperCase()));
const AUTH_SET = new Set(ENV_AUTH);
// Is this variable passed to a position's CLI? ENV_STRIP, the SDK's own markers and ENV_DENY win over the keep lists;
// ENV_AUTH / ENV_AUTH_RE are the one exception to ENV_DENY (see above).
function envKept(name) {
  const k = String(name).toUpperCase();
  if (STRIP_SET.has(k) || ENV_STRIP_RE.test(k) || ENV_SDK_OWN.test(k)) return false;
  if (AUTH_SET.has(k) || ENV_AUTH_RE.test(k)) return true;
  if (ENV_DENY.test(k)) return false;
  return KEEP_SET.has(k) || ENV_KEEP_PREFIX.test(k);
}

function positionEnv(baseEnv) {
  const src = baseEnv || process.env;
  const env = {};
  for (const k of Object.keys(src)) {
    if (src[k] == null || !envKept(k)) continue;
    env[k] = String(src[k]);
  }
  for (const [k, v] of Object.entries(ENV_SET)) {
    for (const have of Object.keys(env)) if (have.toUpperCase() === k && have !== k) delete env[have];
    env[k] = v;
  }
  return env;
}

// ---------------------------------------------------------------- powers -> paths and tools

// One powers path entry -> { token, path } with the glob tail cut off (`C:/x/**` -> `C:/x`). Tokens: $workspace,
// $company (every company folder), $scope (the scope folder, or the company folders for a company-wide position).
function expandPaths(list, where) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const r = raw.trim();
    let paths;
    let token = null;
    if (r === '$workspace') { token = r; paths = where.workspace ? [where.workspace] : []; }
    else if (r === '$company') { token = r; paths = where.companyFolders; }
    else if (r === '$scope') { token = r; paths = where.scopeFolder ? [where.scopeFolder] : where.companyFolders; }
    else if (/^~([\\/]|$)/.test(r)) paths = [path.join(where.home, r.slice(1))];
    else paths = [r];
    for (const p of paths) {
      const base = globBase(p);
      if (base && path.isAbsolute(base)) out.push({ token, raw: r, path: shown(base) });
    }
  }
  return out;
}

function globBase(p) {
  const parts = fwd(p).split('/');
  const i = parts.findIndex((s) => /[*?[\]{}]/.test(s));
  const kept = i < 0 ? parts : parts.slice(0, i);
  const s = kept.join('/');
  return s || (fwd(p).startsWith('/') ? '/' : '');
}

function where(position, ctx) {
  const company = ctx.company || {};
  const companyFolders = (Array.isArray(company.folders) ? company.folders : []).filter((f) => typeof f === 'string' && f);
  const scope = position && position.scope;
  const scopeFolder = scope && scope.kind === 'product' && typeof scope.folder === 'string' ? scope.folder : null;
  return { workspace: ctx.workspace, companyFolders, scopeFolder, home: ctx.home || os.homedir() };
}

// The folders outside cwd that the position may read or write, nested ones folded into their parent. A granted
// single file contributes its folder (Claude Code's directory checks want folders; the guard checks the file).
function dirsOutside(cwd, entries) {
  const dirs = [];
  for (const e of entries) {
    if (isInside(e.path, cwd)) continue;
    const d = isFile(e.path) ? shown(path.dirname(e.path)) : e.path;
    if (!dirs.some((x) => normPath(x) === normPath(d))) dirs.push(d);
  }
  return dirs.filter((d) => !dirs.some((o) => o !== d && normPath(o) !== normPath(d) && isInside(d, o)));
}

function toolList(effectivePowers) {
  const p = effectivePowers || {};
  const agents = p.agents === true;
  const bash = p.bash === 'on' || p.bash === 'readonly' ? p.bash : 'off';
  const out = [];
  const add = (t) => { if (!out.includes(t)) out.push(t); };
  for (const t of Array.isArray(p.tools) ? p.tools : []) {
    if (typeof t !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(t) || /^mcp__/i.test(t)) continue; // MCP is the team server only
    if (NEVER_TOOLS.includes(t)) continue;
    if (AGENT_TOOLS.includes(t) && !agents) continue;
    if (SHELL_TOOLS.includes(t) && bash === 'off') continue;
    add(t);
  }
  if (bash !== 'off') add('Bash');
  if (agents) for (const t of AGENT_TOOLS) add(t);
  for (const t of ALWAYS_TOOLS) add(t);
  return out;
}

function disallowedList(effectivePowers) {
  const agents = effectivePowers && effectivePowers.agents === true;
  return agents ? [...NEVER_TOOLS] : [...NEVER_TOOLS, ...AGENT_TOOLS];
}

// ---------------------------------------------------------------- repo rules (coding positions)

// The git root holding `p` (the folder with a `.git` dir or worktree file), never the home folder or above it.
function gitRootOf(p, home) {
  const h = normPath(home);
  let dir = path.resolve(p);
  if (isFile(dir)) dir = path.dirname(dir);
  for (let i = 0; i < 64; i++) {
    const n = normPath(dir);
    if (!n || n === h || isInside(h, n, { normed: true })) return null; // reached the home folder or an ancestor
    if (fs.existsSync(path.join(dir, '.git'))) return shown(dir);
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

// The live repo a worktree position's worktree was made from (its rules come from the worktree's own copy).
function liveRepoOf(effectivePowers, ctx, cwd) {
  if (!(effectivePowers && effectivePowers.worktree === true)) return null;
  if (ctx.worktree && ctx.worktree.of) return shown(ctx.worktree.of);
  const wt = worktreeOf(cwd);
  return wt ? shown(wt.main) : null;
}

// Is this a coding position: does its write area hold a code repo, or does it work in a worktree? Its repo roots.
function codeRepos(effectivePowers, w, cwd, live) {
  const home = w.home;
  const roots = [];
  const push = (r) => {
    if (!r || roots.some((x) => normPath(x) === normPath(r))) return;
    if (live && normPath(r) === normPath(live)) return; // the worktree stands in for its live repo
    roots.push(r);
  };
  if (effectivePowers && effectivePowers.worktree === true) push(gitRootOf(cwd, home));
  for (const e of expandPaths(effectivePowers && effectivePowers.write, w)) {
    if (e.token === '$workspace' || (w.workspace && isInside(e.path, w.workspace))) continue;
    push(gitRootOf(e.path, home));
  }
  return roots;
}

// [{ path, text, cut }] for each repo's ROOT CLAUDE.md. Only <root>/CLAUDE.md is read: no walk-up, no nested
// files, no @imports followed, and never a file that resolves into ~/.claude or sits in the home folder itself.
function repoRules(position, effectivePowers, ctx, cwd) {
  const w = where(position, ctx);
  const setting = position && typeof position.repoRules === 'boolean' ? position.repoRules : null;
  if (setting === false) return [];
  const roots = codeRepos(effectivePowers, w, cwd, liveRepoOf(effectivePowers, ctx, cwd));
  if (setting === null && !roots.length) return [];
  if (setting === true && !roots.length) {
    // switched on for a non-coding position: the repos it may read
    for (const e of expandPaths(effectivePowers && effectivePowers.read, w)) {
      if (e.token === '$workspace') continue;
      const r = gitRootOf(e.path, w.home);
      if (r && !roots.some((x) => normPath(x) === normPath(r))) roots.push(r);
    }
  }
  const claudeDir = path.join(w.home, '.claude');
  const out = [];
  let total = 0;
  for (const root of roots.slice(0, MAX_REPOS)) {
    const file = path.join(root, 'CLAUDE.md');
    if (!isFile(file)) continue;
    let realFile = file;
    try { realFile = fs.realpathSync.native(file); } catch {}
    if (isInside(realFile, claudeDir) || normPath(path.dirname(realFile)) === normPath(w.home)) continue;
    const raw = readText(file);
    if (raw == null || !raw.trim()) continue;
    const room = Math.min(CAP.repoRulesEach, CAP.repoRulesTotal - total);
    if (room <= 200) break;
    const c = capText(raw.trim(), room, shown(file));
    total += c.text.length;
    out.push({ path: shown(file), text: c.text, cut: c.cut });
  }
  return out;
}

// ---------------------------------------------------------------- the appended system prompt (8.1)

function loadHouseRules(teamRoot) {
  const own = teamRoot ? readText(path.join(teamRoot, 'house-rules.md')) : null;
  if (own && own.trim()) return own;
  return readText(DEFAULT_HOUSE_RULES_FILE) || '';
}

function label(e, w) {
  if (e.token === '$workspace') return `your workspace ${e.path}`;
  if (e.token === '$scope' && w.scopeFolder) return `your scope ${e.path}`;
  return e.path;
}

function pathsInWords(entries, w) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const k = normPath(e.path);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(label(e, w));
  }
  return out.length ? out.join('; ') : 'nothing';
}

function powersInWords(position, effectivePowers, ctx, cwd, tools) {
  const p = effectivePowers || {};
  const w = where(position, ctx);
  const { owner, Owner } = ownerWords(ctx.ownerName);
  const read = expandPaths(['$workspace', ...(Array.isArray(p.read) ? p.read : [])], w);
  let write = expandPaths(['$workspace', ...(Array.isArray(p.write) ? p.write : [])], w);
  const live = liveRepoOf(p, ctx, cwd);
  if (live) {
    // a worktree position writes the live repo's files in its own worktree (7.1): say so in its terms
    write = write.map((e) => (isInside(e.path, live)
      ? { ...e, token: null, path: shown(path.join(cwd, path.relative(live, e.path))) }
      : e));
  }
  const shell = p.bash === 'on'
    ? 'yes, for work inside the folders you may write'
    : p.bash === 'readonly'
      ? 'read-only commands only (ls, cat, rg, git log / show / diff / status and the like; no writes, no redirects)'
      : 'none';
  const lines = [
    `- You may read: ${pathsInWords(read, w)}. Files handed to you with a question are readable for that question only.`,
    `- You may write: ${pathsInWords(write, w)}.`,
    `- Built-in tools: ${tools.join(', ')}; and your team tools (mcp__team__*).`,
    `- Shell: ${shell}.`,
    `- Subagents: ${p.agents === true ? 'yes; they work under your powers' : 'no'}.`,
  ];
  if (p.worktree === true && ctx.worktree) {
    const branch = ctx.worktree.branch || `team/${(ctx.company && ctx.company.id) || 'company'}/${position.id}`;
    const of = ctx.worktree.of ? ` of ${shown(ctx.worktree.of)}` : '';
    lines.push(`- You work in your own git worktree${of}: ${cwd} (branch ${branch}). Make code changes there only; the live folder is never edited. ${Owner} merges your branch.`);
  }
  lines.push(`- Anything outward (send, post, pay, push, deploy, publish) waits for ${owner}'s OK every time, whatever these powers say.`);
  lines.push('- Helm checks these powers on every tool call. If you need more, call request_access with the reason; do not try another way.');
  return lines.join('\n');
}

function whoInWords(position, ctx) {
  const { owner } = ownerWords(ctx.ownerName);
  const companyName = oneLine((ctx.company && (ctx.company.name || ctx.company.id)) || 'the company', 80);
  const m = ctx.manager;
  const manager = m ? `${oneLine(m.name, 80)} (${m.id}): ${oneLine(m.remit, CAP.remit).replace(/[.\s]+$/, '')}` : `the CEO (${owner}'s main chats)`;
  const reports = (Array.isArray(ctx.reports) ? ctx.reports : []).filter((r) => r && r.id);
  const rs = reports.length
    ? reports.map((r) => `\n- ${oneLine(r.name, 80)} (${r.id}): ${oneLine(r.remit, CAP.remit)}`).join('')
    : ' none.';
  return `You are ${oneLine(position.name || position.id, 80)} on ${companyName}'s team. You report to ${manager}.\nYour reports:${rs}`;
}

function positionPrompt(position, effectivePowers, chat, ctx = {}) {
  if (!position || !position.id) throw fail('position_missing', 'positionPrompt: no position');
  if (!ctx.workspace) throw fail('workspace_missing', `Position ${position.id}: no workspace folder`);
  const cwd = cwdFor(position, effectivePowers, ctx);
  const { owner, Owner } = ownerWords(ctx.ownerName);
  const tools = toolList(effectivePowers);
  const rulesRaw = ctx.houseRules != null ? String(ctx.houseRules) : loadHouseRules(ctx.teamRoot);
  const rules = capText(rulesRaw.replace(/\{owner\}/g, owner).replace(/\{Owner\}/g, Owner).trim(), CAP.houseRules).text;
  const briefFile = path.join(ctx.workspace, 'brief.md');
  const briefRaw = ctx.brief != null ? String(ctx.brief) : (readText(briefFile) || '');
  const brief = capText(briefRaw.trim() || '(No brief yet.)', CAP.brief, shown(briefFile)).text;
  const notebookPath = shown(path.join(ctx.workspace, 'notebook.md'));
  const repo = repoRules(position, effectivePowers, ctx, cwd);
  const started = chat && chat.startedAt ? Date.parse(chat.startedAt) : NaN;
  const today = localDate(Number.isFinite(started) ? started : (ctx.now || Date.now()));
  const n = chat && Number.isInteger(chat.n) ? chat.n : 1;

  const parts = [
    '# Your position',
    'You are a position on a team: an AI staff member with a fixed role. The sections below are your standing instructions.',
    rules,
    '## Your brief',
    brief,
    '## Where you sit',
    whoInWords(position, ctx),
    '## Your powers',
    powersInWords(position, effectivePowers, ctx, cwd, tools),
    '## Your notebook',
    `Your notebook is ${notebookPath}, with four headings: ${NOTEBOOK_HEADINGS.join(', ')}. It is your only memory between chats (there is no auto-memory). Add to it with notebook_add, or edit the file. Its text as it is now comes at the start of each chat.`,
  ];
  for (const r of repo) {
    parts.push(`## Repo rules (from ${r.path})`);
    parts.push(`The rules of the repo you work in. They apply to your work in it; the house rules above still win.\n\n${r.text}`);
  }
  parts.push(`Today is ${today}. This is chat ${n} of this position.`);
  return { text: parts.join('\n\n'), repoRules: repo.map((r) => r.path), cwd };
}

// ---------------------------------------------------------------- the SDK options (4.2)

function cwdFor(position, effectivePowers, ctx) {
  const ws = shown(ctx.workspace);
  let cwd = ws;
  if (effectivePowers && effectivePowers.worktree === true) {
    if (!ctx.worktree || !ctx.worktree.path) throw fail('worktree_missing', `Position ${position.id} works in a git worktree, and none was given`);
    cwd = shown(ctx.worktree.path);
  }
  const home = ctx.home || os.homedir();
  // Fail closed: a position never runs in the home folder (where the global memory index is keyed), above it,
  // or inside ~/.claude.
  if (normPath(cwd) === normPath(home) || isInside(home, cwd) || isInside(cwd, path.join(home, '.claude'))) {
    throw fail('cwd_refused', `Position ${position.id}: refusing to run in ${cwd}`);
  }
  return cwd;
}

function positionOptions(position, effectivePowers, chat, ctx = {}) {
  if (!ctx.server || typeof ctx.server !== 'object') throw fail('server_missing', `Position ${position && position.id}: no team MCP server`);
  if (ctx.server.name && ctx.server.name !== 'team') throw fail('server_name', `Position ${position.id}: the MCP server must be named "team"`);
  const preToolUse = Array.isArray(ctx.preToolUse) ? ctx.preToolUse.filter(Boolean) : [];
  if (!preToolUse.length) throw fail('guard_missing', `Position ${position && position.id}: refusing to start without its PreToolUse guard`);
  const prompt = positionPrompt(position, effectivePowers, chat, ctx);
  const cwd = prompt.cwd;
  const w = where(position, ctx);
  const ep = effectivePowers || {};
  const reach = Array.isArray(ep.dirsOutsideCwd)
    ? ep.dirsOutsideCwd.filter((d) => typeof d === 'string' && path.isAbsolute(d)).map(shown)
    : dirsOutside(cwd, [...expandPaths(ep.read, w), ...expandPaths(ep.write, w), ...expandPaths(['$workspace'], w)]);

  const opts = {
    cwd,
    settingSources: [], // never 'project' (section 4 finding 2)
    systemPrompt: { type: 'preset', preset: 'claude_code', append: prompt.text, snapshot: true },
    tools: toolList(ep),
    disallowedTools: disallowedList(ep),
    skills: [],
    strictMcpConfig: true,
    mcpServers: { team: ctx.server },
    settings: { disableClaudeAiConnectors: true, autoMemoryEnabled: false, crossSessionInbound: 'refuse' },
    additionalDirectories: reach,
    env: positionEnv(ctx.baseEnv),
    permissionMode: 'bypassPermissions', // the guard hook is the gate (7.3)
    allowDangerouslySkipPermissions: true,
    hooks: { PreToolUse: preToolUse },
    includePartialMessages: true,
    extraArgs: { 'replay-user-messages': null },
    enableFileCheckpointing: true,
  };
  if (typeof ctx.canUseTool === 'function') opts.canUseTool = ctx.canUseTool;
  if (typeof ctx.stderr === 'function') opts.stderr = ctx.stderr;
  if (ctx.claudePath) opts.pathToClaudeCodeExecutable = ctx.claudePath;
  const model = (position && position.model) || ctx.model;
  if (model && model !== 'default') opts.model = model;
  opts.effort = (position && position.effort) || ctx.effort || 'high';
  // for Helm, not the SDK (non-enumerable: never spread into the CLI's flags)
  Object.defineProperty(opts, '_team', { value: { position: position.id, workspace: shown(ctx.workspace), repoRules: prompt.repoRules }, enumerable: false });
  return opts;
}

// ---------------------------------------------------------------- the seed and later notes (8.1, 8.3)

const unframe = (s) => String(s).replace(/<\/?position-seed>/gi, (m) => m.replace('<', '&lt;'));

// The block in front of a chat's first real message. Never a turn by itself.
function positionSeed({ chatN = 1, notebook = '', notebookPath = '', handoff = null, handoffFailed = null } = {}) {
  const nb = capText(String(notebook || '').trim() || '(empty)', CAP.notebook, notebookPath ? `in ${notebookPath}` : '').text;
  const lines = [
    `Chat ${chatN} of your position starts here. This block is context, not a task: the task is the message after it.`,
    '',
    `Your notebook${notebookPath ? ` (${notebookPath})` : ''}, as it is now:`,
    unframe(nb),
  ];
  if (chatN > 1) {
    lines.push('');
    if (handoff && String(handoff).trim()) {
      lines.push('The handoff your previous chat wrote when it ended:', unframe(capText(String(handoff).trim(), CAP.handoff).text));
    } else {
      lines.push(`Your previous chat ended without a handoff${handoffFailed ? ` (${oneLine(handoffFailed, 300)})` : ''}. Your notebook above is what carried over.`);
    }
  }
  return `<position-seed>\n${lines.join('\n')}\n</position-seed>`;
}

function withSeed(seed, text) {
  return seed ? `${seed}\n\n${text == null ? '' : text}` : text;
}

// Inner text of the <helm-note> (steer.js withNote wraps it) when the owner edits the brief mid-chat: the
// recorded system prompt cannot change, so the whole new brief rides along.
function briefChangedNote(brief, { ownerName } = {}) {
  const { Owner } = ownerWords(ownerName);
  return `${Owner} edited your brief. It replaces the brief in your instructions, in full:\n\n${capText(String(brief || '').trim(), CAP.brief).text}`;
}

// ... and when the owner edits the notebook: the unified diff, or the whole file when the diff is over 4k.
function notebookEditedNote({ diff = '', full = '', ownerName } = {}) {
  const { Owner } = ownerWords(ownerName);
  const d = String(diff || '');
  if (d && d.length <= CAP.noteDiff) return `${Owner} edited your notebook:\n${d}`;
  return `${Owner} edited your notebook. It is now:\n${capText(String(full || '').trim(), CAP.noteFull).text}`;
}

module.exports = {
  positionOptions, positionPrompt, positionSeed, withSeed, positionEnv, loadHouseRules,
  briefChangedNote, notebookEditedNote, toolList, repoRules, expandPaths,
  ROLLOVER_PROMPT, SEED_RE, NEVER_TOOLS, AGENT_TOOLS, ALWAYS_TOOLS, ENV_STRIP, ENV_SET, ENV_KEEP, ENV_AUTH, ENV_AUTH_RE, envKept, NOTEBOOK_HEADINGS,
  DEFAULT_HOUSE_RULES_FILE, CAP,
};
