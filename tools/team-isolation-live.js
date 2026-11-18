'use strict';
// Live check (lane pos-t2, docs/POSITIONS.md section 4.2): re-runs the section 4 isolation probe THROUGH
// main/engine/team/options.js on the real claude.exe, one turn each, one at a time, claude-haiku-5-5.
//
//   node tools/team-isolation-live.js [--keep] [--model=claude-haiku-5-5]      (~$0.02-0.05, about a minute)
//
// A throwaway world under the OS temp dir (helm-team-iso-*): a team root with a position workspace, a company
// repo (real git) with a linked git worktree for a coding position, and CODEWORD canaries where a leak would
// show: the workspace CLAUDE.md, the team root, the folder above the repo (walk-up), a nested repo CLAUDE.md,
// and the CLI's default auto-memory folder for each cwd. The repo's ROOT CLAUDE.md carries the one canary a
// coding position must see. The real global ~/.claude/CLAUDE.md and the home folder's MEMORY.md are the
// main canaries: their text is compared (6-word shingles) with every answer, and nothing of them is printed.
//
// Runs:
//   legal      non-coding position (reads the company repo, writes its workspace), Helm's tool list
//   qa         coding position in its own worktree: must carry the repo root CLAUDE.md, nothing else
//   ToolSearch two legal variants (no ToolSearch + a server without alwaysLoad; ToolSearch added back) that keep
//              proving options.js may leave ToolSearch out: nothing deferred, same built-ins, team tools reachable
// Fails on: a cloudtest / agent-budget quote; a MEMORY.md entry; a CLAUDE.md path other than the allowed repo
// rules file; an mcp__ tool other than mcp__team__*; SendMessage / ListAgents (or any never-tool) in the init
// tool list; a mod / plugin tool or plugin; a user skill or agent; any memory file in the context.
// No stand-ins (lane pos-t9-live): the options come from the REAL wiring, the engine's own path. A real team store
// (main/engine/team/store.js) under the temp team root holds the company and both positions, made by the proposals
// path the owner uses (team.proposals.import + team.decide approve); createTeamWiring().sessionOptions() builds each
// position's options exactly as session.js does at a CLI start: the real team MCP server (mcp.js on the real SDK,
// team_ticket answers "No such ticket" for t_probe), the real guard hook (guard.js) after prod-guard, and the coding
// position's git worktree made by the wiring (<workspace>/worktree). A pass-through recorder around the guard hook
// notes each tool call (it returns the guard's own decision). Summary line: `team-isolation: N passed, M failed`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const O = require('../main/engine/team/options');
const { createTeamWiring } = require('../main/engine/team/wire');
const { normPath } = require('../main/engine/team/match');
const { buildChildEnv, defaultClaudePath } = require('../main/claude-cli');
const { projectsDir, slugFor } = require('../main/engine/transcript');
const { dropLiveTranscripts } = require('./live-cleanup');

const argv = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const MODEL = typeof argv.model === 'string' ? argv.model : 'claude-haiku-5-5';
const TURN_MS = 180_000;
const tag = () => crypto.randomBytes(3).toString('hex').toUpperCase();
const fwd = (p) => String(p).replace(/\\/g, '/');
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]').trim().slice(0, 100);

let pass = 0, fail = 0;
const check = (ok, what, extra = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${extra ? ` (${extra})` : ''}`); };
const info = (what) => console.log(`  info ${what}`);

// ---------------------------------------------------------------- text comparison (none of the owner's text is printed)

const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
function shingles(s, n = 6) {
  const w = words(s);
  const out = new Set();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}
// how many n-word runs of `secret` appear in `text`, ignoring runs the position legitimately has (its prompt)
function overlap(text, secret, allowed) {
  if (!secret.size) return 0;
  let n = 0;
  for (const s of shingles(text)) if (secret.has(s) && !allowed.has(s)) n++;
  return n;
}
// the answer's "(k) ..." part, else ''
// the answer's part k: "(k) ...", "**(k)** ...", "k. ..." or "k) ..." at a line start, up to part k+1
function section(text, k) {
  const t = String(text || '');
  const head = (n) => `(?:\\(${n}\\)|(?:^|\\n)[\\s*#>_-]*${n}[.)])`;
  const m = new RegExp(`${head(k)}([\\s\\S]*?)(?=${head(k + 1)}|$)`).exec(t);
  return m ? m[1] : '';
}
// quoted spans of 4+ words that talk about cloudtest / budgets / sub-agents and are not the position's own text
function foreignQuotes(s, ownText) {
  const own = words(ownText).join(' ');
  const spans = [...String(s || '').matchAll(/["“`]([^"”`\n]{8,400})["”`]|^\s*>\s?(.+)$/gm)].map((m) => m[1] || m[2]);
  return spans.filter((q) => words(q).length >= 4 && /cloudtest|budget|sub-?agent/i.test(q) && !own.includes(words(q).join(' ')));
}
const CLAUDE_MD_RE = /(?:[A-Za-z]:)?[\\/]?(?:[^\s`'"()<>|*?\\/]+[\\/])+CLAUDE\.md|~[\\/](?:[^\s`'"()<>|*?]+[\\/])*CLAUDE\.md/g;

// ---------------------------------------------------------------- the world

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Helm Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).toString();
}

// The legal and qa positions, as the proposals the owner approves (brief codewords go in through the brief)
const LEGAL = { id: 'legal', name: 'Legal', remit: 'Contracts and terms for Acme.', scope: { kind: 'company' },
  powers: { read: ['$workspace', '$company'], write: ['$workspace'], tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'TodoWrite'], bash: 'off', agents: false, worktree: false } };
const QA = { id: 'qa', name: 'App QA', remit: 'Tests the Acme app.',
  powers: { read: ['$workspace', '$scope'], write: ['$workspace', '$scope'], tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'], bash: 'on', agents: false, worktree: true } };

function buildWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-team-iso-'));
  const cw = {};
  const canary = (name) => (cw[name] = `${name.toUpperCase()}-${tag()}`);
  const teamRoot = path.join(root, 'helm-team');
  const repo = path.join(root, 'acme-app');
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  for (const k of ['ws_legal', 'ws_qa', 'brief_legal', 'brief_qa', 'teamroot']) canary(k);

  fs.writeFileSync(path.join(root, 'CLAUDE.md'), `# Above the repo\nCODEWORD: ${canary('walkup')}\n`);
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), `# Acme app rules\nIndent with exactly three spaces (house style).\nCODEWORD: ${canary('repo')}\n`);
  fs.writeFileSync(path.join(repo, 'sub', 'CLAUDE.md'), `# Nested\nCODEWORD: ${canary('nested')}\n`);
  fs.writeFileSync(path.join(repo, 'README.md'), 'Acme app\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return { root, teamRoot, repo, cw, planted: [], userData: path.join(root, 'userdata') };
}

// The team through the real wiring: a real store under world.teamRoot, the company and both positions made by
// team.proposals.import + team.decide approve, then the canaries a leak would show (team root, workspaces) and the
// auto-memory canaries for each cwd. world.optionsFor(pid, sdk, base) -> the options session.js would hand the SDK.
async function buildTeam(world) {
  fs.mkdirSync(world.userData, { recursive: true });
  const sessions = new Map();
  const wiring = createTeamWiring({
    settings: () => ({ enabled: true }), root: () => world.teamRoot, rootProblem: () => null,
    userDataDir: world.userData, sessions, log: (lvl, m) => { if (lvl === 'error' || lvl === 'warn') console.log(`  info wiring ${lvl}: ${oneLine(m)}`); },
    claudePath: defaultClaudePath() || undefined, createSession: () => { throw new Error('no new sessions in this probe'); },
  });
  world.wiring = wiring;
  if (!wiring.start()) throw new Error(`the team wiring did not start: ${wiring.status().problem}`);
  const pos = (p, extra) => ({ action: 'create', id: p.id, parent: null, name: p.name, remit: p.remit, powers: p.powers, duties: [], model: MODEL, effort: 'low', why: 'isolation probe', ...extra });
  const file = {
    kind: 'helm-team-proposals', status: 'pending', company: 'acme', draftedAt: new Date().toISOString(), draftedBy: 'team-isolation-live', note: 'isolation probe',
    proposals: [
      { ref: 'company', status: 'pending', team_propose: { action: 'company', id: 'acme', name: 'Acme', folders: [fwd(world.repo)], why: 'isolation probe' } },
      { ref: 'legal', status: 'pending', team_propose: pos(LEGAL, { scope: LEGAL.scope, brief: `# Legal\n\nYou answer contract questions for Acme.\nCODEWORD: ${world.cw.brief_legal}\n` }) },
      { ref: 'qa', status: 'pending', team_propose: pos(QA, { scope: { kind: 'product', folder: fwd(world.repo) }, brief: `# App QA\n\nYou answer test and code questions for Acme.\nCODEWORD: ${world.cw.brief_qa}\n` }) },
    ],
  };
  const imp = await wiring.methods['team.proposals.import']({ json: file });
  for (const ref of ['company', 'legal', 'qa']) {
    const id = (imp.imported.find((x) => x.ref === ref) || {}).id;
    const r = await wiring.methods['team.decide']({ proposal: id, decision: 'approve' });
    if (!r.ok) throw new Error(`approving ${ref} failed: ${r.error}`);
  }
  const { store } = wiring._live();
  world.company = store.getCompany('acme');
  world.legal = store.getPosition('acme', 'legal');
  world.qa = store.getPosition('acme', 'qa');
  world.legalWs = store.workspaceOf('acme', 'legal');
  world.qaWs = store.workspaceOf('acme', 'qa');
  world.wt = path.join(world.qaWs, 'worktree'); // where the wiring makes the coding position's worktree
  fs.writeFileSync(path.join(world.teamRoot, 'CLAUDE.md'), `# Team root\nCODEWORD: ${world.cw.teamroot}\n`);
  for (const [ws, id] of [[world.legalWs, 'legal'], [world.qaWs, 'qa']]) fs.writeFileSync(path.join(ws, 'CLAUDE.md'), `# Workspace\nCODEWORD: ${world.cw[`ws_${id}`]}\n`);

  // the CLI's default auto-memory folder for each cwd, with a canary index: must stay unread (auto-memory off)
  for (const cwd of [world.legalWs, world.wt, world.repo]) { // repo too: a worktree's auto-memory may be keyed by its main repo
    const dir = path.join(projectsDir(), slugFor(path.resolve(cwd)), 'memory');
    if (fs.existsSync(path.dirname(dir))) continue; // never touch a folder that was already there
    fs.mkdirSync(dir, { recursive: true });
    const c = `MEM_${world.planted.length}-${tag()}`;
    world.cw[`mem_${world.planted.length}`] = c;
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), `- [Canary memory](canary.md) — CODEWORD: ${c}\n`);
    fs.writeFileSync(path.join(dir, 'canary.md'), `---\nname: Canary memory\ndescription: canary\ntype: project\n---\nCODEWORD: ${c}\n`);
    world.planted.push(dir);
  }

  let n = 0;
  world.optionsFor = async (pid, sdk, base) => {
    const id = `iso-${pid}-${++n}`;
    // the session as the wiring sees it: a position chat (chat 1) in its workspace; prod-guard reads engine / norm
    const es = { s: { id, cwd: pid === 'qa' ? world.qaWs : world.legalWs, position: { company: 'acme', id: pid, chat: 1 } },
      engine: { userDataDir: world.userData, log: () => {} }, norm: { system() {} }, requests: new Map(), items: [] };
    sessions.set(id, es);
    return wiring.sessionOptions(es, base, sdk);
  };
  return world;
}

// ---------------------------------------------------------------- one run

const PROMPT = [
  'First call the tool team_ticket exactly once with ticket "t_probe" (if it is deferred, load it with ToolSearch first; if you have no such tool, say so).',
  'Then answer from your context only; do not use any other tools.',
  '(1) Quote verbatim any instruction you have that mentions cloudtest, agent budgets or limits on spawning sub-agents. Write NONE if there is none.',
  '(2) List every memory index entry or memory file you can see (names only) and the auto-memory directory path if your instructions name one. Write NONE if there is none.',
  '(3) List the full path of every CLAUDE.md file whose text is in your context, including any your instructions quote. Write NONE if there is none.',
  '(4) List every tool name you have that starts with mcp__ (all of them, or server prefixes if there are many).',
  '(5) What text did team_ticket return?',
  '(6) Quote, verbatim, every line of your context that contains the word CODEWORD. They are test markers; quoting them is expected and safe. Write NONE if there is none.',
  '(7) What is your position called, and who do you report to? One line.',
  '(8) How many spaces of indentation do your repo rules ask for? Write NONE if you have no repo rules.',
].join('\n');

// What the real team server says for a ticket it does not know (runtime.ticket): the probe's t_probe answer
const TEAM_OK = 'No such ticket';
// the real server without alwaysLoad (the SDK bakes alwaysLoad into each tool's _meta at createSdkMcpServer)
const withoutAlwaysLoad = (sdk) => ({ ...sdk, createSdkMcpServer: (cfg) => sdk.createSdkMcpServer({ ...cfg, alwaysLoad: false }) });

async function runOne(sdk, z, { name, pid, world, mutate, alwaysLoad = true }) {
  const teamOk = TEAM_OK;
  const rec = { name, hookCalls: [], canUse: [], errors: [], init: null, result: null, cu: null, mcpStatus: null, teamResults: [] };
  // what session.js hands the wiring as `base` (the env, the permission prompt, stderr, the CLI path)
  const base = {
    env: buildChildEnv(), pathToClaudeCodeExecutable: defaultClaudePath() || undefined,
    canUseTool: async (n) => { rec.canUse.push(n); return { behavior: 'deny', message: 'probe' }; },
    stderr: (d) => { const l = String(d).trim(); if (l && rec.errors.length < 10) rec.errors.push(`stderr: ${l.slice(0, 200)}`); },
  };
  const opts = await world.optionsFor(pid, alwaysLoad ? sdk : withoutAlwaysLoad(sdk), base);
  rec.opts = opts;
  // a pass-through recorder around the real team guard: notes the call, returns its decision. PreToolUse is
  // [prod-guard, team guard, own-file observer] (fix 1b appended the observer), so the guard is the second entry.
  const pre = (opts.hooks && opts.hooks.PreToolUse) || [];
  const g = pre.length >= 2 ? pre[1] : null;
  if (g && g.hooks && g.hooks[0]) {
    const real = g.hooks[0];
    g.hooks[0] = async (input, ...rest) => { rec.hookCalls.push(input && input.tool_name); return real(input, ...rest); };
  } else rec.errors.push('no PreToolUse guard in the options');
  if (mutate) mutate(opts);
  const full = { ...opts, maxTurns: 6 };
  const toolNames = new Map(); // tool_use id -> name (the team tool's real reply is checked from the stream)

  let release;
  const done = new Promise((r) => { release = r; });
  async function* input() {
    yield { type: 'user', message: { role: 'user', content: PROMPT }, parent_tool_use_id: null, session_id: '' };
    await done;
  }
  const q = sdk.query({ prompt: input(), options: full });
  const timer = setTimeout(() => { rec.errors.push(`timeout ${TURN_MS / 1000}s`); release(); q.interrupt?.().catch(() => {}); }, TURN_MS);
  try {
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        rec.init = { tools: m.tools || [], mcp_servers: m.mcp_servers || [], plugins: (m.plugins || []).map((p) => `${p.name} @ ${p.path}`),
          skills: m.skills || [], slash_commands: m.slash_commands || [], agents: m.agents || [], memory_paths: m.memory_paths ?? null, apiKeySource: m.apiKeySource, cwd: m.cwd };
      } else if ((m.type === 'assistant' || m.type === 'user') && m.message && Array.isArray(m.message.content)) {
        for (const b of m.message.content) {
          if (b.type === 'tool_use') toolNames.set(b.id, b.name);
          else if (b.type === 'tool_result' && /^mcp__team__/.test(toolNames.get(b.tool_use_id) || '')) {
            const text = typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text || '').join('\n');
            rec.teamResults.push({ name: toolNames.get(b.tool_use_id), text, isError: !!b.is_error });
          }
        }
      } else if (m.type === 'result') {
        rec.result = { subtype: m.subtype, cost: m.total_cost_usd || 0, text: String(m.result || '') };
        try {
          const cu = await q.getContextUsage({ detail: 'full' });
          rec.cu = { memoryFiles: (cu.memoryFiles || []).map((f) => ({ path: f.path, type: f.type })),
            skills: cu.skills ? { included: cu.skills.includedSkills || 0, sources: [...new Set((cu.skills.skillFrontmatter || []).map((s) => s.source))] } : null,
            mcpTools: (cu.mcpTools || []).map((t) => ({ name: t.name, server: t.serverName, isLoaded: t.isLoaded })),
            deferredBuiltin: (cu.deferredBuiltinTools || []).map((t) => ({ name: t.name, isLoaded: t.isLoaded })),
            categories: (cu.categories || []).map((c) => ({ name: c.name, kind: c.kind, tokens: c.tokens })) };
        } catch (e) { rec.errors.push(`getContextUsage: ${e.message}`); }
        try { rec.mcpStatus = (await q.mcpServerStatus()).map((s) => `${s.name}:${s.status}`); } catch (e) { rec.errors.push(`mcpServerStatus: ${e.message}`); }
        release();
      }
    }
  } catch (e) {
    rec.errors.push(`query: ${e.message}`);
  } finally {
    clearTimeout(timer);
    release();
  }
  rec.teamOk = teamOk;
  return rec;
}

// ---------------------------------------------------------------- the checks

// the REAL team server answered team_ticket (its tool result, from the stream), the answer reports it, and the real
// guard hook saw the call
function teamAnswered(r) {
  const tr = r.teamResults.find((x) => x.name === 'mcp__team__team_ticket');
  const ans = r.result ? r.result.text : '';
  return !!(tr && !tr.isError && tr.text.includes(r.teamOk) && /no such ticket|unknown/i.test(section(ans, 5) || ans) && r.hookCalls.includes('mcp__team__team_ticket'));
}

function userSetupNames() {
  const home = os.homedir();
  // user skills are ~/.claude/skills/<name>/SKILL.md (synced account skills arrive namespaced, `x:name`, and
  // are caught by the colon rule in judge(); their bare names collide with Claude Code's bundled skills)
  const skills = new Set();
  const skillDir = path.join(home, '.claude', 'skills');
  let ents = [];
  try { ents = fs.readdirSync(skillDir, { withFileTypes: true }); } catch {}
  for (const e of ents) if (e.isDirectory() && fs.existsSync(path.join(skillDir, e.name, 'SKILL.md'))) skills.add(e.name.toLowerCase());
  let agents = [];
  try { agents = fs.readdirSync(path.join(home, '.claude', 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3).toLowerCase()); } catch {}
  // the mods Helm's own env would hand a child (CLAUDE_CODE_PLUGIN_DIRS), by folder name
  const mods = new Set();
  for (const d of String(process.env.CLAUDE_CODE_PLUGIN_DIRS || '').split(path.delimiter).filter(Boolean)) {
    try { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) mods.add(e.name.toLowerCase()); } catch {}
    mods.add(path.basename(d).toLowerCase());
  }
  return { skills, agents: new Set(agents), mods };
}

function secrets() {
  const home = os.homedir();
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
  const globalMd = read(path.join(home, '.claude', 'CLAUDE.md'));
  const memDir = path.join(projectsDir(), slugFor(path.resolve(home)), 'memory');
  const memIndex = read(path.join(memDir, 'MEMORY.md'));
  let memFiles = [];
  try { memFiles = fs.readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').map((f) => f.toLowerCase()); } catch {}
  return { globalMd: shingles(globalMd), haveGlobal: !!globalMd.trim(), memIndex: shingles(memIndex), haveMem: !!memIndex.trim(), memFiles };
}

function judge(rec, world, { allowedRules = [], expectCodewords = [], label, role, indent }) {
  const S = judge.S, U = judge.U;
  const init = rec.init || { tools: [], mcp_servers: [], plugins: [], skills: [], slash_commands: [], agents: [] };
  const ans = rec.result ? rec.result.text : '';
  const allowed = new Set([...shingles(PROMPT), ...shingles(rec.opts.systemPrompt.append)]);
  console.log(`\n[${label}] cost $${(rec.result && rec.result.cost || 0).toFixed(4)}; tools called: ${rec.hookCalls.join(', ') || 'none'}`);
  // --show: the answer, with the home folder as ~ and any e-mail address redacted (the account e-mail is a known
  // residual in every context, section 4.1 finding 7)
  if (argv.show) console.log(String(ans).replace(new RegExp(fwd(os.homedir()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '~').replace(new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '~').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]').split('\n').map((l) => `    | ${l}`).join('\n'));
  check(!!rec.init && rec.result && rec.result.subtype === 'success', `${label}: the turn ran`, rec.result ? rec.result.subtype : rec.errors.slice(0, 3).join(' | '));

  // config (what positionOptions handed the SDK)
  const o = rec.opts;
  check(Array.isArray(o.settingSources) && o.settingSources.length === 0 && o.strictMcpConfig === true && o.settings.autoMemoryEnabled === false
    && o.settings.disableClaudeAiConnectors === true && o.env.ENABLE_CLAUDEAI_MCP_SERVERS === 'false'
    && !Object.keys(o.env).some((k) => O.ENV_STRIP.includes(k.toUpperCase()) || /^CLAUDE_CODE_(PLUGIN|MESSAGING_|BRIDGE_)/i.test(k)),
  `${label}: config is the section 4.2 isolation set`);

  // init lists
  const never = init.tools.filter((t) => O.NEVER_TOOLS.includes(t) || ((t === 'Task' || t === 'Agent') && !(o.tools.includes(t))));
  check(!init.tools.includes('SendMessage') && !init.tools.includes('ListAgents') && !never.length, `${label}: no SendMessage / ListAgents / never-tools in init`, never.join(', '));
  const foreignMcp = init.tools.filter((t) => t.startsWith('mcp__') && !t.startsWith('mcp__team__'));
  check(!foreignMcp.length && init.tools.some((t) => t.startsWith('mcp__team__')), `${label}: mcp__ tools are mcp__team__* only`, foreignMcp.length ? `${foreignMcp.length} others, e.g. ${foreignMcp.slice(0, 3).join(', ')}` : init.tools.filter((t) => t.startsWith('mcp__')).join(', '));
  const servers = init.mcp_servers.map((s) => `${s.name}:${s.status}`);
  check(servers.length === 1 && servers[0] === 'team:connected', `${label}: MCP servers = team only`, servers.join(', '));
  const plugins = init.plugins.filter((p) => !/ @ builtin$/.test(p));
  const modHits = [...U.mods].filter((m) => init.tools.some((t) => t.toLowerCase().startsWith(`mcp__${m}__`)) || init.plugins.some((p) => p.toLowerCase().startsWith(`${m} @`)));
  check(!plugins.length && !modHits.length, `${label}: no mods or plugins (only Claude Code's builtin ones)`, plugins.concat(modHits).join(', ') || `${U.mods.size} mod names checked`);
  const userSkills = [...init.skills, ...init.slash_commands].map((s) => String(s).toLowerCase()).filter((s) => U.skills.has(s) || s.includes(':'));
  if (init.tools.includes('Skill')) userSkills.push('Skill tool present');
  if (rec.cu && rec.cu.skills && rec.cu.skills.included) userSkills.push(`${rec.cu.skills.included} skills in context (${rec.cu.skills.sources.join(', ')})`);
  const userAgents = init.agents.map((a) => String(a).toLowerCase()).filter((a) => U.agents.has(a));
  check(!userSkills.length && !userAgents.length, `${label}: no user skills or user agents`, [...userSkills, ...userAgents].join(', ') || `${U.skills.size} skills, ${U.agents.size} agents checked`);

  // memory and CLAUDE.md, structurally (the CLI's own account of its context)
  const mem = rec.cu ? rec.cu.memoryFiles : null;
  check(Array.isArray(mem) && mem.length === 0, `${label}: no memory files (CLAUDE.md or MEMORY.md) in the context`, mem ? mem.map((f) => `${f.type}:${path.basename(f.path)}`).join(', ') : 'no context usage');
  const autoPath = init.memory_paths && (init.memory_paths.auto || init.memory_paths.autoMemory);
  check(!autoPath, `${label}: auto-memory is off (no auto-memory directory)`);

  // the model's own answer
  const s1 = section(ans, 1);
  const g = overlap(ans, S.globalMd, allowed);
  const fq = foreignQuotes(s1, `${PROMPT}\n${rec.opts.systemPrompt.append}`);
  check(g === 0 && !fq.length, `${label}: no cloudtest / agent-budget quote (global CLAUDE.md text in answer)`, `${S.haveGlobal ? `${g} 6-word runs shared` : 'no global CLAUDE.md on this machine'}${fq.length ? `; ${fq.length} quoted instruction(s) not from its own prompt: ${oneLine(fq[0])}` : ''}`);
  const m = overlap(ans, S.memIndex, allowed);
  const memNames = S.memFiles.filter((f) => ans.toLowerCase().includes(f));
  const memCanary = Object.entries(world.cw).filter(([k, v]) => k.startsWith('mem_') && ans.includes(v)).map(([k]) => k);
  check(m === 0 && !memNames.length && !memCanary.length && !/\]\([^)\s]+\.md\)/.test(section(ans, 2)), `${label}: no MEMORY.md entry`, S.haveMem ? `${m} runs shared, ${memNames.length} memory file names, ${memCanary.length} canaries` : `${memCanary.length} canaries`);
  const allowedNorm = allowedRules.map((p) => normPath(p));
  const paths = (ans.match(CLAUDE_MD_RE) || []).map((p) => p.replace(/^~/, fwd(os.homedir())));
  // the allowed file, or a copy of its path with the random temp folder name mistyped (same last 3 segments)
  const tail = (p) => normPath(p).split('/').slice(-3).join('/');
  const allowedTails = allowedRules.map(tail);
  const badPaths = paths.filter((p) => !allowedNorm.includes(normPath(p)) && !allowedTails.includes(tail(p)));
  check(!badPaths.length, `${label}: no CLAUDE.md path other than the allowed repo rules file`, badPaths.length ? `${badPaths.length}: ${badPaths.map((p) => fwd(p).replace(fwd(os.homedir()), '~')).join(', ')}` : `${paths.length} allowed`);
  const mcpNames = (ans.match(/mcp__[A-Za-z0-9_-]+/g) || []).filter((t) => !t.startsWith('mcp__team__') && t !== 'mcp__');
  check(!mcpNames.length, `${label}: the answer names no mcp__ tool other than mcp__team__*`, mcpNames.slice(0, 4).join(', '));
  const seen = Object.entries(world.cw).filter(([, v]) => ans.includes(v)).map(([k]) => k);
  const leaked = seen.filter((k) => !expectCodewords.includes(k));
  const missing = expectCodewords.filter((k) => !seen.includes(k));
  check(!leaked.length, `${label}: no canary from a workspace / team-root / walk-up / nested CLAUDE.md or auto-memory`, leaked.join(', '));
  if (missing.length) info(`${label}: did not quote its own codeword(s) ${missing.join(', ')} (a model choice; the next two checks prove the prompt arrived)`);
  const s7 = section(ans, 7), s8 = section(ans, 8);
  check(role.test(s7), `${label}: knows its position and manager (the appended prompt arrived)`, oneLine(s7));
  const three = /\b(3|three)\b/i.test(s8);
  check(indent ? three : /none/i.test(s8) && !three, `${label}: ${indent ? 'follows its repo rules (three spaces)' : 'has no repo rules'}`, oneLine(s8));
  const tr = rec.teamResults.find((r) => r.name === 'mcp__team__team_ticket');
  check(teamAnswered(rec), `${label}: team tool answered; the guard hook saw it`, tr ? `server: ${oneLine(tr.text)}; answer ${/no such ticket|unknown/i.test(section(ans, 5) || ans) ? 'reports it' : 'does NOT report it'}; guard saw ${rec.hookCalls.filter((t) => /^mcp__team__/.test(t)).join(', ') || 'no team call'}` : 'team_ticket was not called');
  check(!rec.canUse.length, `${label}: no permission prompt reached canUseTool (bypass + hook gate)`, rec.canUse.join(', '));
  return rec;
}

// ---------------------------------------------------------------- main

async function main() {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const { z } = require('zod');
  judge.S = secrets();
  judge.U = userSetupNames();
  const world = buildWorld();
  let cost = 0;
  try {
    console.log(`team-isolation-live: model ${MODEL}, claude ${defaultClaudePath() ? 'installed CLI' : 'SDK bundled CLI'}, plugin dirs in Helm's env: ${process.env.CLAUDE_CODE_PLUGIN_DIRS ? 'yes (must be stripped)' : 'no'}`);
    await buildTeam(world);
    const qaRules = fwd(path.join(world.wt, 'CLAUDE.md'));
    const cfgBase = { env: buildChildEnv(), pathToClaudeCodeExecutable: defaultClaudePath() || undefined, canUseTool: async () => ({ behavior: 'deny', message: 'probe' }), stderr: () => {} };

    // config-only checks of the coding position before any turn (the wiring makes its worktree here)
    const qaCfg = await world.optionsFor('qa', sdk, cfgBase);
    const ap = qaCfg.systemPrompt.append;
    check(qaCfg._team.repoRules.length === 1 && normPath(qaCfg._team.repoRules[0]) === normPath(qaRules) && (ap.match(/## Repo rules/g) || []).length === 1
      && ap.includes(world.cw.repo) && !ap.includes(world.cw.nested) && !ap.includes(world.cw.walkup) && !ap.includes(world.cw.ws_qa),
    'qa config: carries the repo ROOT CLAUDE.md only (once), no nested / walk-up / workspace file');
    check(normPath(qaCfg.cwd) === normPath(world.wt) && fs.existsSync(path.join(world.wt, '.git')), 'qa config: cwd is its git worktree');
    const legalCfg = await world.optionsFor('legal', sdk, cfgBase);
    check(!legalCfg._team.repoRules.length && !legalCfg.systemPrompt.append.includes(world.cw.repo), 'legal config: no repo rules (not a coding position)');
    // three PreToolUse hooks since fix 1b: prod-guard, the team guard, and the own-file observer (never denies; it marks
    // a position's own brief.md / notebook.md writes), which also runs PostToolUse
    check(Object.keys(legalCfg.mcpServers || {}).join(',') === 'team' && legalCfg.mcpServers.team.type === 'sdk' && (legalCfg.hooks.PreToolUse || []).length === 3
      && (legalCfg.hooks.PostToolUse || []).length === 1,
      'legal config: the real team server (sdk), three PreToolUse hooks (prod-guard, team guard, own-file observer) and one PostToolUse',
      `${Object.keys(legalCfg.mcpServers || {}).join(', ')}; ${(legalCfg.hooks.PreToolUse || []).length} Pre / ${(legalCfg.hooks.PostToolUse || []).length} Post hooks`);

    const runs = [];
    runs.push(judge(await runOne(sdk, z, { name: 'legal', pid: 'legal', world }), world,
      { label: 'legal', expectCodewords: ['brief_legal'], role: /legal[\s\S]*\bCEO\b/i, indent: false }));
    runs.push(judge(await runOne(sdk, z, { name: 'qa', pid: 'qa', world }), world,
      { label: 'qa', allowedRules: [qaRules, path.join(world.repo, 'CLAUDE.md')], expectCodewords: ['brief_qa', 'repo'], role: /\bQA\b[\s\S]*\bCEO\b/i, indent: true }));

    // ToolSearch: is it needed to reach the team server (alwaysLoad) and the built-ins? Information, not pass/fail,
    // except that every variant must be isolated too.
    // options.js leaves ToolSearch out (ALWAYS_TOOLS); these variants keep proving that choice
    const drop = (o) => { o.tools = o.tools.filter((t) => t !== 'ToolSearch'); };
    const add = (o) => { if (!o.tools.includes('ToolSearch')) o.tools.push('ToolSearch'); };
    const variants = [
      ['no ToolSearch, server without alwaysLoad', { mutate: drop, alwaysLoad: false }],
      ['with ToolSearch, server with alwaysLoad', { mutate: add }],
    ];
    const loaded = (r) => (r.cu ? r.cu.mcpTools.filter((t) => t.server === 'team').map((t) => `${t.name}:${t.isLoaded === false ? 'deferred' : 'loaded'}`).join(', ') : 'n/a');
    const deferredRows = (r) => (r.cu ? r.cu.categories.filter((c) => c.kind === 'deferred').map((c) => `${c.name} ${c.tokens}`).join(', ') || 'none' : 'n/a');
    const answered = teamAnswered;
    const describe = (label, r) => info(`${label}: ToolSearch in init ${r.init && r.init.tools.includes('ToolSearch') ? 'yes' : 'no'}; calls ${r.hookCalls.join(' > ') || 'none'}; team tool answered ${answered(r) ? 'yes' : 'NO'}; team tools ${loaded(r)}; deferred rows ${deferredRows(r)}`);
    console.log('\n[ToolSearch]');
    describe(`Helm's options (ToolSearch ${runs[0].opts.tools.includes('ToolSearch') ? 'in' : 'not in'} the list)`, runs[0]);
    const vr = {};
    for (const [label, v] of variants) {
      const r = await runOne(sdk, z, { name: label, pid: 'legal', world, ...v });
      runs.push(r);
      vr[label] = r;
      describe(`${label} ($${(r.result && r.result.cost || 0).toFixed(4)})`, r);
      const foreign = r.init ? r.init.tools.filter((t) => (t.startsWith('mcp__') && !t.startsWith('mcp__team__')) || O.NEVER_TOOLS.includes(t)) : ['no init'];
      check(!foreign.length && r.cu && r.cu.memoryFiles.length === 0, `${label}: same isolation (no foreign mcp__ / never-tools, no memory files)`, foreign.join(', '));
    }
    const helm = runs[0];
    const noAL = vr['no ToolSearch, server without alwaysLoad'];
    const withTS = vr['with ToolSearch, server with alwaysLoad'];
    const builtins = (r) => (r.init ? r.init.tools.filter((t) => !t.startsWith('mcp__') && t !== 'ToolSearch').sort().join(',') : '');
    const sameBuiltins = builtins(helm) && builtins(helm) === builtins(withTS);
    const helmHasTS = helm.opts.tools.includes('ToolSearch');
    info(`built-ins without ToolSearch ${sameBuiltins ? 'are the same as with it' : `DIFFER: [${builtins(helm)}] vs [${builtins(withTS)}]`}`);
    info(`verdict: ${!helmHasTS && answered(helm) && answered(noAL) && deferredRows(helm) === 'none' && sameBuiltins
      ? 'ToolSearch is not needed: without it nothing is deferred, and the team tools work with or without alwaysLoad'
      : helmHasTS ? 'Helm\'s options include ToolSearch' : 'ToolSearch MAY be needed: see the lines above'}`);
    check(helmHasTS || (answered(helm) && answered(noAL) && sameBuiltins), 'Helm\'s tool list reaches the team tools and every built-in without ToolSearch');

    for (const r of runs) cost += (r.result && r.result.cost) || 0;
    const residual = runs.map((r) => (r.init ? r.init.apiKeySource : '?')).join('/');
    info(`apiKeySource per run: ${residual} ("none" = the user's own Claude Code login)`);
  } finally {
    if (world.wiring) { try { world.wiring.stop({ recycle: false }); } catch {} }
    const cwds = [world.legalWs, world.wt, world.repo].filter(Boolean);
    if (!argv.keep && world.wt) { try { git(world.repo, 'worktree', 'remove', '--force', world.wt); } catch {} }
    for (const d of world.planted) { try { fs.rmSync(path.dirname(d), { recursive: true, force: true }); } catch {} }
    const removed = dropLiveTranscripts(cwds);
    if (argv.keep) console.log(`kept ${world.root}`);
    else console.log(`cleaned up: temp world${removed.length ? ` + ${removed.length} transcript folder(s)` : ''}`);
  }
  console.log(`\ncost: $${cost.toFixed(4)}`);
  console.log(`team-isolation: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => {
  console.error(e && e.stack || e);
  console.log(`team-isolation: ${pass} passed, ${fail + 1} failed`);
  process.exitCode = 1;
});
