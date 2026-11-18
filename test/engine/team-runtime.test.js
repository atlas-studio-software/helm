'use strict';
// Positions runtime (main/engine/team/runtime.js; docs/POSITIONS.md sections 5 and 8.3) driven with a fake clock,
// fake Helm sessions and a fake team store: delivery (the owner first, the 90 s window, "Let it answer now"), sync budgets
// and chain clamps, pending and late answers, Stop, cycles, chain caps, 2 h expiry, restarts, order and the run cap,
// rollover, cancel / failure / interrupt, rate limits, the cross-talk log, the notebook echo and team.ask.updated.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, ROLL_PROMPT } = require('../../main/engine/team/runtime');

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN;
const T0 = new Date(2026, 10, 17, 10, 0, 0).getTime(); // local 10:00:00, a 5 s tick boundary
const CID = 'example-co';
const PENDING_NOTE = 'Tell the owner it is pending. The answer will arrive in this chat as a Helm message. Carry on.';
const PENDING_NOTE_POSITION = 'It is pending. The answer will arrive in your chat as a Helm message. Answer with what '
  + 'you have and say what is still pending; use ask_followup if the late answer changes what you said.';
const SHORT_BUDGET_NOTE = 'Too little time left in this chain to wait. Answer with what you have and say what is '
  + 'still pending. Helm will hand you the late answer; use ask_followup if it changes what you said.';

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
async function flush(n = 10) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

// ---------- fake clock: advance() runs due timers in time order, flushing promises between them ----------
function fakeClock(start = T0) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  const add = (fn, ms, every) => { const id = ++seq; timers.set(id, { id, at: t + Math.max(0, Number(ms) || 0), fn, every }); return id; };
  const clock = {
    now: () => t,
    setTimeout: (fn, ms) => add(fn, ms, 0),
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: (fn, ms) => add(fn, ms, Math.max(1, Number(ms) || 1)),
    clearInterval: (id) => { timers.delete(id); },
    async advance(ms) {
      if (ms < 0) throw new Error(`the fake clock cannot go back (${ms} ms)`);
      const end = t + ms;
      await flush();
      for (;;) {
        let next = null;
        for (const x of timers.values()) if (x.at <= end && (!next || x.at < next.at || (x.at === next.at && x.id < next.id))) next = x;
        if (!next) break;
        t = next.at;
        if (next.every) next.at += next.every; else timers.delete(next.id);
        next.fn();
        await flush();
      }
      t = end;
      await flush();
    },
    to: (abs) => clock.advance(abs - t),
  };
  return clock;
}

// ---------- fake EngineSession ----------
function makeSession(clock, id, position = null) {
  let n = 0;
  const es = {
    s: { id, status: 'idle', costUsd: 0, context: { percent: 5 }, ...(position ? { position } : {}) },
    turnActive: false, requests: new Map(), pendingQueue: [], turnWaiters: [], items: [], lastActiveAt: 0,
    sent: [], // every send() Helm made
    loadHops: 0, // > 0: ensureLoaded takes that many event-loop turns (transcript I/O), so a send is not instant
    async ensureLoaded() { for (let i = 0; i < es.loadHops; i++) await new Promise((r) => setImmediate(r)); },
    send({ text, origin, team }) {
      const item = { id: `${id}-i${++n}`, type: 'user', text, uuid: `${id}-u${n}`, origin, ...(team ? { team: clone(team) } : {}) };
      es.items.push(item);
      es.sent.push({ at: clock.now(), text, origin, team: clone(team), itemId: item.id, queued: es.turnActive });
      if (es.turnActive) { es.pendingQueue.push({ item }); return { itemId: item.id, queued: true }; }
      es.turnActive = true;
      es.s.status = 'working';
      return { itemId: item.id, queued: false };
    },
    reply(text, { interrupted = false, failed = false, error = null, costUsd = 0 } = {}) {
      if (text) es.items.push({ id: `${id}-i${++n}`, type: 'assistant', text });
      es.turnActive = false;
      es.s.status = 'idle';
      es.s.costUsd += costUsd;
      const list = es.turnWaiters;
      es.turnWaiters = [];
      for (const fn of list) fn({ interrupted, failed, error, result: null });
    },
    owenSays(text = 'A message from the owner') { // the owner sends: a turn of their own (no Helm waiter)
      es.lastActiveAt = clock.now();
      es.items.push({ id: `${id}-i${++n}`, type: 'user', text, uuid: `${id}-u${n}`, origin: 'owen' });
      es.turnActive = true;
      es.s.status = 'working';
    },
    owenTypes() { es.lastActiveAt = clock.now(); }, // a draft keystroke
  };
  return es;
}

// ---------- fake sessions port ----------
function fakeSessions(clock) {
  const all = new Map();
  const current = new Map();
  const chats = new Map();
  const port = {
    all, viewed: new Set(), cards: [], handoffs: [], ended: [],
    handoffImpl: async () => ({ text: 'Done: the review. In progress: none. Waiting on: none. Next: the Q1 check.' }),
    get: (sid) => all.get(sid) || null,
    current: (cid, pid) => current.get(`${cid}/${pid}`) || null,
    async open(cid, pid) {
      const k = `${cid}/${pid}`;
      let es = current.get(k);
      if (!es) {
        const n = (chats.get(k) || 0) + 1;
        chats.set(k, n);
        es = makeSession(clock, `${pid}-chat${n}`, { company: cid, id: pid, chat: n });
        all.set(es.s.id, es);
        current.set(k, es);
      }
      return es;
    },
    isViewed: (sid) => port.viewed.has(sid),
    addCard: (sid, item) => { port.cards.push({ sid, item: clone(item) }); },
    handoff: (es, prompt) => { port.handoffs.push({ sid: es.s.id, prompt, at: clock.now() }); return port.handoffImpl(es, prompt); },
    async endChat(args) {
      port.ended.push({ ...args, at: clock.now() });
      const k = `${args.company}/${args.position}`;
      const es = current.get(k);
      if (es && es.s.id === args.sessionId) { es.s.position.ended = true; current.delete(k); }
    },
    ceo(id) { const es = makeSession(clock, id); all.set(id, es); return es; },
  };
  return port;
}

// ---------- fake team store: legal > tax > payroll > state > county, plus four top-level positions ----------
const POSITIONS = [
  ['legal', 'Legal', null], ['tax', 'Tax Specialist', 'legal'], ['payroll', 'Payroll', 'tax'],
  ['state', 'State Filings', 'payroll'], ['county', 'County Filings', 'state'],
  ['marketing', 'Marketing', null], ['finance', 'Finance', null], ['ops', 'Ops', null], ['support', 'Support', null],
].map(([id, name, parent]) => ({ id, name, parent, status: 'active' }));

function fakeStore() {
  const positions = POSITIONS.map((p) => ({ ...p }));
  const lines = [];
  return {
    positions, lines,
    getCompany: (cid) => (cid === CID ? { id: CID, name: 'Example Co', folders: ['C:/Users/you/example-co'] } : null),
    listPositions: (cid) => (cid === CID ? positions.map((p) => ({ ...p })) : []),
    getPosition: (cid, pid) => { const p = cid === CID ? positions.find((x) => x.id === pid) : null; return p ? { ...p } : null; },
    append: (cid, log, line) => { lines.push({ cid, log, ...clone(line) }); },
    readLog: (cid, log, { since } = {}) => ({
      lines: lines.filter((l) => l.cid === cid && l.log === log && (since == null || Date.parse(l.at) >= since))
        .map(({ cid: _c, log: _l, ...rest }) => rest),
    }),
  };
}

function memState() {
  const m = new Map();
  return { m, get: (k) => clone(m.get(k)), set: (k, v) => { m.set(k, clone(v)); } };
}

// ---------- team.ask.updated payload check (every event of every test) ----------
const STATES = new Set(['asked', 'delivered', 'pending', 'answered', 'late', 'expired', 'cancelled']);
function checkPayload(p, bad) {
  const problems = [];
  for (const k of ['company', 'ticket', 'chainId', 'state', 'detail', 'from', 'to', 'toName', 'chain', 'sessionIds']) if (p[k] == null) problems.push(`missing ${k}`);
  if (!STATES.has(p.state)) problems.push(`state ${p.state}`);
  if (!p.from || !p.from.kind || !p.from.name) problems.push('from');
  if (!Array.isArray(p.chain) || !p.chain.some((x) => x.ticket === p.ticket)) problems.push('chain lacks the ticket');
  for (const x of Array.isArray(p.chain) ? p.chain : []) {
    if (!STATES.has(x.state)) problems.push(`chain state ${x.state}`);
    for (const k of ['ticket', 'to', 'name', 'state', 'detail', 'sinceMs']) if (x[k] == null) problems.push(`chain item missing ${k}`);
  }
  if (!Array.isArray(p.sessionIds)) problems.push('sessionIds');
  if (problems.length) bad.push({ ticket: p.ticket, state: p.state, problems });
}

function track(p, clock) {
  const r = { done: false, value: undefined, at: null };
  p.then((v) => { r.done = true; r.value = v; r.at = clock.now(); });
  return r;
}

function setup(o = {}) {
  const clock = o.clock || fakeClock();
  const store = o.store || fakeStore();
  const sessions = o.sessions || fakeSessions(clock);
  const state = o.state || memState();
  const events = [];
  const inbox = [];
  const bad = [];
  const settings = o.settings || {};
  const rt = createRuntime({
    store, sessions, state, clock, settings: () => settings,
    emit: (ev, p) => { events.push({ ev, p: clone(p), at: clock.now() }); if (ev === 'team.ask.updated') checkPayload(p, bad); },
    inbox: (cid, e) => { inbox.push({ cid, e: clone(e) }); },
    exists: (p) => !/missing/.test(String(p)),
    ...(o.rt || {}),
  });
  const ceo = sessions.all.get('ceo-1') || sessions.ceo('ceo-1');
  const h = {
    clock, store, sessions, state, rt, events, inbox, bad, settings, ceo,
    at: (s) => clock.to(T0 + s * SEC),
    chat: (pid) => sessions.open(CID, pid),
    track: (p) => track(p, clock),
    askCeo: (to, question, extra = {}) => rt.ask({ company: CID, from: { kind: 'ceo', sessionId: ceo.s.id }, to, kind: 'report', question, ...extra }),
    askFrom: (es, to, question, extra = {}) => rt.ask({ company: CID, from: { kind: 'position', id: es.s.position.id, sessionId: es.s.id }, to, kind: 'report', question, ...extra }),
    caller: (es) => (es === ceo ? { kind: 'ceo', sessionId: ceo.s.id, company: CID } : { kind: 'position', id: es.s.position.id, company: CID, sessionId: es.s.id }),
    async endTurn(es, text, info) { es.reply(text, info); await flush(); rt.noteTurnEnd(es.s.id); await flush(); },
    last: () => [...rt._internals.tickets.values()].at(-1),
    deadline: (id) => { const w = rt._internals.waiters.get(id); return w && w.size ? Math.max(...[...w].map((x) => x.deadline)) : null; },
    lines: (ticket) => store.lines.filter((l) => l.ticket === ticket),
    asks: (es) => es.sent.filter((x) => x.team && x.team.origin === 'ask'),
    answers: (es) => es.sent.filter((x) => x.team && x.team.origin === 'answer'),
    done() { rt.stop(); assert.deepEqual(bad, [], 'every team.ask.updated payload is well formed'); },
  };
  if (!o.noStart) rt.start();
  return h;
}

// =====================================================================================================
test('1. CEO asks Legal while it is free: a helm-ask turn, the answer in-call, nothing else shared', async () => {
  const h = setup();
  h.ceo.items.push({ id: 'c1', type: 'user', text: 'PRIVATE-CEO: the acquisition plan' }, { id: 'c2', type: 'assistant', text: 'PRIVATE-CEO notes' });
  const legal = await h.chat('legal');
  legal.items.push({ id: 'l1', type: 'user', text: 'PRIVATE-LEGAL: The owner draft' }, { id: 'l2', type: 'assistant', text: 'PRIVATE-LEGAL earlier reply' });
  const q = 'Does the new privacy page cover the crash-report upload added in 1.3.0?';
  const call = h.track(h.askCeo('legal', q));
  await flush();
  const t = h.last();
  assert.equal(h.asks(legal).length, 1);
  const d = h.asks(legal)[0];
  assert.equal(d.origin, 'helm');
  assert.deepEqual(d.team, { origin: 'ask', ask: { ticket: t.id, from: { kind: 'ceo', id: null, name: 'CEO (Example Co)' }, kind: 'report', handed: [] } });
  const lines = d.text.split('\n');
  assert.equal(lines[0], `<helm-ask ticket="${t.id}" from="CEO (Example Co)" kind="report" reply-by="${hhmm(T0 + 300 * SEC)}">`);
  assert.equal(lines[1], q);
  assert.equal(lines[2], '</helm-ask>');
  assert.match(lines[3], /^Answer this question in your reply\. Your final message is passed back to the CEO word for word; it sees nothing else of this chat or your notebook\./);
  assert.equal(lines.length, 4);
  assert.doesNotMatch(d.text, /PRIVATE/);
  assert.equal(h.rt.busyText(CID, 'legal'), 'answering CEO');

  // Legal works for 12 s: a progress line, a tool call, then its final reply
  await h.at(12);
  legal.items.push({ id: 'x1', type: 'assistant', text: 'PRIVATE-LEGAL: let me read the page first.' }, { id: 'x2', type: 'tool', name: 'Read' });
  assert.equal(call.done, false);
  await h.endTurn(legal, 'Yes: section 4 covers crash reports.');
  assert.equal(call.done, true);
  assert.equal(call.at, T0 + 12 * SEC);
  assert.deepEqual(call.value, { status: 'answered', ticket: t.id, from: 'legal', answer: 'Yes: section 4 covers crash reports.', took_s: 12, chain: [] });
  assert.doesNotMatch(call.value.answer, /PRIVATE/);
  assert.deepEqual(h.lines(t.id).map((l) => l.state), ['asked', 'delivered', 'answered']);
  const answered = h.lines(t.id)[2];
  assert.equal(answered.answer, 'Yes: section 4 covers crash reports.');
  assert.equal(answered.tookMs, 12 * SEC);
  assert.deepEqual(answered.from, { kind: 'ceo', sessionId: 'ceo-1' });
  assert.equal(h.lines(t.id)[0].question, q);
  assert.equal(h.rt.get(t.id).asker, 'received');
  await h.at(120);
  assert.equal(h.ceo.sent.length, 0, 'an in-call answer is never delivered again as a turn');
  assert.equal(h.rt._internals.outbox.length, 0);
  assert.equal(h.rt.busyText(CID, 'legal'), null);
  h.done();
});

test('2a. The owner typed in Legal\'s on-screen tab: nothing is sent for 89 s, then it is delivered at 90 s', async () => {
  const h = setup();
  const legal = await h.chat('legal');
  h.sessions.viewed.add(legal.s.id);
  legal.owenTypes();
  const call = h.track(h.askCeo('legal', 'Is the NDA with the vendor signed?', { waitS: 30 }));
  await h.at(30);
  assert.equal(call.done, true);
  assert.equal(call.value.status, 'pending');
  assert.equal(call.value.state, 'queued: The owner is talking with Legal');
  assert.deepEqual(h.rt.queued(CID, 'legal').map((x) => x.reason), ['The owner is talking with Legal']);
  await h.at(89);
  assert.equal(legal.sent.length, 0);
  await h.at(90);
  assert.equal(h.asks(legal).length, 1);
  assert.equal(h.asks(legal)[0].at, T0 + 90 * SEC);
  assert.doesNotMatch(h.asks(legal)[0].text, /reply-by=/, 'nobody waits in-call any more: no reply-by');
  h.done();
});

test('2b. The owner mid-turn: never sent during the turn, then only after the 90 s window since the last keystroke', async () => {
  const h = setup();
  const legal = await h.chat('legal');
  h.sessions.viewed.add(legal.s.id);
  legal.owenSays('Help me with the vendor contract');
  const call = h.track(h.askCeo('legal', 'Is the NDA signed?', { waitS: 600 }));
  const t = h.last();
  await h.at(100);
  assert.equal(legal.sent.length, 0, 'never while the turn runs, even after 90 s of quiet');
  assert.equal(h.rt.get(t.id).queueReason, 'Legal is busy');
  await h.at(150);
  legal.owenTypes(); // a draft keystroke at 150 s
  await h.at(155);
  assert.equal(h.rt.get(t.id).queueReason, 'The owner is talking with Legal');
  await h.at(200);
  await h.endTurn(legal, 'Here is the contract summary.');
  assert.equal(legal.sent.length, 0, 'the turn ended but the owner typed 50 s ago');
  await h.at(239);
  assert.equal(legal.sent.length, 0);
  await h.at(240);
  assert.equal(h.asks(legal).length, 1);
  assert.equal(h.asks(legal)[0].at, T0 + 240 * SEC);
  await h.at(250);
  await h.endTurn(legal, 'Yes, signed on 11-02.');
  assert.equal(call.value.status, 'answered');
  assert.ok(call.at <= T0 + 600 * SEC);
  h.done();
});

test('2c. release() delivers right after the owner\'s turn ends without the 90 s wait, and never during the turn', async () => {
  const h = setup();
  const legal = await h.chat('legal');
  h.sessions.viewed.add(legal.s.id);
  legal.owenSays('Draft a reply to the landlord');
  h.track(h.askCeo('legal', 'Is the NDA signed?', { waitS: 600 }));
  const t = h.last();
  await h.at(10);
  assert.deepEqual(h.rt.release(t.id), { state: 'queued' });
  await h.at(60);
  assert.equal(legal.sent.length, 0, 'release never interrupts a running turn');
  legal.owenTypes();
  await h.endTurn(legal, 'Draft attached.');
  assert.equal(h.asks(legal).length, 1);
  assert.equal(h.asks(legal)[0].at, T0 + 60 * SEC, 'delivered at once although the owner typed 0 s ago in the viewed tab');
  assert.deepEqual(h.rt.release(t.id), { state: 'delivered' });
  assert.deepEqual(h.rt.release('t_nope'), { state: 'unknown' });
  h.done();
});

test('3. Pending at exactly 30 s, then the late answer arrives as a helm-answer turn only when the CEO chat is free', async () => {
  const h = setup();
  const legal = await h.chat('legal');
  h.sessions.viewed.add(legal.s.id);
  legal.owenTypes();
  const call = h.track(h.askCeo('legal', 'Does the privacy page cover crash uploads?', { waitS: 30 }));
  const t = h.last();
  await h.clock.to(T0 + 30 * SEC - 1);
  assert.equal(call.done, false);
  await h.clock.to(T0 + 30 * SEC);
  assert.equal(call.done, true);
  assert.equal(call.at, T0 + 30 * SEC);
  assert.deepEqual(call.value, { status: 'pending', ticket: t.id, state: 'queued: The owner is talking with Legal', note: PENDING_NOTE });
  assert.deepEqual(await h.rt.ticket(t.id, { caller: h.caller(h.ceo) }), call.value, 'team_ticket gives the same pending result');
  await h.at(90);
  assert.equal(h.asks(legal).length, 1);
  await h.at(95);
  h.ceo.owenSays('Meanwhile, draft the launch post');
  await h.at(100);
  await h.endTurn(legal, 'Yes, section 4 covers crash uploads.');
  assert.equal(h.rt.get(t.id).state, 'answered');
  await h.at(200);
  assert.equal(h.ceo.sent.length, 0, 'never steered into the CEO\'s running turn');
  h.sessions.viewed.add(h.ceo.s.id);
  h.ceo.owenTypes();
  await h.endTurn(h.ceo, 'Here is the draft.');
  await h.at(214);
  assert.equal(h.ceo.sent.length, 0, 'The owner typed in the CEO tab under 15 s ago');
  await h.at(215);
  assert.equal(h.ceo.sent.length, 1);
  const m = h.ceo.sent[0];
  assert.equal(m.at, T0 + 215 * SEC);
  assert.equal(m.origin, 'helm');
  assert.deepEqual(m.team, { origin: 'answer', answer: { ticket: t.id, from: { id: 'legal', name: 'Legal' }, state: 'late' } });
  assert.equal(m.text, `<helm-answer ticket="${t.id}" from="Legal" state="answered">\nYes, section 4 covers crash uploads.\n</helm-answer>\n`
    + 'This answers your earlier team_ask, which returned pending. Tell the owner.');
  assert.deepEqual(h.lines(t.id).map((l) => l.state), ['asked', 'pending', 'delivered', 'answered']);
  await h.at(300);
  assert.equal(h.ceo.sent.length, 1, 'delivered once');
  h.done();
});

test('3b. The asker fetching the answer with team_ticket cancels the late-answer turn', async () => {
  const h = setup();
  const legal = await h.chat('legal');
  legal.owenSays();
  h.track(h.askCeo('legal', 'Is the NDA signed?', { waitS: 30 }));
  const t = h.last();
  await h.at(40);
  h.ceo.owenSays('Something else');
  await h.at(50);
  await h.endTurn(legal, 'The owner reply');
  assert.equal(h.asks(legal).length, 1);
  await h.at(60);
  await h.endTurn(legal, 'Signed.');
  assert.equal(h.rt._internals.outbox.length, 1);
  const r = await h.rt.ticket(t.id, { caller: h.caller(h.ceo) });
  assert.equal(r.status, 'answered');
  assert.equal(r.answer, 'Signed.');
  assert.equal(h.rt._internals.outbox.length, 0);
  await h.at(70);
  await h.endTurn(h.ceo, 'ok');
  await h.at(120);
  assert.equal(h.ceo.sent.length, 0);
  assert.deepEqual(await h.rt.ticket(t.id, { caller: { kind: 'position', id: 'marketing', company: CID } }), { status: 'refused', reason: 'That ticket is not yours or in your subtree.' });
  h.done();
});

test('4. Stop: the call returns, the ticket goes on, and the answer comes as an answer card with no turn', async () => {
  const h = setup();
  const legal = await h.chat('legal');
  const ac = new AbortController();
  const call = h.track(h.askCeo('legal', 'Review the refund terms.', { signal: ac.signal }));
  await flush();
  const t = h.last();
  assert.equal(h.asks(legal).length, 1);
  await h.at(10);
  ac.abort();
  await flush();
  assert.equal(call.done, true);
  assert.equal(call.at, T0 + 10 * SEC);
  assert.equal(call.value.status, 'pending');
  assert.equal(call.value.state, 'working 10s');
  assert.equal(h.rt.get(t.id).state, 'delivered');
  assert.equal(h.rt.get(t.id).asker, 'stopped');
  await h.at(60);
  await h.endTurn(legal, 'The refund terms are fine.');
  assert.equal(h.rt.get(t.id).state, 'answered');
  assert.deepEqual(h.sessions.cards, [{ sid: 'ceo-1', item: { type: 'team', kind: 'answer', answer: { ticket: t.id, from: { id: 'legal', name: 'Legal' }, text: 'The refund terms are fine.', state: 'late' } } }]);
  await h.at(300);
  assert.equal(h.ceo.sent.length, 0, 'no new turn in the CEO chat');
  assert.equal(h.rt._internals.outbox.length, 0);
  // the card's "Send to CEO"
  assert.deepEqual(h.rt.forward('ceo-1', t.id), { ok: true });
  await flush();
  assert.equal(h.answers(h.ceo).length, 1);
  assert.match(h.ceo.sent[0].text, /^<helm-answer ticket="[^"]+" from="Legal" state="answered">\nThe refund terms are fine\.\n<\/helm-answer>/);
  h.done();
});

test('5. Chain CEO > Legal > Tax > Payroll: budgets clamp, Tax returns pending at +145 s, late answer + ask_followup up', async () => {
  const h = setup();
  const legal = await h.chat('legal'), tax = await h.chat('tax'), payroll = await h.chat('payroll');
  const ceoCall = h.track(h.askCeo('legal', 'Is our payroll tax filing compliant?', { waitS: 300 }));
  await flush();
  const root = h.last();
  assert.equal(h.deadline(root.id), T0 + 300 * SEC);
  await h.at(10);
  const legalCall = h.track(h.askFrom(legal, 'tax', 'What did we file for Q3?'));
  await flush();
  const tTax = h.last();
  assert.equal(tTax.parentTicket, root.id);
  assert.equal(tTax.chain, root.id);
  assert.equal(h.deadline(tTax.id), T0 + 190 * SEC, 'min(180, 300 - 10 - 45) = 180 s');
  assert.equal(h.asks(tax).length, 1);
  assert.match(h.asks(tax)[0].text, new RegExp(`^<helm-ask ticket="${tTax.id}" from="Legal" kind="report" reply-by="${hhmm(T0 + 190 * SEC)}">`));
  assert.match(h.asks(tax)[0].text, /passed back to Legal word for word/);
  await h.at(20);
  const taxCall = h.track(h.askFrom(tax, 'payroll', 'Which states did payroll file in?'));
  await flush();
  const tPay = h.last();
  assert.equal(tPay.parentTicket, tTax.id);
  assert.equal(h.deadline(tPay.id), T0 + 145 * SEC, 'min(180, 190 - 20 - 45) = 125 s');
  assert.equal(h.asks(payroll).length, 1);
  await h.clock.to(T0 + 145 * SEC - 1);
  assert.equal(taxCall.done, false);
  await h.clock.to(T0 + 145 * SEC);
  assert.equal(taxCall.done, true);
  assert.deepEqual(taxCall.value, { status: 'pending', ticket: tPay.id, state: 'working 2m', note: PENDING_NOTE_POSITION });
  // the chain snapshot in the events covers all three tickets and all four chats
  const ev = h.events.filter((e) => e.ev === 'team.ask.updated' && e.p.ticket === tPay.id).at(-1).p;
  assert.deepEqual(ev.chain.map((x) => x.ticket), [root.id, tTax.id, tPay.id]);
  assert.deepEqual(ev.sessionIds.sort(), ['ceo-1', legal.s.id, payroll.s.id, tax.s.id].sort());

  // Tax answers Legal with what it has; Legal answers the CEO
  await h.at(150);
  await h.endTurn(tax, 'Q3 filed; the payroll states are still pending.');
  assert.deepEqual(legalCall.value, { status: 'answered', ticket: tTax.id, from: 'tax', answer: 'Q3 filed; the payroll states are still pending.', took_s: 140,
    chain: [{ ticket: tPay.id, to: 'payroll', name: 'Payroll', state: 'pending' }] });
  await h.at(160);
  await h.endTurn(legal, 'Compliant for Q3; the state detail is pending.');
  assert.equal(ceoCall.done, true);
  assert.ok(ceoCall.at <= T0 + 300 * SEC);
  assert.deepEqual(ceoCall.value, { status: 'answered', ticket: root.id, from: 'legal', answer: 'Compliant for Q3; the state detail is pending.', took_s: 160,
    chain: [{ ticket: tTax.id, to: 'tax', name: 'Tax Specialist', state: 'answered', took_s: 140, chain: [{ ticket: tPay.id, to: 'payroll', name: 'Payroll', state: 'pending' }] }] });

  // Payroll answers late: into Tax's chat, pointing at ask_followup
  await h.at(200);
  await h.endTurn(payroll, 'Payroll filed in CA and NV.');
  assert.equal(h.answers(tax).length, 1);
  const late = h.answers(tax)[0];
  assert.deepEqual(late.team, { origin: 'answer', answer: { ticket: tPay.id, from: { id: 'payroll', name: 'Payroll' }, state: 'late' } });
  assert.equal(late.text, `<helm-answer ticket="${tPay.id}" from="Payroll" state="answered">\nPayroll filed in CA and NV.\n</helm-answer>\n`
    + `You already answered Legal (ticket ${tTax.id}) without this. If it changes what you said, send the change with ask_followup({ ticket: "${tTax.id}", text }). If it changes nothing, reply in one line; nothing is sent.`);
  assert.equal(h.ceo.sent.length, 0);
  assert.equal(h.answers(legal).length, 0, 'Legal hears nothing until Tax follows up');

  // Tax passes it up; Legal's chat gets the addendum, then Legal passes it to the CEO
  assert.deepEqual(h.rt.followup({ ticket: tTax.id, text: 'Payroll filed in CA and NV.', caller: h.caller(tax) }), { status: 'sent', ticket: tTax.id });
  await flush();
  assert.equal(h.answers(legal).length, 1);
  const add = h.answers(legal)[0];
  assert.match(add.text, /^<helm-answer ticket="[^"]+" from="Tax Specialist" state="followup">\nTax Specialist adds \(from Payroll\): Payroll filed in CA and NV\.\n<\/helm-answer>/);
  assert.equal(add.team.answer.followup, true);
  await h.endTurn(tax, 'Sent the follow-up.');
  assert.deepEqual(h.rt.followup({ ticket: root.id, text: 'Payroll filed in CA and NV; still compliant.', caller: h.caller(legal) }), { status: 'sent', ticket: root.id });
  await flush();
  assert.equal(h.answers(h.ceo).length, 1);
  assert.match(h.ceo.sent[0].text, /Legal adds \(from Tax Specialist\): Payroll filed in CA and NV; still compliant\./);
  assert.match(h.ceo.sent[0].text, /Tell the owner what changed\.$/);
  // only the answerer may follow up
  assert.equal(h.rt.followup({ ticket: root.id, text: 'x', caller: h.caller(tax) }).status, 'refused');
  h.done();
});

test('5b. Nobody answers in the chain: every call returns pending inside its caller\'s wait, the CEO at exactly 300 s', async () => {
  const h = setup();
  const legal = await h.chat('legal'), tax = await h.chat('tax');
  await h.chat('payroll');
  const ceoCall = h.track(h.askCeo('legal', 'Is our payroll tax filing compliant?', { waitS: 300 }));
  await h.at(10);
  const legalCall = h.track(h.askFrom(legal, 'tax', 'What did we file for Q3?'));
  await h.at(20);
  const taxCall = h.track(h.askFrom(tax, 'payroll', 'Which states?'));
  const root = [...h.rt._internals.tickets.values()][0];
  const [, tTax, tPay] = [...h.rt._internals.tickets.values()];
  await h.at(145);
  assert.equal(taxCall.at, T0 + 145 * SEC);
  await h.at(190);
  assert.equal(legalCall.at, T0 + 190 * SEC);
  assert.deepEqual(legalCall.value, { status: 'pending', ticket: tTax.id, state: 'waiting on Payroll', where: 'Tax Specialist is waiting on Payroll (working 2m)', note: PENDING_NOTE_POSITION });
  await h.clock.to(T0 + 300 * SEC - 1);
  assert.equal(ceoCall.done, false);
  await h.clock.to(T0 + 300 * SEC);
  assert.equal(ceoCall.at, T0 + 300 * SEC);
  assert.deepEqual(ceoCall.value, { status: 'pending', ticket: root.id, state: 'waiting on Tax Specialist', where: 'Legal is waiting on Tax Specialist → Payroll (working 4m)', note: PENDING_NOTE });
  assert.equal(h.rt.get(tPay.id).state, 'delivered');
  h.done();
});

test('5c. Under 30 s left in the chain: the nested ask returns pending at once (exactly 30 s still waits)', async () => {
  const h = setup();
  const legal = await h.chat('legal'), tax = await h.chat('tax');
  const ceoCall = h.track(h.askCeo('legal', 'Quick check?', { waitS: 60 }));
  await h.at(10);
  const legalCall = h.track(h.askFrom(legal, 'tax', 'What did we file?'));
  const tTax = h.last();
  await flush();
  assert.equal(legalCall.done, true);
  assert.equal(legalCall.at, T0 + 10 * SEC);
  assert.deepEqual(legalCall.value, { status: 'pending', ticket: tTax.id, state: 'queued: waiting for Tax Specialist to be free', note: SHORT_BUDGET_NOTE });
  assert.equal(h.asks(tax).length, 1, 'the ticket still goes on');
  assert.doesNotMatch(h.asks(tax)[0].text, /reply-by=/);
  assert.deepEqual(h.lines(tTax.id).map((l) => l.state), ['asked', 'pending', 'delivered']);
  await h.at(60);
  assert.equal(ceoCall.at, T0 + 60 * SEC);
  assert.equal(ceoCall.value.status, 'pending');
  h.done();

  const h2 = setup();
  const legal2 = await h2.chat('legal');
  await h2.chat('tax');
  h2.track(h2.askCeo('legal', 'Quick check?', { waitS: 85 }));
  await h2.at(10);
  const c2 = h2.track(h2.askFrom(legal2, 'tax', 'What did we file?'));
  const t2 = h2.last();
  await flush();
  assert.equal(c2.done, false);
  assert.equal(h2.deadline(t2.id), T0 + 40 * SEC, '85 - 10 - 45 = 30 s is still a wait');
  await h2.at(40);
  assert.equal(c2.at, T0 + 40 * SEC);
  h2.done();
});

test('6. Cycles: in the chain, and across chains through the wait-for graph', async () => {
  const h = setup();
  const legal = await h.chat('legal'), tax = await h.chat('tax');
  h.track(h.askCeo('legal', 'Is the vendor contract tax-exempt?'));
  await flush();
  h.track(h.askFrom(legal, 'tax', 'Is the vendor tax-exempt?'));
  await flush();
  const tTax = h.last();
  assert.equal(h.asks(tax).length, 1);
  const r = await h.askFrom(tax, 'legal', 'Which clause applies?', { kind: 'colleague' });
  assert.deepEqual(r, { status: 'refused', reason: 'Legal is waiting on you. Answer with what you have.' });
  const line = h.store.lines.at(-1);
  assert.equal(line.state, 'refused');
  assert.equal(line.kind, 'colleague');
  assert.equal(line.parentTicket, tTax.id);
  assert.equal(line.reason, 'Legal is waiting on you. Answer with what you have.');
  h.done();

  // cross-chain: Legal (the owner's own chat) waits on Tax; Marketing (answering the CEO) waits on Legal; Tax asks Marketing
  const g = setup();
  const gl = await g.chat('legal'), gt = await g.chat('tax'), gm = await g.chat('marketing');
  gl.owenSays('Check the vendor contract with Tax');
  g.track(g.askFrom(gl, 'tax', 'Is the vendor contract tax-exempt?'));
  await flush();
  assert.equal(g.asks(gt).length, 1);
  g.track(g.askCeo('marketing', 'Can we run the promo in CA?'));
  await flush();
  assert.equal(g.asks(gm).length, 1);
  const mkt = g.track(g.askFrom(gm, 'legal', 'Is the promo legal in CA?', { kind: 'colleague' }));
  await flush();
  assert.equal(mkt.done, false, 'Marketing may ask Legal: it waits');
  assert.equal(g.last().state, 'queued');
  const es = g.rt._internals.edges(CID).map((e) => `${e.from}>${e.to}`).sort();
  assert.deepEqual(es, ['legal>tax', 'marketing>legal']);
  const r2 = await g.askFrom(gt, 'marketing', 'Is the promo budget deductible?', { kind: 'colleague' });
  assert.deepEqual(r2, { status: 'refused', reason: 'Marketing is waiting on you (through Legal). Answer with what you have.' });
  g.done();
});

test('7. A chain holds at most 8 tickets (depth 5 plus colleague detours); the 9th is refused', async () => {
  const h = setup({ settings: { maxConcurrentRuns: 20 } });
  const chat = {};
  for (const p of POSITIONS) chat[p.id] = await h.chat(p.id);
  h.track(h.askCeo('legal', 'Full compliance review?', { waitS: 600 }));
  await flush();
  const root = h.last();
  const hops = [['legal', 'tax', 'report'], ['tax', 'payroll', 'report'], ['payroll', 'state', 'report'], ['state', 'county', 'report'],
    ['county', 'marketing', 'colleague'], ['marketing', 'finance', 'colleague'], ['finance', 'ops', 'colleague']];
  for (const [i, [from, to, kind]] of hops.entries()) {
    const c = h.track(h.askFrom(chat[from], to, `Hop ${i + 2}: one question.`, { kind }));
    await flush();
    assert.notEqual(c.value && c.value.status, 'refused', `hop ${i + 2} (${from} > ${to}) is allowed`);
    const t = h.last();
    assert.equal(t.chain, root.id);
    assert.equal(h.asks(chat[to]).length, 1, `${to} got hop ${i + 2}`);
  }
  assert.equal(h.rt.list(CID).filter((t) => t.chain === root.id).length, 8);
  const ninth = await h.askFrom(chat.ops, 'support', 'Hop 9?', { kind: 'colleague' });
  assert.deepEqual(ninth, { status: 'refused', reason: 'Chain too long: at most 8 tickets in one chain. Answer with what you have.' });
  assert.equal(h.rt.list(CID).filter((t) => t.chain === root.id).length, 8);
  h.done();
});

test('8a. Expiry at 2 h while stuck behind the owner: withdrawn, and ONE expired helm-answer to the CEO', async () => {
  const h = setup();
  const legal = await h.chat('legal');
  legal.owenSays('A long working session');
  const call = h.track(h.askCeo('legal', 'Is the NDA signed?'));
  const t = h.last();
  await h.at(300);
  assert.equal(call.value.status, 'pending');
  await h.clock.to(T0 + 2 * HOUR - 5 * SEC);
  assert.equal(h.rt.get(t.id).state, 'queued');
  assert.equal(h.ceo.sent.length, 0);
  await h.clock.to(T0 + 2 * HOUR);
  const x = h.rt.get(t.id);
  assert.equal(x.state, 'expired');
  assert.equal(x.reason, 'No answer 2 h after it was asked (Legal: queued: Legal is busy). Withdrawn.');
  assert.equal(h.ceo.sent.length, 1);
  assert.equal(h.ceo.sent[0].text, `<helm-answer ticket="${t.id}" from="Legal" state="expired">\nNo answer 2 h after you asked. Where it stopped: Legal: queued: Legal is busy.\n</helm-answer>\nTell the owner.`);
  assert.deepEqual(h.ceo.sent[0].team, { origin: 'answer', answer: { ticket: t.id, from: { id: 'legal', name: 'Legal' }, state: 'expired' } });
  await h.endTurn(h.ceo, 'Told the owner.');
  await h.endTurn(legal, 'The owner\'s session ends.');
  await h.clock.to(T0 + 2 * HOUR + 10 * MIN);
  assert.equal(legal.sent.length, 0, 'withdrawn: never delivered');
  assert.equal(h.ceo.sent.length, 1, 'one expired message');
  assert.deepEqual(h.lines(t.id).map((l) => l.state), ['asked', 'pending', 'expired']);
  h.done();
});

test('8b. Expiry in a chain: Tax (queued) expires silently, Legal goes late, the CEO gets one expired note then the late answer', async () => {
  const h = setup();
  const legal = await h.chat('legal'), tax = await h.chat('tax');
  tax.owenSays('The owner works with Tax all afternoon');
  const ceoCall = h.track(h.askCeo('legal', 'Is the vendor contract tax-exempt?'));
  await flush();
  const root = h.last();
  assert.equal(h.asks(legal).length, 1);
  await h.at(10);
  const legalCall = h.track(h.askFrom(legal, 'tax', 'Is the vendor tax-exempt?'));
  const tTax = h.last();
  await h.at(300);
  assert.equal(legalCall.value.status, 'pending');
  assert.equal(ceoCall.value.status, 'pending');
  await h.clock.to(T0 + 2 * HOUR);
  assert.equal(h.rt.get(tTax.id).state, 'expired');
  assert.equal(h.rt.get(tTax.id).reason, 'Its chain expired 2 h after the first question.');
  assert.equal(h.rt.get(root.id).state, 'delivered');
  assert.equal(h.rt.get(root.id).late, true);
  assert.ok(h.events.some((e) => e.ev === 'team.ask.updated' && e.p.ticket === root.id && e.p.state === 'late'));
  assert.equal(h.ceo.sent.length, 1);
  assert.equal(h.ceo.sent[0].text, `<helm-answer ticket="${root.id}" from="Legal" state="expired">\nNo answer 2 h after you asked. Where it stopped: Legal is waiting on Tax Specialist (queued: Tax Specialist is busy). If an answer still comes, Helm delivers it here.\n</helm-answer>\nTell the owner.`);
  assert.equal(h.answers(legal).length, 0, 'Legal is not messaged about Tax\'s expiry');
  assert.equal(tax.sent.length, 0);
  await h.endTurn(h.ceo, 'Told the owner it expired.');
  await h.clock.to(T0 + 2 * HOUR + 10 * MIN);
  assert.equal(h.ceo.sent.length, 1, 'one expired message for the whole chain');
  await h.endTurn(legal, 'Without Tax: probably exempt; I will confirm.');
  assert.equal(h.rt.get(root.id).state, 'answered');
  assert.equal(h.ceo.sent.length, 2);
  assert.equal(h.ceo.sent[1].text, `<helm-answer ticket="${root.id}" from="Legal" state="late">\nWithout Tax: probably exempt; I will confirm.\n</helm-answer>\nThis answers your earlier team_ask, which returned pending. Tell the owner.`);
  assert.equal(h.ceo.sent[1].team.answer.state, 'late');
  assert.equal(h.answers(legal).length, 0);
  h.done();
});

test('9a. Restart while queued: the new runtime delivers it and the CEO gets the late answer as a turn', async () => {
  const clock = fakeClock(), sessions = fakeSessions(clock), state = memState(), store = fakeStore();
  const A = setup({ clock, sessions, state, store });
  const legal = await A.chat('legal');
  sessions.viewed.add(legal.s.id);
  legal.owenSays('The owner is mid-conversation');
  const call = A.track(A.askCeo('legal', 'Is the NDA signed?'));
  const id = A.last().id;
  await A.at(20);
  A.rt.stop();
  await flush();
  assert.equal(call.done, true);
  assert.equal(state.get('tickets')[0].asker, 'lost');
  assert.equal(state.get('tickets')[0].state, 'queued');
  A.done();
  const B = setup({ clock, sessions, state, store });
  await B.at(30);
  assert.equal(legal.sent.length, 0);
  await B.at(60);
  await B.endTurn(legal, 'The owner\'s reply');
  assert.equal(legal.sent.length, 0, 'The owner was active 60 s ago in the viewed tab');
  await B.at(90);
  assert.equal(B.asks(legal).length, 1);
  assert.match(B.asks(legal)[0].text, new RegExp(`^<helm-ask ticket="${id}" from="CEO \\(Example Co\\)" kind="report">`));
  await B.at(100);
  await B.endTurn(legal, 'Signed on 11-02.');
  assert.equal(B.answers(B.ceo).length, 1);
  assert.equal(B.ceo.sent[0].text, `<helm-answer ticket="${id}" from="Legal" state="answered">\nSigned on 11-02.\n</helm-answer>\nThis answers your earlier team_ask, which returned pending. Tell the owner.`);
  B.done();
});

test('9b. Restart while the answer turn still runs (broker kept it): the new runtime attaches and records the reply', async () => {
  const clock = fakeClock(), sessions = fakeSessions(clock), state = memState(), store = fakeStore();
  const A = setup({ clock, sessions, state, store });
  const legal = await A.chat('legal');
  A.track(A.askCeo('legal', 'Is the NDA signed?'));
  await flush();
  const id = A.last().id;
  assert.equal(A.asks(legal).length, 1);
  await A.at(30);
  A.done();
  legal.turnWaiters = []; // the old process's waiter died with it
  const B = setup({ clock, sessions, state, store });
  await flush();
  assert.equal(legal.turnWaiters.length, 1, 'attached to the running turn');
  assert.equal(B.asks(legal).length, 1, 'not sent again');
  await B.at(50);
  await B.endTurn(legal, 'Recorded after the restart.');
  assert.equal(B.rt.get(id).state, 'answered');
  assert.equal(B.rt.get(id).answer, 'Recorded after the restart.');
  assert.equal(B.answers(B.ceo).length, 1);
  assert.match(B.ceo.sent[0].text, /\nRecorded after the restart\.\n/);
  B.done();
});

test('9c. Restart after the answer turn ended while Helm was down: settled from the transcript (matched by uuid)', async () => {
  const clock = fakeClock(), sessions = fakeSessions(clock), state = memState(), store = fakeStore();
  const A = setup({ clock, sessions, state, store });
  const legal = await A.chat('legal');
  A.track(A.askCeo('legal', 'Is the NDA signed?'));
  await flush();
  const id = A.last().id;
  const itemId = A.asks(legal)[0].itemId;
  await A.at(30);
  A.done();
  legal.reply('Answered while Helm was down.');
  await flush();
  assert.equal(A.rt.get(id).state, 'delivered', 'a turn end seen while quitting is not an answer');
  legal.items.find((x) => x.id === itemId).id = 'reloaded-7'; // the reloaded transcript has new item ids, same uuid
  const B = setup({ clock, sessions, state, store });
  await flush();
  assert.equal(B.rt.get(id).state, 'answered');
  assert.equal(B.rt.get(id).answer, 'Answered while Helm was down.');
  assert.equal(B.asks(legal).length, 1);
  assert.equal(B.answers(B.ceo).length, 1);
  B.done();
});

test('9d. Restart after the answer turn was cut off before its chat recorded the question: re-delivered with "Asked again"', async () => {
  const clock = fakeClock(), sessions = fakeSessions(clock), state = memState(), store = fakeStore();
  const A = setup({ clock, sessions, state, store });
  const legal = await A.chat('legal');
  A.track(A.askCeo('legal', 'Is the NDA signed?'));
  await flush();
  const id = A.last().id;
  await A.at(30);
  A.done();
  legal.turnActive = false; // the CLI died with Helm: no reply text
  legal.s.status = 'idle';
  legal.turnWaiters = [];
  legal.items = legal.items.filter((x) => x.uuid !== A.rt.get(id).delivery.uuid); // its transcript never got the question
  const B = setup({ clock, sessions, state, store });
  await flush();
  assert.equal(B.asks(legal).length, 2);
  const again = B.asks(legal)[1].text;
  assert.ok(again.startsWith(`(Asked again: Helm restarted before your answer was recorded.)\n<helm-ask ticket="${id}" from="CEO (Example Co)" kind="report">`), again);
  assert.ok(B.lines(id).some((l) => l.state === 'asked' && l.reason === 're-queued: Helm restarted before the answer was recorded'));
  await B.at(40);
  await B.endTurn(legal, 'Signed.');
  assert.equal(B.rt.get(id).state, 'answered');
  assert.equal(B.answers(B.ceo).length, 1);
  B.done();
});

// Keep sessions running through a restart, Positions: the CEO's CLI was kept, still inside its team_ask, and the
// broker re-delivers that unanswered call to the new Helm with the same tool_use id.
test('9f. Kept CEO chat: the re-delivered team_ask (same tool call) takes up its ticket, waits to the original deadline, answers in-call', async () => {
  const clock = fakeClock(), sessions = fakeSessions(clock), state = memState(), store = fakeStore();
  const A = setup({ clock, sessions, state, store });
  const legal = await A.chat('legal');
  A.track(A.askCeo('legal', 'Is the NDA signed?', { toolUseId: 'toolu_ask1' }));
  await flush();
  const id = A.last().id;
  assert.equal(A.rt.get(id).waitUntil, T0 + 300 * SEC, 'the deadline of the in-call wait is kept on the ticket');
  await A.at(30);
  A.done();
  assert.equal(clone(state.get('tickets')).find((t) => t.id === id).asker, 'lost', 'a live wait is saved as lost');
  legal.turnWaiters = []; // the answer turn runs on in the broker
  A.ceo.turnActive = true; // and so does the CEO's turn, inside its tool call
  // the next Helm: the layer is prepared (tickets loaded) but not running while the re-attach pass runs
  const B = setup({ clock, sessions, state, store, noStart: true });
  B.rt.prime();
  const n = B.rt._internals.tickets.size;
  const call = B.track(B.askCeo('legal', 'Is the NDA signed?', { toolUseId: 'toolu_ask1' }));
  await flush();
  assert.equal(B.rt._internals.tickets.size, n, 'no second ticket');
  assert.equal(B.rt.get(id).asker, 'waiting');
  assert.equal(B.deadline(id), T0 + 300 * SEC, 'waits only to the original deadline');
  B.rt.start();
  await flush();
  assert.equal(legal.turnWaiters.length, 1, 'recovery attached to the answer turn that survived');
  assert.equal(B.asks(legal).length, 1, 'never asked twice');
  await B.at(50);
  await B.endTurn(legal, 'Signed on Friday.');
  assert.equal(call.done, true);
  assert.equal(call.value.status, 'answered');
  assert.equal(call.value.answer, 'Signed on Friday.');
  assert.equal(B.rt.get(id).asker, 'received');
  B.ceo.turnActive = false;
  await B.at(200);
  assert.equal(B.answers(B.ceo).length, 0, 'no late-answer turn: it was answered in the same call');
  assert.equal(B.rt._internals.outbox.length, 0);
  // another tool call (or another asker) with the same question is a new ask
  B.track(B.askCeo('legal', 'Is the NDA signed?', { toolUseId: 'toolu_other' }));
  await flush();
  assert.equal(B.rt._internals.tickets.size, n + 1);
  B.done();
});

test('9g. Kept CEO chat: answered while Helm was away -> the re-delivered call gets the answer and the late-answer turn is dropped', async () => {
  const clock = fakeClock(), sessions = fakeSessions(clock), state = memState(), store = fakeStore();
  const A = setup({ clock, sessions, state, store });
  const legal = await A.chat('legal');
  A.track(A.askCeo('legal', 'Is the NDA signed?', { toolUseId: 'toolu_ask2' }));
  await flush();
  const id = A.last().id;
  await A.at(30);
  A.done();
  legal.turnWaiters = [];
  A.ceo.turnActive = true;
  const B = setup({ clock, sessions, state, store });
  await flush();
  await B.at(40);
  await B.endTurn(legal, 'Yes, signed.'); // the answer turn ends before the CEO's call is re-delivered
  assert.equal(B.rt.get(id).state, 'answered');
  assert.equal(B.rt._internals.outbox.length, 1, 'queued as a late answer (the asker was lost)');
  assert.equal(B.answers(B.ceo).length, 0, 'not while the CEO chat is in its turn');
  const call = B.track(B.askCeo('legal', 'Is the NDA signed?', { toolUseId: 'toolu_ask2' }));
  await flush();
  assert.equal(call.done, true);
  assert.equal(call.value.status, 'answered');
  assert.equal(call.value.answer, 'Yes, signed.');
  assert.equal(B.rt.get(id).asker, 'received');
  assert.equal(B.rt._internals.outbox.length, 0, 'the late answer is dropped');
  B.ceo.turnActive = false;
  await B.at(120);
  assert.equal(B.answers(B.ceo).length, 0, 'never delivered twice');
  B.done();
});

test('9h. Kept CEO chat: the original deadline passed while Helm was away -> pending at once; the answer comes late as before', async () => {
  const clock = fakeClock(), sessions = fakeSessions(clock), state = memState(), store = fakeStore();
  const A = setup({ clock, sessions, state, store });
  const legal = await A.chat('legal');
  A.track(A.askCeo('legal', 'Is the NDA signed?', { toolUseId: 'toolu_ask3', waitS: 60 }));
  await flush();
  const id = A.last().id;
  await A.at(30);
  A.done();
  legal.turnWaiters = [];
  const B = setup({ clock, sessions, state, store });
  await B.at(90);
  const call = B.track(B.askCeo('legal', 'Is the NDA signed?', { toolUseId: 'toolu_ask3', waitS: 60 }));
  await flush();
  assert.equal(call.done, true);
  assert.equal(call.value.status, 'pending');
  assert.equal(B.rt.get(id).asker, 'pending');
  await B.at(100);
  await B.endTurn(legal, 'Signed.');
  await B.at(110);
  assert.equal(B.answers(B.ceo).length, 1, 'the late answer as a turn');
  B.done();
});

// Keep sessions running off (or a CLI that could not be kept): the restart ends the CEO's CLI inside its team_ask and
// the position's CLI mid-answer. Before the fix the position got the question twice: recovery re-queued the ticket
// and delivered a second full copy ("Asked again"), and a CEO continued after the restart that called team_ask again
// (a new tool call id) opened a second ticket for the same question.
test('9i. Restart without keep: the cut-off answer is resumed, never a second copy; the CEO asking the same open question again re-joins its ticket', async () => {
  const clock = fakeClock(), sessions = fakeSessions(clock), state = memState(), store = fakeStore();
  const A = setup({ clock, sessions, state, store });
  const legal = await A.chat('legal');
  const q = 'Is the NDA signed? Read the trail in your workspace first.';
  A.track(A.askCeo('legal', q, { toolUseId: 'toolu_a1', waitS: 240 }));
  await flush();
  const id = A.last().id;
  assert.equal(A.asks(legal).length, 1);
  await A.at(30);
  A.done();
  // nothing was kept: both CLIs ended with the old Helm, the position before it answered
  legal.turnActive = false;
  legal.s.status = 'idle';
  legal.turnWaiters = [];
  A.ceo.turnActive = false;
  const B = setup({ clock, sessions, state, store });
  await flush();
  const copies = () => legal.sent.filter((x) => x.text.includes(q)).length;
  assert.equal(copies(), 1, 'the question reached the position once');
  assert.equal(B.asks(legal).length, 2, 'the cut-off answer turn is resumed in its chat');
  const resume = B.asks(legal)[1];
  assert.equal(resume.origin, 'helm');
  assert.deepEqual(resume.team, { origin: 'ask', ask: { ticket: id, from: { kind: 'ceo', id: null, name: 'CEO (Example Co)' }, kind: 'report', handed: [], resume: true } });
  assert.match(resume.text, new RegExp(`^<helm-ask ticket="${id}" from="CEO \\(Example Co\\)" kind="report" resume="restart">\\n`));
  assert.match(resume.text, /The question is above in this chat/);
  assert.equal(B.rt.get(id).state, 'delivered');
  assert.ok(B.lines(id).some((l) => l.state === 'asked' && l.reason === 're-queued to resume: Helm restarted before the answer was recorded'));
  assert.ok(B.lines(id).some((l) => l.state === 'delivered' && l.resumed === true));

  // the CEO is continued after the restart and calls team_ask again: a new tool call for the same open question
  const n = B.rt._internals.tickets.size;
  await B.at(45);
  const call = B.track(B.askCeo('legal', `  ${q}\n`, { toolUseId: 'toolu_b1', waitS: 240 }));
  await flush();
  assert.equal(call.done, false, 'it waits in-call');
  assert.equal(B.rt._internals.tickets.size, n, 'no second ticket');
  assert.equal(B.rt.get(id).asker, 'waiting');
  assert.equal(B.rt.get(id).toolUseId, 'toolu_b1', 'events patch the new tool item');
  assert.equal(B.deadline(id), T0 + 285 * SEC, 'the new call waits its own wait_s');
  assert.equal(copies(), 1, 'still asked once');
  await B.at(60);
  await B.endTurn(legal, 'Signed.');
  assert.equal(call.done, true);
  assert.equal(call.value.status, 'answered');
  assert.equal(call.value.ticket, id);
  assert.equal(call.value.answer, 'Signed.');
  assert.equal(B.rt.get(id).asker, 'received');
  await B.at(120);
  assert.equal(B.answers(B.ceo).length, 0, 'answered in-call: no late-answer turn');
  assert.equal(copies(), 1);
  B.done();
});

test('9j. Restart without keep: a chat that rolled over meanwhile gets the question in full; a settled ticket, another question or another asker is asked as today', async () => {
  const clock = fakeClock(), sessions = fakeSessions(clock), state = memState(), store = fakeStore();
  const A = setup({ clock, sessions, state, store });
  const legal = await A.chat('legal');
  const q = 'Is the NDA signed?';
  A.track(A.askCeo('legal', q, { toolUseId: 'toolu_a1' }));
  await flush();
  const id = A.last().id;
  await A.at(30);
  A.done();
  legal.turnActive = false;
  legal.s.status = 'idle';
  legal.turnWaiters = [];
  await sessions.endChat({ company: CID, position: 'legal', sessionId: legal.s.id }); // its next chat never saw the question
  const B = setup({ clock, sessions, state, store });
  await flush();
  const legal2 = sessions.current(CID, 'legal');
  assert.notEqual(legal2, legal);
  assert.equal(B.asks(legal2).length, 1);
  assert.ok(B.asks(legal2)[0].text.startsWith(`(Asked again: Helm restarted before your answer was recorded.)\n<helm-ask ticket="${id}"`), B.asks(legal2)[0].text);
  assert.ok(B.asks(legal2)[0].text.includes(q));
  assert.equal(B.asks(legal2)[0].team.ask.resume, undefined);
  await B.at(40);
  await B.endTurn(legal2, 'Signed.');
  assert.equal(B.rt.get(id).state, 'answered');
  // settled: asking the same question again is a new ticket, as today (the late answer still comes)
  const n = B.rt._internals.tickets.size;
  B.track(B.askCeo('legal', q, { toolUseId: 'toolu_b1' }));
  await flush();
  assert.equal(B.rt._internals.tickets.size, n + 1);
  assert.notEqual(B.last().id, id);
  assert.equal(B.asks(legal2).length, 2);
  await B.endTurn(legal2, 'Still signed.');
  await B.at(60);
  assert.equal(B.answers(B.ceo).length, 1, 'the late answer of the first ticket');
  B.done();

  // an open lost ticket is re-joined only by its own asker, for the same target and the same question
  const C = setup({ clock, sessions, state, store, noStart: true });
  C.rt.prime();
  const t = [...C.rt._internals.tickets.values()].find((x) => x.id === id);
  Object.assign(t, { state: 'delivered', asker: 'lost', delivery: { sessionId: legal2.s.id, itemId: null, uuid: null } });
  delete t.settledAt;
  const m = C.rt._internals.tickets.size;
  sessions.ceo('ceo-2');
  C.track(C.rt.ask({ company: CID, from: { kind: 'ceo', sessionId: 'ceo-2' }, to: 'legal', kind: 'report', question: q }));
  C.track(C.askCeo('legal', 'Is the NDA signed by both sides?'));
  C.track(C.askCeo('finance', q));
  await flush();
  assert.equal(C.rt._internals.tickets.size, m + 3, 'another asker, another question, another target: new tickets');
  assert.equal(C.rt.get(id).asker, 'lost');
  C.done();
});

// Measured live (tools/team-keep-live.js --no-keep): a CLI told to close rejects its pending tool call ("STOP what you
// are doing and wait") and the model may still reply to that before the CLI exits. The chat's restart note says the
// shutdown cut that turn off, so its last words are not the answer.
test('9l. Restart without keep: a reply the cut-off turn wrote as Helm closed is not the answer; the turn is resumed, and resumed again if that turn fails', async () => {
  const clock = fakeClock(), sessions = fakeSessions(clock), state = memState(), store = fakeStore();
  const A = setup({ clock, sessions, state, store });
  const legal = await A.chat('legal');
  const q = 'What is the ledger code? Follow the trail.';
  A.track(A.askCeo('legal', q, { toolUseId: 'toolu_a1' }));
  await flush();
  const id = A.last().id;
  await A.at(30);
  A.done();
  legal.items.push({ id: 'l-read', type: 'tool', name: 'Read', status: 'error' },
    { id: 'l-stop', type: 'assistant', text: 'My read was rejected; I will stop and wait for instructions.' });
  legal.reply(null);
  legal.turnWaiters = [];
  legal.s.restartNote = { at: clock.now(), cause: 'restart', working: true, waiting: false, agents: [], tasks: [], shells: 0, queued: 0 };
  const B = setup({ clock, sessions, state, store });
  await flush();
  assert.equal(B.rt.get(id).state, 'delivered', 'not settled with the stop reply');
  assert.equal(legal.sent.filter((x) => x.text.includes(q)).length, 1, 'the question reached the position once');
  assert.equal(B.asks(legal).length, 2);
  assert.equal(B.asks(legal)[1].team.ask.resume, true);
  // the resumed turn fails at once (measured live: the new CLI exited while the old Helm's CLI was still closing):
  // resumed again, still no second copy of the question
  legal.reply(null, { failed: true, error: 'Claude Code process exited with code 1' });
  await flush();
  await B.at(40);
  assert.equal(B.asks(legal).length, 3);
  assert.equal(B.asks(legal)[2].team.ask.resume, true);
  assert.equal(legal.sent.filter((x) => x.text.includes(q)).length, 1, 'still asked once');
  assert.equal(B.rt.get(id).state, 'delivered');
  await B.at(45);
  await B.endTurn(legal, 'LEDGER-42');
  assert.equal(B.rt.get(id).state, 'answered');
  assert.equal(B.rt.get(id).answer, 'LEDGER-42');
  await B.at(60);
  assert.equal(B.answers(B.ceo).length, 1, 'one late answer, with the real answer');
  assert.match(B.answers(B.ceo)[0].text, /LEDGER-42/);
  B.done();
});

test('9k. Restart without keep mid duty run: the run is resumed in its chat (a note, not the duty text again); its result is recorded', async () => {
  const clock = fakeClock(), sessions = fakeSessions(clock), state = memState(), store = fakeStore();
  const A = setup({ clock, sessions, state, store });
  const legal = await A.chat('legal');
  const run = A.rt.runDuty({ company: CID, position: 'legal', duty: { id: 'weekly', title: 'Weekly check', trigger: { kind: 'schedule' } }, text: 'Run the weekly check.' });
  await flush();
  assert.equal(legal.sent.length, 1);
  await A.at(30);
  A.done();
  legal.turnActive = false;
  legal.s.status = 'idle';
  legal.turnWaiters = [];
  const B = setup({ clock, sessions, state, store });
  const done = B.rt.resumeRun(run.ticket);
  await flush();
  assert.equal(legal.sent.length, 2);
  assert.equal(legal.sent[1].text, '(Helm restarted before this run finished. The run is above in this chat: carry on from where you left off, without starting over. A tool call rejected or interrupted as Helm closed was not refused: make it again.)');
  assert.equal(legal.sent[1].team.duty.resume, true);
  assert.equal(legal.sent.filter((x) => x.text.includes('Run the weekly check.')).length, 1, 'the duty text went in once');
  await B.endTurn(legal, 'Weekly check done.');
  assert.deepEqual(await done, { state: 'done', finalText: 'Weekly check done.', reported: false, costUsd: 0 });
  B.done();
});

test('10a. Order behind the owner: report, then colleague, then duty; runDuty resolves done with the final text', async () => {
  const h = setup();
  const legal = await h.chat('legal'), mkt = await h.chat('marketing');
  legal.owenSays('The owner first');
  const duty = h.rt.runDuty({ company: CID, position: 'legal', duty: { id: 'weekly', title: 'Weekly contract check' }, text: 'Run the weekly contract check.' });
  await h.at(1);
  const colleague = h.track(h.askFrom(mkt, 'legal', 'Can we say "best price" in the ad?', { kind: 'colleague', waitS: 600 }));
  await h.at(2);
  const report = h.track(h.askCeo('legal', 'Is the NDA signed?', { waitS: 600 }));
  await h.at(10);
  assert.equal(legal.sent.length, 0);
  assert.equal(h.rt.busyText(CID, 'legal'), null);
  await h.endTurn(legal, 'The owner\'s answer');
  assert.equal(legal.sent.length, 1);
  assert.equal(legal.sent[0].team.ask.kind, 'report');
  assert.match(legal.sent[0].text, /Is the NDA signed\?/);
  await h.at(20);
  await h.endTurn(legal, 'NDA signed.');
  assert.equal(report.value.status, 'answered');
  assert.equal(legal.sent.length, 2);
  assert.match(legal.sent[1].text, /^<helm-ask ticket="[^"]+" from="Marketing" kind="colleague" reply-by="/);
  assert.match(legal.sent[1].text, /It is a colleague's one narrow question: answer only it\./);
  await h.at(30);
  await h.endTurn(legal, 'No: avoid "best price".');
  assert.equal(colleague.value.status, 'answered');
  assert.equal(legal.sent.length, 3);
  const d = legal.sent[2];
  assert.equal(d.text, 'Run the weekly contract check.');
  assert.deepEqual(d.team, { origin: 'duty', duty: { id: 'weekly', title: 'Weekly contract check', trigger: null }, ticket: duty.ticket });
  assert.equal(h.rt.busyText(CID, 'legal'), 'running duty Weekly contract check');
  assert.equal(h.rt.noteDutyReport(legal.s.id), duty.ticket);
  await h.at(40);
  await h.endTurn(legal, 'Checked: all fine.', { costUsd: 0.12 });
  assert.deepEqual(await duty.done, { state: 'done', finalText: 'Checked: all fine.', reported: true, costUsd: 0.12 });
  assert.equal(h.ceo.sent.length + mkt.sent.length, 0);
  h.done();
});

test('10b. Run cap 2: a third position waits for a free slot; a turn blocked on its own sub-ask does not count', async () => {
  const h = setup();
  const legal = await h.chat('legal'), mkt = await h.chat('marketing'), fin = await h.chat('finance'), tax = await h.chat('tax');
  h.track(h.askCeo('legal', 'L?', { waitS: 600 }));
  h.track(h.askCeo('marketing', 'M?', { waitS: 600 }));
  await flush();
  assert.equal(h.asks(legal).length + h.asks(mkt).length, 2);
  // Legal blocks in-call on Tax: its slot passes to Tax although two position turns are running
  const sub = h.track(h.askFrom(legal, 'tax', 'T?'));
  await flush();
  assert.equal(h.asks(tax).length, 1);
  h.track(h.askCeo('finance', 'F?', { waitS: 600 }));
  const tFin = h.last();
  await h.at(5);
  assert.equal(h.asks(fin).length, 0);
  assert.equal(h.rt.get(tFin.id).queueReason, 'waiting for a free slot (2 positions running)');
  // Tax answers: Legal is unblocked and counts again, so Finance still waits
  await h.endTurn(tax, 'T.');
  assert.equal(sub.value.status, 'answered');
  await h.at(10);
  assert.equal(h.asks(fin).length, 0);
  // "Let it answer now" skips the cap
  h.rt.release(tFin.id);
  await flush();
  assert.equal(h.asks(fin).length, 1);
  h.done();

  const g = setup();
  const gl = await g.chat('legal'), gm = await g.chat('marketing'), gf = await g.chat('finance');
  for (const es of [gl, gm, gf]) es.loadHops = 3; // three asks in one go while the first sends are still in flight
  g.track(g.askCeo('legal', 'L?', { waitS: 600 }));
  g.track(g.askCeo('marketing', 'M?', { waitS: 600 }));
  g.track(g.askCeo('finance', 'F?', { waitS: 600 }));
  await g.at(5);
  assert.equal(g.asks(gf).length, 0);
  await g.endTurn(gm, 'M.');
  assert.equal(g.asks(gf).length, 1, 'a slot freed: Finance goes');
  assert.equal(g.asks(gl).length, 1);
  g.done();
});

test('11a. Soft roll at 33%: only after the owner is away 120 s; an ask during the roll waits and goes to the NEW chat', async () => {
  const h = setup();
  const legal = await h.chat('legal');
  let finishHandoff;
  h.sessions.handoffImpl = () => new Promise((r) => { finishHandoff = r; });
  legal.owenSays('Keep going on the contract');
  legal.s.context.percent = 33;
  await h.at(30);
  await h.endTurn(legal, 'Done with that part.');
  assert.equal(h.sessions.handoffs.length, 0);
  await h.at(115);
  assert.equal(h.sessions.handoffs.length, 0, 'The owner was here under 120 s ago');
  await h.at(120);
  assert.equal(h.sessions.handoffs.length, 1);
  assert.deepEqual(h.sessions.handoffs[0], { sid: legal.s.id, prompt: ROLL_PROMPT, at: T0 + 120 * SEC });
  assert.equal(h.rt.busyText(CID, 'legal'), 'starting a fresh chat');
  const call = h.track(h.askCeo('legal', 'Is the NDA signed?', { waitS: 30 }));
  await h.at(150);
  assert.deepEqual(call.value && call.value.state, 'queued: Legal is starting a fresh chat');
  assert.equal(legal.sent.length, 0);
  finishHandoff({ text: 'Done: contract review. In progress: none. Waiting on: none. Next: NDA.' });
  await flush();
  assert.deepEqual(h.sessions.ended.map(({ at, ...x }) => x), [{ company: CID, position: 'legal', sessionId: legal.s.id,
    handoff: 'Done: contract review. In progress: none. Waiting on: none. Next: NDA.', error: null, contextPct: 33, reason: 'full' }]);
  const fresh = h.sessions.current(CID, 'legal');
  assert.equal(fresh.s.id, 'legal-chat2');
  assert.equal(h.asks(fresh).length, 1, 'delivered into the new chat');
  assert.equal(legal.sent.length, 0);
  assert.deepEqual(h.inbox, []);
  assert.ok(h.events.some((e) => e.ev === 'team.updated' && e.p.company === CID));
  h.done();
});

test('11b. Soft roll waits for no pending request and no queued owner message', async () => {
  const h = setup();
  const legal = await h.chat('legal');
  legal.owenSays('Long chat');
  legal.s.context.percent = 35;
  await h.at(30);
  await h.endTurn(legal, 'ok');
  legal.requests.set('perm-1', { tool: 'Bash' });
  await h.at(150);
  assert.equal(h.sessions.handoffs.length, 0, 'a permission request is open');
  legal.requests.clear();
  legal.pendingQueue.push({ item: { id: 'q1', text: 'The owner queued this' } });
  await h.at(160);
  assert.equal(h.sessions.handoffs.length, 0, 'The owner has a queued message');
  legal.pendingQueue = [];
  await h.at(165);
  assert.equal(h.sessions.handoffs.length, 1);
  h.done();
});

test('11c. Hard roll at 41%: as soon as the turn ends, even with the tab viewed and the owner active', async () => {
  const h = setup();
  const legal = await h.chat('legal');
  h.sessions.viewed.add(legal.s.id);
  legal.s.context.percent = 41;
  const call = h.track(h.askCeo('legal', 'Is the NDA signed?'));
  await flush();
  assert.equal(h.asks(legal).length, 1);
  await h.at(5);
  legal.owenTypes();
  await h.endTurn(legal, 'Signed.');
  assert.equal(call.value.status, 'answered');
  assert.equal(h.sessions.handoffs.length, 1);
  assert.equal(h.sessions.handoffs[0].at, T0 + 5 * SEC);
  assert.equal(h.sessions.ended.length, 1);
  assert.equal(h.sessions.ended[0].contextPct, 41);
  // fix 12: the next chat opens at once for its "Fresh chat started" notice (a Helm item); no message is sent to it
  const fresh = h.sessions.current(CID, 'legal');
  assert.equal(fresh.s.id, 'legal-chat2');
  assert.equal(fresh.sent.length, 0);
  assert.deepEqual(h.sessions.cards, [{ sid: 'legal-chat2', item: { type: 'team', kind: 'notice', text: 'Fresh chat started (chat 2); the handoff and notebook carried over.' } }]);
  h.done();
});

test('11d. Handoff failing twice: endChat with "handoff failed" and an inbox line; failing once is retried', async () => {
  const h = setup();
  const legal = await h.chat('legal');
  h.sessions.handoffImpl = async () => { throw new Error('Claude Code exited'); };
  legal.owenSays();
  legal.s.context.percent = 45;
  await h.at(10);
  await h.endTurn(legal, 'ok');
  assert.equal(h.sessions.handoffs.length, 2);
  assert.deepEqual(h.sessions.ended.map(({ at, ...x }) => x), [{ company: CID, position: 'legal', sessionId: legal.s.id, handoff: null,
    error: 'handoff failed: Claude Code exited', contextPct: 45, reason: 'full' }]);
  assert.deepEqual(h.inbox, [{ cid: CID, e: { kind: 'flag', position: 'legal', title: 'Legal: fresh chat without a handoff',
    text: 'Its chat was full and the handoff failed twice (Claude Code exited). The new chat (chat 2) starts from the notebook only: '
      + 'whatever the old chat knew that is not in the notebook did not carry over. The old chat is kept and can still be read.', needsOwen: true } }]);
  assert.deepEqual(h.sessions.cards, [{ sid: 'legal-chat2', item: { type: 'team', kind: 'notice', text: 'Fresh chat started (chat 2); the handoff failed, so only the notebook carried over. The old chat is kept.' } }]);
  h.done();

  const g = setup();
  const gl = await g.chat('legal');
  let n = 0;
  g.sessions.handoffImpl = async () => { if (++n === 1) throw new Error('busy'); return { text: 'Done: all.' }; };
  gl.owenSays();
  gl.s.context.percent = 45;
  await g.at(10);
  await g.endTurn(gl, 'ok');
  assert.equal(g.sessions.handoffs.length, 2);
  assert.equal(g.sessions.ended[0].handoff, 'Done: all.');
  assert.equal(g.sessions.ended[0].error, null);
  assert.deepEqual(g.inbox, []);
  g.done();
});

test('12a. Cancel a queued ask: withdrawn, never delivered; only the asker may cancel', async () => {
  const h = setup();
  const legal = await h.chat('legal');
  legal.owenSays();
  const call = h.track(h.askCeo('legal', 'Is the NDA signed?', { waitS: 30 }));
  const t = h.last();
  await h.at(30);
  assert.deepEqual(h.rt.cancel(t.id, { by: { kind: 'position', id: 'marketing', company: CID } }), { state: 'queued', refused: 'Only the asker can cancel a question.' });
  assert.deepEqual(h.rt.cancel(t.id, { by: h.caller(h.ceo) }), { state: 'cancelled' });
  assert.equal(h.rt.get(t.id).reason, 'withdrawn by the asker');
  assert.equal(call.value.status, 'pending');
  await h.endTurn(legal, 'The owner reply');
  await h.at(200);
  assert.equal(legal.sent.length, 0);
  assert.equal(h.ceo.sent.length, 0);
  assert.deepEqual(h.rt.cancel(t.id, { by: h.caller(h.ceo) }), { state: 'cancelled' });
  h.done();
});

test('12b. Cancel a working ask: cancelled, its open sub-asks too, answers logged but not delivered', async () => {
  const h = setup();
  const legal = await h.chat('legal'), tax = await h.chat('tax');
  const ceoCall = h.track(h.askCeo('legal', 'Review the vendor contract.', { waitS: 600 }));
  await flush();
  const root = h.last();
  await h.at(10);
  const legalCall = h.track(h.askFrom(legal, 'tax', 'Is the vendor tax-exempt?'));
  await flush();
  const tTax = h.last();
  assert.equal(h.asks(tax).length, 1);
  await h.at(20);
  assert.deepEqual(h.rt.cancel(root.id, { by: { kind: 'owen' } }), { state: 'cancelled' });
  await flush();
  assert.deepEqual(ceoCall.value, { status: 'cancelled', ticket: root.id, reason: 'cancelled by the owner' });
  assert.deepEqual(legalCall.value, { status: 'cancelled', ticket: tTax.id, reason: 'its parent question was cancelled' });
  await h.at(30);
  await h.endTurn(tax, 'Tax answer nobody waits for.');
  await h.at(40);
  await h.endTurn(legal, 'Legal answer nobody waits for.');
  await h.at(100);
  assert.equal(h.ceo.sent.length, 0);
  assert.equal(h.answers(legal).length, 0);
  assert.deepEqual(h.sessions.cards, []);
  assert.deepEqual(h.lines(root.id).map((l) => l.state), ['asked', 'delivered', 'cancelled', 'cancelled']);
  assert.equal(h.lines(root.id)[3].answer, 'Legal answer nobody waits for.');
  assert.equal(h.lines(root.id)[3].reason, 'answered after it was cancelled; not delivered');
  assert.equal(h.lines(tTax.id).at(-1).answer, 'Tax answer nobody waits for.');
  h.done();
});

test('12c. A failed answer turn is delivered once more, then cancelled with the reason', async () => {
  const h = setup();
  const legal = await h.chat('legal');
  const call = h.track(h.askCeo('legal', 'Is the NDA signed?', { waitS: 600 }));
  await flush();
  const t = h.last();
  await h.at(10);
  await h.endTurn(legal, '', { failed: true, error: 'Claude Code exited unexpectedly' });
  assert.equal(h.asks(legal).length, 2, 'asked again');
  assert.ok(h.asks(legal)[1].text.startsWith(`(Asked again: your last turn on this question failed before it answered.)\n<helm-ask ticket="${t.id}"`), h.asks(legal)[1].text);
  assert.equal(h.rt.get(t.id).attempts, 1);
  assert.doesNotMatch(h.asks(legal)[1].text, /Helm restarted/, 'Helm did not restart: the turn failed');
  assert.equal(call.done, false);
  await h.at(20);
  await h.endTurn(legal, '', { failed: true, error: 'Claude Code exited unexpectedly' });
  assert.deepEqual(call.value, { status: 'cancelled', ticket: t.id, reason: 'Legal\'s turn failed: Claude Code exited unexpectedly' });
  await h.at(60);
  assert.equal(h.asks(legal).length, 2);
  h.done();
});

test('12d. The owner interrupting the answerer\'s turn cancels the ask: "Stopped in Legal\'s chat"', async () => {
  const h = setup();
  const legal = await h.chat('legal');
  const call = h.track(h.askCeo('legal', 'Is the NDA signed?', { waitS: 600 }));
  await flush();
  const t = h.last();
  await h.at(15);
  await h.endTurn(legal, 'Half an answer', { interrupted: true });
  assert.deepEqual(call.value, { status: 'cancelled', ticket: t.id, reason: 'Stopped in Legal\'s chat before it answered', partial: 'Half an answer' });
  h.done();
});

test('12e. Rate limit (20 asks per position per hour), open sub-asks cap, and the chain of command', async () => {
  const h = setup();
  const legal = await h.chat('legal');
  await h.chat('tax');
  for (let i = 1; i <= 20; i++) {
    const c = h.track(h.askFrom(legal, 'tax', `Question ${i}?`));
    await flush();
    assert.equal(c.done, false, `ask ${i} waits`);
  }
  const r21 = await h.askFrom(legal, 'tax', 'Question 21?');
  assert.deepEqual(r21, { status: 'refused', reason: 'Rate limit: at most 20 asks per position per hour.' });
  assert.equal(h.store.lines.at(-1).state, 'refused');
  await h.at(3605);
  const r22 = h.track(h.askFrom(legal, 'tax', 'Question 22?'));
  await flush();
  assert.notEqual(r22.value && r22.value.status, 'refused', 'an hour later it is allowed again');

  // the CEO asking a deeper position: refused, naming its manager and the report to go through
  assert.deepEqual(await h.askCeo('tax', 'Q3 filings?'), { status: 'refused', reason: 'Tax Specialist reports to Legal, not to you. Ask Legal (team_ask to "legal"); the chain of command is real.' });
  assert.deepEqual(await h.askCeo('county', 'County filings?'), { status: 'refused', reason: 'County Filings reports to State Filings, not to you. Ask Legal (team_ask to "legal"); the chain of command is real.' });
  assert.deepEqual(await h.askFrom(legal, 'payroll', 'Payroll?'), { status: 'refused', reason: 'Payroll reports to Tax Specialist, not to you. Ask Tax Specialist (team_ask to "tax"); the chain of command is real.' });
  assert.deepEqual(await h.askCeo('marketing', 'x', { kind: 'colleague' }), { status: 'refused', reason: 'colleague_ask is for positions; ask your reports with team_ask.' });
  h.done();

  // at most 3 open sub-asks per ticket
  const g = setup({ settings: { maxConcurrentRuns: 10 } });
  const gm = await g.chat('marketing');
  g.track(g.askCeo('marketing', 'Launch plan?', { waitS: 600 }));
  await flush();
  for (const to of ['finance', 'ops', 'support']) {
    const c = g.track(g.askFrom(gm, to, `${to}?`, { kind: 'colleague' }));
    await flush();
    assert.equal(c.done, false);
  }
  assert.deepEqual(await g.askFrom(gm, 'legal', 'legal?', { kind: 'colleague' }), { status: 'refused', reason: 'At most 3 open sub-asks per question. Wait for one, or answer with what you have.' });
  g.done();
});

test('13. Every exchange is logged: colleague asks with kind colleague, refused asks with state refused and the reason', async () => {
  const h = setup();
  const mkt = await h.chat('marketing'), fin = await h.chat('finance');
  const c = h.track(h.askFrom(mkt, 'finance', 'What is the Q4 ad budget?', { kind: 'colleague' }));
  await flush();
  const t = h.last();
  await h.at(5);
  await h.endTurn(fin, '$5,000.');
  assert.equal(c.value.answer, '$5,000.');
  const ls = h.lines(t.id);
  assert.deepEqual(ls.map((l) => l.state), ['asked', 'delivered', 'answered']);
  assert.ok(ls.every((l) => l.kind === 'colleague' && l.from.kind === 'position' && l.from.id === 'marketing' && l.to === 'finance'));
  const r1 = await h.askCeo('tax', 'Q3 filings?');
  const r2 = await h.askFrom(mkt, 'marketing', 'Myself?', { kind: 'colleague' });
  const r3 = await h.askFrom(mkt, 'finance', 'Read this', { kind: 'colleague', handed: ['C:/Users/you/example-co/missing.txt'] });
  assert.equal(r2.reason, 'You cannot ask yourself.');
  assert.equal(r3.reason, 'Handed paths must exist: C:/Users/you/example-co/missing.txt');
  const refused = h.store.lines.filter((l) => l.state === 'refused');
  assert.deepEqual(refused.map((l) => [l.to, l.kind, l.reason]), [['tax', 'report', r1.reason], ['marketing', 'colleague', r2.reason], ['finance', 'colleague', r3.reason]]);
  assert.ok(refused.every((l) => l.question && l.ticket && l.at));
  const log = h.rt.logEntries({ company: CID });
  assert.equal(log.length, 4);
  assert.deepEqual(log.find((e) => e.ticket === t.id), { at: ls[0].at, from: 'marketing', to: 'finance', question: 'What is the Q4 ad budget?', answer: '$5,000.', state: 'answered', ticket: t.id });
  assert.equal(log.find((e) => e.to === 'tax').state, 'refused');
  assert.equal(log.find((e) => e.to === 'tax').reason, r1.reason);
  const xt = h.rt.crosstalk({ company: CID });
  assert.equal(xt.entries.length, 4);
  const e = xt.entries.find((x) => x.ticket === t.id);
  assert.equal(e.kind, 'colleague');
  assert.equal(e.state, 'answered');
  assert.equal(e.from.name, 'Marketing');
  assert.equal(xt.entries.find((x) => x.to === 'tax').state, 'refused');
  h.done();
});

test('14. noteOwnWrite / isOwnEdit: the 15 s window, the remembered hash, and an exact hash', async () => {
  const h = setup();
  const { rt } = h;
  rt.noteOwnWrite(CID, 'legal');
  await h.at(10);
  assert.equal(rt.isOwnEdit(CID, 'legal', 'C:/Users/you/example-co/positions/legal/notebook.md', { hash: 'h1' }), true, 'inside the window (and h1 is remembered)');
  await h.clock.to(T0 + 15 * SEC);
  assert.equal(rt.isOwnEdit(CID, 'legal'), true, 'the window includes its last millisecond');
  await h.at(20);
  assert.equal(rt.isOwnEdit(CID, 'legal', 'notebook.md', { hash: 'h1' }), true, 'after the window, the same content is still the own echo');
  assert.equal(rt.isOwnEdit(CID, 'legal', 'notebook.md', { hash: 'h2' }), false, 'different content after the window: The owner edited');
  assert.equal(rt.isOwnEdit(CID, 'legal', 'notebook.md', { hash: 'h1' }), false, 'forgotten after the owner\'s edit');
  assert.equal(rt.isOwnEdit(CID, 'payroll'), false);

  rt.noteOwnWrite(CID, 'tax', 'notebook.md', { hash: 'hA' });
  await h.at(21);
  assert.equal(rt.isOwnEdit(CID, 'tax', 'notebook.md', { hash: 'hB' }), false, 'an exact hash: another hash is the owner\'s even inside the window');
  assert.equal(rt.isOwnEdit(CID, 'tax', 'C:\\Users\\you\\example-co\\positions\\tax\\NOTEBOOK.md', { hash: 'hA' }), true);
  assert.equal(rt.isOwnEdit(CID, 'tax'), true, 'no hash given: the window decides');
  await h.at(40);
  assert.equal(rt.isOwnEdit(CID, 'tax', 'notebook.md', { hash: 'hA' }), true);
  assert.equal(rt.isOwnEdit(CID, 'tax'), false);
  h.done();
});

test('15. team.ask.updated payloads: the shape and every state (asked, delivered, pending, answered, late, expired, cancelled)', async () => {
  const h = setup({ settings: { maxConcurrentRuns: 10 } });
  const legal = await h.chat('legal'), mkt = await h.chat('marketing'), fin = await h.chat('finance'), ops = await h.chat('ops');
  fin.owenSays();
  ops.owenSays();
  h.track(h.askCeo('marketing', 'M?'));
  const a = h.last();
  await flush();
  await h.at(5);
  await h.endTurn(mkt, 'M.');
  h.track(h.askCeo('legal', 'L?', { waitS: 30 }));
  const b = h.last();
  await h.at(40);
  await h.endTurn(legal, 'L.');
  h.track(h.askCeo('finance', 'F?', { waitS: 30 }));
  const c = h.last();
  h.track(h.askCeo('ops', 'O?', { waitS: 30 }));
  const d = h.last();
  await h.at(80);
  h.rt.cancel(c.id, { by: h.caller(h.ceo) });
  await h.clock.to(T0 + 40 * SEC + 2 * HOUR);
  const asks = h.events.filter((e) => e.ev === 'team.ask.updated');
  const seq = (id) => asks.filter((e) => e.p.ticket === id).map((e) => e.p.state).filter((s, i, l) => i === 0 || l[i - 1] !== s);
  assert.deepEqual(seq(a.id), ['asked', 'delivered', 'answered']);
  assert.deepEqual(seq(b.id), ['asked', 'delivered', 'pending', 'late']);
  assert.deepEqual(seq(c.id), ['asked', 'pending', 'cancelled']);
  assert.deepEqual(seq(d.id), ['asked', 'pending', 'expired']);
  assert.deepEqual([...new Set(asks.map((e) => e.p.state))].sort(), [...STATES].sort());
  const ev = asks.find((e) => e.p.ticket === a.id && e.p.state === 'delivered').p;
  assert.deepEqual(ev, {
    company: CID, ticket: a.id, chainId: a.id, state: 'delivered', detail: 'working 0s',
    from: { kind: 'ceo', name: 'CEO (Example Co)' }, to: 'marketing', toName: 'Marketing',
    chain: [{ ticket: a.id, parentTicket: null, to: 'marketing', name: 'Marketing', state: 'delivered', detail: 'working 0s', sinceMs: 0 }],
    sessionIds: ['ceo-1', mkt.s.id], kind: 'report', parentTicket: null, toolUseId: null,
  });
  h.done();
});

test('9e. A late answer still waiting in the outbox when Helm quits is delivered after the restart', async () => {
  const clock = fakeClock(), sessions = fakeSessions(clock), state = memState(), store = fakeStore();
  const A = setup({ clock, sessions, state, store });
  const legal = await A.chat('legal');
  A.track(A.askCeo('legal', 'Is the NDA signed?', { waitS: 30 }));
  const id = A.last().id;
  await A.at(30);
  A.ceo.owenSays('The CEO chat is busy');
  await A.at(40);
  await A.endTurn(legal, 'Signed on 11-02.');
  assert.equal(A.ceo.sent.length, 0);
  A.done();
  assert.equal(state.get('teamOutbox').length, 1);
  A.ceo.reply('done'); // its turn ends while Helm is down
  const B = setup({ clock, sessions, state, store });
  await flush();
  assert.equal(B.answers(B.ceo).length, 1);
  assert.match(B.ceo.sent[0].text, new RegExp(`^<helm-answer ticket="${id}" from="Legal" state="answered">\nSigned on 11-02\.\n`));
  assert.equal(state.get('teamOutbox').length, 0);
  B.done();
});

test('10c. The machine-wide count (positionTurnsRunning): The owner\'s turns count, starts in flight count, blocked turns do not', async () => {
  const h = setup();
  h.sessions.positionTurnsRunning = () => [...h.sessions.all.values()].filter((es) => es.s.position && es.turnActive).length;
  const ops = await h.chat('ops'), sup = await h.chat('support');
  const legal = await h.chat('legal'), mkt = await h.chat('marketing'), fin = await h.chat('finance'), tax = await h.chat('tax');
  ops.owenSays();
  sup.owenSays();
  h.track(h.askCeo('legal', 'L?', { waitS: 600 }));
  const tL = h.last();
  await h.at(5);
  assert.equal(legal.sent.length, 0);
  assert.equal(h.rt.get(tL.id).queueReason, 'waiting for a free slot (2 positions running)');
  await h.endTurn(ops, 'ok');
  assert.equal(h.asks(legal).length, 1);
  await h.endTurn(sup, 'ok');
  // two asks in one go: only one more start fits, although neither turn is running yet when the second is checked
  mkt.loadHops = 3;
  fin.loadHops = 3;
  h.track(h.askCeo('marketing', 'M?', { waitS: 600 }));
  h.track(h.askCeo('finance', 'F?', { waitS: 600 }));
  await flush();
  assert.equal(h.asks(mkt).length, 1);
  assert.equal(h.asks(fin).length, 0);
  // Legal blocks in-call on Tax: its slot is free, Finance (first in line) takes it, Tax waits for the next
  h.track(h.askFrom(legal, 'tax', 'T?'));
  await flush();
  assert.equal(h.asks(fin).length, 1);
  assert.equal(h.asks(tax).length, 0);
  await h.endTurn(mkt, 'M.');
  assert.equal(h.asks(tax).length, 1);
  h.done();
});

test('16. Paused and retired positions: refused at ask, held while paused, cancelled when retired', async () => {
  const h = setup();
  const legal = await h.chat('legal');
  legal.owenSays();
  const call = h.track(h.askCeo('legal', 'Is the NDA signed?', { waitS: 600 }));
  const t = h.last();
  const pos = h.store.positions.find((p) => p.id === 'legal');
  pos.status = 'paused';
  await h.at(5);
  assert.equal(h.rt.get(t.id).queueReason, 'Legal is paused');
  assert.deepEqual(await h.askCeo('legal', 'Another?'), { status: 'refused', reason: 'Legal is paused. The owner can resume it in Team view.' });
  await h.endTurn(legal, 'ok');
  await h.at(60);
  assert.equal(legal.sent.length, 0, 'held while paused');
  pos.status = 'retired';
  await h.at(65);
  assert.deepEqual(call.value, { status: 'cancelled', ticket: t.id, reason: 'Legal was retired' });
  assert.deepEqual(await h.askCeo('legal', 'Again?'), { status: 'refused', reason: 'Legal is retired.' });
  h.done();
});

test('17. A duty whose turn fails twice: delivered again once, then done resolves failed', async () => {
  const h = setup();
  const legal = await h.chat('legal');
  const duty = h.rt.runDuty({ company: CID, position: 'legal', duty: { id: 'weekly', title: 'Weekly check', trigger: { kind: 'schedule' } }, text: 'Run the weekly check.' });
  await flush();
  assert.equal(legal.sent.length, 1);
  await h.at(10);
  await h.endTurn(legal, '', { failed: true, error: 'boom' });
  assert.equal(legal.sent.length, 2);
  assert.equal(legal.sent[1].text, '(Delivered again: the last run failed before it finished.)\nRun the weekly check.');
  await h.at(20);
  await h.endTurn(legal, '', { failed: true, error: 'boom' });
  assert.deepEqual(await duty.done, { state: 'failed', error: 'Legal\'s turn failed: boom', finalText: '', reported: false });
  assert.throws(() => h.rt.runDuty({ company: CID, position: 'nobody' }), /no position "nobody"/);
  h.done();
});
