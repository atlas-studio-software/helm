'use strict';
// Positions review fixes, the session / wiring side (main/engine/session.js + main/engine/team/wire.js), over the
// fake SDK: the team-items sidecar fence, the chat entry undone when a position session cannot be made, async git
// worktrees, team.get lastActivity, a position's own brief.md writes, keep-through-restart with Positions on, and a
// failed CLI start keeping the seed and the Helm notes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../../main/engine');
const { createFakeSdk, F } = require('./fake-sdk');

const tmp = [];
const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `helm-tfs-${p}`)); tmp.push(d); return d; };
test.after(() => { for (const d of tmp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000, what = 'condition') => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(15); }
};
function withMcp(sdk) {
  sdk.tool = (name, description, shape, handler) => ({ name, description, shape, handler });
  sdk.createSdkMcpServer = (cfg) => ({ type: 'sdk', name: cfg.name, instance: cfg });
  return sdk;
}
const textOf = (um) => { const c = um.message.content; return typeof c === 'string' ? c : c.map((b) => b.text || '').join('\n'); };
const isPosition = (o) => Array.isArray(o.settingSources) && o.settingSources.length === 0;

function fixture(companyFolder) {
  return {
    kind: 'helm-team-proposals', status: 'pending', company: 'northwind', draftedAt: '2026-01-01T00:00:00Z', draftedBy: 'test', note: 'test fixture',
    proposals: [
      { ref: 'company', status: 'pending', team_propose: { action: 'company', id: 'northwind', name: 'Northwind Goods', folders: [companyFolder], why: 'test' } },
      { ref: 'ops', status: 'pending', team_propose: {
        action: 'create', id: 'ops', parent: null, name: 'Operations Desk', remit: 'Answers questions about orders.', scope: { kind: 'company' },
        brief: '# Operations Desk\n\nAnswers questions about orders.\n',
        powers: { read: ['$workspace'], write: ['$workspace'], tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'], bash: 'on', agents: false, worktree: false },
        duties: [], model: null, effort: 'low', seed: { notes: 'Orders ship on Mondays.', files: [] }, why: 'test' },
      notebook_md: '# Operations Desk · notebook\n## Decisions\n- Use the weekly sheet.\n## Facts\n- Orders ship on Mondays.\n## Open items\n- [ ] Check the returns policy.\n## Log\n' },
    ],
  };
}

function makeEngine({ sdk, team, extra = {} }) {
  const ud = mk('ud-');
  const emitted = [];
  const engine = createEngine({
    userDataDir: ud, emit: (e, d) => emitted.push([e, d]), log: () => {}, sdk, claudePath: null, projectsDir: mk('proj-'), statuslineDir: mk('sl-'),
    etaDir: false, external: false, broker: false, tempDir: path.join(os.tmpdir(), 'not-the-test-dirs'), getIdleCloseMs: () => 0, team, ...extra,
  });
  return { engine, ud, emitted };
}

// Positions on with the fixture's company (folder `company`) and its one position `ops` approved.
async function teamOn(turn, { extra } = {}) {
  const root = path.join(mk('root-'), 'helm-team');
  const company = mk('co-');
  const sdk = withMcp(createFakeSdk(turn));
  const st = { enabled: true };
  const { engine, ud, emitted } = makeEngine({ sdk, team: { settings: () => st, root: () => root, rootProblem: () => null }, extra });
  await until(() => engine.team.status().running, 3000, 'team start');
  const imp = await engine.methods['team.proposals.import']({ json: fixture(company) });
  const byRef = (r) => imp.imported.find((x) => x.ref === r).id;
  assert.strictEqual((await engine.methods['team.decide']({ proposal: byRef('company'), decision: 'approve' })).ok, true);
  assert.strictEqual((await engine.methods['team.decide']({ proposal: byRef('ops'), decision: 'approve' })).ok, true);
  const ws = path.join(root, 'northwind', 'positions', 'ops');
  return { engine, ud, emitted, sdk, root, company, ws, st, es: (id) => engine._internal.sessions.get(id) };
}

// ---------------------------------------------------------------- 10a: the team-items sidecar fence
test('team-items sidecar: a torn last line is fenced off, the next record stays whole', async () => {
  const sdk = createFakeSdk(async function* () { yield* F.textTurn('m1', 'hi'); yield F.result(0.01); });
  const { engine, ud } = makeEngine({ sdk, team: { settings: () => ({ enabled: false }) } });
  try {
    const { id } = await engine.methods['sessions.create']({ cwd: mk('plain-') });
    const es = engine._internal.sessions.get(id);
    const file = path.join(ud, 'team-items', `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"key":"a","after":null,"item":{"kind":"notice","text":"whole"}}\n{"key":"b","after":null,"ite'); // crash mid-write
    es.addCard({ kind: 'notice', key: 'c', text: 'after the crash' });
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    assert.strictEqual(lines[lines.length - 1], '', 'ends with a newline');
    const last = JSON.parse(lines[lines.length - 2]);
    assert.strictEqual(last.key, 'c');
    assert.strictEqual(last.item.text, 'after the crash');
    assert.strictEqual(lines[1], '{"key":"b","after":null,"ite', 'the torn line stays on its own line');
    // a clean file gets no blank line
    es.addCard({ kind: 'notice', key: 'd', text: 'next' });
    const again = fs.readFileSync(file, 'utf8').split('\n');
    assert.strictEqual(JSON.parse(again[again.length - 2]).key, 'd');
    assert.ok(!again.slice(0, -1).includes(''), 'no empty line in between');
  } finally { await engine.shutdown(); }
});

// ---------------------------------------------------------------- 10b: open() undoes its chat entry on a failed create
test('open(): when the position session cannot be made, its chats.json entry goes again', async () => {
  const { createTeamWiring } = require('../../main/engine/team/wire');
  const root = path.join(mk('root-'), 'helm-team');
  const company = mk('co-');
  let fail = true;
  const sessions = new Map();
  const made = [];
  const team = createTeamWiring({
    settings: () => ({ enabled: true }), root: () => root, rootProblem: () => null, userDataDir: mk('ud-'), sessions,
    createSession: async (p) => {
      if (fail) throw Object.assign(new Error('Folder not found: nowhere'), { code: 'bad_request' });
      const es = { s: { id: `s${made.length + 1}`, cwd: p.cwd, position: p.position }, removed: false };
      made.push(p); sessions.set(es.s.id, es);
      return es;
    },
  });
  try {
    assert.strictEqual(team.start(), true);
    const imp = await team.methods['team.proposals.import']({ json: fixture(company) });
    for (const r of ['company', 'ops']) assert.strictEqual((await team.methods['team.decide']({ proposal: imp.imported.find((x) => x.ref === r).id, decision: 'approve' })).ok, true);
    const chatsFile = path.join(root, 'northwind', 'positions', 'ops', 'chats.json');
    const chats = () => (fs.existsSync(chatsFile) ? JSON.parse(fs.readFileSync(chatsFile, 'utf8')) : []);
    await assert.rejects(team._open('northwind', 'ops'), /Folder not found/);
    assert.deepStrictEqual(chats(), [], 'no orphan chat entry');
    fail = false;
    const es = await team._open('northwind', 'ops');
    assert.strictEqual(made[0].position.chat, 1, 'the next open is chat 1 again');
    assert.deepStrictEqual(chats().map((c) => [c.n, c.helmSessionId]), [[1, es.s.id]]);
  } finally { team.stop({ recycle: false }); }
});

// ---------------------------------------------------------------- 8: git worktrees without blocking the main process
test('worktree position: git runs async (no execFileSync / spawnSync in wire.js), the worktree is made once and reused', async (t) => {
  const { execFileSync } = require('child_process');
  try { execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true }); } catch { t.skip('no git'); return; }
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'main', 'engine', 'team', 'wire.js'), 'utf8');
  assert.ok(!/execFileSync|spawnSync|execSync/.test(src), 'no blocking child_process call in wire.js');

  const repo = mk('repo-');
  const g = (...a) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, stdio: 'pipe', windowsHide: true });
  g('init', '-q'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); g('add', '.'); g('commit', '-q', '-m', 'one');
  const root = path.join(mk('root-'), 'helm-team');
  const seen = [];
  const sdk = withMcp(createFakeSdk(async function* (um, api) { seen.push(api.options); yield* F.textTurn(`m${seen.length}`, 'ok'); yield F.result(0.01); }));
  const { engine } = makeEngine({ sdk, team: { settings: () => ({ enabled: true }), root: () => root, rootProblem: () => null } });
  try {
    await until(() => engine.team.status().running, 3000, 'team start');
    const fx = fixture(repo.split(path.sep).join('/'));
    fx.proposals[1].team_propose = { ...fx.proposals[1].team_propose, id: 'qa', name: 'App QA', scope: { kind: 'product', folder: repo.split(path.sep).join('/') },
      powers: { read: ['$workspace', '$scope'], write: ['$workspace', '$scope'], tools: ['Read', 'Write', 'Edit'], bash: 'on', agents: false, worktree: true } };
    const imp = await engine.methods['team.proposals.import']({ json: fx });
    for (const r of ['company', 'ops']) { const d = await engine.methods['team.decide']({ proposal: imp.imported.find((x) => x.ref === r).id, decision: 'approve' }); assert.strictEqual(d.ok, true, d.error); }
    const { sessionId } = await engine.methods['team.open']({ company: 'northwind', id: 'qa' });
    // the event loop keeps turning while git runs
    let ticks = 0;
    const iv = setInterval(() => { ticks++; }, 1);
    await engine.methods['sessions.send']({ id: sessionId, text: 'hello' });
    await until(() => seen.length === 1, 15000, 'position turn');
    clearInterval(iv);
    const wt = path.join(root, 'northwind', 'positions', 'qa', 'worktree');
    assert.ok(fs.existsSync(path.join(wt, '.git')), 'worktree made');
    assert.strictEqual(fs.realpathSync(seen[0].cwd), fs.realpathSync(wt), 'the position runs in its worktree');
    assert.match(execFileSync('git', ['-C', repo, 'branch', '--list', 'team/northwind/qa'], { encoding: 'utf8', windowsHide: true }), /team\/northwind\/qa/);
    assert.ok(ticks > 0, 'timers ran while the worktree was made');
    // a second CLI start reuses it (no second `worktree add`, which would fail on the existing path)
    const es = engine._internal.sessions.get(sessionId);
    await es.close({ final: false });
    await engine.methods['sessions.send']({ id: sessionId, text: 'again' });
    await until(() => seen.length === 2, 15000, 'second start');
    assert.strictEqual(fs.realpathSync(seen[1].cwd), fs.realpathSync(wt));
  } finally { await engine.shutdown(); }
});

test('worktree position whose scope is not a git repo: the start fails with a clear worktree_missing reason', async () => {
  const notRepo = mk('norepo-');
  const root = path.join(mk('root-'), 'helm-team');
  const sdk = withMcp(createFakeSdk(async function* () { yield* F.textTurn('m1', 'ok'); yield F.result(0.01); }));
  const { engine } = makeEngine({ sdk, team: { settings: () => ({ enabled: true }), root: () => root, rootProblem: () => null } });
  try {
    await until(() => engine.team.status().running, 3000, 'team start');
    const fx = fixture(notRepo.split(path.sep).join('/'));
    fx.proposals[1].team_propose = { ...fx.proposals[1].team_propose, scope: { kind: 'product', folder: notRepo.split(path.sep).join('/') },
      powers: { read: ['$workspace', '$scope'], write: ['$workspace', '$scope'], tools: ['Read'], bash: 'on', agents: false, worktree: true } };
    const imp = await engine.methods['team.proposals.import']({ json: fx });
    for (const r of ['company', 'ops']) assert.strictEqual((await engine.methods['team.decide']({ proposal: imp.imported.find((x) => x.ref === r).id, decision: 'approve' })).ok, true);
    const { sessionId } = await engine.methods['team.open']({ company: 'northwind', id: 'ops' });
    const es = engine._internal.sessions.get(sessionId);
    await assert.rejects(es.start(), (e) => e.code === 'worktree_missing' && /git worktree could not be made/.test(e.message));
  } finally { await engine.shutdown(); }
});

// ---------------------------------------------------------------- 9: team.get lastActivity
test('team.get: lastActivity is omitted before any chat, then the position chat\'s last use (ms epoch)', async () => {
  const w = await teamOn(async function* () { yield* F.textTurn('m1', 'ok'); yield F.result(0.01); });
  try {
    const row = async () => (await w.engine.methods['team.get']({ company: 'northwind' })).tree.find((r) => r.id === 'ops');
    assert.ok(!('lastActivity' in (await row())), 'never chatted: no lastActivity');
    const t0 = Date.now();
    const { sessionId } = await w.engine.methods['team.open']({ company: 'northwind', id: 'ops' });
    await w.engine.methods['sessions.send']({ id: sessionId, text: 'hello' });
    await until(() => w.es(sessionId).s.status === 'idle' && !w.es(sessionId).turnActive, 5000, 'turn end');
    const r = await row();
    assert.strictEqual(typeof r.lastActivity, 'number');
    assert.ok(r.lastActivity >= t0 && r.lastActivity <= Date.now(), `${r.lastActivity} in range`);
    assert.strictEqual(r.lastActivity, w.es(sessionId).s.updatedAt, 'the session\'s last use');
  } finally { await w.engine.shutdown(); }
});

// ---------------------------------------------------------------- 1b: the position's own brief.md / notebook.md writes
test('own writes: a shell command naming brief.md, or a file tool writing notebook.md, is never "the owner changed it"; an outside edit still is', async () => {
  let posOpts = null;
  const w = await teamOn(async function* (um, api) { if (isPosition(api.options)) posOpts = api.options; yield* F.textTurn('m1', 'ok'); yield F.result(0.01); });
  try {
    const { sessionId } = await w.engine.methods['team.open']({ company: 'northwind', id: 'ops' });
    await w.engine.methods['sessions.send']({ id: sessionId, text: 'hello' });
    await until(() => posOpts && w.es(sessionId).s.position.seeded && !w.es(sessionId).turnActive, 5000, 'seeded turn');
    const es = w.es(sessionId);
    const notes = () => es.helmNotes.length;
    const pre = posOpts.hooks.PreToolUse[posOpts.hooks.PreToolUse.length - 1].hooks[0];
    const post = posOpts.hooks.PostToolUse[posOpts.hooks.PostToolUse.length - 1].hooks[0];
    const sig = { signal: new AbortController().signal };
    const brief = path.join(w.ws, 'brief.md'), notebook = path.join(w.ws, 'notebook.md');
    await sleep(300); // the store's own writes settle

    // controls: an edit from outside raises the note (brief, then notebook)
    fs.appendFileSync(brief, '\nOwner line.\n');
    await until(() => notes() === 1, 4000, 'brief note');
    assert.match(es.helmNotes[0], /brief/i);
    fs.appendFileSync(notebook, '\n- owner fact\n');
    await until(() => notes() === 2, 4000, 'notebook note');

    // a Bash command naming brief.md: noted before it runs, so the write it makes stays quiet
    const bash = { tool_name: 'Bash', tool_input: { command: 'printf "x" >> ./brief.md' }, cwd: posOpts.cwd };
    assert.deepStrictEqual(await pre(bash, 'tb1', sig), {}, 'observes only');
    fs.appendFileSync(brief, 'x');
    assert.deepStrictEqual(await post({ ...bash, tool_response: {} }, 'tb1', sig), {});
    // a Write on its notebook.md (after it ran)
    fs.appendFileSync(notebook, '- own fact\n');
    assert.deepStrictEqual(await post({ tool_name: 'Write', tool_input: { file_path: notebook, content: '' }, cwd: posOpts.cwd, tool_response: {} }, 'tw1', sig), {});
    await sleep(900);
    assert.strictEqual(notes(), 2, `no note for its own writes: ${es.helmNotes.slice(2).join(' | ')}`);
  } finally { await w.engine.shutdown(); }
});

// ---------------------------------------------------------------- 3: keep sessions running through a restart, Positions on
test('keep on + Positions on: a chat in no company runs in the broker without the team server; a CEO chat keeps its server and is not kept; a re-attach never gets a team server', async () => {
  const w = await teamOn(async function* () { yield* F.textTurn('m1', 'ok'); yield F.result(0.01); }, { extra: { detach: true } });
  const ctx = w.engine._internal.ctx;
  const spawned = [], attached = [];
  ctx.broker = {
    job: () => null, shutdownAll: async () => {}, keepForRestart: async () => false,
    spawnProcess: (meta, o, hooks) => { const p = { pid: 4242 + spawned.length, key: meta.key, detached: false, exited: false, detach() { this.detached = true; return true; } }; spawned.push({ meta, o, hooks, p }); return p; },
    attachProcess: (entry, hooks, o) => { const p = { pid: entry.pid, key: entry.key, detached: false, exited: false }; attached.push({ entry, hooks, o, p }); return p; },
  };
  const wiring = ctx.team;
  const realOpts = wiring.sessionOptions;
  const hints = [];
  wiring.sessionOptions = (es, base, sdk, hint) => { hints.push({ id: es.s.id, hint }); return realOpts(es, base, sdk, hint); };
  const optsOf = (n) => w.sdk.calls[n].options;
  try {
    // an ordinary chat (folder in no company): broker-run, no team server, keepable
    const plain = await w.engine.methods['sessions.create']({ cwd: mk('plain-') });
    await w.engine.methods['sessions.send']({ id: plain.id, text: 'hi' });
    await until(() => w.sdk.calls.length === 1 && !w.es(plain.id).turnActive, 5000, 'plain turn');
    const po = optsOf(0);
    assert.strictEqual(typeof po.spawnClaudeCodeProcess, 'function', 'goes to the broker');
    assert.ok(!po.mcpServers || !po.mcpServers.team, 'no team server on a kept chat');
    assert.deepStrictEqual(hints[0], { id: plain.id, hint: { keep: true } });
    const pes = w.es(plain.id);
    assert.strictEqual(pes.teamAttached, null);
    po.spawnClaudeCodeProcess({});
    pes.q._helmCli.pid = pes.brokerProc.pid;
    ctx.keepSafe = () => true;
    assert.strictEqual(pes.canKeep(), true, 'kept through a restart as before Positions');

    // a CEO chat (folder in the company): the team server, never in the broker, not kept
    const ceo = await w.engine.methods['sessions.create']({ cwd: w.company });
    await w.engine.methods['sessions.send']({ id: ceo.id, text: 'hi' });
    await until(() => w.sdk.calls.length === 2 && !w.es(ceo.id).turnActive, 5000, 'ceo turn');
    const co = optsOf(1);
    assert.ok(co.mcpServers && co.mcpServers.team, 'the CEO keeps its team server');
    assert.strictEqual(co.spawnClaudeCodeProcess, undefined, 'a CLI with the in-process server never goes to the broker');
    assert.strictEqual(w.es(ceo.id).teamAttached, 'ceo');
    assert.strictEqual(w.es(ceo.id).canKeep(), false);
    assert.strictEqual(spawned.length, 1);

    // a re-attach: sessionOptions is not asked, so no team server is injected into the kept CLI
    const back = await w.engine.methods['sessions.create']({ cwd: mk('back-') });
    const bes = w.es(back.id);
    const n = hints.length;
    await bes._start({ key: `${back.id}~k`, sid: back.id, pid: 5151, busy: false });
    const ro = optsOf(2);
    assert.strictEqual(hints.length, n, 'no sessionOptions on a re-attach');
    assert.ok(!ro.mcpServers || !ro.mcpServers.team, 'no team server on a re-attached CLI');
    ro.spawnClaudeCodeProcess({});
    assert.strictEqual(attached.length, 1, 'through the broker\'s attach');
    assert.strictEqual(bes.teamAttached, null);
    await bes.close({ final: false });

    // a position chat is never re-attached (it would run without its guard)
    const { sessionId } = await w.engine.methods['team.open']({ company: 'northwind', id: 'ops' });
    await assert.rejects(w.es(sessionId)._start({ key: `${sessionId}~k`, sid: sessionId, pid: 6161, busy: false }), /never kept through a restart/);

    // without a broker (keep not possible) a chat in no company still gets the deferred team_propose
    ctx.broker = null;
    const loose = await w.engine.methods['sessions.create']({ cwd: mk('loose-') });
    await w.engine.methods['sessions.send']({ id: loose.id, text: 'hi' });
    await until(() => w.sdk.calls.length === 4 && !w.es(loose.id).turnActive, 5000, 'loose turn');
    const lo = optsOf(3);
    assert.ok(lo.mcpServers && lo.mcpServers.team, 'team server (team_propose) when the chat is not kept');
    assert.strictEqual(w.es(loose.id).teamAttached, 'none');
  } finally { ctx.broker = null; await w.engine.shutdown(); }
});

// ---------------------------------------------------------------- 4: a failed CLI start keeps the seed and the Helm notes
test('a failed CLI start keeps the position seed and the Helm notes for the next message', async () => {
  const got = [];
  const w = await teamOn(async function* (um) { got.push(textOf(um)); yield* F.textTurn(`m${got.length}`, 'ok'); yield F.result(0.01); });
  const q0 = w.sdk.query;
  let failNext = 1;
  w.sdk.query = (a) => { if (failNext > 0) { failNext--; throw new Error('spawn claude.exe EPERM'); } return q0(a); };
  try {
    const { sessionId } = await w.engine.methods['team.open']({ company: 'northwind', id: 'ops' });
    const es = w.es(sessionId);
    es.addHelmNote('NOTE-A: the owner approved the returns proposal.');
    es.stopNote = { cause: 'restart', cut: [] };
    await w.engine.methods['sessions.send']({ id: sessionId, text: 'first try' });
    await until(() => es.s.status === 'error', 5000, 'start failure');
    assert.ok(!es.s.position.seeded, 'not seeded: the seed never reached Claude');
    assert.deepStrictEqual(es.helmNotes, ['NOTE-A: the owner approved the returns proposal.'], 'the note is back');
    assert.ok(es.stopNote && es.stopNote.cause === 'restart', 'the stop note is back');
    es.addHelmNote('NOTE-B: added after the failure.');
    await w.engine.methods['sessions.send']({ id: sessionId, text: 'second try' });
    await until(() => got.length === 1 && !es.turnActive, 5000, 'second try runs');
    assert.match(got[0], /<position-seed>[\s\S]*weekly sheet[\s\S]*<\/position-seed>/, 'the seed rides on the next message');
    assert.match(got[0], /NOTE-A[\s\S]*NOTE-B/, 'both notes, the older first');
    assert.match(got[0], /second try/);
    assert.strictEqual(es.s.position.seeded, true);
    assert.deepStrictEqual(es.helmNotes, []);
    assert.strictEqual(es.stopNote, null);
  } finally { w.sdk.query = q0; await w.engine.shutdown(); }
});

test('a failed CLI start in an ordinary chat keeps its Helm notes too', async () => {
  const got = [];
  const sdk = createFakeSdk(async function* (um) { got.push(textOf(um)); yield* F.textTurn('m1', 'ok'); yield F.result(0.01); });
  const q0 = sdk.query;
  let failNext = 1;
  sdk.query = (a) => { if (failNext > 0) { failNext--; throw new Error('spawn failed'); } return q0(a); };
  const { engine } = makeEngine({ sdk, team: { settings: () => ({ enabled: false }) } });
  try {
    const { id } = await engine.methods['sessions.create']({ cwd: mk('plain-') });
    const es = engine._internal.sessions.get(id);
    es.addHelmNote('NOTE-C');
    await engine.methods['sessions.send']({ id, text: 'one' });
    await until(() => es.s.status === 'error', 5000, 'start failure');
    assert.deepStrictEqual(es.helmNotes, ['NOTE-C']);
    await engine.methods['sessions.send']({ id, text: 'two' });
    await until(() => got.length === 1, 5000, 'second try');
    assert.match(got[0], /NOTE-C/);
  } finally { await engine.shutdown(); }
});

// ---------------------------------------------------------------- an ended (rolled-over) position chat refuses a send
test('send() to an ended position chat is refused before the message is stored or the chat un-archived', async () => {
  let turns = 0;
  const sdk = createFakeSdk(async function* () { turns++; yield* F.textTurn('m1', 'hi'); yield F.result(0.01); });
  const { engine } = makeEngine({ sdk, team: { settings: () => ({ enabled: false }) } });
  try {
    const { id } = await engine.methods['sessions.create']({ cwd: mk('ended-') });
    const es = engine._internal.sessions.get(id);
    es.s.position = { company: 'northwind', id: 'ops', name: 'Operations Desk', ended: true };
    es.s.archived = true;
    const before = es.items.length;
    await assert.rejects(engine.methods['sessions.send']({ id, text: 'still there?' }), (e) => e.code === 'refused' && /has ended/.test(e.message));
    assert.strictEqual(es.items.length, before, 'nothing stored');
    assert.strictEqual(es.s.archived, true, 'still archived');
    assert.strictEqual(turns, 0, 'no CLI turn');
  } finally { await engine.shutdown(); }
});
