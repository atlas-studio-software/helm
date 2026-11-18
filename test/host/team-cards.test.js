// Positions (lane T7): the team cards in a chat (ui/chat/team-cards.js) and the access card (ui/chat/requests.js),
// rendered in plain node through test/host/fixtures/ui-render.mjs (no DOM). The words the owner reads, the buttons each card
// offers in each state, and the RPC each button calls (docs/POSITIONS.md 5.4, 5.5, 6.3, 7.4, 10.4, 11).
// The fixture shims preact/hooks, html.js, icons.js; the extra imports of these two files (store, shell state, chat
// state, markdown, views, util's memo) get the small shims below, through one more module hook registered after the
// fixture's (hooks run last-registered first).
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { registerHooks } = require('node:module');

const UI = path.join(__dirname, '..', '..', 'ui');
const TEAM = path.join(UI, 'chat', 'team-cards.js');
const REQ = path.join(UI, 'chat', 'requests.js');
const UTIL = pathToFileURL(path.join(UI, 'chat', 'util.js')).href;
const PARENTS = new Set([pathToFileURL(TEAM).href, pathToFileURL(REQ).href]);
const PRE = 't7-shim:';
const SHIMS = {
  '../lib/store.js': `const R = globalThis.__helmUiTest;
    export const rpc = (...a) => R.rpc(...a); export const toast = (...a) => R.toast(...a);
    export const send = (id, text) => R.rpc('sessions.send', { id, text });
    export const respond = (id, requestId, response) => R.rpc('sessions.respond', { id, requestId, response });
    export const sessions = { get value() { return R.sessions || []; } };
    export const itemsBySession = { get value() { return R.items || {}; } };
    export const activeId = { value: null };`,
  '../shell/state.js': 'const R = globalThis.__helmUiTest; export const openSession = (id) => { (R.opened ||= []).push(id); };',
  '../lib/markdown.js': 'const R = globalThis.__helmUiTest; export function Markdown(p) { return R.h("markdown", { text: p.text }); }',
  './views.js': `const R = globalThis.__helmUiTest;
    export function CodeView(p) { return R.h("codeview", { code: p.code }); } export function DiffView(p) { return R.h("diffview", { path: p.path }); }
    export function JsonView() { return R.h("jsonview", {}); }`,
  './state.js': `const R = globalThis.__helmUiTest;
    export const now = { get value() { return R.now ?? Date.now(); }, peek() { return R.now ?? Date.now(); } };
    export const useTicker = () => {};
    const open = () => (R.open ||= new Map());
    export const isOpen = (k, d) => (open().has(k) ? open().get(k) : !!d);
    export const toggle = (k, d) => { open().set(k, !isOpen(k, d)); R.dirty = true; };
    export const setOpen = (k, v) => { open().set(k, v); R.dirty = true; };`,
  './util.js': `export * from ${JSON.stringify(UTIL)}; export const memo = (C) => C;`,
};

let ui, C, Q, R;
before(async () => {
  ui = await import('./fixtures/ui-render.mjs');
  if (!ui.available) return;
  await ui.importUnderTest(path.join(UI, 'lib', 'restart-note.js'));   // a file with no imports: registers the fixture's hooks first
  registerHooks({
    resolve(spec, ctx, next) {
      const parent = ctx.parentURL && String(ctx.parentURL).split('?')[0];
      if (parent && PARENTS.has(parent) && Object.hasOwn(SHIMS, spec)) return { url: PRE + encodeURIComponent(spec), format: 'module', shortCircuit: true };
      return next(spec, ctx);
    },
    load(url, ctx, next) {
      if (url.startsWith(PRE)) return { format: 'module', source: SHIMS[decodeURIComponent(url.slice(PRE.length))], shortCircuit: true };
      return next(url, ctx);
    },
  });
  C = await ui.importUnderTest(TEAM);
  Q = await ui.importUnderTest(REQ);
  R = ui.R;
});
const skip = (t) => { if (!ui.available) { t.skip('node:module registerHooks is missing in this node'); return true; } return false; };

const NOW = Date.UTC(2026, 10, 18, 14, 0, 0);
const CEO = { id: 's-ceo', team: { company: 'example-co', companyName: 'Example Co' } };
const TAX = { id: 's-tax', position: { company: 'example-co', companyName: 'Example Co', id: 'tax', name: 'Tax Specialist', parent: 'legal', parentName: 'Legal', chat: 2 } };
function fresh({ rpc, items } = {}) {
  ui.reset();
  R.now = NOW; R.sessions = [CEO, TAX]; R.items = items || {}; R.opened = []; R.open = new Map();
  R.rpcImpl = rpc || (async () => ({}));
}
const deferred = () => { let res; const p = new Promise((r) => { res = r; }); return { p, res }; };
const node = (act) => ui.findAll(ui.byAct(act))[0];
const acts = () => ui.findAll((n) => n.t === 'button' && n.p['data-act']).map((n) => n.p['data-act']);
const ask = (over = {}) => ({ id: 'i1', type: 'tool', name: 'mcp__team__team_ask', toolUseId: 'tu1', status: 'running', startedAt: NOW - 130_000,
  input: { to: 'legal', question: 'Does the privacy page cover the crash upload?' }, ...over });
// the engine's chain rows (runtime.js snapshot): sinceMs = time in that state when the event was made
const chain3 = [
  { ticket: 't_a', parentTicket: null, to: 'legal', name: 'Legal', state: 'delivered', detail: 'waiting on Tax Specialist', sinceMs: 120_000 },
  { ticket: 't_b', parentTicket: 't_a', to: 'tax', name: 'Tax Specialist', state: 'delivered', detail: 'waiting on Payroll tax', sinceMs: 60_000 },
  { ticket: 't_c', parentTicket: 't_b', to: 'payroll', name: 'Payroll tax', state: 'asked', detail: 'queued: The owner is talking with Payroll tax', sinceMs: 10_000 },
];

test('ask model: the live line follows the chain (queued, working, asked a report, waiting for your OK)', (t) => {
  if (skip(t)) return;
  const m = (team) => C.askModel(ask({ team }), NOW);
  assert.equal(m({ ticket: 't_a', state: 'asked', chain: [{ ticket: 't_a', to: 'legal', name: 'Legal', state: 'queued: The owner is talking with Legal' }] }).line.text, 'Queued · you are talking with Legal');
  assert.equal(m({ ticket: 't_q', state: 'asked', detail: 'queued: Legal is busy', chain: [{ ticket: 't_q', to: 'legal', name: 'Legal', state: 'asked', detail: 'queued: Legal is busy', sinceMs: 5000 }] }).line.text, 'Queued · Legal is busy');
  assert.equal(m({ ticket: 't_a', state: 'delivered', chain: [{ ...chain3[0], detail: 'working 2m' }] }).line.text, 'Legal is working · 2m');
  const deep = m({ ticket: 't_a', state: 'delivered', chain: chain3 });
  assert.equal(deep.line.text, 'Legal asked Tax Specialist · 1m');
  assert.deepEqual(deep.chain.map((c) => [c.name, c.depth]), [['Legal', 0], ['Tax Specialist', 1], ['Payroll tax', 2]]);
  assert.deepEqual(deep.chain.map((c) => C.stepWords(c, deep.chain, NOW)), ['waiting on Tax Specialist', 'waiting on Payroll tax', 'queued · you are talking with Payroll tax']);
  const acc = m({ ticket: 't_a', state: 'delivered', chain: [chain3[0], { ...chain3[1], state: 'access' }] });
  assert.deepEqual([acc.line.text, acc.line.tone], ["Waiting for your OK on Tax Specialist's access request", 'waiting']);
  const accS = m({ ticket: 't_a', state: 'delivered', chain: [chain3[0], { ...chain3[1], name: 'Social Posts', state: 'access' }] });
  assert.equal(accS.line.text, "Waiting for your OK on Social Posts' access request", 'a name ending in s takes a bare apostrophe');
  // an edit's added power is cut only when the engine's excess lists it ($scope of a one-product scope = that folder)
  const ex = [{ power: 'write', value: 'C:/Users/you/app' }, { power: 'bash', value: 'readonly' }, { power: 'tools', value: 'WebFetch' }];
  const prod = { kind: 'product', folder: 'C:\\Users\\you\\app\\' };
  assert.deepEqual([{ power: 'write', value: '$scope' }, { power: 'write', value: '$workspace' }, { power: 'write', value: 'C:/Users/you/other' },
    { power: 'bash', value: 'readonly' }, { power: 'bash', value: 'off' }, { power: 'tools', value: 'WebFetch' }, { power: 'tools', value: 'Grep' },
    { power: 'agents', value: true }].map((c) => C.addedCut(c, ex, prod)), [true, false, false, true, false, true, false, false]);
  assert.equal(C.addedCut({ power: 'write', value: '$scope' }, ex, { kind: 'company' }), false, 'a company-wide $scope is not tied to one path');
  assert.equal(m(undefined).line.text, 'Waiting for Legal');   // no ticket event yet: the input names who
});

test('ask model: phases from the tool status, the ticket state and the result', (t) => {
  if (skip(t)) return;
  const answered = C.askModel(ask({ status: 'done', result: JSON.stringify({ status: 'answered', ticket: 't_a', from: 'legal', answer: 'Yes, section 4.', took_s: 220 }) }), NOW);
  assert.deepEqual([answered.phase, answered.answer, answered.took, answered.late], ['answered', 'Yes, section 4.', 220_000, false]);
  const pending = C.askModel(ask({ status: 'done', result: { text: JSON.stringify({ status: 'pending', ticket: 't_a' }) }, team: { ticket: 't_a', state: 'delivered' } }), NOW);
  assert.equal(pending.phase, 'pending');
  const late = C.askModel(ask({ status: 'done', result: JSON.stringify({ status: 'pending', ticket: 't_a' }), team: { ticket: 't_a', state: 'answered', answer: 'Late yes' } }), NOW);
  assert.deepEqual([late.phase, late.late, late.answer], ['answered', true, 'Late yes']);
  assert.equal(C.askModel(ask({ status: 'error', interrupted: true, team: { ticket: 't_a', state: 'delivered' } }), NOW).phase, 'stopped');
  assert.equal(C.askModel(ask({ status: 'error', interrupted: true }), NOW).phase, 'unsent');
  const refused = C.askModel(ask({ status: 'done', result: JSON.stringify({ status: 'refused', reason: 'Finance is waiting on you (through Tax).' }) }), NOW);
  assert.deepEqual([refused.phase, refused.reason], ['refused', 'Finance is waiting on you (through Tax).']);
  assert.equal(C.askModel(ask({ team: { ticket: 't_a', state: 'cancelled' } }), NOW).phase, 'cancelled');
  const exp = C.askModel(ask({ status: 'done', team: { ticket: 't_a', state: 'expired', chain: [{ ...chain3[0], state: 'late' }, { ...chain3[1], state: 'expired' }] } }), NOW);
  assert.deepEqual([exp.phase, exp.where], ['expired', 'Tax Specialist']);
  assert.equal(C.askModel(ask({ name: 'mcp__team__colleague_ask', input: { to: 'finance', question: 'q' } }), NOW).colleague, true);
});

test('chain: parent links give the tree; without them it is a straight line; depth starts at 0', (t) => {
  if (skip(t)) return;
  const fan = C.normChain([{ ticket: 'a', to: 'legal' }, { ticket: 'b', parent: 'a', to: 'tax' }, { ticket: 'c', parent: 'a', to: 'contracts' }, { ticket: 'd', parent: 'b', to: 'payroll-tax' }]);
  assert.deepEqual(fan.map((c) => [c.name, c.depth]), [['Legal', 0], ['Tax', 1], ['Contracts', 1], ['Payroll tax', 2]]);
  assert.deepEqual(C.normChain([{ ticket: 'a', to: 'x' }, { ticket: 'b', to: 'y' }]).map((c) => [c.depth, c.parent]), [[0, null], [1, 'a']]);
  assert.deepEqual(C.normChain([{ ticket: 'a', to: 'x', depth: 1 }, { ticket: 'b', to: 'y', depth: 2 }]).map((c) => c.depth), [0, 1]);
  assert.deepEqual(C.normChain(null), []);
});

test('Ask card live: who, the state line, the chain rows, [Open Legal] opens its chat, [Cancel question] withdraws it', async (t) => {
  if (skip(t)) return;
  const d = deferred();
  fresh({ rpc: async (m, p) => (m === 'team.open' ? { sessionId: 's-legal' } : m === 'team.ask.cancel' ? d.p : undefined) });
  ui.mount(C.AskCard, { item: ask({ team: { ticket: 't_a', state: 'delivered', chain: chain3 } }), sid: CEO.id });
  await ui.settle();
  const txt = ui.text();
  assert.match(txt, /Asking Legal/);
  assert.match(txt, /Legal asked Tax Specialist · 1m/);
  assert.match(txt, /2m/);   // elapsed since asked
  assert.equal(ui.findAll((n) => n.t === 'li' && /tc-step/.test(n.p.class)).length, 3);
  assert.deepEqual(acts(), ['ask-release', 'ask-open', 'ask-cancel'], 'Payroll tax is queued behind the owner: it can be let through');
  assert.match(ui.text(node('ask-release')), /Let Payroll tax answer now/);
  assert.match(ui.text(node('ask-open')), /Open Legal/);
  ui.click('ask-open'); await ui.settle();
  assert.deepEqual(R.rpcLog[0], ['team.open', { company: 'example-co', id: 'legal' }]);
  assert.deepEqual(R.opened, ['s-legal']);
  ui.click('ask-cancel'); await ui.settle();
  assert.deepEqual(R.rpcLog[1], ['team.ask.cancel', { ticket: 't_a' }]);
  assert.equal(node('ask-open').p.disabled, true, 'disabled while sending');
  assert.equal(node('ask-release').p.disabled, true);
  assert.equal(node('ask-cancel').p.disabled, true);
  d.res({ state: 'cancelled' }); await ui.settle();
  assert.match(ui.text(), /Question to Legal cancelled/);
  assert.equal(node('ask-open'), undefined, 'no buttons once settled');
});

test('Ask card: pending and stopped say where the answer will come; answered collapses to one line with a disclosure', async (t) => {
  if (skip(t)) return;
  fresh();
  ui.mount(C.AskCard, { item: ask({ status: 'done', result: JSON.stringify({ status: 'pending', ticket: 't_a' }), team: { ticket: 't_a', state: 'delivered' } }), sid: CEO.id });
  await ui.settle();
  assert.match(ui.text(), /The answer comes into this chat as a Helm message/);
  ui.mount(C.AskCard, { item: ask({ status: 'error', interrupted: true, team: { ticket: 't_a', state: 'delivered' } }), sid: CEO.id });
  await ui.settle();
  assert.match(ui.text(), /You stopped waiting\. Legal carries on/);
  assert.deepEqual(acts(), ['ask-open', 'ask-cancel']);
  ui.mount(C.AskCard, { item: ask({ status: 'done', result: JSON.stringify({ status: 'answered', ticket: 't_a', answer: 'Yes: section 4 covers it.\nMore.', took_s: 220 }) }), sid: CEO.id });
  await ui.settle();
  assert.match(ui.text(), /Legal answered · in 3m 40s/);
  assert.match(ui.text(), /Yes: section 4 covers it\./);   // the peek: first line only
  assert.equal(ui.findAll((n) => n.t === 'markdown').length, 0, 'answer under a closed disclosure');
  ui.click('ask-toggle'); await ui.settle();
  assert.equal(ui.findAll((n) => n.t === 'markdown')[0].p.text, 'Yes: section 4 covers it.\nMore.');
  assert.equal(node('ask-toggle').p['aria-expanded'], true);
  ui.mount(C.AskCard, { item: ask({ status: 'done', result: JSON.stringify({ status: 'refused', reason: 'Legal is paused' }) }), sid: CEO.id });
  await ui.settle();
  assert.match(ui.text(), /Legal could not take the question/);
  assert.match(ui.text(), /Legal is paused/);
});

test('asked-by: CEO question parsed out of <helm-ask>, handed files as chips, never the user bubble', async (t) => {
  if (skip(t)) return;
  const text = '<helm-ask ticket="t_4f1e" from="CEO (Example Co)" kind="report" reply-by="14:32">\nDoes the new privacy page cover the crash upload?\n'
    + 'Handed to you (read-only for this question): C:/Users/you/example-co/site/privacy.html, C:/Users/you/example-co/CHANGELOG.md\n</helm-ask>\n'
    + 'Answer this question in your reply. Your final message is passed back to the CEO word for word.';
  const m = C.askedByModel({ origin: 'ask', text, ask: { ticket: 't_4f1e', from: { kind: 'ceo', name: 'CEO' }, kind: 'report' } }, TAX);
  assert.deepEqual([m.label, m.sub, m.text, m.replyBy], ['Asked by CEO', 'Example Co', 'Does the new privacy page cover the crash upload?', '14:32']);
  assert.deepEqual(m.files, ['C:/Users/you/example-co/site/privacy.html', 'C:/Users/you/example-co/CHANGELOG.md']);
  assert.deepEqual(C.askedByModel({ origin: 'ask', text: 'Plain', ask: { from: { kind: 'position', id: 'legal', name: 'Legal' }, kind: 'report' } }, TAX).label, 'Asked by Legal');
  const col = C.askedByModel({ origin: 'ask', text: 'q', ask: { from: { kind: 'position', id: 'finance' }, kind: 'colleague' } }, TAX);
  assert.deepEqual([col.label, col.sub], ['Asked by Finance', 'colleague']);
  const duty = C.askedByModel({ origin: 'duty', text: 'Check the month', duty: { id: 'money-check', title: 'Monthly money check', trigger: 'schedule' } }, TAX);
  assert.deepEqual([duty.label, duty.sub], ['Duty · Monthly money check', 'scheduled']);
  const exp = C.askedByModel({ origin: 'answer', text: '<helm-answer ticket="t_1" from="legal" state="expired">Stopped at Tax.</helm-answer>' }, CEO);
  assert.deepEqual([exp.label, exp.sub, exp.text], ['No answer from Legal', 'expired after 2 h', 'Stopped at Tax.']);
  const adds = C.askedByModel({ origin: 'answer', text: '<helm-answer ticket="t_1" from="legal" kind="followup" via="tax">More.</helm-answer>' }, CEO);
  assert.deepEqual([adds.label, adds.sub], ['Legal adds', 'from Tax Specialist'], 'via: the open chat names tax, not the id in words');
  assert.equal(C.askedByModel({ origin: 'seed', seed: { fromChat: 3 }, text: 'x' }).line, 'Fresh chat · seeded from the brief and notebook, and the handoff of chat 3');   // older shape
  fresh();
  ui.mount(C.TeamUserMsg, { item: { id: 'u1', type: 'user', origin: 'ask', ts: NOW, text, ask: { from: { kind: 'ceo' } } }, sid: TAX.id });
  await ui.settle();
  const root = ui.findAll((n) => n.p['data-item-id'] === 'u1')[0];
  assert.match(root.p.class, /msg-ask/);
  assert.doesNotMatch(root.p.class, /msg-user/);
  assert.equal(ui.findAll((n) => n.p.class === 'att-file').length, 2);
  assert.doesNotMatch(ui.text(), /Answer this question in your reply/);
});

test('asked-by: a long question clamps with Show all', async (t) => {
  if (skip(t)) return;
  fresh();
  ui.mount(C.TeamUserMsg, { item: { id: 'u2', type: 'user', origin: 'ask', ts: NOW, text: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') }, sid: TAX.id });
  await ui.settle();
  assert.ok(ui.findAll((n) => /ask-bubble.*clamp/.test(n.p.class || '')).length);
  ui.click('asked-more'); await ui.settle();
  assert.equal(ui.findAll((n) => /ask-bubble.*clamp/.test(n.p.class || '')).length, 0);
  assert.match(ui.text(node('asked-more')), /Show less/);
});

const prop = (over = {}) => ({ id: 'tm1', type: 'team', kind: 'proposal', proposal: { id: 'p_9c0d', action: 'create', why: 'Tax questions came up three times.', by: { kind: 'ceo', sessionId: 's-ceo' },
  draft: { name: 'Tax Specialist', parent: 'legal', parentName: 'Legal', remit: 'Sales tax and filings', powers: { read: ['$workspace', '$company'], write: ['$workspace'], tools: ['Read', 'WebFetch'], bash: 'off' },
    duties: [{ id: 'm', title: 'Monthly money check', trigger: { kind: 'schedule', words: 'every month on the 1st' } }], brief: '# Brief', seed: { files: [{ path: 'C:/x/notes.md', why: 'past filings' }] } },
  status: 'open', ...over } });

test('Proposal card: a name warning (proposals.js nameWarning) shows as a note above the body; none without it', async (t) => {
  if (skip(t)) return;
  fresh();
  const warn = '"Legal" reads like a department or topic, not a job title.';
  assert.equal(C.proposalModel({ ...prop().proposal, nameWarning: warn }).nameWarning, warn);
  assert.equal(C.proposalModel(prop().proposal).nameWarning, '');
  ui.mount(C.TeamItem, { item: prop({ draft: { ...prop().proposal.draft, name: 'Legal' }, nameWarning: warn }), sid: CEO.id });
  await ui.settle();
  const notes = ui.findAll((n) => n.p && n.p['data-name-warning'] !== undefined);
  assert.equal(notes.length, 1);
  assert.equal(ui.text(notes[0]), warn);
  ui.mount(C.TeamItem, { item: prop(), sid: CEO.id });
  await ui.settle();
  assert.equal(ui.findAll((n) => n.p && n.p['data-name-warning'] !== undefined).length, 0);
});

test('Proposal card: title and body in words; Approve calls team.decide and collapses to "Approved … (your click)"', async (t) => {
  if (skip(t)) return;
  const d = deferred();
  fresh({ rpc: async (m) => (m === 'team.decide' ? d.p : undefined) });
  ui.mount(C.TeamItem, { item: prop(), sid: CEO.id });
  await ui.settle();
  const txt = ui.text();
  for (const s of ['New position: Tax Specialist under Legal', 'Tax questions came up three times.', 'Sales tax and filings', 'its workspace', 'company folders', 'Bash off',
    'Monthly money check · every month on the 1st', 'notes.md', 'Proposal']) assert.ok(txt.includes(s), `shows "${s}"`);
  assert.deepEqual(acts(), ['brief-toggle', 'proposal-approve', 'proposal-change', 'proposal-decline']);
  assert.equal(ui.findAll((n) => n.t === 'markdown').length, 0, 'brief collapsed by default');
  ui.click('proposal-approve'); await ui.settle();
  assert.deepEqual(R.rpcLog[0], ['team.decide', { proposal: 'p_9c0d', decision: 'approve' }]);
  for (const a of ['proposal-approve', 'proposal-change', 'proposal-decline']) assert.equal(node(a).p.disabled, true, `${a} disabled while sending`);
  d.res({ ok: true }); await ui.settle();
  assert.match(ui.text(), /^Approved .+ \(your click\) · New position: Tax Specialist under Legal$/);
  assert.equal(node('proposal-approve'), undefined);
});

test('Proposal card: Decline sends the note; a refusal keeps the card open; Change… goes to the proposing chat as the owner\'s message', async (t) => {
  if (skip(t)) return;
  fresh({ rpc: async (m) => (m === 'team.decide' ? { ok: false, error: 'depth cap' } : {}) });
  ui.mount(C.TeamItem, { item: prop(), sid: CEO.id });
  await ui.settle();
  ui.input('proposal-note', 'Not now'); await ui.settle();
  ui.click('proposal-decline'); await ui.settle();
  assert.deepEqual(R.rpcLog[0], ['team.decide', { proposal: 'p_9c0d', decision: 'decline', note: 'Not now' }]);
  assert.equal(R.toasts[0].title, 'Could not decline');
  assert.ok(node('proposal-approve'), 'still open');
  ui.click('proposal-change'); await ui.settle();
  assert.deepEqual(acts().slice(-2), ['proposal-back', 'proposal-send']);
  assert.equal(node('proposal-send').p.disabled, true, 'nothing typed yet');
  ui.input('proposal-change-text', 'Make it read-only'); await ui.settle();
  ui.click('proposal-send'); await ui.settle();
  assert.deepEqual(R.rpcLog[1], ['sessions.send', { id: 's-ceo', text: 'Make it read-only' }]);
  assert.match(ui.text(), /Sent\. The proposal stays open/);
});

test('Proposal: decided lines, typed yes, excess powers, the typed-yes hint only for the one open card', async (t) => {
  if (skip(t)) return;
  const at = new Date(2026, 10, 18, 14, 2).getTime();
  const fmt = () => '2:02 PM';
  assert.equal(C.proposalRecord(C.proposalModel({ status: 'approved', decision: { at, how: 'typed', quote: 'yes, make it' } }), fmt).lead, 'Approved 2:02 PM (your reply ‘yes, make it’) · ');
  assert.equal(C.proposalRecord(C.proposalModel({ status: 'declined', decision: { at, note: 'later' } }), fmt).note, 'later');
  assert.equal(C.proposalModel({ action: 'edit', target: 'legal' }).title, 'Change Legal');
  assert.equal(C.proposalModel({ action: 'retire', target: 'contracts' }).title, 'Retire Contracts');
  assert.equal(C.proposalModel({ action: 'company', draft: { name: 'Example Co' } }).title, 'New company: Example Co');
  assert.equal(C.proposalModel({ action: 'create', draft: { name: 'Legal' } }).title, 'New position: Legal under the CEO');
  const item = prop({ excess: [{ power: 'tools', value: 'WebFetch', by: 'legal' }] });
  fresh({ items: { 's-ceo': [item] } });
  ui.mount(C.TeamItem, { item, sid: CEO.id });
  await ui.settle();
  assert.match(ui.text(), /These powers would be cut/);
  assert.match(ui.text(), /WebFetch\s*Legal does not have it/);
  assert.ok(ui.findAll((n) => n.t === 'span' && /chip.*danger/.test(n.p.class || '') && ui.text(n) === 'WebFetch').length);
  assert.match(ui.text(), /Or reply “yes” to approve/);
  fresh({ items: { 's-ceo': [item, { ...prop(), id: 'tm2' }] } });
  ui.mount(C.TeamItem, { item, sid: CEO.id });
  await ui.settle();
  assert.doesNotMatch(ui.text(), /Or reply “yes”/, 'two open proposals: typing yes does not count');
});

test('Answer card: [Show] reveals the kept answer, [Send to CEO] forwards it; in a manager\'s chat it names the manager', async (t) => {
  if (skip(t)) return;
  const item = { id: 'tm3', type: 'team', kind: 'answer', answer: { ticket: 't_a', from: 'Legal', text: 'It does.' } };
  fresh();
  ui.mount(C.TeamItem, { item, sid: CEO.id });
  await ui.settle();
  assert.match(ui.text(), /Legal answered after you stopped/);
  assert.deepEqual(acts(), ['answer-show', 'answer-forward']);
  assert.match(ui.text(node('answer-forward')), /Send to CEO/);
  ui.click('answer-show'); await ui.settle();
  assert.equal(ui.findAll((n) => n.t === 'markdown')[0].p.text, 'It does.');
  ui.click('answer-forward'); await ui.settle();
  assert.deepEqual(R.rpcLog[0], ['team.answer.forward', { sessionId: 's-ceo', ticket: 't_a' }]);
  assert.match(ui.text(), /Sent Legal's answer to CEO/);
  fresh();
  ui.mount(C.TeamItem, { item, sid: TAX.id });
  await ui.settle();
  assert.match(ui.text(node('answer-forward')), /Send to Tax Specialist/);
});

const access = (a, over = {}) => ({ id: 'r1', type: 'request', kind: 'access', requestId: 'q1', status: 'pending', access: { waitMin: 30, ...a }, ...over });

test('Access card: who with its manager path, what, why; once / always / deny answer sessions.respond', async (t) => {
  if (skip(t)) return;
  const d = deferred();
  fresh({ rpc: async (m) => (m === 'sessions.respond' ? d.p : undefined) });
  ui.mount(Q.RequestItem, { item: access({ kind: 'read', target: 'C:/Users/you/app/CHANGELOG.md', why: 'To check what 1.3.0 shipped', ancestors: ['legal'] }), sid: TAX.id });
  await ui.settle();
  const txt = ui.text();
  for (const s of ['Tax Specialist asks to read', 'Example Co › CEO › Legal › Tax Specialist', 'To check what 1.3.0 shipped', 'C:/Users/you/app/CHANGELOG.md',
    'Approve always (also widens Legal)', "saves it to Tax Specialist and Legal's powers", 'No answer in 30 min counts as Deny.']) assert.ok(txt.includes(s), `shows "${s}"`);
  assert.deepEqual(acts(), ['access-once', 'access-always', 'access-deny']);
  ui.click('access-always'); await ui.settle();
  assert.deepEqual(R.rpcLog[0], ['sessions.respond', { id: 's-tax', requestId: 'q1', response: { behavior: 'allow', scope: 'always' } }]);
  for (const a of ['access-once', 'access-always', 'access-deny']) assert.equal(node(a).p.disabled, true, `${a} disabled while sending`);
  d.res({});
  fresh();
  ui.mount(Q.RequestItem, { item: access({ kind: 'write', target: 'C:/x/y.md', ancestors: ['legal', 'compliance', 'ops'] }), sid: TAX.id });
  await ui.settle();
  assert.match(ui.text(node('access-always')), /Approve always \(also widens 3 managers\)/);
  assert.match(ui.text(), /Tax Specialist, Legal, Compliance and Ops's powers/);
  ui.input('access-note', 'Not that folder'); await ui.settle();
  ui.click('access-deny'); await ui.settle();
  assert.deepEqual(R.rpcLog[0][1].response, { behavior: 'deny', message: 'Not that folder' });
});

test('Outward card: only Approve once and Deny, the exact command shown; records say what was decided', async (t) => {
  if (skip(t)) return;
  fresh();
  ui.mount(Q.RequestItem, { item: access({ kind: 'outward', outward: true, target: 'git push origin main', why: 'Release' }, { toolName: 'Bash', input: { command: 'git push origin main' } }), sid: TAX.id });
  await ui.settle();
  assert.deepEqual(acts(), ['access-once', 'access-deny']);
  assert.match(ui.text(), /Tax Specialist wants to act outside this PC/);
  assert.match(ui.text(), /Outward actions ask every time\./);
  assert.equal(ui.findAll((n) => n.t === 'codeview')[0].p.code, 'git push origin main');
  ui.click('access-once'); await ui.settle();
  assert.deepEqual(R.rpcLog[0][1].response, { behavior: 'allow', scope: 'once' });
  const rec = async (over) => { fresh(); ui.mount(Q.RequestItem, { item: access({ kind: 'tool', target: 'WebFetch', ancestors: ['legal'] }, over), sid: TAX.id }); await ui.settle(); return ui.text(); };
  assert.equal(await rec({ status: 'answered', answer: { behavior: 'allow', scope: 'once' } }), 'Approved once · Tax Specialist · WebFetch');
  assert.equal(await rec({ status: 'answered', answer: { behavior: 'allow', scope: 'always' } }), 'Approved always · saved to Tax Specialist and Legal · WebFetch');
  assert.match(await rec({ status: 'answered', answer: { behavior: 'deny', message: 'Not this week' } }), /^Denied · Tax Specialist · WebFetch“Not this week”$/);
  assert.equal(await rec({ status: 'cancelled', timedOut: true }), 'No answer in 30 min · Tax Specialist carries on without WebFetch');
  assert.equal(Q.accessModel(access({ kind: 'bash', target: 'bash:readonly' }), TAX).targetShort, 'Bash read-only');
});

test('dispatch: teamUnit renders only team items; teamToolDescribe words the other team tools', (t) => {
  if (skip(t)) return;
  assert.ok(C.teamUnit(ask(), 's'));
  assert.ok(C.teamUnit({ type: 'team', kind: 'notice' }, 's'));
  assert.ok(C.teamUnit({ type: 'user', origin: 'ask' }, 's'));
  assert.equal(C.teamUnit({ type: 'user', text: 'hi' }, 's'), null);
  assert.equal(C.teamUnit({ type: 'tool', name: 'mcp__team__team_roster' }, 's'), null);
  assert.equal(C.isTeamCard({ type: 'tool', name: 'mcp__team__colleague_ask' }), true);
  assert.equal(C.isTeamCard({ type: 'tool', name: 'Read' }), false);
  assert.deepEqual(C.teamToolDescribe({ name: 'mcp__team__notebook_add', status: 'done', input: { section: 'Facts' } }), { icon: 'pencil', verb: 'Noted in the notebook', target: 'Facts' });
  assert.equal(C.teamToolDescribe({ name: 'mcp__team__request_access', status: 'running', input: { target: 'WebFetch' } }).verb, 'Asking for access');
  assert.equal(C.teamToolDescribe({ name: 'Read' }), null);
});

// ---------- the engine's real payloads (test/host/fixtures/team-engine.js builds them with main/engine/team/*), so a
// shape change in the engine fails here instead of the cards quietly showing less than the owner approves ----------
const { engineFixtures } = require('./fixtures/team-engine.js');
let FX = null;
const fx = () => (FX ||= engineFixtures());
const NW = { id: 's-nw-ceo', team: { company: 'northwind-goods', companyName: 'Northwind Goods' } };
const NWP = (id, name, parent) => ({ id: `s-nw-${id}`, position: { company: 'northwind-goods', companyName: 'Northwind Goods', id, name, parent, chat: 1 } });
const PT = NWP('payroll-tax', 'Payroll Tax Specialist', 'tax'), TS = NWP('tax', 'Tax Specialist', 'legal');
function freshNw(list = [NW, PT, TS], opts) { fresh(opts); R.sessions = list; }
const shows = (txt, list) => { for (const s of list) assert.ok(txt.includes(s), `shows "${s}"\n  in: ${txt}`); };
const propItem = (p, over = {}) => ({ id: 'tp_' + p.id, type: 'team', kind: 'proposal', proposal: { ...p, ...over } });
const cutRows = () => ui.findAll((n) => n.t === 'li' && n.p['data-power']).map((n) => ({ power: n.p['data-power'], by: n.p['data-by'], text: ui.text(n) }));
const chipsOf = (re) => ui.findAll((n) => n.t === 'span' && /\bchip\b/.test(n.p.class || '') && re.test(n.p.class || '')).map((n) => ui.text(n));

test('engine create proposal: draft in words, power chips with the cut ones red, one cut row per excess entry naming who cuts it', async (t) => {
  if (skip(t)) return;
  const p = fx().proposals.create;
  freshNw();
  ui.mount(C.TeamItem, { item: propItem(p), sid: NW.id });
  await ui.settle();
  const txt = ui.text();
  shows(txt, ['New position: State Payroll Analyst under Payroll Tax Specialist', 'State filings keep coming up in payroll questions.', 'State payroll filings and their deadlines.',
    'Reports to', 'The whole company', 'Read its workspace', 'Read company folders', 'Write its workspace', 'WebSearch',
    'Monthly deadlines · Monthly on the 1st at 09:00', 'Helm default · high effort', 'Read the brief · 3 lines', 'These powers would be cut',
    "3 powers go beyond its manager's, so State Payroll Analyst will not have them even if you approve"]);
  assert.doesNotMatch(txt, /\[object Object\]|undefined/);
  assert.deepEqual(chipsOf(/danger/).sort(), ['Bash on', 'Subagents', 'WebFetch'], 'exactly the excess powers are cut chips');
  assert.ok(chipsOf(/^chip$/).includes('Read its workspace'), 'the rest are plain chips');
  const rows = cutRows();
  assert.deepEqual(rows.map((r) => [r.power, r.by]), p.excess.map((x) => [x.power, x.by]), 'one row per engine excess entry, in order');
  assert.match(rows[0].text, /^WebFetch.*Payroll Tax Specialist/);
  assert.match(rows[1].text, /^Bash on.*General Counsel has no Bash/, 'p.names: the manager by its name, never its id in words ("Legal")');
  assert.match(rows[2].text, /^Subagents.*General Counsel/);
  shows(txt, ['Department', 'In Legal (head: General Counsel)']);
  assert.ok(txt.indexOf('These powers would be cut') < txt.indexOf('Approve'), 'the cut notice comes before Approve');
});

test('engine edit proposal: every field from -> to, powers + / −, duties, the brief as a line diff with its counts, the cut rows', async (t) => {
  if (skip(t)) return;
  const p = fx().proposals.edit;
  freshNw();
  ui.mount(C.TeamItem, { item: propItem(p), sid: NW.id });
  await ui.settle();
  const txt = ui.text();
  const field = (k) => ui.text(ui.findAll((n) => n.p['data-field'] === k)[0] || []);
  assert.equal(field('name'), 'Payroll Tax Specialist→Contractor Payroll Specialist');
  assert.equal(field('remit'), `${p.diff.remit.from}→${p.diff.remit.to}`);
  assert.equal(field('scope'), 'The whole company→One product: northwind-app');
  // both added powers are in the engine's excess (its scope folder and Bash, beyond General Counsel): cut chips, never green gains
  assert.deepEqual(chipsOf(/\bok\b/), [], 'no added power shows as a gain when Approve cuts it');
  assert.deepEqual(chipsOf(/danger/), ['+ Write its scope (northwind-app)', '+ Bash read-only']);
  assert.deepEqual(chipsOf(/tc-removed/), ['− WebSearch', '− Bash off']);
  shows(txt, ['Change Payroll Tax Specialist', '+ New: Quarterly withholding check · On the 1st of Jan, Apr, Jul and Oct at 09:00', '+3 −0 lines',
    '## Contractors', '- Withholding rules for contractors abroad.', '… 4 unchanged lines', 'These powers would be cut',
    "2 powers go beyond its manager's, so Payroll Tax Specialist will not have them even if you approve"]);
  const bd = ui.findAll((n) => /\btc-bd\b/.test(n.p.class || ''));
  assert.deepEqual(bd.filter((n) => /\badd\b/.test(n.p.class)).map((n) => ui.text(n)), ['+## Contractors', '+- Withholding rules for contractors abroad.', '+ ']);
  assert.equal(node('brief-toggle'), undefined, 'a short brief diff shows open, nothing behind a disclosure');
  assert.deepEqual(cutRows().map((r) => [r.power, r.by]), [['write', 'legal'], ['bash', 'legal']]);
  assert.match(cutRows()[0].text, /^Write C:\/Users\/you\/northwind-app.*General Counsel does not have it/);
  assert.ok(txt.indexOf('- Withholding rules') < txt.indexOf('Approve'), 'every change comes before Approve');
  // a long brief diff folds under a disclosure that still says how much changed
  const long = { ...p, diff: { brief: Array.from({ length: 30 }, (_, i) => (i % 3 ? ` line ${i}` : `+new ${i}`)).join('\n') } };
  freshNw();
  ui.mount(C.TeamItem, { item: propItem(long), sid: NW.id });
  await ui.settle();
  assert.match(ui.text(node('brief-toggle')), /Show the brief changes · \+10 −0 lines/);
  assert.equal(ui.findAll((n) => /\btc-bdiff\b/.test(n.p.class || '')).length, 0);
  ui.click('brief-toggle'); await ui.settle();
  assert.equal(ui.findAll((n) => /\btc-bdiff\b/.test(n.p.class || '')).length, 1);
});

test('engine reparent / retire / company proposals: reports-to in words, who retires and moves, the folders', async (t) => {
  if (skip(t)) return;
  const F = fx();
  freshNw();
  ui.mount(C.TeamItem, { item: propItem(F.proposals.reparent), sid: NW.id });
  await ui.settle();
  shows(ui.text(), ['Move Tax Specialist out of Legal', 'Reports to', 'General Counsel→the CEO', 'Moves Tax Specialist out of Legal']);
  assert.equal(cutRows().length, 0);
  ui.mount(C.TeamItem, { item: propItem(F.proposals.retire), sid: NW.id });
  await ui.settle();
  shows(ui.text(), ['Retire Marketing Manager; the Marketing department closes', 'Marketing Manager moves to an agency.', 'None: no one reports to it', 'Closes the Marketing department']);
  assert.doesNotMatch(ui.text(), /Also retires/);
  const moved = { ...F.proposals.retire, draft: { ...F.proposals.retire.draft, retires: ['legal'], moves: [{ id: 'tax', from: 'legal', to: null }] } };
  ui.mount(C.TeamItem, { item: propItem(moved), sid: NW.id });
  await ui.settle();
  shows(ui.text(), ['Tax Specialist moves up to the CEO']);
  const too = { ...F.proposals.retire, draft: { ...F.proposals.retire.draft, name: 'Tax Specialist', reports_on_retire: 'retire-too', retires: ['payroll-tax', 'tax'], moves: [] }, target: 'tax' };
  ui.mount(C.TeamItem, { item: propItem(too), sid: NW.id });
  await ui.settle();
  shows(ui.text(), ['Also retires', 'Payroll Tax Specialist', 'They retire with it']);
  ui.mount(C.TeamItem, { item: propItem(F.proposals.company), sid: NW.id });
  await ui.settle();
  shows(ui.text(), ['New company: Harbor Studio', 'Harbor Studio', F.proposals.company.draft.folders[0]]);
});

test('engine access card, once-only + inside ~/.claude: the who line from the path, the warning, no Approve always and why', async (t) => {
  if (skip(t)) return;
  freshNw();
  ui.mount(Q.RequestItem, { item: fx().access.onceOnly, sid: TS.id });
  await ui.settle();
  const txt = ui.text();
  shows(txt, ['Tax Specialist asks to read', 'Northwind Goods › CEO › General Counsel › Tax Specialist', 'To see which model the CLI defaults to.',
    'This is inside ~/.claude (Claude settings and history).', 'It is beyond the company folders, so it can only be approved once.', 'No answer in 30 min counts as Deny.']);
  assert.deepEqual(acts(), ['access-once', 'access-deny']);
  assert.doesNotMatch(txt, /Approve always|true/);
});

test('engine access card that widens managers: ancestor ids in names on the always button, from the path when no chat is open', async (t) => {
  if (skip(t)) return;
  const item = fx().access.widens;
  freshNw();
  ui.mount(Q.RequestItem, { item, sid: PT.id });
  await ui.settle();
  shows(ui.text(), ['Payroll Tax Specialist asks to run shell commands', 'Northwind Goods › CEO › General Counsel › Tax Specialist › Payroll Tax Specialist', 'Bash read-only: listing and reading commands']);
  assert.equal(ui.text(node('access-always')), 'Approve always (also widens Tax Specialist and General Counsel)');
  freshNw([PT]);   // no chat open for tax or legal: the names come from access.position.path
  ui.mount(Q.RequestItem, { item, sid: PT.id });
  await ui.settle();
  assert.equal(ui.text(node('access-always')), 'Approve always (also widens Tax Specialist and General Counsel)');
  assert.deepEqual(Q.accessModel({ ...item, access: { ...item.access, ancestors: ['legal'] } }, PT).ancestors, [{ id: 'legal', name: 'General Counsel' }], 'a subset: named by access.names');
  assert.deepEqual(Q.accessModel({ ...item, access: { ...item.access, names: undefined, ancestors: ['legal'] } }, PT).ancestors, [{ id: 'legal', name: 'Legal' }], 'no names map and no chat open: the id in words (older engines)');
});

test('engine access records: timeout, an always on a once-only card was saved once, a real always names who it saved to', async (t) => {
  if (skip(t)) return;
  const F = fx();
  const rec = async (item, sid) => { freshNw(); ui.mount(Q.RequestItem, { item, sid }); await ui.settle(); return ui.text(); };
  assert.equal(await rec({ ...F.access.widens, status: 'cancelled', answer: { timedOut: true } }, PT.id), 'No answer in 30 min · Payroll Tax Specialist carries on without Bash read-only');
  assert.equal(await rec({ ...F.access.onceOnly, status: 'answered', answer: { behavior: 'allow', scope: 'always' } }, TS.id),
    'Approved once (beyond the company folders, so once only) · Tax Specialist · settings.json');
  assert.equal(await rec({ ...F.access.widens, status: 'answered', answer: { behavior: 'allow', scope: 'always' } }, PT.id),
    'Approved always · saved to Payroll Tax Specialist, Tax Specialist and General Counsel · Bash read-only');
  assert.equal(await rec({ ...F.access.widens, status: 'cancelled' }, PT.id), 'Request withdrawn · Bash read-only');
  const out = { ...F.access.widens, access: { ...F.access.widens.access, kind: 'outward', outward: true, target: 'git push', command: 'git push' } };
  assert.equal(await rec({ ...out, status: 'answered', answer: { behavior: 'allow', scope: 'always' } }, PT.id), 'Approved once (outward actions are never standing) · Payroll Tax Specialist · git push');
  freshNw();
  ui.mount(Q.RequestItem, { item: out, sid: PT.id });
  await ui.settle();
  assert.equal(ui.findAll((n) => n.t === 'codeview')[0].p.code, 'git push', 'an outward request_access shows the command it named');
  assert.equal(ui.findAll((n) => n.t === 'jsonview').length, 0);
});

test('ask timer: sinceMs is the time in the state at the event; the card adds the wall time since it first saw that value', (t) => {
  if (skip(t)) return;
  const item = (sinceMs, detail = 'working 30s') => ask({ team: { ticket: 't_tick', state: 'delivered', detail, chain: [{ ticket: 't_tick', parentTicket: null, to: 'legal', name: 'Legal', state: 'delivered', detail, sinceMs }] } });
  assert.equal(C.askModel(item(30_000), NOW, 1_000).line.text, 'Legal is working · 30s');
  assert.equal(C.askModel(item(30_000), NOW, 16_000).line.text, 'Legal is working · 45s', 'ticks with the clock');
  assert.equal(C.askModel(item(30_000), NOW, 91_000).line.text, 'Legal is working · 2m');
  assert.equal(C.askModel(item(2_000, 'working 2s'), NOW, 95_000).line.text, 'Legal is working · 2s', 'a new event (new sinceMs) starts over');
  assert.equal(C.liveSince('t_epoch', NOW - 120_000, NOW), 120_000, 'an epoch value (older shape) still reads');
  const w = "waiting for the owner's OK on Tax Specialist's access request";
  const acc = C.askModel(ask({ team: { ticket: 't_ac', state: 'delivered', detail: w, chain: [{ ticket: 't_ac', to: 'legal', name: 'Legal', state: 'delivered', detail: w, sinceMs: 0 }] } }), NOW);
  assert.equal(acc.line.tone, 'waiting');
  // 'late' is the display state of an open late ticket AND of an answer that came late: the detail words decide
  const late = (detail) => C.askModel(ask({ status: 'done', result: JSON.stringify({ status: 'pending', ticket: 't_late' }), team: { ticket: 't_late', state: 'late', detail, chain: [{ ticket: 't_late', to: 'legal', name: 'Legal', state: 'late', detail, sinceMs: 0 }] } }), NOW);
  assert.deepEqual([late('answered in 41m (late)').phase, late('answered in 41m (late)').late], ['answered', true]);
  assert.equal(late('late: working 3m').phase, 'pending');
  assert.equal(late('late: queued: The owner is talking with Legal').release.ticket, 't_late');
});

test('Let it answer now: only for an ask queued because the owner is talking with it; calls team.ask.release, spins, toasts a failure', async (t) => {
  if (skip(t)) return;
  const q = (ticket, detail, over = {}) => ask({ team: { ticket, state: 'asked', detail, chain: [{ ticket, parentTicket: null, to: 'legal', name: 'Legal', state: 'asked', detail, sinceMs: 4000 }] }, ...over });
  fresh();
  ui.mount(C.AskCard, { item: q('t_busy', 'queued: Legal is busy'), sid: CEO.id });
  await ui.settle();
  assert.match(ui.text(), /Queued · Legal is busy/);
  assert.equal(node('ask-release'), undefined, 'busy with other work: nothing to release');
  const d = deferred();
  fresh({ rpc: async (m) => (m === 'team.ask.release' ? d.p : undefined) });
  ui.mount(C.AskCard, { item: q('t_rel', 'queued: The owner is talking with Legal'), sid: CEO.id });
  await ui.settle();
  assert.match(ui.text(), /Queued · you are talking with Legal/);
  assert.equal(ui.text(node('ask-release')), 'Let it answer now');
  ui.click('ask-release'); await ui.settle();
  assert.deepEqual(R.rpcLog[0], ['team.ask.release', { ticket: 't_rel' }]);
  assert.ok(ui.findAll((n) => n.t === 'span' && /spinner/.test(n.p.class || '')).length, 'spins while it goes');
  assert.equal(node('ask-release').p.disabled, true);
  d.res({ state: 'queued' }); await ui.settle();
  assert.equal(node('ask-release'), undefined);
  assert.match(ui.text(), /Let through: Legal takes it as soon as its current turn ends\./);
  fresh({ rpc: async (m) => { if (m === 'team.ask.release') throw new Error('No ticket'); } });
  ui.mount(C.AskCard, { item: q('t_fail', 'queued: The owner is talking with Legal', { status: 'done', result: JSON.stringify({ status: 'pending', ticket: 't_fail' }) }), sid: CEO.id });
  await ui.settle();
  ui.click('ask-release'); await ui.settle();
  assert.equal(R.toasts[0].title, 'Could not let Legal answer now');
  assert.ok(node('ask-release'), 'still offered after a failure');
});

test('duty triggers: triggerLabel strings and the onboarding object in plain words', (t) => {
  if (skip(t)) return;
  const w = C.triggerWords;
  assert.equal(w('schedule 0 9 1 * *'), 'Monthly on the 1st at 09:00');
  assert.equal(w('commit C:/Users/you/northwind-shop main'), 'on a new commit to northwind-shop (main)');
  assert.equal(w('commit C:/Users/John Smith/shop main'), 'on a new commit to shop (main)');
  assert.equal(w('commit C:/Users/you/northwind-shop'), 'on a new commit to northwind-shop');
  assert.equal(w('release C:/x/app v*'), 'on a new tag v* in app');
  assert.equal(w('release C:/x/app v1.3.0'), 'on a new tag v1.3.0 in app');
  assert.equal(w('file C:/x/site/pricing.json'), 'when pricing.json changes');
  assert.equal(w('manual'), 'run by you');
  assert.equal(w({ kind: 'onboarding' }), 'onboarding');
  assert.equal(w({ kind: 'schedule', cron: '0 9 * * 1-5' }), 'Weekdays at 09:00');
  const duty = C.askedByModel({ origin: 'duty', text: '<helm-duty id="monthly-deadlines">\nList the filings.\n</helm-duty>', duty: { id: 'monthly-deadlines', title: 'Monthly deadlines', trigger: 'schedule 0 9 1 * *' } }, TAX);
  assert.deepEqual([duty.label, duty.sub, duty.text], ['Duty · Monthly deadlines', 'Monthly on the 1st at 09:00', 'List the filings.']);
  const onb = C.askedByModel({ origin: 'duty', text: 'Read your brief.', duty: { id: 'onboarding', title: 'Onboarding', trigger: { kind: 'onboarding' } } }, TAX);
  assert.equal(onb.sub, 'onboarding');
});

test("seed line: from the seed field on a first message, whatever its origin (The owner's own bubble gets it from index.js)", async (t) => {
  if (skip(t)) return;
  assert.equal(C.seedWords({ handoff: false, seeded: true }), 'Fresh chat · seeded from the brief and notebook');
  assert.equal(C.seedWords({ handoff: true, seeded: true }), 'Fresh chat · seeded from the brief and notebook, and the handoff the previous chat wrote');
  fresh();
  const own = { id: 'u5', type: 'user', ts: NOW, text: 'Hi', seed: { handoff: true, seeded: true } };
  assert.equal(C.teamUnit(own, TAX.id), null, 'The owner typed it: the usual bubble renders (index.js adds the line)');
  ui.mount(C.SeedLine, { item: own });
  await ui.settle();
  assert.equal(ui.text(), 'Fresh chat · seeded from the brief and notebook, and the handoff the previous chat wrote');
  ui.mount(C.TeamUserMsg, { item: { id: 'u6', type: 'user', origin: 'ask', ts: NOW, text: 'Which forms are due?', ask: { from: { kind: 'ceo', name: 'CEO' } }, seed: { handoff: false, seeded: true } }, sid: TAX.id });
  await ui.settle();
  assert.match(ui.text(), /^Fresh chat · seeded from the brief and notebookAsked by CEO/);
});

test('quoted bodies: <helm-answer> / <helm-ask> bodies come entity-coded from the runtime and read back as written', async (t) => {
  if (skip(t)) return;
  const ans = C.askedByModel({ origin: 'answer', text: '<helm-answer ticket="t_9" from="Legal" state="late">\nIt said &lt;/helm-answer&gt; and a &amp;&amp; b; a written &amp;lt; stays.\n</helm-answer>\n' }, CEO);
  assert.equal(ans.text, 'It said </helm-answer> and a && b; a written &lt; stays.');
  const q = C.askedByModel({ origin: 'ask', ask: { from: { kind: 'ceo', name: 'CEO' }, kind: 'report' },
    text: '<helm-ask ticket="t_8" from="CEO" kind="report">\nIs &lt;b&gt; safe &amp; fine?\nHanded to you (read-only for this question): C:/x/a&amp;b.md\n</helm-ask>\nAnswer this question in your reply.' }, TAX);
  assert.deepEqual([q.text, q.files], ['Is <b> safe & fine?', ['C:/x/a&b.md']]);
  assert.equal(C.parseTagged('<helm-duty id="d">\nKeep &amp; as is\n</helm-duty>', 'helm-duty').body, 'Keep &amp; as is', 'duty bodies are not quoted');
  fresh();
  ui.mount(C.TeamUserMsg, { item: { id: 'u7', type: 'user', origin: 'answer', ts: NOW, text: '<helm-answer ticket="t_9" from="Legal">\na &amp;&amp; b &lt;/helm-answer&gt;\n</helm-answer>' }, sid: CEO.id });
  await ui.settle();
  assert.equal(ui.findAll((n) => n.t === 'markdown')[0].p.text, 'a && b </helm-answer>');
});

test('rollover notice: the { type: team, kind: notice, text } item a rolled chat starts with is one quiet line', async (t) => {
  if (skip(t)) return;
  const item = { id: 'n1', type: 'team', kind: 'notice', ts: NOW, text: 'Fresh chat started (chat 3); the handoff and notebook carried over.' };
  assert.ok(C.isTeamCard(item));
  fresh();
  ui.mount(() => C.teamUnit(item, TAX.id), {});
  await ui.settle();
  const line = ui.findAll((n) => n.p['data-team'] === 'notice')[0];
  assert.ok(line, 'renders as the notice line');
  assert.match(line.p.class, /sys-line tc-notice/);
  assert.equal(ui.text(), 'Fresh chat started (chat 3); the handoff and notebook carried over.');
  assert.deepEqual(acts(), [], 'nothing to press');
});

// ---------- departments (spec 2.4): deptChange in words, the Department field row, p.names before any guess ----------
test('department cards: new / rename / close / join in words; a Department field row; names from p.names, never the id in words', async (t) => {
  if (skip(t)) return;
  freshNw([NW]);   // no position chat open: every name comes from the card
  const nu = { id: 'p_d1', company: 'northwind-goods', action: 'create', target: 'bizdev', status: 'open', title: 'New department: Business Development, headed by Head of Business Development',
    draft: { id: 'bizdev', name: 'Head of Business Development', parent: null, department: 'Business Development', remit: 'Partnerships and new markets.' },
    names: { bizdev: 'Head of Business Development' }, deptChange: { kind: 'new', name: 'Business Development', head: 'bizdev', headName: 'Head of Business Development' } };
  ui.mount(C.TeamItem, { item: propItem(nu), sid: NW.id });
  await ui.settle();
  shows(ui.text(), ['New department: Business Development, headed by Head of Business Development', 'Reports to', 'the CEO', 'Department', 'Starts the Business Development department, headed by Head of Business Development']);
  assert.equal(ui.findAll((n) => n.p && n.p['data-dept-change'] === 'new').length, 1);

  // a rename is an edit of the head: the Department field row says it, so no second sentence
  const rename = { id: 'p_d2', company: 'northwind-goods', action: 'edit', target: 'legal', status: 'open', title: 'Rename department: Legal to Legal & Compliance',
    diff: { department: { from: 'Legal', to: 'Legal & Compliance' } }, names: { legal: 'General Counsel' },
    deptChange: { kind: 'rename', from: 'Legal', name: 'Legal & Compliance', head: 'legal', headName: 'General Counsel' } };
  ui.mount(C.TeamItem, { item: propItem(rename), sid: NW.id });
  await ui.settle();
  const txt = ui.text();
  shows(txt, ['Rename department: Legal to Legal & Compliance', 'Department', 'Legal→Legal & Compliance']);
  assert.doesNotMatch(txt, /Renames the Legal department|Nothing that differs/);
  assert.equal(ui.findAll((n) => n.p && n.p['data-field'] === 'department').length, 1);

  // no engine title: the card words the change itself, names from p.names
  const { title: _t, ...untitled } = rename;
  ui.mount(C.TeamItem, { item: propItem(untitled), sid: NW.id });
  await ui.settle();
  shows(ui.text(), ['Rename department: Legal to Legal & Compliance']);
  const close = { id: 'p_d3', company: 'northwind-goods', action: 'edit', target: 'legal', status: 'open', diff: { department: { from: 'Legal', to: null } }, names: { legal: 'General Counsel' },
    deptChange: { kind: 'close', name: 'Legal', head: 'legal', headName: 'General Counsel' } };
  ui.mount(C.TeamItem, { item: propItem(close), sid: NW.id });
  await ui.settle();
  shows(ui.text(), ['Close department: Legal', 'Legal→No department']);

  // a create under a department: "In Legal"; the parent named from p.names, not "Tax" from its id
  const join = { id: 'p_d4', company: 'northwind-goods', action: 'create', target: 'vat', status: 'open', draft: { id: 'vat', name: 'VAT Specialist', parent: 'tax' },
    names: { vat: 'VAT Specialist', tax: 'Tax Specialist', legal: 'General Counsel' }, deptChange: { kind: 'join', name: 'Legal', head: 'legal', headName: 'General Counsel' },
    excess: [{ power: 'bash', value: 'on', max: 'off', by: 'legal' }] };
  ui.mount(C.TeamItem, { item: propItem(join), sid: NW.id });
  await ui.settle();
  shows(ui.text(), ['New position: VAT Specialist under Tax Specialist', 'In Legal (head: General Counsel)', 'General Counsel has no Bash']);
  assert.doesNotMatch(ui.text(), /Legal has no Bash/);
  assert.equal(C.namesFor(join)('legal'), 'General Counsel');
  assert.equal(C.namesFor({ ...join, names: undefined })('legal'), 'Legal', 'older engines without names: the id in words');
});

test('tool rows and ask cards name a position by its open chat, not by its id in words', (t) => {
  if (skip(t)) return;
  freshNw([NW, PT, TS, NWP('legal', 'General Counsel', null)]);
  assert.equal(C.teamToolDescribe({ name: 'mcp__team__team_roster', status: 'done', input: { under: 'legal' } }).target, 'General Counsel');
  assert.equal(C.teamToolDescribe({ name: 'mcp__team__team_propose', status: 'done', input: { action: 'edit', id: 'tax' } }).target, 'edit Tax Specialist');
  assert.equal(C.teamToolDescribe({ name: 'mcp__team__team_roster', status: 'done', input: { under: 'finance' } }).target, 'Finance', 'no chat open: the id in words');
  assert.equal(C.posName('legal'), 'General Counsel');
  assert.equal(C.posName(''), '');
});
