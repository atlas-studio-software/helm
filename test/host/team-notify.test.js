// Team notices (Positions, source "team"): teamNotice titles, normalizeNotice at both outputs, the phone push
// topic / tag / payload, and the desktop toast's switch gating + click routing (fake Electron, as notify.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createNotifier, teamNotice, normalizeNotice } = require('../../main/notify');
const { createPush, pushDecision } = require('../../main/push');

const LEGAL = { id: 'legal', name: 'Legal' };
const MONEY = { id: 'money', name: 'Money' };
const CO = { id: 'example-co', name: 'Example Co' };

test('teamNotice: owner-facing titles for each what', () => {
  const a = teamNotice({ what: 'access', position: LEGAL, company: CO, detail: 'Write C:/work/site/CHANGELOG.md', sessionId: 's9' });
  assert.equal(a.title, 'Legal needs your OK');
  assert.equal(a.body, 'Write C:/work/site/CHANGELOG.md \u00b7 Example Co');
  assert.equal(a.kind, 'waiting');
  assert.equal(a.source, 'team');
  assert.equal(a.sessionId, 's9');
  assert.deepEqual(a.team, { what: 'access', company: 'example-co', position: 'legal', companyName: 'Example Co', positionName: 'Legal', subject: null, action: null });

  const o = teamNotice({ what: 'outward', position: LEGAL, company: CO, detail: 'git push origin main' });
  assert.equal(o.title, 'Legal needs your OK');
  assert.equal(o.body, 'git push origin main \u00b7 Example Co');
  assert.equal('sessionId' in o, false, 'no sessionId key when none was given');

  const p = (action, title) => teamNotice({ what: 'proposal', action, title, position: LEGAL, company: CO, detail: 'Filing season is close.' });
  assert.equal(p(undefined, 'Tax Specialist').title, 'Legal proposes a new report: Tax Specialist');
  assert.equal(p('create', 'Tax Specialist').body, 'Filing season is close.');
  assert.equal(p('edit', 'Payroll').title, 'Legal proposes a change to Payroll');
  assert.equal(p('retire', 'Payroll').title, 'Legal proposes retiring Payroll');
  assert.equal(p('company', undefined).title, 'Legal proposes a change to Example Co');
  assert.equal(p('create', undefined).title, 'Legal proposes a new report');
  assert.equal(p('retire', '').title, 'Legal proposes retiring a report');

  const d = teamNotice({ what: 'duty', title: 'Monthly money check', position: MONEY, company: CO, detail: 'Spend is up 4%; two invoices are late.' });
  assert.equal(d.title, 'Money: Monthly money check is done');
  assert.equal(d.body, 'Spend is up 4%; two invoices are late.');
  assert.equal(teamNotice({ what: 'duty', position: MONEY, company: CO }).title, 'Money finished a duty');

  const f = teamNotice({ what: 'duty-failed', title: 'Monthly money check', position: MONEY, company: CO, detail: 'CLI exited 1' });
  assert.equal(f.title, "Money's duty failed: Monthly money check");
  assert.equal(f.body, 'CLI exited 1');
  assert.equal(teamNotice({ what: 'duty-failed', position: MONEY, company: CO }).title, "Money's duty failed");
  assert.equal(teamNotice({ what: 'something-new', position: MONEY, company: CO }).title, 'Money needs you');
});

test('teamNotice: missing names, junk input, multiline and long text', () => {
  assert.equal(teamNotice({ what: 'access' }).title, 'Your team needs your OK');
  assert.equal(teamNotice({ what: 'access' }).body, '');
  assert.equal(teamNotice({ what: 'access', company: CO }).body, 'Example Co');
  assert.equal(teamNotice({ what: 'duty', position: { id: 'x', name: '  \n ' } }).title, 'Your team finished a duty');
  for (const junk of [undefined, null, 'x', 42]) {
    const r = teamNotice(junk);
    assert.ok(r.title, 'never an empty title');
    assert.equal(r.kind, 'waiting');
    assert.equal(r.team.company, null);
  }
  const r = teamNotice({ what: 'duty', title: 'Weekly\nreview', position: { id: 'm', name: 'Mo\r\nney' }, company: CO, detail: 'line one\n\nline two\tend' });
  assert.equal(r.title, 'Mo ney: Weekly review is done');
  assert.equal(r.body, 'line one line two end');
  const long = teamNotice({ what: 'proposal', title: 'T'.repeat(300), position: { id: 'p', name: 'P'.repeat(300) }, company: CO, detail: 'w '.repeat(1000) });
  assert.ok(long.title.length <= 120, `title ${long.title.length}`);
  assert.ok(long.body.length <= 900, `body ${long.body.length}`);
  assert.ok(long.title.endsWith('\u2026'));
  assert.ok(!/[\r\n]/.test(long.title + long.body));
});

test('normalizeNotice: only source "team" changes; structured re-titles idempotently; plain keeps its title or falls back', () => {
  const plain = { title: 'Fix login', body: 'Done', kind: 'done', sessionId: 's1' };
  assert.equal(normalizeNotice(plain), plain, 'non-team notices pass through untouched');
  assert.equal(normalizeNotice(null), null);
  const built = teamNotice({ what: 'access', position: LEGAL, company: CO, detail: 'Read C:/work/notes.md', sessionId: 's2' });
  const again = normalizeNotice(built);
  assert.equal(again.title, built.title);
  assert.equal(again.body, built.body, 'the company is not appended twice');
  assert.equal(normalizeNotice(again).body, built.body);
  // structured, caller title "Session" -> re-titled from n.team
  assert.equal(normalizeNotice({ ...built, title: 'Session' }).title, 'Legal needs your OK');
  // n.team with ids only: the caller's title is kept, an empty one is built with fallbacks
  const idsOnly = { kind: 'waiting', source: 'team', title: 'Legal proposes a new report: Tax Specialist', body: 'why', team: { what: 'proposal', company: 'example-co', position: 'legal' } };
  assert.equal(normalizeNotice(idsOnly).title, idsOnly.title);
  assert.equal(normalizeNotice({ ...idsOnly, title: '' }).title, 'Your team proposes a new report');
  // plain team notices (no n.team)
  assert.equal(normalizeNotice({ kind: 'waiting', source: 'team', title: 'Session', body: 'x' }).title, 'Team needs you');
  assert.equal(normalizeNotice({ kind: 'waiting', source: 'team', title: '', body: 'x' }).title, 'Team needs you');
  assert.equal(normalizeNotice({ kind: 'waiting', source: 'team', body: 'x' }).title, 'Team needs you');
  assert.equal(normalizeNotice({ kind: 'waiting', source: 'team', title: 'Legal\nproposes X', body: 'a\nb' }).title, 'Legal proposes X');
  assert.equal(normalizeNotice({ kind: 'waiting', source: 'team', title: 'Legal\nproposes X', body: 'a\nb' }).body, 'a b');
});

function fakeWebPush() {
  const sent = [];
  return {
    sent,
    generateVAPIDKeys: () => ({ publicKey: 'BPub' + 'a'.repeat(83), privateKey: 'priv' + 'b'.repeat(39) }),
    async sendNotification(sub, body, opts) { sent.push({ endpoint: sub.endpoint, body: JSON.parse(body), opts }); return { statusCode: 201 }; },
  };
}
const SUB = { endpoint: 'https://push.example.invalid/send/abc', keys: { p256dh: 'BPk' + 'a'.repeat(84), auth: 'x'.repeat(22) } };

test('push: team notices are waiting pushes; per-company+what topic/tag without a session, per-session with one', async () => {
  const go = { subscribers: 1 };
  const duty = teamNotice({ what: 'duty', title: 'Monthly money check', position: MONEY, company: CO, detail: 'All good.' });
  assert.equal(pushDecision(duty, go).send, true);
  assert.match(pushDecision(duty, { ...go, prefs: { waiting: false } }).reason, /off in Settings/, 'the waiting switch gates team pushes');
  assert.match(pushDecision(duty, { ...go, windowFocused: true }).reason, /focused/);
  assert.equal(pushDecision({ kind: 'waiting', source: 'team', title: '' }, go).send, true, 'an empty team title falls back, it is not dropped');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-team-push-'));
  try {
    const wp = fakeWebPush();
    const push = createPush({ dir, webpush: wp });
    push.subscribe(SUB);
    assert.equal((await push.notify(duty)).sent, 1);
    const d1 = wp.sent[wp.sent.length - 1];
    assert.equal(d1.body.title, 'Money: Monthly money check is done');
    assert.equal(d1.body.kind, 'waiting');
    assert.equal(d1.body.sessionId, null);
    assert.equal(d1.body.view, 'team');
    assert.equal(d1.body.company, 'example-co');
    assert.equal(d1.body.tag, 'helm-team-example-co-duty');
    assert.match(d1.opts.topic, /^[A-Za-z0-9_-]{1,32}$/);
    assert.equal(d1.opts.urgency, 'high');

    // a second duty push in the same company replaces the first (same tag + topic); a failed run is its own slot
    await push.notify(teamNotice({ what: 'duty', title: 'Weekly review', position: LEGAL, company: CO }));
    const d2 = wp.sent[wp.sent.length - 1];
    assert.equal(d2.body.tag, d1.body.tag);
    assert.equal(d2.opts.topic, d1.opts.topic);
    await push.notify(teamNotice({ what: 'duty-failed', title: 'Weekly review', position: LEGAL, company: CO }));
    const f = wp.sent[wp.sent.length - 1];
    assert.equal(f.body.tag, 'helm-team-example-co-duty-failed');
    assert.notEqual(f.opts.topic, d1.opts.topic);
    await push.notify(teamNotice({ what: 'duty', title: 'Weekly review', position: LEGAL, company: { id: 'other co!', name: 'Other' } }));
    assert.equal(wp.sent[wp.sent.length - 1].body.tag, 'helm-team-other-co--duty', 'ids are made tag-safe');
    assert.notEqual(wp.sent[wp.sent.length - 1].opts.topic, d1.opts.topic);

    // with a session: today's per-session tag + topic
    await push.notify(teamNotice({ what: 'access', position: LEGAL, company: CO, detail: 'Write C:/work/a.md', sessionId: 's7' }));
    const a = wp.sent[wp.sent.length - 1];
    assert.equal(a.body.tag, 'helm-s7');
    assert.equal(a.body.sessionId, 's7');
    assert.equal(a.body.title, 'Legal needs your OK');
    await push.notify({ title: 'Other turn', body: 'x', sessionId: 's7', kind: 'waiting' });
    assert.equal(wp.sent[wp.sent.length - 1].opts.topic, a.opts.topic, 'same per-session topic as a plain waiting push');

    // a plain team notice (no n.team) titled "Session": pushed as "Team needs you", tag per company "any"
    await push.notify({ kind: 'waiting', source: 'team', title: 'Session', body: 'Something' });
    const pl = wp.sent[wp.sent.length - 1];
    assert.equal(pl.body.title, 'Team needs you');
    assert.equal(pl.body.tag, 'helm-team-any-waiting');
    assert.equal(pl.body.company, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function fakeElectron() {
  const shown = [];
  class Notification extends EventEmitter {
    constructor(o) { super(); this.o = o; }
    static isSupported() { return true; }
    show() { shown.push(this); }
  }
  const img = { isEmpty: () => false, resize: () => img };
  class Tray extends EventEmitter { setToolTip() {} setContextMenu() {} destroy() {} }
  return { shown, electron: { Notification, Tray, Menu: { buildFromTemplate: (t) => t }, nativeImage: { createFromBitmap: () => img, createFromPath: () => img } } };
}
function setup(prefs = { waiting: true, done: true, error: true }) {
  const { electron, shown } = fakeElectron();
  const win = { focused: false, isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused() { return this.focused; }, setOverlayIcon() {}, flashFrame() {} };
  const broadcasts = []; let shows = 0;
  const n = createNotifier({
    electron, getWindow: () => win, showWindow: () => { shows++; }, broadcast: (e, d) => broadcasts.push([e, d]),
    getSettings: () => ({ notifications: prefs }), iconDir: path.join(os.tmpdir(), 'helm-no-icons-here'), onQuit: () => {}, enableTray: false,
  });
  return { n, win, shown, broadcasts, shows: () => shows };
}

test('desktop: team toasts use the built title, obey notifications.waiting, and stay quiet while focused', () => {
  const t = setup();
  t.n.notify(teamNotice({ what: 'proposal', title: 'Tax Specialist', position: LEGAL, company: CO, detail: 'Filing\nseason.' }));
  assert.equal(t.shown.length, 1);
  assert.equal(t.shown[0].o.title, 'Legal proposes a new report: Tax Specialist');
  assert.equal(t.shown[0].o.body, 'Filing season.');
  assert.equal(t.shown[0].o.silent, false);
  t.n.notify({ kind: 'waiting', source: 'team', title: 'Session', body: 'x' });
  assert.equal(t.shown[1].o.title, 'Team needs you', 'an empty / "Session" team title is not dropped');
  t.win.focused = true;
  t.n.notify(teamNotice({ what: 'duty', position: MONEY, company: CO }));
  assert.equal(t.shown.length, 2, 'no native toast while focused');

  const off = setup({ waiting: false, done: true, error: true });
  off.n.notify(teamNotice({ what: 'duty', position: MONEY, company: CO }));
  off.n.onEngineEvent('notify', teamNotice({ what: 'access', position: LEGAL, company: CO, sessionId: 's1' }));
  assert.equal(off.shown.length, 0, 'notifications.waiting=false silences team toasts');
});

test('desktop click: a team notice without a session opens the Team view on its company; with one, the session', () => {
  const t = setup();
  t.n.notify(teamNotice({ what: 'duty-failed', title: 'Monthly money check', position: MONEY, company: CO }));
  t.shown[0].emit('click');
  assert.equal(t.shows(), 1);
  assert.deepEqual(t.broadcasts.pop(), ['app.select', { view: 'team', company: 'example-co' }]);

  t.n.handleClick({ kind: 'waiting', source: 'team', title: 'Team needs you' });
  assert.equal(t.shows(), 2);
  assert.deepEqual(t.broadcasts.pop(), ['app.select', { view: 'team', company: null }]);

  t.n.notify(teamNotice({ what: 'access', position: LEGAL, company: CO, sessionId: 's5' }));
  t.shown[1].emit('click');
  assert.deepEqual(t.broadcasts.pop(), ['app.select', { sessionId: 's5' }]);

  t.n.handleClick({ title: 'Plain', kind: 'info' });
  assert.equal(t.broadcasts.length, 0, 'a plain sessionless notice only shows the window');
  assert.equal(t.shows(), 4);
});
