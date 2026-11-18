// Positions: tree ops (depth, subtree, caps, re-parent, retire plans), effective powers (own ∩ every ancestor's) and
// the schema rules they rest on (main/engine/team/tree.js, schema.js). Pure: no fs.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../main/engine/team/schema');
const { createTree, intersectPaths } = require('../../main/engine/team/tree');

const CO = ['C:/co/shop', 'C:/co/app'];
const ctx = { companyFolders: CO, workspaceOf: (id) => `C:/team/acme/positions/${id}`, home: 'C:/Users/you' };

const NC = () => S.defaultPowers();
function pos(id, parent, extra = {}) {
  const v = S.validatePosition({ id, name: id.toUpperCase(), remit: `${id} things`, parent, version: 1, ...extra });
  assert.ok(v.ok, `${id}: ${v.errors.join('; ')}`);
  return v.value;
}
// CEO ── legal ── tax ── payroll ;  CEO ── marketing ; CEO ── qa (coding, product scope)
function sample() {
  return [
    pos('legal', null),
    pos('tax', 'legal'),
    pos('payroll', 'tax'),
    pos('marketing', null),
    pos('qa', null, { scope: { kind: 'product', folder: 'C:/co/app' }, powers: S.defaultPowers({ coding: true }) }),
  ];
}
function chain(n) { // p1 <- p2 <- ... <- pn (p1 top-level)
  const out = [];
  for (let i = 1; i <= n; i++) out.push(pos(`p${i}`, i === 1 ? null : `p${i - 1}`));
  return out;
}

test('depth, ancestors, reports, subtree and height', () => {
  const t = createTree(sample());
  assert.equal(t.depth('legal'), 1);
  assert.equal(t.depth('payroll'), 3);
  assert.deepEqual(t.ancestors('payroll'), ['tax', 'legal']);
  assert.deepEqual(t.reports(null).sort(), ['legal', 'marketing', 'qa']);
  assert.deepEqual(t.reports('legal'), ['tax']);
  assert.deepEqual(t.subtree('legal'), ['tax', 'payroll']);
  assert.equal(t.height('legal'), 2);
  assert.equal(t.height('payroll'), 0);
  assert.equal(t.liveCount(), 5);
  assert.deepEqual(t.problems(), []);
});

test('retired positions are out of the tree', () => {
  const list = sample();
  list.find((p) => p.id === 'marketing').status = 'retired';
  const t = createTree(list);
  assert.equal(t.has('marketing'), false);
  assert.equal(t.liveCount(), 4);
});

test('problems: cycle, dangling parent, depth over 5, more than 10 reports, more than 30 positions', () => {
  const cyc = createTree([{ ...pos('a', 'b') }, { ...pos('b', 'a') }]);
  assert.ok(cyc.problems().some((p) => /cycle/.test(p.reason)));
  assert.equal(cyc.depth('a'), Infinity);
  assert.ok(createTree([pos('a', 'ghost')]).problems().some((p) => /"ghost"/.test(p.reason)));
  assert.ok(createTree(chain(6)).problems().some((p) => p.id === 'p6' && /depth 6/.test(p.reason)));
  assert.deepEqual(createTree(chain(5)).problems(), []);
  const wide = [pos('boss', null), ...Array.from({ length: 11 }, (_, i) => pos(`r${i}`, 'boss'))];
  assert.ok(createTree(wide).problems().some((p) => p.id === 'boss' && /11 direct reports/.test(p.reason)));
  const many = Array.from({ length: 31 }, (_, i) => pos(`x${i}`, i < 10 ? null : `x${i % 10}`));
  assert.ok(createTree(many).problems().some((p) => p.id === null && /31 live positions/.test(p.reason)));
});

test('checkCreate: depth cap 5, 10 reports, 30 positions, ids unique (retired ones too)', () => {
  const t5 = createTree(chain(5));
  assert.deepEqual(t5.checkCreate({ id: 'deep', parent: 'p4' }), []);
  assert.match(t5.checkCreate({ id: 'deep', parent: 'p5' }).join(), /depth 6; the cap is 5/);
  assert.match(t5.checkCreate({ id: 'p3', parent: null }).join(), /already used/);
  assert.match(t5.checkCreate({ id: 'old', parent: null }, { taken: ['old'] }).join(), /retired ones too/);
  assert.match(t5.checkCreate({ id: 'x', parent: 'nobody' }).join(), /not a live position/);
  const ten = createTree([pos('boss', null), ...Array.from({ length: 10 }, (_, i) => pos(`r${i}`, 'boss'))]);
  assert.match(ten.checkCreate({ id: 'r10', parent: 'boss' }).join(), /already has 10 direct reports/);
  const ceo10 = createTree(Array.from({ length: 10 }, (_, i) => pos(`t${i}`, null)));
  assert.match(ceo10.checkCreate({ id: 'z', parent: null }).join(), /the CEO already has 10/);
  const thirty = createTree(Array.from({ length: 30 }, (_, i) => pos(`x${i}`, i < 10 ? null : `x${i % 10}`)));
  assert.match(thirty.checkCreate({ id: 'one-more', parent: 'x1' }).join(), /already 30 live positions/);
  assert.match(t5.checkCreate({ id: 'Bad Id', parent: null }).join(), /a-z, 0-9/);
});

test('checkReparent: no cycles, depth counts the moved subtree, caps hold', () => {
  const t = createTree(sample());
  assert.deepEqual(t.checkReparent('payroll', 'legal'), []);
  assert.match(t.checkReparent('tax', 'tax').join(), /cannot report to itself/);
  assert.match(t.checkReparent('legal', 'payroll').join(), /would make a cycle/);
  assert.match(t.checkReparent('legal', 'tax').join(), /would make a cycle/);
  assert.match(t.checkReparent('legal', 'ghost').join(), /not a live position/);
  assert.deepEqual(t.checkReparent('tax', 'legal'), [], 'same parent: no move, no error');
  // a 3-deep subtree (legal > tax > payroll) under a depth-3 node would reach depth 6
  const deep = createTree([...sample(), pos('m2', 'marketing'), pos('m3', 'm2')]);
  assert.match(deep.checkReparent('legal', 'm3').join(), /down to depth 6/);
  assert.deepEqual(deep.checkReparent('legal', 'm2'), [], 'depth 5 exactly is allowed');
  const moved = t.withParent('payroll', 'marketing');
  assert.equal(moved.parentOf('payroll'), 'marketing');
  assert.equal(t.parentOf('payroll'), 'tax', 'withParent leaves the original alone');
});

test('planRetire: move-up by default, retire-too deepest first, cap check on the receiving manager', () => {
  const t = createTree(sample());
  const up = t.planRetire('tax');
  assert.ok(up.ok);
  assert.deepEqual(up.retire, ['tax']);
  assert.deepEqual(up.moves, [{ id: 'payroll', from: 'tax', to: 'legal' }]);
  const all = t.planRetire('legal', 'retire-too');
  assert.deepEqual(all.retire, ['payroll', 'tax', 'legal']);
  assert.deepEqual(all.moves, []);
  assert.equal(t.planRetire('legal', 'sideways').ok, false);
  // CEO has 9 top-level; retiring one with 3 reports would give the CEO 11
  const list = [...Array.from({ length: 8 }, (_, i) => pos(`t${i}`, null)), pos('mgr', null), pos('a', 'mgr'), pos('b', 'mgr'), pos('c', 'mgr')];
  const r = createTree(list).planRetire('mgr');
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /11 direct reports/);
});

test('effective powers: own ∩ every ancestor; workspace always on and never inherited', () => {
  const list = [
    pos('legal', null, { powers: { read: ['$workspace', 'C:/co/shop'], write: ['$workspace'], tools: ['Read', 'Grep', 'WebFetch'], bash: 'readonly' } }),
    pos('tax', 'legal', { powers: { read: ['$workspace', '$company', 'C:/team/acme/positions/legal'], write: ['$workspace', 'C:/co/shop'], tools: ['Read', 'Grep', 'Write', 'WebSearch', 'Bash'], bash: 'on' } }),
  ];
  const t = createTree(list);
  const e = t.effective('tax', ctx);
  assert.deepEqual(e.read, ['C:/team/acme/positions/tax', 'C:/co/shop'], 'company read cut to what legal has; legal\'s workspace never reachable');
  assert.deepEqual(e.write, ['C:/team/acme/positions/tax']);
  assert.deepEqual(e.tools, ['Read', 'Grep'], 'tools is a list intersection: legal has no Bash tool');
  assert.equal(e.limitedBy.find((x) => x.power === 'tools' && x.value === 'Bash').by, 'legal');
  assert.equal(e.bash, 'readonly');
  const by = (power, value) => e.limitedBy.find((x) => x.power === power && x.value === value);
  assert.equal(by('read', 'C:/co/app').by, 'legal');
  assert.equal(by('write', 'C:/co/shop').by, 'legal');
  assert.equal(by('tools', 'Write').by, 'legal');
  assert.equal(by('bash', 'on').max, 'readonly');
  assert.equal(by('read', 'C:/team/acme/positions/legal').by, 'company', 'the CEO level is the company folders');
  const le = t.effective('legal', ctx);
  assert.deepEqual(le.read, ['C:/team/acme/positions/legal', 'C:/co/shop']);
  assert.deepEqual(le.limitedBy, []);
});

test('effective powers: three levels, narrowing a manager narrows the whole subtree', () => {
  const mk = (legalBash) => createTree([
    pos('legal', null, { powers: { ...NC(), tools: ['Read', 'Bash', 'Agent'], bash: legalBash, agents: true } }),
    pos('tax', 'legal', { powers: { ...NC(), tools: ['Read', 'Bash', 'Agent'], bash: 'on', agents: true, worktree: true } }),
    pos('payroll', 'tax', { powers: { ...NC(), tools: ['Read', 'Bash'], bash: 'on' } }),
  ]);
  const on = mk('on').effective('payroll', ctx);
  assert.equal(on.bash, 'on');
  assert.deepEqual(on.tools, ['Read', 'Bash']);
  const ro = mk('readonly').effective('payroll', ctx);
  assert.equal(ro.bash, 'readonly');
  assert.equal(ro.limitedBy.find((x) => x.power === 'bash').by, 'legal');
  const tax = mk('readonly').effective('tax', ctx);
  assert.equal(tax.agents, true);
  assert.equal(tax.worktree, false, 'worktree is AND: legal does not have it');
  assert.equal(tax.limitedBy.find((x) => x.power === 'worktree').by, 'legal');
});

test('effective powers: product scope, CEO level, globs and narrowing kept', () => {
  const t = createTree([
    pos('qa', null, { scope: { kind: 'product', folder: 'C:/co/app' }, powers: { ...S.defaultPowers({ coding: true }), read: ['$workspace', '$scope', 'D:/elsewhere'] } }),
    pos('site', null, { powers: { ...NC(), read: ['$workspace', 'C:/co/shop/site'] } }),
    pos('priv', 'site', { powers: { ...NC(), read: ['$workspace', 'C:/co/shop', 'C:/co/shop/site/**/privacy*', 'C:/co/**/terms*'] } }),
  ]);
  const qa = t.effective('qa', ctx);
  assert.deepEqual(qa.read, ['C:/team/acme/positions/qa', 'C:/co/app']);
  assert.deepEqual(qa.write, ['C:/team/acme/positions/qa', 'C:/co/app']);
  assert.equal(qa.limitedBy.find((x) => x.value === 'D:/elsewhere').by, 'company');
  const priv = t.effective('priv', ctx);
  assert.deepEqual(priv.read, ['C:/team/acme/positions/priv', 'C:/co/shop/site', 'C:/co/shop/site/**/privacy*']);
  const shop = priv.limitedBy.find((x) => x.value === 'C:/co/shop');
  assert.deepEqual(shop.kept, ['C:/co/shop/site'], 'a wider path is narrowed to the manager\'s, and the card can say so');
  assert.ok(priv.limitedBy.find((x) => x.value === 'C:/co/**/terms*'), 'a glob reaching outside the manager is cut (conservative)');
});

test('intersectPaths: case-insensitive on Windows-style keys, trailing /** is the folder', () => {
  S.setCaseInsensitive(true);
  try {
    assert.deepEqual(intersectPaths(['c:/CO/Shop/x'], ['C:/co/shop']), ['c:/CO/Shop/x']);
    assert.deepEqual(intersectPaths(['C:/co'], ['C:/co/shop', 'C:/co/app']), ['C:/co/shop', 'C:/co/app']);
    assert.deepEqual(intersectPaths(['C:/cop'], ['C:/co']), [], 'a prefix that is not a folder boundary does not count');
  } finally { S.setCaseInsensitive(process.platform === 'win32'); }
  assert.deepEqual(S.expandPathTokens(['C:/co/shop/**', '$scope'], { companyFolders: CO, scopeFolder: null }), ['C:/co/shop', 'C:/co/app']);
});

test('excess: a draft beyond its manager is refused with the exact excess', () => {
  const t = createTree(sample());
  const fits = t.excess(NC(), 'legal', ctx, { workspace: 'C:/team/acme/positions/new' });
  assert.deepEqual(fits, []);
  const big = t.excess({ ...NC(), read: ['$workspace', 'D:/secret'], tools: [...NC().tools, 'Bash'], bash: 'on', agents: true }, 'legal', ctx, { workspace: 'C:/team/acme/positions/new' });
  const keys = big.map((x) => `${x.power}:${x.value}:${x.by}`).sort();
  assert.deepEqual(keys, ['agents:true:legal', 'bash:on:legal', 'read:D:/secret:company', 'tools:Bash:legal']);
  assert.deepEqual(t.excess(NC(), 'ghost', ctx), [{ power: 'parent', value: 'ghost', by: null }]);
  assert.deepEqual(t.excess(S.defaultPowers({ coding: true }), null, ctx), [], 'the CEO level has every tool');
});

test('widens: "Approve always" lists every ancestor whose own powers do not cover the request', () => {
  const t = createTree(sample());
  assert.deepEqual(t.widens('payroll', { kind: 'write', target: 'C:/co/shop/legal.md' }, ctx), { ancestors: ['tax', 'legal'], beyondCompany: false });
  assert.deepEqual(t.widens('payroll', { kind: 'read', target: 'C:/co/shop/x' }, ctx), { ancestors: [], beyondCompany: false });
  assert.deepEqual(t.widens('payroll', { kind: 'read', target: 'D:/outside' }, ctx), { ancestors: ['tax', 'legal'], beyondCompany: true });
  assert.deepEqual(t.widens('payroll', { kind: 'bash', target: 'bash:readonly' }, ctx).ancestors, ['tax', 'legal']);
  assert.deepEqual(t.widens('tax', { kind: 'tool', target: 'WebFetch' }, ctx).ancestors, []);
});

test('cutsAfterReparent: exactly what a move would cut, for the moved node and its subtree', () => {
  const t = createTree([
    pos('eng', null, { powers: { ...S.defaultPowers({ coding: true }), read: ['$workspace', '$company'], write: ['$workspace', '$company'] } }),
    pos('lead', 'eng', { powers: { ...S.defaultPowers({ coding: true }), read: ['$workspace', '$company'], write: ['$workspace', '$company'] } }),
    pos('dev', 'lead', { powers: { ...S.defaultPowers({ coding: true }), read: ['$workspace', '$company'], write: ['$workspace', 'C:/co/app'] } }),
    pos('docs', null),
  ]);
  assert.deepEqual(t.cutsAfterReparent('lead', 'eng', ctx), [], 'no move, no cut');
  const cuts = t.cutsAfterReparent('lead', 'docs', ctx).map((c) => `${c.id}:${c.power}:${c.value}`).sort();
  assert.ok(cuts.includes('lead:bash:on'));
  assert.ok(cuts.includes('dev:bash:on'));
  assert.ok(cuts.includes('dev:write:C:/co/app'));
  assert.ok(cuts.includes('lead:worktree:true'));
  assert.ok(!cuts.some((c) => c.startsWith('dev:read')), 'docs reads the company too: reads are not cut');
});

test('a broken reporting line limits to nothing (no powers beyond the workspace)', () => {
  const t = createTree([pos('a', 'b'), pos('b', 'a')]);
  const e = t.effective('a', ctx);
  assert.equal(e.broken, 'cycle');
  assert.deepEqual(e.read, ['C:/team/acme/positions/a']);
  assert.deepEqual(e.tools, []);
});

// ---------- schema ----------
test('schema: ids and slugs', () => {
  assert.equal(S.checkId('legal'), null);
  assert.match(S.checkId('Legal'), /a-z, 0-9/);
  assert.match(S.checkId('a'.repeat(41)), /1 to 40/);
  assert.match(S.checkId('con'), /reserves/);
  assert.match(S.checkId('-x'), /start or end/);
  assert.equal(S.slugify('Tax Specialist'), 'tax-specialist');
  assert.equal(S.slugify('Tax Specialist', ['tax-specialist', 'tax-specialist-2']), 'tax-specialist-3');
  assert.equal(S.slugify('Café & Crème!'), 'cafe-and-creme');
  assert.equal(S.slugify('***'), 'position');
  assert.equal(S.slugify('NUL'), 'nul-team');
  const long = S.slugify('x'.repeat(60), ['x'.repeat(40)]);
  assert.ok(long.length <= 40 && long.endsWith('-2'));
});

test('schema: position validation fills defaults and refuses bad shapes with field-first reasons', () => {
  const ok = S.validatePosition({ id: 'tax', name: 'Tax', remit: 'Tax things', parent: null }, { draft: true });
  assert.ok(ok.ok, ok.errors.join());
  assert.deepEqual(ok.value.scope, { kind: 'company' });
  assert.equal(ok.value.status, 'active');
  assert.equal(ok.value.effort, 'high');
  assert.equal(ok.value.model, null);
  assert.deepEqual(ok.value.powers, S.defaultPowers());
  assert.deepEqual(ok.value.duties, []);
  const missing = S.validatePosition({ id: 'tax', name: 'Tax', remit: 'x', version: 1 });
  assert.match(missing.errors.join('\n'), /^parent: required/m);
  const bad = S.validatePosition({ id: 'tax', name: 'Tax', remit: 'x', parent: 'tax', version: 1, status: 'gone', effort: 'huge',
    powers: { read: ['relative/path', '$home', 'C:/a/../b'], tools: ['Read', 'SendMessage', 'mcp__gmail__send', 'Agent', 'Bash'], bash: 'sometimes' } });
  const msg = bad.errors.join('\n');
  for (const re of [/parent: a position cannot report to itself/, /status: must be/, /effort: must be/, /must be absolute/, /unknown token "\$home"/,
    /may not contain "\.\."/, /"SendMessage" is never given/, /connector and MCP tools are off/, /bash: must be off, readonly or on/]) assert.match(msg, re);
  const agent = S.validatePowers({ tools: ['Agent'] });
  assert.match(agent.errors.join(), /needs powers.agents: true/);
  const bashOff = S.validatePowers({ tools: ['Bash'], bash: 'off' });
  assert.match(bashOff.errors.join(), /bash is "off"/);
});

test('schema: duties', () => {
  const sched = S.validateDuty({ id: 'q', title: 'Quarterly', prompt: 'Do it', trigger: { kind: 'schedule', cron: '0 9 1 1,4,7,10 *' } });
  assert.ok(sched.ok, sched.errors.join());
  assert.equal(sched.value.trigger.catchUp, 'once');
  assert.equal(sched.value.output, 'report');
  assert.match(S.validateDuty({ id: 'q', title: 'Q', prompt: 'x', trigger: { kind: 'schedule', cron: '61 * * * *' } }).errors.join(), /cron/);
  assert.ok(S.validateDuty({ id: 'c', title: 'C', prompt: 'x', trigger: { kind: 'event', event: 'commit', repo: '$scope', branch: 'master', paths: ['**/privacy*'] } }).ok);
  assert.ok(S.validateDuty({ id: 'r', title: 'R', prompt: 'x', output: 'draft', trigger: { kind: 'event', event: 'release', repo: 'C:/co/app', tag: 'v*' } }).ok);
  assert.ok(S.validateDuty({ id: 'f', title: 'F', prompt: 'x', trigger: { kind: 'event', event: 'file', path: 'C:/co/app/CHANGELOG.md' } }).ok);
  assert.match(S.validateDuty({ id: 'f', title: 'F', prompt: 'x', trigger: { kind: 'event', event: 'push', repo: '$scope' } }).errors.join(), /commit, release or file/);
  assert.match(S.validateDuty({ id: 'f', title: 'F', prompt: 'x', cooldownMin: -1, trigger: { kind: 'event', event: 'file', path: 'rel.txt' } }).errors.join('\n'), /absolute[\s\S]*cooldownMin/);
  const dup = S.validatePosition({ id: 'a', name: 'A', remit: 'a', parent: null, version: 1, duties: [
    { id: 'd', title: 'D', prompt: 'x', trigger: { kind: 'schedule', cron: '0 9 * * *' } },
    { id: 'd', title: 'D2', prompt: 'x', trigger: { kind: 'schedule', cron: '0 9 * * *' } }] });
  assert.match(dup.errors.join(), /used twice/);
});

test('schema: company folders, paths and caps', () => {
  const c = S.validateCompany({ id: 'acme', name: 'Acme', folders: ['C:\\co\\shop\\', 'C:/co/app'], version: 1 });
  assert.ok(c.ok, c.errors.join());
  assert.deepEqual(c.value.folders, ['C:/co/shop', 'C:/co/app']);
  assert.match(S.validateCompany({ id: 'acme', name: 'Acme', folders: ['C:/co', 'C:/co/app'], version: 1 }).errors.join(), /nested folders are refused/);
  assert.match(S.validateCompany({ id: 'acme', name: 'Acme', folders: ['C:/'], version: 1 }).errors.join(), /whole drive/);
  assert.match(S.validateCompany({ id: 'acme', name: 'Acme', folders: [], version: 1 }).errors.join(), /at least one/);
  assert.equal(S.normPath('c:\\Users\\you\\x\\..\\y\\'), 'C:/Users/you/y');
  assert.equal(S.normPath('/srv//a/./b/'), '/srv/a/b');
  assert.equal(S.normPath('\\\\server\\share\\x'), '//server/share/x');
  assert.ok(S.isUnder('C:/co/shop/a', 'C:/co/shop'));
  assert.ok(!S.isUnder('C:/co/shopping', 'C:/co/shop'));
  assert.equal(S.capText('x'.repeat(30), 10).length, 10);
  const capped = S.capStrings({ a: 'y'.repeat(25_000), b: [{ c: 'z'.repeat(25_000) }], n: 3 });
  assert.equal(capped.a.length, S.LIMITS.logTextMax);
  assert.equal(capped.b[0].c.length, S.LIMITS.logTextMax);
  assert.equal(capped.n, 3);
  assert.equal(S.notebookTemplate('Tax Specialist'), '# Tax Specialist · notebook\n## Decisions\n## Facts\n## Open items\n## Log\n');
  assert.match(S.validateBrief('  ').errors.join(), /empty/);
  assert.match(S.validateBrief('a\u0000b').errors.join(), /binary/);
  assert.match(S.validateChats([{ n: 2 }, { n: 1 }]).errors.join(), /above the previous/);
});

// ---------- departments (2.4) ----------
test('departments: derived from the top-level ancestor; listed in report order with members breadth first', () => {
  const list = [
    pos('legal', null, { department: 'Legal' }),
    pos('tax', 'legal'),
    pos('contracts', 'legal'),
    pos('payroll', 'tax'),
    pos('marketing', null, { department: 'Marketing' }),
    pos('social', 'marketing'),
    pos('qa', null),
  ];
  const t = createTree(list);
  assert.deepEqual(t.departmentOf('legal'), { name: 'Legal', head: 'legal' });
  assert.deepEqual(t.departmentOf('payroll'), { name: 'Legal', head: 'legal' }, 'staff take the head\'s department');
  assert.deepEqual(t.departmentOf('social'), { name: 'Marketing', head: 'marketing' });
  assert.equal(t.departmentOf('qa'), null, 'a top-level position without one is outside any department');
  assert.equal(t.departmentOf('ghost'), null);
  assert.deepEqual(t.departments(), [
    { name: 'Legal', head: 'legal', members: ['tax', 'contracts', 'payroll'] },
    { name: 'Marketing', head: 'marketing', members: ['social'] },
  ]);
  // a re-parent moves the derived department with it (and its subtree)
  const moved = t.withParent('tax', 'marketing');
  assert.deepEqual(moved.departmentOf('payroll'), { name: 'Marketing', head: 'marketing' });
  assert.deepEqual(createTree(sample()).departments(), [], 'no departments: an empty list');
});
test('departments: a broken line (missing parent, cycle) is in no department', () => {
  const t = createTree([
    pos('legal', null, { department: 'Legal' }),
    pos('orphan', 'ghost'),
    pos('a', 'b'), pos('b', 'a'),
  ]);
  assert.equal(t.departmentOf('orphan'), null);
  assert.equal(t.departmentOf('a'), null);
  assert.deepEqual(t.departments().map((d) => d.name), ['Legal']);
});
test('checkDepartment: a name is unique per company, case-insensitive with whitespace collapsed', () => {
  const t = createTree([pos('legal', null, { department: 'Legal  Affairs' }), pos('fin', null, { department: 'Finance' })]);
  assert.deepEqual(t.checkDepartment('Marketing'), []);
  assert.match(t.checkDepartment(' legal affairs ').join(), /^department: "Legal {2}Affairs" already exists in this company \(headed by "legal"\)/);
  assert.match(t.checkDepartment('FINANCE').join(), /headed by "fin"/);
  assert.deepEqual(t.checkDepartment('legal affairs', { except: 'legal' }), [], 'renaming a head to its own name (another case) is fine');
  assert.deepEqual(t.checkDepartment(''), []);
  // hand-edited duplicates still load: both heads are listed
  const dup = createTree([pos('a', null, { department: 'Ops' }), pos('b', null, { department: 'ops' })]);
  assert.deepEqual(dup.departments().map((d) => d.head), ['a', 'b']);
});
