'use strict';
// main/engine/team/mcp.js: the `team` MCP server mapping layer (docs/POSITIONS.md 3, 5.2, 6.1-6.3, 7.4, 9.5).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { z } = require('zod');
const M = require('../../main/engine/team/mcp');

const WS_ROOT = path.resolve(os.tmpdir(), 'team-mcp-test').replace(/\\/g, '/');

function makeStore(extra = []) {
  const positions = [
    { id: 'legal', name: 'Legal', parent: null, remit: 'Contracts, terms of service and privacy questions.', status: 'active' },
    { id: 'tax', name: 'Tax Specialist', parent: 'legal', remit: 'Sales tax and filings.', status: 'active' },
    { id: 'payroll', name: 'Payroll', parent: 'tax', remit: 'Contractor payments and forms.', status: 'active' },
    { id: 'marketing', name: 'Marketing', parent: null, remit: 'Launch posts, positioning and the weekly roundup for every product.', status: 'active' },
    ...extra,
  ];
  const notebooks = {
    legal: '# Notebook\n## Open items\n- [ ] SECRET-NOTEBOOK-TEXT review terms\n- [ ] privacy page\n- [x] done one\n',
  };
  const adds = [];
  return {
    adds,
    getCompany: (cid) => (cid === 'example-co' ? { id: 'example-co', name: 'Example Co', folders: ['C:/Users/you/example'] } : null),
    listPositions: (cid) => (cid === 'example-co' ? positions.filter((p) => p.status !== 'retired').map((p) => ({ ...p, brief: 'SECRET-BRIEF-TEXT' })) : []),
    getPosition: (cid, pid) => { const p = positions.find((x) => x.id === pid); return p ? { ...p } : null; },
    readNotebook: (cid, pid) => (notebooks[pid] != null ? { text: notebooks[pid], ok: true, errors: null } : { text: null, ok: false, errors: ['missing'] }),
    notebookAdd: (cid, pid, section, text) => {
      if (!String(text || '').trim()) throw new Error('text: empty');
      adds.push({ cid, pid, section, text });
      notebooks[pid] = (notebooks[pid] || '') + `- ${text}\n`;
    },
    workspaceOf: (cid, pid) => `${WS_ROOT}/${cid}/${pid}`,
  };
}

function makeRuntime() {
  const calls = [];
  const rec = (name, ret) => (...a) => { calls.push({ name, args: a }); return typeof ret === 'function' ? ret(...a) : ret; };
  const rt = {
    calls,
    answeringTicket: null,
    ask: rec('ask', async () => ({ status: 'answered', ticket: 't_1', from: 'legal', answer: 'ok', took_s: 1, chain: [] })),
    ticket: rec('ticket', async (id) => ({ status: 'pending', ticket: id })),
    cancel: rec('cancel', () => ({ state: 'cancelled' })),
    followup: rec('followup', () => ({ status: 'sent' })),
    logEntries: rec('logEntries', () => []),
    busyText: rec('busyText', (cid, pid) => (pid === 'legal' ? 'answering CEO' : null)),
    queued: rec('queued', () => []),
    answering: rec('answering', () => (rt.answeringTicket ? { ticket: rt.answeringTicket } : null)),
    setWaitingOn: rec('setWaitingOn', () => {}),
    noteDutyReport: rec('noteDutyReport', () => 't_duty'),
    noteOwnWrite: rec('noteOwnWrite', () => {}),
  };
  return rt;
}

const CEO = { kind: 'ceo', company: 'example-co', sessionId: 's-ceo' };
const LEGAL = { kind: 'position', company: 'example-co', position: 'legal', sessionId: 's-legal' };
const TAX = { kind: 'position', company: 'example-co', position: 'tax', sessionId: 's-tax' };
const PAYROLL = { kind: 'position', company: 'example-co', position: 'payroll', sessionId: 's-payroll' };
const NONE = { kind: 'none', sessionId: 's-none' };

function fakeClock() {
  const timers = [];
  return {
    timers,
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    fire() { for (const t of timers) if (!t.cleared) t.fn(); },
  };
}

test('toolNamesFor: ceo, manager, leaf, none', () => {
  const store = makeStore();
  assert.deepEqual(M.toolNamesFor(CEO, store), ['team_roster', 'team_ask', 'team_ticket', 'team_cancel', 'team_log', 'team_propose']);
  const mgr = M.toolNamesFor(LEGAL, store);
  for (const n of ['colleague_ask', 'ask_followup', 'notebook_add', 'request_access', 'duty_report', 'team_propose', 'team_ticket', 'team_roster', 'team_ask', 'team_cancel', 'team_log']) assert.ok(mgr.includes(n), n);
  assert.equal(new Set(mgr).size, mgr.length);
  assert.deepEqual(M.toolNamesFor(PAYROLL, store), ['colleague_ask', 'ask_followup', 'notebook_add', 'request_access', 'duty_report', 'team_propose', 'team_ticket']);
  assert.deepEqual(M.toolNamesFor(NONE, store), ['team_propose']);
  assert.deepEqual(Object.keys(M.handlersFor(PAYROLL, { store, runtime: makeRuntime() })).sort(), M.toolNamesFor(PAYROLL, store).slice().sort());
});

test('instructions: CEO lists direct reports with deeper counts, the recurring line, no brief or notebook text', () => {
  const store = makeStore([
    { id: 'support', name: 'Support', parent: null, remit: 'Answers user emails and triages bug reports from the forum.', status: 'active' },
    { id: 'money', name: 'Money', parent: null, remit: 'Budget, invoices and the monthly cost review.', status: 'active' },
  ]);
  const s = M.instructionsFor(CEO, { store });
  assert.match(s, /Example Co/);
  assert.ok(s.includes('- Legal (legal): Contracts, terms of service and privacy questions. · 2 below'));
  assert.ok(s.includes('- Marketing (marketing): Launch posts'));
  assert.ok(s.includes('- Support (support):'));
  assert.ok(s.includes('- Money (money):'));
  assert.ok(!s.includes('Tax Specialist (tax)'), 'only direct reports are listed');
  assert.ok(s.includes(M.RECURRING_CEO));
  assert.ok(s.includes('When a non-code topic (legal, money, marketing, support…) comes up a second or third time and no position covers it, suggest a position to the owner in plain words first; call team_propose only once the owner wants it.'));
  assert.ok(s.includes(M.NAME_RULE), 'the CEO is told to name positions by real job titles');
  assert.match(M.NAME_RULE, /job title that person would hold at a real company \(General Counsel, Controller, .*never by a topic or department label \("Legal", "Finance", "Money & Paperwork", "Leads & Outreach"\); the remit says what it covers\.$/);
  assert.ok(s.includes('<helm-answer>'));
  assert.ok(!/SECRET-BRIEF|SECRET-NOTEBOOK/.test(s));
  assert.ok(s.length < 2400, `length ${s.length}`);
});

test('instructions: position, manager, none', () => {
  const store = makeStore();
  const t = M.instructionsFor(TAX, { store });
  assert.ok(t.startsWith("You are Tax Specialist on Example Co's team. You report to Legal: Contracts"));
  assert.ok(t.includes('- Payroll (payroll): Contractor payments'));
  assert.ok(t.includes('<helm-ask>'));
  assert.ok(t.includes('Marketing (marketing): '), 'colleagues listed');
  assert.ok(!/Colleagues.*Payroll \(payroll\)/.test(t), 'own reports are not colleagues');
  assert.ok(!/Colleagues.*Tax Specialist \(tax\)/.test(t), 'self is not a colleague');
  assert.ok(t.includes(M.RECURRING_MANAGER));
  assert.ok(M.RECURRING_MANAGER.endsWith(M.NAME_RULE), 'managers get the naming rule with the recurring-topic line');
  assert.ok(!/SECRET-BRIEF|SECRET-NOTEBOOK/.test(t));
  const leaf = M.instructionsFor(PAYROLL, { store });
  assert.ok(leaf.includes('You report to Tax Specialist'));
  assert.ok(leaf.includes('Your reports: none.'));
  assert.ok(leaf.includes('team_propose: propose a new report under you (named by its real job title'), 'a leaf proposing its first report is told too');
  assert.ok(!leaf.includes(M.RECURRING_MANAGER));
  const top = M.instructionsFor(LEGAL, { store });
  assert.ok(top.includes("You report to the CEO (the owner's main chats)."));
  const marketingRemit = /Marketing \(marketing\): ([^;\n]*)/.exec(leaf)[1];
  assert.ok(marketingRemit.length <= 60, marketingRemit);
  const n = M.instructionsFor(NONE, {});
  assert.match(n, /team_propose/);
  assert.equal(n.split('\n').length, 1);
});

test('team_roster: scoping, under refusal, manager, open proposals', async () => {
  const store = makeStore();
  const runtime = makeRuntime();
  const ceo = M.handlersFor(CEO, { store, runtime, proposals: { open: () => [{ id: 'p_1' }], propose: async () => ({}) }, duties: { nextDuty: (c, id) => (id === 'marketing' ? 'Fri 15:00 roundup' : null) } });
  const r = await ceo.team_roster({});
  assert.deepEqual(r.reports.map((x) => x.id), ['legal', 'marketing']);
  const legal = r.reports[0];
  assert.equal(legal.reports, 1);
  assert.equal(legal.openItems, 2);
  assert.equal(legal.busy, 'answering CEO');
  assert.equal(r.reports[1].nextDuty, 'Fri 15:00 roundup');
  assert.deepEqual(r.openProposals, [{ id: 'p_1' }]);
  assert.ok(!JSON.stringify(r).includes('SECRET'), 'no brief or notebook text');
  const deep = await ceo.team_roster({ under: 'tax' });
  assert.deepEqual(deep.reports.map((x) => x.id), ['payroll']);
  assert.equal((await ceo.team_roster({ under: 'nobody' })).status, 'refused');

  const tax = M.handlersFor(TAX, { store, runtime });
  const t = await tax.team_roster({});
  assert.deepEqual(t.reports.map((x) => x.id), ['payroll']);
  assert.deepEqual(t.manager, { id: 'legal', name: 'Legal', remit: 'Contracts, terms of service and privacy questions.' });
  assert.equal(t.openProposals, undefined);
  for (const under of ['marketing', 'legal']) {
    const x = await tax.team_roster({ under });
    assert.equal(x.status, 'refused', under);
  }
  const l = await M.handlersFor(LEGAL, { store, runtime }).team_roster({ under: 'tax' });
  assert.deepEqual(l.reports.map((x) => x.id), ['payroll']);
  assert.deepEqual((await M.handlersFor(LEGAL, { store, runtime }).team_roster({})).manager, { id: null, name: 'CEO', remit: "the owner's main chats" });
});

test('team_ask / colleague_ask pass from, to, kind, wait_s, signal and toolUseId through', async () => {
  const store = makeStore();
  const runtime = makeRuntime();
  const ac = new AbortController();
  const ceo = M.handlersFor(CEO, { store, runtime });
  const res = await ceo.team_ask({ to: 'legal', question: 'Q?', handed: ['C:/Users/you/a.md'], wait_s: 42 }, { signal: ac.signal, _meta: { 'claudecode/toolUseId': 'toolu_1' } });
  assert.equal(res.status, 'answered');
  const p = runtime.calls.find((c) => c.name === 'ask').args[0];
  assert.equal(p.company, 'example-co');
  assert.equal(p.kind, 'report');
  assert.deepEqual(p.from, { kind: 'ceo', sessionId: 's-ceo', name: 'CEO (Example Co)' });
  assert.equal(p.to, 'legal');
  assert.equal(p.question, 'Q?');
  assert.deepEqual(p.handed, ['C:/Users/you/a.md']);
  assert.equal(p.waitS, 42);
  assert.equal(p.signal, ac.signal);
  assert.equal(p.toolUseId, 'toolu_1');

  const tax = M.handlersFor(TAX, { store, runtime });
  await tax.colleague_ask({ to: 'marketing', question: 'one thing' }, { _meta: { tool_use_id: 'toolu_2' } });
  const q = runtime.calls.filter((c) => c.name === 'ask')[1].args[0];
  assert.equal(q.kind, 'colleague');
  assert.deepEqual(q.from, { kind: 'position', id: 'tax', sessionId: 's-tax', name: 'Tax Specialist' });
  assert.equal(q.toolUseId, 'toolu_2');

  await tax.team_ticket({ ticket: 't_9', wait_s: 5 }, {});
  const tk = runtime.calls.find((c) => c.name === 'ticket');
  assert.equal(tk.args[0], 't_9');
  assert.equal(tk.args[1].waitS, 5);
  assert.deepEqual(tk.args[1].caller, { kind: 'position', company: 'example-co', id: 'tax', sessionId: 's-tax', name: 'Tax Specialist' });
  const c = await ceo.team_cancel({ ticket: 't_9' });
  assert.deepEqual(c, { ticket: 't_9', state: 'cancelled' });
  assert.deepEqual(runtime.calls.find((x) => x.name === 'cancel').args[1].by, { kind: 'ceo', company: 'example-co', sessionId: 's-ceo' });
  assert.deepEqual(await ceo.team_log({ limit: 5 }), { entries: [] });
  assert.equal(runtime.calls.find((x) => x.name === 'logEntries').args[0].limit, 5);
});

test('notebook_add: calls the store and marks its own write', async () => {
  const store = makeStore();
  const runtime = makeRuntime();
  const h = M.handlersFor(TAX, { store, runtime });
  assert.deepEqual(await h.notebook_add({ section: 'Facts', text: 'Filing is quarterly.' }), { ok: true, section: 'Facts' });
  assert.deepEqual(store.adds, [{ cid: 'example-co', pid: 'tax', section: 'Facts', text: 'Filing is quarterly.' }]);
  const own = runtime.calls.filter((c) => c.name === 'noteOwnWrite');
  assert.equal(own.length, 2);
  assert.deepEqual(own[0].args, ['example-co', 'tax', 'notebook.md']);
  assert.match(own[1].args[3].hash, /^[0-9a-f]{40}$/);
  assert.equal((await h.notebook_add({ section: 'Gossip', text: 'x' })).status, 'refused');
});

test('request_access: approved path', async () => {
  const store = makeStore();
  const runtime = makeRuntime();
  runtime.answeringTicket = 't_ask';
  const seen = [];
  const h = M.handlersFor(TAX, { store, runtime, clock: fakeClock(), access: { request: async (r) => { seen.push(r); return { decision: 'once' }; } } });
  const r = await h.request_access({ kind: 'read', target: 'C:/Users/you/mantle/CHANGELOG.md', why: 'release notes' });
  assert.equal(r.decision, 'once');
  assert.equal(seen[0].ticket, 't_ask');
  assert.equal(seen[0].kind, 'read');
  assert.equal(seen[0].warn, false);
  const w = runtime.calls.filter((c) => c.name === 'setWaitingOn').map((c) => c.args);
  assert.deepEqual(w[0], ['s-tax', "waiting for the owner's OK on Tax Specialist's access request"]);
  assert.deepEqual(w[w.length - 1], ['s-tax', null]);
  // .claude targets warn rather than refuse
  await h.request_access({ kind: 'write', target: '~/.claude/settings.json', why: 'x' });
  assert.equal(seen[1].warn, true);
  // validation
  assert.equal((await h.request_access({ kind: 'read', target: 'relative/file.md', why: 'x' })).status, 'refused');
  assert.equal((await h.request_access({ kind: 'bash', target: 'bash:everything', why: 'x' })).status, 'refused');
  assert.equal((await h.request_access({ kind: 'tool', target: 'WebFetch', why: '' })).status, 'refused');
  assert.equal((await h.request_access({ kind: 'tool', target: 'rm -rf', why: 'x' })).status, 'refused');
  // no port
  const none = await M.handlersFor(TAX, { store, runtime }).request_access({ kind: 'tool', target: 'WebFetch', why: 'x' });
  assert.deepEqual(none, { decision: 'denied', note: 'Access requests are not available.' });
});

test('request_access: the timer wins -> no-answer, waitingOn cleared', async () => {
  const store = makeStore();
  const runtime = makeRuntime();
  const clock = fakeClock();
  const h = M.handlersFor(TAX, { store, runtime, clock, access: { request: () => new Promise(() => {}) } });
  const p = h.request_access({ kind: 'tool', target: 'WebFetch', why: 'docs' });
  await new Promise((r) => setImmediate(r));
  assert.equal(clock.timers[0].ms, 600_000);
  clock.fire();
  const r = await p;
  assert.equal(r.decision, 'no-answer');
  assert.equal(r.note, M.NO_ANSWER_NOTE);
  const w = runtime.calls.filter((c) => c.name === 'setWaitingOn');
  assert.deepEqual(w[w.length - 1].args, ['s-tax', null]);
  assert.equal(clock.timers[0].cleared, true);
});

test('request_access: abort clears waitingOn too', async () => {
  const store = makeStore();
  const runtime = makeRuntime();
  const clock = fakeClock();
  const ac = new AbortController();
  const h = M.handlersFor(TAX, { store, runtime, clock, access: { request: () => new Promise(() => {}) } });
  const p = h.request_access({ kind: 'bash', target: 'bash:readonly', why: 'git log' }, { signal: ac.signal });
  await new Promise((r) => setImmediate(r));
  ac.abort();
  const r = await p;
  assert.equal(r.decision, 'stopped');
  const w = runtime.calls.filter((c) => c.name === 'setWaitingOn');
  assert.equal(w.length, 2);
  assert.deepEqual(w[1].args, ['s-tax', null]);
  assert.equal(clock.timers[0].cleared, true);
});

test('duty_report: files outside the workspace are refused; inside ones pass to duties.report', async () => {
  const store = makeStore();
  const runtime = makeRuntime();
  const reports = [];
  const h = M.handlersFor(TAX, { store, runtime, duties: { report: async (r) => { reports.push(r); } } });
  const ws = store.workspaceOf('example-co', 'tax');
  const bad = await h.duty_report({ summary: 'done', needs_owen: false, files: [`${ws}/../legal/brief.md`] });
  assert.equal(bad.status, 'refused');
  assert.equal((await h.duty_report({ summary: 'done', needs_owen: false, files: ['C:/Users/you/elsewhere.md'] })).status, 'refused');
  assert.equal(reports.length, 0);
  const ok = await h.duty_report({ summary: 'Drafted the Q4 summary.', needs_owen: true, files: [`${ws}/drafts/q4.md`, 'drafts/notes.md'] });
  assert.deepEqual(ok, { ok: true, ticket: 't_duty' });
  assert.equal(reports[0].needsOwen, true);
  assert.equal(reports[0].ticket, 't_duty');
  assert.equal(reports[0].files.length, 2);
  for (const f of reports[0].files) assert.ok(f.toLowerCase().startsWith(ws.toLowerCase() + '/'), f);
});

test('team_propose: authorization matrix', async () => {
  const store = makeStore();
  const runtime = makeRuntime();
  const got = [];
  const proposals = { propose: async (p) => { got.push(p); return { proposal: `p_${got.length}`, status: 'shown', where: ['this chat', 'Team view'] }; } };
  const tax = M.handlersFor(TAX, { store, runtime, proposals });
  const why = 'needed';
  // position: create only under itself
  const c = await tax.team_propose({ action: 'create', name: 'Filings', remit: 'r', brief: 'b', why });
  assert.equal(c.status, 'shown');
  assert.equal(c.note, M.PROPOSE_NOTE);
  assert.equal(got[0].draft.parent, 'tax');
  assert.deepEqual(got[0].by, { kind: 'position', id: 'tax', sessionId: 's-tax' });
  assert.equal((await tax.team_propose({ action: 'create', parent: 'marketing', name: 'X', why })).status, 'refused');
  assert.equal((await tax.team_propose({ action: 'create', parent: null, name: 'X', why })).status, 'refused');
  // never itself, its manager, a sibling / another branch; never 'company'
  for (const id of ['tax', 'legal', 'marketing']) {
    assert.equal((await tax.team_propose({ action: 'retire', id, why })).status, 'refused', `retire ${id}`);
    assert.equal((await tax.team_propose({ action: 'edit', id, remit: 'x', why })).status, 'refused', `edit ${id}`);
  }
  assert.equal((await tax.team_propose({ action: 'company', name: 'X', folders: [], why })).status, 'refused');
  // its own subtree is fine
  assert.equal((await tax.team_propose({ action: 'retire', id: 'payroll', why })).status, 'shown');
  assert.equal((await tax.team_propose({ action: 'edit', id: 'payroll', parent: 'marketing', why })).status, 'refused', 're-parent outside');
  // why required
  assert.equal((await tax.team_propose({ action: 'retire', id: 'payroll' })).status, 'refused');
  // CEO: any position, never 'company'
  const ceo = M.handlersFor(CEO, { store, runtime, proposals });
  assert.equal((await ceo.team_propose({ action: 'retire', id: 'payroll', why })).status, 'shown');
  assert.equal((await ceo.team_propose({ action: 'edit', id: 'legal', remit: 'x', why })).status, 'shown');
  const cc = await ceo.team_propose({ action: 'create', name: 'Support', why });
  assert.equal(cc.status, 'shown');
  assert.equal(got[got.length - 1].draft.parent, null);
  // a name warning from the port (proposals.js nameWarning) is repeated in the note, after the usual one
  const warned = await M.handlersFor(CEO, { store, runtime, proposals: { propose: async () => ({ proposal: 'p_w', status: 'shown', nameWarning: '"Legal" reads like a department or topic, not a job title.' }) } })
    .team_propose({ action: 'create', name: 'Legal', why });
  assert.equal(warned.status, 'shown');
  assert.equal(warned.note, `${M.PROPOSE_NOTE} Name check: "Legal" reads like a department or topic, not a job title. Call team_propose again with the job title to replace this card.`);
  assert.equal(cc.note, M.PROPOSE_NOTE, 'no warning, no extra words');
  assert.match((await ceo.team_propose({ action: 'company', name: 'X', why })).reason, /exists/);
  // 'none': only company
  const none = M.handlersFor(NONE, { store, runtime, proposals });
  assert.equal((await none.team_propose({ action: 'create', name: 'X', why })).status, 'refused');
  assert.equal((await none.team_propose({ action: 'company', name: 'Example Co', folders: ['C:/Users/you/example'], why })).status, 'shown');
  assert.equal(got[got.length - 1].company, null);
  // port refusal and no port
  const r = await M.handlersFor(CEO, { store, runtime, proposals: { propose: async () => ({ refused: true, reasons: ['id: taken', 'depth: too deep'] }) } }).team_propose({ action: 'create', name: 'X', why });
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.reasons, ['id: taken', 'depth: too deep']);
  assert.deepEqual(await M.handlersFor(CEO, { store, runtime }).team_propose({ action: 'create', name: 'X', why }), { status: 'refused', reason: 'Proposals are not available.' });
});

test('team_propose: powers beyond the manager are reported as excess, not refused', async () => {
  const store = makeStore();
  store.tree = () => ({ reports: () => [], subtree: (id) => (id === 'tax' ? ['payroll'] : []), ids: () => ['legal', 'tax', 'payroll', 'marketing'], excess: (powers, parent) => (parent === 'tax' ? [{ power: 'tools', value: 'WebFetch', by: 'tax' }] : []) });
  store.powersCtx = () => ({ companyFolders: [], workspaceOf: () => '' });
  const got = [];
  const proposals = { propose: async (p) => { got.push(p); return { proposal: 'p_1', status: 'shown', where: ['this chat'] }; } };
  const r = await M.handlersFor(TAX, { store, runtime: makeRuntime(), proposals }).team_propose({ action: 'create', name: 'Filings', powers: { tools: ['WebFetch'] }, why: 'w' });
  assert.equal(r.status, 'shown');
  assert.deepEqual(r.excess, [{ power: 'tools', value: 'WebFetch', by: 'tax' }]);
  assert.deepEqual(got[0].excess, r.excess);
  assert.match(r.note, /exceed Tax Specialist's/);
});

test('typedApproval and isApproval', () => {
  const base = { origin: 'user', openProposals: ['p_1'], lastShown: 'p_1' };
  for (const text of ['yes', 'yes, make it', 'ok go ahead', 'Approve', 'Sounds good!', 'yep. do it please', 'lgtm', 'go for it']) {
    const r = M.typedApproval({ ...base, text });
    assert.ok(r, text);
    assert.equal(r.proposal, 'p_1');
    assert.equal(r.quote, text.trim());
  }
  for (const text of ['no', "don't", 'not yet', 'wait', 'hold on', 'yes but rename it', 'yes?', 'ok, but change the name', 'please', 'thanks', '']) {
    assert.equal(M.typedApproval({ ...base, text }), null, text);
  }
  assert.equal(M.typedApproval({ ...base, text: 'yes', origin: 'helm' }), null);
  assert.equal(M.typedApproval({ ...base, text: 'yes', openProposals: ['p_1', 'p_2'] }), null);
  assert.equal(M.typedApproval({ ...base, text: 'yes', openProposals: [] }), null);
  assert.equal(M.typedApproval({ ...base, text: 'yes', lastShown: 'item_9' }), null);
  assert.equal(M.isApproval('yes, make it'), true);
  assert.equal(M.isApproval('yes but no'), false);
});

test('createTeamServer: wraps results and errors (fake sdk)', async () => {
  const store = makeStore();
  const runtime = makeRuntime();
  const made = [];
  const sdk = {
    tool: (name, desc, shape, handler) => ({ name, desc, shape, handler }),
    createSdkMcpServer: (o) => { made.push(o); return { type: 'sdk', name: o.name, tools: o.tools }; },
  };
  const srv = M.createTeamServer(TAX, { sdk, z, store, runtime });
  const o = made[0];
  assert.equal(o.name, 'team');
  assert.equal(o.alwaysLoad, true);
  assert.equal(o.timeout, M.SERVER_TIMEOUT_MS);
  assert.equal(M.SERVER_TIMEOUT_MS, 660_000);
  assert.equal(M.SERVER_NAME, 'team');
  assert.ok(o.instructions.startsWith('You are Tax Specialist'));
  assert.deepEqual(srv.tools.map((t) => t.name).sort(), M.toolNamesFor(TAX, store).slice().sort());
  const nb = srv.tools.find((t) => t.name === 'notebook_add');
  const ok = await nb.handler({ section: 'Facts', text: 'x' }, {});
  assert.deepEqual(JSON.parse(ok.content[0].text), { ok: true, section: 'Facts' });
  assert.equal(ok.isError, undefined);
  const err = await nb.handler({ section: 'Facts', text: '' }, {});
  assert.equal(err.isError, true);
  assert.deepEqual(JSON.parse(err.content[0].text), { status: 'error', reason: 'text: empty' });
  assert.match(srv.tools.find((t) => t.name === 'colleague_ask').desc, /one specific question, no hand-over of your work/);
  assert.match(srv.tools.find((t) => t.name === 'team_ask').desc, /DIRECT reports/);
  assert.ok(srv.tools.find((t) => t.name === 'team_propose').desc.endsWith(M.NAME_RULE), 'team_propose says how to name a position');
  M.createTeamServer(NONE, { sdk, z, store, runtime });
  assert.equal(made[1].alwaysLoad, false);
  assert.deepEqual(made[1].tools.map((t) => t.name), ['team_propose']);
});

test('createTeamServer: builds with the real SDK, no schema conversion warnings', async () => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const warnings = [];
  const onWarn = (w) => warnings.push(w);
  process.on('warning', onWarn);
  try {
    const store = makeStore();
    const runtime = makeRuntime();
    for (const ctx of [CEO, LEGAL, NONE]) {
      const srv = M.createTeamServer(ctx, { sdk, z, store, runtime });
      assert.equal(srv.type, 'sdk');
      assert.equal(srv.name, 'team');
      const reg = srv.instance && srv.instance._registeredTools;
      if (reg) assert.deepEqual(Object.keys(reg).sort(), M.toolNamesFor(ctx, store).slice().sort());
    }
    await new Promise((r) => setImmediate(r));
  } finally { process.off('warning', onWarn); }
  assert.ok(!warnings.some((w) => w && (w.code === 'CLAUDE_SDK_MCP_TOOL_SCHEMA_UNCONVERTIBLE' || /UNCONVERTIBLE/.test(String(w.message)))), warnings.map((w) => w.message).join('; '));
});

test('owner name: instructions, tool descriptions and handler notes use deps.ownerName (string or getter, read per message)', async () => {
  const store = makeStore();
  let name = 'Jordan';
  const own = () => name;
  const ceo = M.instructionsFor(CEO, { store, ownerName: own });
  assert.ok(ceo.includes('suggest a position to Jordan in plain words first; call team_propose only once Jordan wants it.'));
  assert.ok(ceo.includes('tell Jordan and carry on'));
  assert.ok(M.instructionsFor(LEGAL, { store, ownerName: own }).includes("You report to the CEO (Jordan's main chats)."));
  assert.match(M.instructionsFor({ kind: 'none' }, { ownerName: own }), /when Jordan asks to set up a company for a business Jordan runs/);
  assert.match(M.instructionsFor({ kind: 'none' }, {}), /when the owner asks to set up a company/);
  const runtime = makeRuntime();
  const h = M.handlersFor(LEGAL, { store, runtime, ownerName: own });
  assert.deepEqual((await h.team_roster({})).manager, { id: null, name: 'CEO', remit: "Jordan's main chats" });
  name = '';
  assert.deepEqual((await h.team_roster({})).manager, { id: null, name: 'CEO', remit: "the owner's main chats" }, 'read per call');
  assert.equal(M.PROPOSE_NOTE.startsWith('The owner decides on the card.'), true);
  assert.equal(M.NO_ANSWER_NOTE.startsWith('The owner has not answered in 10 minutes.'), true);
  const text = JSON.stringify([M.RECURRING_CEO, M.RECURRING_MANAGER, M.PROPOSE_NOTE, M.NO_ANSWER_NOTE]);
  assert.doesNotMatch(text, /\b(he|his|him)\b/, 'no pronoun for the owner');
});
