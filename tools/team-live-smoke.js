'use strict';
// Live smoke (lane pos-t9-live, docs/POSITIONS.md 12 "T9"): the Positions engine wiring end to end on the REAL
// claude.exe and the real @anthropic-ai/claude-agent-sdk, the same flow test/engine/team-wiring.test.js runs with the
// fake SDK. No Electron: the engine runs in plain Node with a throwaway profile.
//
//   node tools/team-live-smoke.js [--model=claude-haiku-5-5] [--keep] [--step-s=240]      (a few cents, 2-5 min)
//
// A throwaway world under the OS temp dir (helm-team-smoke-*): Helm's userData, a team root, a company folder (no
// git repo) and an "outside" folder with a file the position may not read. Never the owner's Helm profile.
// Checks, each printed PASS/FAIL with its reason:
//   a  import a company + a position proposal (pending only), approve both (team.decide): the files on disk, the
//      FULL notebook (all four sections + a token only the notebook holds)
//   b  a CEO session in the company folder: init lists the team server and mcp__team__* tools; "Who is on the team?"
//      names the position
//   c  the CEO asks the position (team_ask) a question only the position's notebook answers: the CEO's reply has the
//      token; the CEO's mcp__team__team_ask item carries `team` { ticket, state } patched live
//   d  the position reads a file outside its powers: the guard denies (tool error, the guard's reason), a
//      request_access card arrives, the script answers Approve once, the Read is retried and succeeds, the reply has
//      the second token
// Then `team-live-smoke: N passed, M failed` and the run's cost (sum of every session's costUsd).
// Every step has a timeout (--step-s, default 240 s) and the whole run a 10-minute cap. The engine is shut down and
// any claude.exe this script started (by PID, never by name) is stopped at the end; temp folders and the CLI's
// transcript folders for the temp cwds are removed (--keep leaves them).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const argv = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const MODEL = typeof argv.model === 'string' ? argv.model : 'claude-haiku-5-5';
const STEP_MS = (Number(argv['step-s']) > 0 ? Number(argv['step-s']) : 240) * 1000;
const TOTAL_MS = 10 * 60_000;
const KEEP = !!argv.keep;
const tag = () => crypto.randomBytes(3).toString('hex').toUpperCase();
const HOME_RE = new RegExp([os.homedir(), os.homedir().replace(/\\/g, '/')].map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
// one line, the home folder as ~ and e-mail addresses redacted (the output gets pasted into reports)
const oneLine = (s, n = 160) => String(s == null ? '' : s).replace(HOME_RE, '~').replace(/\s+/g, ' ').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]').trim().slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(id, ok, what, why) {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${what} -- ${oneLine(why, 400) || (ok ? 'ok' : 'no detail')}`);
  return !!ok;
}
const info = (s) => console.log(`     ${s}`);

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}`);
    await sleep(250);
  }
}

// ---------------------------------------------------------------- the throwaway world

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-team-smoke-'));
const W = {
  base,
  userData: path.join(base, 'userdata'),
  teamRoot: path.join(base, 'team-root'),
  company: path.join(base, 'northwind-goods'),
  outside: path.join(base, 'outside'),
  statusline: path.join(base, 'statusline'),
};
for (const d of [W.userData, W.company, W.outside, W.statusline]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(W.company, 'README.md'), '# Northwind Goods\n\nA small online shop (test company).\n');
const DOCK = `DOCK-${tag()}`;      // only the position's notebook holds it
const VAULT = `VAULT-${tag()}`;    // only the outside file holds it
const VAULT_FILE = path.join(W.outside, 'vault-code.txt');
fs.writeFileSync(VAULT_FILE, `The vault code is ${VAULT}.\n`);
const POS = { id: 'orders', name: 'Orders Desk' };

function proposalsFile() {
  return {
    kind: 'helm-team-proposals', status: 'pending', company: 'northwind', draftedAt: new Date().toISOString(), draftedBy: 'team-live-smoke', note: 'live smoke fixture',
    proposals: [
      { ref: 'company', status: 'pending', team_propose: { action: 'company', id: 'northwind', name: 'Northwind Goods', folders: [W.company.replace(/\\/g, '/')], why: 'live smoke' } },
      { ref: 'orders', status: 'pending', team_propose: {
        action: 'create', id: POS.id, parent: null, name: POS.name, remit: 'Answers questions about orders, shipping and the warehouse dock.', scope: { kind: 'company' },
        brief: `# ${POS.name}\n\nAnswers questions about orders, shipping and the warehouse dock. Answer from your notebook; keep answers to one line.\n`,
        powers: { read: ['$workspace'], write: ['$workspace'], tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'], bash: 'off', agents: false, worktree: false },
        duties: [], model: MODEL, effort: 'low', seed: { notes: 'Orders ship on Mondays.', files: [] }, why: 'live smoke' },
      notebook_md: `# ${POS.name} · notebook\n## Decisions\n- Use the weekly sheet.\n## Facts\n- Orders ship on Mondays.\n- The warehouse dock code is ${DOCK}.\n## Open items\n- [ ] Check the returns policy.\n## Log\n` },
    ],
  };
}

// ---------------------------------------------------------------- the engine (real SDK, real claude.exe)

const logLines = [];
const updates = []; // session.itemUpdate patches with a `team` field
let engine = null;
const pids = new Set();
let pidTimer = null;

function startEngine() {
  const { createEngine } = require('../main/engine');
  engine = createEngine({
    userDataDir: W.userData,
    emit: (e, d) => {
      if (e === 'session.itemUpdate' && d && d.patch && d.patch.team) updates.push({ sessionId: d.sessionId, itemId: d.itemId, team: d.patch.team });
    },
    log: (lvl, msg) => { logLines.push(`${lvl} ${msg}`); if (logLines.length > 400) logLines.shift(); if (argv.verbose) console.log(`  [log] ${lvl} ${oneLine(msg, 300)}`); },
    statuslineDir: W.statusline, external: false, broker: false, etaDir: false, prewarmSdk: false, usageSampling: false,
    getIdleCloseMs: () => 0,
    team: { settings: () => ({ enabled: true }), root: () => W.teamRoot, rootProblem: () => null },
  });
  // every claude.exe the engine spawns, by PID (stopped at the end if shutdown left one)
  pidTimer = setInterval(() => {
    for (const es of engine._internal.sessions.values()) { const p = es.q && es.q._helmCli && es.q._helmCli.pid; if (p) pids.add(p); }
  }, 300);
}

const esOf = (id) => engine._internal.sessions.get(id);
const results = (es) => es.items.filter((it) => it.type === 'result' && !it.parentToolUseId);

// Send one message and wait for its turn to end. onTick(es) runs while the turn is live (answers cards).
async function turn(id, text, { onTick, ms = STEP_MS } = {}) {
  const es = esOf(id);
  const start = es.items.length;
  const before = results(es).length;
  await engine.methods['sessions.send']({ id, text });
  await until(async () => {
    if (onTick) await onTick(es);
    // any other card (a question, a plan) would hang the turn: refuse it
    for (const [rid, r] of es.requests || []) {
      if (r && r.item && r.item.kind !== 'access' && !r._smokeDenied) {
        r._smokeDenied = true;
        info(`(refused an unexpected ${r.item.kind || r.item.type} card in ${id})`);
        await engine.methods['sessions.respond']({ id, requestId: rid, response: { behavior: 'deny', message: 'Not in this test; answer without it.' } }).catch(() => {});
      }
    }
    return results(es).length > before && !es.turnActive;
  }, ms, `the turn in ${id}`);
  const span = es.items.slice(start);
  const main = span.filter((it) => !it.parentToolUseId);
  const reply = main.filter((it) => it.type === 'assistant').map((it) => it.text || '').join('\n');
  return { es, span, reply, tools: main.filter((it) => it.type === 'tool'), result: results(es).slice(-1)[0] };
}

const cost = () => (engine ? engine.snapshot().sessions.reduce((n, s) => n + (Number(s.costUsd) || 0), 0) : 0);

// ---------------------------------------------------------------- cleanup

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function imageOf(pid) {
  if (process.platform !== 'win32') return 'claude';
  try { return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(',')[0].replace(/"/g, '').trim(); } catch { return ''; }
}

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (engine) {
    try { await Promise.race([engine.shutdown(), sleep(20_000)]); } catch (e) { info(`engine.shutdown failed: ${e.message}`); }
  }
  if (pidTimer) clearInterval(pidTimer);
  // the CLIs this run started: give them a moment to exit, then stop survivors by PID (only a claude image)
  const end = Date.now() + 8000;
  while ([...pids].some(alive) && Date.now() < end) await sleep(250);
  const left = [...pids].filter(alive);
  for (const pid of left) {
    const img = imageOf(pid);
    if (/claude/i.test(img)) { try { process.kill(pid); info(`stopped leftover ${img} PID ${pid}`); } catch (e) { info(`could not stop PID ${pid}: ${e.message}`); } }
    else info(`PID ${pid} is no longer a claude process (${img || 'gone'}); left alone`);
  }
  console.log(`claude.exe processes started: ${pids.size}; still running after shutdown: ${left.length}`);
  let ws = [];
  try {
    ws = fs.readdirSync(path.join(W.teamRoot, 'northwind', 'positions'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(W.teamRoot, 'northwind', 'positions', d.name));
  } catch {}
  const { dropLiveTranscripts } = require('./live-cleanup');
  const removed = dropLiveTranscripts([W.company, W.outside, ...ws], { keep: KEEP });
  if (KEEP) console.log(`kept ${W.base}`);
  else { try { fs.rmSync(W.base, { recursive: true, force: true }); } catch {} console.log(`cleaned up: temp world${removed.length ? ` + ${removed.length} transcript folder(s)` : ''}`); }
}

// ---------------------------------------------------------------- the run

async function main() {
  console.log(`team-live-smoke: model ${MODEL}, step timeout ${STEP_MS / 1000} s, world ${path.basename(W.base)} (temp dir)`);
  startEngine();
  await until(() => engine.team.status().running, 10_000, 'Positions to start');

  // ---- a: import -> approve -> files on disk, the full notebook
  let made = null;
  try {
    const imp = await engine.methods['team.proposals.import']({ json: proposalsFile() });
    const byRef = (r) => (imp.imported.find((x) => x.ref === r) || {}).id;
    const list0 = await engine.methods['team.list']({});
    check('a1', imp.imported.length === 2 && list0.companies.length === 0, 'import loads the proposals as pending only', `${imp.imported.length} imported, ${list0.companies.length} companies before any approval`);
    const co = await engine.methods['team.decide']({ proposal: byRef('company'), decision: 'approve' });
    made = await engine.methods['team.decide']({ proposal: byRef('orders'), decision: 'approve' });
    check('a2', co.ok === true && made.ok === true && made.created && made.created.id === POS.id, 'team.decide approve creates the company and the position', `company ${co.ok ? 'ok' : co.error}; position ${made.ok ? JSON.stringify(made.created) : made.error}`);
    const ws = path.join(W.teamRoot, 'northwind', 'positions', POS.id);
    const files = ['position.json', 'brief.md', 'notebook.md', 'chats.json'].filter((f) => fs.existsSync(path.join(ws, f)));
    const nb = fs.existsSync(path.join(ws, 'notebook.md')) ? fs.readFileSync(path.join(ws, 'notebook.md'), 'utf8') : '';
    const heads = ['## Decisions', '## Facts', '## Open items', '## Log'].filter((h) => nb.includes(h));
    check('a3', fs.existsSync(path.join(W.teamRoot, 'northwind', 'company.json')) && files.length === 4 && heads.length === 4 && nb.includes(DOCK) && /weekly sheet/.test(nb),
      'files on disk with the FULL notebook', `company.json ${fs.existsSync(path.join(W.teamRoot, 'northwind', 'company.json')) ? 'yes' : 'NO'}; ${files.join(', ')}; ${heads.length}/4 sections; dock token ${nb.includes(DOCK) ? 'in' : 'NOT in'} the notebook`);
  } catch (e) { check('a', false, 'import + approve', e.message); }
  if (!made || !made.ok) throw new Error('no position: the live steps need one');

  // ---- b: a CEO session in the company folder sees the roster
  const ceo = await engine.methods['sessions.create']({ cwd: W.company, model: MODEL });
  let b = null;
  try {
    b = await turn(ceo.id, 'Who is on the team? Use your team tools (team_roster), no other tools, and do not ask me anything. Answer in one or two lines.');
    const init = b.es.initInfo || { tools: [], mcpServers: [] };
    const team = (init.mcpServers || []).find((s) => s.name === 'team');
    const teamTools = (init.tools || []).filter((t) => t.startsWith('mcp__team__'));
    check('b1', team && team.status === 'connected' && teamTools.includes('mcp__team__team_roster') && teamTools.includes('mcp__team__team_ask'),
      'the CEO\'s init lists the team server and its tools', `team server ${team ? team.status : 'MISSING'}; ${teamTools.length} mcp__team__ tools: ${teamTools.map((t) => t.replace('mcp__team__', '')).join(', ')}`);
    const snap = engine.snapshot().sessions.find((s) => s.id === ceo.id) || {};
    check('b2', snap.team && snap.team.company === 'northwind', 'the session is the company\'s CEO (session.team)', JSON.stringify(snap.team || null));
    const roster = b.tools.find((t) => t.name === 'mcp__team__team_roster');
    check('b3', b.reply.includes(POS.name) || b.reply.includes(POS.id), 'the CEO\'s reply names the position',
      `team_roster ${roster ? `called (${roster.status})` : 'not called'}; reply: ${oneLine(b.reply)}`);
  } catch (e) { check('b', false, 'CEO roster turn', e.message); }

  // ---- c: CEO -> position ask, answered from the position's notebook
  let posId = null;
  try {
    const c = await turn(ceo.id, `Call team_ask with to "${POS.id}", wait_s 180 and this exact question: "What is the warehouse dock code? Reply with the code only." Then tell me the code it answered, in one line. Use no other tools and do not ask me anything.`);
    const askItem = c.tools.find((t) => t.name === 'mcp__team__team_ask');
    check('c1', c.reply.includes(DOCK), 'the position answered the CEO with the token only its notebook holds', `team_ask ${askItem ? askItem.status : 'not called'}; reply: ${oneLine(c.reply)}`);
    const live = askItem && updates.find((u) => u.sessionId === ceo.id && u.itemId === askItem.id);
    check('c2', !!(askItem && askItem.team && askItem.team.ticket && askItem.team.state && live), 'the CEO\'s team_ask item carries `team` from the live patch',
      askItem ? `team ${JSON.stringify(askItem.team ? { ticket: askItem.team.ticket, state: askItem.team.state } : null)}; ${updates.filter((u) => u.sessionId === ceo.id).length} live team patch(es)` : 'no team_ask item');
    const pos = engine.snapshot().sessions.find((s) => s.position && s.position.id === POS.id);
    posId = pos ? pos.id : null;
    const pes = posId && esOf(posId);
    const ptools = pes && pes.initInfo ? pes.initInfo.tools : [];
    const mcpOk = ptools.filter((t) => t.startsWith('mcp__')).every((t) => t.startsWith('mcp__team__'));
    const pservers = pes && pes.initInfo ? pes.initInfo.mcpServers.map((s) => `${s.name}:${s.status}`) : [];
    check('c3', !!pos && pos.position.chat === 1 && mcpOk && pservers.join(',') === 'team:connected' && ptools.includes('mcp__team__request_access'),
      'the position chat ran isolated (team server only)', pos ? `chat ${pos.position.chat}; servers ${pservers.join(', ') || 'none'}; ${ptools.length} tools, mcp__ ${ptools.filter((t) => t.startsWith('mcp__')).map((t) => t.replace('mcp__team__', '')).join(', ')}` : 'no position session');
    const posCost = pos ? Number(pos.costUsd) || 0 : 0;
    info(`the position's chat cost so far $${posCost.toFixed(4)}`);
  } catch (e) { check('c', false, 'CEO -> position ask', e.message); }

  // ---- d: guard deny -> request_access -> Approve once -> the retried Read succeeds
  try {
    const opened = await engine.methods['team.open']({ company: 'northwind', id: POS.id });
    if (posId) check('d0', opened.sessionId === posId, 'team.open returns the position\'s current chat', `${opened.sessionId === posId ? 'same chat as the ask' : `a different chat ${opened.sessionId}`}`);
    posId = opened.sessionId;
    const cards = [];
    const answerCards = async (es) => {
      for (const [rid, r] of es.requests || []) {
        if (!r || !r.item || r.item.kind !== 'access' || cards.some((c) => c.requestId === rid)) continue;
        cards.push({ requestId: rid, access: r.item.access });
        info(`access card: ${JSON.stringify(r.item.access && { kind: r.item.access.kind, target: r.item.access.target && path.basename(String(r.item.access.target)) })}; answering Approve once`);
        await engine.methods['sessions.respond']({ id: posId, requestId: rid, response: { behavior: 'allow', scope: 'once' } });
      }
    };
    const fwd = VAULT_FILE.replace(/\\/g, '/');
    // "try the Read first": with only its instructions the model may call request_access before any Read (run 1 did),
    // which never exercises the guard's deny
    const d1 = await turn(posId, `Call the Read tool on the file ${fwd} right away, before anything else (do not call request_access first: try the read itself). Reply with the vault code it contains, in one line. If the read is denied, follow the instructions in the denial.`, { onTick: answerCards });
    const reads = (r) => r.tools.filter((t) => t.name === 'Read' && /vault-code\.txt/i.test(JSON.stringify(t.input || {})));
    let rs = reads(d1);
    const denied = rs.find((t) => t.status === 'error' || t.status === 'denied');
    check('d1', !!denied && /Outside your area|request_access/i.test(String(denied.result || '')), 'the guard denies the Read outside the position\'s powers',
      denied ? `${denied.status}: ${oneLine(denied.result, 200)}` : `Read calls: ${rs.map((t) => t.status).join(', ') || 'none'}; tools: ${d1.tools.map((t) => t.name).join(', ')}`);
    const ra = d1.tools.find((t) => t.name === 'mcp__team__request_access');
    check('d2', !!ra && cards.length >= 1, 'request_access raised an access card, answered Approve once', `request_access ${ra ? `${ra.status}: ${oneLine(ra.result, 160)}` : 'not called'}; ${cards.length} card(s)`);
    let okRead = rs.find((t) => t.status === 'done' || t.status === 'ok' || t.status === 'success' || (t !== denied && t.status !== 'error' && t.status !== 'denied' && t.status !== 'running'));
    let reply = d1.reply;
    let followUp = false;
    if (!okRead && cards.length) {
      followUp = true;
      const d2 = await turn(posId, `Access was approved once. Now read ${fwd} again with the Read tool and reply with the vault code, in one line.`, { onTick: answerCards });
      rs = reads(d2);
      okRead = rs.find((t) => t.status !== 'error' && t.status !== 'denied' && t.status !== 'running');
      reply = d2.reply;
    }
    check('d3', !!okRead && reply.includes(VAULT), `the retried Read succeeds and the reply has the token${followUp ? ' (after a follow-up "read it again" message: the model did not retry on its own)' : ' (the model retried on its own)'}`,
      `Read ${okRead ? okRead.status : 'never succeeded'}; reply: ${oneLine(reply, 320)}`);
    const grants = path.join(W.teamRoot, 'northwind', 'grants.jsonl');
    const g = fs.existsSync(grants) ? fs.readFileSync(grants, 'utf8') : '';
    check('d4', /"once"/.test(g), 'the once-grant is on file (grants.jsonl)', g ? `${g.trim().split('\n').length} line(s)` : 'no grants.jsonl');
  } catch (e) { check('d', false, 'guard deny -> request_access -> once', e.message); }
}

const hardStop = setTimeout(async () => {
  check('run', false, 'the whole run', `over the ${TOTAL_MS / 60000}-minute cap`);
  await finish(2);
}, TOTAL_MS);

async function finish(code) {
  clearTimeout(hardStop);
  const spent = cost();
  await cleanup();
  console.log(`cost: $${spent.toFixed(4)}`);
  console.log(`team-live-smoke: ${pass} passed, ${fail} failed`);
  if (fail && logLines.length) {
    const warn = logLines.filter((l) => /^(warn|error) /.test(l)).slice(-8);
    if (warn.length) { console.log('engine warnings (last 8):'); for (const l of warn) console.log(`  ${oneLine(l, 300)}`); }
  }
  process.exit(code != null ? code : fail ? 1 : 0);
}

main().then(() => finish(), async (e) => {
  check('run', false, 'the run', e && (e.stack || e.message));
  await finish(1);
});
