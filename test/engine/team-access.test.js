// Positions: access requests (main/engine/team/access.js, docs/POSITIONS.md 7.3-7.4). A temp team root through the real
// store, a fake EngineSession.openRequest (the card) and a fake clock; no network, no Helm.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../../main/engine/team/schema');
const { createTeamStore } = require('../../main/engine/team/store');
const { createAccess } = require('../../main/engine/team/access');
const guard = require('../../main/engine/team/guard');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'team-access-'));
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });
const CID = 'acme';
const BRIEF = '# Role\n\nDoes the thing.\n';
const MIN = 60_000;
let n = 0;

// A fresh root: company acme (folder co/app), Legal (top) -> Tax (report). Outside: a folder no company owns.
function rig({ waitMs, ownerName } = {}) {
  const dir = path.join(TMP, `r${++n}`);
  const app = S.normPath(path.join(dir, 'co', 'app'));
  const outside = S.normPath(path.join(dir, 'outside'));
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const store = createTeamStore({ root: path.join(dir, 'team'), houseRulesDefault: '# House rules\n1. Report faithfully.\n' });
  store.ensureRoot();
  store.createCompany({ id: CID, name: 'Acme', folders: [app] });
  store.createPosition(CID, { id: 'legal', name: 'Legal', parent: null, remit: 'Contracts.' }, { brief: BRIEF });
  store.createPosition(CID, { id: 'tax', name: 'Tax Specialist', parent: 'legal', remit: 'Tax.' }, { brief: BRIEF });

  // fake clock: timers fire only when advanced
  const clock = { t: Date.parse('2026-11-18T10:00:00Z'), timers: [] };
  clock.now = () => clock.t;
  clock.setTimeout = (fn, ms) => { const h = { fn, at: clock.t + ms, done: false }; clock.timers.push(h); return h; };
  clock.clearTimeout = (h) => { if (h) h.done = true; };
  clock.advance = (ms) => {
    clock.t += ms;
    for (const h of clock.timers.slice()) if (!h.done && h.at <= clock.t) { h.done = true; h.fn(); }
  };

  // fake sessions: each es records its cards; card.answer(x) resolves the card
  const cards = [];
  const closed = [];
  const mkEs = (sessionId, pid, name) => ({
    s: { position: { company: CID, id: pid, name } },
    openRequest(opts) {
      let resolve;
      const result = new Promise((r) => { resolve = r; });
      const card = { sessionId, opts, requestId: `r${cards.length + 1}`, answer: (a) => resolve(a) };
      cards.push(card);
      return { requestId: card.requestId, itemId: `i${cards.length}`, result };
    },
    closeRequest(requestId, why) {
      closed.push({ requestId, why });
      const c = cards.find((x) => x.requestId === requestId);
      if (c) c.answer({ cancelled: true, message: why });
    },
  });
  const ses = new Map([['s1', mkEs('s1', 'tax', 'Tax Specialist')], ['s2', mkEs('s2', 'legal', 'Legal')], ['s3', mkEs('s3', 'tax', 'Tax Specialist')]]);
  const events = [];
  const logs = [];
  const A = createAccess({
    store, sessions: { get: (sid) => ses.get(sid) || null },
    emit: (ev, p) => events.push([ev, p]), clock, log: (l, m) => logs.push(`${l} ${m}`), ...(waitMs ? { waitMs } : {}), ...(ownerName !== undefined ? { ownerName } : {}),
  });
  const grantsLog = () => store.readLog(CID, 'grants').lines;
  const tick = () => new Promise((r) => setImmediate(r));
  return { dir, app, outside, store, clock, cards, closed, ses, events, logs, A, grantsLog, tick };
}

// the guard's need, matched exactly as the guard does
const need = (kind, target) => { const x = { kind, target, toolName: 'Read' }; x.matches = (g) => guard.grantMatches(g, x); return x; };

test('once: card fields, grant stored in memory and consumed by the guard exactly once, grants.jsonl line', async () => {
  const R = rig();
  const target = `${R.outside}/notes.txt`;
  const p = R.A.request({ company: CID, position: 'tax', sessionId: 's1', ticket: 't_1', kind: 'read', target, why: 'The supplier notes.' });
  await R.tick();
  assert.equal(R.cards.length, 1);
  const o = R.cards[0].opts;
  assert.equal(o.kind, 'access');
  assert.equal(o.title, 'Tax Specialist asks for read access');
  assert.match(o.body, /notes\.txt/);
  assert.match(o.body, /The supplier notes\./);
  assert.equal(o.waitMs, 30 * MIN);
  assert.deepEqual(o.access.position, { id: 'tax', name: 'Tax Specialist', path: ['Legal', 'Tax Specialist'] });
  assert.equal(o.access.outward, false);
  assert.equal(o.access.onceOnly, true, 'outside the company folders: once only');
  assert.equal(o.access.waitMin, 30);
  assert.deepEqual(R.A.pending(CID).map((x) => [x.position, x.kind, x.target, x.sessionId]), [['tax', 'read', target, 's1']]);
  assert.ok(R.events.some(([ev, x]) => ev === 'team.access.updated' && x.company === CID && x.request.state === 'open'));

  R.cards[0].answer({ behavior: 'allow', scope: 'once' });
  const r = await p;
  assert.equal(r.decision, 'once');
  assert.deepEqual(R.A.pending(), []);
  assert.ok(R.events.some(([ev, x]) => ev === 'team.access.updated' && x.request.state === 'closed'));
  const g = R.A.grants(CID, 'tax');
  assert.equal(g.length, 1);
  assert.match(g[0].id, /^g_[0-9a-f]+$/);
  assert.deepEqual([g[0].kind, g[0].target, g[0].sessionId, g[0].position], ['read', target, 's1', 'tax']);

  // a rolled-over chat (s3) of the same position can use it; a different position (s2) cannot
  assert.equal(R.A.consumeGrant('s2', need('read', `${target}`)), null);
  assert.equal(R.A.consumeGrant('s3', need('read', `${R.outside}/other.txt`)), null, 'only the granted path');
  const used = R.A.consumeGrant('s3', need('read', target));
  assert.ok(used && used.id === g[0].id);
  assert.equal(R.A.consumeGrant('s1', need('read', target)), null, 'one use only');
  assert.equal(R.A.consumeGrant('nope', need('read', target)), null, 'unknown session');

  const lines = R.grantsLog();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, g[0].id);
  assert.equal(lines[0].position, 'tax');
  assert.deepEqual(lines[0].request, { kind: 'read', target, why: 'The supplier notes.' });
  assert.equal(lines[0].decision, 'once');
  assert.equal(lines[0].ticket, 't_1');
  assert.ok(lines[0].at);
});

test('once-grants expire with the card lifetime when unused', async () => {
  const R = rig();
  const p = R.A.request({ company: CID, position: 'tax', sessionId: 's1', kind: 'tool', target: 'NotebookEdit', why: 'A notebook.' });
  await R.tick();
  R.cards[0].answer({ behavior: 'allow', scope: 'once' });
  assert.equal((await p).decision, 'once');
  R.clock.advance(29 * MIN);
  assert.equal(R.A.grants(CID).length, 1);
  R.clock.advance(2 * MIN);
  assert.equal(R.A.grants(CID).length, 0);
  assert.equal(R.A.consumeGrant('s1', need('tool', 'NotebookEdit')), null);
});

test('always: saved into position.json, ancestors whose own powers cut it are widened, effective powers include it', async () => {
  const R = rig();
  R.store.updatePosition(CID, 'legal', { name: 'General Counsel' }); // a real job title, so names differs from the id
  const target = `${R.app}/contracts`;
  const v0 = { tax: R.store.getPosition(CID, 'tax').version, legal: R.store.getPosition(CID, 'legal').version };
  assert.ok(!R.store.effectivePowers(CID, 'tax').write.some((w) => S.isUnder(target, w)));
  const p = R.A.request({ company: CID, position: 'tax', sessionId: 's1', kind: 'write', target, why: 'Redlines.' });
  await R.tick();
  const o = R.cards[0].opts;
  assert.deepEqual(o.access.ancestors, ['legal'], 'Approve always also widens Legal');
  assert.deepEqual(o.access.names, { legal: 'General Counsel' }, 'the card names each widened manager by its real name');
  assert.equal(o.access.onceOnly, undefined);
  R.cards[0].answer({ behavior: 'allow', scope: 'always' });
  const r = await p;
  assert.equal(r.decision, 'always');
  assert.deepEqual(r.savedTo, ['legal', 'tax']);
  assert.match(r.note, /also widened legal/);
  const tax = R.store.getPosition(CID, 'tax');
  const legal = R.store.getPosition(CID, 'legal');
  assert.equal(tax.version, v0.tax + 1);
  assert.equal(legal.version, v0.legal + 1);
  assert.ok(tax.powers.write.includes(target) && legal.powers.write.includes(target));
  assert.ok(tax.powers.write.includes('$workspace'), 'existing entries kept');
  assert.ok(!tax.powers.read.includes(target), 'read already covered by $company: not duplicated');
  const eff = R.store.effectivePowers(CID, 'tax');
  assert.ok(eff.write.some((w) => S.isUnder(target, w)));
  assert.equal(R.A.grants(CID).length, 0, 'always stores no once-grant');
  assert.ok(R.events.some(([ev, x]) => ev === 'team.updated' && x.company === CID));
  const line = R.grantsLog().at(-1);
  assert.equal(line.decision, 'always');
  assert.deepEqual(line.savedTo, ['legal', 'tax']);
});

test('always: bash and tool requests widen the position and its ancestors', async () => {
  const R = rig();
  let p = R.A.request({ company: CID, position: 'tax', sessionId: 's1', kind: 'bash', target: 'bash:readonly', why: 'git log.' });
  await R.tick();
  R.cards[0].answer({ behavior: 'allow', scope: 'always' });
  assert.equal((await p).decision, 'always');
  assert.equal(R.store.getPosition(CID, 'tax').powers.bash, 'readonly');
  assert.equal(R.store.getPosition(CID, 'legal').powers.bash, 'readonly');
  assert.equal(R.store.effectivePowers(CID, 'tax').bash, 'readonly');
  p = R.A.request({ company: CID, position: 'tax', sessionId: 's1', kind: 'tool', target: 'Agent', why: 'Parallel reads.' });
  await R.tick();
  R.cards[1].answer({ behavior: 'allow', scope: 'always' });
  assert.equal((await p).decision, 'always');
  const tax = R.store.getPosition(CID, 'tax');
  assert.ok(tax.powers.tools.includes('Agent') && tax.powers.agents === true, 'Agent needs agents: true');
  assert.ok(R.store.effectivePowers(CID, 'tax').tools.includes('Agent'));
});

test('always beyond the company folders is answered as once (never a standing power)', async () => {
  const R = rig();
  const target = `${R.outside}/a.txt`;
  const before = R.store.getPosition(CID, 'tax');
  const p = R.A.request({ company: CID, position: 'tax', sessionId: 's1', kind: 'read', target, why: 'x' });
  await R.tick();
  R.cards[0].answer({ behavior: 'allow', scope: 'always' });
  const r = await p;
  assert.equal(r.decision, 'once');
  assert.match(r.note, /outside the company's folders/);
  assert.deepEqual(R.store.getPosition(CID, 'tax'), before, 'position.json untouched');
  assert.equal(R.A.grants(CID).length, 1);
  assert.equal(R.grantsLog().at(-1).decision, 'once');
  assert.match(R.grantsLog().at(-1).note, /asked always/);
});

test('deny: nothing stored, note carries the owner\'s message, logged', async () => {
  const R = rig();
  const p = R.A.request({ company: CID, position: 'tax', sessionId: 's1', kind: 'tool', target: 'WebSearch', why: 'x' });
  await R.tick();
  R.cards[0].answer({ behavior: 'deny', message: 'Use the notes you have.' });
  const r = await p;
  assert.equal(r.decision, 'denied');
  assert.match(r.note, /a later need may ask again/);
  assert.match(r.note, /Use the notes you have\./);
  assert.equal(R.A.grants().length, 0);
  const line = R.grantsLog().at(-1);
  assert.equal(line.decision, 'denied');
  assert.equal(line.note, 'Use the notes you have.');
});

test('outward: always is answered as once (request_access and the guard port)', async () => {
  const R = rig();
  const p = R.A.request({ company: CID, position: 'tax', sessionId: 's1', kind: 'outward', target: 'gh issue create --title x', why: 'File the bug.' });
  await R.tick();
  assert.equal(R.cards[0].opts.access.outward, true);
  assert.equal(R.cards[0].opts.access.command, 'gh issue create --title x');
  assert.equal(R.cards[0].opts.title, 'Tax Specialist asks to run an outward action');
  R.cards[0].answer({ behavior: 'allow', scope: 'always' });
  const r = await p;
  assert.equal(r.decision, 'once');
  assert.equal(R.store.getPosition(CID, 'tax').version, 1, 'nothing saved');
  assert.ok(R.A.consumeGrant('s1', need('outward', 'gh issue  create --title x')), 'the guard can use it once');

  const ac = new AbortController();
  const q = R.A.requestApproval({ kind: 'outward', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'npm publish' }, toolUseID: 'tu9',
    signal: ac.signal, command: 'npm publish', what: ['npm publish'], title: 'Outward action · npm publish', waitMs: 30 * MIN });
  await R.tick();
  const c = R.cards[1].opts;
  assert.deepEqual([c.kind, c.toolName, c.toolUseId, c.signal, c.access.outward, c.access.command], ['access', 'Bash', 'tu9', ac.signal, true, 'npm publish']);
  assert.deepEqual(c.input, { command: 'npm publish' });
  R.cards[1].answer({ behavior: 'allow', scope: 'always' });
  assert.deepEqual(await q, { decision: 'once' });
  assert.equal(R.A.grants().length, 0, 'the guard port allows directly; no grant left behind');
  const line = R.grantsLog().at(-1);
  assert.equal(line.decision, 'once');
  assert.equal(line.via, 'guard');

  const d = R.A.requestApproval({ kind: 'outward', sessionId: 's1', toolName: 'Bash', command: 'git push', what: ['git push'] });
  await R.tick();
  R.cards[2].answer({ behavior: 'deny', message: 'Not yet.' });
  assert.deepEqual(await d, { behavior: 'deny', message: 'Not yet.' });
  assert.equal(R.grantsLog().at(-1).decision, 'denied');
  const none = await R.A.requestApproval({ kind: 'outward', sessionId: 'ghost', command: 'git push' });
  assert.equal(none.behavior, 'deny');
});

test('timeout: the card times out -> no-answer; the backstop closes a card that never times out itself', async () => {
  const R = rig();
  const p = R.A.request({ company: CID, position: 'tax', sessionId: 's1', kind: 'tool', target: 'WebSearch', why: 'x' });
  await R.tick();
  R.cards[0].answer({ timedOut: true });
  const r = await p;
  assert.equal(r.decision, 'no-answer');
  assert.equal(R.grantsLog().at(-1).decision, 'no-answer');

  const q = R.A.request({ company: CID, position: 'tax', sessionId: 's1', kind: 'tool', target: 'TodoWrite', why: 'y' });
  await R.tick();
  R.clock.advance(31 * MIN);
  assert.equal((await q).decision, 'no-answer');
  assert.equal(R.closed.length, 1, 'closeRequest called on the card');
  assert.deepEqual(R.A.pending(), []);
  const g = R.A.requestApproval({ kind: 'outward', sessionId: 's1', command: 'npm publish', waitMs: 5 * MIN });
  await R.tick();
  R.cards[2].answer({ timedOut: true });
  const gr = await g;
  assert.equal(gr.behavior, 'deny');
  assert.equal(gr.timedOut, true);
});

test('late answer: the mcp handler gave up at 600 s, the owner answers later, the grant is still stored for the next try', async () => {
  const R = rig();
  const target = `${R.outside}/late.txt`;
  const req = R.A.request({ company: CID, position: 'tax', sessionId: 's1', kind: 'read', target, why: 'x' });
  // the mcp handler's race: its own 600 s timer wins
  let t;
  const timed = new Promise((res) => { t = R.clock.setTimeout(() => res({ decision: 'no-answer' }), 600_000); });
  await R.tick();
  R.clock.advance(600_000);
  assert.equal((await Promise.race([req, timed])).decision, 'no-answer');
  R.clock.clearTimeout(t);
  assert.equal(R.A.pending().length, 1, 'the card stays open');
  // asking again while it is open joins the same card
  const again = R.A.request({ company: CID, position: 'tax', sessionId: 's1', kind: 'read', target, why: 'x again' });
  await R.tick();
  assert.equal(R.cards.length, 1, 'no second card');
  R.clock.advance(5 * MIN);
  R.cards[0].answer({ behavior: 'allow', scope: 'once' });
  assert.equal((await req).decision, 'once');
  assert.equal((await again).decision, 'once');
  assert.equal(R.A.grants(CID).length, 1);
  // the next try (a new request for the same thing) is answered at once: no new card
  const next = await R.A.request({ company: CID, position: 'tax', sessionId: 's1', kind: 'read', target, why: 'x' });
  assert.equal(next.decision, 'once');
  assert.match(next.note, /already approved/);
  assert.equal(R.cards.length, 1);
  assert.ok(R.A.consumeGrant('s1', need('read', target)));
  assert.equal(R.grantsLog().filter((l) => l.decision === 'once').length, 1, 'one line per card');
});

test('pending() and cancelFor(): open cards listed per company, a chat ending closes its cards as stopped', async () => {
  const R = rig();
  const a = R.A.request({ company: CID, position: 'tax', sessionId: 's1', kind: 'tool', target: 'WebSearch', why: 'x' });
  R.clock.advance(1000);
  const b = R.A.request({ company: CID, position: 'legal', sessionId: 's2', kind: 'tool', target: 'TodoWrite', why: 'y' });
  await R.tick();
  const pend = R.A.pending(CID);
  assert.deepEqual(pend.map((x) => x.position), ['tax', 'legal']);
  for (const x of pend) assert.deepEqual(Object.keys(x).sort(), ['access', 'at', 'company', 'id', 'kind', 'position', 'requestId', 'sessionId', 'target']);
  assert.equal(pend[0].requestId, R.cards[0].requestId);
  assert.deepEqual(pend[0].access, R.cards[0].opts.access);
  assert.deepEqual(R.A.pending('other'), []);
  assert.equal(R.A.cancelFor('s1', 'The chat ended.'), 1);
  const ra = await a;
  assert.equal(ra.decision, 'stopped');
  assert.equal(ra.note, 'The chat ended.');
  assert.deepEqual(R.closed.map((c) => c.why), ['The chat ended.']);
  assert.deepEqual(R.A.pending().map((x) => x.position), ['legal']);
  assert.equal(R.grantsLog().at(-1).decision, 'stopped');
  R.A.stop();
  assert.equal((await b).decision, 'stopped');
  assert.deepEqual(R.A.pending(), []);
  assert.ok(R.clock.timers.every((h) => h.done), 'every timer cleared');
});

test('bad input and a closed chat are denied without a card', async () => {
  const R = rig();
  assert.equal((await R.A.request({ company: CID, position: 'tax', sessionId: 's1', kind: 'nope', target: 'x', why: 'x' })).decision, 'denied');
  assert.equal((await R.A.request({ company: CID, position: 'ghost', sessionId: 's1', kind: 'tool', target: 'X', why: 'x' })).decision, 'denied');
  const r = await R.A.request({ company: CID, position: 'tax', sessionId: 'gone', kind: 'tool', target: 'WebSearch', why: 'x' });
  assert.equal(r.decision, 'denied');
  assert.match(r.note, /not open/);
  assert.equal(R.cards.length, 0);
  assert.equal(R.grantsLog().at(-1).decision, 'denied');
});

// The owner's name in every note and message comes from ownerName (string or getter, read per message); unset or
// empty it reads "the owner" / "The owner". No text names anyone by default.
async function ownerTexts(ownerName) {
  const R = rig({ ownerName });
  const texts = [];
  const ask = async (target, answer) => {
    const p = R.A.request({ company: CID, position: 'tax', sessionId: 's1', kind: 'tool', target, why: 'x' });
    await R.tick();
    R.cards.at(-1).answer(answer);
    return p;
  };
  const d = await ask('WebSearch', { behavior: 'deny', message: 'Use the notes.' });
  texts.push(d.note);
  texts.push((await ask('TodoWrite', { timedOut: true })).note);
  texts.push((await ask('WebFetch', {})).note);
  // a once grant waiting from an earlier approval
  const o = R.A.request({ company: CID, position: 'tax', sessionId: 's1', kind: 'tool', target: 'Glob', why: 'x' });
  await R.tick();
  R.cards.at(-1).answer({ behavior: 'allow', scope: 'once' });
  await o;
  texts.push((await R.A.request({ company: CID, position: 'tax', sessionId: 's1', kind: 'tool', target: 'Glob', why: 'x' })).note);
  const g = R.A.requestApproval({ kind: 'outward', sessionId: 's1', command: 'npm publish' });
  await R.tick();
  R.cards.at(-1).answer({ timedOut: true });
  texts.push((await g).message);
  const h = R.A.requestApproval({ kind: 'outward', sessionId: 's1', command: 'git push' });
  await R.tick();
  R.cards.at(-1).answer({});
  texts.push((await h).message);
  const c = R.A.request({ company: CID, position: 'tax', sessionId: 's1', kind: 'tool', target: 'Grep', why: 'x' });
  await R.tick();
  R.A.cancelFor('s1');
  texts.push((await c).note);
  R.A.stop();
  return texts;
}

test('owner name: notes and messages use ownerName; unset reads "the owner"; never a built-in name', async () => {
  const named = await ownerTexts('Jordan');
  assert.match(named[0], /^Jordan declined this request\..* Note from Jordan: "Use the notes\."$/);
  assert.match(named[1], /^Jordan did not answer in time\./);
  assert.equal(named[2], 'The card was closed before Jordan answered.');
  assert.match(named[3], /^Jordan already approved this once/);
  assert.equal(named[4], 'Jordan did not answer in time.');
  assert.equal(named[5], 'The card was closed before Jordan answered.');
  assert.equal(named[6], 'The chat ended before Jordan answered.');
  for (const src of [undefined, '', '   ', () => '', () => { throw new Error('x'); }]) {
    const plain = await ownerTexts(src);
    assert.match(plain[0], /^The owner declined this request\..* Note from the owner: "Use the notes\."$/);
    assert.match(plain[1], /^The owner did not answer in time\./);
    assert.equal(plain[2], 'The card was closed before the owner answered.');
    assert.match(plain[3], /^The owner already approved this once/);
    assert.equal(plain[4], 'The owner did not answer in time.');
    assert.equal(plain[6], 'The chat ended before the owner answered.');
  }
});

test('owner name: a getter is read per message, so a Settings change applies without a rebuild', async () => {
  let name = 'Jordan';
  const R = rig({ ownerName: () => name });
  const ask = async (target) => {
    const p = R.A.request({ company: CID, position: 'tax', sessionId: 's1', kind: 'tool', target, why: 'x' });
    await R.tick();
    R.cards.at(-1).answer({ timedOut: true });
    return (await p).note;
  };
  assert.match(await ask('WebSearch'), /^Jordan did not answer/);
  name = 'Alex  Kim\n<x>';
  assert.match(await ask('TodoWrite'), /^Alex Kim x did not answer/);
  name = '';
  assert.match(await ask('WebFetch'), /^The owner did not answer/);
  R.A.stop();
});

test('notify: an access card and an outward card each hand the session one built team notice (sent when the card shows)', async () => {
  const { normalizeNotice } = require('../../main/notify');
  const R = rig();
  const p = R.A.request({ company: CID, position: 'tax', sessionId: 's1', kind: 'tool', target: 'WebSearch', why: 'x' });
  await R.tick();
  let n = R.cards.map((c) => c.opts.notice);
  assert.equal(n.length, 1);
  assert.equal(R.events.filter(([ev]) => ev === 'notify').length, 0, 'access.js never sends it itself (no double notice)');
  assert.equal(n[0].source, 'team');
  assert.equal(n[0].sessionId, 's1');
  assert.deepEqual(n[0].team, { what: 'access', company: CID, position: 'tax', companyName: 'Acme', positionName: 'Tax Specialist', subject: null, action: null });
  assert.equal(n[0].title, 'Tax Specialist needs your OK', 'built by teamNotice, so the in-app toast has it too');
  assert.equal(n[0].body, 'Tax Specialist asks for the WebSearch tool · Acme');
  assert.equal(n[0].company, CID);
  assert.equal(n[0].view, undefined, 'a notice with a chat opens the chat');
  assert.deepEqual(normalizeNotice(n[0]), n[0], 'already in its final shape');
  R.cards[0].answer({ behavior: 'deny', message: 'no' });
  await p;
  const g = R.A.requestApproval({ kind: 'outward', sessionId: 's1', command: 'npm publish', what: ['npm publish'] });
  await R.tick();
  n = R.cards.map((c) => c.opts.notice);
  assert.equal(n.length, 2);
  assert.equal(n[1].team.what, 'outward');
  assert.equal(n[1].title, 'Tax Specialist needs your OK');
  assert.equal(n[1].body, 'npm publish · Acme');
  R.cards[1].answer({ timedOut: true });
  await g;
  R.A.stop();
});
