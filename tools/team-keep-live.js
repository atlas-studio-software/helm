'use strict';
// Live proof (lane pos-keep-live): a CEO chat and a position chat survive a Helm restart through the CLI broker, on
// the REAL claude.exe and the real @anthropic-ai/claude-agent-sdk. The same flow test/engine/team-fix-session.test.js
// runs with fakes ("two-engine restart"). No Electron: two engines run one after the other in plain Node on one
// throwaway profile, the way main.js restarts (engine.shutdown({ cause: 'restart' }) with keeping on, then a new
// engine on the same userData re-attaches what the broker kept).
//
//   node tools/team-keep-live.js [--model=claude-haiku-5-5] [--keep] [--no-keep] [--step-s=240] [--verbose]   (a few cents)
//
// A throwaway world under the OS temp dir (helm-team-keep-*): Helm's userData, a team root, a company folder and an
// "outside" folder the position may not read. Never the owner's Helm profile. The position's answer needs a trail of
// files in its workspace (ledger-1.txt names ledger-2.txt, ... the last holds a token), so it is mid-answer for a while.
// Checks, each printed PASS/FAIL with its evidence:
//   a   company + position imported and approved (team.proposals.import / team.decide)
//   b   engine A: the CEO and position CLIs run in the broker; the restart catches the CEO's team_ask in flight and
//       the position mid-answer; shutdown({ cause: 'restart' }) detaches both
//   c   the same claude.exe PIDs stay alive across the restart; engine B re-attached both ("Kept running through the
//       restart", no restart note) on the same PIDs
//   d   the CEO's team_ask returns the position's answer in the same tool call; the CEO's reply has the token; one
//       ticket; the question reached the position once; the broker log shows the re-delivered team_ask and the
//       position's re-initialize with hooks_applied true
//   e   the position's guard still denies a Read outside its area after the re-attach
//   f   a follow-up to the CEO runs on the same CLI pid
// --no-keep: "Keep sessions running through a restart" OFF (engine option detach: false), so the restart ends both
// CLIs. Then, instead of b..f (docs/POSITIONS.md 5.5 "Without keep, each question still reaches the answerer once"):
//   b   both CLIs ran (not keepable); shutdown({ cause: 'restart' }) ended both and left restart notes
//   c   engine B: Positions running; the CEO is continued ("Continue where you left off") at once, while the
//       position's cut-off answer is resumed by recovery
//   d   one ticket; the question reached the position once (one full <helm-ask>, any resume is a note only, one
//       first delivery in the cross-talk log); the CEO's reply has the token (by re-joining its open ticket in-call,
//       or as a late answer)
//   (--keep here keeps the temp world for a look; it is not the setting)
// Run it from PowerShell or a normal terminal, not Git Bash: a shell whose Windows job forbids breakaway keeps the
// broker in that job, Helm then counts no CLI as keepable (broker-launch.js jobSafe) and b1 fails saying so.
// Then engine B shuts down normally (the broker ends the CLIs and exits), leftovers are stopped by PID, the temp world
// and the CLI transcript folders for the temp cwds are removed. Last line: `team-keep-live: N passed, M failed`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const argv = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const MODEL = typeof argv.model === 'string' ? argv.model : 'claude-haiku-5-5';
const STEP_MS = (Number(argv['step-s']) > 0 ? Number(argv['step-s']) : 240) * 1000;
const TOTAL_MS = 12 * 60_000;
const KEEP = !!argv.keep;
const NO_KEEP = !!argv['no-keep']; // the setting "Keep sessions running through a restart" off
const TRAIL = 5;
const tag = () => crypto.randomBytes(3).toString('hex').toUpperCase();
const HOME_RE = new RegExp([os.homedir(), os.homedir().replace(/\\/g, '/')].map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
const oneLine = (s, n = 160) => String(s == null ? '' : s).replace(HOME_RE, '~').replace(/\s+/g, ' ').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]').trim().slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const str = (v) => (typeof v === 'string' ? v : JSON.stringify(v == null ? '' : v));

let pass = 0, fail = 0;
function check(id, ok, what, why) {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${what} -- ${oneLine(why, 500) || (ok ? 'ok' : 'no detail')}`);
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-team-keep-'));
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
const LEDGER = `LEDGER-${tag()}`;  // only the last file of the position's trail holds it
const VAULT = `VAULT-${tag()}`;    // only the outside file holds it
const VAULT_FILE = path.join(W.outside, 'vault-code.txt');
fs.writeFileSync(VAULT_FILE, `The vault code is ${VAULT}.\n`);
const POS = { id: 'orders', name: 'Orders Desk' };
const WS = path.join(W.teamRoot, 'northwind', 'positions', POS.id);
const fwd = (p) => p.replace(/\\/g, '/');

function proposalsFile() {
  return {
    kind: 'helm-team-proposals', status: 'pending', company: 'northwind', draftedAt: new Date().toISOString(), draftedBy: 'team-keep-live', note: 'live keep fixture',
    proposals: [
      { ref: 'company', status: 'pending', team_propose: { action: 'company', id: 'northwind', name: 'Northwind Goods', folders: [fwd(W.company)], why: 'live keep' } },
      { ref: 'orders', status: 'pending', team_propose: {
        action: 'create', id: POS.id, parent: null, name: POS.name, remit: 'Answers questions about orders and the ledger.', scope: { kind: 'company' },
        brief: `# ${POS.name}\n\nAnswers questions about orders and the ledger. Keep answers to one line.\n`,
        powers: { read: ['$workspace'], write: ['$workspace'], tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'], bash: 'off', agents: false, worktree: false },
        duties: [], model: MODEL, effort: 'low', seed: { notes: 'Orders ship on Mondays.', files: [] }, why: 'live keep' },
      notebook_md: `# ${POS.name} · notebook\n## Decisions\n- Use the weekly sheet.\n## Facts\n- Orders ship on Mondays.\n- The ledger code is never in this notebook: it is at the end of the ledger trail (ledger-1.txt in my workspace; each file names the next).\n## Open items\n## Log\n` },
    ],
  };
}

function writeTrail() {
  for (let i = 1; i <= TRAIL; i++) {
    const body = i < TRAIL
      ? `Ledger trail, step ${i} of ${TRAIL}. The code is not here. Next, read ${fwd(path.join(WS, `ledger-${i + 1}.txt`))} with the Read tool.\n`
      : `Ledger trail, step ${i} of ${TRAIL}. The ledger code is ${LEDGER}.\n`;
    fs.writeFileSync(path.join(WS, `ledger-${i}.txt`), body);
  }
}

// ---------------------------------------------------------------- the engines (real SDK, real claude.exe, real broker)

const logLines = [];
let engine = null;       // the current engine (A, then B)
let label = '';
const pids = new Set();  // every claude.exe pid seen (stopped by PID at the end if still alive)
const brokerPids = new Set();
let pidTimer = null;

const pidOf = (es) => (es && ((es.brokerProc && es.brokerProc.pid) || (es.q && es.q._helmCli && es.q._helmCli.pid))) || null;

function startEngine(name) {
  const { createEngine } = require('../main/engine');
  label = name;
  engine = createEngine({
    userDataDir: W.userData,
    emit: () => {},
    log: (lvl, msg) => { logLines.push(`${lvl} [${name}] ${msg}`); if (logLines.length > 600) logLines.shift(); if (argv.verbose) console.log(`  [${name}] ${lvl} ${oneLine(msg, 300)}`); },
    statuslineDir: W.statusline, external: false, etaDir: false, prewarmSdk: false, usageSampling: false,
    detach: !NO_KEEP, // "Keep sessions running through a restart" on (off with --no-keep); broker: the real broker-client.js (default)
    getIdleCloseMs: () => 0,
    team: { settings: () => ({ enabled: true }), root: () => W.teamRoot, rootProblem: () => null },
  });
  if (pidTimer) clearInterval(pidTimer);
  const e = engine;
  pidTimer = setInterval(() => { for (const es of e._internal.sessions.values()) { const p = pidOf(es); if (p) pids.add(p); } }, 300);
  return engine;
}

const esOf = (id) => engine._internal.sessions.get(id);
const results = (es) => es.items.filter((it) => it.type === 'result' && !it.parentToolUseId);
const mainItems = (es, from = 0) => es.items.slice(from).filter((it) => !it.parentToolUseId);
const replyOf = (items) => items.filter((it) => it.type === 'assistant').map((it) => it.text || '').join('\n');

async function refuseCards(id, es) {
  for (const [rid, r] of es.requests || []) {
    if (r && r.item && !r._keepDenied) {
      r._keepDenied = true;
      info(`(refused a ${r.item.kind || r.item.type} card in ${id === ceoId ? 'the CEO' : 'the position'})`);
      await engine.methods['sessions.respond']({ id, requestId: rid, response: { behavior: 'deny', message: 'Not in this test; answer without it.' } }).catch(() => {});
    }
  }
}

async function turn(id, text, { ms = STEP_MS } = {}) {
  const es = esOf(id);
  const start = es.items.length;
  const before = results(es).length;
  await engine.methods['sessions.send']({ id, text });
  await until(async () => { await refuseCards(id, es); return results(es).length > before && !es.turnActive; }, ms, `the turn in ${id}`);
  const main = mainItems(es, start);
  return { es, reply: replyOf(main), tools: main.filter((it) => it.type === 'tool') };
}

const cost = () => (engine ? engine.snapshot().sessions.reduce((n, s) => n + (Number(s.costUsd) || 0), 0) : 0);

// ---------------------------------------------------------------- cleanup

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function imageOf(pid) {
  if (process.platform !== 'win32') return 'claude';
  try { return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(',')[0].replace(/"/g, '').trim(); } catch { return ''; }
}
async function noteBrokers() {
  try { const st = await engine.methods['sessions.keepStatus'](); for (const b of st.brokers || []) if (b.pid) brokerPids.add(b.pid); return st; } catch { return null; }
}

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (engine) {
    await noteBrokers();
    try { await Promise.race([engine.shutdown({ cause: 'quit' }), sleep(20_000)]); } catch (e) { info(`engine.shutdown failed: ${e.message}`); }
  }
  if (pidTimer) clearInterval(pidTimer);
  const end = Date.now() + 10_000;
  while ([...pids, ...brokerPids].some(alive) && Date.now() < end) await sleep(250);
  const left = [...pids].filter(alive);
  for (const pid of left) {
    const img = imageOf(pid);
    if (/claude/i.test(img)) { try { process.kill(pid); info(`stopped leftover ${img} PID ${pid}`); } catch (e) { info(`could not stop PID ${pid}: ${e.message}`); } }
    else info(`PID ${pid} is no longer a claude process (${img || 'gone'}); left alone`);
  }
  const bleft = [...brokerPids].filter(alive);
  for (const pid of bleft) {
    const img = imageOf(pid);
    if (/^node/i.test(img)) { try { process.kill(pid); info(`stopped leftover broker ${img} PID ${pid}`); } catch (e) { info(`could not stop broker PID ${pid}: ${e.message}`); } }
    else info(`broker PID ${pid} is no longer node (${img || 'gone'}); left alone`);
  }
  console.log(`claude.exe processes started: ${pids.size}; still running after shutdown: ${left.length}; broker(s) ${[...brokerPids].join(', ') || 'none seen'}, still running: ${bleft.length}`);
  const { dropLiveTranscripts } = require('./live-cleanup');
  let removed = [];
  // the broker may hold files in userData for a moment after it exits
  for (let i = 0; i < 3; i++) { try { removed = dropLiveTranscripts([W.company, W.outside, WS], { keep: KEEP }); break; } catch { await sleep(1000); } }
  if (KEEP) console.log(`kept ${W.base}`);
  else {
    for (let i = 0; i < 5 && fs.existsSync(W.base); i++) { try { fs.rmSync(W.base, { recursive: true, force: true }); } catch { await sleep(1000); } }
    console.log(`cleaned up: temp world${fs.existsSync(W.base) ? ' NOT fully removed' : ''}${removed.length ? ` + ${removed.length} transcript folder(s)` : ''}`);
  }
}

// ---------------------------------------------------------------- the run

let ceoId = null, posId = null;
let costA = 0;

async function main() {
  console.log(`team-keep-live: model ${MODEL}, step timeout ${STEP_MS / 1000} s, world ${path.basename(W.base)} (temp dir)`);
  startEngine('A');
  await until(() => engine.team.status().running, 15_000, 'Positions to start (A)');

  // ---- a: import -> approve
  const imp = await engine.methods['team.proposals.import']({ json: proposalsFile() });
  const byRef = (r) => (imp.imported.find((x) => x.ref === r) || {}).id;
  const co = await engine.methods['team.decide']({ proposal: byRef('company'), decision: 'approve' });
  const made = await engine.methods['team.decide']({ proposal: byRef('orders'), decision: 'approve' });
  check('a', co.ok === true && made.ok === true && fs.existsSync(path.join(WS, 'notebook.md')), 'company + position approved', `company ${co.ok ? 'ok' : co.error}; position ${made.ok ? JSON.stringify(made.created) : made.error}`);
  if (!made.ok) throw new Error('no position: the live steps need one');
  writeTrail();

  // ---- b: CEO asks; restart while the ask is in flight and the position is mid-answer
  const ceo = await engine.methods['sessions.create']({ cwd: W.company, model: MODEL });
  ceoId = ceo.id;
  const ceoA = esOf(ceoId);
  const askStart = ceoA.items.length;
  const q = `What is the ledger code? Read ${fwd(path.join(WS, 'ledger-1.txt'))} with the Read tool, then follow the trail one file at a time (each file names the next) until you reach the code. Reply with the code only.`;
  await engine.methods['sessions.send']({ id: ceoId, text: `Call team_ask with to "${POS.id}", wait_s 240 and this exact question: "${q}" Then tell me the code it answered, in one line. Use no other tools and do not ask me anything.` });
  let ask = null, pesA = null, readsAtRestart = 0;
  await until(async () => {
    await refuseCards(ceoId, ceoA);
    ask = mainItems(ceoA, askStart).find((it) => it.type === 'tool' && it.name === 'mcp__team__team_ask');
    const pos = engine.snapshot().sessions.find((s) => s.position && s.position.id === POS.id);
    if (pos) { posId = pos.id; pesA = esOf(posId); await refuseCards(posId, pesA); }
    if (!ask || ask.status !== 'running' || !pesA || !pesA.turnActive) return false;
    readsAtRestart = pesA.items.filter((it) => it.type === 'tool' && it.name === 'Read' && /ledger-\d/.test(str(it.input))).length;
    return readsAtRestart >= 1;
  }, STEP_MS, 'the CEO\'s team_ask in flight and the position mid-answer (its first ledger Read)');
  const ceoPidA = pidOf(ceoA), posPidA = pidOf(pesA);
  const ticketA = ask.team && ask.team.ticket;
  const posDoneReads = pesA.items.filter((it) => it.type === 'tool' && it.name === 'Read' && /ledger-\d/.test(str(it.input)) && it.status !== 'running').length;
  if (NO_KEEP) return noKeepRestart({ q, ceoA, pesA, ask, ticketA, readsAtRestart, posDoneReads });
  const ks = await noteBrokers();
  check('b1', !!(ceoA.brokerProc && pesA.brokerProc && ceoPidA && posPidA && ceoA.canKeep() && pesA.canKeep()), 'engine A: both CLIs run in the broker and can be kept',
    `CEO pid ${ceoPidA} (broker ${!!ceoA.brokerProc}), position pid ${posPidA} (broker ${!!pesA.brokerProc}); canKeep CEO ${ceoA.canKeep()}, position ${pesA.canKeep()}; broker job safe ${ks ? ks.safe : '?'}${ks && ks.job && ks.job.note ? ` (${ks.job.note})` : ''}`);
  costA = cost();
  info(`restarting: CEO team_ask ${ask.status} (ticket ${ticketA || '?'}), position turn active ${pesA.turnActive}, ${readsAtRestart} ledger Read(s) started, ${posDoneReads} finished`);
  const t0 = Date.now();
  await engine.shutdown({ cause: 'restart' });
  const detachedLog = logLines.filter((l) => /\[A\].*restart detached/.test(l)).slice(-1)[0] || '';
  check('b2', /detached 2 of 2/.test(detachedLog) && ceoA.brokerProc.detached && pesA.brokerProc.detached, 'engine A shutdown({ cause: "restart" }) detached both CLIs', oneLine(detachedLog.replace(/^\S+ \[A\] /, ''), 200) || 'no detach log line');
  clearInterval(pidTimer); pidTimer = null;
  engine = null;
  const aliveGap = [ceoPidA, posPidA].map((p) => `${p} ${alive(p) ? 'alive' : 'GONE'}`).join(', ');

  // ---- c: engine B on the same userData + team root re-attaches
  startEngine('B');
  const ceoB = await until(() => { const es = esOf(ceoId); return es && es.q ? es : null; }, 60_000, 'engine B to re-attach the CEO');
  const pesB = await until(() => { const es = esOf(posId); return es && es.q ? es : null; }, 60_000, 'engine B to re-attach the position');
  await until(() => !ceoB.awaitingReinit && !pesB.awaitingReinit, 30_000, 'both re-initialize answers');
  info(`re-attached ${Math.round((Date.now() - t0) / 1000)} s after the restart began`);
  const ceoPidB = pidOf(ceoB), posPidB = pidOf(pesB);
  check('c1', alive(ceoPidA) && alive(posPidA) && ceoPidB === ceoPidA && posPidB === posPidA, 'the same claude.exe PIDs are alive and engine B drives them',
    `between engines: ${aliveGap}; B: CEO pid ${ceoPidB}, position pid ${posPidB}`);
  const keptItem = (es) => es.items.find((it) => it.type === 'system' && /Kept running through the restart/.test(str(it.text || it)));
  const noteOf = (es) => (es.stopNote ? JSON.stringify(es.stopNote).slice(0, 120) : 'none');
  check('c2', !!keptItem(ceoB) && !!keptItem(pesB) && !ceoB.stopNote && !pesB.stopNote, 'engine B re-attached both sessions, no restart note',
    `CEO: kept item ${keptItem(ceoB) ? 'yes' : 'NO'}, restart note ${noteOf(ceoB)}; position: kept item ${keptItem(pesB) ? 'yes' : 'NO'}, restart note ${noteOf(pesB)}; ${logLines.filter((l) => /\[B\].*(re-attached|re-delivered|hooks_applied)/.test(l)).map((l) => l.replace(/^\S+ \[B\] /, '')).join(' | ')}`);

  // ---- d: the CEO's team_ask answers in the same call
  await until(async () => { await refuseCards(ceoId, ceoB); await refuseCards(posId, pesB); return !ceoB.turnActive && !pesB.turnActive; }, STEP_MS, 'the CEO\'s ask turn to end in engine B');
  const asksB = ceoB.items.filter((it) => it.type === 'tool' && it.name === 'mcp__team__team_ask' && !it.parentToolUseId);
  const askB = asksB.find((it) => it.toolUseId === ask.toolUseId) || asksB[asksB.length - 1];
  const askIdx = ceoB.items.indexOf(askB);
  const ceoReply = replyOf(mainItems(ceoB, askIdx + 1));
  const lateTurns = ceoB.items.filter((it) => it.type === 'user' && it.origin === 'answer');
  check('d1', !!askB && askB.toolUseId === ask.toolUseId && asksB.length === 1 && askB.status !== 'running' && askB.status !== 'error' && str(askB.result).includes(LEDGER) && lateTurns.length === 0,
    'the CEO\'s team_ask returned the position\'s answer in the same tool call',
    askB ? `${asksB.length} team_ask item(s), same tool_use id as in A ${askB.toolUseId === ask.toolUseId}; status ${askB.status}; result: ${oneLine(str(askB.result), 200)}; late-answer turns ${lateTurns.length}` : 'no team_ask item in B');
  check('d2', ceoReply.includes(LEDGER), 'the CEO\'s reply has the token', oneLine(ceoReply, 200));
  const xt = path.join(W.teamRoot, 'northwind');
  const lines = [];
  for (const f of (fs.existsSync(xt) ? fs.readdirSync(xt) : []).filter((n) => /crosstalk/.test(n))) {
    for (const l of fs.readFileSync(path.join(xt, f), 'utf8').split('\n')) { try { if (l.trim()) lines.push(JSON.parse(l)); } catch {} }
  }
  const tickets = [...new Set(lines.map((l) => l.ticket).filter(Boolean))];
  const asked = pesB.items.filter((it) => it.type === 'user' && it.origin === 'ask');
  check('d3', tickets.length === 1 && asked.length === 1, 'exactly one ticket; the question reached the position once',
    `tickets ${tickets.join(', ') || 'none'} (states ${lines.map((l) => l.state).join(' > ')}); ask messages in the position chat: ${asked.length}`);
  // the broker's own log: the repeated initialize (hooks_applied for the guarded position) and the re-delivered
  // team_ask the old Helm never answered
  let blog = '';
  try { blog = fs.readFileSync(path.join(W.userData, 'logs', 'broker.log'), 'utf8'); } catch {}
  const bl = blog.split('\n').map((l) => l.replace(/^\S+ \[broker [^\]]*\] /, ''));
  const reinitPos = bl.find((l) => l.startsWith('re-initialize ') && l.includes(posId));
  const redeliv = bl.find((l) => /re-delivered [0-9]+ unanswered mcp_message/.test(l) && l.includes(ceoId));
  check('d4', !!redeliv && !!reinitPos && /hooks_applied true/.test(reinitPos), 'the broker re-delivered the unanswered team_ask; the position\'s re-initialize confirmed its hooks',
    `${redeliv || 'no re-delivery line'} | ${reinitPos || 'no position re-initialize line'}`);
  const posReads = pesB.items.filter((it) => it.type === 'tool' && it.name === 'Read' && /ledger-\d/.test(str(it.input)));
  info(`the position's ledger Reads: ${posReads.map((t) => `${(str(t.input).match(/ledger-\d/) || [''])[0]}:${t.status}`).join(', ')}`);

  // ---- e: the guard still denies a Read outside the position's area
  const e1 = await turn(posId, `Call the Read tool on the file ${fwd(VAULT_FILE)} right away (do not call request_access first: try the read itself). If it is denied, do NOT call request_access; just reply "denied" in one line.`);
  const vr = e1.tools.filter((t) => t.name === 'Read' && /vault-code\.txt/i.test(str(t.input)));
  const denied = vr.find((t) => t.status === 'error' || t.status === 'denied');
  check('e', !!denied && !vr.some((t) => t !== denied && t.status !== 'error' && t.status !== 'denied') && !e1.reply.includes(VAULT) && pidOf(pesB) === posPidA,
    'the position\'s guard still denies a Read outside its area after the re-attach',
    denied ? `pid ${pidOf(pesB)}; ${denied.status}: ${oneLine(str(denied.result), 200)}; reply: ${oneLine(e1.reply, 80)}` : `Read calls: ${vr.map((t) => t.status).join(', ') || 'none'}; tools: ${e1.tools.map((t) => t.name).join(', ')}; reply: ${oneLine(e1.reply, 120)}`);

  // ---- f: a follow-up to the CEO on the same CLI
  const f1 = await turn(ceoId, 'Reply with exactly the word PONG and nothing else. Use no tools.');
  check('f', /PONG/.test(f1.reply) && pidOf(ceoB) === ceoPidA && alive(ceoPidA), 'a follow-up to the CEO runs on the same CLI pid', `pid ${pidOf(ceoB)} (A had ${ceoPidA}); reply: ${oneLine(f1.reply, 80)}`);
}

// --no-keep: the restart ends both CLIs; each question must still reach the position once.
async function noKeepRestart({ q, ceoA, pesA, ask, ticketA, readsAtRestart, posDoneReads }) {
  const ceoPidA = pidOf(ceoA), posPidA = pidOf(pesA);
  check('b1', !!(ceoPidA && posPidA && !ceoA.canKeep() && !pesA.canKeep()), 'engine A (keeping off): both CLIs run and are not keepable',
    `CEO pid ${ceoPidA}, position pid ${posPidA}; canKeep CEO ${ceoA.canKeep()}, position ${pesA.canKeep()}`);
  costA = cost();
  info(`restarting: CEO team_ask ${ask.status} (ticket ${ticketA || '?'}, tool use ${ask.toolUseId || '?'}), position turn active ${pesA.turnActive}, ${readsAtRestart} ledger Read(s) started, ${posDoneReads} finished`);
  await engine.shutdown({ cause: 'restart' });
  await until(() => !alive(ceoPidA) && !alive(posPidA), 15_000, 'both CLIs to end with engine A').catch(() => null);
  const noted = (es) => !!(es.s.restartNote && es.s.restartNote.working);
  check('b2', !alive(ceoPidA) && !alive(posPidA) && noted(ceoA) && noted(pesA), 'engine A shutdown({ cause: "restart" }) ended both CLIs and noted what it cut off',
    `CEO pid ${ceoPidA} ${alive(ceoPidA) ? 'ALIVE' : 'gone'}, restart note ${noted(ceoA)}; position pid ${posPidA} ${alive(posPidA) ? 'ALIVE' : 'gone'}, restart note ${noted(pesA)}`);
  clearInterval(pidTimer); pidTimer = null;
  engine = null;

  // ---- c: engine B; the CEO is continued at once (it usually calls team_ask again); recovery resumes the position
  startEngine('B');
  await until(() => engine.team.status().running, 15_000, 'Positions to start (B)');
  const ceoB = esOf(ceoId), pesB = esOf(posId);
  const from = ceoB.items.length;
  const cont = await engine.methods['sessions.continueAfterRestart']({ id: ceoId }).catch((e) => ({ action: 'error', message: e.message }));
  check('c', !!ceoB && !!pesB && cont.action === 'continued', 'engine B: Positions running; the CEO continued after the restart', `continue: ${cont.action} (${oneLine(cont.message, 80)})`);
  const ceoText = () => replyOf(mainItems(ceoB, from));
  await until(async () => {
    await refuseCards(ceoId, ceoB); await refuseCards(posId, pesB);
    return ceoText().includes(LEDGER) && !ceoB.turnActive && !pesB.turnActive && !ceoB.starting && !pesB.starting;
  }, STEP_MS * 2, 'the CEO to relay the token after the restart').catch((e) => info(e.message));
  await sleep(3000); // a late answer or a stray turn would show by now

  // ---- d: one ticket, one copy of the question in the position's chat, the CEO has the token
  const xt = path.join(W.teamRoot, 'northwind');
  const lines = [];
  for (const f of (fs.existsSync(xt) ? fs.readdirSync(xt) : []).filter((n) => /crosstalk/.test(n))) {
    for (const l of fs.readFileSync(path.join(xt, f), 'utf8').split('\n')) { try { if (l.trim()) lines.push(JSON.parse(l)); } catch {} }
  }
  const tickets = [...new Set(lines.map((l) => l.ticket).filter(Boolean))];
  const firstDeliveries = lines.filter((l) => l.state === 'delivered' && !l.resumed).length;
  const resumed = lines.filter((l) => l.state === 'delivered' && l.resumed).length;
  const head = q.slice(0, 40);
  const userItems = pesB.items.filter((it) => it.type === 'user' && !it.parentToolUseId);
  const copies = userItems.filter((it) => str(it.text).includes(head)).length;
  const resumes = userItems.filter((it) => it.ask && it.ask.resume).length;
  check('d1', tickets.length === 1 && copies === 1 && firstDeliveries === 1, 'one ticket; the question reached the position once',
    `tickets ${tickets.join(', ') || 'none'} (states ${lines.map((l) => l.state + (l.resumed ? '(resumed)' : '')).join(' > ')}); copies of the question in the position chat ${copies}; first deliveries ${firstDeliveries}, resumes ${resumed} (resume notes in the chat ${resumes})`);
  const asksB = mainItems(ceoB, from).filter((it) => it.type === 'tool' && it.name === 'mcp__team__team_ask');
  const lateTurns = mainItems(ceoB, from).filter((it) => it.type === 'user' && it.origin === 'answer');
  const rejoined = logLines.filter((l) => /\[B\].*re-joining it/.test(l)).length;
  check('d2', ceoText().includes(LEDGER), 'the CEO\'s reply after the restart has the token',
    `${asksB.length} new team_ask call(s) (${asksB.map((a) => `${a.status}: ${oneLine(str(a.result), 80)}`).join(' | ') || 'none'}); re-joined ${rejoined}; late-answer turns ${lateTurns.length}; reply: ${oneLine(ceoText(), 160)}`);
  const posReads = pesB.items.filter((it) => it.type === 'tool' && it.name === 'Read' && /ledger-\d/.test(str(it.input)));
  info(`the position's ledger Reads (both engines): ${posReads.map((t) => `${(str(t.input).match(/ledger-\d/) || [''])[0]}:${t.status}`).join(', ')}`);
}

const hardStop = setTimeout(async () => {
  check('run', false, 'the whole run', `over the ${TOTAL_MS / 60000}-minute cap`);
  await finish(2);
}, TOTAL_MS);

async function finish(code) {
  clearTimeout(hardStop);
  const spentB = cost();
  await cleanup();
  console.log(`cost: $${Math.max(spentB, costA).toFixed(4)} (engine B's session totals; engine A at the restart $${costA.toFixed(4)})`);
  console.log(`team-keep-live: ${pass} passed, ${fail} failed`);
  if (fail && logLines.length) {
    const warn = logLines.filter((l) => /^(warn|error) /.test(l)).slice(-10);
    if (warn.length) { console.log('engine warnings (last 10):'); for (const l of warn) console.log(`  ${oneLine(l, 300)}`); }
  }
  process.exit(code != null ? code : fail ? 1 : 0);
}

main().then(() => finish(), async (e) => {
  check('run', false, `the run (engine ${label})`, e && (e.stack || e.message));
  await finish(1);
});
