// The Team view against the REAL engine (lane positions-fix): (a) ui/lib/positions-model.js on payloads the engine
// itself built (test/host/fixtures/team-engine.js: main/engine/team/* over a temp copy of docs/positions.example), and
// (b) SHAPE parity: ui/lib/mock-positions.js (the ?mock=1 backend the screenshots run on) has the same keys and types
// as the engine for every payload the view reads. An engine field rename fails here instead of hiding behind the mock.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const M = require('../../ui/lib/positions-model.js');
const { createMockTeam } = require('../../ui/lib/mock-positions.js');
const { engineFixtures } = require('./fixtures/team-engine.js');

const F = engineFixtures();
const NOW = new Date(2026, 10, 17, 12, 0).getTime();
// the example company's names (docs/positions.example/northwind-goods)
const NAMES = { legal: 'General Counsel', tax: 'Tax Specialist', 'payroll-tax': 'Payroll Tax Specialist', marketing: 'Marketing Manager' };

// keys + types: objects by their keys (sorted), arrays by their first element, null as 'null'
function shapeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0])] : [];
  if (typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shapeOf(v[k])]));
  return typeof v;
}
const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
// the department contract's optional card keys (docs/POSITIONS.md 2.4): compared on their own, never as a side effect
const DEPT_CARD_KEYS = ['names', 'deptChange'];
const isNameMap = (o) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.values(o).every((v) => typeof v === 'string' && v.length > 0);
// list entries keyed by their `power` (excess / limits: optional keys like max / kept depend on the power)
const byPower = (list) => Object.fromEntries((list || []).map((x) => [x.power, shapeOf(x)]));
function samePowers(engine, mock, what, min = 2) {
  const a = byPower(engine), b = byPower(mock);
  const common = Object.keys(a).filter((k) => k in b);
  assert.ok(common.length >= min, `${what}: at least ${min} powers to compare (engine ${Object.keys(a)}, mock ${Object.keys(b)})`);
  for (const k of common) assert.deepEqual(b[k], a[k], `${what}: the ${k} entry`);
  for (const x of mock || []) assert.ok(['read', 'write', 'tools', 'bash', 'agents', 'worktree', 'parent'].includes(x.power), `${what}: power ${x.power}`);
}

async function mock(mode = null) {
  const m = createMockTeam({ now: NOW, mode });
  const got = mode === 'imported' ? null : await m.rpc('team.get', { company: 'example-co' });
  return { ...m, got };
}

// ---------------------------------------------------------------- (a) the model on engine payloads
test('engine: powerRows on team.position marks TodoWrite (Tax Specialist), Bash (General Counsel), the outside folder, and nothing else', () => {
  const pos = F.positionPayload;
  const rows = M.powerRows(pos, NAMES, { companyFolders: F.companyFolders });
  const marked = rows.flatMap((r) => (r.items ? r.items.filter((i) => i.limitNote).map((i) => [r.key, i.value, i.limitedBy, i.limitNote]) : r.limitNote ? [[r.key, r.text, r.limitedBy, r.limitNote]] : []));
  assert.deepEqual(marked, [
    ['read', F.outside, 'the company folders', 'outside the company folders'],
    ['tools', 'TodoWrite', 'Tax Specialist', 'limited by Tax Specialist'],
    ['bash', 'Off', 'General Counsel', 'limited by General Counsel'],
  ]);
  const read = rows.find((r) => r.key === 'read').items;
  assert.deepEqual(read.slice(0, 2).map((i) => [i.label, i.partly]), [['Its workspace', false], ['Company folders', false]]);
  assert.equal(read[0].title, pos.effective.workspace);
  // the limitedBy map alone reads the same
  const viaMap = M.powerRows({ ...pos, effective: { ...pos.effective, limits: undefined } }, NAMES, { companyFolders: F.companyFolders });
  assert.deepEqual(viaMap.map((r) => (r.items ? r.items.map((i) => i.limitNote) : r.limitNote)), rows.map((r) => (r.items ? r.items.map((i) => i.limitNote) : r.limitNote)));
});

test('engine: proposalChanges on an edit card lists the field changes, the brief lines, powers, the duty and the cuts', () => {
  const p = F.proposals.edit;
  const ch = M.proposalChanges(p, NAMES, { duties: [] });
  assert.deepEqual(ch.fields.map((f) => [f.key, f.from, f.to]), [
    ['name', 'Payroll Tax Specialist', 'Contractor Payroll Specialist'],
    ['remit', p.diff.remit.from, 'Payroll tax and contractor withholding.'],
    ['scope', 'The whole company', `One product: ${M.baseName(F.app)}`],
  ]);
  assert.equal(ch.brief.added, 3);
  assert.equal(ch.brief.removed, 0);
  assert.deepEqual(ch.brief.rows.filter((r) => r.t === 'add').map((r) => r.text), ['## Contractors', '- Withholding rules for contractors abroad.', '']);
  assert.deepEqual(ch.powers.added.map((x) => [x.power, x.value, x.label]), [['write', '$scope', `Write its scope (${M.baseName(F.app)})`], ['bash', 'readonly', 'Bash read-only']]);
  assert.deepEqual(ch.powers.removed.map((x) => [x.power, x.value, x.label]), [['tools', 'WebSearch', 'WebSearch'], ['bash', 'off', 'Bash off']]);
  assert.deepEqual([ch.duties.added.map((d) => d.title), ch.duties.changed, ch.duties.removed], [['Quarterly withholding check'], [], []]);
  assert.equal(ch.excess.length, 2);
  assert.deepEqual(ch.excess.map((x) => [x.power, x.byName, x.why]), [['write', 'General Counsel', 'General Counsel does not have it'], ['bash', 'General Counsel', 'General Counsel has no Bash']]);
  // a reparent card: only "Reports to"
  assert.deepEqual(M.fieldChanges(F.proposals.reparent.diff, NAMES).map((f) => [f.label, f.from, f.to]), [['Reports to', 'General Counsel', 'the CEO']]);
});

test('engine: excessRows on a create card names who cuts each power; the headline counts them', () => {
  const p = F.proposals.create;
  const rows = M.excessRows(M.excessOf(p), NAMES, p.draft.scope);
  assert.deepEqual(rows.map((r) => [r.label, r.byName, r.why]), [
    ['WebFetch', 'Payroll Tax Specialist', 'Payroll Tax Specialist does not have it'],
    ['Bash on', 'General Counsel', 'General Counsel has no Bash'],
    ['Subagents', 'General Counsel', 'General Counsel does not have it'],
  ]);
  assert.match(M.excessHeadline(rows, p.draft.name), /^3 powers go beyond its manager's, so State Payroll Analyst will not have them/);
  const chips = M.draftPowerChips(p.draft.powers, p.draft.scope, p.excess);
  assert.deepEqual(chips.filter((c) => c.cut).map((c) => c.label), ['WebFetch', 'Bash on', 'Subagents']);
  // after the imported company exists, a root card cut by the company folders
  const web = F.imported.after.find((c) => c.target === 'web-copy');
  assert.deepEqual(M.excessRows(web.excess, {}).map((r) => [r.by, r.why]), [['company', 'outside the company folders']]);
});

test('engine: scopeWords never comes back empty for any card scope', () => {
  const scopes = [];
  for (const p of [...Object.values(F.proposals), ...F.imported.open]) {
    if (p.draft && 'scope' in p.draft) scopes.push(p.draft.scope);
    if (p.diff && p.diff.scope) scopes.push(p.diff.scope.from, p.diff.scope.to);
  }
  assert.ok(scopes.length >= 6);
  for (const s of scopes) assert.ok(M.scopeWords(s).length > 0, JSON.stringify(s));
});

test('engine: foldCrosstalk on team.crosstalk (folded, ISO) nests the child, epoch times, newest chain first', () => {
  const f = M.foldCrosstalk(F.crosstalk.entries);
  assert.deepEqual(f.map((e) => e.ticket), ['t_fx1', 't_0b01']);
  const [chain] = f;
  assert.deepEqual(chain.children.map((e) => e.ticket), ['t_fx2']);
  const child = chain.children[0];
  assert.deepEqual([typeof child.askedAt, child.doneAt - child.askedAt, child.tookMs], ['number', 61_000, 61_000]);
  assert.equal(M.crosstalkLine(child, NAMES, NOW).from, 'General Counsel');
  assert.equal(M.countCrosstalk(f), F.crosstalk.entries.length);
});

// ---------------------------------------------------------------- (b) mock vs engine: same keys and types
test('shape: a create card with excess (team.get proposals / team.position pending.proposals)', async () => {
  const { got } = await mock();
  const e = F.proposals.create;
  const m = got.proposals.find((p) => p.action === 'create' && p.status === 'open' && p.excess && p.excess.length);
  assert.ok(m, 'the mock has an open create card with excess');
  // names / deptChange: the department contract, checked on their own below (the engine may not carry them yet)
  assert.deepEqual(shapeOf(omit(m, ['by', ...DEPT_CARD_KEYS])), shapeOf(omit(e, ['by', ...DEPT_CARD_KEYS])));
  samePowers(e.excess, m.excess, 'create excess');
  // `by` per kind: the engine fixture's is the CEO's; the mock's CEO-made card must match it
  assert.deepEqual(shapeOf(got.proposals.find((p) => p.by.kind === 'ceo').by), shapeOf(e.by));
  assert.deepEqual(Object.keys(m.by).sort(), ['id', 'kind', 'sessionId'], 'a position\'s card: by { kind, id, sessionId }');
});

test('shape: an edit card and its diff (brief, powers, duties, name / remit / scope, excess)', async () => {
  const { got } = await mock();
  const e = F.proposals.edit;
  const m = got.proposals.find((p) => p.action === 'edit' && p.status === 'open');
  assert.ok(m && m.diff.brief && m.diff.powers && m.diff.duties && m.diff.scope, 'the mock has an open edit with a brief diff, powers, duties and scope');
  assert.deepEqual(shapeOf(omit(m.diff, ['excess', 'department'])), shapeOf(omit(e.diff, ['excess', 'department'])));
  assert.deepEqual(shapeOf(omit(m, ['diff', 'excess', ...DEPT_CARD_KEYS])), shapeOf(omit(e, ['diff', 'excess', ...DEPT_CARD_KEYS])));
  samePowers(e.diff.excess, m.diff.excess, 'edit diff.excess');
  samePowers(e.excess, m.excess, 'edit excess');
  // the brief diff is the engine's line format: every line starts with ' ', '-' or '+'
  assert.ok(m.diff.brief.split('\n').every((l) => /^[ +-]/.test(l)));
  assert.ok([...m.diff.powers.added, ...m.diff.powers.removed].every((s) => /^(read|write|tools|bash|agents|worktree): /.test(s)));
  // decided cards carry the engine's decision fields
  const dec = got.proposals.find((p) => p.status === 'approved');
  for (const k of ['decidedAt', 'decision', 'decidedHow', 'result']) assert.ok(k in dec, `approved card has ${k}`);
  assert.deepEqual(Object.keys(dec.decision).sort(), ['at', 'how', 'result']);
  assert.deepEqual(shapeOf(F.imported.companyCard.decision), shapeOf(dec.decision));
});

test('shape: team.position position.effective (expanded paths, workspace first, limits) and the limitedBy map', async () => {
  const { rpc } = await mock();
  const tp = await rpc('team.position', { company: 'example-co', id: 'tax' });
  const e = F.positionPayload, m = tp.position;
  assert.deepEqual(shapeOf(omit(m.effective, ['limits', 'limitedBy'])), shapeOf(omit(e.effective, ['limits', 'limitedBy'])));
  samePowers(e.effective.limits, m.effective.limits, 'effective.limits', 3);
  samePowers(e.effective.limitedBy, m.effective.limitedBy, 'effective.limitedBy', 3);
  assert.equal(m.effective.read[0], m.effective.workspace);
  assert.equal(e.effective.read[0], e.effective.workspace);
  // position keys: the engine's position.json (+ effective, limitedBy); createdBy only on positions a proposal made
  const ek = Object.keys(e), mk = Object.keys(m);
  assert.deepEqual(mk.filter((k) => !ek.includes(k)), []);
  assert.deepEqual(ek.filter((k) => !mk.includes(k)).filter((k) => k !== 'createdBy'), []);
  // limitedBy map: the same key forms ("<power>:<value>" or a bare flag power), string values
  const forms = (map) => Object.keys(map).map((k) => k.split(':')[0]).sort();
  assert.deepEqual(forms(m.limitedBy), forms(e.limitedBy));
  assert.ok(Object.values(m.limitedBy).every((v) => typeof v === 'string'));
  for (const x of m.effective.limits) {
    const key = ['bash', 'agents', 'worktree'].includes(x.power) ? x.power : `${x.power}:${x.value}`;
    assert.equal(m.limitedBy[key], x.by ?? 'company', key);
  }
});

test('shape: an access request (team.position pending.requests[].access)', async () => {
  const { rpc } = await mock();
  const legal = await rpc('team.position', { company: 'example-co', id: 'legal' });
  const m = legal.pending.requests[0];
  // wire.js team.position maps access.pending() rows to { requestId, sessionId, access, kind, target, at }
  const e = F.accessRows.map((r) => ({ requestId: r.requestId, sessionId: r.sessionId, access: r.access, kind: r.kind, target: r.target, at: r.at }));
  assert.equal(e.length, 2);
  assert.deepEqual(shapeOf(omit(m, ['access'])), shapeOf(omit(e[0], ['access'])));
  // access: the keys the engine sets (ancestors only when some, onceOnly / warn only when true), same types
  const engine = [F.access.onceOnly.access, F.access.widens.access];
  const types = {};
  for (const a of engine) for (const [k, v] of Object.entries(a)) types[k] = shapeOf(v);
  // access.names ({ [ancestorId]: name }, the department contract): its keys are ids, so it is checked as a name map,
  // not key by key; the engine's too, once the engine sets it
  for (const [k, v] of Object.entries(m.access)) if (k !== 'names') assert.deepEqual(shapeOf(v), types[k], `access.${k}`);
  // names sits beside ancestors (only when some), naming each one
  for (const [who, a] of [['mock', m.access], ['engine', engine[0]], ['engine', engine[1]]]) {
    assert.equal('names' in a, 'ancestors' in a, `${who} access: names only beside ancestors`);
    if ('names' in a) assert.deepEqual([isNameMap(a.names), Object.keys(a.names).sort()], [true, [...a.ancestors].sort()], `${who} access.names: { [ancestorId]: name }`);
  }
  assert.ok(engine.some((a) => 'names' in a), 'the engine fixture has a request with access.names');
  for (const k of ['kind', 'target', 'why', 'position', 'outward', 'waitMin']) assert.ok(k in m.access, `access.${k}`);
  assert.deepEqual(engine.map((a) => Object.keys(a).filter((k) => !(k in types))), [[], []]);
  for (const k of ['onceOnly', 'warn']) if (k in m.access) assert.equal(m.access[k], true, `${k} is only ever true`);
  if ('ancestors' in m.access) assert.ok(m.access.ancestors.length > 0, 'ancestors only when some');
});

test('shape: team.crosstalk entries (one per ticket, folded, ISO times)', async () => {
  const { rpc } = await mock();
  const ct = await rpc('team.crosstalk', { company: 'example-co' });
  assert.deepEqual(shapeOf(omit(ct, ['entries'])), shapeOf(omit(F.crosstalk, ['entries'])));
  const pick = (list, fn) => list.find(fn);
  const roles = {
    'a sub-ask, answered': (x) => x.parentTicket && x.state === 'answered',
    'the CEO\'s ask, still open': (x) => !x.parentTicket && x.from.kind === 'ceo' && !x.answer,
    'the CEO\'s ask, answered': (x) => !x.parentTicket && x.from.kind === 'ceo' && x.state === 'answered',
  };
  for (const [role, fn] of Object.entries(roles)) {
    const e = pick(F.crosstalk.entries, fn), m = pick(ct.entries, fn);
    assert.ok(e && m, `${role}: in both`);
    assert.deepEqual(shapeOf(m), shapeOf(e), role);
  }
  for (const x of ct.entries) assert.ok(!Number.isNaN(Date.parse(x.askedAt)) && (x.answeredAt == null || !Number.isNaN(Date.parse(x.answeredAt))), `${x.ticket} times are ISO`);
});

test('shape: team.list proposals, team.proposals and the import flow (?team=imported) match the engine', async () => {
  const { rpc } = await mock('imported');
  const list = await rpc('team.list');
  assert.equal(list.proposals.length, 1);
  const co = list.proposals[0];
  // team.list proposals: the engine's company card (proposed by a chat: by { kind: 'none', sessionId }) vs the import's
  assert.deepEqual(shapeOf(omit(co, ['by', 'ref', ...DEPT_CARD_KEYS])), shapeOf(omit(F.listProposals[0], ['by', ...DEPT_CARD_KEYS])));
  const eOpen = F.imported.open, mOpen = (await rpc('team.proposals', { status: 'open' })).proposals;
  assert.deepEqual(mOpen.map((p) => p.action), eOpen.map((p) => p.action), 'newest first: the position cards, then the company card');
  const noDept = (c) => shapeOf(omit(c, DEPT_CARD_KEYS));
  assert.deepEqual(noDept(co), noDept(eOpen.find((p) => p.action === 'company')));
  const eRoot = eOpen.find((p) => p.action === 'create' && p.parent == null), mRoot = mOpen.find((p) => p.action === 'create' && p.parent == null);
  const eKid = eOpen.find((p) => p.action === 'create' && p.parent != null), mKid = mOpen.find((p) => p.action === 'create' && p.parent != null);
  assert.deepEqual(noDept(mRoot), noDept(eRoot));
  assert.deepEqual(noDept(mKid), noDept(eKid));
  assert.ok(eOpen.every((p) => !('excess' in p)) && mOpen.every((p) => !('excess' in p)), 'no excess before the company exists');
  assert.ok(mOpen.filter((p) => p.action === 'create').every((p) => p.company === co.target));

  // approving a position card first: refused the same way, the card stays open with `error`
  const r1 = await rpc('team.decide', { proposal: mRoot.id, decision: 'approve' });
  assert.deepEqual(shapeOf(r1), shapeOf(F.imported.early));
  const pat = (s, card) => s.replace(card.draft.name, '<name>').replace(card.id, '<id>');
  assert.equal(pat(r1.error, co), pat(F.imported.early.error, eOpen.find((p) => p.action === 'company')));
  const mErr = (await rpc('team.proposals', {})).proposals.find((p) => p.id === mRoot.id);
  assert.deepEqual(noDept(mErr), noDept(F.imported.earlyCard));

  // approving the company card: the same result and the same card afterwards; root cards get their excess
  const r2 = await rpc('team.decide', { proposal: co.id, decision: 'approve' });
  assert.deepEqual(r2, { ...F.imported.approved, created: { company: co.target } });
  const after = (await rpc('team.proposals', { company: co.target })).proposals;
  assert.deepEqual(noDept(after.find((p) => p.id === co.id)), noDept(F.imported.companyCard));
  const has = (list) => list.filter((p) => p.status === 'open').map((p) => [p.target, 'excess' in p]).sort();
  assert.deepEqual(has(after).map(([, x]) => x).sort(), has(F.imported.after).map(([, x]) => x).sort(), 'which cards have excess once the company exists');
  const listed = (await rpc('team.list')).companies.find((c) => c.id === co.target);
  assert.deepEqual(Object.keys(listed).sort(), ['folders', 'id', 'name', 'needsYou', 'positions']);
});

// ---------------------------------------------------------------- departments (docs/POSITIONS.md 2.4)
// A department is a name on a top-level position (its HEAD); every position below the head is in it. team.get rows
// carry `department` + `departmentHead` (head and staff alike; a head's departmentHead is its own id); rows outside
// any department carry neither. Rows are compared KIND BY KIND (head / staff / none), so the optional keys never
// make a false failure. The engine side is wire.js team.get itself, over the same temp copy of docs/positions.example.
const DEPT_KEYS = ['department', 'departmentHead'];
const rowKind = (r) => (!('department' in r) ? 'none' : r.departmentHead === r.id ? 'head' : 'staff');
const deptKeysOf = (r) => Object.fromEntries(DEPT_KEYS.filter((k) => k in r).map((k) => [k, typeof r[k]]));
// the keys every team.get row has in the engine (the rest: nextDuty / lastActivity / busy / problem only when some)
const ROW_KEYS = ['id', 'name', 'parent', 'remit', 'status', 'depth', 'reports', 'openItems', 'pending'];
let engineGet = null;
async function engineTeam() {
  if (engineGet) return engineGet;
  const fs = require('fs'), os = require('os'), path = require('path');
  const { createTeamWiring } = require('../../main/engine/team/wire');
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-ui-team-ud-'));
  process.on('exit', () => { try { fs.rmSync(ud, { recursive: true, force: true }); } catch { /* best effort */ } });
  const team = createTeamWiring({ settings: () => ({ enabled: true }), root: () => F.root, rootProblem: () => null, userDataDir: ud, sessions: new Map(),
    createSession: async () => { throw new Error('no sessions in this test'); } });
  assert.equal(team.start(), true, 'the engine team starts over the example');
  try {
    const got = await team.methods['team.get']({ company: F.company });
    const heads = got.tree.filter((r) => rowKind(r) === 'head');
    const head = heads.length ? await team.methods['team.position']({ company: F.company, id: heads[0].id }) : null;
    engineGet = { got, head };
  } finally { team.stop({ recycle: false }); }
  return engineGet;
}
// a row's top-level ancestor (the department head when it heads one), derived independently of the mock
function topOf(byId, id) { let r = byId.get(id); while (r && r.parent != null && byId.has(r.parent)) r = byId.get(r.parent); return r; }

test('departments: team.get rows, head vs staff vs none, mock and engine alike', async (t) => {
  const { got, rpc } = await mock();
  const byId = new Map(got.tree.map((r) => [r.id, r]));
  const kinds = (tree) => Object.fromEntries(['head', 'staff', 'none'].map((k) => [k, tree.filter((r) => rowKind(r) === k).map((r) => r.id)]));
  // the mock: Legal (legal: tax, payroll, contracts), Marketing (marketing: social), Finance (finance), QA Engineer in none
  assert.deepEqual(kinds(got.tree), { head: ['legal', 'marketing', 'finance'], staff: ['tax', 'payroll', 'contracts', 'social'], none: ['qa'] });
  const tops = {};
  for (const r of got.tree.filter((x) => x.parent == null)) tops[r.id] = (await rpc('team.position', { company: 'example-co', id: r.id })).position.department;
  for (const r of got.tree) {
    for (const k of ROW_KEYS) assert.ok(k in r, `mock row ${r.id} has ${k}`);
    const top = topOf(byId, r.id), dept = tops[top.id];
    if (dept) assert.deepEqual([r.department, r.departmentHead], [dept, top.id], `${r.id} is in ${dept} (its top-level ancestor ${top.id})`);
    else assert.deepEqual(DEPT_KEYS.filter((k) => k in r), [], `${r.id}: no department keys outside a department`);
  }
  assert.equal(tops.legal, 'Legal', 'team.position carries a head\'s own department (position.json spread)');
  const tax = (await rpc('team.position', { company: 'example-co', id: 'tax' })).position;
  assert.ok(!('department' in tax), 'a staff position never stores `department` (it derives from its head)');
  // Harbor Books: no departments at all (the backward-compat scene)
  const harbor = await rpc('team.get', { company: 'harbor-books' });
  assert.ok(harbor.tree.length > 0 && harbor.tree.every((r) => DEPT_KEYS.every((k) => !(k in r))), 'Harbor Books rows carry no department keys');

  // the engine, kind by kind
  const { got: eg, head } = await engineTeam();
  for (const r of eg.tree) for (const k of ROW_KEYS) assert.ok(k in r, `engine row ${r.id} has ${k}`);
  const ek = kinds(eg.tree);
  if (!ek.head.length && !ek.staff.length) {
    for (const r of eg.tree) assert.deepEqual(deptKeysOf(r), {}, `engine row ${r.id}: no department keys`);
    t.skip('engine example has no departments yet (docs/positions.example + wire.js team.get carry none); only the mock side and the no-department kind were compared');
    return;
  }
  // docs/positions.example: legal heads "Legal" (tax, payroll-tax under it), marketing heads "Marketing", app-qa in none
  assert.ok(ek.head.includes('legal') && ek.head.includes('marketing'), `engine heads: ${ek.head}`);
  assert.ok(ek.none.includes('app-qa'), `engine rows outside a department: ${ek.none}`);
  for (const kind of ['head', 'staff', 'none']) {
    const e = eg.tree.find((r) => rowKind(r) === kind), m = got.tree.find((r) => rowKind(r) === kind);
    assert.ok(e && m, `a ${kind} row in both`);
    assert.deepEqual(deptKeysOf(m), deptKeysOf(e), `${kind} rows: the same department keys and types`);
    const base = (r) => shapeOf(Object.fromEntries(ROW_KEYS.map((k) => [k, r[k]])));
    assert.deepEqual(base(m), base(e), `${kind} rows: the same base keys and types`);
  }
  const eById = new Map(eg.tree.map((r) => [r.id, r]));
  for (const r of eg.tree) if (r.department) assert.equal(r.departmentHead, topOf(eById, r.id).id, `engine ${r.id}: departmentHead is its top-level ancestor`);
  assert.equal(typeof head.position.department, 'string', 'engine team.position carries a head\'s department');
});

test('departments: every proposal card carries `names` for each position id it mentions; deptChange per kind', async (t) => {
  const { got, rpc } = await mock();
  const imported = (await createMockTeam({ now: NOW, mode: 'imported' }).rpc('team.proposals', {})).proposals;
  const live = Object.fromEntries(got.tree.map((r) => [r.id, r.name]));
  const mentioned = (c) => [c.action !== 'company' ? c.target : null, c.parent, c.by && c.by.kind === 'position' ? c.by.id : null,
    ...(c.excess || []).map((x) => x.by), ...((c.diff && c.diff.excess) || []).map((x) => x.by), c.deptChange && c.deptChange.head]
    .filter((x) => typeof x === 'string' && x !== 'company');
  const all = [...got.proposals, ...imported];
  for (const c of all) {
    if (c.action === 'company') { assert.deepEqual(c.names ?? {}, {}, `${c.id}: a company card names no position`); continue; }
    assert.ok(isNameMap(c.names), `${c.id}: names is { [positionId]: name }`);
    for (const id of mentioned(c)) assert.ok(id in c.names, `${c.id}: names covers ${id}`);
    for (const [id, name] of Object.entries(c.names)) {
      const draft = all.find((y) => y.action === 'create' && y.target === id && y.company === c.company);
      assert.ok(name === live[id] || (draft && name === draft.draft.name), `${c.id}: ${id} is named from a position or a draft ("${name}"), never from its id`);
    }
  }
  // the open "new department" card
  const nd = got.proposals.find((c) => c.status === 'open' && c.deptChange && c.deptChange.kind === 'new');
  assert.ok(nd, 'an open new-department card');
  assert.deepEqual([nd.action, nd.parent, nd.draft.department, nd.title], ['create', null, 'Business Development', 'New department: Business Development, headed by Head of Business Development']);
  assert.deepEqual(nd.deptChange, { kind: 'new', name: 'Business Development', head: nd.target, headName: nd.draft.name });
  // deptChange keys per kind (the contract); a 'join' keeps its "New position" title
  const KEYS = { new: ['head', 'headName', 'kind', 'name'], rename: ['from', 'head', 'headName', 'kind', 'name'], close: ['head', 'headName', 'kind', 'name'],
    move: ['from', 'head', 'headName', 'kind', 'name'], join: ['head', 'headName', 'kind', 'name'] };
  const withDc = all.filter((c) => c.deptChange);
  assert.ok(withDc.some((c) => c.deptChange.kind === 'join'), 'a create under a department carries deptChange join');
  for (const c of withDc) {
    assert.deepEqual(Object.keys(c.deptChange).sort(), KEYS[c.deptChange.kind], `${c.id}: deptChange ${c.deptChange.kind} keys`);
    // strings; a move has null on one side (proposals.js): into a department from none -> from null, out of every
    // department -> name / head / headName null; never both
    const dc = c.deptChange;
    const nullable = dc.kind !== 'move' ? [] : dc.from === null ? ['from'] : dc.name === null ? ['name', 'head', 'headName'] : [];
    assert.ok(Object.entries(dc).every(([k, v]) => typeof v === 'string' || (v === null && nullable.includes(k))), `${c.id}: deptChange values`);
    if (dc.kind === 'move') assert.ok(dc.from !== null || dc.name !== null, `${c.id}: a move names at least one department`);
    if (c.deptChange.kind === 'join') assert.match(c.title, /^New position: /);
  }
  // approving it makes a head: its row is in Business Development, departmentHead = its own id
  assert.deepEqual(await rpc('team.decide', { proposal: nd.id, decision: 'approve' }), { ok: true, created: { company: 'example-co', id: nd.target } });
  const row = (await rpc('team.get', { company: 'example-co' })).tree.find((r) => r.id === nd.target);
  assert.deepEqual([row.department, row.departmentHead], ['Business Development', nd.target]);

  // the engine's cards: the same names shape, once the engine sets it
  const eCards = [...Object.values(F.proposals), ...F.imported.open, ...F.imported.after];
  if (!eCards.some((c) => 'names' in c)) { t.skip('engine proposal cards carry no `names` yet (proposals.js); only the mock side was checked'); return; }
  for (const c of eCards) {
    if (c.action === 'company') { assert.deepEqual(c.names ?? {}, {}, `engine ${c.id}: a company card names no position`); continue; }
    assert.ok(isNameMap(c.names), `engine ${c.id}: names is { [positionId]: name }`);
    for (const id of mentioned(c)) assert.ok(id in c.names, `engine ${c.id}: names covers ${id}`);
  }
  const eDc = eCards.filter((x) => x.deptChange);
  assert.ok(eDc.length > 0, 'the engine fixture has cards with deptChange');
  for (const c of eDc) assert.deepEqual(Object.keys(c.deptChange).sort(), KEYS[c.deptChange.kind], `engine ${c.id}: deptChange keys`);
  // the same kind in both: the same keys
  for (const c of withDc) { const e = eDc.find((x) => x.deptChange.kind === c.deptChange.kind); if (e) assert.deepEqual(Object.keys(c.deptChange).sort(), Object.keys(e.deptChange).sort(), `deptChange ${c.deptChange.kind}: mock vs engine`); }
});
