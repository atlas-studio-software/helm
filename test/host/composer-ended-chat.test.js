// Positions: an ended position chat (session.position.ended, docs/PROTOCOL.md "Session fields") has no composer box,
// only "This chat has ended · continue in chat N", whose button opens the position's current chat (a loaded session
// of the same position that has not ended, highest chat number), or asks team.open when none is loaded.
// A normal session still gets the box, and keeps one composer instance across session switches.
// Rendered in plain node through test/host/fixtures/ui-render.mjs; every import of ui/composer/index.js other than
// the fixture's preact/html/icons shims goes to a stub below that reads globalThis.__composerTest.
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { registerHooks } = require('node:module');

const FILE = path.join(__dirname, '..', '..', 'ui', 'composer', 'index.js');
const PARENT = pathToFileURL(FILE).href;
const REAL = new Set(['preact/hooks', '../lib/html.js', '../lib/icons.js']);
const PRE = 'composer-ended-stub:';

const T = globalThis.__composerTest = { sessions: [], activeId: null, drafts: {}, saves: [], opened: [], sent: [] };
const STUBS = {
  '../lib/store.js': `const T = globalThis.__composerTest; const R = globalThis.__helmUiTest;
    export const sessions = { get value() { return T.sessions; }, peek() { return T.sessions; } };
    export const activeId = { get value() { return T.activeId; }, peek() { return T.activeId; } };
    export const activeSession = { get value() { return T.sessions.find((s) => s.id === T.activeId) || null; } };
    export const send = (...a) => { T.sent.push(a); return Promise.resolve(); };
    export const rpc = (...a) => R.rpc(...a);
    export const toast = (...a) => R.toast(...a);
    export const noteAttachments = () => {};
    export const noteDraft = () => {};`,
  './util.js': `const T = globalThis.__composerTest;
    export const isPhone = { value: false };
    export const isTouch = () => true;
    export const loadDraft = (id) => T.drafts[id] || '';
    export const saveDraft = (id, v) => { T.saves.push([id, v]); };
    export const loadHistory = () => [];
    export const pushHistory = () => {};
    export const readDataUrl = async () => '';
    export const fmtBytes = (n) => String(n);
    let n = 0; export const uid = () => 'u' + (++n);
    export const getCommands = async () => [];
    export const filterCommands = () => [];
    export const normFile = (x) => x;
    export const detectToken = () => null;`,
  '../shell/state.js': 'const T = globalThis.__composerTest; export const openSession = (id) => { T.opened.push(id); };',
  './voice.js': 'export const useVoice = () => ({}); export const VoiceStatus = () => null;',
  './bar.js': 'export const Bar = () => null;',
  './menu.js': 'export const AutoMenu = () => null;',
  '../shell/auth-notice.js': 'export const AuthNotice = () => null;',
  '../lib/stop.js': 'export const stopTurn = () => {};',
};

// window events: a real EventTarget, with a count of the composer's listeners
const win = new EventTarget();
const live = new Map();
globalThis.addEventListener = (ev, fn) => { win.addEventListener(ev, fn); live.set(ev, (live.get(ev) || 0) + 1); };
globalThis.removeEventListener = (ev, fn) => { win.removeEventListener(ev, fn); live.set(ev, (live.get(ev) || 0) - 1); };
globalThis.dispatchEvent = (e) => win.dispatchEvent(e);
globalThis.requestAnimationFrame = (f) => setImmediate(f);
let added = 0;
const origAdd = globalThis.addEventListener;
globalThis.addEventListener = (ev, fn) => { if (String(ev).startsWith('helm:composer-')) added++; origAdd(ev, fn); };
const composerListeners = () => ['helm:composer-insert', 'helm:composer-attach', 'helm:composer-focus'].reduce((a, ev) => a + (live.get(ev) || 0), 0);
const insert = (text) => win.dispatchEvent(Object.assign(new Event('helm:composer-insert'), { detail: { text } }));

let ui, mod;
before(async () => {
  ui = await import('./fixtures/ui-render.mjs');
  if (!ui.available) return;
  await ui.importUnderTest(path.join(__dirname, '..', '..', 'ui', 'lib', 'restart-note.js'));   // registers the fixture's hooks first
  registerHooks({
    resolve(spec, ctx, next) {
      const parent = ctx.parentURL && String(ctx.parentURL).split('?')[0];
      if (parent !== PARENT || REAL.has(spec)) return next(spec, ctx);
      return { url: PRE + encodeURIComponent(spec), format: 'module', shortCircuit: true };
    },
    load(url, ctx, next) {
      if (!url.startsWith(PRE)) return next(url, ctx);
      const spec = decodeURIComponent(url.slice(PRE.length));
      if (!(spec in STUBS)) throw new Error(`composer-ended test: no stub for ${spec}`);
      return { format: 'module', source: STUBS[spec], shortCircuit: true };
    },
  });
  mod = await ui.importUnderTest(FILE);
});
const skip = (t) => { if (!ui.available) { t.skip('node:module registerHooks is missing in this node'); return true; } return false; };

const pos = (chat, over = {}) => ({ company: 'acme', companyName: 'Acme', id: 'legal', name: 'Legal', parent: null, chat, ...over });
const ENDED = { id: 's2', status: 'idle', archived: true, position: pos(2, { ended: true }) };
const NORMAL = { id: 'n1', status: 'idle', cwd: 'C:/x' };
const NORMAL2 = { id: 'n2', status: 'idle', cwd: 'C:/y' };

beforeEach(() => {
  if (!ui?.available) return;
  ui.unmountAll();
  ui.reset();
  Object.assign(T, { sessions: [], activeId: null, drafts: {}, saves: [], opened: [], sent: [] });
});

const textareas = () => ui.findAll((n) => n.t === 'textarea');
const bar = () => ui.findAll((n) => n.p.class === 'cmp-ended')[0];
const link = () => ui.findAll(ui.byAct('cmp-ended-open'))[0];

test('an ended position chat renders the ended bar and no textarea; no draft writes, no window-event listeners', async (t) => {
  if (skip(t)) return;
  T.sessions = [ENDED];
  T.activeId = 's2';
  T.drafts.s2 = 'old draft';
  ui.mount(mod.Composer);
  await ui.settle();
  assert.equal(textareas().length, 0);
  const b = bar();
  assert.ok(b, 'the ended bar is there');
  assert.equal(b.p.role, 'status');
  assert.match(ui.text(b), /This chat has ended/);
  assert.equal(link().t, 'button');
  assert.equal(link().p.type, 'button');
  assert.equal(composerListeners(), 0, 'no helm:composer-* listener for an ended chat');
  insert('typed into an ended chat');
  await ui.settle();
  assert.deepEqual(T.saves, []);
  assert.equal(textareas().length, 0);
});

test('the same, for a split-view pane given its sid', async (t) => {
  if (skip(t)) return;
  T.sessions = [NORMAL, ENDED];
  T.activeId = 'n1';
  ui.mount(mod.Composer, { sid: 's2' });
  await ui.settle();
  assert.equal(textareas().length, 0);
  assert.ok(bar());
});

test('the link names the current chat (same position, not ended, highest chat) and opens it', async (t) => {
  if (skip(t)) return;
  T.sessions = [
    { id: 's1', position: pos(1, { ended: true }) },
    ENDED,
    { id: 's3', position: pos(3) },
    { id: 's4', position: pos(4, { ended: true }) },          // ended: never the current chat
    { id: 'other', position: pos(9, { id: 'tax' }) },          // another position
    { id: 'otherco', position: pos(7, { company: 'zeta' }) },  // the same id in another company
    NORMAL,
  ];
  T.activeId = 's2';
  ui.mount(mod.Composer);
  await ui.settle();
  assert.equal(ui.text(link()), 'continue in chat 3');
  assert.match(link().p['aria-label'], /^Continue in chat 3 with Legal$/);
  ui.click('cmp-ended-open');
  await ui.settle();
  assert.deepEqual(T.opened, ['s3']);
  assert.deepEqual(ui.R.rpcLog, [], 'no rpc when the current chat is loaded');
});

test('currentChatOf picks the highest live chat of the same position, or null', (t) => {
  if (skip(t)) return;
  const list = [{ id: 'a', position: pos(2) }, { id: 'b', position: pos(5) }, { id: 'c', position: pos(6, { ended: true }) }, { id: 'd' }];
  assert.equal(mod.currentChatOf(pos(1), list).id, 'b');
  assert.equal(mod.currentChatOf(pos(1, { id: 'nobody' }), list), null);
  assert.equal(mod.currentChatOf(null, list), null);
});

test('no current chat loaded: the link asks team.open and opens what it returns', async (t) => {
  if (skip(t)) return;
  T.sessions = [ENDED, NORMAL];
  T.activeId = 's2';
  ui.R.rpcImpl = async (method) => (method === 'team.open' ? { sessionId: 's7' } : null);
  ui.mount(mod.Composer);
  await ui.settle();
  assert.equal(ui.text(link()), 'continue in the current chat');
  ui.click('cmp-ended-open');
  await ui.settle();
  assert.deepEqual(ui.R.rpcLog, [['team.open', { company: 'acme', id: 'legal' }]]);
  assert.deepEqual(T.opened, ['s7']);
  assert.deepEqual(ui.R.toasts, []);
});

test('team.open failing shows a toast and opens nothing', async (t) => {
  if (skip(t)) return;
  T.sessions = [ENDED];
  T.activeId = 's2';
  ui.R.rpcImpl = async () => { throw new Error('No position "legal" in Acme'); };
  ui.mount(mod.Composer);
  await ui.settle();
  ui.click('cmp-ended-open');
  await ui.settle();
  assert.deepEqual(T.opened, []);
  assert.equal(ui.R.toasts.length, 1);
  assert.equal(ui.R.toasts[0].title, 'Could not open the chat');
  assert.equal(ui.R.toasts[0].kind, 'error');
  assert.match(ui.R.toasts[0].error, /No position/);
  assert.equal(link().p.disabled, false, 'the button is usable again');
});

test('a normal session still renders the textarea and takes window inserts', async (t) => {
  if (skip(t)) return;
  T.sessions = [NORMAL];
  T.activeId = 'n1';
  ui.mount(mod.Composer);
  await ui.settle();
  assert.equal(textareas().length, 1);
  assert.equal(bar(), undefined);
  assert.equal(composerListeners(), 3);
  insert('hello');
  await ui.settle();
  assert.deepEqual(T.saves.at(-1), ['n1', 'hello']);
  assert.equal(textareas()[0].p.value, 'hello');
});

test('switching sessions: one composer across normal sessions, unmounted for an ended chat, back after', async (t) => {
  if (skip(t)) return;
  T.sessions = [NORMAL, NORMAL2, ENDED];
  T.activeId = 'n1';
  T.drafts.n2 = 'draft two';
  ui.mount(mod.Composer);
  await ui.settle();
  const mounted = added;
  T.activeId = 'n2';
  await ui.settle();
  assert.equal(added, mounted, 'no remount between two normal sessions (listeners added once)');
  assert.equal(textareas()[0].p.value, 'draft two');
  T.activeId = 's2';
  await ui.settle();
  assert.equal(textareas().length, 0);
  assert.equal(composerListeners(), 0, 'the live composer is gone, with its listeners');
  insert('nope');
  await ui.settle();
  assert.ok(!T.saves.some(([id]) => id === 's2'), 'nothing is written for the ended chat');
  T.activeId = 'n1';
  await ui.settle();
  assert.equal(textareas().length, 1);
  assert.equal(composerListeners(), 3);
});
