// Positions: Settings > Team (ui/shell/settings.js TeamSettings), rendered in plain node through
// test/host/fixtures/ui-render.mjs. The rows the owner sees, what each control saves (one partial `team` object through
// settings.set, the same RPC every other section uses), the team folder's problem in words (from team.list, or
// the refusal of settings.set), and the Advanced disclosure with the rollover pair that can't be crossed.
// settings.js's imports other than the fixture's preact/html/icons shims go to auto-made stubs (named exports read
// from the import statement); store.js and util.js get the few real-ish exports the panel uses.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { registerHooks } = require('node:module');

const UI = path.join(__dirname, '..', '..', 'ui');
const FILE = path.join(UI, 'shell', 'settings.js');
const PARENT = pathToFileURL(FILE).href;
const REAL = new Set(['preact/hooks', '../lib/html.js', '../lib/icons.js']);
const PRE = 'team-settings-stub:';
const SPECIAL = {
  settings: 'export const settings = { get value() { return globalThis.__helmUiTest.settings; }, set value(v) { globalThis.__helmUiTest.settings = v; } };',
  saveSettings: 'export async function saveSettings(p) { const R = globalThis.__helmUiTest; const s = await R.rpc("settings.set", p); if (s) R.settings = { ...s }; return s; }',
  rpc: 'export const rpc = (...a) => globalThis.__helmUiTest.rpc(...a);',
  toast: 'export const toast = (...a) => globalThis.__helmUiTest.toast(...a);',
  appInfo: 'export const appInfo = { get value() { return globalThis.__helmUiTest.appInfo; } };',
  cx: 'export const cx = (...a) => a.filter(Boolean).join(" ");',
};
function stubSource(spec) {
  const src = fs.readFileSync(FILE, 'utf8');
  const names = new Set();
  const re = /import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) if (m[2] === spec) for (const p of m[1].split(',')) { const n = p.trim().split(/\s+as\s+/)[0].trim(); if (n) names.add(n); }
  return [...names].map((n) => SPECIAL[n] || `export const ${n} = new Proxy(function () {}, { get: (t, k) => (k === 'value' ? undefined : t[k]), apply: () => undefined });`).join('\n');
}

let ui, mod, R;
before(async () => {
  ui = await import('./fixtures/ui-render.mjs');
  if (!ui.available) return;
  await ui.importUnderTest(path.join(UI, 'lib', 'restart-note.js'));   // registers the fixture's hooks first
  registerHooks({
    resolve(spec, ctx, next) {
      const parent = ctx.parentURL && String(ctx.parentURL).split('?')[0];
      if (parent !== PARENT || REAL.has(spec)) return next(spec, ctx);
      return { url: PRE + encodeURIComponent(spec), format: 'module', shortCircuit: true };
    },
    load(url, ctx, next) {
      if (!url.startsWith(PRE)) return next(url, ctx);
      return { format: 'module', source: stubSource(decodeURIComponent(url.slice(PRE.length))), shortCircuit: true };
    },
  });
  mod = await ui.importUnderTest(FILE);
  R = ui.R;
});
const skip = (t) => { if (!ui.available) { t.skip('node:module registerHooks is missing in this node'); return true; } return false; };

const TEAM = { enabled: false, root: '~/helm-team', maxConcurrentRuns: 2, usageCeilingPct: 80, dutiesPaused: false, rollPct: 32, rollNowPct: 40, askWaitS: 300, askWaitPositionS: 180, askWaitMaxS: 600 };
// a settings.set that merges a partial team object (like main/settings.js), refusing what `refuse` says
function fresh({ team = {}, list = { enabled: false, root: 'C:/home/helm-team', companies: [] }, refuse = null } = {}) {
  ui.reset();
  R.settings = { team: { ...TEAM, ...team } };
  R.rpcImpl = async (method, p) => {
    if (method === 'team.list') { if (list instanceof Error) throw list; return list; }
    if (method === 'settings.set') {
      const why = refuse && refuse(p);
      if (why) throw Object.assign(new Error(why), { code: 'bad_params' });
      return { ...R.settings, team: { ...R.settings.team, ...p.team } };
    }
    throw new Error('unexpected ' + method);
  };
}
const sets = () => R.rpcLog.filter((c) => c[0] === 'settings.set').map((c) => c[1]);
const btn = (act) => ui.findAll((n) => n.p && n.p['data-act'] === act)[0];
const selects = () => ui.findAll((n) => n.t === 'select');
const select = (label) => selects().find((n) => n.p['aria-label'] === label);
const opts = (sel) => ui.findAll((n) => n.t === 'option', sel.c).map((o) => o.p.value);
const pick = async (label, v) => { select(label).p.onChange({ currentTarget: { value: String(v) } }); await ui.settle(); };
const rerender = async () => { ui.mount(mod.TeamSettings); await ui.settle(); };

test('the panel shows every Team setting with plain helper lines', async (t) => {
  if (skip(t)) return;
  fresh();
  await rerender();
  const txt = ui.text();
  for (const w of ['Positions', 'Team folder', 'Pause all duties', 'Duties wait at usage', 'Position replies at once', 'Advanced']) assert.ok(txt.includes(w), w);
  assert.ok(/outside every git repo/.test(txt));
  assert.ok(/Default 80%/.test(txt));
  assert.equal(btn('team-enabled').p['aria-checked'], false);
  assert.equal(select('Duties wait at usage').p.value, '80');
  assert.equal(select('Position replies at once').p.value, '2');
  assert.deepEqual(opts(select('Position replies at once')), ['1', '2', '3', '4', '5', '6', '7', '8']);
  // rollover rows stay folded until Advanced opens
  assert.equal(select('Fresh chat at its next quiet moment'), undefined);
  assert.ok(R.rpcLog.some((c) => c[0] === 'team.list'));
});

test('switches and selects save one partial team object through settings.set', async (t) => {
  if (skip(t)) return;
  fresh();
  await rerender();
  ui.click(ui.byAct('team-enabled'));
  await ui.settle();
  await rerender();
  assert.equal(btn('team-enabled').p['aria-checked'], true);
  ui.click(ui.byAct('team-paused'));
  await ui.settle();
  await pick('Duties wait at usage', 70);
  await pick('Position replies at once', 3);
  assert.deepEqual(sets(), [{ team: { enabled: true } }, { team: { dutiesPaused: true } }, { team: { usageCeilingPct: 70 } }, { team: { maxConcurrentRuns: 3 } }]);
  assert.equal(R.settings.team.usageCeilingPct, 70);
  assert.equal(R.toasts.length, 0);
});

test('a hand-edited value outside the choices is still shown and kept', async (t) => {
  if (skip(t)) return;
  fresh({ team: { usageCeilingPct: 85 } });
  await rerender();
  assert.equal(select('Duties wait at usage').p.value, '85');
  assert.ok(opts(select('Duties wait at usage')).includes('85'));
});

test('team folder: saves on blur, shows a refusal in words, and shows the rootProblem from team.list', async (t) => {
  if (skip(t)) return;
  const why = 'The team folder is inside the git repo at C:/x. Helm keeps it out of every repo, so nothing in it is pushed by accident.';
  fresh({ refuse: (p) => (p.team && p.team.root === 'C:/x/team' ? why : null) });
  await rerender();
  const field = () => ui.findAll((n) => n.t === 'input' && n.p['data-act'] === 'team-root')[0];
  field().p.onInput({ currentTarget: { value: 'C:/x/team' } });
  await ui.settle();
  field().p.onBlur();
  await ui.settle();
  assert.deepEqual(sets().at(-1), { team: { root: 'C:/x/team' } });
  assert.ok(ui.text().includes('Not saved: ' + why), ui.text());
  assert.equal(R.settings.team.root, '~/helm-team');   // nothing changed
  // a good folder saves and clears the message
  field().p.onInput({ currentTarget: { value: '~/elsewhere/team' } });
  await ui.settle();
  field().p.onBlur();
  await ui.settle();
  await rerender();
  assert.equal(R.settings.team.root, '~/elsewhere/team');
  assert.ok(!ui.text().includes('Not saved'));
  // an unchanged or blank field saves nothing
  const n = sets().length;
  field().p.onBlur();
  await ui.settle();
  assert.equal(sets().length, n);

  // a hand-edited bad root: the engine reports it through team.list
  fresh({ list: { enabled: true, root: 'C:/x/team', rootProblem: why, companies: [] }, team: { enabled: true, root: 'C:/x/team' } });
  await rerender();
  assert.ok(ui.text().includes("Helm can't use this folder: " + why));
});

test('team.list missing (older engine) leaves the panel working with no problem line', async (t) => {
  if (skip(t)) return;
  fresh({ list: Object.assign(new Error('unknown method'), { code: 'unknown_method' }) });
  await rerender();
  assert.ok(ui.text().includes('Team folder'));
  assert.ok(!/can't use this folder/.test(ui.text()));
});

test('Advanced opens the rollover pair, and neither select offers a crossed value', async (t) => {
  if (skip(t)) return;
  fresh();
  await rerender();
  ui.click(ui.byAct('team-advanced'));
  await ui.settle();
  const roll = select('Fresh chat at its next quiet moment');
  const now = select('Fresh chat as soon as the turn ends');
  assert.equal(roll.p.value, '32');
  assert.equal(now.p.value, '40');
  assert.ok(opts(roll).every((v) => +v < 40), opts(roll).join());
  assert.ok(opts(now).every((v) => +v > 32), opts(now).join());
  await pick('Fresh chat at its next quiet moment', 35);
  assert.deepEqual(sets().at(-1), { team: { rollPct: 35 } });
  await rerender();   // a fresh mount folds Advanced again
  assert.equal(select('Fresh chat at its next quiet moment'), undefined);
});

test('your name (team.ownerName): empty means "the owner", saves trimmed on blur / Enter, shows a refusal, Escape reverts', async (t) => {
  if (skip(t)) return;
  const tooLong = 'team.ownerName can be at most 40 characters';
  const angle = "team.ownerName can't contain < or >";
  fresh({ refuse: (p) => (p.team && /[<>]/.test(p.team.ownerName || '') ? angle : p.team && (p.team.ownerName || '').length > 40 ? tooLong : null) });
  await rerender();
  const field = () => ui.findAll((n) => n.t === 'input' && n.p['data-act'] === 'team-owner-name')[0];
  assert.ok(ui.text().includes('How positions refer to you. Empty means "the owner". At most 40 characters.'), ui.text());
  assert.equal(field().p.value, '');                 // the settings fixture has no ownerName: the default ''
  assert.equal(field().p.placeholder, 'the owner');
  assert.equal(field().p.maxLength, 40);
  // unchanged: nothing saved
  field().p.onBlur(); await ui.settle();
  assert.equal(sets().length, 0);
  // a name saves trimmed, as one partial team object
  field().p.onInput({ currentTarget: { value: '  Alex  ' } }); await ui.settle();
  field().p.onBlur(); await ui.settle();
  assert.deepEqual(sets().at(-1), { team: { ownerName: 'Alex' } });
  await rerender();
  assert.equal(R.settings.team.ownerName, 'Alex');
  assert.equal(field().p.value, 'Alex');
  // a refusal is shown in words (the key name swapped for "The name") and nothing changes
  field().p.onInput({ currentTarget: { value: 'Alex <x>' } }); await ui.settle();
  field().p.onBlur(); await ui.settle();
  assert.ok(ui.text().includes("Not saved: The name can't contain < or >"), ui.text());
  assert.equal(field().p['aria-invalid'], 'true');
  assert.equal(R.settings.team.ownerName, 'Alex');
  // Escape puts the saved value back and clears the message
  field().p.onKeyDown({ key: 'Escape', currentTarget: { blur() {} } }); await ui.settle();
  assert.equal(field().p.value, 'Alex');
  assert.ok(!ui.text().includes('Not saved'));
  // Enter blurs (which saves); clearing the field saves '' = "the owner"
  let blurred = false;
  field().p.onKeyDown({ key: 'Enter', currentTarget: { blur() { blurred = true; } } });
  assert.ok(blurred);
  field().p.onInput({ currentTarget: { value: '   ' } }); await ui.settle();
  field().p.onBlur(); await ui.settle();
  assert.deepEqual(sets().at(-1), { team: { ownerName: '' } });
  assert.equal(R.settings.team.ownerName, '');
});
