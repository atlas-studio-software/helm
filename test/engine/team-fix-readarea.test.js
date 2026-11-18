'use strict';
// Positions fix 2, end to end through the engine wiring (main/engine/team/wire.js) with the fake SDK: a position hands
// files (team_ask / colleague_ask `handed`) only from inside its own read area. That area is the guard's view
// (wire.js powersFor: the store's effective powers plus onboarding reads and the worktree path), handed to the runtime
// as opts.readArea. Helpers copied from test/engine/team-wiring.test.js.
//
// The onboarding case is the one that passes ONLY because of the wiring (the runtime's store fallback does not know
// onboarding reads). It also guards the onboarding start itself: proposals.js once passed the position OBJECT as
// `position` to opts.onboard, so the run never started ("no position [object Object]"). The worktree is no
// substitute: it sits inside the position's workspace, which the fallback reads too.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../../main/engine');
const { createFakeSdk, F } = require('./fake-sdk');

const tmp = [];
// the long form, as the engine resolves it (CI's TEMP is an 8.3 short name)
const mk = (p) => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `helm-ra-${p}`))); tmp.push(d); return d; };
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

const position = (id, name, extra = {}) => ({
  action: 'create', id, parent: null, name, remit: `${name} work.`, scope: { kind: 'company' },
  brief: `# ${name}\n\n${name} work.\n`,
  powers: { read: ['$workspace'], write: ['$workspace'], tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'], bash: 'off', agents: false, worktree: false },
  duties: [], model: null, effort: 'low', seed: { notes: 'A note.', files: [] }, why: 'test', ...extra,
});
// ops and desk read only their own workspaces; the company folder holds files neither may read
function fixture(companyFolder, onboardFiles = []) {
  return {
    kind: 'helm-team-proposals', status: 'pending', company: 'northwind', draftedAt: '2026-01-01T00:00:00Z', draftedBy: 'test', note: 'test fixture',
    proposals: [
      { ref: 'company', status: 'pending', team_propose: { action: 'company', id: 'northwind', name: 'Northwind Goods', folders: [companyFolder], why: 'test' } },
      { ref: 'desk', status: 'pending', team_propose: position('desk', 'Front Desk') },
      { ref: 'ops', status: 'pending', team_propose: position('ops', 'Operations Desk', { seed: { notes: 'Orders ship on Mondays.', files: onboardFiles.map((p) => ({ path: p, why: 'the order rules' })) } }) },
    ],
  };
}

function makeEngine({ sdk, team, logs = [] }) {
  const ud = mk('ud-');
  const emitted = [];
  const engine = createEngine({
    userDataDir: ud, emit: (e, d) => emitted.push([e, d]), log: (lvl, m) => logs.push([lvl, String(m)]), sdk, claudePath: null, projectsDir: mk('proj-'), statuslineDir: mk('sl-'),
    etaDir: false, external: false, broker: false, tempDir: path.join(os.tmpdir(), 'not-the-test-dirs'), getIdleCloseMs: () => 0, team,
  });
  return { engine, ud, emitted };
}

const crosstalk = (root) => {
  const f = path.join(root, 'northwind', 'crosstalk.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};
const asked = (root, q) => crosstalk(root).filter((l) => l.state === 'asked' && String(l.question || '').includes(q));
// handed paths are stored resolved with forward slashes; compare case- and separator-blind
const norm = (p) => String(p).split(path.sep).join('/').toLowerCase();
const handedOf = (root, q) => asked(root, q).flatMap((l) => l.handed || []).map(norm);
const key = (p) => norm(fs.realpathSync(p));

async function approveAll(engine, json) {
  const imp = await engine.methods['team.proposals.import']({ json });
  assert.strictEqual(imp.imported.length, 3);
  for (const ref of ['company', 'desk', 'ops']) {
    const d = await engine.methods['team.decide']({ proposal: imp.imported.find((x) => x.ref === ref).id, decision: 'approve' });
    assert.strictEqual(d.ok, true, `${ref}: ${d.error}`);
  }
}

test('fix 2 wiring: a position hands a file from its own read area (ticket made); a company file it cannot read is refused in plain words, no ticket', async () => {
  const root = path.join(mk('root-'), 'helm-team');
  const company = mk('co-');
  const secret = path.join(company, 'private-plan.md');
  fs.writeFileSync(secret, 'not for ops');
  const st = { enabled: true };
  const log = { asks: null, desk: [], ceoResult: null };
  const opsWs = path.join(root, 'northwind', 'positions', 'ops');
  const own = path.join(opsWs, 'notebook.md');
  let ceoScript = null;

  const sdk = withMcp(createFakeSdk(async function* (um, api) {
    const o = api.options;
    if (isPosition(o)) {
      const text = textOf(um);
      if (/DO-ASKS/.test(text)) {
        const ask = toolOf(o, 'colleague_ask');
        const r = {};
        r.inside = await ask({ to: 'desk', question: 'HANDED-OWN: does this notebook match yours?', handed: [own], wait_s: 30 });
        r.outside = await ask({ to: 'desk', question: 'HANDED-SECRET: what does this plan say?', handed: [secret], wait_s: 30 });
        r.mixed = await ask({ to: 'desk', question: 'HANDED-MIXED: both of these?', handed: [own, secret], wait_s: 30 });
        log.asks = r;
        yield* F.textTurn('pa', 'asked'); yield F.result(0.01); return;
      }
      if (/HANDED-/.test(text)) log.desk.push(text);
      yield* F.textTurn('pd', 'desk-answer: yes'); yield F.result(0.01); return;
    }
    if (ceoScript) log.ceoResult = await ceoScript(o);
    yield* F.textTurn('c1', 'ceo done'); yield F.result(0.01);
  }));
  const { engine } = makeEngine({ sdk, team: { settings: () => st, root: () => root, rootProblem: () => null } });
  try {
    await until(() => engine.team.status().running, 3000, 'team start');
    await approveAll(engine, fixture(company));
    assert.ok(fs.existsSync(own), 'ops has its workspace notebook');

    // the CEO asks ops once, so ops has a live chat; then ops (in that chat) asks its colleague desk
    ceoScript = async (o) => toolOf(o, 'team_ask')({ to: 'ops', question: 'Are you there?', wait_s: 60 });
    const ceo = await engine.methods['sessions.create']({ cwd: company });
    await engine.methods['sessions.send']({ id: ceo.id, text: 'ask ops' });
    await until(() => log.ceoResult, 8000, 'CEO ask answered');
    assert.strictEqual(log.ceoResult.status, 'answered', JSON.stringify(log.ceoResult));
    const ops = engine.snapshot().sessions.find((s) => s.position && s.position.id === 'ops');
    assert.ok(ops, 'an ops chat');
    await until(() => { const es = engine._internal.sessions.get(ops.id); return es && !es.turnActive && !es.starting; }, 5000, 'ops idle');
    await engine.methods['sessions.send']({ id: ops.id, text: 'DO-ASKS now' });
    const r = await until(() => log.asks, 15000, 'ops asks');

    // (a) a file in its own read area (its workspace): handed, one ticket, the resolved path rides on it
    assert.notStrictEqual(r.inside.status, 'refused', JSON.stringify(r.inside));
    assert.strictEqual(asked(root, 'HANDED-OWN').length, 1, 'the inside ask made one ticket');
    assert.ok(handedOf(root, 'HANDED-OWN').includes(key(own)), 'the handed file rides on the ticket');
    await until(() => log.desk.some((t) => /HANDED-OWN/.test(t)), 15000, 'desk got the inside ask');

    // (b) a company-folder file ops cannot read: refused, a plain reason naming the path, no ticket; one bad path
    // in a list refuses the whole ask
    for (const [k, q] of [['outside', 'HANDED-SECRET'], ['mixed', 'HANDED-MIXED']]) {
      assert.strictEqual(r[k].status, 'refused', `${k}: ${JSON.stringify(r[k])}`);
      assert.match(r[k].reason, /You can hand only files you can read yourself\. Outside your read area: /, k);
      assert.ok(r[k].reason.includes(secret), `${k}: the reason names the path`);
      assert.ok(!r[k].reason.includes(own), `${k}: the reason names only the outside path`);
      assert.strictEqual(asked(root, q).length, 0, `${k}: no ticket`);
      assert.ok(crosstalk(root).some((l) => l.state === 'refused' && String(l.question || '').includes(q)), `${k}: the refusal is logged`);
    }
    await new Promise((res) => setTimeout(res, 100));
    assert.ok(!log.desk.some((t) => /HANDED-SECRET|HANDED-MIXED/.test(t)), 'a refused ask never reaches the answerer');
  } finally { await engine.shutdown(); }
});

test('fix 2 wiring: a file from the position\'s onboarding reads may be handed during the onboarding run (only the wiring knows them), not after', async () => {
  const root = path.join(mk('root-'), 'helm-team');
  const company = mk('co-');
  const onboardFile = path.join(company, 'order-rules.md');
  fs.writeFileSync(onboardFile, 'Orders ship on Mondays.');
  const st = { enabled: true };
  const logs = [];
  const log = { during: null, after: null };
  const sdk = withMcp(createFakeSdk(async function* (um, api) {
    const o = api.options;
    if (isPosition(o)) {
      const text = textOf(um);
      if (/Onboarding: you are new/.test(text) && !log.during) {
        log.during = await toolOf(o, 'colleague_ask')({ to: 'desk', question: 'HANDED-ONBOARD: are these the order rules?', handed: [onboardFile], wait_s: 30 });
        yield* F.textTurn('po', 'onboarded'); yield F.result(0.01); return;
      }
      if (/ASK-AFTER/.test(text)) {
        log.after = await toolOf(o, 'colleague_ask')({ to: 'desk', question: 'HANDED-LATER: the order rules again?', handed: [onboardFile], wait_s: 30 });
        yield* F.textTurn('pl', 'done'); yield F.result(0.01); return;
      }
      yield* F.textTurn('pd', 'desk-answer: yes'); yield F.result(0.01); return;
    }
    yield* F.textTurn('c1', 'ceo done'); yield F.result(0.01);
  }));
  const { engine } = makeEngine({ sdk, logs, team: { settings: () => st, root: () => root, rootProblem: () => null } });
  try {
    await until(() => engine.team.status().running, 3000, 'team start');
    await approveAll(engine, fixture(company, [onboardFile]));
    const failed = () => logs.find(([lvl, m]) => lvl === 'warn' && /onboarding .* failed to start/.test(m));
    // approving ops (seed files) starts its onboarding run; inside it, ops hands the onboarding file
    const during = await until(() => log.during || failed(), 15000, 'onboarding run');
    assert.ok(!Array.isArray(during), `the onboarding run did not start: ${during && during[1]}`);
    assert.notStrictEqual(during.status, 'refused', `the onboarding read was refused: ${JSON.stringify(during)}`);
    assert.ok(handedOf(root, 'HANDED-ONBOARD').includes(key(onboardFile)), 'the onboarding file rides on the ticket');

    // once the run is done the onboarding reads are gone: the same file is outside ops's read area again
    await until(() => crosstalk(root).some((l) => l.to === 'ops' && l.state && l.state !== 'asked' && l.state !== 'refused'), 15000, 'the onboarding run settled');
    const ops = await until(() => {
      const s = engine.snapshot().sessions.find((x) => x.position && x.position.id === 'ops');
      const es = s && engine._internal.sessions.get(s.id);
      return s && es && !es.turnActive && !es.starting ? s : null;
    }, 15000, 'ops idle');
    // the onboarding run has the duties.js shape: duty.trigger is the string label (the chat's duty line reads it)
    const hist = (await engine.methods['sessions.history']({ id: ops.id, limit: 50 })).items || [];
    const dutyItem = hist.find((it) => it.type === 'user' && it.duty && it.duty.id === 'onboarding');
    assert.ok(dutyItem, `the onboarding message carries its duty: ${JSON.stringify(hist.filter((it) => it.type === 'user').map((it) => it.origin))}`);
    assert.strictEqual(dutyItem.duty.trigger, 'onboarding');
    await engine.methods['sessions.send']({ id: ops.id, text: 'ASK-AFTER the onboarding' });
    const after = await until(() => log.after, 15000, 'the ask after onboarding');
    assert.strictEqual(after.status, 'refused', JSON.stringify(after));
    assert.match(after.reason, /You can hand only files you can read yourself/);
  } finally { await engine.shutdown(); }
});
