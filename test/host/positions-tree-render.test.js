// Positions: the Team view's org tree (ui/positions/tree.js) rendered in plain node through
// test/host/fixtures/ui-render.mjs (no DOM, no browser). Departments (docs/POSITIONS.md 2.4, 10.2): with at least one,
// the CEO's top level is grouped under a header per department, then "No department"; a header is not a tree item, so
// the tree keyboard model and the tree items themselves are what they were. With none, nothing changes.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { registerHooks } = require('node:module');

const UI = path.join(__dirname, '..', '..', 'ui');
const TREE = path.join(UI, 'positions', 'tree.js');
const PARENT = pathToFileURL(TREE).href;
const PRE = 'pos-tree-shim:';
const SHIMS = {
  '../shell/util.js': 'export const cx = (...a) => a.filter(Boolean).join(" ");',
  './state.js': `const R = globalThis.__helmUiTest;
    export const opens = { get value() { return R.opens || {}; } };
    export const selected = { get value() { return R.selected || {}; } };
    export const setOpen = (id, v) => { (R.setOpen ||= []).push([id, v]); };
    export const select = (id) => { (R.selectedIds ||= []).push(id); };`,
};

let ui, T, R;
before(async () => {
  ui = await import('./fixtures/ui-render.mjs');
  if (!ui.available) return;
  await ui.importUnderTest(path.join(UI, 'lib', 'restart-note.js'));   // a file with no imports: registers the fixture's hooks first
  registerHooks({
    resolve(spec, ctx, next) {
      const parent = ctx.parentURL && String(ctx.parentURL).split('?')[0];
      if (parent === PARENT && Object.hasOwn(SHIMS, spec)) return { url: PRE + encodeURIComponent(spec), format: 'module', shortCircuit: true };
      return next(spec, ctx);
    },
    load(url, ctx, next) {
      if (url.startsWith(PRE)) return { format: 'module', source: SHIMS[decodeURIComponent(url.slice(PRE.length))], shortCircuit: true };
      return next(url, ctx);
    },
  });
  T = await ui.importUnderTest(TREE);
  R = ui.R;
});
const skip = (t) => { if (!ui.available) { t.skip('node:module registerHooks is missing in this node'); return true; } return false; };

const row = (id, name, parent, dept, head) => ({ id, name, parent, remit: `${name} remit`, status: 'active', pending: { requests: 0, proposals: 0 },
  ...(dept ? { department: dept, departmentHead: head } : {}) });
const DTREE = [
  row('qa', 'QA Engineer', null),
  row('legal', 'General Counsel', null, 'Legal', 'legal'),
  row('tax', 'Tax Specialist', 'legal', 'Legal', 'legal'),
  row('contracts', 'Contracts Manager', 'legal', 'Legal', 'legal'),
  row('finance', 'Controller', null, 'Finance', 'finance'),
];
const data = (tree) => ({ company: { id: 'example-co', name: 'Example Co', folders: ['C:/Users/you/example-co'] }, tree });
function render(tree, { phone = false, sel = null } = {}) {
  ui.reset();
  R.opens = {}; R.selected = sel ? { 'example-co': sel } : {};
  ui.mount(T.Tree, { cid: 'example-co', data: data(tree), phone });
}
const items = () => ui.findAll((n) => n.p && n.p.role === 'treeitem');
const groups = () => ui.findAll((n) => n.p && n.p.role === 'group');

test('tree with departments: a labelled group per department (then No department), headers hidden from the tree, items unchanged', async (t) => {
  if (skip(t)) return;
  render(DTREE, { sel: 'tax' });
  await ui.settle();
  assert.deepEqual(items().map((n) => n.p['data-id']), ['@ceo', 'legal', 'tax', 'contracts', 'finance', 'qa'], 'every position is a tree item, in grouped order');
  assert.deepEqual(groups().map((g) => g.p['aria-label']), ['Legal department, headed by General Counsel, 3 positions', 'Finance department, headed by Controller, 1 position', 'No department, 1 position']);
  assert.deepEqual(groups().map((g) => g.p['data-dept']), ['Legal', 'Finance', '']);
  const heads = ui.findAll((n) => /\bpos-dept\b/.test(n.p?.class || '') && /\bpos-row\b/.test(n.p.class));
  assert.equal(heads.length, 3);
  assert.ok(heads.every((h) => h.p['aria-hidden'] === 'true' && h.p.role !== 'treeitem' && h.p.tabindex === undefined), 'a header is not focusable and not read twice');
  assert.match(ui.text(heads[0]), /^Legal.*headed by General Counsel.*3 positions$/);
  assert.match(ui.text(heads[2]), /^No department.*1 position$/);
  assert.doesNotMatch(ui.text(heads[2]), /headed by/);
  // the header sits on the head's indent so the guides run on; levels / sets are the tree's
  assert.equal(heads[0].p.style['--indent'], '16px');
  const legal = items().find((n) => n.p['data-id'] === 'legal');
  assert.deepEqual([legal.p['aria-level'], legal.p['aria-posinset'], legal.p['aria-setsize']], [2, 1, 3]);
  // roving tab stop: the selected row only
  assert.deepEqual(items().filter((n) => n.p.tabindex === 0).map((n) => n.p['data-id']), ['tax']);
  // the head and staff rows live inside their department's group
  const legalGroup = groups()[0];
  assert.deepEqual(ui.findAll((n) => n.p && n.p.role === 'treeitem', legalGroup.c).map((n) => n.p['data-id']), ['legal', 'tax', 'contracts']);
});

test('tree on the phone: the count drops its word (CSS), headers keep the phone indent', async (t) => {
  if (skip(t)) return;
  render(DTREE, { phone: true });
  await ui.settle();
  const tree = ui.findAll((n) => n.p && n.p.role === 'tree')[0];
  assert.match(tree.p.class, /\bis-phone\b/);
  const heads = ui.findAll((n) => /\bpos-dept\b/.test(n.p?.class || '') && /\bpos-row\b/.test(n.p.class));
  assert.equal(heads[0].p.style['--indent'], '12px');
  assert.equal(ui.findAll((n) => /\bpos-dept-n-word\b/.test(n.p?.class || '')).length, 3, 'the word is its own span, hidden on the phone by positions.css');
});

test('tree without departments: no groups, no headers, the rows as before', async (t) => {
  if (skip(t)) return;
  const plain = DTREE.map(({ department: _d, departmentHead: _h, ...r }) => r);
  render(plain);
  await ui.settle();
  assert.deepEqual(items().map((n) => n.p['data-id']), ['@ceo', 'qa', 'legal', 'tax', 'contracts', 'finance'], 'the CEO report order, untouched');
  assert.equal(groups().length, 0);
  assert.equal(ui.findAll((n) => /\bpos-dept\b/.test(n.p?.class || '')).length, 0);
});
