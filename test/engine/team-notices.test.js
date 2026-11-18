// Positions: the team notice shape (main/engine/team/notice.js teamEvent, built with main/notify.js teamNotice) and
// the session's request card notice (main/engine/session.js openRequest): one notice per card, a built title, the
// company id, and view 'team' only when there is no chat to open.
const test = require('node:test');
const assert = require('node:assert/strict');
const { teamEvent } = require('../../main/engine/team/notice');
const { normalizeNotice } = require('../../main/notify');
const { EngineSession } = require('../../main/engine/session');

test('teamEvent: built title, company id, view only without a session; stable under normalizeNotice', () => {
  const a = teamEvent({ what: 'duty-failed', subject: 'Rent check', detail: 'exit 1', company: { id: 'acme', name: 'Acme' }, position: { id: 'fin', name: 'Finance' } });
  assert.equal(a.title, "Finance's duty failed: Rent check");
  assert.equal(a.body, 'exit 1');
  assert.equal(a.company, 'acme');
  assert.equal(a.view, 'team');
  assert.equal(a.sessionId, undefined);
  assert.deepEqual(normalizeNotice(a), a);
  const b = teamEvent({ what: 'access', detail: 'Read C:/x', sessionId: 's9', company: { id: 'acme', name: 'Acme' }, position: { id: 'fin', name: 'Finance' } });
  assert.equal(b.title, 'Finance needs your OK');
  assert.equal(b.sessionId, 's9');
  assert.equal(b.view, undefined);
  assert.equal(b.body, 'Read C:/x · Acme');
});

// openRequest on a minimal stand-in for an EngineSession (only what the method touches)
function fakeSession(position) {
  const sent = [];
  const es = Object.create(EngineSession.prototype);
  let n = 0;
  Object.assign(es, {
    s: { id: 's1', title: 'Legal chat', status: 'idle', position },
    requests: new Map(),
    norm: { store: { add() {}, patch() {} } },
    nextId: () => `i${++n}`,
    _refreshActivity() {}, touch() {}, _afterRequest() {},
    engine: { notify: (x) => sent.push(x) },
  });
  return { es, sent };
}

test('session openRequest: sends the caller\'s notice once, else builds one from the position', () => {
  const given = teamEvent({ what: 'outward', detail: 'npm publish', sessionId: 's1', company: { id: 'acme', name: 'Acme' }, position: { id: 'legal', name: 'Legal' } });
  const one = fakeSession({ company: 'acme', companyName: 'Acme', id: 'legal', name: 'Legal' });
  one.es.openRequest({ title: 'Legal asks to run an outward action', body: 'npm publish', access: { outward: true }, waitMs: 60_000, notice: given });
  assert.equal(one.sent.length, 1);
  assert.equal(one.sent[0], given);

  const two = fakeSession({ company: 'acme', companyName: 'Acme', id: 'legal', name: 'Legal' });
  two.es.openRequest({ title: 'Legal asks for the WebSearch tool', body: 'WebSearch', access: { kind: 'tool' }, waitMs: 60_000 });
  assert.equal(two.sent.length, 1);
  const n = two.sent[0];
  assert.equal(n.title, 'Legal needs your OK', 'never the bare session or position title');
  assert.equal(n.team.what, 'access');
  assert.equal(n.company, 'acme');
  assert.equal(n.sessionId, 's1');
  assert.equal(n.view, undefined);
  for (const es of [one.es, two.es]) for (const [id] of es.requests) es.closeRequest(id, 'done');
});
