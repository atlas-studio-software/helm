// A phone push for a team notice (Positions: no session, { view: 'team', company }) opens the Team view on that
// company when tapped, not the bare page. ui/sw.js runs here in a vm with a fake service-worker `self`; ui/shell/phone.js
// is checked by source (it is a browser module with side effects) for the routing through ./select-route.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const UI = path.join(__dirname, '..', '..', 'ui');
const SW = fs.readFileSync(path.join(UI, 'sw.js'), 'utf8');

function loadSw({ windows = [] } = {}) {
  const handlers = {};
  const shown = [];
  const opened = [];
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve(), matchAll: async () => windows, openWindow: async (u) => { opened.push(u); } },
    registration: { showNotification: async (title, opts) => { shown.push({ title, ...opts }); } },
  };
  vm.runInNewContext(SW, { self, Response: function Response() {}, fetch: () => Promise.reject(new Error('no net')), URL, console });
  // run one event through its handler, wait for its waitUntil
  const fire = async (type, ev) => {
    let p = Promise.resolve();
    handlers[type]({ ...ev, waitUntil: (x) => { p = x; } });
    await p;
  };
  return { fire, shown, opened };
}
const pushEvent = (obj) => ({ data: { json: () => obj, text: () => JSON.stringify(obj) } });
const clickEvent = (data) => ({ notification: { data, close() {} } });
function fakeWindow() {
  const posted = [];
  return { posted, visibilityState: 'visible', focused: false, focus: async () => {}, postMessage: (m) => posted.push(m) };
}

test('push: a team notice keeps view + company in the notification data', async () => {
  const sw = loadSw();
  await sw.fire('push', pushEvent({ title: 'Duty done', body: 'x', sessionId: null, view: 'team', company: 'example-co', tag: 'helm-team-x' }));
  assert.equal(sw.shown.length, 1);
  assert.deepEqual({ ...sw.shown[0].data }, { sessionId: null, view: 'team', company: 'example-co' });
});

test('push: a session push carries no team view; an unknown view is dropped', async () => {
  const sw = loadSw();
  await sw.fire('push', pushEvent({ title: 't', sessionId: 's1' }));
  await sw.fire('push', pushEvent({ title: 't', view: 'admin', company: 7 }));
  assert.deepEqual({ ...sw.shown[0].data }, { sessionId: 's1', view: null, company: null });
  assert.deepEqual({ ...sw.shown[1].data }, { sessionId: null, view: null, company: null });
});

test('click with Helm closed: a team notice opens /?view=team&company=<id>', async () => {
  const sw = loadSw();
  await sw.fire('notificationclick', clickEvent({ sessionId: null, view: 'team', company: 'a b&c' }));
  assert.deepEqual(sw.opened, ['/?view=team&company=a%20b%26c']);
  const sw2 = loadSw();
  await sw2.fire('notificationclick', clickEvent({ sessionId: null, view: 'team', company: null }));
  assert.deepEqual(sw2.opened, ['/?view=team']);
});

test('click with Helm closed: a session push still opens /?session=<id>, a plain one /', async () => {
  const sw = loadSw();
  await sw.fire('notificationclick', clickEvent({ sessionId: 's 1', view: null, company: null }));
  await sw.fire('notificationclick', clickEvent({ sessionId: null, view: null, company: null }));
  await sw.fire('notificationclick', clickEvent(undefined));   // a notification shown by an older sw (no data)
  assert.deepEqual(sw.opened, ['/?session=s%201', '/', '/']);
});

test('click with Helm open: helm.select carries the view + company, or the session', async () => {
  const w = fakeWindow();
  const sw = loadSw({ windows: [w] });
  await sw.fire('notificationclick', clickEvent({ sessionId: null, view: 'team', company: 'example-co' }));
  await sw.fire('notificationclick', clickEvent({ sessionId: 's1', view: 'team', company: 'example-co' }));   // a session wins
  await sw.fire('notificationclick', clickEvent({ sessionId: null, view: null, company: null }));
  assert.deepEqual(w.posted.map((m) => ({ ...m })), [
    { type: 'helm.select', view: 'team', company: 'example-co' },
    { type: 'helm.select', sessionId: 's1' },
  ]);
  assert.equal(sw.opened.length, 0);
});

test('phone.js: helm.select and the ?session / ?view=team deep link go through routeSelect', () => {
  const src = fs.readFileSync(path.join(UI, 'shell', 'phone.js'), 'utf8');
  assert.match(src, /import \{ routeSelect \} from '\.\/select-route\.js';/);
  assert.match(src, /e\.data\.type === 'helm\.select'\) selectFromPush\(e\.data\)/, 'a message with no sessionId is routed too');
  assert.match(src, /return routeSelect\(msg, \{\s*\n\s*go, openSession,/);
  assert.match(src, /setCompany: \(cid\) => import\('\.\.\/positions\/state\.js'\)\.then\(\(m\) => m\.setCompany\(cid\)\)/);
  assert.match(src, /params\.get\('view'\) === 'team'/);
  assert.match(src, /\{ view: 'team', company: params\.get\('company'\) \|\| null \}/);
  assert.doesNotMatch(src, /openWhenKnown/, 'the old session-only path is gone');
});
