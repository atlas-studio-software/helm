// The right sidebar's Team panel (ui/panels/team.js) rendered in plain node through test/host/fixtures/ui-render.mjs
// (no DOM, no browser), with the REAL compact tree (ui/positions/tree.js) over the mock company
// (ui/lib/mock-positions.js). positions/state.js, shell/state.js and the store are shims that record what the panel
// calls, so a click can be checked for where it goes: a position -> the Team view on it (select + go('team')), the CEO
// row -> a CEO chat (openCeo), a row's chat button / Shift+Enter -> its chat (openChat).
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { registerHooks } = require('node:module');
const { createMockTeam } = require('../../ui/lib/mock-positions.js');

const UI = path.join(__dirname, '..', '..', 'ui');
const TREE = path.join(UI, 'positions', 'tree.js');
const PANEL = path.join(UI, 'panels', 'team.js');
const PRE = 'team-panel-shim:';
const T0 = `const R = globalThis.__helmUiTest; const T = () => R.T; const log = (n) => (...a) => { T().calls.push([n, ...a]); };`;
const SHIMS = {
  [pathToFileURL(TREE).href]: {
    '../shell/util.js': 'export const cx = (...a) => a.filter(Boolean).join(" ");',
    './state.js': `${T0}
      export const opens = { get value() { return T().opens || {}; } };
      export const selected = { get value() { return T().selected || {}; } };
      export const setOpen = log('setOpen');
      export const select = log('treeSelect');`,
  },
  [pathToFileURL(PANEL).href]: {
    './util.js': `const R = globalThis.__helmUiTest;
      export const html = R.html; export const cx = (...a) => a.filter(Boolean).join(" ");
      export function Icon(p) { return R.h("icon", { name: p.name, size: p.size }); }
      export function Empty(p) { return R.h("empty", { title: p.title, icon: p.icon }, p.children); }
      export function Loading(p) { return R.h("loading", { label: p.label }); }
      export function ErrorState(p) { return R.h("error-state", { title: p.title, error: String(p.error || ""), onRetry: p.onRetry }); }`,
    '../lib/store.js': `${T0} export const activeSession = { get value() { return T().active || null; } };`,
    '../shell/state.js': `${T0}
      export const go = log('go');
      export const isPhone = { get value() { return !!T().phone; } };
      export const sheetOpen = { get value() { return !!T().sheet; }, set value(v) { T().sheet = v; T().calls.push(['sheet', v]); } };`,
    '../positions/state.js': `${T0}
      export const teamList = { get value() { return T().teamList; } };
      export const listError = { get value() { return T().listError || null; } };
      export const companyId = { get value() { return T().companyId; } };
      export const companies = { get value() { return T().companies || {}; } };
      export const proposed = { get value() { return T().proposed || { list: [], error: null }; } };
      export const loadList = log('loadList'); export const loadCompany = log('loadCompany'); export const ensureEvents = log('ensureEvents');
      export const setCompany = log('setCompany'); export const select = log('select');
      export const openCeo = log('openCeo'); export const openChat = log('openChat');`,
  },
};

let ui, P, R, LIST, DATA, ONE, HARBOR;
before(async () => {
  ui = await import('./fixtures/ui-render.mjs');
  if (!ui.available) return;
  await ui.importUnderTest(path.join(UI, 'lib', 'restart-note.js'));   // a file with no imports: registers the fixture's hooks first
  registerHooks({
    resolve(spec, ctx, next) {
      const parent = ctx.parentURL && String(ctx.parentURL).split('?')[0];
      const map = parent && SHIMS[parent];
      if (map && Object.hasOwn(map, spec)) return { url: PRE + encodeURIComponent(parent) + '|' + encodeURIComponent(spec), format: 'module', shortCircuit: true };
      return next(spec, ctx);
    },
    load(url, ctx, next) {
      if (url.startsWith(PRE)) {
        const [parent, spec] = url.slice(PRE.length).split('|').map(decodeURIComponent);
        return { format: 'module', source: SHIMS[parent][spec], shortCircuit: true };
      }
      return next(url, ctx);
    },
  });
  await ui.importUnderTest(TREE);   // the panel's '../positions/tree.js' is this same module, its imports shimmed
  P = await ui.importUnderTest(PANEL);
  R = ui.R;
  const mock = createMockTeam({ mode: null, emit: () => {} });
  LIST = await mock.rpc('team.list', {});
  DATA = await mock.rpc('team.get', { company: 'example-co' });
  HARBOR = await mock.rpc('team.get', { company: 'harbor-books' });
  ONE = await createMockTeam({ mode: 'one', emit: () => {} }).rpc('team.list', {});
});
const skip = (t) => { if (!ui.available) { t.skip('node:module registerHooks is missing in this node'); return true; } return false; };

function render(over = {}) {
  ui.reset();
  R.T = { teamList: LIST, companyId: 'example-co', companies: { 'example-co': { data: DATA } }, opens: {}, selected: {}, calls: [], ...over };
  ui.mount(P.TeamPanel);
}
const items = () => ui.findAll((n) => n.p && n.p.role === 'treeitem');
const ids = () => items().map((n) => n.p['data-id']);
const item = (id) => items().find((n) => n.p['data-id'] === id);
const rowOf = (id) => ui.findAll((n) => n.p && n.p.role === 'none' && (n.c || []).some((k) => k && k.p && k.p['data-id'] === id))[0];
const has = (n, cls) => new RegExp(`\\b${cls}\\b`).test(n?.p?.class || '');
const calls = (name) => R.T.calls.filter((c) => c[0] === name);
const node = (id) => DATA.tree.find((r) => r.id === id);

test('the panel draws the company tree from the mock: CEO row, then each department with its head and staff nested, then No department', async (t) => {
  if (skip(t)) return;
  render();
  await ui.settle();
  const tree = ui.findAll((n) => n.p && n.p.role === 'tree')[0];
  assert.ok(tree, 'a role=tree');
  assert.ok(has(tree, 'is-compact'), 'the compact tree');
  assert.equal(tree.p.style['--step'], '12px');
  // every position is a tree item, CEO first, grouped by department in the CEO's report order
  assert.equal(ids()[0], '@ceo');
  assert.deepEqual([...ids()].sort(), ['@ceo', ...DATA.tree.map((r) => r.id)].sort(), 'no row missing, none invented');
  const groups = ui.findAll((n) => n.p && n.p.role === 'group');
  assert.deepEqual(groups.map((g) => g.p['data-dept']), ['Legal', 'Marketing', 'Finance', '']);
  assert.match(groups[0].p['aria-label'], /^Legal department, headed by General Counsel, 4 positions$/);
  const heads = ui.findAll((n) => has(n, 'pos-dept') && has(n, 'pos-row'));
  assert.match(ui.text(heads[0]), /^Legal\s*headed by General Counsel/);
  assert.match(ui.text(heads[3]), /^No department/);
  // a group's rows sit one 12 px step in from its header: header 12, head 24, staff 36, theirs 48
  assert.equal(heads[0].p.style['--indent'], '12px');
  assert.deepEqual(['legal', 'tax', 'payroll', 'qa'].map((id) => rowOf(id).p.style['--indent']), ['24px', '36px', '48px', '24px']);
  assert.equal(rowOf('@ceo').p.style['--indent'], '0px');
  assert.deepEqual(ui.findAll((n) => n.p && n.p.role === 'treeitem', groups[0].c).map((n) => n.p['data-id']), ['legal', 'tax', 'payroll', 'contracts']);
  // one line a row: a status dot, the name, Paused, the counts that need you, and a chat button
  for (const r of DATA.tree) {
    const it = item(r.id);
    const st = it.p.class.match(/\bst-(\w+)\b/)[1];
    const dot = ui.findAll((n) => has(n, 'dot'), it.c)[0];
    assert.ok(dot && has(dot, { working: 'working', waiting: 'waiting', paused: 'closed', idle: 'idle' }[st]), `${r.id}: the ${st} dot`);
    assert.equal(ui.text(ui.findAll((n) => has(n, 'pos-name'), it.c)[0]), r.name);
    const req = +r.pending?.requests || 0, prop = +r.pending?.proposals || 0;
    const ns = ui.findAll((n) => has(n, 'pos-n') && has(n, 'warn'), it.c).map((n) => ui.text(n));
    assert.deepEqual(ns, [req && String(req), prop && String(prop)].filter(Boolean), `${r.id}: the needs-you counts`);
    assert.equal(ui.findAll((n) => has(n, 'pos-item-chat'), it.c).length, 1, `${r.id}: a chat button`);
    assert.equal(it.p['aria-keyshortcuts'], 'Shift+Enter');
  }
  assert.ok(DATA.tree.some((r) => (+r.pending?.requests || 0) > 0) && DATA.tree.some((r) => (+r.pending?.proposals || 0) > 0), 'the mock has both kinds of counts');
  assert.equal(ui.text(ui.findAll((n) => has(n, 'pos-item-tag'), item('social').c)[0]), 'Paused');
  assert.match(item('legal').p['aria-label'], /^General Counsel\. Waiting on you\. 1 request/);
  // branches fold: a row with reports has the chevron and aria-expanded
  assert.equal(item('legal').p['aria-expanded'], 'true');
  assert.equal(item('qa').p['aria-expanded'], undefined);
  // two companies: the switcher, with what needs you in each
  const sw = ui.findAll(ui.byAct('team-company'))[0];
  assert.ok(sw, 'a company switcher');
  assert.deepEqual(ui.findAll((n) => n.t === 'option', sw.c).map((o) => o.p.value), LIST.companies.map((c) => c.id));
  assert.equal(sw.p.value, 'example-co');
  // each count once: the current company's option is its name only; the counts are a line of their own under the bar
  const opts = ui.findAll((n) => n.t === 'option', sw.c);
  assert.equal(ui.text(opts[0]), 'Example Co');
  const counts = ui.findAll(ui.byAct('team-counts'));
  assert.equal(counts.length, 1);
  const need = LIST.companies[0].needsYou;
  assert.ok(need > 0);
  assert.match(ui.text(counts[0]), new RegExp(`^${need} needs? you`));
  const bar = ui.findAll((n) => has(n, 'pn-team-bar'))[0];
  assert.doesNotMatch(ui.text(bar), /need/, 'the bar itself carries no count');
  assert.ok(!(ui.findAll((n) => has(n, 'pn-team-bar'))[0].c || []).some((k) => k && k.p && k.p['data-act'] === 'team-counts'), 'the counts are not inside the bar');
});

test('one company: no switcher, its name instead; no departments: rows as the CEO lists them, no extra step', async (t) => {
  if (skip(t)) return;
  render({ teamList: ONE });
  await ui.settle();
  assert.equal(ui.findAll(ui.byAct('team-company')).length, 0);
  assert.match(ui.text(ui.findAll((n) => has(n, 'pn-team-name'))[0]), /Example Co/);
  assert.equal(ui.findAll(ui.byAct('team-counts')).length, 1, 'one company: its name, and the counts under it');
  render({ companyId: 'harbor-books', companies: { 'harbor-books': { data: HARBOR } } });
  await ui.settle();
  assert.deepEqual(ids(), ['@ceo', ...HARBOR.tree.map((r) => r.id)]);
  assert.equal(ui.findAll((n) => n.p && n.p.role === 'group').length, 0);
  assert.equal(rowOf(HARBOR.tree[0].id).p.style['--indent'], '12px');
});

test('a click on a position opens the Team view on it; the CEO row opens a CEO chat; the chat button and Shift+Enter open its chat', async (t) => {
  if (skip(t)) return;
  render({ phone: true, sheet: true });
  await ui.settle();
  item('tax').p.onClick({});
  assert.deepEqual(calls('select'), [['select', 'tax']]);
  assert.deepEqual(calls('go'), [['go', 'team']]);
  assert.equal(R.T.sheet, false, 'the phone sheet closes first');
  assert.equal(calls('openChat').length, 0);

  R.T.calls = [];
  item('@ceo').p.onClick({});
  assert.deepEqual(calls('openCeo'), [['openCeo', 'example-co']]);
  assert.equal(calls('go').length + calls('select').length, 0, 'the CEO row does not leave for the Team view');

  R.T.calls = [];
  let stopped = false;
  ui.findAll((n) => has(n, 'pos-item-chat'), item('payroll').c)[0].p.onClick({ stopPropagation() { stopped = true; } });
  assert.ok(stopped, 'the row itself does not also get the click');
  assert.deepEqual(calls('openChat'), [['openChat', 'example-co', 'payroll']]);
  assert.equal(calls('select').length, 0);

  // keys on the tree (the WAI-ARIA tree pattern of the Team view's tree, plus Shift+Enter)
  const tree = ui.findAll((n) => n.p && n.p.role === 'tree')[0];
  const key = (id, k, shiftKey = false) => { let prevented = false; tree.p.onKeyDown({ key: k, shiftKey, target: { closest: () => ({ dataset: { id } }) }, preventDefault() { prevented = true; } }); return prevented; };
  R.T.calls = [];
  assert.ok(key('contracts', 'Enter', true));
  assert.deepEqual(calls('openChat'), [['openChat', 'example-co', 'contracts']]);
  assert.equal(calls('select').length, 0);
  R.T.calls = [];
  assert.ok(key('contracts', 'Enter'));
  assert.deepEqual([...calls('select'), ...calls('go')], [['select', 'contracts'], ['go', 'team']]);
  R.T.calls = [];
  assert.ok(key('legal', 'ArrowLeft'), 'an open branch folds');
  assert.deepEqual(calls('setOpen'), [['setOpen', 'legal', false]]);
});

test('live: mounting subscribes and re-reads; rows follow the shared state (status dots, counts, the active chat)', async (t) => {
  if (skip(t)) return;
  render();
  await ui.settle();
  assert.equal(calls('ensureEvents').length, 1);
  assert.deepEqual(calls('loadList'), [['loadList', { quiet: true }]]);
  assert.equal(items().filter((n) => n.p['aria-selected'] === 'true').length, 0, 'no chat of this company open: nothing highlighted');
  // team.updated -> positions/state.js reloads the company; the panel draws what is there now
  const tax = node('tax');
  const tree = DATA.tree.map((r) => (r.id === 'tax' ? { ...tax, status: 'active', chatStatus: undefined, busy: 'answering General Counsel', pending: { requests: 0, proposals: 2 } } : r));
  R.T.companies = { 'example-co': { data: { ...DATA, tree } } };
  R.T.active = { id: 's1', position: { company: 'example-co', id: 'tax' } };
  ui.mount(P.TeamPanel);
  await ui.settle();
  assert.ok(has(ui.findAll((n) => has(n, 'dot'), item('tax').c)[0], 'working'));
  assert.deepEqual(ui.findAll((n) => has(n, 'pos-n'), item('tax').c).map((n) => ui.text(n)), ['2']);
  assert.match(item('tax').p['aria-label'], /^Tax Specialist\. Working\. 2 proposals$/);
  assert.equal(item('tax').p['aria-selected'], 'true', 'the active position chat is the highlighted row');
  R.T.active = { id: 's2', team: { company: 'example-co' } };
  ui.mount(P.TeamPanel);
  await ui.settle();
  assert.equal(item('@ceo').p['aria-selected'], 'true', 'a CEO chat highlights the CEO row');
});

test('empty states: Positions off says how to switch it on; no company; a refused folder; never a made-up row', async (t) => {
  if (skip(t)) return;
  render({ teamList: { enabled: false, root: 'C:/Users/you/helm-team', companies: [] }, companyId: null, companies: {} });
  await ui.settle();
  assert.equal(items().length, 0);
  const empty = ui.findAll((n) => n.t === 'empty')[0];
  assert.equal(empty.p.title, 'Team is off');
  assert.match(ui.text(empty), /Settings > Team > Positions/);
  assert.equal(ui.findAll(ui.byAct('team-company')).length + ui.findAll(ui.byAct('team-open')).length, 0, 'no company bar');
  ui.findAll(ui.byAct('team-settings'))[0].p.onClick({});
  assert.deepEqual(calls('go'), [['go', 'settings']]);

  render({ teamList: { enabled: true, root: 'C:/Users/you/helm-team', companies: [] }, companyId: null, companies: {} });
  await ui.settle();
  assert.equal(items().length, 0);
  assert.equal(ui.findAll((n) => n.t === 'empty')[0].p.title, 'No company yet');

  render({ teamList: { enabled: true, root: 'C:/Users/you/helm-team', rootProblem: 'it is inside a git repo', companies: [] }, companyId: null, companies: {} });
  await ui.settle();
  assert.match(ui.text(ui.findAll((n) => n.t === 'empty')[0]), /inside a git repo/);

  render({ teamList: null });
  await ui.settle();
  assert.equal(ui.findAll((n) => n.t === 'loading').length, 1);
  render({ teamList: null, listError: 'socket closed' });
  await ui.settle();
  const err = ui.findAll((n) => n.t === 'error-state')[0];
  assert.equal(err.p.error, 'socket closed');
  err.p.onRetry();
  assert.ok(calls('loadList').some((c) => c.length === 1), 'Try again re-reads loudly');
  render({ companies: { 'example-co': { error: 'team.get failed' } } });
  await ui.settle();
  assert.equal(ui.findAll((n) => n.t === 'error-state')[0].p.title, 'Could not read this company');
  assert.equal(items().length, 0);
});

test('the inspector registers the Team tab (and remembers it as the open panel)', () => {
  const idx = fs.readFileSync(path.join(UI, 'panels', 'index.js'), 'utf8');
  assert.match(idx, /\{ id: 'team', label: 'Team', icon: 'users', component: TeamPanel \}/);
  assert.match(idx, /import \{ TeamPanel \} from '\.\/team\.js'/);
  assert.match(fs.readFileSync(path.join(UI, 'panels', 'state.js'), 'utf8'), /const IDS = \[[^\]]*'team'[^\]]*\]/);
});
