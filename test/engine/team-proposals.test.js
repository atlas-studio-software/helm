// Positions: proposals (main/engine/team/proposals.js, docs/POSITIONS.md 6). Every test works in its own temp copy of
// docs/positions.example (the fictional "Northwind Goods"). Nothing here touches ~/helm-team or a running Helm.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTeamStore } = require('../../main/engine/team/store');
const { createProposals, parseImport } = require('../../main/engine/team/proposals');

const EXAMPLE = path.join(__dirname, '..', '..', 'docs', 'positions.example');
const CID = 'northwind-goods';
const temps = [];
test.after(() => { for (const d of temps) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-proposals-test-'));
  temps.push(d);
  return d;
}

const POWERS = { read: ['$workspace', '$company'], write: ['$workspace'], tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'WebSearch'], bash: 'off', agents: false, worktree: false };
const BRIEF = '# Role\n\nCovers one narrow area.\n\n## Never\n- Send anything outward.\n';
const NOTEBOOK = '# Shipping Rates · notebook\n## Decisions\n- Carrier list frozen for Q1 (owner, 2026-01-10)\n## Facts\n- Flat rate is 5.00 (rates.md)\n## Open items\n- [ ] Check the oversize rule\n## Log\n- Notebook drafted.\n';

function setup({ withExample = true, tickets = [], ownerName = 'Owner' } = {}) {
  const root = tempDir();
  if (withExample) fs.cpSync(EXAMPLE, root, { recursive: true });
  let now = Date.parse('2026-02-01T12:00:00Z');
  const clock = { now: () => (now += 1000) };
  const store = createTeamStore({ root, houseRulesDefault: '# House rules\n', now: () => now });
  const slices = new Map();
  const state = { get: (n) => slices.get(n), set: (n, v) => slices.set(n, JSON.parse(JSON.stringify(v))) };
  const rec = { events: [], notes: [], notifies: [], cards: [], patches: [], onboard: [], applied: [] };
  const sessions = {
    addCard: (sid, item) => { rec.cards.push({ sid, item }); return `i${rec.cards.length}`; },
    patchCard: (sid, key, patch) => { rec.patches.push({ sid, key, patch }); return true; },
    note: (sid, text, o) => rec.notes.push({ sid, text, wake: !!(o && o.wake) }),
    ceoSessions: (cid) => (cid === CID ? ['s_ceo'] : []),
    positionSession: (cid, pid) => (pid === 'legal' ? 's_legal' : pid === 'tax' ? 's_tax' : null),
  };
  const runtime = { list: () => tickets };
  const mk = () => createProposals({
    store, runtime, state, sessions, clock, ownerName,
    emit: (e, p) => rec.events.push({ e, p }),
    notify: (n) => rec.notifies.push(n),
    onboard: (x) => rec.onboard.push(x),
    onApplied: (x) => rec.applied.push(x),
  });
  return { root, store, state, rec, P: mk(), mk, tickets };
}

const ceo = (sid = 's_ceo') => ({ kind: 'ceo', sessionId: sid });
const createDraft = (over = {}) => ({ name: 'Shipping Rates', remit: 'Carrier rates and shipping rules for the shop.', brief: BRIEF, powers: POWERS, why: 'Shipping questions keep coming up.', ...over });
const read = (root, ...p) => fs.readFileSync(path.join(root, CID, ...p), 'utf8');
const logLines = (root, cid, log) => { try { return fs.readFileSync(path.join(root, cid, `${log}.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

test('propose refuses with reasons: schema, why, taken id, folders outside the company, wrong parent for a position', () => {
  const { P } = setup();
  let r = P.propose({ company: CID, by: ceo(), action: 'create', draft: createDraft({ why: '' }) });
  assert.ok(r.refused && r.reasons.some((x) => /^why/.test(x)));
  r = P.propose({ company: CID, by: ceo(), action: 'create', draft: createDraft({ effort: 'enormous' }) });
  assert.ok(r.refused && r.reasons.some((x) => /^effort/.test(x)), JSON.stringify(r));
  r = P.propose({ company: CID, by: ceo(), action: 'create', draft: createDraft({ brief: '' }) });
  assert.ok(r.refused && r.reasons.some((x) => /brief/.test(x)));
  r = P.propose({ company: CID, by: ceo(), action: 'create', draft: createDraft({ id: 'legal' }) });
  assert.ok(r.refused && r.reasons.some((x) => /already used/.test(x)), JSON.stringify(r));
  r = P.propose({ company: CID, by: ceo(), action: 'create', draft: createDraft({ scope: { kind: 'product', folder: 'C:/Users/you/elsewhere' } }) });
  assert.ok(r.refused && r.reasons.some((x) => /scope\.folder.*not inside/.test(x)), JSON.stringify(r));
  r = P.propose({ company: CID, by: { kind: 'position', id: 'tax', sessionId: 's_tax' }, action: 'create', draft: createDraft({ parent: 'legal' }) });
  assert.ok(r.refused && r.reasons.some((x) => /only under yourself/.test(x)));
  r = P.propose({ company: CID, by: { kind: 'none', sessionId: 's_x' }, action: 'create', draft: createDraft() });
  assert.ok(r.refused);
  r = P.propose({ company: CID, by: ceo(), action: 'edit', draft: { id: 'nobody', remit: 'x', why: 'y' } });
  assert.ok(r.refused && /not a live position/.test(r.reasons[0]));
  assert.equal(P.pendingCount(CID), 0);
});

test('propose refuses past the depth cap and past 10 direct reports', () => {
  const { P, store } = setup();
  // payroll-tax is at depth 3 (legal > tax > payroll-tax); add depth 4 and 5
  store.createPosition(CID, { id: 'd4', name: 'D4', remit: 'r', parent: 'payroll-tax', powers: POWERS }, { brief: BRIEF });
  store.createPosition(CID, { id: 'd5', name: 'D5', remit: 'r', parent: 'd4', powers: POWERS }, { brief: BRIEF });
  let r = P.propose({ company: CID, by: ceo(), action: 'create', draft: createDraft({ parent: 'd5' }) });
  assert.ok(r.refused && r.reasons.some((x) => /depth 6; the cap is 5/.test(x)), JSON.stringify(r));
  const top = store.tree(CID).reports(null).length;
  for (let i = top; i < 10; i++) store.createPosition(CID, { id: `top-${i}`, name: `Top ${i}`, remit: 'r', parent: null, powers: POWERS }, { brief: BRIEF });
  r = P.propose({ company: CID, by: ceo(), action: 'create', draft: createDraft() });
  assert.ok(r.refused && r.reasons.some((x) => /10 direct reports/.test(x)), JSON.stringify(r));
});

test('a new proposal for the same target from the same session supersedes the older one; another session is refused', () => {
  const { P, rec, root } = setup();
  const base = logLines(root, CID, 'proposals').length; // the example's own lines
  const a = P.propose({ company: CID, by: ceo(), action: 'create', draft: createDraft({ id: 'shipping' }) });
  assert.equal(a.status, 'shown');
  assert.deepEqual(a.where, ['this chat', 'Team view']);
  assert.equal(rec.cards[0].item.kind, 'proposal');
  assert.equal(rec.cards[0].item.key, a.proposal);
  const b = P.propose({ company: CID, by: ceo(), action: 'create', draft: createDraft({ id: 'shipping', remit: 'Rates, rules and carriers.' }) });
  assert.equal(P.get(a.proposal).status, 'superseded');
  assert.equal(P.get(b.proposal).status, 'open');
  assert.ok(rec.patches.some((p) => p.key === a.proposal && p.patch.proposal.status === 'superseded'));
  const c = P.propose({ company: CID, by: ceo('s_ceo_2'), action: 'create', draft: createDraft({ id: 'shipping' }) });
  assert.ok(c.refused && /already proposed/.test(c.reasons[0]));
  assert.deepEqual(P.open(CID).map((x) => x.id), [b.proposal]);
  const lines = logLines(root, CID, 'proposals').slice(base);
  assert.equal(lines.length, 3); // a, b, a superseded
  assert.equal(lines.find((l) => l.decision).decision.result, 'superseded');
});

test('create approve writes position.json, brief.md and the FULL notebook; notes, inbox, onboard, onApplied', () => {
  const { P, rec, root } = setup();
  const by = { kind: 'position', id: 'tax', sessionId: 's_tax' };
  const base = logLines(root, CID, 'proposals').length;
  const r = P.propose({ company: CID, by, action: 'create', draft: createDraft({ id: 'shipping', parent: 'tax', notebook: NOTEBOOK, seed: { notes: 'ignored when a full notebook is given', files: [{ path: 'C:/Users/you/northwind-shop/rates.md', why: 'the rate table' }] } }) });
  assert.equal(r.status, 'shown');
  assert.ok(r.where.includes('phone'));
  assert.equal(rec.notifies.length, 1);
  assert.match(rec.notifies[0].title, /Tax Specialist proposes a new report: Shipping Rates/);
  assert.equal(rec.notifies[0].source, 'team');
  assert.ok(logLines(root, CID, 'inbox').some((l) => l.kind === 'proposal' && l.needsOwen));
  const res = P.decide({ proposal: r.proposal, decision: 'approve', how: 'click' });
  assert.deepEqual(res, { ok: true, created: { company: CID, id: 'shipping' } });
  const pos = JSON.parse(read(root, 'positions', 'shipping', 'position.json'));
  assert.equal(pos.version, 1);
  assert.equal(pos.parent, 'tax');
  assert.deepEqual(pos.createdBy, { proposal: r.proposal, by: 'tax', how: 'click' });
  assert.equal(read(root, 'positions', 'shipping', 'brief.md'), BRIEF);
  const nb = read(root, 'positions', 'shipping', 'notebook.md');
  for (const h of ['## Decisions', '## Facts', '## Open items', '## Log']) assert.ok(nb.includes(h), h);
  assert.ok(nb.includes('Flat rate is 5.00') && nb.includes('Carrier list frozen') && nb.includes('- [ ] Check the oversize rule'));
  const card = P.get(r.proposal);
  assert.equal(card.status, 'approved');
  assert.equal(card.decidedHow, 'click');
  const lines = logLines(root, CID, 'proposals').slice(base);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].decision.result, 'approved');
  assert.ok(logLines(root, CID, 'inbox').some((l) => l.title === 'Shipping Rates created under Tax Specialist'));
  const proposerNote = rec.notes.find((n) => n.sid === 's_tax');
  assert.equal(proposerNote.text, `Owner approved ${r.proposal}: Shipping Rates created under Tax Specialist.`);
  assert.equal(proposerNote.wake, true);
  assert.ok(rec.notes.some((n) => n.sid === 's_ceo' && !n.wake && /roster/.test(n.text)));
  assert.equal(rec.onboard.length, 1);
  assert.strictEqual(rec.onboard[0].position, 'shipping', 'onboard gets the new position id (a string), not the position object');
  assert.strictEqual(rec.onboard[0].company, CID);
  assert.deepEqual(rec.onboard[0].files, [{ path: 'C:/Users/you/northwind-shop/rates.md', why: 'the rate table' }]);
  assert.deepEqual(rec.applied[0].created, { company: CID, id: 'shipping' });
  for (const e of ['team.proposal.updated', 'team.updated', 'team.inbox.appended']) assert.ok(rec.events.some((x) => x.e === e), e);
});

test('create approve with seed.notes only: the store seeds Facts; a CEO proposer gets no wake; the manager gets a note', () => {
  const { P, rec, root } = setup();
  const r = P.propose({ company: CID, by: ceo(), action: 'create', draft: createDraft({ id: 'shipping', parent: 'legal', seed: { notes: 'Rates live in rates.md' } }) });
  assert.ok(P.decide({ proposal: r.proposal, decision: 'approve', how: 'click' }).ok);
  const nb = read(root, 'positions', 'shipping', 'notebook.md');
  assert.match(nb, /## Facts\n\(seeded by ceo, 2026-02-01\)\n- Rates live in rates\.md/);
  assert.equal(rec.notes.find((n) => n.sid === 's_ceo').wake, false);
  assert.ok(rec.notes.some((n) => n.sid === 's_legal' && /created under Legal/.test(n.text)));
  assert.equal(rec.onboard.length, 0);
});

test('company proposal from a no-company chat: company null until approved, then created and logged', () => {
  const { P, root, store } = setup({ withExample: false });
  const by = { kind: 'none', sessionId: 's_free' };
  const r = P.propose({ company: null, by, action: 'company', draft: { name: 'Contoso Labs', folders: ['C:/Users/you/contoso'], why: 'Group the lab repos.' } });
  assert.equal(r.status, 'shown');
  const open = P.open(null);
  assert.equal(open.length, 1);
  assert.equal(open[0].company, null);
  assert.equal(open[0].target, 'contoso-labs');
  const res = P.decide({ proposal: r.proposal, decision: 'approve', how: 'click' });
  assert.deepEqual(res, { ok: true, created: { company: 'contoso-labs' } });
  assert.equal(store.getCompany('contoso-labs').name, 'Contoso Labs');
  const lines = logLines(root, 'contoso-labs', 'proposals');
  assert.deepEqual(lines.map((l) => (l.decision ? l.decision.result : 'proposal')), ['proposal', 'approved']);
  assert.equal(P.get(r.proposal).company, 'contoso-labs');
  assert.equal(P.open(null).length, 0);
  const again = P.propose({ company: null, by, action: 'company', draft: { id: 'contoso-labs', name: 'Contoso Labs', folders: ['C:/Users/you/other'], why: 'x' } });
  assert.ok(again.refused && /already exists/.test(again.reasons[0]));
});

const FIXTURE = () => ({
  kind: 'helm-team-proposals', status: 'pending', company: 'contoso-labs', draftedAt: '2026-02-01T10:00:00Z', draftedBy: 'a planning chat', note: 'example',
  proposals: [
    { ref: 'company', status: 'pending', team_propose: { action: 'company', id: 'contoso-labs', name: 'Contoso Labs', folders: ['C:/Users/you/contoso'], why: 'Group the lab repos.' } },
    { ref: 'ops', status: 'pending', team_propose: { action: 'create', id: 'ops', parent: null, name: 'Operations', remit: 'Orders and suppliers.', scope: { kind: 'company' }, brief: BRIEF, powers: POWERS, duties: [], model: null, effort: 'high', seed: { notes: 'Suppliers: two.', files: [{ path: 'C:/Users/you/contoso/suppliers.md', why: 'who supplies what' }] }, why: 'Orders pile up.' },
      notebook_md: '# Operations · notebook\n## Decisions\n## Facts\n- Two suppliers (suppliers.md)\n## Open items\n- [ ] Map the reorder points\n## Log\n' },
    { ref: 'buyer', status: 'pending', team_propose: { action: 'create', id: 'buyer', parent: 'ops', name: 'Buyer', remit: 'Reorders stock.', brief: BRIEF, powers: { ...POWERS, bash: 'on' }, model: null, why: 'Reorders are manual.' } },
    { ref: 'later', status: 'drafting', team_propose: { action: 'create', id: 'later', name: 'Later', remit: 'x', brief: BRIEF, why: 'x' } },
  ],
});

test('parseImport is pure: valid items, non-pending skipped, model null accepted', () => {
  const p = parseImport(JSON.stringify(FIXTURE()));
  assert.equal(p.company, 'contoso-labs');
  assert.deepEqual(p.items.map((i) => `${i.action}:${i.target}`), ['company:contoso-labs', 'create:ops', 'create:buyer']);
  assert.equal(p.items[1].draft.model, null);
  assert.ok(p.items[1].draft.notebook.includes('Two suppliers'));
  assert.deepEqual(p.errors.map((e) => e.ref), ['later']);
  assert.ok(parseImport('{').errors.length);
  assert.ok(parseImport({ kind: 'other' }).errors.length);
});

test('import loads open cards only (never approved), dedupes a re-import, and approval order is enforced', () => {
  const { P, root, store, rec } = setup({ withExample: false });
  const r = P.import(FIXTURE());
  assert.deepEqual(r.imported.map((i) => i.ref), ['company', 'ops', 'buyer']);
  assert.deepEqual(r.skipped.map((s) => s.ref), ['later']);
  assert.ok(P.list({ includeDecided: true }).every((c) => c.status === 'open'));
  assert.equal(store.getCompany('contoso-labs'), null);
  assert.equal(rec.cards.length, 0); // no session: no chat card
  assert.equal(rec.notifies.length, 0);
  const again = P.import(JSON.stringify(FIXTURE()));
  assert.equal(again.imported.length, 0);
  assert.ok(again.skipped.filter((s) => /already open/.test(s.reason)).length === 3);
  const id = Object.fromEntries(r.imported.map((i) => [i.ref, i.id]));
  // order: the child before its parent, the parent before its company
  let res = P.decide({ proposal: id.buyer, decision: 'approve', how: 'click' });
  assert.equal(res.ok, false);
  assert.match(res.error, /approve Contoso Labs .* first/);
  res = P.decide({ proposal: id.ops, decision: 'approve', how: 'click' });
  assert.equal(res.ok, false);
  assert.match(res.error, /approve Contoso Labs/);
  assert.equal(P.get(id.ops).status, 'open');
  assert.ok(P.get(id.ops).error);
  assert.ok(P.decide({ proposal: id.company, decision: 'approve', how: 'click' }).ok);
  res = P.decide({ proposal: id.buyer, decision: 'approve', how: 'click' });
  assert.equal(res.ok, false);
  assert.match(res.error, /approve Operations \(p_[0-9a-f]+\) first/);
  assert.equal(P.get(id.buyer).status, 'open');
  res = P.decide({ proposal: id.ops, decision: 'approve', how: 'click' });
  assert.deepEqual(res, { ok: true, created: { company: 'contoso-labs', id: 'ops' } });
  assert.equal(P.get(id.ops).error, undefined);
  const nb = fs.readFileSync(path.join(root, 'contoso-labs', 'positions', 'ops', 'notebook.md'), 'utf8');
  assert.ok(nb.includes('- [ ] Map the reorder points') && nb.includes('## Log'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'contoso-labs', 'positions', 'ops', 'position.json'), 'utf8')).createdBy.by, 'a planning chat');
  // the buyer's excess shows once its parent exists (bash on beyond Operations' off)
  assert.ok(P.get(id.buyer).excess.some((e) => e.power === 'bash'), JSON.stringify(P.get(id.buyer).excess));
  assert.ok(P.decide({ proposal: id.buyer, decision: 'approve', how: 'click' }).ok);
  // all lines (proposal lines buffered while the company did not exist) are in the new company's log
  const lines = logLines(root, 'contoso-labs', 'proposals');
  assert.equal(lines.filter((l) => !l.decision).length, 3);
  assert.equal(lines.filter((l) => l.decision && l.decision.result === 'approved').length, 3);
  // a re-import after approval loads nothing
  const third = P.import(FIXTURE());
  assert.equal(third.imported.length, 0);
});

test('excess is computed (not a refusal) when powers go beyond the manager', () => {
  const { P } = setup();
  const by = { kind: 'position', id: 'tax', sessionId: 's_tax' };
  const r = P.propose({ company: CID, by, action: 'create', draft: createDraft({ id: 'shipping', powers: { ...POWERS, bash: 'on', tools: [...POWERS.tools, 'Bash'] } }) });
  assert.equal(r.status, 'shown');
  const card = P.get(r.proposal);
  assert.ok(card.excess.length > 0);
  assert.ok(card.excess.some((e) => e.power === 'bash'), JSON.stringify(card.excess));
  // a given excess (from mcp.js) is kept as is
  const r2 = P.propose({ company: CID, by: ceo(), action: 'create', draft: createDraft({ id: 'other' }), excess: [{ power: 'tools', value: 'X', by: 'company' }] });
  assert.deepEqual(P.get(r2.proposal).excess, [{ power: 'tools', value: 'X', by: 'company' }]);
});

test('decline: status, note to the proposer without a wake; a decided or unknown proposal throws', () => {
  const { P, rec, root } = setup();
  const r = P.propose({ company: CID, by: { kind: 'position', id: 'tax', sessionId: 's_tax' }, action: 'create', draft: createDraft({ id: 'shipping' }) });
  assert.deepEqual(P.decide({ proposal: r.proposal, decision: 'decline', how: 'click', note: 'not yet' }), { ok: true });
  const c = P.get(r.proposal);
  assert.equal(c.status, 'declined');
  assert.equal(c.note, 'not yet');
  const n = rec.notes.find((x) => x.sid === 's_tax');
  assert.equal(n.wake, false);
  assert.match(n.text, /Owner declined p_[0-9a-f]+: .*Note: not yet/);
  assert.equal(fs.existsSync(path.join(root, CID, 'positions', 'shipping')), false);
  assert.throws(() => P.decide({ proposal: r.proposal, decision: 'approve', how: 'click' }), (e) => e.code === 'refused');
  assert.throws(() => P.decide({ proposal: 'p_nope', decision: 'approve', how: 'click' }), (e) => e.code === 'not_found');
  assert.equal(P.list({ company: CID }).length, 0);
  assert.equal(P.list({ company: CID, includeDecided: true }).length, 1);
});

test('retire: refused with open tickets; re-checked on approve; move-up applies', () => {
  const tickets = [];
  const { P, store } = setup({ tickets });
  tickets.push({ id: 't_1', company: CID, state: 'queued', to: 'payroll-tax', from: { kind: 'ceo' } });
  let r = P.propose({ company: CID, by: ceo(), action: 'retire', draft: { id: 'payroll-tax', why: 'Folded into Tax.' } });
  assert.ok(r.refused && /open tickets/.test(r.reasons[0]), JSON.stringify(r));
  tickets.length = 0;
  r = P.propose({ company: CID, by: ceo(), action: 'retire', draft: { id: 'tax', why: 'Legal covers it.' } });
  assert.equal(r.status, 'shown');
  tickets.push({ id: 't_2', company: CID, state: 'delivered', to: 'legal', from: { kind: 'position', id: 'tax' } });
  let res = P.decide({ proposal: r.proposal, decision: 'approve', how: 'click' });
  assert.equal(res.ok, false);
  assert.match(res.error, /open tickets/);
  assert.equal(P.get(r.proposal).status, 'open');
  tickets.length = 0;
  res = P.decide({ proposal: r.proposal, decision: 'approve', how: 'click' });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(store.getPosition(CID, 'payroll-tax').parent, 'legal');
  assert.equal(store.tree(CID).has('tax'), false);
  assert.match(P.get(r.proposal).result, /Tax Specialist retired \(1 report\(s\) moved up to Legal\)/);
});

test('edit: diff on the card, approve updates position.json and the brief', () => {
  const { P, store, root } = setup();
  const r = P.propose({ company: CID, by: ceo(), action: 'edit', draft: { id: 'marketing', remit: 'Posts and the newsletter.', brief: '# Marketing\n\nNew brief.\n', why: 'Narrower remit.' } });
  assert.equal(r.status, 'shown');
  const c = P.get(r.proposal);
  assert.deepEqual(c.diff.remit.to, 'Posts and the newsletter.');
  assert.ok(c.diff.brief.includes('+New brief.'));
  const before = store.getPosition(CID, 'marketing').version;
  assert.ok(P.decide({ proposal: r.proposal, decision: 'approve', how: 'click' }).ok);
  assert.equal(store.getPosition(CID, 'marketing').remit, 'Posts and the newsletter.');
  assert.equal(store.getPosition(CID, 'marketing').version, before + 1);
  assert.equal(read(root, 'positions', 'marketing', 'brief.md'), '# Marketing\n\nNew brief.\n');
  const same = P.propose({ company: CID, by: ceo(), action: 'edit', draft: { id: 'marketing', remit: 'Posts and the newsletter.', why: 'x' } });
  assert.ok(same.refused && /nothing to change/.test(same.reasons[0]));
});

test('typed approval: accepted only for the owner, one open card, shown last, a plain yes', () => {
  const { P } = setup();
  const r = P.propose({ company: CID, by: ceo(), action: 'create', draft: createDraft({ id: 'shipping' }) });
  const id = r.proposal;
  assert.equal(P.onUserMessage({ sessionId: 's_ceo', text: 'yes', origin: 'helm', lastShownId: id }), null);
  assert.equal(P.onUserMessage({ sessionId: 's_ceo', text: 'yes?', origin: 'user', lastShownId: id }), null);
  assert.equal(P.onUserMessage({ sessionId: 's_ceo', text: "don't", origin: 'user', lastShownId: id }), null);
  assert.equal(P.onUserMessage({ sessionId: 's_ceo', text: 'yes', origin: 'user', lastShownId: 'p_other' }), null);
  assert.equal(P.onUserMessage({ sessionId: 's_other', text: 'yes', origin: 'user', lastShownId: id }), null);
  const r2 = P.propose({ company: CID, by: ceo(), action: 'create', draft: createDraft({ id: 'returns', name: 'Returns' }) });
  assert.equal(P.onUserMessage({ sessionId: 's_ceo', text: 'yes', origin: 'user', lastShownId: r2.proposal }), null); // two open
  P.decide({ proposal: r2.proposal, decision: 'decline', how: 'click' });
  assert.equal(P.get(id).status, 'open');
  const hit = P.onUserMessage({ sessionId: 's_ceo', text: 'yes, go ahead', origin: 'user', lastShownId: id });
  assert.equal(hit.proposal, id);
  assert.deepEqual(hit.result, { ok: true, created: { company: CID, id: 'shipping' } });
  const c = P.get(id);
  assert.equal(c.decidedHow, 'typed');
  assert.equal(c.quote, 'yes, go ahead');
});

test('cards persist through the state slice', () => {
  const { P, mk } = setup();
  const r = P.propose({ company: CID, by: ceo(), action: 'create', draft: createDraft({ id: 'shipping' }) });
  const P2 = mk();
  assert.equal(P2.get(r.proposal).status, 'open');
  assert.equal(P2.pendingCount(CID), 1);
  assert.ok(P2.decide({ proposal: r.proposal, decision: 'approve', how: 'click' }).ok);
});

test('company edit (the CEO edit without an id): folders diff, approve updates company.json', () => {
  const { P, store } = setup();
  const r = P.propose({ company: CID, by: ceo(), action: 'edit', draft: { folders: ['C:/Users/you/northwind-shop', 'C:/Users/you/northwind-app', 'C:/Users/you/northwind-docs'], why: 'The docs repo too.' } });
  assert.equal(r.status, 'shown');
  const c = P.get(r.proposal);
  assert.equal(c.target, null);
  assert.deepEqual(c.diff.folders.added, ['C:/Users/you/northwind-docs']);
  assert.ok(P.decide({ proposal: r.proposal, decision: 'approve', how: 'click' }).ok);
  assert.equal(store.getCompany(CID).folders.length, 3);
  const pos = P.propose({ company: CID, by: { kind: 'position', id: 'legal', sessionId: 's_legal' }, action: 'edit', draft: { folders: ['C:/Users/you/x'], why: 'x' } });
  assert.ok(pos.refused);
});

test('owner name: notes to the proposer use ownerName (string or getter, read per message); empty reads "The owner"', () => {
  let name = 'Jordan';
  const { P, rec } = setup({ ownerName: () => name });
  const by = { kind: 'position', id: 'tax', sessionId: 's_tax' };
  const a = P.propose({ company: CID, by, action: 'create', draft: createDraft({ id: 'shipping', parent: 'tax' }) });
  P.decide({ proposal: a.proposal, decision: 'approve', how: 'click' });
  assert.match(rec.notes.find((n) => n.sid === 's_tax').text, /^Jordan approved p_/);
  name = '';
  const b = P.propose({ company: CID, by, action: 'create', draft: createDraft({ id: 'billing', name: 'Billing Desk', parent: 'tax' }) });
  P.decide({ proposal: b.proposal, decision: 'decline', how: 'click', note: 'later' });
  assert.match(rec.notes.filter((n) => n.sid === 's_tax').at(-1).text, /^The owner declined p_[0-9a-f]+: .*Note: later/);

  const u = setup({ ownerName: null });
  const c = u.P.propose({ company: CID, by, action: 'create', draft: createDraft({ id: 'shipping', parent: 'tax' }) });
  u.P.decide({ proposal: c.proposal, decision: 'approve', how: 'click' });
  assert.match(u.rec.notes.find((n) => n.sid === 's_tax').text, /^The owner approved p_/);
});

test('notify: a position proposal fires one notice with a team object (what proposal, action, subject, ids, names)', () => {
  const { normalizeNotice } = require('../../main/notify');
  const { P, rec } = setup();
  const by = { kind: 'position', id: 'tax', sessionId: 's_tax' };
  P.propose({ company: CID, by, action: 'create', draft: createDraft({ id: 'shipping', parent: 'tax' }) });
  assert.equal(rec.notifies.length, 1);
  const n = rec.notifies[0];
  assert.equal(n.sessionId, 's_tax');
  assert.equal(n.team.what, 'proposal');
  assert.equal(n.team.action, 'create');
  assert.equal(n.team.subject, 'Shipping Rates');
  assert.equal(n.team.company, CID);
  assert.equal(n.team.position, 'tax');
  assert.equal(n.team.positionName, 'Tax Specialist');
  assert.ok(n.team.companyName, 'the company name rides along');
  assert.equal(n.title, 'Tax Specialist proposes a new report: Shipping Rates');
  assert.equal(n.company, CID);
  assert.equal(n.view, undefined);
  assert.deepEqual(normalizeNotice(n), n);
  P.propose({ company: CID, by: ceo(), action: 'create', draft: createDraft({ id: 'billing', name: 'Billing Desk', parent: 'legal' }) });
  assert.equal(rec.notifies.length, 1, 'a CEO proposal is made in front of the owner: no push');
});
