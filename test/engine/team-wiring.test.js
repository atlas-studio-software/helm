'use strict';
// Positions T9: the engine wiring (main/engine/team/wire.js + session.js + index.js) with the fake SDK. The team MCP
// server's handlers are called the way the CLI would (through options.mcpServers.team), and the guard hook the way
// the CLI's PreToolUse runs it, so this drives the real store, runtime, proposals and access modules end to end.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../../main/engine');
const { createFakeSdk, F } = require('./fake-sdk');

const tmp = [];
const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `helm-tw-${p}`)); tmp.push(d); return d; };
test.after(() => { for (const d of tmp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const until = async (fn, ms = 5000, what = 'condition') => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 15)); }
};

// the SDK's in-process MCP pieces, as plain objects the fake CLI can call
function withMcp(sdk) {
  sdk.tool = (name, description, shape, handler) => ({ name, description, shape, handler });
  sdk.createSdkMcpServer = (cfg) => ({ type: 'sdk', name: cfg.name, instance: cfg });
  return sdk;
}
const toolOf = (opts, name) => {
  const s = opts.mcpServers && opts.mcpServers.team;
  const t = s && s.instance.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no team tool ${name}`);
  return async (args) => JSON.parse((await t.handler(args, { signal: new AbortController().signal })).content[0].text);
};
const textOf = (um) => { const c = um.message.content; return typeof c === 'string' ? c : c.map((b) => b.text || '').join('\n'); };
const isPosition = (o) => Array.isArray(o.settingSources) && o.settingSources.length === 0;

function fixture(companyFolder) {
  return {
    kind: 'helm-team-proposals', status: 'pending', company: 'northwind', draftedAt: '2026-01-01T00:00:00Z', draftedBy: 'test', note: 'test fixture',
    proposals: [
      { ref: 'company', status: 'pending', team_propose: { action: 'company', id: 'northwind', name: 'Northwind Goods', folders: [companyFolder], why: 'test' } },
      { ref: 'ops', status: 'pending', team_propose: {
        action: 'create', id: 'ops', parent: null, department: 'Operations', name: 'Operations Desk', remit: 'Answers questions about orders.', scope: { kind: 'company' },
        brief: '# Operations Desk\n\nAnswers questions about orders.\n',
        powers: { read: ['$workspace'], write: ['$workspace'], tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'], bash: 'off', agents: false, worktree: false },
        duties: [], model: null, effort: 'low', seed: { notes: 'Orders ship on Mondays.', files: [] }, why: 'test' },
      notebook_md: '# Operations Desk · notebook\n## Decisions\n- Use the weekly sheet.\n## Facts\n- Orders ship on Mondays.\n## Open items\n- [ ] Check the returns policy.\n## Log\n' },
    ],
  };
}

function makeEngine({ sdk, team }) {
  const ud = mk('ud-');
  const emitted = [];
  const engine = createEngine({
    userDataDir: ud, emit: (e, d) => emitted.push([e, d]), log: () => {}, sdk, claudePath: null, projectsDir: mk('proj-'), statuslineDir: mk('sl-'),
    etaDir: false, external: false, broker: false, tempDir: path.join(os.tmpdir(), 'not-the-test-dirs'), getIdleCloseMs: () => 0, team,
  });
  return { engine, ud, emitted };
}

test('Positions off (default): inert; team.list answers with rootProblem; other team.* reject disabled; no team server', async () => {
  const root = path.join(mk('off-'), 'helm-team');
  let seen = null;
  const sdk = withMcp(createFakeSdk(async function* (um, api) { seen = api.options; yield* F.textTurn('m1', 'hi'); yield F.result(0.01); }));
  const { engine, ud } = makeEngine({ sdk, team: { settings: () => ({ enabled: false }), root: () => root, rootProblem: () => 'The team folder is inside the git repo at X.' } });
  await new Promise((r) => setTimeout(r, 30));
  const list = await engine.methods['team.list']({});
  assert.strictEqual(list.enabled, false);
  assert.strictEqual(list.root, root);
  assert.match(list.rootProblem, /git repo/);
  assert.deepStrictEqual(list.companies, []);
  for (const m of ['team.get', 'team.decide', 'team.proposals.import', 'team.inbox']) {
    await assert.rejects(engine.methods[m]({ company: 'x', proposal: 'p_1', decision: 'approve', json: {} }), (e) => e.code === 'disabled', m);
  }
  const { id } = await engine.methods['sessions.create']({ cwd: mk('plain-') });
  await engine.methods['sessions.send']({ id, text: 'hello' });
  await until(() => seen, 3000, 'turn');
  assert.ok(!seen.mcpServers || !seen.mcpServers.team, 'no team server while off');
  assert.ok(!fs.existsSync(root), 'no team root created while off');
  assert.ok(!fs.existsSync(path.join(ud, 'team-state.json')), 'no team-state while off');
  assert.strictEqual(engine.team.status().running, false);
  await engine.shutdown();
});

test('Positions on: import -> approve -> CEO roster -> ask answered by a position (seed, isolation) -> guard deny -> request_access once -> allowed once', async () => {
  const root = path.join(mk('on-'), 'helm-team');
  const company = mk('co-');
  const outside = mk('outside-');
  const secret = path.join(outside, 'plan.md');
  fs.writeFileSync(secret, 'plan');
  const st = { enabled: true, ownerName: 'Jordan' }; // team.ownerName reaches every module through wire.js's getter
  const log = { ceo: null, pos: [], guard: [] };
  let ceoScript = null;
  const sdk = withMcp(createFakeSdk(async function* (um, api) {
    const o = api.options;
    if (isPosition(o)) {
      const text = textOf(um);
      log.pos.push({ text, opts: o });
      if (/WHAT-SHIPS/.test(text)) { yield* F.textTurn(`p${log.pos.length}`, 'answer-42: Mondays'); yield F.result(0.01); return; }
      if (/TRY-READ/.test(text)) {
        const hook = o.hooks.PreToolUse[1].hooks[0]; // prod-guard, team guard, own-file observer
        const call = () => hook({ tool_name: 'Read', tool_input: { file_path: secret }, cwd: o.cwd }, 'tu1', { signal: new AbortController().signal });
        log.guard.push(await call());
        const ask = toolOf(o, 'request_access');
        const pending = ask({ kind: 'read', target: secret, why: 'need the plan' });
        log.guard.push(await pending);
        log.guard.push(await call());
        log.guard.push(await call());
        yield* F.textTurn(`p${log.pos.length}`, 'done'); yield F.result(0.01); return;
      }
      if (/DO-REPORT/.test(text)) {
        log.report = await toolOf(o, 'duty_report')({ summary: 'Orders checked.', needs_owen: false });
        yield* F.textTurn(`p${log.pos.length}`, 'reported'); yield F.result(0.01); return;
      }
      yield* F.textTurn(`p${log.pos.length}`, 'ok'); yield F.result(0.01); return;
    }
    log.ceo = o;
    if (ceoScript) { const r = await ceoScript(o); log.ceoResult = r; }
    yield* F.textTurn('c1', 'ceo done'); yield F.result(0.01);
  }));
  const { engine, emitted } = makeEngine({ sdk, team: { settings: () => st, root: () => root, rootProblem: () => null } });
  try {
  await until(() => engine.team.status().running, 3000, 'team start');
  assert.ok(fs.existsSync(path.join(root, 'house-rules.md')), 'root made with house rules');

  // import: pending only, never approved
  const imp = await engine.methods['team.proposals.import']({ json: fixture(company) });
  assert.strictEqual(imp.imported.length, 2);
  let list = await engine.methods['team.list']({});
  assert.strictEqual(list.companies.length, 0, 'nothing approved by an import');
  assert.ok((list.proposals || []).some((p) => p.action === 'company' && p.status === 'open'));
  const byRef = (r) => imp.imported.find((x) => x.ref === r).id;
  const early = await engine.methods['team.decide']({ proposal: byRef('ops'), decision: 'approve' });
  assert.strictEqual(early.ok, false, 'a create before its company fails and stays open');
  assert.strictEqual((await engine.methods['team.decide']({ proposal: byRef('company'), decision: 'approve' })).ok, true);
  const made = await engine.methods['team.decide']({ proposal: byRef('ops'), decision: 'approve' });
  assert.strictEqual(made.ok, true, made.error);
  assert.deepStrictEqual(made.created, { company: 'northwind', id: 'ops' });
  const nb = fs.readFileSync(path.join(root, 'northwind', 'positions', 'ops', 'notebook.md'), 'utf8');
  for (const h of ['## Decisions', '## Facts', '## Open items', '## Log']) assert.ok(nb.includes(h), h);
  assert.match(nb, /weekly sheet/, 'the FULL notebook, not just Facts');
  list = await engine.methods['team.list']({});
  assert.deepStrictEqual(list.companies.map((c) => [c.id, c.positions]), [['northwind', 1]]);
  const g = await engine.methods['team.get']({ company: 'northwind' });
  assert.deepStrictEqual(g.tree.map((r) => r.id), ['ops']);
  assert.deepStrictEqual([g.tree[0].department, g.tree[0].departmentHead], ['Operations', 'ops'], 'team.get rows carry the derived department');
  assert.deepStrictEqual([g.limits.depthCap, g.limits.reportsPerManager, g.limits.positionsPerCompany, g.limits.expiryH], [5, 10, 30, 2]);
  const pv = await engine.methods['team.position']({ company: 'northwind', id: 'ops' });
  assert.ok(pv.position.effective && Array.isArray(pv.position.effective.read) && pv.position.limitedBy && typeof pv.position.limitedBy === 'object');
  assert.ok(g.proposals.some((p) => p.status === 'approved'), 'team.get carries decided proposals');
  assert.ok(emitted.some(([e]) => e === 'team.proposal.updated'));

  // a CEO session in the company folder: The owner's setup + the team server with the roster
  ceoScript = async (o) => toolOf(o, 'team_ask')({ to: 'ops', question: 'WHAT-SHIPS on which day?', wait_s: 60 });
  const ceo = await engine.methods['sessions.create']({ cwd: company });
  await engine.methods['sessions.send']({ id: ceo.id, text: 'ask ops' });
  await until(() => log.ceoResult, 8000, 'CEO ask answered');
  assert.deepStrictEqual(log.ceo.settingSources, ['user', 'project', 'local'], 'the CEO keeps the owner setup');
  assert.match(log.ceo.mcpServers.team.instance.instructions, /Operations Desk/, 'the roster is in the CEO instructions');
  assert.match(log.ceo.mcpServers.team.instance.instructions, /tell Jordan and carry on/, 'the owner name from settings');
  assert.strictEqual(log.ceoResult.status, 'answered', JSON.stringify(log.ceoResult));
  assert.match(JSON.stringify(log.ceoResult), /answer-42/);
  const ceoS = engine.snapshot().sessions.find((s) => s.id === ceo.id);
  assert.deepStrictEqual(ceoS.team, { company: 'northwind', companyName: 'Northwind Goods' });

  // the position chat: isolated options, the seed in front of the first message, chats.json, out of project groups
  const p1 = log.pos[0];
  assert.deepStrictEqual(p1.opts.settingSources, []);
  assert.strictEqual(p1.opts.strictMcpConfig, true);
  assert.deepStrictEqual(Object.keys(p1.opts.mcpServers), ['team']);
  assert.strictEqual(p1.opts.hooks.PreToolUse.length, 3, 'prod-guard + team guard + own-file observer');
  assert.strictEqual(p1.opts.hooks.PostToolUse.length, 1, 'own-file observer');
  assert.match(p1.text, /<position-seed>[\s\S]*weekly sheet[\s\S]*<\/position-seed>/);
  assert.match(p1.text, /WHAT-SHIPS/);
  const posS = engine.snapshot().sessions.find((s) => s.position);
  assert.strictEqual(posS.position.company, 'northwind');
  assert.strictEqual(posS.position.chat, 1);
  assert.match(posS.project, /^Team · /);
  assert.strictEqual(fs.realpathSync(posS.cwd), fs.realpathSync(path.join(root, 'northwind', 'positions', 'ops')));
  const chats = JSON.parse(fs.readFileSync(path.join(root, 'northwind', 'positions', 'ops', 'chats.json'), 'utf8'));
  assert.strictEqual(chats[0].helmSessionId, posS.id);
  const items = (await engine.methods['sessions.history']({ id: posS.id, limit: 50 })).items || [];
  const asked = items.find((it) => it.type === 'user' && it.origin === 'ask');
  assert.ok(asked && asked.ask && asked.ask.from.kind === 'ceo', 'the Asked-by fields ride on the user item');
  assert.ok(!/position-seed/.test(asked.text), 'the bubble never shows the seed');

  // guard deny -> request_access -> Approve once -> allowed once
  const posId = posS.id;
  const sent = engine.methods['sessions.send']({ id: posId, text: 'TRY-READ the plan' });
  await sent;
  const req = await until(() => { const es = engine._internal.sessions.get(posId); return [...es.requests.values()].map((r) => r.item).find((it) => it.kind === 'access'); }, 5000, 'access card');
  assert.strictEqual(req.access.kind, 'read');
  const pushes = emitted.filter(([e, d]) => e === 'notify' && d.source === 'team' && d.team && d.team.what === 'access').map(([, d]) => d);
  assert.strictEqual(pushes.length, 1, 'one phone push for the card');
  assert.strictEqual(pushes[0].title, 'Operations Desk needs your OK');
  assert.strictEqual(pushes[0].company, 'northwind');
  assert.strictEqual(pushes[0].sessionId, posId);
  assert.strictEqual(pushes[0].view, undefined, 'a notice with a chat opens the chat');
  const pend = await engine.methods['team.position']({ company: 'northwind', id: 'ops' });
  assert.strictEqual(pend.pending.requests[0].requestId, req.requestId);
  await engine.methods['sessions.respond']({ id: posId, requestId: req.requestId, response: { behavior: 'allow', scope: 'once' } });
  await until(() => log.guard.length === 4, 5000, 'guard calls');
  const denied = (r) => r && r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny';
  assert.ok(denied(log.guard[0]), 'first read denied');
  assert.strictEqual(log.guard[1].decision, 'once');
  assert.ok(!denied(log.guard[2]), 'the once-grant allows the next read');
  assert.ok(denied(log.guard[3]), 'and only once');
  const grants = fs.readFileSync(path.join(root, 'northwind', 'grants.jsonl'), 'utf8');
  assert.match(grants, /"once"/);

  // turning Positions off: inert again, a position chat refuses to start without its isolation
  // duty_report notifies once, through wire.js dutiesPort.report: a built 'duty' notice that opens the chat
  const before = emitted.filter(([e, d]) => e === 'notify' && d.team && d.team.what === 'duty').length;
  await engine.methods['sessions.send']({ id: posId, text: 'DO-REPORT now' });
  await until(() => log.report, 5000, 'duty_report');
  assert.strictEqual(log.report.ok, true, JSON.stringify(log.report));
  const duty = emitted.filter(([e, d]) => e === 'notify' && d.team && d.team.what === 'duty').map(([, d]) => d).slice(before);
  assert.strictEqual(duty.length, 1, 'one notice per report');
  assert.strictEqual(duty[0].title, 'Operations Desk finished a duty');
  assert.strictEqual(duty[0].body, 'Orders checked.');
  assert.strictEqual(duty[0].company, 'northwind');
  assert.strictEqual(duty[0].sessionId, posId);
  assert.strictEqual(duty[0].view, undefined);
  st.enabled = false;
  engine.team.refresh();
  assert.strictEqual((await engine.methods['team.list']({})).enabled, false);
  await assert.rejects(engine.methods['team.get']({ company: 'northwind' }), (e) => e.code === 'disabled');
  } finally { await engine.shutdown(); }
});

test('Positions turning on closes only the idle CLIs whose team setup changes: a chat in a company restarts as CEO, one in no company keeps its warm CLI', async () => {
  const root = path.join(mk('rc-'), 'helm-team');
  const company = mk('rc-co-');
  const plain = mk('rc-plain-');
  const st = { enabled: true };
  const opts = new Map(); // cwd -> distinct options objects (one per CLI start)
  const sdk = withMcp(createFakeSdk(async function* (um, api) {
    const o = api.options;
    const seen = opts.get(o.cwd) || [];
    if (!seen.includes(o)) seen.push(o);
    opts.set(o.cwd, seen);
    yield* F.textTurn(`t${seen.length}`, 'ok'); yield F.result(0.01);
  }));
  const { engine } = makeEngine({ sdk, team: { settings: () => st, root: () => root, rootProblem: () => null } });
  try {
    await until(() => engine.team.status().running, 3000, 'team start');
    const imp = await engine.methods['team.proposals.import']({ json: fixture(company) });
    const co = imp.imported.find((x) => x.ref === 'company').id;
    assert.strictEqual((await engine.methods['team.decide']({ proposal: co, decision: 'approve' })).ok, true);
    st.enabled = false; engine.team.refresh();
    assert.strictEqual(engine.team.status().running, false);

    // two warm CLIs started while Positions is off: neither has the team server
    const a = await engine.methods['sessions.create']({ cwd: plain });
    const b = await engine.methods['sessions.create']({ cwd: company });
    await engine.methods['sessions.send']({ id: a.id, text: 'one' });
    await engine.methods['sessions.send']({ id: b.id, text: 'one' });
    await until(() => (opts.get(plain) || []).length === 1 && (opts.get(company) || []).length === 1, 3000, 'first turns');
    assert.ok(!opts.get(company)[0].mcpServers || !opts.get(company)[0].mcpServers.team);
    await new Promise((r) => setTimeout(r, 150)); // both turns settle (idle, not busy)

    st.enabled = true; engine.team.refresh();
    assert.strictEqual(engine.team.status().running, true);
    await new Promise((r) => setTimeout(r, 100));
    await engine.methods['sessions.send']({ id: a.id, text: 'two' });
    await engine.methods['sessions.send']({ id: b.id, text: 'two' });
    await until(() => opts.get(company).length === 2, 3000, 'the company chat restarts');
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(opts.get(plain).length, 1, 'the chat in no company kept its warm CLI');
    assert.ok(opts.get(company)[1].mcpServers && opts.get(company)[1].mcpServers.team, 'the company chat came back as CEO with the team server');
  } finally {
    await engine.shutdown();
  }
});
