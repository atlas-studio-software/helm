// Positions: the chat hooks for the team cards (ui/chat/index.js build() + Unit(), ui/chat/tools.js describe()).
// An Ask card (mcp__team__team_ask / colleague_ask) is never folded into a "Worked for ... · N tool calls" group,
// the other mcp__team__* tools get their own row words, and a normal chat groups exactly as before.
// Rendered in plain node through test/host/fixtures/ui-render.mjs. Every import of index.js / tools.js /
// team-cards.js other than team-cards.js itself (and the fixture's own preact/html/icons shims) goes to an
// auto-made stub module whose named exports are read from the import statement.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { registerHooks } = require('node:module');

const UI = path.join(__dirname, '..', '..', 'ui');
const INDEX = path.join(UI, 'chat', 'index.js');
const TOOLS = path.join(UI, 'chat', 'tools.js');
const TEAM = path.join(UI, 'chat', 'team-cards.js');
const href = (f) => pathToFileURL(f).href;
const PARENTS = new Map([INDEX, TOOLS, TEAM].map((f) => [href(f), f]));
const REAL = new Set(['./team-cards.js', 'preact/hooks', '../lib/html.js', '../lib/icons.js']);
const REAL_FOR_TOOLS = new Set(['./util.js']);   // describe() words come from util (basename, relPath, ...)
const PRE = 'team-hooks-stub:';

// named imports of one specifier in a source file
function namesFrom(src, spec) {
  const out = new Set();
  const re = /import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[2] !== spec) continue;
    for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/)[0].trim(); if (n) out.add(n); }
  }
  return [...out];
}
const SPECIAL = {
  memo: 'export const memo = (C) => C;',
  signal: 'export const signal = (v) => ({ value: v, peek() { return this.value; } });',
  kids: 'export const kids = new Map();',
  descendants: 'export const descendants = () => [];',
  foldRewound: 'export const foldRewound = (u) => u;',
  isOpen: 'export const isOpen = () => false;',
};
function stubSource(parentFile, spec) {
  const src = fs.readFileSync(parentFile, 'utf8');
  return namesFrom(src, spec).map((n) => SPECIAL[n] || `export const ${n} = new Proxy(function () {}, { get: (t, k) => (k === 'value' ? undefined : t[k]), apply: () => undefined });`).join('\n');
}

let ui, idx, tools;
before(async () => {
  ui = await import('./fixtures/ui-render.mjs');
  if (!ui.available) return;
  await ui.importUnderTest(path.join(UI, 'lib', 'restart-note.js'));   // registers the fixture's hooks first
  registerHooks({
    resolve(spec, ctx, next) {
      const parent = ctx.parentURL && String(ctx.parentURL).split('?')[0];
      const file = parent && PARENTS.get(parent);
      if (!file || REAL.has(spec)) return next(spec, ctx);
      // past the fixture's own ./util.js shim: the real file
      if (file === TOOLS && REAL_FOR_TOOLS.has(spec)) return { url: new URL(spec, parent).href, format: 'module', shortCircuit: true };
      return { url: PRE + encodeURIComponent(file) + '|' + encodeURIComponent(spec), format: 'module', shortCircuit: true };
    },
    load(url, ctx, next) {
      if (!url.startsWith(PRE)) return next(url, ctx);
      const [f, s] = url.slice(PRE.length).split('|').map(decodeURIComponent);
      return { format: 'module', source: stubSource(f, s), shortCircuit: true };
    },
  });
  await ui.importUnderTest(TEAM);
  idx = await ui.importUnderTest(INDEX);
  tools = await ui.importUnderTest(TOOLS);
});
const skip = (t) => { if (!ui.available) { t.skip('node:module registerHooks is missing in this node'); return true; } return false; };

const SESSION = { id: 's1', status: 'idle' };
let n = 0;
const tool = (name, over = {}) => ({ id: 'i' + (++n), type: 'tool', name, toolUseId: 'tu' + n, status: 'done', input: {}, ...over });
const said = (text) => ({ id: 'i' + (++n), type: 'assistant', text });
const shape = (units) => units.map((u) => (u.kind === 'group' ? `group(${u.items.map((i) => i.name || i.type).join(',')})` : `${u.item.type}:${u.item.name || ''}`));

test('a normal tool run still collapses into one group (unchanged behaviour)', (t) => {
  if (skip(t)) return;
  const items = [said('Looking.'), tool('Read', { input: { file_path: 'a.js' } }), { id: 'th', type: 'thinking', text: 'hm' },
    tool('Grep', { input: { pattern: 'x' } }), tool('Edit', { input: { file_path: 'a.js' } }), said('Done.'), tool('Bash', { input: { command: 'ls' } })];
  const { units } = idx.build(items, SESSION, 150);
  assert.deepEqual(shape(units), ['assistant:', 'group(Read,thinking,Grep,Edit)', 'assistant:', 'tool:Bash']);
});

test('an Ask card is never folded into a tool group, and it splits the run around it', (t) => {
  if (skip(t)) return;
  const ask = tool('mcp__team__team_ask', { input: { to: 'legal', question: 'Q?' } });
  const items = [tool('Read'), tool('Grep'), ask, tool('Edit'), tool('Bash')];
  const { units } = idx.build(items, SESSION, 150);
  assert.deepEqual(shape(units), ['group(Read,Grep)', 'tool:mcp__team__team_ask', 'group(Edit,Bash)']);
  const colleague = tool('mcp__team__colleague_ask', { input: { to: 'tax', question: 'Q?' } });
  const u2 = idx.build([tool('Read'), colleague], SESSION, 150).units;
  assert.deepEqual(shape(u2), ['tool:Read', 'tool:mcp__team__colleague_ask']);
});

test('other mcp__team__* tools still group like any tool', (t) => {
  if (skip(t)) return;
  const { units } = idx.build([tool('mcp__team__team_roster'), tool('mcp__team__notebook_add')], SESSION, 150);
  assert.deepEqual(shape(units), ['group(mcp__team__team_roster,mcp__team__notebook_add)']);
});

test('describe(): team tools get their own words, normal tools are untouched', (t) => {
  if (skip(t)) return;
  const roster = tools.describe(tool('mcp__team__team_roster', { input: { under: 'legal' } }), 'C:/x');
  assert.equal(roster.verb, 'Looked at the team');
  assert.equal(roster.target, 'Legal');
  const running = tools.describe(tool('mcp__team__notebook_add', { status: 'running', input: { section: 'Facts' } }), 'C:/x');
  assert.equal(running.verb, 'Noting in the notebook');
  assert.equal(running.target, 'Facts');
  // a non-team MCP tool and a built-in tool fall through to the usual describe()
  const unknown = tools.describe(tool('mcp__team__not_a_tool'), 'C:/x');
  const other = tools.describe(tool('mcp__other__thing'), 'C:/x');
  assert.notEqual(unknown.verb, undefined);
  assert.notEqual(other.verb, 'Looked at the team');
  const read = tools.describe(tool('Read', { input: { file_path: 'C:/x/a.js' } }), 'C:/x');
  assert.ok(/a\.js/.test(String(read.target)), JSON.stringify(read));
});

test('isTeamCard/teamUnit: plain items render through the usual path (teamUnit returns null)', async (t) => {
  if (skip(t)) return;
  const tc = await ui.importUnderTest(TEAM);
  for (const it of [tool('Read'), said('hi'), { id: 'u', type: 'user', text: 'hello' }, { id: 'r', type: 'result' }]) {
    assert.equal(tc.isTeamCard(it), false, JSON.stringify(it));
    assert.equal(tc.teamUnit(it, 's1'), null, JSON.stringify(it));
  }
  assert.ok(tc.teamUnit(tool('mcp__team__team_ask'), 's1'));
});
