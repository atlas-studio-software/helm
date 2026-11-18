// Positions, lane T10 (shell wiring): where the Team view is reached from and how position chats sit in the
// sidebar (docs/POSITIONS.md 10.1). The split rule is pure (ui/lib/session-activity.js, require(esm)); the shell
// wiring (rail, palette, shortcut, Mains / Phone, Home card, mock routing, css link) is checked on the source,
// the way restart-note.test.js and chat-team-hooks.test.js check theirs, since those modules need a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { splitSessions, buildProjectGroups, isPositionSession, ACTIVE_WINDOW_MS } = require('../../ui/lib/session-activity.js');

const ROOT = path.join(__dirname, '..', '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const NOW = new Date(2026, 10, 18, 9, 0).getTime();
const MIN = 60 * 1000, HOUR = 60 * MIN;
const ids = (list) => list.map((s) => s.id);
const co = { company: 'example-co', companyName: 'Example Co' };
const base = (o) => ({ claudeSessionId: `c-${o.id}`, title: 'T', status: 'idle', pinned: false, archived: false,
  updatedAt: NOW - 3 * HOUR, createdAt: NOW - 4 * HOUR, ...o });
const ceo = (o) => base({ project: 'example-site', cwd: 'C:\\work\\example-site', team: co, ...o });
const pos = (id, o = {}, p = {}) => base({ title: p.name || id, project: id, cwd: `C:\\team\\example-co\\positions\\${id}`,
  position: { ...co, id, name: p.name || id, parent: null, chat: 1, ...p }, ...o });
const plain = (o) => base({ project: 'storefront', cwd: 'C:\\work\\storefront', ...o });

test('isPositionSession: a position chat yes; a CEO session, a plain session and junk no', () => {
  assert.equal(isPositionSession(pos('legal')), true);
  assert.equal(isPositionSession(ceo({ id: 'c' })), false);
  assert.equal(isPositionSession(plain({ id: 'p' })), false);
  assert.equal(isPositionSession(null), false);
  assert.equal(isPositionSession({ id: 'x', position: {} }), false);       // no position id: not one
  assert.equal(isPositionSession({ id: 'x', position: 'legal' }), false);  // wrong shape
});

test('splitSessions: live / recent position chats go to team, never to active, past, empty or archived', () => {
  const list = [
    pos('legal', { id: 'p-work', status: 'working', updatedAt: NOW - 2 * MIN }),
    pos('money', { id: 'p-wait', status: 'waiting', updatedAt: NOW - 5 * HOUR }),
    pos('tax', { id: 'p-recent', updatedAt: NOW - 20 * MIN }),
    pos('qa', { id: 'p-old', updatedAt: NOW - 3 * HOUR }),                                      // idle, old: Team view only
    pos('qa', { id: 'p-empty', updatedAt: NOW - 3 * HOUR, claudeSessionId: null }),             // never got a prompt
    pos('legal', { id: 'p-ended', status: 'closed', archived: true }, { chat: 1, ended: true }), // chat 1, full
    pos('legal', { id: 'p-ended-live', updatedAt: NOW - MIN }, { ended: true }),                 // ended, still recent
    ceo({ id: 'ceo', status: 'working', updatedAt: NOW - MIN }),
    plain({ id: 'plain-past', updatedAt: NOW - 5 * HOUR }),
  ];
  const r = splitSessions(list, { now: NOW });
  assert.deepEqual(ids(r.team).sort(), ['p-recent', 'p-wait', 'p-work']);
  assert.deepEqual(ids(r.active), ['ceo']);                 // the CEO session stays a normal session
  assert.deepEqual(ids(r.past), ['plain-past']);
  assert.deepEqual(ids(r.empty), []);
  assert.deepEqual(ids(r.archived), []);                    // an ended position chat is not in Archived either
});

test('splitSessions: the keep set and the open position chat stay in team (never invisible while open)', () => {
  const old = pos('qa', { id: 'p-old', updatedAt: NOW - 3 * HOUR });
  const kept = pos('money', { id: 'p-kept', updatedAt: NOW - 3 * HOUR });
  assert.deepEqual(ids(splitSessions([old, kept], { now: NOW }).team), []);
  assert.deepEqual(ids(splitSessions([old, kept], { now: NOW, keep: new Set(['p-kept']) }).team), ['p-kept']);
  assert.deepEqual(ids(splitSessions([old, kept], { now: NOW, openId: 'p-old' }).team), ['p-old']);
  // the window is the main list's: one hour
  const edge = pos('tax', { id: 'p-edge', updatedAt: NOW - ACTIVE_WINDOW_MS + MIN });
  assert.deepEqual(ids(splitSessions([edge], { now: NOW }).team), ['p-edge']);
});

test('project groups never get a group per position folder', () => {
  const list = [pos('legal', { id: 'a', status: 'working' }), pos('money', { id: 'b', status: 'waiting' }), ceo({ id: 'c', status: 'working' })];
  const groups = buildProjectGroups(splitSessions(list, { now: NOW }).active, []);
  assert.deepEqual(groups.map((g) => g.name), ['example-site']);
  assert.deepEqual(ids(groups[0].sessions), ['c']);
});

test('splitSessions without positions keeps its old lists (team is just empty)', () => {
  const r = splitSessions([plain({ id: 'x', status: 'working' })], { now: NOW });
  assert.deepEqual(ids(r.active), ['x']);
  assert.deepEqual(r.team, []);
});

test('shell: Team is a full view with a rail button, a palette entry and Ctrl+Shift+T, with no clash', () => {
  const idx = src('ui/shell/index.js');
  assert.match(idx, /if \(v === 'team'\) return html`<\$\{Pane\} key="p0"><\$\{TeamView\} \/><\/\/>`/, 'desktop Mains branch');
  assert.match(idx, /else if \(v === 'team'\) screen = html`<\$\{TeamView\} \/>`/, 'phone screen branch');
  assert.match(idx, /import \{ TeamView \} from '\.\.\/positions\/team\.js'/);
  assert.match(idx, /plist-team/, 'phone list header icon');
  // the shortcut handler: exactly one Ctrl+Shift+T, nothing else on T
  const keys = [...idx.matchAll(/k === '([a-z,])'( && e\.shiftKey| && !e\.shiftKey)?/g)].map((m) => `${m[1]}${m[2] && !m[2].includes('!') ? '+shift' : ''}`);
  assert.ok(keys.includes('t+shift'), 'Ctrl+Shift+T is handled');
  assert.equal(keys.filter((k) => k === 't+shift').length, 1);
  assert.equal(keys.filter((k) => k === 't').length, 0, 'plain Ctrl+T stays free');
  assert.equal(new Set(keys).size, keys.length, `no two handlers on one combo: ${keys.join(' ')}`);
  for (const f of ['ui/shell/tabs.js', 'ui/shell/split.js', 'ui/chat/index.js', 'ui/composer/index.js', 'ui/deck/deck.js']) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    assert.doesNotMatch(src(f), /key(\.toLowerCase\(\))? === '[tT]'[^\n]*shiftKey|KeyT/, `${f} must not take Ctrl+Shift+T`);
  }
  const chrome = src('ui/shell/chrome.js');
  assert.match(chrome, /icon="users" label="Team" on=\$\{v === 'team'\}/, 'rail button');
  assert.match(chrome, /badge=\$\{teamNeedsYou\.value \|\| null\}/, 'rail badge');
  const pal = src('ui/shell/palette.js');
  assert.match(pal, /\{ id: 'team', group: 'Actions', icon: 'users', label: 'Open Team'[^\n]*keys: \[mod, 'Shift', 'T'\], run: \(\) => go\('team'\)/);
  const sheet = src('ui/shell/shortcuts.js');
  assert.match(sheet, /\['Team: your AI staff per company', k\('mod', 'shift', 'T'\)\]/, 'the shortcuts sheet lists it');
  assert.match(src('ui/lib/icons.js'), /\n  users: '/, 'users glyph');
});

test('shell: the sidebar Team section, the Home card and the app.select route', () => {
  const sb = src('ui/shell/sidebar.js');
  assert.match(sb, /function TeamSection\(/);
  assert.match(sb, /<\$\{TeamSection\} list=\$\{team\} forceOpen=\$\{f\} \/>\s*\n\s*\$\{!f && html`<\$\{ElsewhereSection\} \/>`\}/, 'Team sits before Elsewhere and Past');
  const st = src('ui/shell/state.js');
  assert.match(st, /archivedSessions = computed\(\(\) => sessions\.value\.filter\(\(s\) => s\.archived && !isPositionSession\(s\)\)\)/);
  assert.match(st, /on\('app\.select', \(msg\) => routeSelect\(msg, \{\s*\n\s*go, openSession,/, 'app.select goes through routeSelect with the module go()');
  const home = src('ui/shell/home.js');
  assert.match(home, /team\.map\(\(c\) => html`<\$\{TeamCard\}/);
});

// app.select routing (ui/shell/select-route.js). Regression: the old handler declared `const go` for its retry loop
// in the same function as the Team branch's go('team'), so a team toast / push click threw "Cannot access 'go'
// before initialization" and never opened the company.
const { routeSelect } = require('../../ui/shell/select-route.js');
const fakeShell = (known = []) => {
  const calls = [];
  const timers = [];
  return {
    calls, timers,
    deps: {
      go: (v) => calls.push(['go', v]),
      openSession: (id) => calls.push(['open', id]),
      hasSession: (id) => known.includes(id),
      setCompany: (cid) => { calls.push(['company', cid]); },
      later: (fn, ms) => { timers.push([fn, ms]); },
    },
  };
};

test('app.select { view: team, company } (a team toast / push click) opens the Team view on that company', async () => {
  const f = fakeShell();
  assert.doesNotThrow(() => routeSelect({ view: 'team', company: 'example-co' }, f.deps));
  assert.deepEqual(f.calls, [['go', 'team']]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.calls, [['go', 'team'], ['company', 'example-co']]);
  // without a company: the Team view as it was; a failing setCompany never throws out of the handler
  const g = fakeShell();
  assert.equal(routeSelect({ view: 'team', company: null }, g.deps), 'team');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(g.calls, [['go', 'team']]);
  const h = fakeShell();
  h.deps.setCompany = () => Promise.reject(new Error('not loaded'));
  assert.equal(routeSelect({ view: 'team', company: 'x' }, h.deps), 'team');
  await new Promise((r) => setImmediate(r));
});

test('app.select { sessionId } still opens the session, retrying while it has not landed', () => {
  const f = fakeShell(['s1']);
  assert.equal(routeSelect({ sessionId: 's1' }, f.deps), 'session');
  assert.deepEqual(f.calls, [['open', 's1']]);
  // a session id wins over view: team; an unknown session is retried 10 times, 200 ms apart, then given up
  const g = fakeShell([]);
  assert.equal(routeSelect({ sessionId: 's9', view: 'team' }, g.deps), 'session');
  let runs = 0;
  while (g.timers.length && runs < 50) { const [fn, ms] = g.timers.shift(); assert.equal(ms, 200); fn(); runs++; }
  assert.equal(runs, 10);
  assert.deepEqual(g.calls, []);
  // nothing to show: a no-op
  assert.equal(routeSelect({}, fakeShell().deps), null);
  assert.equal(routeSelect(null, fakeShell().deps), null);
});

test('the host sends what routeSelect reads: notify.js clicks a session-less team notice into { view, company: id }', () => {
  assert.match(src('main/notify.js'), /broadcast\('app\.select', \{ view: 'team', company: \(n\.team && n\.team\.company\) \|\| null \}\)/);
  assert.doesNotMatch(src('ui/shell/state.js'), /const go = /, 'no local go() shadows the module go() in state.js');
});

test('Home: Team cards only for companies that need the user, never while off or broken', async () => {
  // teamCards is pure but home.js imports browser modules; evaluate just the function from the source
  const m = src('ui/shell/home.js').match(/export function teamCards\(list\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'teamCards in home.js');
  const teamCards = new Function(`${m[0].replace('export ', '')}; return teamCards;`)();
  const cos = [{ id: 'a', name: 'A', needsYou: 2 }, { id: 'b', name: 'B', needsYou: 0 }, { id: 'c', name: 'C' }];
  assert.deepEqual(teamCards({ enabled: true, companies: cos }).map((c) => c.id), ['a']);
  assert.deepEqual(teamCards({ enabled: false, companies: cos }), []);
  assert.deepEqual(teamCards({ enabled: true, rootProblem: 'inside a repo', companies: cos }), []);
  assert.deepEqual(teamCards(null), []);
  assert.deepEqual(teamCards({ enabled: true }), []);
});

test('mock mode routes team.* to the Team mock and honours the Settings switch; the Team sheet loads last', () => {
  const tr = src('ui/lib/transport.js');
  assert.match(tr, /if \(method\.startsWith\('team\.'\)\) \{/);
  assert.match(tr, /\(await import\('\.\/mock-positions\.js'\)\)\.mockTeam\(method, p, \{ state: S, emit \}\)/);
  assert.match(tr, /method === 'team\.list' && S\.settings\.team && S\.settings\.team\.enabled === false/);
  const html = src('ui/index.html');
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  assert.equal(links[links.length - 1], '/positions/positions.css', 'positions.css after the existing sheets');
  assert.ok(fs.existsSync(path.join(ROOT, 'ui/positions/positions.css')));
});

test('overlap audit covers the team screens', () => {
  const oa = src('tools/overlap-audit.js');
  for (const name of ['team', 'team-detail', 'team-cards', 'team-position', 'team-sidebar']) assert.match(oa, new RegExp(`S\\('${name}', `), name);
});
