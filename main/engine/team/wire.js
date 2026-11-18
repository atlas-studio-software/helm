'use strict';
// Positions: the engine wiring (docs/POSITIONS.md 12 "T9", PROTOCOL "Positions"). index.js creates ONE of these; it
// owns the team store, runtime, duties (+ refs-watch inside duties), proposals and access requests, builds each
// session's `team` MCP server and position options, and answers every `team.*` RPC.
//
// Positions is OFF by default (settings team.enabled false). While off nothing here is created: no store, no watch,
// no timers, no team server on any session; team.list still answers ({ enabled: false, root, rootProblem? }) and every
// other team.* method rejects with code `disabled`. A position chat never starts while Positions is off (it would run
// with the owner's full setup): its CLI start fails with that reason instead.
//
//   const team = createTeamWiring({
//     settings: () => settings.team,             the team.* settings (main/settings.js TEAM_DEFAULTS shape)
//     root: () => resolved team root,
//     rootProblem: (companyFolders) => text | null,   main/settings.js teamRootProblem for the root in force
//     userDataDir, log, emit, notify,
//     sessions: Map(id -> EngineSession), viewedBy(id) -> client key | null,
//     createSession({ cwd, title, model, effort, position }) -> EngineSession     (index.js: registered + announced)
//     handoff({ id, prompt }) -> Promise<{ text }>,                               (handoff.js, the rollover prompt)
//     usagePct() -> number | null, claudePath, openPath?(dir) -> Promise,
//     loadSdk() -> Promise<sdk>, z?, clock?, home?, ownerName? (fallback when settings team.ownerName is empty)
//   });
//   team.start() / team.stop() / team.refresh()          settings changes call refresh()
//   team.prepare()                                        the layer without running it (the engine's re-attach pass)
//   team.sessionOptions(es, base, sdk, { keep, reattach }) -> SDK options   session.js _start (keep: the CLI goes to
//                                                         the broker; reattach: rebuilt for a CLI kept through a restart)
//   team.beforeSend(es, { text, origin, lastShownId })   typed approval (6.3)
//   team.seedFor(es) -> '<position-seed>…' | null         a chat's first message (8.1)
//   team.noteTurnEnd(es)                                  delivery queues + rollover
//   team.methods                                          { 'team.list': fn, ... }
//   team.companyFolders() / team.excludeDirs() / team.poke(reason) / team.status()

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { writeJsonAtomic } = require('../util');
const S = require('./schema');
const { ownerWords } = require('./owner');
const { teamEvent } = require('./notice');

const DEFAULTS = Object.freeze({ enabled: false, root: '~/helm-team', maxConcurrentRuns: 2, usageCeilingPct: 80, dutiesPaused: false,
  rollPct: 32, rollNowPct: 40, askWaitS: 300, askWaitPositionS: 180, askWaitMaxS: 600 });
const ACCESS_WAIT_MS = 30 * 60_000;

function codeErr(message, code) { return Object.assign(new Error(message), { code }); }
const bad = (m) => codeErr(m, 'bad_params');
const safe = (fn, fb) => { try { return fn(); } catch { return fb; } };
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const idOk = (v) => typeof v === 'string' && /^[a-z0-9-]{1,40}$/.test(v);

// team-state.json (<userData>, Helm's own: losing it loses nothing the owner wrote). Slices by name; writes debounced.
function createStateFile(file, log) {
  let data = {};
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (isObj(j)) data = j; } catch (e) { if (e.code !== 'ENOENT') log('warn', `team: team-state.json unreadable (${e.message}); starting empty`); }
  let timer = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    try { writeJsonAtomic(file, data); } catch (e) { log('warn', `team: could not save team-state.json: ${e.message}`); }
  };
  return {
    get: (k) => (data[k] === undefined ? undefined : JSON.parse(JSON.stringify(data[k]))),
    set: (k, v) => {
      if (v === undefined) delete data[k]; else data[k] = JSON.parse(JSON.stringify(v));
      if (!timer) { timer = setTimeout(flush, 300); if (timer.unref) timer.unref(); }
    },
    flush,
  };
}

function createTeamWiring(o = {}) {
  const log = typeof o.log === 'function' ? o.log : () => {};
  const emit = typeof o.emit === 'function' ? o.emit : () => {};
  const sessions = o.sessions || new Map();
  const home = o.home || os.homedir();
  const settingsOf = () => ({ ...DEFAULTS, ...(safe(() => o.settings && o.settings(), null) || {}) });
  // what positions call the owner: one getter for every module, read per message (owner.js; '' = "the owner")
  const ownerName = () => String(settingsOf().ownerName || o.ownerName || '');
  const rootOf = () => safe(() => o.root && o.root(), null) || path.join(home, 'helm-team');
  const getEs = (id) => { const es = typeof id === 'string' ? sessions.get(id) : null; return es && !es.removed ? es : null; };

  let live = null;          // { store, runtime, duties, proposals, access, state, root, offs }
  let problem = null;       // why the team could not start (root problem, store error)
  let startedRoot = null;
  const onboardReads = new Map(); // `${cid}/${pid}` -> [paths] read-only for an onboarding run (6.5 step 3)
  const worktrees = new Map();    // `${cid}/${pid}` -> { path, of, branch }
  const recentWrites = new Map(); // file path -> ms: the owner's own team.file.write (the watcher must not echo it)
  const opening = new Map();      // `${cid}/${pid}` -> Promise<es> (one lazy create at a time)

  const enabled = () => settingsOf().enabled === true;
  const companies = () => (live ? safe(() => live.store.listCompanies(), []) : []);
  const companyFolders = () => companies().flatMap((c) => c.folders || []);

  // ---------------------------------------------------------------- sessions
  function positionSessions(cid, pid) {
    return [...sessions.values()].filter((es) => !es.removed && es.s.position && es.s.position.company === cid && es.s.position.id === pid);
  }
  function current(cid, pid) {
    if (!live) return null;
    const chats = safe(() => live.store.readChats(cid, pid).chats, []) || [];
    const last = chats[chats.length - 1];
    if (last && !last.endedAt && last.helmSessionId) {
      const es = getEs(last.helmSessionId);
      if (es && !(es.s.position && es.s.position.ended)) return es;
    }
    return null;
  }
  // team.get `lastActivity` (ms epoch): the newest sign of use across the position's chats (chats.json), each chat's
  // Helm session `updatedAt` (last used: a message, a turn, a duty run, an answer) or, for a chat whose session is
  // gone, its `endedAt`. Not `startedAt` alone: an entry with neither says nothing about use. Never chatted: null.
  function lastActivityOf(cid, pid) {
    const chats = safe(() => live.store.readChats(cid, pid).chats, []) || [];
    let best = 0;
    for (const ch of chats) {
      const es = ch && ch.helmSessionId ? getEs(ch.helmSessionId) : null;
      const t = es && Number.isFinite(es.s.updatedAt) ? es.s.updatedAt : (ch && ch.endedAt ? Date.parse(ch.endedAt) : NaN);
      if (Number.isFinite(t) && t > best) best = t;
    }
    return best || null;
  }
  async function open(cid, pid) {
    const k = `${cid}/${pid}`;
    const have = current(cid, pid);
    if (have) return have;
    if (opening.has(k)) return opening.get(k);
    const p = (async () => {
      const { store } = live;
      const pos = store.getPosition(cid, pid);
      if (!pos) throw codeErr(`No position "${pid}" in ${cid}`, 'not_found');
      if (pos.status === 'retired') throw codeErr(`${pos.name} is retired`, 'refused');
      const c = store.getCompany(cid);
      const ws = store.workspaceOf(cid, pid);
      fs.mkdirSync(ws, { recursive: true });
      const entry = store.addChat(cid, pid, {});
      let es;
      try {
        es = await o.createSession({
          cwd: ws, title: pos.name, model: pos.model || undefined, effort: pos.effort || undefined,
          position: { company: cid, companyName: (c && c.name) || cid, id: pid, name: pos.name, parent: pos.parent == null ? null : pos.parent, chat: entry.n },
        });
      } catch (e) {
        // no session was made: the chat entry goes again, so chats.json never lists a chat no session belongs to
        // (the next open would otherwise number its chat one higher and seed it with a handoff that never ran)
        try {
          const left = (store.readChats(cid, pid).chats || []).filter((x) => x.n !== entry.n);
          store.writeChats(cid, pid, left);
        } catch (e2) { log('warn', `team: could not take back chat ${entry.n} of ${cid}/${pid}: ${e2.message}`); }
        throw e;
      }
      store.updateChat(cid, pid, entry.n, { helmSessionId: es.s.id });
      return es;
    })();
    opening.set(k, p);
    try { return await p; } finally { opening.delete(k); }
  }
  function ceoSessions(cid) {
    return [...sessions.values()].filter((es) => !es.removed && !es.s.archived && es.s.team && es.s.team.company === cid).map((es) => es.s.id);
  }
  function emitSession(es) {
    try { if (typeof es._emitUpdated === 'function') es._emitUpdated(); } catch {}
    try { if (o.save) o.save(); } catch {}
  }
  function idle(es) { return !!es && !es.turnActive && !es.starting && !(es.requests && es.requests.size) && !(es.pendingQueue && es.pendingQueue.length); }
  // Close the idle CLIs `pred` picks, resumable: the next send restarts them with (or without) the team server.
  function recycle(pred) {
    for (const es of sessions.values()) {
      if (es.removed || !(es.live && es.live()) || safe(() => es.busyState(), true) || !pred(es)) continue;
      es.close({ final: false }).catch((e) => log('warn', `team: recycle ${es.s.id} failed: ${e.message}`));
    }
  }
  function note(sid, text, { wake = false } = {}) {
    const es = getEs(sid);
    if (!es || !text) return;
    if (wake && idle(es) && (!es.s.position || !es.s.position.ended)) {
      es.send({ text: String(text), origin: 'helm' }).catch((e) => log('warn', `team: wake ${sid} failed: ${e.message}`));
      return;
    }
    es.addHelmNote(text);
  }

  // ---------------------------------------------------------------- powers (guard + options)
  // Never blocks the main process: git runs async (execFile), its output captured (git's "Preparing worktree" goes
  // nowhere) and logged only when it fails. One run per position at a time (two CLI starts share it).
  const worktreeRuns = new Map(); // `${cid}/${pid}` -> Promise<{ path, of, branch }>
  function gitRun(args) {
    return new Promise((resolve, reject) => {
      execFile('git', args, { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve(String(stdout || '').trim());
      });
    });
  }
  function worktreeFor(cid, pid, pos) {
    const k = `${cid}/${pid}`;
    if (worktreeRuns.has(k)) return worktreeRuns.get(k);
    const p = (async () => {
      const ws = live.store.workspaceOf(cid, pid);
      const wt = path.join(ws, 'worktree');
      const folder = pos.scope && pos.scope.folder ? S.expandHome(pos.scope.folder) : null;
      if (!folder) throw codeErr(`${pos.name} works in a git worktree, but its scope names no repo folder`, 'worktree_missing');
      const git = async (args) => {
        try { return await gitRun(args); } catch (e) {
          const out = String(e.stderr || e.stdout || '').trim().slice(0, 2000);
          log('warn', `team: git ${args.join(' ')} failed: ${e.message.split('\n')[0]}${out ? ` | ${out}` : ''}`);
          throw codeErr(`${pos.name}'s git worktree could not be made: ${(out.split('\n').pop() || e.message).slice(0, 300)}`, 'worktree_missing');
        }
      };
      const of = await git(['-C', folder, 'rev-parse', '--show-toplevel']);
      const branch = `team/${cid}/${pid}`;
      if (!fs.existsSync(path.join(wt, '.git'))) {
        const has = await gitRun(['-C', of, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
        await git(['-C', of, 'worktree', 'add', ...(has ? [wt, branch] : ['-b', branch, wt])]);
        log('info', `team: made worktree ${wt} (${branch}) of ${of}`);
      }
      const w = { path: wt, of, branch };
      worktrees.set(k, w);
      return w;
    })();
    worktreeRuns.set(k, p);
    const done = () => { if (worktreeRuns.get(k) === p) worktreeRuns.delete(k); };
    p.then(done, done);
    return p;
  }
  function powersFor(cid, pid, es) {
    const { store } = live;
    const pos = store.getPosition(cid, pid);
    if (!pos || pos.status === 'retired') return null;
    const eff = store.effectivePowers(cid, pid);
    if (!eff) return null;
    const c = store.getCompany(cid);
    const extra = onboardReads.get(`${cid}/${pid}`) || [];
    const wt = worktrees.get(`${cid}/${pid}`);
    return {
      ...eff, read: [...(eff.read || []), ...extra], ...(es ? { cwd: es.s.cwd } : {}),
      companyFolders: (c && c.folders) || [], scopeFolder: (pos.scope && pos.scope.folder) || null,
      ...(eff.worktree && wt ? { worktreePath: wt.path, worktreeOf: wt.of } : {}),
    };
  }
  function guardPowers(sid) {
    if (!live) return null;
    const es = getEs(sid);
    const p = es && es.s.position;
    if (!p || p.ended) return null;
    return powersFor(p.company, p.id, es);
  }

  // A position's own writes to its brief.md / notebook.md: the store's change events do not say who wrote, so these
  // open the runtime's own-write window (noteOwnWrite, ~15 s) and onStoreChange stays quiet instead of telling the
  // position "the owner changed your brief" (false). The team guard notes allowed Edit / Write on notebook.md itself
  // (and denies brief.md writes); this observer adds what the guard cannot see: a shell command that names either
  // file, noted before it runs AND after it ends (a write early in a long command, and a change event landing after
  // the result, are both covered), and a file tool's completed write to either file in the workspace. Best-effort by
  // design: a script that writes brief.md without naming it is missed, and a command that only reads the file hides
  // an owner edit landing in the same window. It only observes: every call answers {} (no decision).
  const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
  const OWN_FILE_TOOLS = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path' };
  const OWN_NAME_RE = /\b(brief|notebook)\.md\b/gi;
  function ownFileName(file) {
    const b = path.basename(String(file || '')).toLowerCase();
    return b === 'brief.md' || b === 'notebook.md' ? b : null;
  }
  function ownFileHooks(cid, pid, workspace) {
    const mark = (f) => { if (live) safe(() => live.runtime.noteOwnWrite(cid, pid, f), null); };
    const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    const named = (input) => (SHELL_TOOLS.has(input && input.tool_name)
      ? [...new Set([...String((input.tool_input && input.tool_input.command) || '').matchAll(OWN_NAME_RE)].map((m) => `${m[1].toLowerCase()}.md`))]
      : []);
    const written = (input) => {
      const key = OWN_FILE_TOOLS[input && input.tool_name];
      const f = key && input.tool_input && input.tool_input[key];
      if (typeof f !== 'string' || !f) return null;
      const abs = path.resolve(String(input.cwd || workspace), S.expandHome(f, home));
      const name = ownFileName(abs);
      return name && S.pathKey(real(path.dirname(abs))) === S.pathKey(real(workspace)) ? name : null;
    };
    const pre = async (input) => { try { for (const f of named(input)) mark(f); } catch {} return {}; };
    const post = async (input) => {
      try { for (const f of named(input)) mark(f); const w = written(input); if (w) mark(w); } catch {}
      return {};
    };
    return { pre: { hooks: [pre] }, post: { hooks: [post] } };
  }

  // ---------------------------------------------------------------- the team server's ports
  // The runtime with the owner's wait settings applied (round-2 note 3): a missing wait_s takes askWaitS (CEO) or
  // askWaitPositionS; every wait is clamped to askWaitMaxS.
  function runtimePort(runtime) {
    const waitOf = (raw, fromKind) => {
      const st = settingsOf();
      const n = Number(raw);
      const def = fromKind === 'ceo' ? st.askWaitS : st.askWaitPositionS;
      return Math.min(st.askWaitMaxS, Number.isFinite(n) && n > 0 ? n : def);
    };
    return new Proxy(runtime, {
      get(t, k) {
        if (k === 'ask') return (p = {}) => t.ask({ ...p, waitS: waitOf(p.waitS, p.from && p.from.kind) });
        if (k === 'ticket') return (id, opt = {}) => t.ticket(id, { ...opt, ...(opt.waitS != null ? { waitS: Math.min(settingsOf().askWaitMaxS, Number(opt.waitS) || 0) } : {}) });
        return t[k];
      },
    });
  }
  function dutiesPort() {
    return {
      nextDuty: (cid, pid) => safe(() => live.duties.nextDuty(cid, pid), null),
      report: ({ company, position, summary, needsOwen, files, ticket, sessionId }) => {
        const pos = safe(() => live.store.getPosition(company, position), null);
        const entry = { at: new Date().toISOString(), id: `n_${crypto.randomBytes(3).toString('hex')}`, position, kind: 'duty-report',
          title: `${(pos && pos.name) || position}: report`, text: String(summary || '').slice(0, 20_000), ...(files && files.length ? { files } : {}), needsOwen: !!needsOwen, ...(ticket ? { ticket } : {}) };
        inboxAppend(company, entry);
        // every report notifies once (duties.js stays quiet for a run that called duty_report): "<position>: <duty> is done"
        const co = safe(() => live.store.getCompany(company), null);
        const t = ticket ? safe(() => live.runtime.get(ticket), null) : null;
        safe(() => emit('notify', teamEvent({ what: 'duty', subject: (t && t.duty && t.duty.title) || null, detail: entry.text.slice(0, 400),
          company: { id: company, name: co && co.name }, position: { id: position, name: (pos && pos.name) || position }, sessionId })), null);
      },
    };
  }
  function inboxAppend(cid, entry) {
    try { live.store.append(cid, 'inbox', entry); } catch (e) { log('warn', `team: inbox line failed: ${e.message}`); return; }
    emit('team.inbox.appended', { company: cid, entry });
  }
  function serverFor(ctx, sdk) {
    const { createTeamServer } = require('./mcp');
    return createTeamServer(ctx, {
      sdk, z: o.z, runtime: runtimePort(live.runtime), store: live.store, proposals: live.proposals,
      access: live.access, duties: dutiesPort(), log, ownerName,
    });
  }

  // ---------------------------------------------------------------- session options (session.js _start)
  async function sessionOptions(es, base, sdk, hint = {}) {
    const pos = es.s.position;
    // the re-attach pass runs before start(): a kept CEO or position chat needs the layer (not running yet) now
    if (hint && hint.reattach && !live) prepare();
    if (pos) {
      if (!live) throw codeErr(problem && enabled() ? `Positions could not start: ${problem}` : 'Positions is off. Turn it on in Settings > Team to use this chat.', 'disabled');
      if (pos.ended) throw codeErr(`This chat of ${pos.name || pos.id} has ended; the position goes on in its newest chat.`, 'refused');
      const { store } = live;
      const cid = pos.company, pid = pos.id;
      const p = store.getPosition(cid, pid);
      if (!p || p.status === 'retired') throw codeErr(`${(p && p.name) || pid} is retired`, 'refused');
      const company = store.getCompany(cid);
      const eff0 = store.effectivePowers(cid, pid);
      const worktree = eff0 && eff0.worktree ? await worktreeFor(cid, pid, p) : null;
      const eff = powersFor(cid, pid, es);
      const { positionOptions } = require('./options');
      const teamGuard = require('./guard');
      const prodGuard = require('../prod-guard');
      const chats = safe(() => store.readChats(cid, pid).chats, []) || [];
      const chat = chats.find((c) => c.n === pos.chat) || { n: pos.chat || 1 };
      const tr = store.tree(cid);
      const guard = teamGuard.createHook({
        ownerName,
        sessionId: es.s.id, home,
        getEffectivePowers: (sid) => guardPowers(sid),
        consumeGrant: (sid, need) => (live && live.access ? live.access.consumeGrant(sid, need) : null),
        requestApproval: (req) => (live && live.access ? live.access.requestApproval(req) : Promise.resolve({ behavior: 'deny', message: 'Positions is off.' })),
        handedReads: (sid) => (live ? safe(() => live.runtime.handedReads(sid), []) || [] : []),
        noteOwnWrite: (sid, file) => { const f = ownFileName(file); if (live && f) safe(() => live.runtime.noteOwnWrite(cid, pid, f), null); },
        log,
      });
      const opts = positionOptions(p, eff, chat, {
        workspace: store.workspaceOf(cid, pid), server: serverFor({ kind: 'position', company: cid, position: pid, sessionId: es.s.id }, sdk),
        preToolUse: [prodGuard.createHook(es), guard], worktree, company,
        manager: p.parent ? safe(() => store.getPosition(cid, p.parent), null) : null,
        reports: (safe(() => tr.reports(pid), []) || []).map((id) => safe(() => store.getPosition(cid, id), null)).filter(Boolean),
        teamRoot: live.root, baseEnv: base.env, claudePath: o.claudePath || base.pathToClaudeCodeExecutable,
        canUseTool: base.canUseTool, stderr: base.stderr, home, ownerName,
      });
      const own = ownFileHooks(cid, pid, store.workspaceOf(cid, pid));
      const hk = opts.hooks || {};
      opts.hooks = { ...hk, PreToolUse: [...(hk.PreToolUse || []), own.pre], PostToolUse: [...(hk.PostToolUse || []), own.post] };
      if (opts.cwd && opts.cwd !== es.s.cwd && fs.existsSync(opts.cwd)) log('info', `team: ${es.s.id} runs in ${opts.cwd}`);
      // session.js checks this before it re-attaches a kept position: its guard is in the hooks the CLI gets
      if ((opts.hooks.PreToolUse || []).includes(guard)) Object.defineProperty(opts, '_teamGuarded', { value: true, enumerable: false });
      es.teamAttached = 'position';
      es.teamBuiltOn = live;
      return opts;
    }
    if (!live) {
      if (es.s.team) { delete es.s.team; emitSession(es); }
      return base;
    }
    // A normal session: the CEO of the company its folder is in (3), or a session in no company (it may propose one).
    try {
      const { companyFor } = require('./match');
      const c = companyFor(es.s.cwd, live.store.listCompanies(), { teamRoot: live.root });
      const was = es.s.team ? es.s.team.company : null;
      if (c) es.s.team = { company: c.id, companyName: c.name }; else delete es.s.team;
      if ((c ? c.id : null) !== was) emitSession(es);
      // Keep-through-restart (hint.keep: this CLI goes to the CLI broker). The server lives in THIS Helm process; a CLI
      // kept through a restart gets it rebuilt by the next Helm: the re-attach (hint.reattach, session.js) builds the
      // same server again, the repeated initialize names it, and the CLI, which keeps its MCP client for it, sends
      // its tools/call to the new one (a call the old Helm never answered is re-delivered by the broker, broker.js).
      // So a CEO chat keeps its server AND is kept. A chat in no company still runs WITHOUT the server when kept: its
      // only team tool is the deferred team_propose (action "company"), a rare convenience (an imported proposals
      // file does the same), and such a chat must not depend on the team layer to survive a restart (a re-attach
      // needs the rebuilt server, so Positions turned off in between would stop it).
      if (!c && hint && hint.keep) { es.teamAttached = null; return base; }
      const server = serverFor(c ? { kind: 'ceo', company: c.id, sessionId: es.s.id } : { kind: 'none', sessionId: es.s.id }, sdk);
      es.teamAttached = c ? 'ceo' : 'none';
      es.teamBuiltOn = live;
      return { ...base, mcpServers: { ...(base.mcpServers || {}), team: server } };
    } catch (e) {
      log('warn', `team: no team server for ${es.s.id}: ${e.message}`);
      return base;
    }
  }

  function seedFor(es) {
    const pos = es.s.position;
    if (!live || !pos || pos.seeded || pos.ended) return null;
    const { positionSeed } = require('./options');
    const { store } = live;
    const nb = safe(() => store.readNotebook(pos.company, pos.id), null);
    const chats = safe(() => store.readChats(pos.company, pos.id).chats, []) || [];
    const prev = [...chats].reverse().find((c) => c.n < (pos.chat || 1));
    const seed = positionSeed({
      chatN: pos.chat || 1, notebook: (nb && nb.text) || '',
      notebookPath: path.join(store.workspaceOf(pos.company, pos.id), 'notebook.md'),
      handoff: prev ? prev.handoff || null : null, handoffFailed: prev && !prev.handoff ? prev.handoffError || prev.endReason || null : null,
    });
    es.s.position = { ...pos, seeded: true };
    emitSession(es);
    return seed;
  }

  function beforeSend(es, { text, origin, lastShownId }) {
    if (!live || !live.proposals || typeof live.proposals.onUserMessage !== 'function') return;
    live.proposals.onUserMessage({ sessionId: es.s.id, text, origin, lastShownId });
  }
  function noteTurnEnd(es) { if (live) live.runtime.noteTurnEnd(es.s.id); }

  // ---------------------------------------------------------------- start / stop
  // prepare(): the team layer exists (store, runtime with its tickets loaded, proposals, access, duties) but nothing
  // in it runs yet: no delivery, recovery, duty, file watch or recycle. The engine's re-attach pass needs that much
  // (a kept CEO or position chat gets its team server and guard rebuilt from it, and a team_ask the broker
  // re-delivers finds its ticket) before start() lets the layer run; start() alone does both.
  function prepare() {
    if (live) return true;
    if (!enabled()) return false;
    const root = rootOf();
    const why = safe(() => (o.rootProblem ? o.rootProblem([]) : null), null);
    if (why) { problem = why; log('warn', `team: Positions is on but the team folder can't be used: ${why}`); return false; }
    let store;
    try {
      const { createTeamStore } = require('./store');
      store = createTeamStore({ root });
      store.ensureRoot();
    } catch (e) { problem = e.message; log('warn', `team: could not open the team folder ${root}: ${e.message}`); return false; }
    const state = createStateFile(path.join(o.userDataDir || os.tmpdir(), 'team-state.json'), log);
    const L = { store, state, root: store.root, offs: [] };
    live = L;
    problem = null;
    startedRoot = root;
    try {
      const { createRuntime } = require('./runtime');
      const st = settingsOf();
      const testRoll = o.testMode && Number(process.env.HELM_TEST_TEAM_ROLL_PCT) > 0 ? Number(process.env.HELM_TEST_TEAM_ROLL_PCT) : null;
      L.runtime = createRuntime({
        ownerName,
        store, state, log,
        emit: (ev, d) => { emit(ev, d); if (ev === 'team.ask.updated') safe(() => patchAsk(d), null); },
        settings: () => settingsOf(),
        rollPct: testRoll || st.rollPct, ceilingPct: testRoll ? Math.max(testRoll + 1, st.rollNowPct) : st.rollNowPct,
        inbox: (cid, entry) => inboxAppend(cid, entry),
        // the read area a position may hand from (fix 2): the guard's own view, so its worktree and onboarding reads count
        readArea: (cid, pid) => powersFor(cid, pid, null),
        sessions: {
          get: (id) => getEs(id),
          current, open,
          isViewed: (id) => !!(o.viewedBy && o.viewedBy(id)),
          addCard: (sid, item) => { const es = getEs(sid); return es ? es.addCard(item) : null; },
          handoff: (es, prompt) => o.handoff({ id: es.s.id, prompt }),
          endChat: (x) => endChat(x),
          positionTurnsRunning: () => [...sessions.values()].filter((es) => es.s.position && (es.turnActive || es.starting)).length,
        },
      });
      const cardPort = {
        get: (id) => getEs(id),
        addCard: (sid, item) => { const es = getEs(sid); return es ? es.addCard(item) : null; },
        patchCard: (sid, key, patch) => { const es = getEs(sid); return es ? es.patchCard(key, patch) : false; },
        note, ceoSessions,
        positionSession: (cid, pid) => { const es = current(cid, pid); return es ? es.s.id : null; },
      };
      try {
        const { createProposals } = require('./proposals');
        L.proposals = createProposals({
          store, runtime: L.runtime, state, emit, log, sessions: cardPort,
          notify: (n) => emit('notify', { kind: 'waiting', source: 'team', ...n }),
          onboard: (x) => onboard(x), onApplied: (x) => onApplied(x),
          ownerName,
        });
      } catch (e) { log('warn', `team: proposals are off: ${e.message}`); L.proposals = null; }
      try {
        const { createAccess } = require('./access');
        L.access = createAccess({ store, sessions: cardPort, emit, log, waitMs: ACCESS_WAIT_MS, ownerName });
      } catch (e) { log('warn', `team: access requests are off: ${e.message}`); L.access = null; }
      const { createDuties } = require('./duties');
      L.duties = createDuties({
        listPositions: () => store.listCompanies().flatMap((company) => safe(() => store.listPositions(company.id), []).map((position) => ({ company, position }))),
        runDuty: (req) => L.runtime.runDuty(req),
        resumeRun: (t) => L.runtime.resumeRun(t),
        appendRun: (cid, line) => safe(() => store.append(cid, 'duty-runs', line), null),
        appendInbox: (cid, entry) => inboxAppend(cid, entry),
        notify: (n) => emit('notify', n),   // teamEvent shape (notice.js): failed or unreported duty runs
        settings: () => settingsOf(),
        usagePct: () => safe(() => (o.usagePct ? o.usagePct() : null), null),
        state, log,
        emit: (company) => emit('team.updated', { company }),
        ownerName,
      });
      L.runtime.prime(); // tickets loaded (a re-delivered team_ask finds its own); nothing delivered before start()
    } catch (e) {
      log('error', `team: Positions failed to start: ${e.stack || e.message}`);
      problem = e.message;
      stop();
      return false;
    }
    return true;
  }

  function start() {
    if (!enabled() || (live && live.running)) return false;
    if (!live && !prepare()) return false;
    const L = live;
    const { store } = L;
    L.running = true;
    try {
      store.watch();
      L.offs.push(store.on('change', (ev) => onStoreChange(ev)));
      for (const c of store.listCompanies()) safe(() => store.sweepRetired(c.id), null);
      L.runtime.start();
      L.duties.start();
      log('info', `team: Positions on (root ${store.root}, ${store.listCompanies().length} companies)`);
    } catch (e) {
      log('error', `team: Positions failed to start: ${e.stack || e.message}`);
      problem = e.message;
      stop();
      return false;
    }
    // idle CLIs pick up (or drop) the team server at their next start. Only a chat whose team setup changes now is
    // closed: one in a company (it becomes a CEO) or one still carrying a server from an earlier start. A chat in no
    // company would gain only the deferred team_propose, so it keeps its warm CLI (and a CLI kept through a restart
    // stays kept) and picks the tool up at its next natural start. A chat whose server was built on THIS layer (a
    // CEO chat the re-attach pass just kept) already has its setup.
    const { companyFor } = require('./match');
    const inCompany = (es) => !!safe(() => companyFor(es.s.cwd, store.listCompanies(), { teamRoot: store.root }), null);
    recycle((es) => !es.s.position && es.teamBuiltOn !== L && (!!es.teamAttached || inCompany(es)));
    return true;
  }

  function stop({ recycle: again = true } = {}) {
    const L = live;
    if (!L) return;
    live = null;
    for (const off of L.offs) safe(() => off(), null);
    for (const k of ['duties', 'access', 'runtime']) if (L[k] && typeof L[k].stop === 'function') safe(() => L[k].stop(), null);
    safe(() => L.store.close(), null);
    safe(() => L.state.flush(), null);
    if (again) recycle((es) => !!es.teamAttached);
  }

  function refresh() {
    if (!enabled()) { if (live) { stop(); log('info', 'team: Positions off'); } emit('team.updated', { company: null }); return; }
    if (live && rootOf() !== startedRoot) stop();
    if (!live || !live.running) start(); else safe(() => live.duties.refresh(), null);
    emit('team.updated', { company: null });
  }

  // PROTOCOL: the asker's mcp__team__* tool item carries the live ticket (team: { ticket, state, detail, chain }), patched
  // on every team.ask.updated: by the tool-use id when the CLI gave one, else that chat's running ask for this ticket.
  const ASK_TOOL_RE = /^mcp__team__(team_ask|colleague_ask|team_ticket)$/;
  function patchAsk(d) {
    if (!live || !d || !d.ticket) return;
    const t = live.runtime.get(d.ticket);
    const es = getEs(t && t.from && t.from.sessionId);
    if (!es || !es.norm) return;
    let it = d.toolUseId && typeof es.norm.toolItem === 'function' ? es.norm.toolItem(d.toolUseId) : null;
    if (!it) it = [...es.items].reverse().find((x) => x && x.type === 'tool' && ASK_TOOL_RE.test(x.name || '') && ((x.team && x.team.ticket === d.ticket) || (!x.team && x.status === 'running')));
    if (!it) return;
    es.norm.store.patch(it.id, { team: { ...(it.team || {}), ticket: d.ticket, state: d.state, detail: d.detail, chain: d.chain, company: d.company } });
  }

  // ---------------------------------------------------------------- runtime / proposals callbacks
  async function endChat({ company, position, sessionId, handoff, error, contextPct, reason }) {
    const es = getEs(sessionId);
    const n = es && es.s.position ? es.s.position.chat : null;
    if (n != null) {
      safe(() => live.store.updateChat(company, position, n, {
        endedAt: new Date().toISOString(), endReason: reason || (error ? 'failed' : 'full'),
        ...(contextPct != null ? { contextPct } : {}), ...(handoff ? { handoff: String(handoff).slice(0, 20_000) } : {}),
        ...(error ? { handoffError: String(error).slice(0, 300) } : {}),
      }), null);
    }
    if (es) {
      es.s.position = { ...es.s.position, ended: true };
      es.s.archived = true;
      emitSession(es);
      if (live && live.access) safe(() => live.access.cancelFor(es.s.id, 'This chat ended'), null);
      await es.close({ final: false }).catch(() => {});
    }
  }

  function onboard({ company, position, files }) {
    const list = (files || []).map((f) => (typeof f === 'string' ? f : f && f.path)).filter(Boolean).map((p) => S.expandHome(p));
    if (!list.length || !live) return;
    const k = `${company}/${position}`;
    onboardReads.set(k, list);
    const lines = (files || []).map((f) => `- ${typeof f === 'string' ? f : `${f.path}${f.why ? ` (${f.why})` : ''}`}`);
    const text = ['Onboarding: you are new in this role. Read these files (read-only for this run) and record what matters to your remit with notebook_add, mostly under Facts and Open items. Reply with a short summary when done.', '', ...lines].join('\n');
    try {
      const r = live.runtime.runDuty({ company, position, duty: { id: 'onboarding', title: 'Onboarding', trigger: 'onboarding' }, trigger: { kind: 'onboarding' }, text });
      Promise.resolve(r && r.done).catch(() => {}).finally(() => onboardReads.delete(k));
    } catch (e) { onboardReads.delete(k); log('warn', `team: onboarding ${k} failed to start: ${e.message}`); }
  }

  function onApplied({ proposal, company }) {
    const cid = company || (proposal && proposal.company);
    if (proposal && proposal.action === 'company') {
      // sessions already in the new company's folders become its CEO at their next CLI start
      recycle((es) => !es.s.position && !es.s.team);
    }
    emit('team.updated', { company: cid || null });
    if (live) safe(() => live.duties.refresh(), null);
  }

  function onStoreChange(ev) {
    if (!live || !ev) return;
    const cid = ev.company || null;
    emit('team.updated', { company: cid });
    if (ev.position && ev.file && /^(brief|notebook)\.md$/i.test(path.basename(String(ev.file)))) {
      const file = path.join(live.store.workspaceOf(cid, ev.position), path.basename(String(ev.file)));
      const own = recentWrites.get(file);
      if (own && Date.now() - own < 5_000) return;
      // the position's own write (notebook_add, its Edit / Write, or a shell command naming the file): never "the owner changed it"
      if (safe(() => live.runtime.isOwnEdit(cid, ev.position, path.basename(String(ev.file)).toLowerCase()), false)) return;
      if (ev.source === 'external') noteFileChange(cid, ev.position, /brief/i.test(ev.file) ? 'brief' : 'notebook');
    }
    if (ev.kind === 'position' || ev.kind === 'company') safe(() => live.duties.refresh(), null);
  }
  function noteFileChange(cid, pid, which) {
    const es = current(cid, pid);
    if (!es || !es.s.position || !es.s.position.seeded) return; // a chat not started yet reads the new file in its seed
    const { briefChangedNote, notebookEditedNote } = require('./options');
    const r = which === 'brief' ? live.store.readBrief(cid, pid) : live.store.readNotebook(cid, pid);
    const text = (r && r.text) || '';
    es.addHelmNote(which === 'brief' ? briefChangedNote(text, { ownerName }) : notebookEditedNote({ full: text, ownerName }));
  }

  // ---------------------------------------------------------------- RPC helpers
  function need() {
    if (!enabled()) throw codeErr('Positions is off (Settings > Team).', 'disabled');
    if (!live) throw codeErr(problem || 'Positions is starting.', 'root_problem');
    return live;
  }
  function companyOf(p) {
    const L = need();
    if (!isObj(p) || !idOk(p.company)) throw bad('company must be a company id');
    const c = L.store.getCompany(p.company);
    if (!c) throw codeErr(`No company "${p.company}"`, 'not_found');
    return c;
  }
  function positionOf(p, { retired = true } = {}) {
    const c = companyOf(p);
    if (!idOk(p.id)) throw bad('id must be a position id');
    const pos = live.store.getPosition(c.id, p.id);
    if (!pos || (!retired && pos.status === 'retired')) throw codeErr(`No position "${p.id}" in ${c.name}`, 'not_found');
    return { c, pos };
  }
  function inboxEntries(cid, limit = 200) {
    const lines = safe(() => live.store.readLog(cid, 'inbox').lines, []) || [];
    const byId = new Map();
    for (const l of lines) {
      if (!l || !l.id) continue;
      const cur = byId.get(l.id);
      if (cur && l.dismissedAt && !l.kind) { cur.dismissedAt = l.dismissedAt; continue; }
      byId.set(l.id, { ...(cur || {}), ...l });
    }
    return [...byId.values()].sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, limit);
  }
  const accessPending = (cid) => (live && live.access ? safe(() => live.access.pending(cid), []) || [] : []);
  const proposalList = (q) => (live && live.proposals ? safe(() => live.proposals.list(q), []) || [] : []);
  function needsYou(cid) {
    const props = live && live.proposals ? safe(() => live.proposals.pendingCount(cid), 0) || 0 : 0;
    return accessPending(cid).length + props + inboxEntries(cid).filter((e) => e.needsOwen && !e.dismissedAt).length;
  }
  // tree.effective limitedBy [{ power, value, by }] -> PROTOCOL { "<power>[:<value>]": "<ancestor id>" }
  function limitedMap(list) {
    const out = {};
    for (const x of Array.isArray(list) ? list : []) {
      const key = ['bash', 'agents', 'worktree'].includes(x.power) ? x.power : `${x.power}:${typeof x.value === 'string' ? x.value : JSON.stringify(x.value)}`;
      out[key] = x.by == null ? 'company' : x.by;
    }
    return out;
  }
  function fileOf(c, pos, file) {
    if (file !== 'brief' && file !== 'notebook') throw bad('file must be "brief" or "notebook"');
    return path.join(live.store.workspaceOf(c.id, pos.id), `${file}.md`);
  }
  const mtimeOf = (f) => safe(() => fs.statSync(f).mtimeMs, null);

  // ---------------------------------------------------------------- team.* RPC (PROTOCOL "Positions")
  const methods = {
    async 'team.list'() {
      const root = rootOf();
      const on = enabled();
      const rp = live ? null : problem || safe(() => (o.rootProblem ? o.rootProblem(companyFolders()) : null), null);
      const out = { enabled: on, root, ...(rp ? { rootProblem: rp } : {}), companies: [] };
      if (!on || !live) return out;
      out.companies = companies().map((c) => ({ id: c.id, name: c.name, folders: c.folders, positions: safe(() => live.store.listPositions(c.id).length, 0), needsYou: needsYou(c.id) }));
      const pendingCompanies = proposalList({ company: null, status: 'open' });
      if (pendingCompanies.length) out.proposals = pendingCompanies;
      return out;
    },
    async 'team.get'(p = {}) {
      const c = companyOf(p);
      const { store, runtime } = live;
      const tr = store.tree(c.id);
      const all = safe(() => store.listPositions(c.id), []) || [];
      const byId = new Map(all.map((x) => [x.id, x]));
      const props = proposalList({ company: c.id, includeDecided: true });
      const reqs = accessPending(c.id);
      const rows = [];
      const walk = (id, depth) => {
        const x = byId.get(id);
        if (!x) return;
        const nd = safe(() => live.duties.nextDuty(c.id, id), null);
        const errs = safe(() => store.positionErrors(c.id, id), null);
        const nb = safe(() => store.readNotebook(c.id, id).text, '') || '';
        rows.push({
          id, name: x.name, parent: x.parent == null ? null : x.parent, remit: x.remit || '', status: x.status, depth,
          reports: safe(() => tr.reports(id), []) || [], openItems: (nb.match(/^[ \t]*[-*][ \t]+\[ \]/gm) || []).length,
          ...(nd ? { nextDuty: nd } : {}), ...(safe(() => runtime.busyText(c.id, id), null) ? { busy: runtime.busyText(c.id, id) } : {}),
          pending: { requests: reqs.filter((r) => r.position === id).length, proposals: props.filter((q) => q.status === 'open' && (q.target === id || q.parent === id)).length },
          ...(errs ? { problem: errs.join('; ') } : {}),
        });
        const la = safe(() => lastActivityOf(c.id, id), null);
        if (la) rows[rows.length - 1].lastActivity = la;
        const dp = safe(() => tr.departmentOf(id), null); if (dp) Object.assign(rows[rows.length - 1], { department: dp.name, departmentHead: dp.head });
        for (const k of safe(() => tr.reports(id), []) || []) walk(k, depth + 1);
      };
      for (const x of all) if (x.parent == null || !byId.has(x.parent)) walk(x.id, 1);
      const { PROTOCOL_LIMITS } = require('./runtime');
      return {
        company: { id: c.id, name: c.name, folders: c.folders }, tree: rows, proposals: props,
        limits: { depthCap: S.LIMITS.maxDepth, reportsPerManager: S.LIMITS.maxReports, positionsPerCompany: S.LIMITS.maxPositions, ...PROTOCOL_LIMITS },
      };
    },
    async 'team.position'(p = {}) {
      const { c, pos } = positionOf(p);
      const eff = pos.status === 'retired' ? null : safe(() => live.store.effectivePowers(c.id, pos.id), null);
      const info = safe(() => live.duties.info(c.id, pos.id), {}) || {};
      const grants = (safe(() => live.store.readLog(c.id, 'grants', { limit: 200 }).lines, []) || []).filter((g) => g && g.position === pos.id).reverse();
      return {
        position: { ...pos, effective: eff ? { ...eff, limits: eff.limitedBy || [] } : null, limitedBy: limitedMap(eff && eff.limitedBy) },
        chats: safe(() => live.store.readChats(c.id, pos.id).chats, []) || [],
        duties: (pos.duties || []).map((d) => { const i = info[d.id] || {}; return { ...d, ...(i.nextAt ? { nextAt: i.nextAt } : {}), ...(i.last ? { last: i.last } : {}) }; }),
        grants,
        pending: {
          requests: accessPending(c.id).filter((r) => r.position === pos.id).map((r) => ({ requestId: r.requestId, sessionId: r.sessionId, access: r.access, kind: r.kind, target: r.target, at: r.at })),
          proposals: proposalList({ company: c.id, status: 'open' }).filter((q) => q.target === pos.id || q.parent === pos.id),
        },
      };
    },
    async 'team.file.read'(p = {}) {
      const { c, pos } = positionOf(p);
      const f = fileOf(c, pos, p.file);
      const r = p.file === 'brief' ? live.store.readBrief(c.id, pos.id) : live.store.readNotebook(c.id, pos.id);
      return { text: (r && r.text) || '', mtime: mtimeOf(f) };
    },
    async 'team.file.write'(p = {}) {
      const { c, pos } = positionOf(p, { retired: false });
      const f = fileOf(c, pos, p.file);
      if (typeof p.text !== 'string' || p.text.length > 200_000) throw bad('text must be a string (at most 200k characters)');
      const cur = mtimeOf(f);
      if (p.expectMtime != null && cur != null && Math.abs(cur - Number(p.expectMtime)) > 1) throw codeErr('The file changed since you opened it.', 'conflict');
      try { if (cur != null) fs.copyFileSync(f, `${f}.bak`); } catch (e) { log('warn', `team: .bak copy failed: ${e.message}`); }
      recentWrites.set(f, Date.now());
      try {
        if (p.file === 'brief') live.store.writeBrief(c.id, pos.id, p.text); else live.store.writeNotebook(c.id, pos.id, p.text);
      } catch (e) { throw codeErr(e.message, e.code === 'conflict' ? 'conflict' : 'refused'); }
      if (p.file === 'brief') inboxAppend(c.id, { at: new Date().toISOString(), id: `n_${crypto.randomBytes(3).toString('hex')}`, position: pos.id, kind: 'flag', title: `Brief edited by ${ownerWords(ownerName).owner}`, text: `${pos.name}'s brief changed.`, needsOwen: false });
      noteFileChange(c.id, pos.id, p.file);
      emit('team.updated', { company: c.id });
      return { mtime: mtimeOf(f) };
    },
    async 'team.open'(p = {}) {
      const { c, pos } = positionOf(p, { retired: false });
      const es = await open(c.id, pos.id);
      return { sessionId: es.s.id };
    },
    async 'team.openCeo'(p = {}) {
      const c = companyOf(p);
      const { companyFor } = require('./match');
      const mine = [...sessions.values()].filter((es) => !es.removed && !es.s.position && !es.s.archived
        && ((es.s.team && es.s.team.company === c.id) || safe(() => (companyFor(es.s.cwd, [c], { teamRoot: live.root }) || {}).id === c.id, false)))
        .sort((a, b) => (b.s.updatedAt || 0) - (a.s.updatedAt || 0));
      if (mine[0]) return { sessionId: mine[0].s.id };
      const folder = (c.folders || []).map((f) => S.expandHome(f)).find((f) => fs.existsSync(f));
      if (!folder) throw codeErr(`None of ${c.name}'s folders exists on this computer.`, 'refused');
      const es = await o.createSession({ cwd: folder });
      return { sessionId: es.s.id };
    },
    async 'team.decide'(p = {}) {
      const L = need();
      if (!L.proposals) throw codeErr('Proposals are not available (see the Helm log).', 'refused');
      if (typeof p.proposal !== 'string' || !p.proposal) throw bad('proposal must be a proposal id');
      if (p.decision !== 'approve' && p.decision !== 'decline') throw bad('decision must be "approve" or "decline"');
      if (p.note != null && (typeof p.note !== 'string' || p.note.length > 2000)) throw bad('note must be a short string');
      return L.proposals.decide({ proposal: p.proposal, decision: p.decision, note: p.note || undefined, how: 'click' });
    },
    async 'team.proposals'(p = {}) {
      need();
      if (p.company != null && !idOk(p.company)) throw bad('company must be a company id');
      return { proposals: proposalList({ ...(p.company !== undefined ? { company: p.company } : {}), ...(p.status ? { status: String(p.status) } : {}), includeDecided: p.includeDecided !== false }) };
    },
    async 'team.proposals.import'(p = {}) {
      const L = need();
      if (!L.proposals) throw codeErr('Proposals are not available (see the Helm log).', 'refused');
      const json = typeof p.json === 'string' ? safe(() => JSON.parse(p.json), null) : p.json;
      if (!isObj(json)) throw bad('json must be the proposals file (an object, or its text)');
      return L.proposals.import(json, {});
    },
    async 'team.ask.cancel'(p = {}) {
      const L = need();
      if (typeof p.ticket !== 'string') throw bad('ticket must be a ticket id');
      if (!L.runtime.get(p.ticket)) throw codeErr(`No ticket ${p.ticket}`, 'not_found');
      const r = L.runtime.cancel(p.ticket, { by: { kind: 'owen' } });
      return { state: (r && r.state) || (L.runtime.get(p.ticket) || {}).state };
    },
    async 'team.ask.release'(p = {}) {
      const L = need();
      if (typeof p.ticket !== 'string') throw bad('ticket must be a ticket id');
      if (!L.runtime.get(p.ticket)) throw codeErr(`No ticket ${p.ticket}`, 'not_found');
      const r = L.runtime.release(p.ticket);
      return { state: (r && r.state) || (L.runtime.get(p.ticket) || {}).state };
    },
    async 'team.answer.forward'(p = {}) {
      const L = need();
      if (typeof p.sessionId !== 'string' || typeof p.ticket !== 'string') throw bad('sessionId and ticket are required');
      if (!getEs(p.sessionId)) throw codeErr(`Unknown session ${p.sessionId}`, 'not_found');
      const r = await L.runtime.forward(p.sessionId, p.ticket);
      return { itemId: (r && (r.itemId || r)) || null };
    },
    async 'team.duty.run'(p = {}) {
      const { c, pos } = positionOf(p, { retired: false });
      if (typeof p.duty !== 'string') throw bad('duty must be a duty id');
      if (!(pos.duties || []).some((d) => d.id === p.duty)) throw codeErr(`No duty "${p.duty}"`, 'not_found');
      const r = await live.duties.runNow(c.id, pos.id, p.duty);
      return { ticket: (r && r.ticket) || null };
    },
    async 'team.duty.toggle'(p = {}) {
      const { c, pos } = positionOf(p, { retired: false });
      if (typeof p.duty !== 'string' || typeof p.enabled !== 'boolean') throw bad('duty and enabled are required');
      if (!(pos.duties || []).some((d) => d.id === p.duty)) throw codeErr(`No duty "${p.duty}"`, 'not_found');
      live.store.updatePosition(c.id, pos.id, (x) => ({ ...x, duties: (x.duties || []).map((d) => (d.id === p.duty ? { ...d, enabled: p.enabled } : d)) }));
      safe(() => live.duties.refresh(), null);
      emit('team.updated', { company: c.id });
      return { ok: true };
    },
    async 'team.pause'(p = {}) {
      const { c, pos } = positionOf(p);
      if (typeof p.paused !== 'boolean') throw bad('paused must be true or false');
      if (pos.status === 'retired') throw codeErr(`${pos.name} is retired`, 'refused');
      const next = live.store.updatePosition(c.id, pos.id, { status: p.paused ? 'paused' : 'active' });
      safe(() => live.duties.refresh(), null);
      emit('team.updated', { company: c.id });
      return { status: next.status };
    },
    async 'team.crosstalk'(p = {}) {
      const c = companyOf(p);
      const limit = Math.min(200, Math.max(1, Number(p.limit) || 50));
      return live.runtime.crosstalk({ company: c.id, position: p.position || null, before: p.before || null, limit });
    },
    async 'team.inbox'(p = {}) {
      const c = companyOf(p);
      return { entries: inboxEntries(c.id, Math.min(1000, Math.max(1, Number(p.limit) || 200))) };
    },
    async 'team.inbox.dismiss'(p = {}) {
      const c = companyOf(p);
      if (!Array.isArray(p.ids) || p.ids.length > 500 || !p.ids.every((x) => typeof x === 'string')) throw bad('ids must be a list of inbox ids');
      const known = new Set(inboxEntries(c.id, 100_000).filter((e) => !e.dismissedAt).map((e) => e.id));
      let n = 0;
      const at = new Date().toISOString();
      for (const id of p.ids) if (known.has(id)) { live.store.append(c.id, 'inbox', { at, id, dismissedAt: at }); n++; }
      if (n) emit('team.updated', { company: c.id });
      return { dismissed: n };
    },
    async 'team.openFolder'(p = {}, client) {
      const c = companyOf(p);
      if (client && client.platform && client.platform !== 'electron') throw codeErr('Opening a folder works on the desktop only.', 'unsupported');
      if (typeof o.openPath !== 'function') throw codeErr('Opening a folder is not available here.', 'unsupported');
      const dir = p.id ? positionOf(p).pos && live.store.workspaceOf(c.id, p.id) : live.store.companyDir(c.id);
      await o.openPath(dir);
      return { ok: true };
    },
  };

  return {
    methods,
    start, stop, refresh, sessionOptions, beforeSend, seedFor, noteTurnEnd,
    enabled, running: () => !!(live && live.running), prepare,
    companyFolders,
    excludeDirs: () => (enabled() ? [rootOf()] : []),
    poke: (reason) => { if (live && live.running) safe(() => live.duties.poke(reason), null); },
    status: () => ({ enabled: enabled(), running: !!(live && live.running), problem, root: live ? live.root : rootOf() }),
    // tests and tools/team-live-smoke.js
    _live: () => live,
    _open: (cid, pid) => open(cid, pid),
  };
}

module.exports = { createTeamWiring, createStateFile, DEFAULTS };
