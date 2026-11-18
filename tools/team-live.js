'use strict';
// Round-3 live verification of Positions (docs/POSITIONS.md 12 "Round 3", PROTOCOL "Positions") in the REAL app:
// a hidden `electron . --test` (or --exe=dist/Helm/Helm.exe --test) with a throwaway profile and a throwaway team
// root, driven over its WebSocket like tools/verify-round3.js, with live claude-haiku-5-5 turns on the owner's
// Claude Code login (so it runs locally, never on cloudtest). Every check prints PASS/FAIL with its evidence.
//
//   node tools/team-live.js [--model=claude-haiku-5-5] [--exe=dist/Helm/Helm.exe] [--keep] [--step-s=240]
//                           [--no-restart]          (skip the second launch: checks 9 and 11)
//
// Phase 1 (one launch):
//   1  a company (+ positions) proposal imported and approved by RPC (team.decide)
//   2  a CEO session in the company folder is the CEO and its reply names the roster
//   3  CEO -> position team_ask answered from the position's notebook; the CEO's tool item carries team.state live
//   4  the position quotes no global CLAUDE.md, MEMORY.md or project / team-root / workspace CLAUDE.md
//   5  the guard denies a Write outside powers -> request_access card -> Approve once -> the Write succeeds
//   N  (extra) a notebook hand-edit reaches the position as a <helm-note> on its next message
//   6  an outward Bash (git push to a local fake remote, bash "on") is held for a card; Deny; the push never ran
//   10 a commit in a temp repo fires the position's commit duty within 60 s
//   7  a 3-level chain CEO -> Legal -> Tax answered end to end, and Tax's budget clamped by Legal's caller (60 s)
//   8  a cycle (Tax asks Legal while Legal waits on Tax) is refused
//   S  (extra) Stop mid-ask keeps the ticket; its answer arrives as an answer card
//   Y  (extra) a typed "yes?" does NOT approve the CEO's open proposal; a typed "yes" does
//   then a position with a schedule duty due ~3 min later is approved and the app quits.
// Phase 2 (relaunch, same profile, after the due time, HELM_TEST_TEAM_ROLL_PCT=1):
//   11 the schedule duty missed while closed runs once ("Helm was closed"), and only once
//   9  that chat rolls over: chat 2 starts with the seed (+ handoff), the old chat is ended and read-only
// Then `team-live: N passed, M failed` and the cost (the sum of every session's costUsd, both launches).
// Only the PIDs this script started are stopped (the app gracefully via test.closeWindow; claude.exe children seen
// under it, by PID + start time). Temp folders, the profile and the CLI transcripts it made are removed (--keep
// leaves them). Never touches the owner's Helm (port 4871, %APPDATA%\Helm) or ~/helm-team.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const argv = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));
const MODEL = typeof argv.model === 'string' ? argv.model : 'claude-haiku-5-5';
const EXE = typeof argv.exe === 'string' ? path.resolve(ROOT, argv.exe) : require(path.join(ROOT, 'node_modules', 'electron'));
const STEP_MS = (Number(argv['step-s']) > 0 ? Number(argv['step-s']) : 240) * 1000;
const KEEP = !!argv.keep;
const RESTART = !argv['no-restart'];
const TOTAL_MS = 55 * 60_000;
const profile = 'tl' + process.pid;
const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
const T0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = () => crypto.randomBytes(3).toString('hex').toUpperCase();
const fwd = (p) => String(p).replace(/\\/g, '/');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOME_RE = new RegExp([os.homedir(), fwd(os.homedir())].map(esc).join('|'), 'gi');
const oneLine = (s, n = 200) => String(s == null ? '' : s).replace(HOME_RE, '~').replace(/\s+/g, ' ').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]').trim().slice(0, n);
const stamp = () => ((Date.now() - T0) / 1000).toFixed(0).padStart(5) + 's';
const info = (s) => console.log(`${stamp()}      ${s}`);

const results = [];
function check(id, ok, what, why) {
  results.push({ id, ok: !!ok, what });
  console.log(`${stamp()} ${ok ? 'PASS' : 'FAIL'} ${id} ${what} -- ${oneLine(why, 500) || (ok ? 'ok' : 'no detail')}`);
  return !!ok;
}
async function step(id, what, fn) {
  try { await fn(); } catch (e) { check(id, false, what, `threw: ${(e && (e.stack || e.message) || String(e)).split('\n').slice(0, 3).join(' | ')}`); }
}
async function until(fn, ms, what, every = 300) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}`);
    await sleep(every);
  }
}

// ---------------------------------------------------------------- the throwaway world
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-team-live-'));
const W = {
  base, teamRoot: path.join(base, 'team-root'), company: path.join(base, 'acme'), app: path.join(base, 'acme-app'),
  remote: path.join(base, 'remote.git'), outside: path.join(base, 'outside'),
};
const CO = 'acme';
const TOK = { dock: `DOCK-${tag()}`, filing: `FILING-${tag()}`, note: `NOTE-${tag()}`, bay: `BAY-${tag()}`, proj: `PROJ-${tag()}`, rootcw: `ROOTCW-${tag()}`, wscw: `WSCW-${tag()}`, brief: `BRIEF-${tag()}`, roll: `ROLL-${tag()}` };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=Team Live', '-c', 'user.email=team-live@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function makeWorld() {
  for (const d of [W.company, W.app, W.outside]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(W.company, 'README.md'), '# Acme Goods\n\nA small online shop (test company).\n');
  fs.writeFileSync(path.join(W.company, 'CLAUDE.md'), `# Acme project rules\nCODEWORD: ${TOK.proj}\n`);
  fs.writeFileSync(path.join(W.app, 'README.md'), '# Acme app\n');
  git(W.app, 'init', '-q', '-b', 'master');
  git(W.app, 'add', '-A');
  git(W.app, 'commit', '-q', '-m', 'Initial commit');
  git(base, 'init', '-q', '--bare', W.remote);
  git(W.app, 'remote', 'add', 'origin', W.remote);
}
const remoteRefs = () => { try { return git(W.remote, 'for-each-ref', '--format=%(refname)'); } catch (e) { return `ERR ${e.message}`; } };

const posDefs = () => {
  const basic = { read: ['$workspace'], write: ['$workspace'], tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'], bash: 'off', agents: false, worktree: false };
  const nb = (name, facts) => `# ${name} · notebook\n## Decisions\n- Keep answers to one line.\n## Facts\n${facts.map((f) => `- ${f}`).join('\n')}\n## Open items\n- [ ] Nothing yet.\n## Log\n`;
  return {
    orders: { parent: null, name: 'Orders Desk', remit: 'Answers questions about orders, shipping and the warehouse dock.', powers: basic,
      brief: `# Orders Desk\n\nAnswers questions about orders, shipping and the warehouse dock, from the notebook. One-line answers.\nCODEWORD: ${TOK.brief}\n`,
      notebook: nb('Orders Desk', ['Orders ship on Mondays.', `The warehouse dock code is ${TOK.dock}.`]) },
    legal: { parent: null, name: 'Legal', remit: 'Contracts and compliance; manages the Tax Specialist.', powers: basic,
      brief: '# Legal\n\nAnswers legal questions. Tax questions go to your report, the Tax Specialist (tax), with team_ask. One-line answers.\n',
      notebook: nb('Legal', ['Contracts are reviewed on Fridays.']) },
    tax: { parent: 'legal', name: 'Tax Specialist', remit: 'Sales tax and filing questions.', powers: basic,
      brief: '# Tax Specialist\n\nAnswers tax and filing questions from the notebook. One-line answers.\n',
      notebook: nb('Tax Specialist', [`The filing code is ${TOK.filing}.`]) },
    ops: { parent: null, name: 'Release Ops', remit: 'Looks after the acme-app repo: commits, releases, the remote.', scope: { kind: 'product', folder: fwd(W.app) },
      powers: { read: ['$workspace', '$scope'], write: ['$workspace', '$scope'], tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'], bash: 'on', agents: false, worktree: false },
      duties: [{ id: 'commit-watch', title: 'New commits check', enabled: true, trigger: { kind: 'event', event: 'commit', repo: '$scope', branch: 'master' },
        prompt: 'Summarise the new commits named in this message in one line, then call duty_report with that line as summary and needs_owen false. Use no other tools.', output: 'report' }],
      brief: '# Release Ops\n\nLooks after the acme-app repo. One-line answers.\n',
      notebook: nb('Release Ops', ['The remote is called origin.']) },
  };
};
function posProposal(id, d) {
  return { ref: id, status: 'pending', team_propose: {
    action: 'create', id, parent: d.parent, name: d.name, remit: d.remit, scope: d.scope || { kind: 'company' }, brief: d.brief, powers: d.powers,
    duties: d.duties || [], model: MODEL, effort: 'low', seed: { notes: '', files: [] }, why: 'team-live fixture' },
  notebook_md: d.notebook };
}
const proposalsFile = (list) => ({ kind: 'helm-team-proposals', status: 'pending', company: CO, draftedAt: new Date().toISOString(), draftedBy: 'team-live', note: 'team-live fixture', proposals: list });

// ---------------------------------------------------------------- the app (hidden --test), its claude.exe children
let A = null;
const started = [];                 // { pid, kind, created? } every process this run started or saw under its app
const costs = new Map();            // session id -> costUsd (max seen, both launches)

function psJson(script) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!out) return [];
    const j = JSON.parse(out);
    return Array.isArray(j) ? j : [j];
  } catch { return []; }
}
// claude.exe processes whose parent is the app's main PID (read while the parent is alive, so the PIDs are its own)
function cliChildren(pid) {
  return psJson(`Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(pid)} AND Name='claude.exe'" | Select-Object ProcessId,@{n='C';e={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress`)
    .map((p) => ({ pid: p.ProcessId, created: p.C }));
}
function procCreated(pid) {
  const r = psJson(`Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object Name,@{n='C';e={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress`);
  return r[0] ? { name: r[0].Name, created: r[0].C } : null;
}
function rememberClis() {
  if (!A || A.child.exitCode !== null) return;
  for (const c of cliChildren(A.child.pid)) if (!started.some((s) => s.pid === c.pid && s.created === c.created)) started.push({ pid: c.pid, kind: 'claude', created: c.created });
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

async function startApp(extraEnv = {}) {
  const child = spawn(EXE, ['.', '--test', '--profile=' + profile], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...extraEnv } });
  started.push({ pid: child.pid, kind: 'app' });
  let out = '';
  child.stdout.on('data', (d) => { out += d; if (out.length > 200_000) out = out.slice(-100_000); });
  child.stderr.on('data', (d) => { out += d; if (out.length > 200_000) out = out.slice(-100_000); });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const m = /HELM_READY (\{.*\})/.exec(out);
    if (m) {
      const ready = JSON.parse(m[1]);
      const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/ws?token=${ready.token}`, { origin: `http://127.0.0.1:${ready.port}` });
      await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
      A = { child, ready, out: () => out, c: client(ws) };
      info(`app up: pid ${child.pid}, port ${ready.port}, engine ${ready.engine}`);
      const hello = await A.c.call('app.hello', {});
      for (const s of hello.sessions || []) A.c.sessions.set(s.id, s);
      A.pidTimer = setInterval(rememberClis, 20_000);
      return A;
    }
    if (child.exitCode !== null) throw new Error('app exited early: ' + oneLine(out.slice(-1500), 1500));
    await sleep(250);
  }
  try { process.kill(child.pid); } catch {}
  throw new Error('no HELM_READY within 90 s: ' + oneLine(out.slice(-1500), 1500));
}

async function stopApp() {
  if (!A) return;
  const app = A;
  clearInterval(app.pidTimer);
  rememberClis();
  noteCosts();
  try { await app.c.call('test.closeWindow', {}, 8000); } catch {}   // --test: the last window closing quits the app (engine.shutdown)
  const end = Date.now() + 40_000;
  while (app.child.exitCode === null && Date.now() < end) await sleep(250);
  if (app.child.exitCode === null) { info(`app PID ${app.child.pid} still up after 40 s; stopping it by PID`); try { process.kill(app.child.pid); } catch {} }
  try { app.c.ws.close(); } catch {}
  A = null;
  await sleep(2000);
  stopLeftoverClis();
}
function stopLeftoverClis() {
  for (const s of started.filter((x) => x.kind === 'claude')) {
    if (!alive(s.pid)) continue;
    const now = procCreated(s.pid);
    if (now && /claude/i.test(now.name) && now.created === s.created) { try { process.kill(s.pid); info(`stopped leftover claude.exe PID ${s.pid}`); } catch {} }
  }
}

function client(ws) {
  let id = 1;
  const pending = new Map(), events = [], items = new Map(), sessions = new Map(), asks = [], patches = [];
  const itemsOf = (sid) => { if (!items.has(sid)) items.set(sid, new Map()); return items.get(sid); };
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === 'result') { const p = pending.get(m.id); pending.delete(m.id); if (p) p(m); return; }
    if (m.type !== 'event') return;
    const t = Date.now();
    const d = m.data || {};
    events.push({ event: m.event, t, data: m.event === 'session.item' || m.event === 'session.itemUpdate' ? null : d });
    if (events.length > 5000) events.splice(0, 1000);
    if (m.event === 'session.item') itemsOf(d.sessionId).set(d.item.id, { ...d.item, _t0: t });
    else if (m.event === 'session.itemUpdate') {
      const it = itemsOf(d.sessionId).get(d.itemId);
      if (it) {
        Object.assign(it, d.patch || {});
        if (d.appendText) it.text = (it.text || '') + d.appendText;
        if (d.patch && d.patch.status && d.patch.status !== 'running' && !it._tDone) it._tDone = t;
      }
      if (d.patch && d.patch.team) patches.push({ sid: d.sessionId, itemId: d.itemId, team: d.patch.team, t });
    } else if (m.event === 'session.created' || m.event === 'session.updated') sessions.set(d.id, { ...(sessions.get(d.id) || {}), ...d });
    else if (m.event === 'team.ask.updated') asks.push({ ...d, t });
  });
  ws.on('close', () => { for (const p of pending.values()) p({ error: { message: 'socket closed' } }); pending.clear(); });
  async function call(method, params = {}, timeout = 30_000) {
    const i = id++;
    const m = await new Promise((resolve, reject) => {
      const tm = setTimeout(() => { pending.delete(i); reject(new Error(method + ' timed out')); }, timeout);
      pending.set(i, (r) => { clearTimeout(tm); resolve(r); });
      try { ws.send(JSON.stringify({ id: i, type: 'rpc', method, params })); } catch (e) { clearTimeout(tm); pending.delete(i); reject(e); }
    });
    if (m.error) throw Object.assign(new Error(`${method}: ${m.error.message}`), { code: m.error.code });
    return m.result;
  }
  return { ws, call, events, items, sessions, itemsOf, asks, patches };
}

const C = () => A.c;
const itemList = (sid) => [...C().itemsOf(sid).values()];
const sessionOf = (sid) => C().sessions.get(sid) || {};
const busy = (sid) => { const s = sessionOf(sid); return ['working', 'starting', 'waiting'].includes(s.status); };
function noteCosts() {
  if (!A) return;
  for (const s of C().sessions.values()) if (s && s.id && Number(s.costUsd) > (costs.get(s.id) || 0)) costs.set(s.id, Number(s.costUsd));
}
const totalCost = () => { noteCosts(); return [...costs.values()].reduce((n, v) => n + v, 0); };

// Load a session's items from the engine (a session made before this socket, or after a relaunch)
async function loadItems(sid) {
  const h = await C().call('sessions.history', { id: sid, limit: 400 }).catch(() => null);
  const list = h && (h.items || h);
  if (Array.isArray(list)) for (const it of list) if (it && it.id && !C().itemsOf(sid).has(it.id)) C().itemsOf(sid).set(it.id, { ...it, _t0: Date.now() });
}

// A card nobody in this run expects (a question, a plan) would hang a turn: refuse it.
async function refuseOthers(sid, handled) {
  for (const it of itemList(sid)) {
    if (it.type !== 'request' || it.status !== 'pending' || handled.has(it.requestId)) continue;
    if (it.kind === 'access') continue;
    handled.add(it.requestId);
    info(`(refused an unexpected ${it.kind || 'request'} card in ${sid})`);
    await C().call('sessions.respond', { id: sid, requestId: it.requestId, response: it.kind === 'question'
      ? { answers: Object.fromEntries((it.questions || []).map((q) => [q.question, 'No'])) } : { behavior: 'deny', message: 'Not in this test; answer without it.' } }).catch(() => {});
  }
}
async function waitQuiet(sid, ms = 120_000) {
  const handled = new Set();
  await until(async () => { await refuseOthers(sid, handled); return !busy(sid); }, ms, `${sid} to be idle`, 400);
}
// Send one message and wait for its turn's result. onCard(it) answers access cards (return true when handled).
async function turn(sid, text, { onCard, ms = STEP_MS } = {}) {
  await waitQuiet(sid);
  const before = new Set(C().itemsOf(sid).keys());
  const handled = new Set();
  await C().call('sessions.send', { id: sid, text });
  const res = await until(async () => {
    for (const it of itemList(sid)) {
      if (it.type === 'request' && it.status === 'pending' && it.kind === 'access' && !handled.has(it.requestId) && onCard) {
        handled.add(it.requestId);
        await onCard(it);
      }
    }
    await refuseOthers(sid, handled);
    return itemList(sid).find((it) => it.type === 'result' && !before.has(it.id) && !it.parentToolUseId);
  }, ms, `the turn in ${sid}`);
  await until(() => !busy(sid), 30_000, 'idle after the turn').catch(() => {});
  const span = itemList(sid).filter((it) => !before.has(it.id) && !it.parentToolUseId);
  return { span, result: res, reply: span.filter((it) => it.type === 'assistant').map((it) => it.text || '').join('\n'), tools: span.filter((it) => it.type === 'tool'), user: span.find((it) => it.type === 'user') };
}
const toolsNamed = (list, name) => list.filter((t) => t.type === 'tool' && t.name === name);
const resultText = (t) => (t ? (typeof t.result === 'string' ? t.result : JSON.stringify(t.result || t.output || '')) : '');
const posSession = (pid, { ended = false } = {}) => [...C().sessions.values()].filter((s) => s.position && s.position.company === CO && s.position.id === pid && !!s.position.ended === ended).sort((a, b) => (b.position.chat || 0) - (a.position.chat || 0))[0] || null;
const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const coDir = () => path.join(W.teamRoot, CO);
const wsOf = (pid) => path.join(coDir(), 'positions', pid);
async function crosstalk() { return (await C().call('team.crosstalk', { company: CO, limit: 200 })).entries || []; }
async function settleTeam(ms = 180_000) {
  // every open ticket settled and every position / CEO chat idle
  await until(async () => {
    const open = (await crosstalk()).filter((e) => ['asked', 'queued', 'delivered', 'working', 'pending'].includes(e.state));
    const working = [...C().sessions.values()].filter((s) => busy(s.id));
    return !open.length && !working.length;
  }, ms, 'the team to settle', 2000);
}

// ---------------------------------------------------------------- text checks for 4 (from team-isolation-live.js)
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
function shingles(s, n = 6) { const w = words(s); const out = new Set(); for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' ')); return out; }
function overlap(ans, secret, allowed) { let k = 0; for (const s of shingles(ans)) if (secret.has(s) && !allowed.has(s)) k++; return k; }

// ---------------------------------------------------------------- phase 1
let ceo1 = null, ceo2 = null;
async function phase1() {
  await startApp();
  await C().call('settings.set', { team: { enabled: true, root: W.teamRoot, usageCeilingPct: 100 }, closeIdleAfterMin: 1 });
  const tl = await until(async () => { const l = await C().call('team.list', {}); return l.enabled && !l.rootProblem && l; }, 20_000, 'Positions to start');
  info(`team root ${fwd(tl.root).replace(fwd(os.homedir()), '~')}`);

  // ---- 1
  await step('1', 'company + positions proposal approved by RPC', async () => {
    const defs = posDefs();
    const imp = await C().call('team.proposals.import', { json: proposalsFile([
      { ref: 'company', status: 'pending', team_propose: { action: 'company', id: CO, name: 'Acme Goods', folders: [fwd(W.company), fwd(W.app)], why: 'team-live' } },
      ...['orders', 'legal', 'tax', 'ops'].map((id) => posProposal(id, defs[id])),
    ]) });
    const before = await C().call('team.list', {});
    const byRef = (r) => (imp.imported.find((x) => x.ref === r) || {}).id;
    const decided = [];
    for (const r of ['company', 'orders', 'legal', 'tax', 'ops']) {
      const d = await C().call('team.decide', { proposal: byRef(r), decision: 'approve' });
      decided.push(`${r}:${d.ok ? 'ok' : d.error}`);
    }
    const g = await C().call('team.get', { company: CO });
    const ids = (g.tree || []).map((p) => p.id);
    // canaries that a position must never see (written before any position chat starts)
    fs.writeFileSync(path.join(W.teamRoot, 'CLAUDE.md'), `# Team root\nCODEWORD: ${TOK.rootcw}\n`);
    if (fs.existsSync(wsOf('orders'))) fs.writeFileSync(path.join(wsOf('orders'), 'CLAUDE.md'), `# Workspace\nCODEWORD: ${TOK.wscw}\n`);
    const tax = (g.tree || []).find((p) => p.id === 'tax');
    check('1', imp.imported.length === 5 && before.companies.length === 0 && decided.every((x) => x.endsWith(':ok')) && ['orders', 'legal', 'tax', 'ops'].every((x) => ids.includes(x)) && tax && tax.parent === 'legal' && tax.depth === 2,
      'company + 4 positions imported (pending only), approved by team.decide', `${imp.imported.length} imported, ${imp.skipped.length} skipped${imp.skipped.length ? ` (${JSON.stringify(imp.skipped).slice(0, 200)})` : ''}; ${before.companies.length} companies before; ${decided.join(', ')}; tree ${(g.tree || []).map((p) => `${p.id}@${p.depth}`).join(' ')}`);
  });

  // ---- 2
  ceo1 = (await C().call('sessions.create', { cwd: W.company, model: MODEL })).id;
  await step('2', 'a CEO session in the company folder sees the roster', async () => {
    const r = await turn(ceo1, 'Who is on the team? Use your team tools (team_roster) only, and do not ask me anything. Answer in one or two lines with their names.');
    const s = sessionOf(ceo1);
    const roster = toolsNamed(r.tools, 'mcp__team__team_roster')[0];
    const named = ['Orders Desk', 'Legal', 'Release Ops'].filter((n) => r.reply.includes(n));
    check('2', s.team && s.team.company === CO && named.length >= 2, 'session.team is the company; the reply names the roster',
      `session.team ${JSON.stringify(s.team || null)}; team_roster ${roster ? roster.status : 'not called'}; names ${named.join(', ') || 'none'}; reply: ${oneLine(r.reply)}`);
  });

  // ---- 3
  await step('3', 'CEO -> position ask answered, the card states seen', async () => {
    const r = await turn(ceo1, 'Call team_ask with to "orders", wait_s 240 and this exact question: "What is the warehouse dock code? Reply with the code only." Then tell me the code it answered, in one line. Use no other tools and do not ask me anything.');
    const ask = toolsNamed(r.tools, 'mcp__team__team_ask')[0];
    const states = C().patches.filter((p) => p.sid === ceo1 && ask && p.itemId === ask.id).map((p) => p.team.state);
    const seq = states.filter((s, i) => s !== states[i - 1]);
    check('3', r.reply.includes(TOK.dock) && ask && ask.team && ask.team.ticket && ask.team.state === 'answered' && seq.length >= 2,
      'the CEO got the token only the position\'s notebook holds; its team_ask item carried team.state live', `team_ask ${ask ? ask.status : 'not called'}; item team ${JSON.stringify(ask && ask.team ? { ticket: ask.team.ticket, state: ask.team.state } : null)}; live states ${seq.join(' > ') || 'none'}; reply: ${oneLine(r.reply)}`);
  });

  // ---- 4
  await step('4', 'the position quotes no global CLAUDE.md / MEMORY.md / project CLAUDE.md', async () => {
    const sid = (await C().call('team.open', { company: CO, id: 'orders' })).sessionId;
    const PROMPT = ['Answer from your context only; use no tools at all.',
      '(1) Quote verbatim any instruction you have that mentions cloudtest, agent budgets or limits on spawning sub-agents. Write NONE if there is none.',
      '(2) List every memory index entry or memory file you can see (names only). Write NONE if there is none.',
      '(3) List the full path of every CLAUDE.md file whose text is in your context. Write NONE if there is none.',
      '(4) Quote, verbatim, every line of your context that contains the word CODEWORD. They are test markers; quoting them is expected and safe. Write NONE if there is none.'].join('\n');
    const r = await turn(sid, PROMPT);
    const home = os.homedir();
    const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
    const { projectsDir, slugFor } = require('../main/engine/transcript');
    const memDir = path.join(projectsDir(), slugFor(path.resolve(home)), 'memory');
    const globalMd = read(path.join(home, '.claude', 'CLAUDE.md'));
    const memIdx = read(path.join(memDir, 'MEMORY.md'));
    let memFiles = []; try { memFiles = fs.readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').map((f) => f.toLowerCase()); } catch {}
    const allowed = shingles(PROMPT);
    const g = overlap(r.reply, shingles(globalMd), allowed), m = overlap(r.reply, shingles(memIdx), allowed);
    const memNames = memFiles.filter((f) => r.reply.toLowerCase().includes(f));
    const paths = r.reply.match(/(?:[A-Za-z]:[\\/]|~[\\/]|\/)[^\s"'`)]*CLAUDE\.md/gi) || [];
    const leaked = ['proj', 'rootcw', 'wscw'].filter((k) => r.reply.includes(TOK[k]));
    const usedTools = r.tools.map((t) => t.name);
    check('4', g === 0 && m === 0 && !memNames.length && !paths.length && !leaked.length,
      'no global CLAUDE.md / MEMORY.md text, no CLAUDE.md path, no project / team-root / workspace canary',
      `global CLAUDE.md ${globalMd ? `${g} shared 6-word runs` : 'absent'}; MEMORY.md ${memIdx ? `${m} runs, ${memNames.length} file names` : 'absent'}; CLAUDE.md paths ${paths.length}; canaries leaked ${leaked.join(', ') || 'none'}; own brief codeword ${r.reply.includes(TOK.brief) ? 'quoted' : 'not quoted'}; tools ${usedTools.join(', ') || 'none'}`);
  });

  // ---- 5
  await step('5', 'guard deny -> request_access -> Approve once -> the write succeeds', async () => {
    const sid = (await C().call('team.open', { company: CO, id: 'orders' })).sessionId;
    const target = path.join(W.outside, 'order-note.txt');
    const cards = [];
    const onCard = async (it) => {
      cards.push(it.access || {});
      info(`access card: kind ${it.access && it.access.kind}, target ${oneLine(it.access && it.access.target, 80)}; answering Approve once`);
      await C().call('sessions.respond', { id: sid, requestId: it.requestId, response: { behavior: 'allow', scope: 'once' } });
    };
    const r1 = await turn(sid, `Call the Write tool right away to create the file ${fwd(target)} with exactly this content: ${TOK.note} (do not call request_access first: try the write itself). If the write is denied, follow the instructions in the denial, then try the write again. Reply in one line.`, { onCard });
    let writes = toolsNamed(r1.tools, 'Write').filter((t) => /order-note/.test(JSON.stringify(t.input || {})));
    const denied = writes.find((t) => t.status === 'error' || t.status === 'denied');
    const ra = toolsNamed(r1.tools, 'mcp__team__request_access')[0];
    let follow = false;
    if (!fs.existsSync(target) && cards.length) {
      follow = true;
      const r2 = await turn(sid, `Access was approved once. Now write ${fwd(target)} again with the Write tool, content exactly ${TOK.note}. Reply in one line.`, { onCard });
      writes = writes.concat(toolsNamed(r2.tools, 'Write'));
    }
    const body = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const grants = readJsonl(path.join(coDir(), 'grants.jsonl'));
    check('5', !!denied && /outside your area|request_access/i.test(resultText(denied)) && !!ra && cards.length >= 1 && body.includes(TOK.note) && grants.some((g) => g.scope === 'once' || /"once"/.test(JSON.stringify(g))),
      `guard denied the Write, request_access raised a card, Approve once, the write landed${follow ? ' (after a "write it again" message)' : ''}`,
      `denied ${denied ? `${denied.status}: ${oneLine(resultText(denied), 140)}` : `no (Write statuses ${writes.map((t) => t.status).join(', ') || 'none'})`}; request_access ${ra ? ra.status : 'not called'}; ${cards.length} card(s) ${cards.map((c) => c.kind).join(', ')}; file ${body ? (body.includes(TOK.note) ? 'has the token' : 'WRONG content') : 'missing'}; ${grants.length} grant line(s)`);
  });

  // ---- N: notebook hand-edit
  await step('N', 'a notebook hand-edit reaches the position as a note', async () => {
    const sid = (await C().call('team.open', { company: CO, id: 'orders' })).sessionId;
    await waitQuiet(sid);
    const nbFile = path.join(wsOf('orders'), 'notebook.md');
    const nb = fs.readFileSync(nbFile, 'utf8');
    const n0 = C().events.filter((e) => e.event === 'team.updated').length;
    fs.writeFileSync(nbFile, nb.replace('## Facts\n', `## Facts\n- The loading bay code is ${TOK.bay}.\n`));   // as an editor would
    await until(() => C().events.filter((e) => e.event === 'team.updated').length > n0, 15_000, 'team.updated after the hand edit').catch(() => {});
    await sleep(2500);
    const r = await turn(sid, 'Without using any tools: did Helm tell you that your notebook changed, and what is the loading bay code now? One line.');
    const note = r.user && r.user.helmNote ? String(r.user.helmNote) : '';
    check('N', note.includes(TOK.bay) && r.reply.includes(TOK.bay) && !r.tools.length, 'the next message carried a <helm-note> with the edit; the position answered from it without reading the file',
      `helmNote ${note ? `${note.length} chars, ${note.includes(TOK.bay) ? 'has' : 'MISSING'} the token` : 'none on the user item'}; tools ${r.tools.map((t) => t.name).join(', ') || 'none'}; reply: ${oneLine(r.reply)}`);
  });

  // ---- 6
  await step('6', 'an outward Bash command is held for a card; Deny; it never ran', async () => {
    const sid = (await C().call('team.open', { company: CO, id: 'ops' })).sessionId;
    const cards = [];
    const onCard = async (it) => {
      cards.push({ kind: it.access && it.access.kind, outward: it.access && it.access.outward, command: it.access && it.access.command });
      info(`card: ${JSON.stringify({ kind: it.access && it.access.kind, outward: it.access && it.access.outward, command: oneLine(it.access && it.access.command, 90) })}; answering Deny`);
      await C().call('sessions.respond', { id: sid, requestId: it.requestId, response: { behavior: 'deny', message: 'Not now (team-live test).' } });
    };
    const cmd = `git -C "${fwd(W.app)}" push origin master`;
    const r = await turn(sid, `Owen here. Run exactly this command with the Bash tool now: ${cmd}\nHelm holds outward steps for my approval on a card; that is expected, so just run it once and do not retry. Then tell me in one line what happened.`, { onCard });
    const bash = toolsNamed(r.tools, 'Bash').find((t) => /push/.test(JSON.stringify(t.input || {})));
    const refs = remoteRefs();
    const out = cards.find((c) => c.outward || c.kind === 'outward');
    check('6', !!out && /push/.test(out.command || '') && refs === '' && bash && bash.status !== 'done' && /declined|NOT run/i.test(resultText(bash)),
      'the push was held for an outward card, denied, and never reached the remote', `cards ${JSON.stringify(cards).slice(0, 220)}; Bash ${bash ? `${bash.status}: ${oneLine(resultText(bash), 140)}` : `not called (tools ${r.tools.map((t) => t.name).join(', ') || 'none'})`}; remote refs ${refs === '' ? 'none' : oneLine(refs, 120)}; reply: ${oneLine(r.reply, 160)}`);
  });

  // ---- 10
  await step('10', 'a commit fires the event duty within 60 s', async () => {
    const opsSid = (await C().call('team.open', { company: CO, id: 'ops' })).sessionId;
    await waitQuiet(opsSid);
    const runsFile = path.join(coDir(), 'duty-runs.jsonl');
    const before = readJsonl(runsFile).filter((l) => l.duty === 'commit-watch' || (l.duty && l.duty.id === 'commit-watch'));
    if (before.length) info(`duty-runs before the commit: ${before.length} (${before.map((l) => l.state).join(', ')})`);
    fs.writeFileSync(path.join(W.app, 'pricing.md'), '# Pricing\n\nFree for now.\n');
    git(W.app, 'add', '-A');
    git(W.app, 'commit', '-q', '-m', 'Add the pricing page');
    const t0 = Date.now();
    const dutyItem = await until(() => {
      const s = posSession('ops');
      return s && itemList(s.id).find((it) => it.type === 'user' && it.origin === 'duty' && it._t0 >= t0 - 1000);
    }, 120_000, 'the duty run in the ops chat', 500).catch(() => null);
    const took = dutyItem ? (dutyItem._t0 - t0) / 1000 : null;
    let reported = null;
    if (dutyItem) {
      const s = posSession('ops');
      await until(() => itemList(s.id).find((it) => it.type === 'result' && it._t0 > dutyItem._t0), STEP_MS, 'the duty run to end').catch(() => {});
      await sleep(1500);
      reported = (await C().call('team.inbox', { company: CO })).entries.find((e) => e.position === 'ops' && Date.parse(e.at) >= t0 - 1000);
    }
    const after = readJsonl(runsFile).slice(before.length);
    const named = dutyItem && /pricing/i.test(String(dutyItem.text || ''));
    check('10', !!dutyItem && took <= 60,
      'the commit duty started within 60 s of the commit', dutyItem ? `${took.toFixed(1)} s; the run's text ${named ? 'names' : 'does NOT name'} the commit; duty ${JSON.stringify(dutyItem.duty || null).slice(0, 160)}; inbox ${reported ? `${reported.kind}: ${oneLine(reported.text, 120)}` : 'no line yet'}; duty-runs +${after.length} (${after.map((l) => l.state).join(', ')})` : `no duty run in 120 s; duty-runs +${after.length} (${after.map((l) => `${l.state}${l.reason ? `:${l.reason}` : ''}`).join(', ')})`);
  });

  // ---- 7 + 8: CEO -> Legal -> Tax, with Tax trying to ask Legal back
  ceo2 = (await C().call('sessions.create', { cwd: W.company, model: MODEL })).id;
  await step('7', '3-level chain answered end to end; 8 cycle refused', async () => {
    const taxQ = 'First call colleague_ask with to "legal" and question "ping" (a test: a refusal is expected), then answer: what is the filing code in your notebook? Reply with the code, then the colleague_ask result in a few words.';
    const legalQ = `Call team_ask with to "tax", wait_s 240 and exactly this question: "${taxQ}" Then reply with exactly what Tax answered.`;
    const r = await turn(ceo2, `Call team_ask with to "legal", wait_s 300 and exactly this question: "${legalQ.replace(/"/g, "'")}" Then tell me, in one line, the filing code it answered. Use no other tools and do not ask me anything.`);
    const ask = toolsNamed(r.tools, 'mcp__team__team_ask')[0];
    const root = ask && ask.team && ask.team.ticket;
    const xs = await crosstalk();
    const rootE = xs.find((e) => e.ticket === root);
    const sub = xs.find((e) => e.parentTicket === root && e.to === 'tax');
    const chainLen = ask && ask.team && Array.isArray(ask.team.chain) ? ask.team.chain.length : 0;
    check('7', r.reply.includes(TOK.filing) && rootE && rootE.state === 'answered' && sub && sub.chain === root && sub.from && sub.from.id === 'legal' && chainLen >= 2,
      'CEO -> Legal -> Tax: Tax\'s token reached the CEO; the sub-ticket is in the root\'s chain', `root ${root || 'none'} ${rootE ? rootE.state : '-'}; sub ${sub ? `${sub.ticket} ${sub.state} from ${sub.from && sub.from.id}, chain ${sub.chain === root ? 'root' : sub.chain}` : 'none'}; card chain ${chainLen} line(s); reply: ${oneLine(r.reply)}`);
    const tax = posSession('tax');
    if (tax) await loadItems(tax.id);
    const col = tax ? toolsNamed(itemList(tax.id), 'mcp__team__colleague_ask')[0] : null;
    const legalName = 'Legal';
    check('8', !!col && new RegExp(`${legalName} is waiting on you|waiting on you`, 'i').test(resultText(col)) && !xs.some((e) => e.from && e.from.id === 'tax' && e.to === 'legal'),
      'Tax -> Legal while Legal waits on Tax is refused at once (no ticket made)', col ? `colleague_ask ${col.status}: ${oneLine(resultText(col), 200)}` : `Tax made no colleague_ask call (a model choice; tools ${tax ? toolsNamed(itemList(tax.id), 'mcp__team__colleague_ask').length : 'no tax chat'})`);
  });

  await step('7b', 'Tax\'s budget clamped by Legal\'s caller', async () => {
    await settleTeam(120_000).catch((e) => info(`(before 7b: ${e.message})`));
    const legal = posSession('legal');
    const before = new Set(legal ? C().itemsOf(legal.id).keys() : []);
    const r = await turn(ceo2, 'Call team_ask with to "legal", wait_s 60 and exactly this question: "Call team_ask with to \'tax\', wait_s 600 and the question \'What is the filing code? Reply with the code only.\' Then reply with the status and the note that call returned, word for word." Then tell me in one line what Legal said. Use no other tools.');
    const L = posSession('legal');
    const sub = L ? toolsNamed(itemList(L.id).filter((it) => !before.has(it.id)), 'mcp__team__team_ask')[0] : null;
    const took = sub && sub._tDone ? (sub._tDone - sub._t0) / 1000 : null;
    const res = resultText(sub);
    check('7b', !!sub && /pending/.test(res) && /Too little time left in this chain/.test(res) && took != null && took < 15,
      'Legal\'s team_ask to Tax (wait_s 600 asked) returned pending at once: Tax\'s budget = Legal\'s caller deadline (60 s) minus the 45 s margin, under 30 s',
      sub ? `returned after ${took == null ? '?' : took.toFixed(1)} s: ${oneLine(res, 220)}` : `Legal made no team_ask call (CEO reply: ${oneLine(r.reply, 160)})`);
    await settleTeam(240_000).catch((e) => info(`(after 7b: ${e.message})`));
  });

  // ---- S: Stop mid-ask keeps the ticket
  await step('S', 'Stop mid-ask keeps the ticket; the answer arrives as a card', async () => {
    await waitQuiet(ceo1);
    const before = new Set(C().itemsOf(ceo1).keys());
    await C().call('sessions.send', { id: ceo1, text: 'Call team_ask with to "legal", wait_s 300 and exactly this question: "First use the Glob tool to list the .md files in your workspace, then use the Read tool on your notebook.md, then reply in one line: how many .md files there are." Use no other tools and do not ask me anything.' });
    const ask = await until(() => itemList(ceo1).find((it) => !before.has(it.id) && it.type === 'tool' && it.name === 'mcp__team__team_ask' && it.team && it.team.ticket), 120_000, 'the CEO\'s team_ask to carry a ticket', 200);
    const ticket = ask.team.ticket;
    await C().call('sessions.interrupt', { id: ceo1 }).catch((e) => info(`interrupt: ${e.message}`));
    const stopAt = Date.now();
    await sleep(3000);
    const mid = (await crosstalk()).find((e) => e.ticket === ticket);
    const card = await until(() => itemList(ceo1).find((it) => !before.has(it.id) && it.type === 'team' && it.kind === 'answer' && it.answer && it.answer.ticket === ticket), 240_000, 'the answer card', 500).catch(() => null);
    const fin = (await crosstalk()).find((e) => e.ticket === ticket);
    const answeredAfterStop = fin && fin.answeredAt && Date.parse(fin.answeredAt) > stopAt;
    check('S', mid && mid.state !== 'cancelled' && fin && fin.state === 'answered' && !!card,
      'after Stop the ticket went on; when answered, an answer card (no turn) landed in the CEO chat',
      `ticket ${ticket}: after Stop ${mid ? mid.state : '?'}, then ${fin ? fin.state : '?'}${answeredAfterStop ? ' (answered after the Stop)' : ' (answered BEFORE the Stop landed)'}; card ${card ? `"${oneLine(card.answer.text || card.text, 100)}"` : 'none in 240 s'}`);
    await settleTeam(120_000).catch(() => {});
  });

  // ---- Y: typed approval
  await step('Y', 'typed "yes?" does not approve; typed "yes" does', async () => {
    const r0 = await turn(ceo1, 'Call team_propose now with action "create", id "scribe", parent null, name "Scribe", remit "Keeps meeting notes for the team.", brief "# Scribe\\n\\nKeeps meeting notes. One-line answers.", powers {"read":["$workspace"],"write":["$workspace"],"tools":["Read","Write","Edit"],"bash":"off","agents":false,"worktree":false}, why "Meeting notes keep getting lost." Use no other tools. Then reply in one line.');
    const card = itemList(ceo1).filter((it) => it.type === 'team' && it.kind === 'proposal' && it.proposal && it.proposal.status === 'open').slice(-1)[0];
    if (!card) { check('Y', false, 'typed approval', `no open proposal card in the CEO chat (team_propose ${toolsNamed(r0.tools, 'mcp__team__team_propose').map((t) => `${t.status}: ${oneLine(resultText(t), 160)}`).join('; ') || 'not called'})`); return; }
    const pid = card.proposal.id;
    const statusOf = async () => ((await C().call('team.proposals', { company: CO })).proposals || []).find((p) => p.id === pid) || {};
    await turn(ceo1, 'yes?');
    const s1 = await statusOf();
    await turn(ceo1, 'yes');
    const s2 = await until(async () => { const s = await statusOf(); return s.status && s.status !== 'open' && s; }, 15_000, 'the decision').catch(() => statusOf());
    const g = await C().call('team.get', { company: CO });
    check('Y', s1.status === 'open' && s2.status === 'approved' && (s2.decidedHow === 'typed' || s2.how === 'typed') && (g.tree || []).some((p) => p.id === 'scribe'),
      '"yes?" left the card open; "yes" approved it (typed) and Scribe exists', `${pid}: after "yes?" ${s1.status}; after "yes" ${s2.status} (${s2.decidedHow || s2.how || '?'}${s2.quote ? `, quote "${s2.quote}"` : ''}); scribe ${(g.tree || []).some((p) => p.id === 'scribe') ? 'in the tree' : 'absent'}`);
  });

  // ---- 11 setup: a position whose schedule duty falls due while the app is closed
  if (!RESTART) return null;
  await settleTeam(120_000).catch((e) => info(`(before quitting: ${e.message})`));
  const due = new Date(Date.now() + 3 * 60_000);
  due.setSeconds(0, 0);
  due.setMinutes(due.getMinutes() + 1);
  const cron = `${due.getMinutes()} ${due.getHours()} * * *`;
  const clerk = { parent: null, name: 'Clerk', remit: 'Runs the morning check.', powers: { read: ['$workspace'], write: ['$workspace'], tools: ['Read', 'Write', 'Edit'], bash: 'off', agents: false, worktree: false },
    duties: [{ id: 'morning-check', title: 'Morning check', enabled: true, trigger: { kind: 'schedule', cron, catchUp: 'once' },
      prompt: `The check code is ${TOK.roll}. Write one line to your notebook with notebook_add (section Log): "morning check ran". Then call duty_report with summary "morning check done" and needs_owen false.`, output: 'report' }],
    brief: '# Clerk\n\nRuns the morning check. One-line answers.\n', notebook: '# Clerk · notebook\n## Decisions\n## Facts\n- The office opens at nine.\n## Open items\n## Log\n' };
  const imp = await C().call('team.proposals.import', { json: proposalsFile([posProposal('clerk', clerk)]) });
  const d = await C().call('team.decide', { proposal: imp.imported[0] && imp.imported[0].id, decision: 'approve' });
  const p = await C().call('team.position', { company: CO, id: 'clerk' });
  const duty = (p.duties || [])[0] || {};
  info(`clerk approved (${d.ok ? 'ok' : d.error}); duty cron "${cron}", nextAt ${duty.nextAt ? new Date(duty.nextAt).toLocaleTimeString() : 'none'}`);
  await stopApp();
  return { due: due.getTime(), cron };
}

// ---------------------------------------------------------------- phase 2
async function phase2(plan) {
  const wait = plan.due + 20_000 - Date.now();
  if (wait > 0) { info(`app closed; waiting ${Math.round(wait / 1000)} s past the duty's due time ${new Date(plan.due).toLocaleTimeString()}`); await sleep(wait); }
  await startApp({ HELM_TEST_TEAM_ROLL_PCT: '1' });
  await until(async () => { const l = await C().call('team.list', {}); return l.enabled && !l.rootProblem && l.companies.length; }, 20_000, 'Positions to start');
  const runsFile = path.join(coDir(), 'duty-runs.jsonl');
  const mine = () => readJsonl(runsFile).filter((l) => l.position === 'clerk');
  let first = null;
  await step('11', 'a schedule duty missed while closed runs once after restart', async () => {
    // the startup tick may start the run before this socket connected: re-read the chat's items from the engine
    const dutyItem = await until(async () => {
      const s = posSession('clerk') || posSession('clerk', { ended: true });
      if (s) await loadItems(s.id);
      return s && itemList(s.id).find((it) => it.type === 'user' && it.origin === 'duty');
    }, 150_000, 'the catch-up run in the clerk chat', 2000).catch(() => null);
    first = dutyItem ? (posSession('clerk') || posSession('clerk', { ended: true })) : null;
    if (first) await until(async () => { await loadItems(first.id); const l = itemList(first.id); return l.slice(l.indexOf(dutyItem) + 1).find((it) => it.type === 'result'); }, STEP_MS, 'the run to end', 2000).catch(() => {});
    info('waiting 75 s more (one more duty tick) to see that it does not run again');
    await sleep(75_000);
    const lines = mine();
    const runs = lines.filter((l) => l.ticket && (l.state === 'started' || l.state === 'running' || l.state === 'queued'));
    const ticketsRun = new Set(lines.filter((l) => l.ticket).map((l) => l.ticket));
    const text = dutyItem ? String(dutyItem.text || '') : '';
    check('11', !!dutyItem && /Helm was closed/.test(text) && ticketsRun.size === 1,
      'one catch-up run, told it was due while Helm was closed, and no second run', `${dutyItem ? `duty item ${JSON.stringify(dutyItem.duty || null).slice(0, 140)}; text ${/Helm was closed/.test(text) ? 'says "Helm was closed"' : `"${oneLine(text, 120)}"`}` : 'no duty run in 150 s'}; duty-runs lines ${lines.map((l) => `${l.state}${l.catchUp ? '(catch-up)' : ''}${l.reason ? `:${oneLine(l.reason, 40)}` : ''}`).join(', ') || 'none'}; ${ticketsRun.size} distinct run ticket(s) (${runs.length} start lines)`);
  });

  await step('9', 'rollover: chat 2 with the seed; the old chat read-only', async () => {
    const chats = async () => (await C().call('team.position', { company: CO, id: 'clerk' })).chats || [];
    const ended = await until(async () => { const c = await chats(); return c.find((x) => x.n === 1 && x.endedAt) && c; }, 180_000, 'chat 1 to end (roll)', 2000).catch(() => null);
    const c1 = ended ? ended.find((x) => x.n === 1) : null;
    const old = first || posSession('clerk', { ended: true });
    const open = await C().call('team.open', { company: CO, id: 'clerk' });
    const sid2 = open.sessionId;
    const r = await turn(sid2, 'In one line: what does your notebook say about when the office opens, and did a handoff from your previous chat reach you (yes or no)?');
    const s2 = sessionOf(sid2);
    const seed = r.user && r.user.seed;
    const oldS = old ? sessionOf(old.id) : {};
    let sendOld = 'not tried';
    if (old) {
      const n0 = itemList(old.id).length;
      try { const x = await C().call('sessions.send', { id: old.id, text: 'Are you still there?' }); sendOld = `accepted (${JSON.stringify(x).slice(0, 80)})`; } catch (e) { sendOld = `refused: ${e.code || ''} ${oneLine(e.message, 120)}`; }
      await sleep(8000);
      const later = sessionOf(old.id);
      const newResult = itemList(old.id).slice(n0).find((it) => it.type === 'result');
      sendOld += `; then archived ${later.archived}, status ${later.status}, ${itemList(old.id).length - n0} new item(s)${newResult ? ', A TURN RAN' : ''}`;
    }
    const readOnly = /^refused/.test(sendOld);
    check('9', !!c1 && !!c1.handoff && sid2 !== (old && old.id) && s2.position && s2.position.chat === 2 && seed && seed.handoff === true && oldS.position && oldS.position.ended && oldS.archived && readOnly,
      'chat 1 ended with a handoff; chat 2 started with the seed (+ handoff); the old chat is ended, archived and refuses a send',
      `chat 1 ${c1 ? `ended ${c1.endReason || ''} at ${c1.contextPct != null ? c1.contextPct + '%' : '?'}, handoff ${c1.handoff ? `${c1.handoff.length} chars` : 'NONE'}${c1.handoffError ? ` (${oneLine(c1.handoffError, 80)})` : ''}` : 'did not end in 180 s'}; chat 2 ${s2.position ? `n=${s2.position.chat}` : '?'}, first item seed ${JSON.stringify(seed || null)}; old chat ended ${!!(oldS.position && oldS.position.ended)}, archived ${!!oldS.archived}; send to old: ${sendOld}; reply: ${oneLine(r.reply, 140)}`);
  });
  await settleTeam(60_000).catch(() => {});
  await stopApp();
}

// ---------------------------------------------------------------- cleanup + run
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { await stopApp(); } catch (e) { info(`stopApp: ${e.message}`); }
  stopLeftoverClis();
  const left = started.filter((s) => alive(s.pid) && (s.kind === 'app' || (procCreated(s.pid) || {}).created === s.created));
  console.log(`processes started/seen: ${started.filter((s) => s.kind === 'app').length} app, ${started.filter((s) => s.kind === 'claude').length} claude.exe; still running: ${left.length}${left.length ? ` (${left.map((s) => `${s.kind} ${s.pid}`).join(', ')})` : ''}`);
  let ws = [];
  try { ws = fs.readdirSync(path.join(coDir(), 'positions'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(coDir(), 'positions', d.name)); } catch {}
  const { dropLiveTranscripts } = require('./live-cleanup');
  const removed = dropLiveTranscripts([W.company, W.app, W.outside, W.teamRoot, ...ws], { keep: KEEP });
  if (KEEP) { console.log(`kept ${W.base} and ${userData}`); return; }
  for (const d of [W.base, userData]) { for (let i = 0; i < 5 && fs.existsSync(d); i++) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { await sleep(1500); } } }
  console.log(`cleaned up: temp world + profile${removed.length ? ` + ${removed.length} transcript folder(s)` : ''}${fs.existsSync(W.base) || fs.existsSync(userData) ? ' (SOME LEFT: locked files)' : ''}`);
}

async function finish(code) {
  clearTimeout(hardStop);
  const spent = totalCost();
  await cleanup();
  const pass = results.filter((r) => r.ok).length, fail = results.length - pass;
  console.log(`cost: $${spent.toFixed(4)} (${costs.size} sessions)`);
  console.log(`team-live: ${pass} passed, ${fail} failed`);
  process.exit(code != null ? code : fail ? 1 : 0);
}
let hardStop = null;
if (require.main === module) hardStop = setTimeout(async () => { check('run', false, 'the whole run', `over the ${TOTAL_MS / 60000}-minute cap`); await finish(2); }, TOTAL_MS);

async function main() {
  console.log(`team-live: model ${MODEL}, exe ${path.basename(EXE)}, profile ${profile}, world ${path.basename(W.base)}${RESTART ? '' : ' (no restart: 9 and 11 skipped)'}`);
  makeWorld();
  const plan = await phase1();
  if (plan) await phase2(plan);
}
if (require.main === module) {
  main().then(() => finish(), async (e) => { check('run', false, 'the run', e && (e.stack || e.message)); await finish(1); });
  process.on('SIGINT', async () => { check('run', false, 'the run', 'interrupted'); await finish(130); });
} else {
  // tests / a dry run of the fixtures (no app): node -e "require('./tools/team-live.js')"
  module.exports = { W, CO, TOK, posDefs, posProposal, proposalsFile, makeWorld };
}
