// Unit tests for ui/lib/positions-model.js: the Team view's pure rules (lane T6), plus a consistency check of
// ui/lib/mock-positions.js (the ?mock=1 backend). Both are ESM with no imports, so require(esm) loads them directly.
// Dates are local (new Date(y, m, d, h, min)) so every assertion holds in any time zone.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const M = require('../../ui/lib/positions-model.js');
const { createMockTeam } = require('../../ui/lib/mock-positions.js');
const {
  CEO, indexTree, visibleRows, treeKey, revealOpen, ancestorsOf,
  untilLabel, liveStatus, statusText, dotClass, fmtActivity, fmtNextDuty, pendingChips, needsYou, companyCounts, countsText,
  tokenLabel, powerRows, cronWords, triggerWords, foldCrosstalk, crosstalkLine, countCrosstalk,
  parseNotebook, countOpenItems, toggleItem, chatRows, proposalTitle, decidedText, splitProposals, liveInbox,
} = M;

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = new Date(2026, 10, 17, 12, 0).getTime();   // Tue 17 Nov 2026, 12:00 local
const at = (d, h, min = 0, mo = 10, y = 2026) => new Date(y, mo, d, h, min).getTime();

// legal > tax > payroll > deep4 > deep5 (depth 5, the cap), legal > contracts, marketing
const R = (id, name, parent, extra = {}) => ({ id, name, parent, remit: '', status: 'active', depth: 0, pending: { requests: 0, proposals: 0 }, ...extra });
const TREE = [
  R('legal', 'Legal', null),
  R('tax', 'Tax Specialist', 'legal', { depth: 9 }),   // a wrong stored depth is only a hint
  R('payroll', 'Payroll Tax', 'tax'),
  R('deep4', 'Deep Four', 'payroll'),
  R('deep5', 'Deep Five', 'deep4'),
  R('contracts', 'Contracts', 'legal'),
  R('marketing', 'Marketing', null),
];
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

// ---------------------------------------------------------------- tree
test('indexTree: depth is recomputed from parents, not the stored hint', () => {
  const ix = indexTree(TREE);
  assert.deepEqual(Object.fromEntries(ix.depth), { legal: 1, tax: 2, payroll: 3, deep4: 4, deep5: 5, contracts: 2, marketing: 1 });
  assert.deepEqual(ix.roots, ['legal', 'marketing']);
  assert.deepEqual(ix.kids.get('legal'), ['tax', 'contracts']);
  assert.equal(ix.orphan.size, 0);
  assert.deepEqual(indexTree(null).roots, []);
  assert.deepEqual(indexTree([null, {}, { id: '' }]).roots, []);
});

test('indexTree: a missing parent or a cycle shows the row at the top, flagged orphan; descendants re-depthed; nothing dropped', () => {
  const rows = [
    R('a', 'A', 'ghost'),          // parent missing
    R('b', 'B', 'a'),              // child of an orphan
    R('c', 'C', 'c2'),             // c <-> c2 cycle
    R('c2', 'C2', 'c'),
    R('d', 'D', 'c'),              // hangs under a cycle member, is not on the cycle itself
    R('e', 'E', 'd'),
    R('x', 'X', 'x'),              // its own parent: a cycle of one
    R('ok', 'OK', null),
  ];
  const ix = indexTree(rows);
  assert.deepEqual([...ix.orphan].sort(), ['a', 'c', 'c2', 'x']);
  assert.deepEqual(Object.fromEntries(ix.depth), { a: 1, b: 2, c: 1, c2: 1, d: 2, e: 3, x: 1, ok: 1 });
  assert.deepEqual([...ix.roots].sort(), ['a', 'c', 'c2', 'ok', 'x']);
  assert.deepEqual(ix.kids.get('c'), ['d']);
  const vis = visibleRows(rows, {});
  assert.deepEqual(vis.map((r) => r.id).sort(), [CEO, ...rows.map((r) => r.id)].sort(), 'every row is on screen exactly once');
  assert.equal(byId(vis).a.orphan, true);
  assert.equal(byId(vis).b.orphan, false);
  assert.equal(byId(vis).e.parentId, 'd');
  assert.deepEqual(ancestorsOf(ix, 'e'), ['c', 'd']);
  assert.deepEqual(ancestorsOf(ix, 'c2'), []);
});

test('visibleRows: CEO root first, depth-first order, level / posinset / setsize', () => {
  const rows = visibleRows(TREE, {});
  assert.deepEqual(rows.map((r) => r.id), [CEO, 'legal', 'tax', 'payroll', 'deep4', 'deep5', 'contracts', 'marketing']);
  const ceo = rows[0];
  assert.equal(CEO, '@ceo');
  assert.equal(ceo.ceo, true); assert.equal(ceo.level, 1); assert.equal(ceo.indent, 0); assert.equal(ceo.open, true); assert.equal(ceo.hasKids, true);
  const b = byId(rows);
  assert.deepEqual([b.legal.level, b.tax.level, b.deep5.level, b.deep5.depth], [2, 3, 6, 5]);
  assert.deepEqual([b.legal.posinset, b.legal.setsize, b.marketing.posinset, b.marketing.setsize], [1, 2, 2, 2]);
  assert.deepEqual([b.tax.posinset, b.tax.setsize, b.contracts.posinset, b.contracts.setsize], [1, 2, 2, 2]);
  assert.deepEqual([b.legal.parentId, b.tax.parentId, b.deep5.parentId], [CEO, 'legal', 'deep4']);
  assert.equal(b.deep5.hasKids, false); assert.equal(b.deep5.open, false);
  assert.deepEqual(visibleRows([], {}).map((r) => r.id), [CEO]);
  assert.equal(visibleRows([], {})[0].hasKids, false);
  assert.deepEqual(visibleRows(TREE, null).map((r) => r.id), rows.map((r) => r.id), 'no open map = all open');
});

test('visibleRows: a collapsed row hides its whole subtree', () => {
  const rows = visibleRows(TREE, { tax: false });
  assert.deepEqual(rows.map((r) => r.id), [CEO, 'legal', 'tax', 'contracts', 'marketing']);
  assert.equal(byId(rows).tax.open, false);
  assert.equal(byId(rows).tax.hasKids, true);
  assert.deepEqual(visibleRows(TREE, { legal: false, marketing: false }).map((r) => r.id), [CEO, 'legal', 'marketing']);
  assert.deepEqual(visibleRows(TREE, { tax: true }).length, 8);
});

test('visibleRows: indent 16 px a level on desktop, 12 px on phone; phone stops at level 3 and shows the parent as a crumb', () => {
  const desk = byId(visibleRows(TREE, {}));
  assert.deepEqual(['legal', 'tax', 'payroll', 'deep4', 'deep5'].map((id) => desk[id].indent), [16, 32, 48, 64, 80]);
  assert.ok(Object.values(desk).every((r) => r.crumb === null), 'desktop never has a crumb');
  const phone = byId(visibleRows(TREE, {}, { phone: true }));
  assert.deepEqual(['legal', 'tax', 'payroll', 'deep4', 'deep5'].map((id) => phone[id].indent), [12, 24, 36, 36, 36]);
  assert.deepEqual(['legal', 'tax', 'payroll', 'deep4', 'deep5'].map((id) => phone[id].crumb), [null, null, null, 'Payroll Tax', 'Deep Four']);
  assert.equal(phone[CEO].indent, 0);
});

test('treeKey: arrows, Home/End, expand/collapse, parent, select, unknown keys', () => {
  const rows = visibleRows(TREE, { tax: false });   // @ceo, legal, tax(collapsed), contracts, marketing
  assert.deepEqual(treeKey(rows, CEO, 'ArrowDown'), { focus: 'legal' });
  assert.deepEqual(treeKey(rows, 'legal', 'ArrowDown'), { focus: 'tax' });
  assert.deepEqual(treeKey(rows, 'marketing', 'ArrowDown'), {});
  assert.deepEqual(treeKey(rows, 'tax', 'ArrowUp'), { focus: 'legal' });
  assert.deepEqual(treeKey(rows, CEO, 'ArrowUp'), {});
  assert.deepEqual(treeKey(rows, 'contracts', 'Home'), { focus: CEO });
  assert.deepEqual(treeKey(rows, 'legal', 'End'), { focus: 'marketing' });
  // ArrowRight: expand a closed row, then step into its first child; a leaf does nothing
  assert.deepEqual(treeKey(rows, 'tax', 'ArrowRight'), { toggle: { id: 'tax', open: true } });
  assert.deepEqual(treeKey(rows, 'legal', 'ArrowRight'), { focus: 'tax' });
  assert.deepEqual(treeKey(rows, CEO, 'ArrowRight'), { focus: 'legal' });
  assert.deepEqual(treeKey(rows, 'contracts', 'ArrowRight'), {});
  // ArrowLeft: collapse an open row, then go to its parent; a top-level row goes to the CEO; the CEO stays
  assert.deepEqual(treeKey(rows, 'legal', 'ArrowLeft'), { toggle: { id: 'legal', open: false } });
  assert.deepEqual(treeKey(rows, 'tax', 'ArrowLeft'), { focus: 'legal' });
  assert.deepEqual(treeKey(rows, 'contracts', 'ArrowLeft'), { focus: 'legal' });
  assert.deepEqual(treeKey(rows, 'marketing', 'ArrowLeft'), { focus: CEO });
  assert.deepEqual(treeKey(visibleRows(TREE, { legal: false }), 'legal', 'ArrowLeft'), { focus: CEO });
  assert.deepEqual(treeKey(rows, CEO, 'ArrowLeft'), {});
  // select / no-op / unknown id
  assert.deepEqual(treeKey(rows, 'tax', 'Enter'), { select: 'tax' });
  assert.deepEqual(treeKey(rows, CEO, ' '), { select: CEO });
  assert.deepEqual(treeKey(rows, 'tax', 'x'), {});
  assert.deepEqual(treeKey(rows, 'tax', 'Tab'), {});
  assert.deepEqual(treeKey(rows, 'gone', 'ArrowDown'), { focus: CEO });
  assert.deepEqual(treeKey([], 'gone', 'ArrowDown'), {});
  // depth 5 navigates like any other level
  const deep = visibleRows(TREE, {});
  assert.deepEqual(treeKey(deep, 'deep5', 'ArrowLeft'), { focus: 'deep4' });
  assert.deepEqual(treeKey(deep, 'deep4', 'ArrowRight'), { focus: 'deep5' });
});

test('revealOpen: opens collapsed ancestors only; same object back when nothing changes', () => {
  const open = { legal: false, tax: false, marketing: false, payroll: true };
  const next = revealOpen(TREE, open, 'deep4');
  assert.deepEqual(next, { marketing: false, payroll: true });
  assert.notEqual(next, open);
  assert.deepEqual(open, { legal: false, tax: false, marketing: false, payroll: true }, 'input not mutated');
  const same = { marketing: false, deep4: false };
  assert.deepEqual(revealOpen(TREE, same, 'deep5'), { marketing: false });
  const untouched = { marketing: false };
  assert.equal(revealOpen(TREE, untouched, 'deep5'), untouched);
  assert.equal(revealOpen(TREE, untouched, 'legal'), untouched);
  assert.equal(revealOpen(TREE, undefined, 'deep5'), undefined);
  assert.equal(revealOpen(TREE, untouched, 'nobody'), untouched);
});

// ---------------------------------------------------------------- status + chips
test('liveStatus / statusText / dotClass: active reads idle, paused wins', () => {
  assert.equal(liveStatus(null), 'idle');
  assert.equal(liveStatus({ status: 'active' }), 'idle');
  assert.equal(liveStatus({ status: 'active', chatStatus: 'working' }), 'working');
  assert.equal(liveStatus({ status: 'paused', chatStatus: 'working' }), 'paused');
  assert.equal(liveStatus({ status: 'working', paused: true }), 'paused');
  assert.equal(liveStatus({ status: 'waiting' }), 'waiting');
  assert.equal(liveStatus({ status: 'weird' }), 'idle');
  assert.deepEqual(['working', 'waiting', 'idle', 'paused', 'active', undefined].map(statusText), ['Working', 'Waiting on you', 'Idle', 'Paused', 'Idle', 'Idle']);
  assert.deepEqual(['working', 'waiting', 'idle', 'paused', 'active'].map(dotClass), ['working', 'waiting', 'idle', 'closed', 'idle']);
});

test('fmtActivity: object with a time, plain string, nothing', () => {
  const a = fmtActivity({ at: NOW - 12 * MIN, text: 'answered CEO' }, NOW);
  assert.equal(a.text, 'answered CEO'); assert.equal(a.ago, '12m');
  assert.ok(a.title.startsWith('answered CEO · '));
  assert.deepEqual(fmtActivity('drafted a post', NOW), { text: 'drafted a post', ago: '', title: 'drafted a post' });
  assert.deepEqual(fmtActivity(null, NOW), { text: '', ago: '', title: '' });
  assert.deepEqual(fmtActivity({ text: 'no time' }, NOW), { text: 'no time', ago: '', title: 'no time' });
  assert.equal(fmtActivity({ at: NOW - 3 * DAY, text: 'x' }, NOW).ago, '3d');
});

test('untilLabel / fmtNextDuty: "in 40m", "in 5h", a date after a day, "due now" once past; soon under 24 h', () => {
  assert.equal(untilLabel(NOW + 40 * MIN, NOW), 'in 40m');
  assert.equal(untilLabel(NOW + 30_000, NOW), 'in 1m');
  assert.equal(untilLabel(NOW + 5 * HOUR, NOW), 'in 5h');
  assert.equal(untilLabel(NOW + 59 * MIN + 50_000, NOW), 'in 1h', 'never "in 60m"');
  assert.notEqual(untilLabel(NOW + 23 * HOUR + 50 * MIN, NOW), 'in 24h');
  assert.equal(untilLabel(at(20, 9), NOW), 'Nov 20');
  assert.equal(untilLabel(at(5, 9, 0, 0, 2027), NOW), 'Jan 5, 2027');
  assert.equal(untilLabel(NOW, NOW), 'due now');
  assert.equal(untilLabel(NOW - HOUR, NOW), 'due now');

  const soon = fmtNextDuty({ title: 'Money check', at: NOW + 40 * MIN }, NOW);
  assert.equal(soon.label, 'in 40m · Money check'); assert.equal(soon.when, 'in 40m'); assert.equal(soon.title, 'Money check');
  assert.equal(soon.soon, true); assert.ok(soon.full.startsWith('Next duty: Money check, '));
  assert.equal(fmtNextDuty({ title: 'Money check', at: NOW + 5 * HOUR }, NOW).label, 'in 5h · Money check');
  const later = fmtNextDuty({ title: 'Money check', at: at(1, 9, 0, 11) }, NOW);
  assert.equal(later.label, 'Dec 1 · Money check'); assert.equal(later.soon, false);
  assert.equal(fmtNextDuty({ at: NOW - MIN }, NOW).label, 'due now · Duty');
  assert.equal(fmtNextDuty({ title: 'x' }, NOW), null);
  assert.equal(fmtNextDuty(null, NOW), null);
});

test('pendingChips / needsYou', () => {
  assert.deepEqual(pendingChips({ requests: 1, proposals: 2 }), [
    { kind: 'request', n: 1, label: '1 request' }, { kind: 'proposal', n: 2, label: '2 proposals' }]);
  assert.deepEqual(pendingChips({ requests: 2 }), [{ kind: 'request', n: 2, label: '2 requests' }]);
  assert.deepEqual(pendingChips({ requests: -1, proposals: 'x' }), []);
  assert.deepEqual(pendingChips(null), []);
  assert.equal(needsYou({ pending: { requests: 1, proposals: 1 } }), 2);
  assert.equal(needsYou({}), 0);
});

test('companyCounts / countsText: team.list needsYou wins over the row sum', () => {
  const rows = [
    { status: 'working', pending: { requests: 1, proposals: 0 } },
    { status: 'waiting', pending: { requests: 0, proposals: 1 } },
    { status: 'paused' }, { status: 'active' },
  ];
  assert.deepEqual(companyCounts(rows), { positions: 4, needsYou: 2, working: 1, waiting: 1, paused: 1 });
  assert.equal(companyCounts(rows, 5).needsYou, 5);
  assert.equal(companyCounts(rows, 0).needsYou, 0, 'a real 0 from team.list wins too');
  assert.equal(companyCounts(rows, NaN).needsYou, 2);
  assert.equal(companyCounts(rows, '7').needsYou, 2);
  assert.deepEqual(companyCounts(null), { positions: 0, needsYou: 0, working: 0, waiting: 0, paused: 0 });
  assert.equal(countsText({ positions: 4, needsYou: 2, working: 1 }), '2 need you · 1 working');
  assert.equal(countsText({ positions: 4, needsYou: 1, working: 0 }), '1 needs you');
  assert.equal(countsText({ positions: 3, needsYou: 0, working: 2 }), '2 working');
  assert.equal(countsText({ positions: 3, needsYou: 0, working: 0 }), '3 positions, all quiet');
  assert.equal(countsText({ positions: 1, needsYou: 0, working: 0 }), '1 position, all quiet');
  assert.equal(countsText({ positions: 0, needsYou: 0, working: 0 }), 'No positions yet');
});

// ---------------------------------------------------------------- powers
test('tokenLabel: path tokens in words', () => {
  assert.equal(tokenLabel('$workspace'), 'Its workspace');
  assert.equal(tokenLabel('$company'), 'Company folders');
  assert.equal(tokenLabel('$scope', { kind: 'product', folder: 'C:/Users/you/example-app/' }), 'Its scope: example-app');
  assert.equal(tokenLabel('$scope', { kind: 'company' }), 'Its scope (company folders)');
  assert.equal(tokenLabel('C:/Users/you/docs/**'), 'C:/Users/you/docs/**');
});

test('toMs / pathKey: ISO or epoch times; engine-normalised path keys', () => {
  assert.equal(M.toMs(5), 5);
  assert.equal(M.toMs('2026-11-17T12:00:00.000Z'), Date.UTC(2026, 10, 17, 12));
  for (const v of [NaN, Infinity, '', 'nope', null, undefined, {}]) assert.equal(M.toMs(v), null, String(v));
  assert.equal(M.pathKey('C:\\Users\\You\\Docs\\**'), 'c:/users/you/docs');
  assert.equal(M.pathKey('C:/Users/you/app/'), 'c:/users/you/app');
  assert.equal(M.pathKey('/'), '/');
  assert.equal(M.pathKey(null), '');
});

// team.position `position` as wire.js sends it: effective = tree.effective (expanded absolute paths, its workspace
// first) + limits [{ power, value, by, max?, kept? }]; limitedBy = the same cuts as a { "<power>[:<value>]": by } map
const WS = 'C:/Users/you/helm-team/example-co/positions/tax';
const FOLDERS = ['C:/Users/you/example-site', 'C:/Users/you/example-app', 'C:/Users/you/example-docs'];
const TAX_LIMITS = [{ power: 'read', value: 'C:/Users/you/tax-archive', by: 'company' }, { power: 'tools', value: 'NotebookEdit', by: 'legal' }, { power: 'bash', value: 'readonly', max: 'off', by: 'legal' }];
const TAX = {
  scope: { kind: 'company' },
  powers: { read: ['$workspace', '$company', 'C:/Users/you/tax-archive'], write: ['$workspace'], tools: ['Read', 'WebFetch', 'NotebookEdit'], bash: 'readonly', agents: false, worktree: false },
  effective: { read: [WS, ...FOLDERS], write: [WS], tools: ['Read', 'WebFetch'], bash: 'off', agents: false, worktree: false, workspace: WS, limitedBy: TAX_LIMITS, broken: null, limits: TAX_LIMITS },
  limitedBy: { 'read:C:/Users/you/tax-archive': 'company', 'tools:NotebookEdit': 'legal', bash: 'legal' },
};
const notes = (rows) => rows.map((r) => (r.items ? r.items.map((i) => i.limitNote) : r.limitNote));

test('powerRows: engine limits -> limitedBy (names) + limitNote; tokens in words; nothing else marked', () => {
  const names = { legal: 'Legal', qa: 'App QA' };
  const rows = byId(powerRows(TAX, names, { companyFolders: FOLDERS }).map((r) => ({ ...r, id: r.key })));
  assert.deepEqual(Object.keys(rows), ['read', 'write', 'tools', 'bash', 'agents', 'worktree']);
  assert.deepEqual(rows.read.items.map((i) => [i.label, i.mono, i.limitedBy, i.limitNote, i.partly]), [
    ['Its workspace', false, null, null, false], ['Company folders', false, null, null, false],
    ['C:/Users/you/tax-archive', true, 'the company folders', 'outside the company folders', false]]);
  assert.equal(rows.read.items[0].title, WS, 'a token\'s title lists the folders it stands for');
  assert.equal(rows.read.items[1].title, FOLDERS.join('\n'));
  assert.deepEqual(rows.write.items.map((i) => [i.label, i.limitedBy]), [['Its workspace', null]]);
  assert.deepEqual(rows.tools.items.map((i) => [i.value, i.limitedBy, i.limitNote]), [['Read', null, null], ['WebFetch', null, null], ['NotebookEdit', 'Legal', 'limited by Legal']]);
  assert.deepEqual([rows.bash.text, rows.bash.limitedBy, rows.bash.limitNote, rows.bash.title, rows.bash.label], ['Off', 'Legal', 'limited by Legal', 'Listed: Read-only commands', 'Bash']);
  assert.deepEqual([rows.agents.text, rows.agents.limitedBy, rows.agents.label], ['No subagents', null, 'Agents']);
  assert.deepEqual([rows.worktree.text, rows.worktree.limitedBy], ['No worktree', null]);

  // the limitedBy map alone (no effective.limits) gives the same marks
  const fromMap = powerRows({ ...TAX, effective: { ...TAX.effective, limits: undefined } }, names, { companyFolders: FOLDERS });
  assert.deepEqual(notes(fromMap), notes(powerRows(TAX, names, { companyFolders: FOLDERS })));

  // a token whose folders are only partly cut; a ~ path; a cut the UI cannot tie to a listed entry; flags and kept
  const pos = {
    scope: { kind: 'product', folder: 'C:/Users/you/example-app' },
    powers: { read: ['$company', '~/notes'], write: ['$scope'], tools: ['Read', 'Agent'], bash: 'on', agents: true, worktree: true },
    effective: { tools: ['Read'], bash: 'readonly', agents: false, worktree: false, workspace: 'C:/Users/you/helm-team/example-co/positions/x',
      limits: [{ power: 'read', value: 'C:/Users/you/example-app', by: 'qa' }, { power: 'read', value: 'C:/Users/you/notes', by: 'company' },
        { power: 'write', value: 'C:/Users/you/example-app', by: 'legal', kept: ['C:/Users/you/example-app/docs'] }, { power: 'read', value: 'D:/elsewhere', by: 'legal' },
        { power: 'tools', value: 'Agent', by: 'legal' }, { power: 'bash', value: 'on', max: 'readonly', by: 'qa' }, { power: 'agents', value: true, by: 'legal' }, { power: 'worktree', value: true, by: 'company' }] },
  };
  const r = byId(powerRows(pos, names, { companyFolders: FOLDERS }).map((x) => ({ ...x, id: x.key })));
  assert.deepEqual(r.read.items.map((i) => [i.label, i.limitNote, !!i.partly]), [
    ['Company folders', 'limited by App QA', true], ['~/notes', 'outside the company folders', false], ['D:/elsewhere', 'limited by Legal', false]]);
  assert.deepEqual(r.write.items.map((i) => [i.label, i.limitNote, i.partly]), [['Its scope: example-app', 'limited by Legal', false]]);
  assert.match(r.write.items[0].title, /Keeps only: C:\/Users\/you\/example-app\/docs/);
  assert.equal(r.tools.items[1].limitNote, 'limited by Legal');
  assert.deepEqual([r.bash.text, r.bash.limitNote], ['Read-only commands', 'limited by App QA']);
  assert.deepEqual([r.agents.text, r.agents.limitNote, r.agents.title], ['No subagents', 'limited by Legal', 'Listed: May use subagents']);
  assert.deepEqual([r.worktree.text, r.worktree.limitNote], ['No worktree', 'outside the company folders']);

  // no effective block: own powers as is, nothing limited
  const plain = powerRows({ powers: { read: ['$company'], tools: ['Read'], bash: 'off', agents: false } });
  assert.equal(plain[0].items[0].label, 'Company folders');
  assert.ok(plain.every((x) => (x.items ? x.items.every((i) => i.limitedBy === null) : x.limitedBy === null)));
  assert.equal(plain[3].text, 'Off'); assert.equal(plain[4].text, 'No subagents'); assert.equal(plain[5].text, 'No worktree');
  assert.equal(powerRows({ powers: { bash: 'readonly' }, effective: { bash: 'on', limits: [] } })[3].limitedBy, null);
  assert.equal(powerRows(null).length, 6);
});

// ---------------------------------------------------------------- duties
test('cronWords: common schedules in words, raw fallback', () => {
  assert.equal(cronWords('0 9 * * *'), 'Every day at 09:00');
  assert.equal(cronWords('30 8 * * 1-5'), 'Weekdays at 08:30');
  assert.equal(cronWords('0 10 * * 1'), 'Every Monday at 10:00');
  assert.equal(cronWords('0 10 * * 1,3,5'), 'Every Monday, Wednesday and Friday at 10:00');
  assert.equal(cronWords('0 10 * * 0'), 'Every Sunday at 10:00');
  assert.equal(cronWords('0 10 * * 7'), 'Every Sunday at 10:00');
  const ord = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 11: '11th', 12: '12th', 13: '13th', 21: '21st', 22: '22nd', 23: '23rd', 31: '31st' };
  for (const [d, w] of Object.entries(ord)) assert.equal(cronWords(`0 9 ${d} * *`), `Monthly on the ${w} at 09:00`);
  assert.equal(cronWords('0 9 1 1,4,7,10 *'), 'On the 1st of Jan, Apr, Jul and Oct at 09:00');
  assert.equal(cronWords('15 6 25 12 *'), 'On the 25th of Dec at 06:15');
  assert.equal(cronWords('*/15 * * * *'), 'Every 15 minutes');
  assert.equal(cronWords('*/1 * * * *'), 'Every minute');
  assert.equal(cronWords('0 */2 * * *'), 'Every 2 hours');
  assert.equal(cronWords('0 */1 * * *'), 'Every hour');
  assert.equal(cronWords('5 * * * *'), 'Every hour at :05');
  assert.equal(cronWords('  0   9 * *   * '), 'Every day at 09:00');
  for (const raw of ['0 9 * * 1-3', '0 9 L * *', '0 9 1 13 *', '0 9 1 * 1', '* * * * *', '0 9,17 * * *'])
    assert.equal(cronWords(raw), `Schedule ${raw}`);
  assert.equal(cronWords('bad'), 'Schedule bad');
  assert.equal(cronWords(''), 'No schedule');
  assert.equal(cronWords(null), 'No schedule');
});

test('triggerWords: schedule, commit, release, file', () => {
  const product = { kind: 'product', folder: 'C:/Users/you/example-app' };
  assert.equal(triggerWords({ kind: 'schedule', cron: '0 9 * * *', catchUp: 'skip' }), 'Every day at 09:00 · skips missed runs');
  assert.equal(triggerWords({ kind: 'schedule', cron: '0 9 * * *', catchUp: 'once' }), 'Every day at 09:00');
  assert.equal(triggerWords({ kind: 'event', event: 'commit', repo: 'C:/Users/you/example-site', paths: ['**/privacy*', '**/terms*'] }),
    'On a new commit to example-site touching **/privacy*, **/terms*');
  assert.equal(triggerWords({ kind: 'event', event: 'commit', repo: '$scope', branch: 'main' }, product), 'On a new commit to example-app (main)');
  assert.equal(triggerWords({ kind: 'event', event: 'commit', repo: '$scope', paths: [] }, { kind: 'company' }), 'On a new commit to its scope');
  assert.equal(triggerWords({ kind: 'event', event: 'release', repo: 'C:/Users/you/example-app', tag: 'v*' }), 'On a new tag v* in example-app');
  assert.equal(triggerWords({ kind: 'event', event: 'release', repo: '$scope' }, product), 'On a new tag in example-app');
  assert.equal(triggerWords({ kind: 'event', event: 'file', path: 'C:\\Users\\you\\example-site\\config.json' }), 'When config.json changes');
  assert.equal(triggerWords(null), 'No trigger');
  assert.equal(triggerWords({ kind: 'webhook' }), 'Custom trigger');
});

// ---------------------------------------------------------------- cross-talk
const T = NOW;
const RAW = [
  { at: T - 16 * MIN, ticket: 'a1', chain: 'a1', from: { kind: 'ceo', sessionId: 's_ceo' }, to: 'legal', kind: 'report', state: 'asked', question: 'Q1' },
  { at: T - 16 * MIN + 2000, ticket: 'a1', state: 'delivered' },
  { at: T - 15 * MIN, ticket: 'a2', parentTicket: 'a1', chain: 'a1', from: { kind: 'position', id: 'legal' }, to: 'tax', kind: 'report', state: 'asked', question: 'Q2' },
  { at: T - 14 * MIN, ticket: 'a2', state: 'answered', answer: 'A2' },
  { at: T - 13 * MIN, ticket: 'a3', parentTicket: 'a1', chain: 'a1', from: { kind: 'position', id: 'legal' }, to: 'contracts', kind: 'report', state: 'asked', question: 'Q3' },
  { at: T - 12 * MIN, ticket: 'a1', state: 'answered', answer: 'A1', tookMs: 220_000 },
  { at: T - 2 * HOUR, ticket: 'b1', chain: 'b1', from: { kind: 'position', id: 'marketing' }, to: 'legal', kind: 'colleague', state: 'asked', question: 'Can we say "no tracking"?' },
  { at: T - 2 * HOUR + 95_000, ticket: 'b1', state: 'answered', answer: 'Yes, for now.' },
  { at: T - 1 * MIN, ticket: 'z1', parentTicket: 'nope', chain: 'nope', from: { kind: 'owen' }, to: 'marketing', kind: 'report', state: 'asked', question: 'Q4' },
];

test('foldCrosstalk: one entry per ticket, chains nested, newest chain first, children oldest first', () => {
  const f = foldCrosstalk(RAW);
  assert.deepEqual(f.map((e) => e.ticket), ['z1', 'a1', 'b1']);
  const a1 = f[1];
  assert.deepEqual(a1.children.map((e) => e.ticket), ['a2', 'a3']);
  assert.deepEqual([a1.state, a1.question, a1.answer, a1.to, a1.askedAt, a1.doneAt, a1.tookMs], ['answered', 'Q1', 'A1', 'legal', T - 16 * MIN, T - 12 * MIN, 220_000]);
  const [a2, a3] = a1.children;
  assert.deepEqual([a2.state, a2.askedAt, a2.doneAt, a2.tookMs, a2.answer], ['answered', T - 15 * MIN, T - 14 * MIN, 60_000, 'A2']);
  assert.deepEqual([a3.state, a3.doneAt, a3.tookMs], ['asked', undefined, undefined]);
  assert.equal(f[2].tookMs, 95_000);
  assert.deepEqual(f[0].children, [], 'an unknown parent stays top-level');
  assert.equal(countCrosstalk(f), 5);
  assert.deepEqual(foldCrosstalk(RAW.slice().reverse()), f, 'input order does not matter');
  assert.deepEqual(foldCrosstalk(null), []);
  assert.deepEqual(foldCrosstalk([null, { at: 1 }]), []);
});

test('foldCrosstalk: idempotent on already-folded entries, including nested children', () => {
  const f = foldCrosstalk(RAW);
  const again = foldCrosstalk(f);
  assert.deepEqual(again, f);
  assert.equal(countCrosstalk(again), 5);
  // folded state plus a newer raw line for a child: the child finishes, its parent chain keeps it
  const more = foldCrosstalk([...f, { at: T - 11 * MIN, ticket: 'a3', state: 'answered', answer: 'A3' }]);
  const a3 = more.find((e) => e.ticket === 'a1').children.find((e) => e.ticket === 'a3');
  assert.deepEqual([a3.state, a3.askedAt, a3.doneAt, a3.tookMs, a3.question], ['answered', T - 13 * MIN, T - 11 * MIN, 2 * MIN, 'Q3']);
  // a parentTicket loop never drops either entry
  const loop = foldCrosstalk([{ at: 1, ticket: 'p', parentTicket: 'q', state: 'asked' }, { at: 2, ticket: 'q', parentTicket: 'p', state: 'asked' },
    { at: 3, ticket: 'r', parentTicket: 'p', state: 'asked' }]);
  assert.equal(countCrosstalk(loop), 3);
  assert.deepEqual(loop.map((e) => e.ticket).sort(), ['p', 'q']);
  assert.deepEqual(loop.find((e) => e.ticket === 'p').children.map((e) => e.ticket), ['r'], 'below the loop still nests');
});

test('crosstalkLine: names, live tickets show elapsed time, terminal ones tookMs', () => {
  const names = { legal: 'Legal', tax: 'Tax Specialist', marketing: 'Marketing' };
  const f = foldCrosstalk(RAW);
  const a1 = crosstalkLine(f[1], names, NOW);
  assert.deepEqual(a1, { from: 'CEO', to: 'Legal', when: '11:44', q: 'Q1', state: 'answered', stateText: 'answered', tone: 'ok', took: '3m 40s', colleague: false });
  const a2 = crosstalkLine(f[1].children[0], names, NOW);
  assert.deepEqual([a2.from, a2.to, a2.took], ['Legal', 'Tax Specialist', '1m']);
  const z1 = crosstalkLine(f[0], names, NOW);
  assert.deepEqual([z1.from, z1.to, z1.state, z1.tone, z1.took], ['You', 'Marketing', 'asked', 'live', '1m']);
  assert.equal(crosstalkLine(f[1].children[1], names, NOW).took, '13m', 'live: elapsed since asked');
  assert.equal(crosstalkLine(f[2], names, NOW).colleague, true);
  assert.equal(crosstalkLine(f[2], names, NOW).took, '1m 35s');
  const delivered = crosstalkLine({ askedAt: NOW - 30_000, state: 'delivered', to: 'nobody', from: 'legal' }, names, NOW);
  assert.deepEqual([delivered.from, delivered.to, delivered.stateText, delivered.tone, delivered.took], ['Legal', 'nobody', 'answering', 'live', '30s']);
  assert.equal(crosstalkLine({ state: 'refused', tookMs: 5000 }, names, NOW).tone, 'danger');
  assert.equal(crosstalkLine({ state: 'expired' }, names, NOW).took, '');
  assert.equal(crosstalkLine({ askedAt: at(15, 9), state: 'answered', question: 'x'.repeat(200) }, names, NOW).when, 'Nov 15');
  assert.equal(crosstalkLine({ question: 'x'.repeat(200) }, names, NOW).q.length, 90);
});

// ---------------------------------------------------------------- notebook
const NB = ['# Legal · notebook', '## Open items', '- [ ] one', '- [x] two', '```', '- [ ] fenced, not a task', '```',
  'Some text', '  * [X] three', '~~~md', '```', '- [ ] still fenced', '~~~', '+ [ ] four'].join('\n');

test('parseNotebook: counts open/done, skips fenced task-looking lines, keeps markdown blocks between tasks', () => {
  const nb = parseNotebook(NB);
  assert.equal(nb.open, 2); assert.equal(nb.done, 2);
  assert.equal(countOpenItems(NB), 2);
  const tasks = nb.blocks.filter((b) => b.kind === 'task');
  assert.deepEqual(tasks.map((t) => [t.line, t.checked, t.text, t.indent]), [[2, false, 'one', 0], [3, true, 'two', 0], [8, true, 'three', 2], [13, false, 'four', 0]]);
  const md = nb.blocks.filter((b) => b.kind === 'md');
  assert.deepEqual(md.map((b) => [b.line, b.text]), [
    [0, '# Legal · notebook\n## Open items'],
    [4, '```\n- [ ] fenced, not a task\n```\nSome text'],
    [9, '~~~md\n```\n- [ ] still fenced\n~~~'],
  ]);
  assert.deepEqual(nb.blocks.map((b) => b.kind), ['md', 'task', 'task', 'md', 'task', 'md', 'task'], 'blocks stay in file order');
  assert.deepEqual(parseNotebook('a\r\n- [ ] b\r\n').blocks.filter((b) => b.kind === 'task').map((b) => b.text), ['b']);
  assert.equal(parseNotebook(null).open, 0);
  assert.equal(parseNotebook('- [ ]\n-[ ] x\n- [y] z').open, 0);
});

test('toggleItem: flips the right line, keeps CRLF, null when the line is no longer a checkbox', () => {
  const ticked = toggleItem(NB, 2, true);
  assert.equal(ticked.split('\n')[2], '- [x] one');
  assert.equal(ticked.split('\n').filter((l, i) => i !== 2).join('\n'), NB.split('\n').filter((l, i) => i !== 2).join('\n'));
  assert.equal(toggleItem(NB, 8, false).split('\n')[8], '  * [ ] three');
  assert.equal(toggleItem(NB, 3, true), NB, 'already ticked: unchanged');
  const crlf = NB.replace(/\n/g, '\r\n');
  const out = toggleItem(crlf, 13, true);
  assert.equal(out, crlf.replace('+ [ ] four', '+ [x] four'));
  assert.ok(!/[^\r]\n/.test(out), 'every line ending stays CRLF');
  assert.equal(toggleItem(NB, 0, true), null);
  assert.equal(toggleItem(NB, 99, true), null);
  assert.equal(toggleItem('', 0, true), null);
  assert.equal(parseNotebook(ticked).open, 1);
});

// ---------------------------------------------------------------- chats
test('chatRows: newest first, current = newest without endedAt, end reasons in words', () => {
  const iso = (t) => new Date(t).toISOString();
  const chats = [
    { n: 1, startedAt: iso(at(8, 10)), endedAt: iso(at(15, 10)), endReason: 'full', contextPct: 33.1, handoff: 'Done: x', helmSessionId: 's1' },
    { n: 3, startedAt: iso(at(17, 10)), helmSessionId: 's3' },
    { n: 2, startedAt: iso(at(15, 10)), endedAt: iso(at(17, 9)), endReason: 'manual' },
    { n: 'x' }, null,
  ];
  const rows = chatRows(chats, NOW);
  assert.deepEqual(rows.map((r) => [r.n, r.current, r.label]), [[3, true, 'Chat 3'], [2, false, 'Chat 2'], [1, false, 'Chat 1']]);
  assert.equal(rows[0].sub, 'Current · started 10:00');
  assert.equal(rows[0].sessionId, 's3');
  assert.equal(rows[1].sub, 'Nov 15 – 09:00 · ended by you');
  assert.equal(rows[2].sub, 'Nov 8 – Nov 15 · was full');
  assert.deepEqual([rows[2].pct, rows[2].handoff, rows[1].pct, rows[1].sessionId], [33.1, 'Done: x', null, null]);
  const reasons = ['handoff-failed', 'retired', 'something-new'].map((endReason) => chatRows([{ n: 1, endedAt: iso(at(16, 9)), endReason }], NOW)[0].sub);
  assert.deepEqual(reasons, ['Nov 16 · handoff failed', 'Nov 16 · position retired', 'Nov 16 · something-new']);
  const allEnded = chatRows([{ n: 1, endedAt: iso(at(16, 9)) }, { n: 2, endedAt: iso(at(17, 9)) }], NOW);
  assert.ok(allEnded.every((r) => !r.current), 'no current chat when the newest has ended');
  assert.equal(chatRows([{ n: 1 }, { n: 2, endedAt: iso(at(17, 9)) }], NOW)[1].current, false, 'only the newest can be current');
  assert.deepEqual(chatRows(null), []);
});

// ---------------------------------------------------------------- proposals + inbox
test('proposalTitle: create / edit / retire / company', () => {
  const names = { legal: 'Legal', contracts: 'Contracts' };
  assert.equal(proposalTitle({ action: 'create', target: 'tax', parent: 'legal', draft: { name: 'Tax Specialist' } }, names), 'New position: Tax Specialist under Legal');
  assert.equal(proposalTitle({ action: 'create', target: 'tax', draft: { name: 'Tax Specialist', parent: 'legal' } }, names), 'New position: Tax Specialist under Legal');
  assert.equal(proposalTitle({ action: 'create', target: 'tax', parent: 'unknown' }, names), 'New position: tax under unknown');
  assert.equal(proposalTitle({ action: 'create', target: 'tax', draft: { name: 'Tax Specialist' } }, names), 'New position: Tax Specialist under the CEO');
  assert.equal(proposalTitle({ action: 'edit', target: 'legal', draft: { name: 'Legal (new)' } }, names), 'Change Legal');
  assert.equal(proposalTitle({ action: 'edit', target: 'qa', draft: { name: 'App QA' } }, names), 'Change App QA');
  assert.equal(proposalTitle({ action: 'retire', target: 'contracts' }, names), 'Retire Contracts');
  assert.equal(proposalTitle({ action: 'retire', target: 'gone' }, names), 'Retire gone');
  assert.equal(proposalTitle({ action: 'company', draft: { name: 'Harbor Books' } }), 'New company: Harbor Books');
  assert.equal(proposalTitle({ action: 'company' }), 'New company:');
  assert.equal(proposalTitle({ action: 'edit', title: 'Own title' }), 'Own title');
  assert.equal(proposalTitle({ action: 'other' }), 'Proposal');
  assert.equal(proposalTitle(null), '');
});

test('decidedText: click vs typed quote, declined, superseded', () => {
  const iso = (t) => new Date(t).toISOString();
  assert.equal(decidedText({ status: 'open' }), '');
  assert.equal(decidedText({}), '');
  assert.equal(decidedText({ status: 'approved', decision: { at: iso(at(17, 14, 2)), how: 'click', result: 'approved' } }), 'Approved 14:02 (your click)');
  assert.equal(decidedText({ status: 'approved', decision: { at: iso(at(17, 14, 2)), how: 'typed', quote: 'yes, make it' } }), "Approved 14:02 (your reply 'yes, make it')");
  assert.equal(decidedText({ decision: { at: iso(at(13, 9, 5)), how: 'typed', result: 'declined' } }), 'Declined 09:05 (your reply)');
  assert.equal(decidedText({ status: 'declined', decision: { how: 'click' } }), 'Declined (your click)');
  assert.equal(decidedText({ decision: { result: 'superseded' } }), 'Superseded by a newer proposal');
  assert.equal(decidedText({ status: 'superseded', decision: { how: 'click' } }), 'Superseded by a newer proposal');
  const long = decidedText({ status: 'approved', decision: { how: 'typed', quote: 'y'.repeat(100) } });
  assert.equal(long, `Approved (your reply '${'y'.repeat(39)}…')`);
});

test('splitProposals / liveInbox', () => {
  const iso = (t) => new Date(t).toISOString();
  const list = [
    { id: 'o1', at: iso(NOW - 2 * HOUR), status: 'open' },
    { id: 'd1', at: iso(NOW - 3 * DAY), status: 'approved' },
    { id: 'o2', at: iso(NOW - 25 * MIN) },
    { id: 'd2', at: iso(NOW - DAY), decision: { result: 'declined' } },
    { id: 's1', at: iso(NOW - 5 * DAY), decision: { result: 'superseded' } },
  ];
  const s = splitProposals(list);
  assert.deepEqual(s.open.map((p) => p.id), ['o2', 'o1']);
  assert.deepEqual(s.decided.map((p) => p.id), ['d2', 'd1', 's1']);
  assert.deepEqual(splitProposals(null), { open: [], decided: [] });
  assert.deepEqual(liveInbox([{ id: 1 }, { id: 2, dismissedAt: 'x' }, null, { id: 3 }]).map((e) => e.id), [1, 3]);
  assert.deepEqual(liveInbox(undefined), []);
});

// ---------------------------------------------------------------- proposal changes (engine card shapes)
test('scopeWords / pathWords / parsePowerEntry / powerWords', () => {
  assert.equal(M.scopeWords({ kind: 'company' }), 'The whole company');
  assert.equal(M.scopeWords({ kind: 'product', folder: 'C:/Users/you/example-app/' }), 'One product: example-app');
  assert.equal(M.scopeWords({ kind: 'product' }), 'One product');
  for (const s of [null, undefined, {}, '']) assert.equal(M.scopeWords(s), 'The whole company');
  assert.equal(M.scopeWords('custom'), 'custom');
  assert.equal(M.pathWords('$workspace'), 'its workspace');
  assert.equal(M.pathWords('$company'), 'company folders');
  assert.equal(M.pathWords('$scope', { kind: 'product', folder: 'C:/a/app' }), 'its scope (app)');
  assert.equal(M.pathWords('$scope', { kind: 'company' }), 'its scope (company folders)');
  assert.equal(M.pathWords('C:/Users/you/x'), 'C:/Users/you/x');
  // proposals.js powerEntries strings
  assert.deepEqual(M.parsePowerEntry('read: $workspace'), { power: 'read', value: '$workspace' });
  assert.deepEqual(M.parsePowerEntry('tools: WebFetch'), { power: 'tools', value: 'WebFetch' });
  assert.deepEqual(M.parsePowerEntry('bash: "on"'), { power: 'bash', value: 'on' });
  assert.deepEqual(M.parsePowerEntry('agents: true'), { power: 'agents', value: true });
  assert.deepEqual(M.parsePowerEntry('read: ["C:/a"]'), { power: 'read', value: ['C:/a'] });
  assert.deepEqual(M.parsePowerEntry('odd'), { power: 'odd', value: true });
  assert.deepEqual(M.powerWords('read', '$workspace'), { label: 'Read its workspace', mono: false, title: '$workspace' });
  assert.deepEqual(M.powerWords('write', 'C:/Users/you/out'), { label: 'Write C:/Users/you/out', mono: true, title: 'C:/Users/you/out' });
  assert.equal(M.powerWords('tools', 'WebFetch').label, 'WebFetch');
  assert.equal(M.powerWords('bash', 'readonly').label, 'Bash read-only');
  assert.equal(M.powerWords('agents', true).label, 'Subagents');
  assert.equal(M.powerWords('worktree', false).label, 'No git worktree');
  assert.equal(M.powerWords('model', 'x').label, 'model: x');
});

test('excessRows / excessOf / excessHeadline: who cuts what, in words', () => {
  const names = { 'payroll-tax': 'Payroll Tax', legal: 'Legal', operations: 'Operations' };
  const rows = M.excessRows([{ power: 'tools', value: 'WebFetch', by: 'payroll-tax' }, { power: 'bash', value: 'on', max: 'off', by: 'legal' },
    { power: 'bash', value: 'on', max: 'readonly', by: 'legal' }, { power: 'agents', value: true, by: 'legal' },
    { power: 'read', value: 'C:/Users/you/old', by: 'company', kept: ['C:/Users/you/old/docs'] }, { power: 'write', value: 'C:/x', by: null }, null, { value: 'no power' }], names);
  assert.deepEqual(rows.map((r) => [r.label, r.by, r.byName, r.why]), [
    ['WebFetch', 'payroll-tax', 'Payroll Tax', 'Payroll Tax does not have it'], ['Bash on', 'legal', 'Legal', 'Legal has no Bash'],
    ['Bash on', 'legal', 'Legal', 'Legal allows Bash read-only at most'], ['Subagents', 'legal', 'Legal', 'Legal does not have it'],
    ['Read C:/Users/you/old', 'company', null, 'outside the company folders'], ['Write C:/x', 'company', null, 'outside the company folders']]);
  assert.deepEqual([rows[4].kept, rows[4].mono, rows[1].max, rows[0].max], [['C:/Users/you/old/docs'], true, 'off', null]);
  const wait = M.excessRows([{ power: 'parent', value: 'operations', by: null }], (id) => names[id]);
  assert.deepEqual([wait[0].waits, wait[0].label], [true, 'Its manager (Operations) is not approved yet']);
  assert.deepEqual(M.excessOf({ excess: [1], diff: { excess: [2] } }), [1]);
  assert.deepEqual(M.excessOf({ excess: [], diff: { excess: [2] } }), [2]);
  assert.deepEqual(M.excessOf({}), []);
  assert.deepEqual(M.excessOf(null), []);
  assert.equal(M.excessHeadline(rows, 'State Payroll'), '6 powers go beyond its manager\'s, so State Payroll will not have them even if you approve');
  assert.equal(M.excessHeadline(rows.slice(0, 1)), 'One power goes beyond its manager\'s, so the position will not have it even if you approve');
  assert.equal(M.excessHeadline(wait), 'Its powers are checked once its manager is approved');
  assert.equal(M.excessHeadline([]), '');
});

test('briefDiffRows: the engine line diff with 2 lines of context, long same runs folded', () => {
  const text = [' a', ' b', ' c', ' d', ' e', ' f', '-g', '+h', ' i', ' j', ' k', ' l', '+m', '+'].join('\n');
  const r = M.briefDiffRows(text);
  assert.deepEqual(r.rows.map((x) => (x.t === 'gap' ? `gap${x.n}` : `${x.t}:${x.text}`)), ['gap4', 'same:e', 'same:f', 'del:g', 'add:h', 'same:i', 'same:j', 'same:k', 'same:l', 'add:m', 'add:']);
  assert.deepEqual([r.added, r.removed], [3, 1]);
  assert.deepEqual(M.briefDiffRows(' x\n y\n').rows, [{ t: 'gap', n: 2 }], 'no change: all folded');
  assert.deepEqual(M.briefDiffRows(null), { rows: [], added: 0, removed: 0 });
  assert.deepEqual(M.briefDiffRows('-a\r\n+b').rows.map((x) => x.t), ['del', 'add']);
});

test('fieldChanges / proposalChanges / draftPowerChips', () => {
  const names = { legal: 'Legal', tax: 'Tax Specialist' };
  const diff = { name: { from: 'Payroll Tax', to: 'Payroll & Contractors' }, parent: { from: 'legal', to: null }, scope: { from: { kind: 'company' }, to: { kind: 'product', folder: 'C:/Users/you/app' } },
    model: { from: null, to: 'claude-sonnet-5-5' }, effort: { from: 'high', to: null }, status: { from: 'active', to: 'paused' }, remit: 'not an object', brief: ' x' };
  assert.deepEqual(M.fieldChanges(diff, names).map((f) => [f.label, f.from, f.to, f.toTitle]), [
    ['Name', 'Payroll Tax', 'Payroll & Contractors', undefined], ['Reports to', 'Legal', 'the CEO', undefined], ['Scope', 'The whole company', 'One product: app', 'C:/Users/you/app'],
    ['Model', 'Helm default', 'claude-sonnet-5-5', undefined], ['Effort', 'high', 'Helm default', undefined], ['Status', 'Active', 'Paused', undefined]]);
  assert.deepEqual(M.fieldChanges(null), []);

  const card = { action: 'edit', target: 'payroll-tax', draft: { scope: { kind: 'product', folder: 'C:/Users/you/app' }, duties: [{ id: 'q', title: 'Quarterly', trigger: { kind: 'schedule', cron: '0 9 * * *' } }, { id: 'w', title: 'Weekly (new)' }] },
    diff: { brief: ' a\n+b', powers: { added: ['write: $scope', 'bash: "readonly"'], removed: ['tools: WebSearch'] }, duties: { added: ['q', 'w'], removed: ['w', 'old'] },
      excess: [{ power: 'bash', value: 'readonly', max: 'off', by: 'legal' }] } };
  const ch = M.proposalChanges(card, names, { duties: [{ id: 'old', title: 'Old duty' }] });
  assert.deepEqual(ch.powers.added.map((x) => [x.power, x.value, x.label]), [['write', '$scope', 'Write its scope (app)'], ['bash', 'readonly', 'Bash read-only']]);
  assert.deepEqual(ch.powers.removed.map((x) => x.label), ['WebSearch']);
  assert.deepEqual([ch.duties.added.map((d) => d.title), ch.duties.changed.map((d) => d.title), ch.duties.removed.map((d) => d.title)], [['Quarterly'], ['Weekly (new)'], ['Old duty']]);
  assert.ok(ch.duties.added[0].trigger && !/^Schedule /.test(ch.duties.added[0].trigger));
  assert.deepEqual([ch.brief.added, ch.excess.map((x) => x.why)], [1, ['Legal has no Bash']]);
  assert.deepEqual(M.proposalChanges({ action: 'create', draft: {} }), { fields: [], brief: null, powers: null, duties: null, excess: [] });

  const chips = M.draftPowerChips({ read: ['$workspace', 'C:/Users/you/old/'], write: ['$workspace'], tools: ['Read', 'WebFetch'], bash: 'on', agents: true, worktree: false },
    { kind: 'company' }, [{ power: 'read', value: 'C:/Users/you/old', by: 'company' }, { power: 'tools', value: 'WebFetch', by: 'tax' }, { power: 'bash', value: 'on', max: 'off', by: 'legal' }]);
  assert.deepEqual(chips.map((c) => [c.label, c.cut]), [['Read its workspace', false], ['Read C:/Users/you/old/', true], ['Write its workspace', false], ['Read', false], ['WebFetch', true], ['Bash on', true], ['Subagents', false]]);
  assert.deepEqual(M.draftPowerChips(null), []);
});

test('foldCrosstalk: team.crosstalk entries (folded, ISO askedAt / answeredAt) fold to epoch times and nest', () => {
  const isoT = (t) => new Date(t).toISOString();
  const entries = [
    { ticket: 'c2', parentTicket: 'c1', chain: 'c1', from: { kind: 'position', id: 'legal', name: 'Legal' }, to: 'tax', toName: 'Tax Specialist', kind: 'report', state: 'answered', question: 'Q2',
      askedAt: isoT(T - 15 * MIN), answer: 'A2', answeredAt: isoT(T - 14 * MIN), tookMs: 61_000, costUsd: 0.01 },
    { ticket: 'c1', chain: 'c1', from: { kind: 'ceo', name: 'CEO' }, to: 'legal', toName: 'Legal', kind: 'report', state: 'delivered', question: 'Q1', askedAt: isoT(T - 16 * MIN) },
    { ticket: 'c0', chain: 'c0', from: { kind: 'ceo', name: 'CEO' }, to: 'legal', toName: 'Legal', kind: 'report', state: 'answered', question: 'Q0', askedAt: isoT(T - 3 * DAY), answeredAt: isoT(T - 3 * DAY + 90_000) },
  ];
  const f = foldCrosstalk(entries);
  assert.deepEqual(f.map((e) => e.ticket), ['c1', 'c0']);
  const [c1, c0] = f;
  assert.deepEqual([c1.askedAt, c1.doneAt, c1.state], [T - 16 * MIN, undefined, 'delivered']);
  assert.deepEqual(c1.children.map((e) => [e.ticket, e.askedAt, e.answeredAt, e.doneAt, e.tookMs]), [['c2', T - 15 * MIN, T - 14 * MIN, T - 14 * MIN, 61_000]]);
  assert.deepEqual([c0.doneAt, c0.tookMs], [T - 3 * DAY + 90_000, 90_000], 'tookMs from the times when the entry has none');
  assert.deepEqual(foldCrosstalk(f), f, 'idempotent');
  const line = crosstalkLine(c1.children[0], { tax: 'Tax Specialist' }, NOW);
  assert.deepEqual([line.from, line.to, line.took, line.when], ['Legal', 'Tax Specialist', '1m 1s', '11:45']);
});

// ---------------------------------------------------------------- mock consistency
test('mock: team.list / team.get / team.position / team.crosstalk tell one consistent story', async () => {
  const { rpc } = createMockTeam({ now: NOW });
  const list = await rpc('team.list');
  assert.equal(list.enabled, true);
  const co = list.companies.find((c) => c.name === 'Example Co');
  assert.ok(co, 'Example Co is listed');
  const got = await rpc('team.get', { company: co.id });
  const ix = indexTree(got.tree);
  assert.equal(Math.max(...ix.depth.values()), 3, 'three levels');
  assert.equal(ix.orphan.size, 0);
  assert.equal(got.tree.filter((r) => liveStatus(r) === 'working').length, 1, 'exactly one working row');
  assert.ok(got.tree.some((r) => r.pending.requests > 0), 'a row with a pending request');
  assert.ok(got.proposals.some((p) => p.status === 'open'), 'an open proposal');
  assert.ok(got.tree.some((r) => r.nextDuty && r.nextDuty.at > NOW && r.nextDuty.at - NOW < DAY), 'a duty due within 24 h');
  assert.ok(got.tree.every((r) => r.id && r.name && 'parent' in r && r.pending), 'row shape');
  const rowSum = got.tree.reduce((n, r) => n + needsYou(r), 0);
  assert.ok(co.needsYou >= rowSum, 'team.list needsYou includes the rows (plus the inbox)');
  assert.equal(companyCounts(got.tree, co.needsYou).needsYou, co.needsYou);
  for (const r of got.tree) assert.deepEqual([...r.reports].sort(), [...(ix.kids.get(r.id) || [])].sort(), `reports of ${r.id}`);

  const names = Object.fromEntries(got.tree.map((r) => [r.id, r.name]));
  const tp = await rpc('team.position', { company: co.id, id: 'tax' });
  for (const k of ['position', 'chats', 'duties', 'grants']) assert.ok(k in tp, `team.position has ${k}`);
  assert.ok(tp.position.effective, 'position.effective');
  const tools = powerRows(tp.position, names).find((r) => r.key === 'tools');
  assert.ok(tools.items.some((i) => i.limitedBy === 'Legal'), 'tax shows a tool limited by Legal');
  for (const d of tp.duties) assert.ok(!/^Schedule /.test(triggerWords(d.trigger, tp.position.scope)), `duty ${d.id} trigger reads in words`);
  for (const id of Object.keys(names)) {
    const p = await rpc('team.position', { company: co.id, id });
    for (const d of p.duties) assert.ok(!/^Schedule |^Custom/.test(triggerWords(d.trigger, p.position.scope)), `${id}/${d.id} trigger in words`);
    assert.ok(chatRows(p.chats, NOW).filter((c) => c.current).length <= 1);
  }

  // team.crosstalk: runtime.crosstalk's folded entries (one per ticket, ISO times, newest first), names included
  const ct = await rpc('team.crosstalk', { company: co.id });
  assert.equal(ct.hasMore, false);
  assert.equal(new Set(ct.entries.map((e) => e.ticket)).size, ct.entries.length, 'one entry per ticket');
  assert.deepEqual(ct.entries.map((e) => e.askedAt), ct.entries.map((e) => e.askedAt).slice().sort().reverse(), 'newest first');
  assert.ok(ct.entries.every((e) => typeof e.askedAt === 'string' && !('at' in e) && e.from.name && e.toName));
  const folded = foldCrosstalk(ct.entries);
  assert.ok(folded.some((e) => e.children.length > 0), 'a chain with a child');
  assert.equal(countCrosstalk(folded), ct.entries.length);
  assert.deepEqual(foldCrosstalk(folded), folded);
  const mine = await rpc('team.crosstalk', { company: co.id, position: 'tax' });
  const all = new Set(ct.entries.map((e) => e.ticket));
  assert.ok(mine.entries.length > 0 && mine.entries.every((e) => all.has(e.ticket) && (e.to === 'tax' || e.from.id === 'tax')), 'its own tickets only (to or from it)');
  const older = await rpc('team.crosstalk', { company: co.id, before: ct.entries[0].ticket, limit: 1 });
  assert.deepEqual([older.entries.map((e) => e.ticket), older.hasMore], [[ct.entries[1].ticket], true]);
});

test('mock: Tax Specialist\'s powers are cut the engine way; proposal cards carry excess and an edit diff', async () => {
  const { rpc } = createMockTeam({ now: NOW });
  const got = await rpc('team.get', { company: 'example-co' });
  const names = Object.fromEntries(got.tree.map((r) => [r.id, r.name]));
  const tp = await rpc('team.position', { company: 'example-co', id: 'tax' });
  const eff = tp.position.effective;
  assert.equal(eff.read[0], eff.workspace, 'its workspace first');
  assert.ok(eff.read.every((p) => /^C:\/Users\/you\//.test(p)), 'expanded absolute paths');
  assert.deepEqual(eff.limits, eff.limitedBy);
  assert.deepEqual(Object.keys(tp.position.limitedBy).sort(), ['bash', 'read:C:/Users/you/tax-archive', 'tools:NotebookEdit']);
  const marked = powerRows(tp.position, names, { companyFolders: got.company.folders }).flatMap((r) => (r.items ? r.items.filter((i) => i.limitNote).map((i) => `${r.key}:${i.value}:${i.limitNote}`) : r.limitNote ? [`${r.key}:${r.limitNote}`] : []));
  assert.deepEqual(marked, ['read:C:/Users/you/tax-archive:outside the company folders', 'tools:NotebookEdit:limited by Legal', 'bash:limited by Legal']);
  for (const id of Object.keys(names)) {
    if (id === 'tax') continue;
    const p = await rpc('team.position', { company: 'example-co', id });
    assert.deepEqual(p.position.effective.limits, [], `${id} lists nothing beyond its managers`);
  }

  const open = splitProposals(got.proposals).open;
  const create = open.find((p) => p.action === 'create'), edit = open.find((p) => p.action === 'edit');
  const cut = M.excessRows(M.excessOf(create), names, create.draft.scope);
  assert.deepEqual(cut.map((x) => [x.power, x.by, x.why]), [['read', 'company', 'outside the company folders'], ['tools', 'legal', 'Legal does not have it'], ['bash', 'legal', 'Legal has no Bash']]);
  const ch = M.proposalChanges(edit, names, { duties: [] });
  assert.deepEqual(ch.fields.map((f) => f.key), ['name', 'remit', 'scope']);
  assert.ok(ch.brief.added >= 3 && ch.brief.removed === 1);
  assert.deepEqual([ch.powers.added.map((x) => x.label), ch.powers.removed.map((x) => x.label)], [['Write its scope (example-docs)', 'Bash read-only'], ['WebSearch', 'Bash off']]);
  assert.deepEqual(ch.duties.added.map((d) => d.title), ['Supplier DPA check']);
  assert.equal(ch.excess.length, 2);
  // the engine counts a card for its target and for its parent (wire.js team.get)
  assert.deepEqual(['legal', 'tax', 'contracts'].map((id) => got.tree.find((r) => r.id === id).pending.proposals), [1, 1, 1]);
  assert.deepEqual(tp.pending.proposals.map((p) => p.id), [create.id]);
  const legal = await rpc('team.position', { company: 'example-co', id: 'legal' });
  assert.deepEqual(Object.keys(legal.pending.requests[0]).sort(), ['access', 'at', 'kind', 'requestId', 'sessionId', 'target']);
  assert.deepEqual(legal.pending.requests[0].access.position, { id: 'legal', name: 'Legal', path: ['Legal'] });
});

test('mock ?team=imported: company card first, a position card before it is refused, approving it creates the company', async () => {
  const events = [];
  const { rpc } = createMockTeam({ now: NOW, mode: 'imported', emit: (e, d) => events.push([e, d]) });
  const list = await rpc('team.list');
  assert.deepEqual(list.companies, []);
  assert.deepEqual(list.proposals.map((p) => [p.action, p.company]), [['company', null]]);
  const co = list.proposals[0];
  const all = (await rpc('team.proposals', { status: 'open' })).proposals;
  const jobs = all.filter((p) => p.action === 'create');
  assert.equal(jobs.length, 4);
  assert.ok(jobs.every((p) => p.company === co.target && p.by.kind === 'import' && !('excess' in p)), 'no excess before the company exists');
  assert.ok(jobs.some((p) => p.parent && jobs.some((q) => q.target === p.parent)), 'one under another');
  assert.deepEqual((await rpc('team.proposals', { company: null })).proposals.map((p) => p.id), [co.id]);
  await assert.rejects(rpc('team.get', { company: co.target }), (e) => e.code === 'not_found');

  const ops = jobs.find((p) => p.target === 'operations');
  assert.deepEqual(await rpc('team.decide', { proposal: ops.id, decision: 'approve' }), { ok: false, error: `approve Example Studio (${co.id}) first: the company does not exist yet` });
  assert.equal((await rpc('team.proposals', {})).proposals.find((p) => p.id === ops.id).status, 'open', 'still open, with the error');
  events.length = 0;
  assert.deepEqual(await rpc('team.decide', { proposal: co.id, decision: 'approve' }), { ok: true, created: { company: co.target } });
  assert.deepEqual(events.slice(0, 3).map(([e, d]) => [e, d.company]), [['team.inbox.appended', co.target], ['team.proposal.updated', co.target], ['team.updated', co.target]]);
  const after = await rpc('team.list');
  assert.deepEqual([after.companies.map((c) => c.id), 'proposals' in after], [[co.target], false]);
  const got = await rpc('team.get', { company: co.target });
  assert.deepEqual(got.tree, []);
  assert.equal(splitProposals(got.proposals).open.length, 4);
  assert.deepEqual(got.proposals.find((p) => p.id === co.id).decision.result, 'approved');
  const web = got.proposals.find((p) => p.target === 'web-copy');
  assert.deepEqual(M.excessRows(web.excess, {}).map((x) => x.why), ['outside the company folders'], 'excess once the company exists');
  await assert.rejects(rpc('team.decide', { proposal: co.id, decision: 'approve' }), (e) => e.code === 'refused');
  assert.deepEqual(await rpc('team.decide', { proposal: ops.id, decision: 'approve' }), { ok: true, created: { company: co.target, id: 'operations' } });
  assert.deepEqual((await rpc('team.get', { company: co.target })).tree.map((r) => [r.id, r.depth]), [['operations', 1]]);
  const declined = jobs.find((p) => p.target === 'customer-care');
  assert.deepEqual(await rpc('team.decide', { proposal: declined.id, decision: 'decline' }), { ok: true });
});

test('mock: team.file.write with a stale expectMtime rejects with code conflict', async () => {
  const { rpc } = createMockTeam({ now: NOW });
  const r = await rpc('team.file.read', { company: 'example-co', id: 'legal', file: 'notebook' });
  assert.equal(typeof r.text, 'string'); assert.equal(typeof r.mtime, 'number');
  assert.equal(parseNotebook(r.text).open, (await rpc('team.get', { company: 'example-co' })).tree.find((x) => x.id === 'legal').openItems);
  await assert.rejects(rpc('team.file.write', { company: 'example-co', id: 'legal', file: 'notebook', text: 'x', expectMtime: r.mtime - 1 }), (e) => e.code === 'conflict');
  const fresh = await rpc('team.file.read', { company: 'example-co', id: 'legal', file: 'notebook' });
  const next = toggleItem(fresh.text, parseNotebook(fresh.text).blocks.find((b) => b.kind === 'task' && !b.checked).line, true);
  const w = await rpc('team.file.write', { company: 'example-co', id: 'legal', file: 'notebook', text: next, expectMtime: fresh.mtime });
  assert.ok(w.mtime > fresh.mtime);
  assert.equal((await rpc('team.file.read', { company: 'example-co', id: 'legal', file: 'notebook' })).text, next);
  const conflict = createMockTeam({ now: NOW, mode: 'conflict' });
  const c = await conflict.rpc('team.file.read', { company: 'example-co', id: 'tax', file: 'brief' });
  await assert.rejects(conflict.rpc('team.file.write', { company: 'example-co', id: 'tax', file: 'brief', text: 'x', expectMtime: c.mtime }), (e) => e.code === 'conflict');
});

test('mock: no real names, projects or home paths anywhere in its RPC results', async () => {
  const out = [];
  const call = async (rpc, method, p) => { try { out.push(await rpc(method, p)); } catch (e) { out.push({ error: e.message, code: e.code }); } };
  for (const mode of [null, 'one', 'empty', 'off', 'root', 'nopositions', 'error', 'conflict', 'deep', 'imported']) {
    const events = [];
    const { rpc, data } = createMockTeam({ now: NOW, mode, emit: (e, d) => events.push([e, d]) });
    await call(rpc, 'team.list');
    await call(rpc, 'team.proposals', {});
    await call(rpc, 'team.openCeo', {});
    // approve every open card (the imported company first), so created companies and positions are scanned too
    for (const p of (await rpc('team.proposals', { status: 'open' }).catch(() => ({ proposals: [] }))).proposals.sort((a, b) => (a.action === 'company' ? -1 : b.action === 'company' ? 1 : 0))) {
      await call(rpc, 'team.decide', { proposal: p.id, decision: 'approve' });
    }
    out.push(events);
    for (const c of data.companies) {
      await call(rpc, 'team.get', { company: c.id });
      await call(rpc, 'team.crosstalk', { company: c.id });
      await call(rpc, 'team.inbox', { company: c.id });
      const defs = data.defs[c.id] || {};
      for (const id of Object.keys(defs)) {
        await call(rpc, 'team.position', { company: c.id, id });
        await call(rpc, 'team.crosstalk', { company: c.id, position: id });
        await call(rpc, 'team.open', { company: c.id, id });
        for (const file of ['brief', 'notebook']) await call(rpc, 'team.file.read', { company: c.id, id, file });
      }
    }
    await call(rpc, 'team.file.write', { company: 'example-co', id: 'legal', file: 'brief', text: 'x', expectMtime: -1 });
    await call(rpc, 'team.nope', {});
  }
  const json = JSON.stringify(out);
  assert.ok(json.length > 10_000, 'the scan saw real content');
  assert.doesNotMatch(json, /owens/i);
  assert.doesNotMatch(json.replace(/needsOwen/g, ''), /Owen/);
  assert.doesNotMatch(json, /atlas/i);
  const homes = [...json.matchAll(/[A-Za-z]:(?:\\\\|\/)+Users(?:\\\\|\/)+([^\\/"]+)/g)].map((m) => m[1]);
  assert.ok(homes.length > 0);
  assert.deepEqual([...new Set(homes)], ['you']);
  assert.doesNotMatch(json, /\/home\/|\/Users\/(?!you)|~\//);
});

test('PROTOCOL shapes: status active|paused + busy, pending requests -> waiting, position.limitedBy map', () => {
  const M = require('../../ui/lib/positions-model.js');
  assert.equal(M.liveStatus({ status: 'active' }), 'idle');
  assert.equal(M.liveStatus({ status: 'active', busy: 'answering CEO' }), 'working');
  assert.equal(M.liveStatus({ status: 'active', busy: 'answering CEO', pending: { requests: 1 } }), 'waiting');
  assert.equal(M.liveStatus({ status: 'paused', busy: 'answering CEO' }), 'paused');
  const now = new Date(2026, 10, 18, 12, 0).getTime();
  const a = M.rowActivity({ busy: 'answering CEO', lastActivity: { at: now - 5 * 60_000, text: 'answered Legal' } }, now);
  assert.equal(a.text, 'answering CEO');
  assert.equal(a.ago, '5m');
  assert.equal(M.rowActivity({ lastActivity: { at: now - 5 * 60_000, text: 'answered Legal' } }, now).text, 'answered Legal');
  const pos = {
    powers: { read: ['$workspace'], write: ['$workspace'], tools: ['Read', 'WebFetch', 'NotebookEdit'], bash: 'readonly' },
    effective: { read: ['$workspace'], write: ['$workspace'], tools: ['Read'], bash: 'off' },
    limitedBy: { 'tools:WebFetch': 'legal', 'tools:NotebookEdit': 'tax', bash: 'legal' },   // wire.js limitedMap keys
  };
  const rows = M.powerRows(pos, { legal: 'Legal', tax: 'Tax Specialist' });
  const tools = rows.find((r) => r.key === 'tools').items;
  assert.equal(tools.find((i) => i.value === 'WebFetch').limitedBy, 'Legal');
  assert.equal(tools.find((i) => i.value === 'NotebookEdit').limitedBy, 'Tax Specialist');
  assert.equal(tools.find((i) => i.value === 'Read').limitedBy, null);
  assert.equal(rows.find((r) => r.key === 'bash').limitedBy, 'Legal');
});
