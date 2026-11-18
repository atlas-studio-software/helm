'use strict';
// Positions review fixes, the session / wiring side (main/engine/session.js + main/engine/team/wire.js), over the
// fake SDK: the team-items sidecar fence, the chat entry undone when a position session cannot be made, async git
// worktrees, team.get lastActivity, a position's own brief.md writes, keep-through-restart with Positions on (CEO and
// position chats kept, their setup rebuilt on re-attach or refused), and a
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
test('keep on + Positions on: CEO and position chats run in the broker with their team setup recorded; a re-attach rebuilds exactly that setup or refuses', async () => {
  const w = await teamOn(async function* () { yield* F.textTurn('m1', 'ok'); yield F.result(0.01); }, { extra: { detach: true } });
  const ctx = w.engine._internal.ctx;
  const spawned = [], attached = [], ended = [];
  ctx.broker = {
    job: () => null, shutdownAll: async () => {}, keepForRestart: async () => false,
    spawnProcess: (meta, o, hooks) => { const p = { pid: 4242 + spawned.length, key: meta.key, detached: false, exited: false, detach() { this.detached = true; return true; } }; spawned.push({ meta, o, hooks, p }); return p; },
    attachProcess: (entry, hooks, o) => { const p = { pid: entry.pid, key: entry.key, detached: false, exited: false }; attached.push({ entry, hooks, o, p }); return p; },
    end: async (entry, why) => { ended.push({ key: entry.key, why }); return { t: 'ok' }; },
  };
  ctx.keepSafe = () => true;
  const wiring = ctx.team;
  const realOpts = wiring.sessionOptions;
  const hints = [];
  wiring.sessionOptions = (es, base, sdk, hint) => { hints.push({ id: es.s.id, hint }); return realOpts(es, base, sdk, hint); };
  const optsOf = (n) => w.sdk.calls[n].options;
  const lastOpts = () => w.sdk.calls[w.sdk.calls.length - 1].options;
  const turn = async (id, text, n) => { await w.engine.methods['sessions.send']({ id, text }); await until(() => w.sdk.calls.length === n && !w.es(id).turnActive, 5000, `turn ${n}`); };
  const here = { v: 2, sdkVersion: null, claudePath: null };
  const entryFor = (es, extra) => ({ key: `${es.s.id}~k${Math.random().toString(36).slice(2, 6)}`, sid: es.s.id, pid: 6000 + attached.length, busy: false, cliVersion: '2.1.300', claudeSessionId: es.s.claudeSessionId, broker: { v: 2, compatible: true }, ...extra });
  try {
    // an ordinary chat (folder in no company): broker-run, no team server, no team meta, keepable as before
    const plain = await w.engine.methods['sessions.create']({ cwd: mk('plain-') });
    await turn(plain.id, 'hi', 1);
    const po = optsOf(0);
    assert.strictEqual(typeof po.spawnClaudeCodeProcess, 'function', 'goes to the broker');
    assert.ok(!po.mcpServers || !po.mcpServers.team, 'no team server on a kept chat in no company');
    assert.deepStrictEqual(hints[0], { id: plain.id, hint: { keep: true } });
    po.spawnClaudeCodeProcess({});
    assert.strictEqual(spawned[0].meta.meta.team, undefined, 'no team meta');
    assert.strictEqual(spawned[0].meta.meta.guarded, undefined);
    const pes = w.es(plain.id);
    pes.q._helmCli.pid = pes.brokerProc.pid;
    assert.strictEqual(pes.canKeep(), true, 'kept through a restart as before Positions');

    // a CEO chat (folder in the company): its team server AND the broker; the meta says what it was started with
    const ceo = await w.engine.methods['sessions.create']({ cwd: w.company });
    await turn(ceo.id, 'hi', 2);
    const co = optsOf(1);
    assert.ok(co.mcpServers && co.mcpServers.team, 'the CEO keeps its team server');
    assert.strictEqual(typeof co.spawnClaudeCodeProcess, 'function', 'and goes to the broker');
    co.spawnClaudeCodeProcess({});
    assert.deepStrictEqual(spawned[1].meta.meta.team, { kind: 'ceo', company: 'northwind' });
    assert.strictEqual(spawned[1].meta.meta.guarded, undefined, 'a CEO is not guarded (its prod-guard is an ordinary hook)');
    const ces = w.es(ceo.id);
    ces.q._helmCli.pid = ces.brokerProc.pid;
    assert.strictEqual(ces.teamAttached, 'ceo');
    assert.strictEqual(ces.canKeep(), true, 'a CEO chat is kept');

    // a position chat: isolated options, its guard, the broker; meta.guarded makes the broker kill it on an unconfirmed re-attach
    const { sessionId } = await w.engine.methods['team.open']({ company: 'northwind', id: 'ops' });
    await turn(sessionId, 'hi', 3);
    const pso = optsOf(2);
    assert.ok(isPosition(pso), 'position options');
    assert.strictEqual(pso.permissionMode, 'bypassPermissions', 'isolation unchanged: the guard is the gate');
    assert.strictEqual(pso._teamGuarded, true, 'built with the team guard');
    assert.strictEqual(typeof pso.spawnClaudeCodeProcess, 'function', 'a position goes to the broker');
    pso.spawnClaudeCodeProcess({});
    assert.deepStrictEqual(spawned[2].meta.meta.team, { kind: 'position', company: 'northwind', position: 'ops' });
    assert.strictEqual(spawned[2].meta.meta.guarded, true);
    const xes = w.es(sessionId);
    xes.q._helmCli.pid = xes.brokerProc.pid;
    assert.strictEqual(xes.canKeep(), true, 'a position chat is kept');

    // re-attach of an ordinary kept CLI: sessionOptions is not asked, no team server appears in it
    const back = await w.engine.methods['sessions.create']({ cwd: mk('back-') });
    const bes = w.es(back.id);
    let n = hints.length;
    await bes._start(entryFor(bes, {}));
    assert.strictEqual(hints.length, n, 'no sessionOptions on a re-attach without team meta');
    const ro = lastOpts();
    assert.ok(!ro.mcpServers || !ro.mcpServers.team, 'no team server on a re-attached ordinary CLI');
    ro.spawnClaudeCodeProcess({});
    assert.strictEqual(attached.length, 1, 'through the broker\'s attach');
    assert.strictEqual(bes.teamAttached, null);
    await bes.close({ final: false });

    // re-attach of a kept CEO CLI: the same server is rebuilt in this Helm and named in the repeated initialize
    await ces.close({ final: false });
    n = hints.length;
    await ces._start(entryFor(ces, { meta: { team: { kind: 'ceo', company: 'northwind' } }, cwd: w.company }));
    assert.deepStrictEqual(hints[n], { id: ceo.id, hint: { keep: true, reattach: true } });
    const rco = lastOpts();
    assert.ok(rco.mcpServers && rco.mcpServers.team, 'the CEO\'s team server is back');
    assert.notStrictEqual(rco.mcpServers.team, co.mcpServers.team, 'a server of THIS Helm');
    assert.ok(rco.mcpServers.team.instance.tools.some((t) => t.name === 'team_ask'), 'with the CEO tools');
    rco.spawnClaudeCodeProcess({});
    assert.strictEqual(attached.length, 2);
    assert.strictEqual(ces.teamAttached, 'ceo');
    await ces.close({ final: false });

    // re-attach of a kept position CLI: its isolated options and the full hook set (prod-guard, team guard, own-file)
    await xes.close({ final: false });
    await xes._start(entryFor(xes, { meta: { team: { kind: 'position', company: 'northwind', position: 'ops' }, guarded: true }, cwd: pso.cwd }));
    const rpo = lastOpts();
    assert.ok(isPosition(rpo), 'the isolated options again');
    assert.strictEqual(rpo._teamGuarded, true);
    assert.strictEqual(rpo.hooks.PreToolUse.length, pso.hooks.PreToolUse.length, 'every PreToolUse hook');
    assert.strictEqual(rpo.hooks.PostToolUse.length, pso.hooks.PostToolUse.length, 'the own-file observer');
    assert.ok(rpo.mcpServers && rpo.mcpServers.team, 'its team server');
    // the rebuilt team guard enforces: a read outside the position's area is denied
    const outside = path.join(mk('outside-'), 'plan.md');
    fs.writeFileSync(outside, 'plan');
    const guard = rpo.hooks.PreToolUse[1].hooks[0];
    const verdict = await guard({ tool_name: 'Read', tool_input: { file_path: outside }, cwd: rpo.cwd }, 'tu-r', { signal: new AbortController().signal });
    assert.strictEqual(verdict.hookSpecificOutput && verdict.hookSpecificOutput.permissionDecision, 'deny', `guarded after a re-attach: ${JSON.stringify(verdict)}`);
    rpo.spawnClaudeCodeProcess({});
    assert.strictEqual(attached.length, 3);
    await xes.close({ final: false });

    // refusals: never a position without its guard, never a setup other than the one the CLI was started with
    await assert.rejects(xes._start(entryFor(xes, {})), /started without its team server and guard/);
    await assert.rejects(xes._start(entryFor(xes, { meta: { team: { kind: 'position', company: 'northwind', position: 'ops' }, guarded: true }, cwd: mk('elsewhere-') })), /runs in .* but the position now runs in/);
    await assert.rejects(xes._start(entryFor(xes, { meta: { team: { kind: 'position', company: 'northwind', position: 'qa' }, guarded: true }, cwd: pso.cwd })), /started for position qa/);
    await assert.rejects(ces._start(entryFor(ces, { meta: { team: { kind: 'ceo', company: 'other' } }, cwd: w.company })), /started for company other/);
    const loose = await w.engine.methods['sessions.create']({ cwd: mk('loose-') });
    await assert.rejects(w.es(loose.id)._start(entryFor(w.es(loose.id), { meta: { team: { kind: 'ceo', company: 'northwind' } } })), /without the team server/);
    assert.strictEqual(attached.length, 3, 'nothing refused was attached');

    // the engine's path (reattach): a refusal stops that CLI at the broker and shows the restart note with the reason
    const e1 = entryFor(xes, {});
    assert.strictEqual(await xes.reattach(e1, here), false);
    assert.deepStrictEqual(ended.map((x) => x.key), [e1.key], 'the broker ends the CLI');
    assert.match(ended[0].why, /started without its team server and guard/);

    // Positions off now: neither a CEO nor a position CLI can get its setup back, so neither is re-attached
    w.st.enabled = false; w.engine.team.refresh();
    await assert.rejects(ces._start(entryFor(ces, { meta: { team: { kind: 'ceo', company: 'northwind' } }, cwd: w.company })), /without the team server/);
    await assert.rejects(xes._start(entryFor(xes, { meta: { team: { kind: 'position', company: 'northwind', position: 'ops' }, guarded: true }, cwd: pso.cwd })), /Positions is off/);
    assert.strictEqual(attached.length, 3);
    w.st.enabled = true; w.engine.team.refresh();

    // without a broker (keep not possible) a chat in no company still gets the deferred team_propose
    ctx.broker = null;
    const nb = await w.engine.methods['sessions.create']({ cwd: mk('nb-') });
    const before = w.sdk.calls.length;
    await turn(nb.id, 'hi', before + 1);
    const lo = lastOpts();
    assert.ok(lo.mcpServers && lo.mcpServers.team, 'team server (team_propose) when the chat is not kept');
    assert.strictEqual(w.es(nb.id).teamAttached, 'none');
  } finally { ctx.broker = null; await w.engine.shutdown(); }
});

// ---------------------------------------------------------------- 3b: a restart with a CEO mid-ask and its position mid-answer
// The whole engine path minus the real broker (broker.test.js covers that): Helm A detaches both CLIs; Helm B's
// re-attach pass rebuilds their team setup before Positions runs, recovery attaches to the answer turn that
// survived, the CEO's re-delivered team_ask takes up its own ticket, and the answer comes back in that same call.
test('restart with keep on: a CEO mid-team_ask and its position mid-answer are kept; the ask is answered in the same call', async () => {
  const root = path.join(mk('root-'), 'helm-team');
  const company = mk('co-');
  const ud = mk('ud-');
  const st = { enabled: true };
  const team = { settings: () => st, root: () => root, rootProblem: () => null };
  const base = { userDataDir: ud, emit: () => {}, log: () => {}, claudePath: null, projectsDir: mk('proj-'), statuslineDir: mk('sl-'),
    etaDir: false, external: false, tempDir: path.join(os.tmpdir(), 'not-the-test-dirs'), getIdleCloseMs: () => 0, team, detach: true };
  const ask = (opts, extra) => {
    const t = opts.mcpServers.team.instance.tools.find((x) => x.name === 'team_ask');
    return t.handler({ to: 'ops', question: 'WHAT-SHIPS on Monday?' }, { signal: new AbortController().signal, _meta: { 'claudecode/toolUseId': 'toolu_keep1' }, ...extra }).then((r) => JSON.parse(r.content[0].text));
  };
  // Helm A: the CEO asks, the position starts answering; both are still at it when Helm restarts
  const spawnedA = [];
  const brokerA = {
    job: () => null, list: async () => [], takeStops: () => [], drainOld: async () => [], shutdownAll: async () => [], end: async () => null,
    keepForRestart: async (procs) => new Set(procs),
    spawnProcess: (m, o, hooks) => { const p = { pid: 7100 + spawnedA.length, key: m.key, detached: false, exited: false, detach() { this.detached = true; return true; } }; spawnedA.push({ m, p }); return p; },
  };
  let ceoOptsA = null, posOptsA = null;
  const sdkA = withMcp(createFakeSdk(async function* (um, api) {
    if (isPosition(api.options)) { posOptsA = api.options; await new Promise(() => {}); return; } // answering when Helm restarts
    ceoOptsA = api.options;
    if (/ASK/.test(textOf(um))) await ask(api.options); // in its team_ask when Helm restarts
    yield* F.textTurn('c1', 'ceo'); yield F.result(0.01);
  }));
  const A = createEngine({ ...base, sdk: sdkA, broker: brokerA });
  const esA = (id) => A._internal.sessions.get(id);
  let ceoId, posId;
  try {
    await until(() => A.team.status().running, 3000, 'team start');
    const imp = await A.methods['team.proposals.import']({ json: fixture(company) });
    const byRef = (r) => imp.imported.find((x) => x.ref === r).id;
    assert.strictEqual((await A.methods['team.decide']({ proposal: byRef('company'), decision: 'approve' })).ok, true);
    assert.strictEqual((await A.methods['team.decide']({ proposal: byRef('ops'), decision: 'approve' })).ok, true);
    A._internal.ctx.keepSafe = () => true;
    ceoId = (await A.methods['sessions.create']({ cwd: company })).id;
    await A.methods['sessions.send']({ id: ceoId, text: 'ASK ops' });
    await until(() => [...A._internal.sessions.values()].some((es) => es.s.position && es.turnActive) && posOptsA, 5000, 'the position answering');
    posId = [...A._internal.sessions.values()].find((es) => es.s.position).s.id;
    for (const [id, o] of [[ceoId, ceoOptsA], [posId, posOptsA]]) { o.spawnClaudeCodeProcess({}); esA(id).q._helmCli.pid = esA(id).brokerProc.pid; assert.strictEqual(esA(id).canKeep(), true); }
    assert.strictEqual(A.busy().filter((b) => b.keep).length, 2, 'both keepable: an update restart does not wait for them');
  } finally { await A.shutdown({ cause: 'restart' }); }
  const savedA = JSON.parse(fs.readFileSync(path.join(ud, 'sessions.json'), 'utf8')).sessions;
  const keptA = (id) => savedA.find((x) => x.id === id).kept;
  assert.ok(keptA(ceoId) && keptA(posId), 'both detached and kept');
  const metaA = (id) => spawnedA.find((x) => x.m.sid === id).m.meta;
  assert.deepStrictEqual(metaA(posId).team, { kind: 'position', company: 'northwind', position: 'ops' });

  // Helm B: the broker lists both CLIs; nothing new is spawned for them
  const attached = [];
  const ch = new Map(); // sessionId -> push(message) into its re-attached query
  const entry = (id, cwd) => ({ key: keptA(id).key, sid: id, pid: keptA(id).pid, cwd, meta: metaA(id), busy: true, attached: false, cliVersion: '2.1.300',
    claudeSessionId: savedA.find((x) => x.id === id).claudeSessionId, startedAt: 1, broker: { v: 2, compatible: true, current: true } });
  const listed = [entry(ceoId, company), entry(posId, posOptsA.cwd)];
  const brokerB = {
    job: () => null, list: async () => listed, takeStops: () => [], drainOld: async () => [], shutdownAll: async () => [], end: async () => null,
    keepForRestart: async () => new Set(),
    attachProcess: (e, hooks) => { const p = { pid: e.pid, key: e.key, detached: false, exited: false }; attached.push(e.sid); setImmediate(() => hooks.onReinit({ ok: true, subtype: 'success', hooksApplied: true, pending: 0, error: null, ms: 3 })); return p; },
  };
  const sdkB = withMcp(createFakeSdk(async function* () { yield* F.textTurn('b1', 'ok'); yield F.result(0.01); }));
  const q0 = sdkB.query;
  const optsB = new Map();
  sdkB.query = (a) => {
    const q = q0(a);
    if (a.options.spawnClaudeCodeProcess) {
      a.options.spawnClaudeCodeProcess({});
      const sid = attached[attached.length - 1];
      optsB.set(sid, a.options);
      // the kept CLI's stdout: whatever the test pushes
      const queue = [], waits = [];
      ch.set(sid, (m) => { const w = waits.shift(); if (w) w({ value: m, done: false }); else queue.push(m); });
      q[Symbol.asyncIterator] = () => ({ next: () => (queue.length ? Promise.resolve({ value: queue.shift(), done: false }) : new Promise((r) => waits.push(r))), return: async () => ({ done: true }) });
    }
    return q;
  };
  const B = createEngine({ ...base, sdk: sdkB, broker: brokerB });
  const esB = (id) => B._internal.sessions.get(id);
  try {
    await until(() => B.team.status().running, 5000, 'team start after the re-attach pass');
    assert.deepStrictEqual(attached.sort(), [ceoId, posId].sort(), 'both re-attached');
    await until(() => esB(ceoId).items.some((i) => i.subtype === 'kept') && esB(posId).items.some((i) => i.subtype === 'kept'), 3000, 'kept lines');
    // the setup each CLI was started with, rebuilt in this Helm
    assert.ok(optsB.get(ceoId).mcpServers.team, 'the CEO\'s team server');
    assert.ok(isPosition(optsB.get(posId)) && optsB.get(posId)._teamGuarded, 'the position\'s isolated options with its guard');
    const qCeo = esB(ceoId).q;
    await sleep(100);
    assert.strictEqual(esB(ceoId).q, qCeo, 'Positions starting did not recycle the kept CEO chat');
    const rt = B._internal.ctx.team._live().runtime;
    const tickets = rt._internals.tickets;
    const posSends = () => esB(posId).items.filter((i) => i.type === 'user').length;
    const sendsBefore = posSends();
    await until(() => (esB(posId).turnWaiters || []).length === 1, 3000, 'recovery attached to the answer turn that survived');
    // the broker re-delivers the CEO's unanswered team_ask: the same tool call takes up its ticket
    const n = tickets.size;
    const call = ask(optsB.get(ceoId));
    let done = null;
    call.then((v) => { done = v; });
    await sleep(50);
    assert.strictEqual(done, null, 'waiting in the same call');
    assert.strictEqual(tickets.size, n, 'no second ticket');
    // the position's kept CLI finishes its answer
    const push = ch.get(posId);
    for (const m of F.textTurn('p9', 'answer-42: Mondays')) push(m);
    push(F.result(0.02));
    await until(() => done, 3000, 'the answer in the same call');
    assert.strictEqual(done.status, 'answered', JSON.stringify(done));
    assert.match(done.answer, /answer-42: Mondays/);
    assert.strictEqual(posSends(), sendsBefore, 'the question was never delivered a second time');
    for (const m of F.textTurn('c9', 'ceo done')) ch.get(ceoId)(m);
    ch.get(ceoId)(F.result(0.03));
    await sleep(300);
    assert.ok(!esB(ceoId).items.some((i) => i.type === 'user' && /helm-answer/.test(i.text || '')), 'no late-answer turn in the CEO chat');
  } finally { await B.shutdown({ cause: 'quit' }); }
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
