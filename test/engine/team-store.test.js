// Positions: the team root on disk (main/engine/team/store.js). Every test works in its own temp dir, usually a copy
// of docs/positions.example (a fictional company). Nothing here touches ~/helm-team.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createTeamStore, checkTeamRoot, defaultTeamRoot, TeamStoreError } = require('../../main/engine/team/store');
const S = require('../../main/engine/team/schema');

const EXAMPLE = path.join(__dirname, '..', '..', 'docs', 'positions.example');
const STORE = path.join(__dirname, '..', '..', 'main', 'engine', 'team', 'store.js');
const CID = 'northwind-goods';
const temps = [];
test.after(() => { for (const d of temps) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-team-test-'));
  temps.push(d);
  return d;
}
function exampleRoot() {
  const d = tempDir();
  fs.cpSync(EXAMPLE, d, { recursive: true });
  return d;
}
let clock = Date.parse('2026-02-01T12:00:00Z');
const open = (root, extra = {}) => createTeamStore({ root, houseRulesDefault: '# House rules\n1. Report faithfully.\n', now: () => clock, ...extra });
const pfile = (root, pid, name = 'position.json') => path.join(root, CID, 'positions', pid, name);
const readJ = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJ = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));
// mtime resolution: make sure a hand edit right after a Helm write is seen as a change
const bump = (f) => { const t = new Date(Date.now() + 2000); fs.utimesSync(f, t, t); };
function throwsCode(fn, code, re) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof TeamStoreError, `expected TeamStoreError, got ${e && e.stack}`);
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
}
const BRIEF = '# Role\n\nDoes the thing.\n';

test('default root is ~/helm-team and the example loads clean', () => {
  assert.equal(defaultTeamRoot(), path.join(os.homedir(), 'helm-team'));
  const root = exampleRoot();
  const s = open(root);
  assert.deepEqual(s.listCompanies().map((c) => c.id), [CID]);
  assert.deepEqual(s.listPositions(CID).map((p) => p.id).sort(), ['app-qa', 'legal', 'marketing', 'payroll-tax', 'tax']);
  assert.deepEqual(s.problems(), []);
  const t = s.tree(CID);
  assert.equal(t.depth('payroll-tax'), 3, 'a 3-level tree');
  assert.equal(s.readBrief(CID, 'legal').ok, true);
  assert.equal(s.readChats(CID, 'legal').chats.length, 2);
  assert.equal(s.readLog(CID, 'crosstalk').lines.length, 3);
  const e = s.effectivePowers(CID, 'payroll-tax');
  assert.equal(e.workspace, S.normPath(path.join(root, CID, 'positions', 'payroll-tax')));
  assert.deepEqual(e.read.slice(1), ['C:/Users/you/northwind-shop', 'C:/Users/you/northwind-app']);
});

test('ensureRoot writes README.md and house-rules.md once, then keeps the owner\'s edits', () => {
  const root = path.join(tempDir(), 'helm-team');
  const s = open(root);
  s.ensureRoot();
  assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /Helm team root/);
  assert.equal(s.houseRules().text, '# House rules\n1. Report faithfully.\n');
  fs.writeFileSync(path.join(root, 'house-rules.md'), '# Mine\n');
  s.ensureRoot();
  assert.equal(fs.readFileSync(path.join(root, 'house-rules.md'), 'utf8'), '# Mine\n');
  assert.equal(s.houseRules().text, '# Mine\n');
  fs.writeFileSync(path.join(root, 'house-rules.md'), '   ');
  bump(path.join(root, 'house-rules.md'));
  const r = s.houseRules();
  assert.equal(r.text, '# Mine\n', 'an emptied file keeps the last good rules in force');
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /house-rules.md: is empty/);
});

test('checkTeamRoot refuses a git work tree, a company folder (either way round) and the home folder', () => {
  const base = tempDir();
  fs.mkdirSync(path.join(base, 'repo', '.git'), { recursive: true });
  assert.match(checkTeamRoot(path.join(base, 'repo', 'team')).reason, /inside a git work tree/);
  const company = { name: 'Acme', folders: [S.normPath(path.join(base, 'acme'))] };
  assert.match(checkTeamRoot(path.join(base, 'acme', 'team'), { companies: [company] }).reason, /inside Acme's folder/);
  assert.match(checkTeamRoot(base, { companies: [company] }).reason, /is inside/);
  assert.match(checkTeamRoot(os.homedir()).reason, /whole home folder/);
  assert.equal(checkTeamRoot(path.join(base, 'team')).ok, true);
  const s = open(path.join(base, 'repo', 'team'));
  throwsCode(() => s.ensureRoot(), 'root', /git work tree/);
  assert.equal(fs.existsSync(path.join(base, 'repo', 'team')), false, 'nothing written into the repo');
});

test('createCompany: validated, one folder per company, never around the team root, versioned', () => {
  const root = exampleRoot();
  const s = open(root);
  const c = s.createCompany({ id: 'acme', name: 'Acme', folders: ['C:/Users/you/acme'] }, { createdBy: { proposal: 'p_1', how: 'click' } });
  assert.equal(c.version, 1);
  assert.equal(c.createdAt, new Date(clock).toISOString());
  assert.ok(fs.existsSync(path.join(root, 'acme', 'company.json.v1')));
  assert.ok(fs.existsSync(path.join(root, 'acme', 'positions')));
  throwsCode(() => s.createCompany({ id: 'acme', name: 'Again', folders: ['C:/Users/you/other'] }), 'exists');
  throwsCode(() => s.createCompany({ id: 'shop2', name: 'Shop 2', folders: ['C:/Users/you/northwind-shop/sub'] }), 'invalid', /overlaps Northwind Goods's folder/);
  throwsCode(() => s.createCompany({ id: 'wrap', name: 'Wrap', folders: [root] }), 'invalid', /overlaps the team root/);
  throwsCode(() => s.createCompany({ id: 'Bad', name: 'x', folders: ['C:/x'] }), 'invalid', /a-z/);
  const u = s.updateCompany('acme', { folders: ['C:/Users/you/acme', 'C:/Users/you/acme-site'] }, { expectVersion: 1 });
  assert.equal(u.version, 2);
  assert.equal(u.createdAt, c.createdAt);
  throwsCode(() => s.updateCompany('acme', { name: 'X' }, { expectVersion: 1 }), 'conflict');
  throwsCode(() => s.updateCompany('acme', { id: 'other' }), 'invalid', /never changes/);
  throwsCode(() => s.updateCompany('acme', { folders: ['C:/Users/you/northwind-app'] }), 'invalid', /overlaps/);
});

test('createPosition writes the folder of 6.5: position v1, brief, seeded notebook, chats [], work/drafts', () => {
  const root = exampleRoot();
  const s = open(root);
  const p = s.createPosition(CID, { id: 'bookkeeping', name: 'Bookkeeping', parent: 'tax', remit: 'Monthly books.' },
    { brief: BRIEF, seed: { notes: 'Books close on the 5th.\n- Two bank accounts.' }, createdBy: { proposal: 'p_9', by: 'tax', how: 'click' } });
  assert.equal(p.version, 1);
  assert.equal(p.status, 'active');
  assert.deepEqual(p.createdBy, { proposal: 'p_9', by: 'tax', how: 'click' });
  const dir = path.join(root, CID, 'positions', 'bookkeeping');
  assert.deepEqual(readJ(path.join(dir, 'position.json')), p);
  assert.deepEqual(readJ(path.join(dir, 'position.json.v1')), p);
  assert.equal(fs.readFileSync(path.join(dir, 'brief.md'), 'utf8'), BRIEF);
  assert.deepEqual(readJ(path.join(dir, 'chats.json')), []);
  assert.ok(fs.statSync(path.join(dir, 'work', 'drafts')).isDirectory());
  assert.equal(fs.readFileSync(path.join(dir, 'notebook.md'), 'utf8'),
    '# Bookkeeping · notebook\n## Decisions\n## Facts\n(seeded by tax, 2026-02-01)\n- Books close on the 5th.\n- Two bank accounts.\n## Open items\n## Log\n');
  assert.equal(s.tree(CID).depth('bookkeeping'), 3);
  assert.deepEqual(fs.readdirSync(path.join(root, CID, 'positions')).filter((n) => n.startsWith('.')), [], 'no temp folder left');
});

test('createPosition refuses: duplicate or retired id, depth cap, report cap, company cap, no brief, bad scope', () => {
  const root = exampleRoot();
  const s = open(root);
  const d = (id, parent, extra = {}) => ({ id, name: id, parent, remit: `${id} work`, ...extra });
  throwsCode(() => s.createPosition(CID, d('legal', null), { brief: BRIEF }), 'tree', /already used/);
  fs.mkdirSync(path.join(root, CID, 'retired', 'old-role'), { recursive: true });
  throwsCode(() => s.createPosition(CID, d('old-role', null), { brief: BRIEF }), 'tree', /retired ones too/);
  s.createPosition(CID, d('l4', 'payroll-tax'), { brief: BRIEF });
  s.createPosition(CID, d('l5', 'l4'), { brief: BRIEF });
  throwsCode(() => s.createPosition(CID, d('l6', 'l5'), { brief: BRIEF }), 'tree', /depth 6; the cap is 5/);
  throwsCode(() => s.createPosition(CID, d('x', 'ghost'), { brief: BRIEF }), 'tree', /not a live position/);
  throwsCode(() => s.createPosition(CID, d('nobrief', null), { brief: '  ' }), 'invalid', /empty/);
  throwsCode(() => s.createPosition(CID, d('elsewhere', null, { scope: { kind: 'product', folder: 'D:/other' } }), { brief: BRIEF }), 'invalid', /not inside Northwind/);
  throwsCode(() => s.createPosition(CID, d('bad', null, { powers: { tools: ['SendMessage'] } }), { brief: BRIEF }), 'invalid', /never given/);
  for (let i = 0; i < 7; i++) s.createPosition(CID, d(`top${i}`, null), { brief: BRIEF }); // CEO: 3 + 7 = 10
  throwsCode(() => s.createPosition(CID, d('top7', null), { brief: BRIEF }), 'tree', /the CEO already has 10/);
  for (let i = 0; i < 9; i++) s.createPosition(CID, d(`m${i}`, 'marketing'), { brief: BRIEF });
  for (let i = 0; i < 6; i++) s.createPosition(CID, d(`a${i}`, 'app-qa'), { brief: BRIEF });
  assert.equal(s.tree(CID).liveCount(), 29);
  s.createPosition(CID, d('last', 'legal'), { brief: BRIEF });
  throwsCode(() => s.createPosition(CID, d('one-too-many', 'legal'), { brief: BRIEF }), 'tree', /already 30 live positions/);
  throwsCode(() => s.createPosition('nope', d('x', null), { brief: BRIEF }), 'not-found');
});

test('updatePosition: version +1, a copy per version (last 10 kept), conflicts, immutable id, tree checks', () => {
  const root = exampleRoot();
  const s = open(root);
  const v2 = s.updatePosition(CID, 'marketing', { remit: 'Posts and release notes.' }, { expectVersion: 1 });
  assert.equal(v2.version, 2);
  assert.equal(v2.createdAt, '2026-01-05T09:10:00.000Z', 'createdAt is Helm\'s');
  throwsCode(() => s.updatePosition(CID, 'marketing', { name: 'X' }, { expectVersion: 1 }), 'conflict', /version 2, not 1/);
  throwsCode(() => s.updatePosition(CID, 'marketing', { id: 'mkt' }), 'invalid', /never changes/);
  throwsCode(() => s.updatePosition(CID, 'marketing', { status: 'retired' }), 'invalid', /retirePosition/);
  throwsCode(() => s.updatePosition(CID, 'marketing', { effort: 'enormous' }), 'invalid', /effort/);
  throwsCode(() => s.updatePosition(CID, 'legal', { parent: 'payroll-tax' }), 'tree', /cycle/);
  throwsCode(() => s.updatePosition(CID, 'nobody', { name: 'x' }), 'not-found');
  const moved = s.updatePosition(CID, 'payroll-tax', { parent: 'legal' });
  assert.equal(s.tree(CID).parentOf('payroll-tax'), 'legal');
  assert.equal(moved.version, 2);
  for (let i = 0; i < 12; i++) s.updatePosition(CID, 'marketing', (p) => ({ ...p, remit: `Remit ${i}` }));
  assert.equal(s.getPosition(CID, 'marketing').version, 14);
  assert.deepEqual(s.versions(CID, 'marketing'), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.equal(s.readVersion(CID, 'marketing', 13).remit, 'Remit 10');
  assert.equal(s.getPosition(CID, 'paused-nope'), null);
});

test('hand edit of position.json: bad JSON keeps the last good in force and says why; a fix is picked up', () => {
  const root = exampleRoot();
  const s = open(root);
  assert.equal(s.getPosition(CID, 'marketing').remit.startsWith('Release notes'), true);
  const f = pfile(root, 'marketing');
  const good = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, good.replace('"remit"', '"remit" oops'));
  bump(f);
  assert.equal(s.getPosition(CID, 'marketing').remit.startsWith('Release notes'), true, 'last good stays in force');
  const pr = s.problems(CID);
  assert.equal(pr.length, 1);
  assert.equal(pr[0].file, `${CID}/positions/marketing/position.json`);
  assert.match(pr[0].errors.join(), /not valid JSON/);
  throwsCode(() => s.updatePosition(CID, 'marketing', { remit: 'x' }), 'invalid', /fix it first/);
  writeJ(f, { ...JSON.parse(good), remit: 'Hand-written remit.' });
  bump(f);
  assert.equal(s.getPosition(CID, 'marketing').remit, 'Hand-written remit.');
  assert.deepEqual(s.problems(CID), []);
  // a schema error, an id that is not the folder name
  writeJ(f, { ...JSON.parse(good), powers: { bash: 'yes' } });
  bump(f);
  assert.match(s.problems(CID)[0].errors.join(), /powers.bash/);
  assert.equal(s.getPosition(CID, 'marketing').remit, 'Hand-written remit.');
  writeJ(f, { ...JSON.parse(good), id: 'mkt' });
  bump(f);
  assert.match(s.problems(CID)[0].errors.join(), /its folder is "marketing"/);
});

test('hand edit that breaks the tree (cycle, dangling parent, depth) is reverted to its last good with the reason', () => {
  const root = exampleRoot();
  const s = open(root);
  s.listPositions(CID);
  const f = pfile(root, 'legal');
  writeJ(f, { ...readJ(f), parent: 'payroll-tax' });
  bump(f);
  assert.equal(s.getPosition(CID, 'legal').parent, null);
  const pr = s.problems(CID).find((p) => p.position === 'legal');
  assert.match(pr.errors.join(), /cycle/);
  assert.deepEqual(s.tree(CID).problems(), [], 'the tree in force stays sound');
  writeJ(f, { ...readJ(f), parent: 'ghost' });
  bump(f);
  assert.match(s.problems(CID).find((p) => p.position === 'legal').errors.join(), /"ghost"/);
  writeJ(f, { ...readJ(f), parent: null });
  bump(f);
  assert.deepEqual(s.problems(CID), []);
});

test('after a restart a broken position.json falls back to the newest good version Helm wrote', () => {
  const root = exampleRoot();
  const s = open(root);
  s.updatePosition(CID, 'marketing', { remit: 'Version two remit.' });
  fs.writeFileSync(pfile(root, 'marketing'), '{ broken');
  const fresh = open(root);
  assert.equal(fresh.getPosition(CID, 'marketing').remit, 'Version two remit.');
  const pr = fresh.problems(CID)[0];
  assert.equal(pr.usingVersion, 2);
  assert.equal(pr.inForce, true);
  // a position whose file never validated is listed as a problem and is not in force
  fs.writeFileSync(pfile(root, 'app-qa'), '{');
  const third = open(root);
  assert.equal(third.getPosition(CID, 'app-qa'), null);
  assert.ok(third.problems(CID).some((p) => p.position === 'app-qa' && p.inForce === false));
  throwsCode(() => third.createPosition(CID, { id: 'n', name: 'N', remit: 'n', parent: null }, { brief: BRIEF }), 'invalid', /app-qa/);
});

test('brief.md and notebook.md hand edits: re-validated, last good kept, reason exposed', () => {
  const root = exampleRoot();
  const s = open(root);
  const b0 = s.readBrief(CID, 'tax').text;
  fs.writeFileSync(pfile(root, 'tax', 'brief.md'), '\n\n');
  bump(pfile(root, 'tax', 'brief.md'));
  const r = s.readBrief(CID, 'tax');
  assert.equal(r.text, b0);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /empty/);
  assert.ok(s.problems(CID).some((p) => p.file.endsWith('tax/brief.md')));
  s.writeBrief(CID, 'tax', '# New brief\n');
  assert.equal(s.readBrief(CID, 'tax').text, '# New brief\n');
  throwsCode(() => s.writeBrief(CID, 'tax', ''), 'invalid');
  throwsCode(() => s.writeBrief(CID, 'tax', '# x\n', { expectText: 'stale' }), 'conflict');
  s.readNotebook(CID, 'tax');
  fs.writeFileSync(pfile(root, 'tax', 'notebook.md'), 'x'.repeat(S.LIMITS.notebookMax + 1));
  bump(pfile(root, 'tax', 'notebook.md'));
  const n = s.readNotebook(CID, 'tax');
  assert.equal(n.ok, false);
  assert.match(n.text, /Tax Specialist · notebook/);
  throwsCode(() => s.notebookAdd(CID, 'tax', 'Facts', 'x'), 'invalid', /fix it first/);
});

test('notebookAdd: dated entries in their section, missing headings put back, the Log trimmed to 200 into the archive', () => {
  const root = exampleRoot();
  const s = open(root);
  s.notebookAdd(CID, 'legal', 'Decisions', 'Keep the cookie notice short.');
  s.notebookAdd(CID, 'legal', 'Open items', 'Ask about the new analytics tool');
  s.notebookAdd(CID, 'legal', 'Facts', 'Line one\nline two');
  const nb = fs.readFileSync(pfile(root, 'legal', 'notebook.md'), 'utf8');
  assert.match(nb, /## Decisions\n- 2026-02-01: Keep the cookie notice short\.\n## Facts\n/);
  assert.match(nb, /pay\.js\)\.\n- 2026-02-01: Line one\n  line two\n## Open items/);
  assert.match(nb, /- \[ \] Ask about the new analytics tool \(2026-02-01\)\n## Log/);
  throwsCode(() => s.notebookAdd(CID, 'legal', 'Gossip', 'x'), 'invalid', /section/);
  throwsCode(() => s.notebookAdd(CID, 'legal', 'Log', '   '), 'invalid', /empty/);
  // the owner deleted the Facts heading by hand
  fs.writeFileSync(pfile(root, 'marketing', 'notebook.md'), '# Marketing Manager · notebook\n## Decisions\n- old\n## Open items\n## Log\n');
  bump(pfile(root, 'marketing', 'notebook.md'));
  s.notebookAdd(CID, 'marketing', 'Facts', 'The app ships monthly.');
  assert.equal(fs.readFileSync(pfile(root, 'marketing', 'notebook.md'), 'utf8'),
    '# Marketing Manager · notebook\n## Decisions\n- old\n## Facts\n- 2026-02-01: The app ships monthly.\n## Open items\n## Log\n');
  for (let i = 0; i < 203; i++) s.notebookAdd(CID, 'payroll-tax', 'Log', `did thing ${i}`);
  const log = fs.readFileSync(pfile(root, 'payroll-tax', 'notebook.md'), 'utf8').split('## Log\n')[1].trim().split('\n');
  assert.equal(log.length, 200);
  assert.match(log[0], /did thing 3$/);
  const arch = fs.readFileSync(pfile(root, 'payroll-tax', 'notebook-log-archive.md'), 'utf8');
  assert.match(arch, /^# Payroll Tax Specialist · notebook log archive\n- 2026-02-01: did thing 0\n- 2026-02-01: did thing 1\n- 2026-02-01: did thing 2\n$/);
});

test('chats.json: addChat numbers chats, updateChat patches one, handoff capped', () => {
  const root = exampleRoot();
  const s = open(root);
  const c1 = s.addChat(CID, 'tax', { helmSessionId: 's_1' });
  assert.deepEqual(c1, { n: 1, helmSessionId: 's_1', claudeSessionId: null, startedAt: new Date(clock).toISOString() });
  const c2 = s.addChat(CID, 'tax', { helmSessionId: 's_2', n: 99 });
  assert.equal(c2.n, 2, 'n is always last + 1');
  const ended = s.updateChat(CID, 'tax', 1, { endedAt: 'x', endReason: 'full', handoff: 'h'.repeat(30_000) });
  assert.equal(ended.handoff.length, S.LIMITS.logTextMax);
  assert.equal(s.readChats(CID, 'tax').chats.length, 2);
  throwsCode(() => s.updateChat(CID, 'tax', 7, {}), 'not-found');
  fs.writeFileSync(pfile(root, 'tax', 'chats.json'), '[{"n": "one"}]');
  bump(pfile(root, 'tax', 'chats.json'));
  const r = s.readChats(CID, 'tax');
  assert.equal(r.ok, false);
  assert.equal(r.chats.length, 2, 'last good list');
  throwsCode(() => s.addChat(CID, 'tax', {}), 'invalid', /fix it first/);
});

test('JSONL logs: append-only, at stamped, text capped, torn last line fenced, bad lines skipped, since/limit/filter', () => {
  const root = exampleRoot();
  const s = open(root);
  const line = s.append(CID, 'crosstalk', { ticket: 't_1', to: 'tax', state: 'asked', question: 'q'.repeat(25_000) });
  assert.equal(line.at, new Date(clock).toISOString());
  assert.equal(line.question.length, S.LIMITS.logTextMax);
  const f = path.join(root, CID, 'crosstalk.jsonl');
  fs.appendFileSync(f, '{"at":"2026-02-01T12:00:00.000Z","ticket":"t_torn"'); // a crash mid-line
  clock += 60_000;
  s.append(CID, 'crosstalk', { ticket: 't_2', to: 'legal', state: 'answered', answer: 'yes' });
  const all = s.readLog(CID, 'crosstalk');
  assert.equal(all.bad, 1);
  assert.deepEqual(all.lines.map((l) => l.ticket), ['t_0b01', 't_0b01', 't_0b01', 't_1', 't_2']);
  assert.deepEqual(s.readLog(CID, 'crosstalk', { limit: 1 }).lines.map((l) => l.ticket), ['t_2']);
  assert.deepEqual(s.readLog(CID, 'crosstalk', { since: clock }).lines.map((l) => l.ticket), ['t_2']);
  assert.deepEqual(s.readLog(CID, 'crosstalk', { filter: (l) => l.to === 'legal', limit: 2 }).lines.map((l) => l.ticket), ['t_0b01', 't_2']);
  assert.deepEqual(s.readLog(CID, 'grants').lines.length, 1);
  assert.deepEqual(s.readLog(CID, 'inbox', { since: '2030-01-01' }).lines, []);
  throwsCode(() => s.append(CID, 'diary', {}), 'invalid', /log: must be one of/);
  throwsCode(() => s.append('nope', 'inbox', {}), 'not-found');
  for (const log of s.LOGS) s.append(CID, log, { probe: true });
  assert.ok(fs.readFileSync(f, 'utf8').endsWith('\n'));
});

test('retire: move-up moves reports to the manager\'s manager and the folder to retired/; the id stays taken', () => {
  const root = exampleRoot();
  const s = open(root);
  throwsCode(() => s.retirePosition(CID, 'tax', { openTickets: (id) => (id === 'tax' ? 1 : 0) }), 'busy', /open tickets/);
  const r = s.retirePosition(CID, 'tax');
  assert.deepEqual(r.retired, ['tax']);
  assert.deepEqual(r.moved, [{ id: 'payroll-tax', from: 'tax', to: 'legal' }]);
  assert.deepEqual(r.pendingMove, []);
  assert.equal(s.getPosition(CID, 'payroll-tax').parent, 'legal');
  assert.ok(!fs.existsSync(path.join(root, CID, 'positions', 'tax')));
  const ret = readJ(path.join(root, CID, 'retired', 'tax', 'position.json'));
  assert.equal(ret.status, 'retired');
  assert.equal(ret.version, 3);
  assert.equal(ret.retiredAt, new Date(clock).toISOString());
  assert.ok(fs.existsSync(path.join(root, CID, 'retired', 'tax', 'notebook.md')), 'moved unchanged');
  assert.equal(s.getPosition(CID, 'tax').status, 'retired');
  assert.equal(s.readBrief(CID, 'tax').ok, true, 'a retired position\'s files stay readable');
  assert.ok(s.takenIds(CID).has('tax'));
  assert.deepEqual(s.listPositions(CID).map((p) => p.id).sort(), ['app-qa', 'legal', 'marketing', 'payroll-tax']);
  assert.ok(s.listPositions(CID, { retired: true }).some((p) => p.id === 'tax' && p.status === 'retired'));
  throwsCode(() => s.createPosition(CID, { id: 'tax', name: 'Tax', remit: 'x', parent: null }, { brief: BRIEF }), 'tree', /already used/);
  throwsCode(() => s.retirePosition(CID, 'tax'), 'not-found');
});

test('retire-too retires the whole subtree, deepest first', () => {
  const root = exampleRoot();
  const s = open(root);
  const r = s.retirePosition(CID, 'legal', { mode: 'retire-too' });
  assert.deepEqual(r.retired, ['payroll-tax', 'tax', 'legal']);
  assert.deepEqual(fs.readdirSync(path.join(root, CID, 'retired')).filter((n) => !n.startsWith('.')).sort(), ['legal', 'payroll-tax', 'tax']);
  assert.deepEqual(s.listPositions(CID).map((p) => p.id).sort(), ['app-qa', 'marketing']);
});

test('a position marked retired in place (folder held open, or a hand edit) is moved by sweepRetired', () => {
  const root = exampleRoot();
  const s = open(root);
  const f = pfile(root, 'marketing');
  writeJ(f, { ...readJ(f), status: 'retired' });
  bump(f);
  assert.ok(!s.listPositions(CID).some((p) => p.id === 'marketing'), 'retired is out of the live list at once');
  assert.deepEqual(s.sweepRetired(CID), ['marketing']);
  assert.ok(fs.existsSync(path.join(root, CID, 'retired', 'marketing', 'position.json')));
});

function runChild(code, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('exit', (c) => (c === 0 ? resolve(out) : reject(new Error(`child exit ${c}: ${err}`))));
  });
}

test('two processes writing at once: no lost update, no torn log line', async () => {
  const root = exampleRoot();
  const code = `
    const { createTeamStore } = require(process.argv[1]);
    const s = createTeamStore({ root: process.argv[2] });
    const tag = process.argv[3];
    for (let i = 0; i < 25; i++) {
      s.updatePosition('${CID}', 'marketing', (p) => ({ ...p, counter: (p.counter || 0) + 1 }));
      s.append('${CID}', 'inbox', { id: tag + i, kind: 'flag', title: tag, text: 'x'.repeat(3000), needsOwen: false });
    }`;
  await Promise.all([runChild(code, [STORE, root, 'a']), runChild(code, [STORE, root, 'b'])]);
  const s = open(root);
  const p = s.getPosition(CID, 'marketing');
  assert.equal(p.counter, 50, 'every read-modify-write saw the previous one');
  assert.equal(p.version, 51);
  const log = s.readLog(CID, 'inbox', { filter: (l) => l.kind === 'flag' });
  assert.equal(log.bad, 0);
  assert.equal(log.lines.length, 50);
  assert.ok(!fs.existsSync(path.join(root, CID, '.lock')), 'lock released');
  assert.deepEqual(fs.readdirSync(pfile(root, 'marketing', '')).filter((n) => n.endsWith('.tmp')), []);
});

test('a stale lock (a crashed writer) is taken over', () => {
  const root = exampleRoot();
  const s = open(root);
  const lock = path.join(root, CID, '.lock');
  fs.writeFileSync(lock, '999999 old\n');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(s.updatePosition(CID, 'marketing', { remit: 'after a crash' }).remit, 'after a crash');
  assert.ok(!fs.existsSync(lock));
});

function waitFor(pred, ms = 4000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { const v = pred(); if (v) return resolve(v); if (Date.now() - t0 > ms) return reject(new Error('timed out waiting')); setTimeout(tick, 40); };
    tick();
  });
}

test('watch: hand edits raise change events (with the previous text); Helm\'s own writes do not', async (t) => {
  const root = exampleRoot();
  const s = open(root);
  s.listPositions(CID);
  s.readNotebook(CID, 'legal');
  s.readBrief(CID, 'tax');
  const events = [];
  s.on('change', (e) => events.push(e));
  assert.equal(s.watch(), true);
  t.after(() => s.close());
  await new Promise((r) => setTimeout(r, 150));
  s.notebookAdd(CID, 'legal', 'Log', 'Helm wrote this');
  s.updatePosition(CID, 'marketing', { remit: 'Helm edit' });
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(events.filter((e) => e.kind !== 'log'), [], 'no echo of our own writes');
  const before = s.readNotebook(CID, 'legal').text;
  fs.writeFileSync(pfile(root, 'legal', 'notebook.md'), before + '- The owner added this\n');
  const nb = await waitFor(() => events.find((e) => e.kind === 'notebook'));
  assert.equal(nb.position, 'legal');
  assert.equal(nb.source, 'external');
  assert.equal(nb.prev, before);
  assert.match(nb.text, /The owner added this/);
  fs.writeFileSync(pfile(root, 'app-qa'), '{ nope');
  const bad = await waitFor(() => events.find((e) => e.kind === 'position' && e.position === 'app-qa'));
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(), /not valid JSON/);
  assert.equal(bad.value.id, 'app-qa', 'the last good value is what stays in force');
  fs.writeFileSync(pfile(root, 'tax', 'brief.md'), '');
  const br = await waitFor(() => events.find((e) => e.kind === 'brief'));
  assert.equal(br.ok, false);
  assert.match(br.text, /Tax Specialist/);
});
