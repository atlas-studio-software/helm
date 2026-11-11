// Look Sync (lane look-sync): settings keys + migration, main/look.js against a real shared folder driven by
// ~/look-sync/fake-writer.js (LOOK_SYNC_DIR-style temp dirs only; never %APPDATA%\look-sync), the switch,
// the status states, the desktop record and the /bg/desktop route.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { createSettings } = require('../../main/settings');
const { createLook } = require('../../main/look');
const { startServer } = require('../../main/server');

const UI_BG = path.join(__dirname, '..', '..', 'ui', 'assets', 'backgrounds');
const FAKE_WRITER = path.join(os.homedir(), 'look-sync', 'fake-writer.js');
const HAS_WRITER = fs.existsSync(FAKE_WRITER);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const made = [];
const tmp = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `helm-look-${name}-`)); made.push(d); return d; };
after(() => { for (const d of made) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

function writer(dir, ...args) {
  return execFileSync(process.execPath, [FAKE_WRITER, '--dir', dir, ...args], { encoding: 'utf8', timeout: 15000 });
}
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(20); }
  return fn();
}
function readLook(dir) { return JSON.parse(fs.readFileSync(path.join(dir, 'look.json'), 'utf8')); }

function makeSettings(prior, extra = {}) {
  const userDataDir = tmp('ud');
  if (prior) fs.writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify(prior));
  const events = [];
  let look = null;
  const settings = createSettings({
    userDataDir, uiBgDir: UI_BG, appDataDir: path.join(userDataDir, 'no-appdata'),
    emit: (e, d) => events.push([e, d]),
    onLocalChange: (b, a) => look && look.onLocalChange(b, a),
    ...extra,
  });
  return { settings, events, userDataDir, setLook: (l) => { look = l; } };
}
function makeLook(ctx, dir, opts = {}) {
  const events = [];
  const look = createLook({
    settings: ctx.settings, dir, windowsWallpaper: opts.windowsWallpaper ?? null,
    emit: (e, d) => { events.push([e, d]); ctx.events.push([e, d]); },
    syncOpts: { debounceMs: 30, corruptRetryMs: 30, ...(opts.syncOpts || {}) },
  });
  ctx.setLook(look);
  return { look, events };
}

// ---------------------------------------------------------------- store keys
test('migration: the user\'s live settings land on desktop mode with glass dark {5, .50, 0}', () => {
  const { settings } = makeSettings({ background: { kind: 'image', file: 'snow-peak.jpg', blur: 5, dim: 0.5 }, theme: 'dark' });
  const s = settings.get();
  assert.equal(s.background.mode, 'desktop');
  assert.equal(s.background.file, 'snow-peak.jpg', 'the picked photo stays as the own picture');
  assert.deepEqual(s.glass.dark, { blurPx: 5, dim: 0.5, panel: 0 });
  assert.deepEqual(s.glass.light, { blurPx: 5, dim: 0.5, panel: 0 }, 'light keeps Helm\'s own (single) blur/dim');
  assert.equal(s.glass.render, 'picture');
  assert.equal(s.accentHue, null);
  assert.equal(s.accentTokens, null);
  assert.deepEqual(s.lookSync, { enabled: true });
  assert.equal(s.theme, 'dark');
  // persisted: a restart reads the migrated values back, not the defaults
  const again = createSettings({ userDataDir: path.dirname(settings.file), uiBgDir: UI_BG, appDataDir: 'x' }).get();
  assert.deepEqual(again.glass, s.glass);
});

test('migration clamps old values into the shared ranges', () => {
  const { settings } = makeSettings({ background: { file: 'forest.jpg', blur: 120, dim: 0.05 } });
  assert.deepEqual(settings.get().glass.dark, { blurPx: 64, dim: 0.2, panel: 0 });
  const { settings: s2 } = makeSettings({ background: { file: 'forest.jpg', blur: 28, dim: 0.45 } });
  assert.deepEqual(s2.get().glass.dark, { blurPx: 28, dim: 0.45, panel: 0 });
});

test('a fresh install starts on the shared seed', () => {
  const { settings } = makeSettings(null);
  const s = settings.get();
  // look-sync 98bf878 (CONTRACT "2026-11-11: sharp painted glass + tint override"): blur 0, dim .30, both themes
  assert.deepEqual(s.glass, { dark: { blurPx: 0, dim: 0.3, panel: 0 }, light: { blurPx: 0, dim: 0.3, panel: 0 }, render: 'picture' });
  assert.equal(s.background.mode, 'desktop');
});

test('a hand-damaged glass falls back per value', () => {
  const { settings } = makeSettings({ glass: { dark: { blurPx: 999, dim: 0.6, panel: 'x' }, render: 'laser' }, accentHue: 7.5, lookSync: 'yes', background: { mode: 'sideways' } });
  const s = settings.get();
  assert.deepEqual(s.glass.dark, { blurPx: 0, dim: 0.6, panel: 0 });
  assert.deepEqual(s.glass.light, { blurPx: 0, dim: 0.3, panel: 0 });
  assert.equal(s.glass.render, 'picture');
  assert.equal(s.accentHue, null);
  assert.deepEqual(s.lookSync, { enabled: true });
  assert.equal(s.background.mode, 'desktop');
});

test('settings.set: glass merges per theme, validates ranges; accent tokens derive from the hue', () => {
  const { settings } = makeSettings({ background: { file: 'snow-peak.jpg', blur: 5, dim: 0.5 } });
  settings.set({ glass: { dark: { dim: 0.6 } } });
  assert.deepEqual(settings.get().glass.dark, { blurPx: 5, dim: 0.6, panel: 0 });
  assert.deepEqual(settings.get().glass.light, { blurPx: 5, dim: 0.5, panel: 0 });
  assert.equal(settings.get().background.dim, 0.6, 'legacy mirror follows glass.dark');
  for (const bad of [{ glass: { dark: { dim: 0.95 } } }, { glass: { dark: { blurPx: -1 } } }, { glass: { light: { panel: 0.2 } } },
    { glass: { dark: { wobble: 1 } } }, { glass: { render: 'x' } }, { glass: 5 }, { accentHue: 361 }, { accentHue: 1.5 }, { accentHue: '200' },
    { lookSync: true }, { lookSync: { enabled: 'on' } }, { background: { mode: 'both' } }]) {
    assert.throws(() => settings.set(bad), /must|unknown/, JSON.stringify(bad));
  }
  settings.set({ accentHue: 212 });
  const t = settings.get().accentTokens;
  assert.equal(t.dark.acc, '#9fb4cc', 'hue 212 reproduces the steel blue');
  assert.ok(t.light.acc.startsWith('#'));
  settings.set({ accentTokens: { dark: { acc: '#ff0000' } } });   // derived: ignored
  assert.equal(settings.get().accentTokens.dark.acc, '#9fb4cc');
  settings.set({ accentHue: null });
  assert.equal(settings.get().accentTokens, null);
  settings.set({ background: { mode: 'own' } });
  assert.equal(settings.get().background.mode, 'own');
  assert.equal(settings.get().background.file, 'snow-peak.jpg');
});

test('legacy background.blur/dim from an older client lands in glass.dark (the legacy mirror); echoes are ignored', () => {
  const { settings } = makeSettings({ background: { file: 'snow-peak.jpg', blur: 5, dim: 0.5 }, theme: 'light' });
  settings.set({ background: { ...settings.get().background, file: 'forest.jpg' } });   // echo of the mirror values
  assert.deepEqual(settings.get().glass.light, { blurPx: 5, dim: 0.5, panel: 0 });
  settings.set({ background: { blur: 20 } });
  assert.equal(settings.get().glass.dark.blurPx, 20);
  assert.equal(settings.get().glass.light.blurPx, 5, 'a legacy blur never writes the light glass (only the light sliders do)');
});

// ---------------------------------------------------------------- the adapter (real folder)
test('first start with no shared file seeds it (Match Windows); Helm adopts the seed', { skip: !HAS_WRITER && 'no ~/look-sync' }, async () => {
  const dir = tmp('seed');
  const ctx = makeSettings({ background: { file: 'snow-peak.jpg', blur: 5, dim: 0.5 }, theme: 'dark' });
  const { look } = makeLook(ctx, dir);
  look.start();
  await until(() => look.state().sync.state === 'ok');
  const doc = readLook(dir);
  assert.equal(doc.writer.app, 'helm');
  assert.deepEqual(doc.look.glass.v.dark, { blurPx: 0, dim: 0.3, panel: 0 }, 'the seed (look-sync 98bf878)');
  assert.equal(doc.look.theme.v, 'system', 'the first seed is Match Windows (look-sync 0b55b9c)');
  assert.equal(ctx.settings.get().theme, 'system', 'Helm adopts the seed so all three start on the same look');
  // look-sync 98bf878: the seed glass (blur 0 / dim .30) is adopted like the theme; a shared entry is the whole value,
  // so its absent dimAuto lands as true (automatic). Before, Helm's 5 / .50 happened to equal the old seed.
  assert.deepEqual(ctx.settings.get().glass.dark, { blurPx: 0, dim: 0.3, panel: 0, dimAuto: true }, 'dark glass = the seed');
  assert.match(look.state().sync.reason || '', /started/i);
  look.close();
});

test('a remote change (fake writer as Quartz) is applied within 1 s and broadcast as settings.updated', { skip: !HAS_WRITER && 'no ~/look-sync' }, async () => {
  const dir = tmp('remote');
  const ctx = makeSettings({ background: { file: 'snow-peak.jpg', blur: 5, dim: 0.5 } });
  const { look } = makeLook(ctx, dir);
  look.start();
  await until(() => look.state().sync.state === 'ok');
  const before = ctx.events.length;
  const t0 = Date.now();
  writer(dir, 'set', 'glass.dark.dim', '0.62');
  const ok = await until(() => ctx.settings.get().glass.dark.dim === 0.62, 1000);
  const ms = Date.now() - t0;
  assert.ok(ok, `glass.dark.dim not applied within 1 s (took ${ms} ms)`);
  assert.ok(ctx.events.slice(before).some(([e, d]) => e === 'settings.updated' && d.glass.dark.dim === 0.62));
  writer(dir, 'set', 'theme', 'light');
  writer(dir, 'set', 'accent', '30');
  assert.ok(await until(() => ctx.settings.get().theme === 'light' && ctx.settings.get().accentHue === 30, 1000), 'theme + accent within 1 s');
  assert.ok(ctx.settings.get().accentTokens.light.acc);
  // applying a remote value never publishes it back (loop guard 4)
  const doc = readLook(dir);
  assert.equal(doc.writer.app, 'quartz');
  const st = look.state().sync;
  assert.equal(st.state, 'ok'); assert.equal(st.by, 'quartz'); assert.equal(st.rev, doc.rev);
  look.close();
});

test('a local change publishes only the changed field', { skip: !HAS_WRITER && 'no ~/look-sync' }, async () => {
  const dir = tmp('pub');
  const ctx = makeSettings({ background: { file: 'snow-peak.jpg', blur: 5, dim: 0.5 } });
  const { look } = makeLook(ctx, dir);
  look.start();
  await until(() => look.state().sync.state === 'ok');
  const rev0 = readLook(dir).rev;
  ctx.settings.set({ glass: { dark: { panel: -0.1 } } });
  assert.ok(await until(() => { try { return readLook(dir).look.glass.v.dark.panel === -0.1; } catch { return false; } }, 1000), 'glass published');
  const doc = readLook(dir);
  assert.equal(doc.writer.app, 'helm');
  assert.equal(doc.rev, rev0 + 1);
  assert.equal(doc.look.glass.rev, doc.rev);
  assert.ok(doc.look.theme.rev < doc.rev, 'theme untouched');
  ctx.settings.set({ accentHue: 140 });
  assert.ok(await until(() => readLook(dir).look.accent.v.hue === 140, 1000), 'accent published');
  ctx.settings.set({ background: { mode: 'own' } });   // per app: never shared
  await sleep(150);
  assert.equal(JSON.stringify(readLook(dir)).includes('"mode"'), false);
  look.close();
});

test('the switch: OFF stops reading and writing; ON adopts the shared values', { skip: !HAS_WRITER && 'no ~/look-sync' }, async () => {
  const dir = tmp('switch');
  const ctx = makeSettings({ background: { file: 'snow-peak.jpg', blur: 5, dim: 0.5 } });
  const { look } = makeLook(ctx, dir);
  look.start();
  await until(() => look.state().sync.state === 'ok');
  ctx.settings.set({ lookSync: { enabled: false } });
  assert.ok(await until(() => look.state().sync.state === 'off'), 'status off');
  assert.equal(look.state().sync.enabled, false);
  const revOff = readLook(dir).rev;
  ctx.settings.set({ glass: { dark: { dim: 0.7 } } });
  await sleep(200);
  assert.equal(readLook(dir).rev, revOff, 'OFF: a local change is not published');
  writer(dir, 'set', 'glass.dark.dim', '0.3');
  await sleep(400);
  assert.equal(ctx.settings.get().glass.dark.dim, 0.7, 'OFF: a remote change is not applied');
  ctx.settings.set({ lookSync: { enabled: true } });
  assert.ok(await until(() => ctx.settings.get().glass.dark.dim === 0.3), 'ON: shared value adopted');
  const st = await until(() => (look.state().sync.state === 'ok' && /matching/i.test(look.state().sync.reason || '') ? look.state().sync : null));
  assert.ok(st, 'status says it matches the others again: ' + JSON.stringify(look.state().sync));
  look.close();
});

test('status states: corrupt, newer schema, removed', { skip: !HAS_WRITER && 'no ~/look-sync' }, async () => {
  const dir = tmp('states');
  const ctx = makeSettings({ background: { file: 'snow-peak.jpg', blur: 5, dim: 0.5 } });
  const { look } = makeLook(ctx, dir);
  look.start();
  await until(() => look.state().sync.state === 'ok');
  writer(dir, 'corrupt');
  // look-sync 8b9e452: the damage is said once, then the TRUE state of the recovered file: ok, with the reason
  const c = await until(() => { const s = look.state().sync; return s.state === 'ok' && s.recovered === 'corrupt' ? s : null; });
  assert.ok(c, 'recovered from the damaged file, state ok with the reason: ' + JSON.stringify(look.state().sync));
  assert.match(c.reason, /damaged/i);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('look.json.bad-')), 'damaged copy kept');
  writer(dir, 'newer');
  const n = await until(() => (look.state().sync.state === 'newer' ? look.state().sync : null));
  assert.ok(n, 'newer state: ' + JSON.stringify(look.state().sync));
  assert.match(n.reason, /newer/i);
  fs.rmSync(path.join(dir, 'look.json'));
  look.refresh();
  const m = await until(() => (look.state().sync.state === 'missing' ? look.state().sync : null));
  assert.ok(m, 'missing state: ' + JSON.stringify(look.state().sync));
  assert.match(m.reason, /removed/i);
  look.close();
});

// ---------------------------------------------------------------- desktop record + /bg/desktop
test('desktop follow: Mantle\'s still is served at /bg/desktop; fallbacks are announced', { skip: !HAS_WRITER && 'no ~/look-sync' }, async () => {
  const dir = tmp('desk');
  const stills = path.join(dir, 'stills');
  fs.mkdirSync(stills, { recursive: true });
  const still = path.join(stills, 'wall-1.jpg');
  fs.copyFileSync(path.join(UI_BG, 'snow-peak.jpg'), still);
  const winWall = path.join(tmp('win'), 'TranscodedWallpaper');
  fs.copyFileSync(path.join(UI_BG, 'forest.jpg'), winWall);
  const ctx = makeSettings({ background: { file: 'snow-peak.jpg', blur: 5, dim: 0.5 } });
  const { look, events } = makeLook(ctx, dir, { windowsWallpaper: winWall });
  look.start();
  await until(() => look.state().sync.state === 'ok');
  // no record yet: Windows' wallpaper, with the reason
  let d = look.state().desktop;
  assert.equal(d.source, 'windows');
  assert.match(d.reason, /Following Windows' wallpaper/);
  assert.equal(look.desktopFile().file, winWall);
  assert.equal(look.desktopFile().type, 'image/jpeg');

  const TOKEN = 'b'.repeat(64);
  const srv = await startServer({ uiDir: path.join(__dirname, '..', '..', 'ui'), token: TOKEN, port: 0, bgDesktop: () => look.desktopFile(), onRpc: async () => ({}) });
  const get = (p) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: srv.port, path: p }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
  }).on('error', reject));
  try {
    assert.equal((await get('/bg/desktop')).status, 401, 'needs the token like every route');
    let r = await get('/bg/desktop?v=1&token=' + TOKEN);
    assert.equal(r.status, 200); assert.equal(r.type, 'image/jpeg');
    assert.ok(r.body.equals(fs.readFileSync(winWall)));

    writer(dir, '--app', 'mantle', 'desktop', 'builtin:snow-peak', path.join(UI_BG, 'snow-peak.jpg'), still);
    d = await until(() => (look.state().desktop.source === 'mantle' ? look.state().desktop : null), 1000);
    assert.ok(d, 'followed the desktop record within 1 s: ' + JSON.stringify(look.state().desktop));
    assert.equal(d.ok, true); assert.equal(d.reason, null);
    assert.match(d.url, /^\/bg\/desktop\?v=m\d+$/);
    assert.ok(events.some(([e, x]) => e === 'look.updated' && x.desktop.source === 'mantle'), 'look.updated broadcast');
    r = await get('/bg/desktop?token=' + TOKEN);
    assert.equal(r.status, 200);
    assert.ok(r.body.equals(fs.readFileSync(still)), 'serves the still');

    // a record pointing outside the stills folder is not served from there
    const outside = path.join(tmp('evil'), 'wall-9.jpg');
    fs.copyFileSync(path.join(UI_BG, 'lake.jpg'), outside);
    writer(dir, '--app', 'mantle', 'desktop', 'builtin:lake', 'C:\\nope\\missing.jpg', outside);
    d = await until(() => (look.state().desktop.source === 'windows' ? look.state().desktop : null), 1000);
    assert.ok(d, 'fell back: ' + JSON.stringify(look.state().desktop));
    assert.match(d.reason, /outside its stills folder/);
    assert.notEqual(look.desktopFile().file, outside);

    // nothing readable at all
    fs.rmSync(winWall);
    writer(dir, '--app', 'mantle', 'desktop', 'builtin:x', 'C:\\nope\\a.jpg', path.join(stills, 'wall-404.jpg'));
    d = await until(() => (look.state().desktop.source === 'none' ? look.state().desktop : null), 1000);
    assert.ok(d, 'none: ' + JSON.stringify(look.state().desktop));
    assert.equal(d.url, null);
    assert.match(d.reason, /can't be read/);
    assert.equal((await get('/bg/desktop?token=' + TOKEN)).status, 404);
  } finally { await srv.close(); look.close(); }
});

test('the desktop record flows with sync OFF (a fact about the screen)', { skip: !HAS_WRITER && 'no ~/look-sync' }, async () => {
  const dir = tmp('deskoff');
  const stills = path.join(dir, 'stills');
  fs.mkdirSync(stills, { recursive: true });
  const still = path.join(stills, 'wall-3.jpg');
  fs.copyFileSync(path.join(UI_BG, 'snow-peak.jpg'), still);
  const ctx = makeSettings({ background: { file: 'snow-peak.jpg', blur: 5, dim: 0.5 }, lookSync: { enabled: false } });
  const { look } = makeLook(ctx, dir);
  look.start();
  writer(dir, '--app', 'mantle', 'desktop', 'builtin:snow-peak', '', still);
  assert.ok(await until(() => look.state().desktop.source === 'mantle', 1500), JSON.stringify(look.state()));
  assert.equal(look.state().sync.state, 'off');
  look.close();
});

test('"Change it in Mantle": off when Mantle is missing, launches exactly the command, reports Mantle refusing', async () => {
  const dir = tmp('mopen');
  const ctx = makeSettings({ background: { file: 'snow-peak.jpg', blur: 5, dim: 0.5 } });
  const off = createLook({ settings: ctx.settings, dir, windowsWallpaper: null, mantleOpen: null });
  assert.equal(off.state().mantleOpen.available, false);
  assert.match(off.state().mantleOpen.reason, /Mantle/);
  await assert.rejects(off.methods['look.openMantle'](), (e) => e.code === 'unsupported');
  const ran = [];
  const on = createLook({ settings: ctx.settings, dir, windowsWallpaper: null, mantleOpen: { exe: 'C:/fake/Mantle.exe', args: ['--wallpapers'] }, launch: (exe, args) => ran.push([exe, args]) });
  assert.deepEqual(on.state().mantleOpen, { available: true, reason: null });
  assert.deepEqual(await on.methods['look.openMantle'](), { ok: true });
  assert.deepEqual(ran, [['C:/fake/Mantle.exe', ['--wallpapers']]]);
  // Mantle answers with a non-zero exit: the reason reaches the caller (no silent failure)
  const down = createLook({ settings: ctx.settings, dir, windowsWallpaper: null, mantleOpen: { exe: 'C:/fake/Mantle.exe', args: [] }, launch: async () => ({ ok: false, reason: 'Mantle is not running, so its Wallpapers could not be opened' }) });
  await assert.rejects(down.methods['look.openMantle'](), (e) => e.code === 'mantle' && /not running/.test(e.message));
});

// ---------------------------------------------------------------- shared top-band darkening (desktop.guard)
// look-sync CONTRACT "Shared top-band darkening (desktop.guard)": Mantle publishes one dark alpha; Helm's dark wash
// uses it in 'desktop' mode. main/look.js validates it (checkGuard), ui/lib/wash.js picks the painted --bg-dim.
const { checkGuard } = require('../../main/look');
const { washFor } = require('../../ui/lib/wash.js');
const LS = require('../../main/look-sync');
const GLASS = { blurPx: 5, dim: 0.5, panel: 0 };
const rec = (dark, extra = {}) => ({ rev: 3, ok: true, still: 'x', guard: dark === undefined ? undefined : { dark }, ...extra });
const GUARD = { alpha: 0.52, contrast: 4.21, dim: 0.5, blurPx: 5, region: { topDip: 0, heightDip: 144 }, monitor: [1536, 864] };
const ON = { syncOn: true, source: 'mantle' };

test('checkGuard: a valid, fresh guard is used; everything else falls back with a reason', () => {
  assert.deepEqual(checkGuard(rec(GUARD), GLASS, ON), { guard: { alpha: 0.52, dim: 0.5, blurPx: 5 }, guardReason: null });
  assert.equal(checkGuard(rec({ ...GUARD, alpha: 0.88 }), GLASS, ON).guard.alpha, 0.88, 'the ceiling is valid');
  const why = (r, g = GLASS, o = ON) => { const x = checkGuard(r, g, o); assert.equal(x.guard, null); return x.guardReason; };
  assert.match(why(rec({ ...GUARD, dim: 0.55 })), /out of date: worked out for dim 0\.55 \/ blur 5px, the glass is now dim 0\.50 \/ blur 5px/);
  assert.match(why(rec({ ...GUARD, blurPx: 8 })), /out of date/);
  assert.match(why(rec(GUARD), { ...GLASS, dim: 0.6 }), /out of date/, 'stale against Helm\'s synced glass');
  assert.match(why(rec({ ...GUARD, alpha: 0.9 })), /outside 0\.50-0\.88/);
  assert.match(why(rec({ ...GUARD, alpha: 0.4 })), /outside/);
  assert.match(why(rec({ ...GUARD, alpha: '0.6' })), /outside/);
  assert.match(why(rec({ alpha: 0.6 })), /which dim and blur/);
  assert.match(why({ rev: 1, ok: true, guard: 'x' }), /no dark value/);
  assert.match(why(rec(undefined, { guardReason: 'still unreadable' })), /could not work out the shared darkening: still unreadable/);
  assert.match(why(rec(undefined)), /hasn't shared a darkening/);
  assert.match(why(rec(GUARD), GLASS, { syncOn: false, source: 'mantle' }), /Look Sync is off/);
  assert.match(why(rec(GUARD), GLASS, { syncOn: true, source: 'windows' }), /not sharing the desktop picture/);
});

test('washFor (look-sync washAlpha): Automatic raises to a valid guard; own / unusable / stale stay at Dim with the reason; Manual is exactly Dim', () => {
  const dark = { theme: 'dark', dim: 0.5, blurPx: 5, dimAuto: true }, light = { theme: 'light', dim: 0.5, blurPx: 5, dimAuto: true };
  const record = { ok: true, still: 'x.png', reason: null, guard: { dark: { alpha: 0.6, dim: 0.5, blurPx: 5 } }, guardReason: null };
  const desk = { source: 'mantle', record, unusable: null };
  const up = washFor(dark, 'desktop', desk);
  assert.equal(up.alpha, 0.6); assert.equal(up.mode, 'auto'); assert.equal(up.raised, true);
  assert.match(up.text, /^Automatic: 0\.50, raised to 0\.60/);
  const own = washFor(dark, 'own', desk);
  assert.equal(own.alpha, 0.5); assert.equal(own.raised, false); assert.match(own.reason, /your own picture shows/);
  const lt = washFor(light, 'desktop', desk);
  assert.equal(lt.alpha, 0.5, 'light never takes the dark guard'); assert.match(lt.reason, /light top band/);
  const stale = washFor({ ...dark, dim: 0.62 }, 'desktop', desk);   // another app moved the dim; Mantle not caught up
  assert.equal(stale.alpha, 0.62); assert.equal(stale.raised, false); assert.match(stale.reason, /Dim 0\.50 and blur 5/);
  const manual = washFor({ ...dark, dim: 0.3, dimAuto: false }, 'desktop', desk);
  assert.equal(manual.alpha, 0.3); assert.equal(manual.mode, 'manual'); assert.equal(manual.text, 'Manual: 0.30');
  const off = washFor(dark, 'desktop', { ...desk, unusable: "Look Sync is off, so Mantle's top band is not used" });
  assert.equal(off.alpha, 0.5); assert.match(off.reason, /Look Sync is off/);
  assert.match(washFor(dark, 'desktop', { source: 'mantle' }).reason, /older host/, 'a host without the record says so');
  assert.equal(washFor(dark, 'desktop', null).alpha, 0.5, 'no look state yet: the dim');
  assert.match(washFor(dark, 'desktop', null).reason, /hasn't heard/);
});

// ---------------------------------------------------------------- the light look (CONTRACT "Light look", 2026-10-14)
const { checkGuardLight } = require('../../main/look');
const GLASS_L = { blurPx: 12, dim: 0.45, panel: 0 };
const GUARD_L = { alpha: 0.55, contrast: 4.9, dim: 0.45, blurPx: 12, region: { topDip: 0, heightDip: 100 }, monitor: [1536, 864] };
const recL = (light, extra = {}) => ({ rev: 4, ok: true, still: 'x', guard: { dark: GUARD, ...(light === undefined ? {} : { light }) }, ...extra });

test('checkGuardLight: a valid, fresh guard.light is used; missing / invalid / stale fall back with the reason', () => {
  assert.deepEqual(checkGuardLight(recL(GUARD_L), GLASS_L, ON), { guardLight: { alpha: 0.55, dim: 0.45, blurPx: 12 }, guardLightReason: null });
  assert.equal(checkGuardLight(recL({ ...GUARD_L, alpha: 0.45 }), GLASS_L, ON).guardLight.alpha, 0.45, 'the floor (= dim) is valid');
  assert.equal(checkGuardLight(recL({ ...GUARD_L, alpha: 0.88 }), GLASS_L, ON).guardLight.alpha, 0.88, 'the ceiling is valid');
  const why = (r, g = GLASS_L, o = ON) => { const x = checkGuardLight(r, g, o); assert.equal(x.guardLight, null); return x.guardLightReason; };
  assert.equal(why(recL(undefined)), 'light top band not published by Mantle yet', 'Mantle published only the dark guard');
  assert.equal(why({ rev: 1, ok: true, still: 'x' }), 'light top band not published by Mantle yet');
  assert.match(why(recL(GUARD_L), { ...GLASS_L, dim: 0.55 }), /light top band is stale: worked out for dim 0\.45 \/ blur 12px, the light glass is now dim 0\.55 \/ blur 12px/);
  assert.match(why(recL({ ...GUARD_L, blurPx: 20 })), /stale/);
  assert.match(why(recL({ ...GUARD_L, alpha: 0.9 })), /outside 0\.45-0\.88/);
  assert.match(why(recL({ ...GUARD_L, alpha: 0.4 })), /outside 0\.45-0\.88/, 'below the light floor');
  assert.match(why(recL({ ...GUARD_L, alpha: '0.6' })), /outside/);
  assert.match(why(recL({ alpha: 0.6 })), /which dim and blur/);
  assert.match(why(recL('x')), /not readable/);
  assert.match(why(rec(undefined, { guardReason: 'still unreadable' })), /could not work out the light top band: still unreadable/);
  assert.match(why(recL(GUARD_L), GLASS_L, { syncOn: false, source: 'mantle' }), /Look Sync is off/);
  assert.match(why(recL(GUARD_L), GLASS_L, { syncOn: true, source: 'windows' }), /not sharing the desktop picture/);
  // the dark guard is judged on its own: a light-only problem never touches it
  assert.equal(checkGuard(recL(undefined), GLASS, ON).guard.alpha, 0.52);
});

test('washFor light: Automatic raises to a valid guard.light; own and stale keep the light Dim and say why', () => {
  const light = { theme: 'light', dim: 0.45, blurPx: 12, dimAuto: true };
  const record = { ok: true, still: 'x.png', guard: { dark: { alpha: 0.6, dim: 0.5, blurPx: 5 }, light: { alpha: 0.55, dim: 0.45, blurPx: 12 } } };
  const desk = { source: 'mantle', record, unusable: null };
  const up = washFor(light, 'desktop', desk);
  assert.equal(up.alpha, 0.55); assert.equal(up.raised, true);
  assert.equal(washFor({ theme: 'dark', dim: 0.5, blurPx: 5 }, 'desktop', desk).alpha, 0.6, 'dark still takes guard.dark');
  assert.equal(washFor(light, 'own', desk).alpha, 0.45, 'own picture: glass.light.dim');
  const stale = washFor({ ...light, dim: 0.5 }, 'desktop', desk);
  assert.equal(stale.alpha, 0.5); assert.match(stale.text, /^Automatic: 0\.50, not raised: .*waiting for Mantle/);
  const none = washFor(light, 'desktop', { ...desk, record: { ...record, guard: { dark: record.guard.dark } } });
  assert.equal(none.alpha, 0.45); assert.match(none.reason, /has not published the light top band/);
});

test('glass per theme: light paints glass.light (blur, dim, panel); sliders made in light save to glass.light only', async () => {
  const G = await import('../../ui/lib/glass.js');
  const st = { glass: { dark: { blurPx: 5, dim: 0.5, panel: 0 }, light: { blurPx: 12, dim: 0.45, panel: 0.05 } }, background: { blur: 5, dim: 0.5 } };
  assert.deepEqual(G.paintedGlass(st, 'light', null), { theme: 'light', blurPx: 12, dim: 0.45, panel: 0.05, dimAuto: true }, 'the light glass, panel shift included');
  assert.deepEqual(G.paintedGlass(st, 'dark', null), { theme: 'dark', blurPx: 5, dim: 0.5, panel: 0, dimAuto: true }, 'dark exactly as before (dimAuto absent = automatic)');
  assert.deepEqual(G.paintedGlass({ background: { blur: 9, dim: 0.6 } }, 'light', null), { theme: 'light', blurPx: 9, dim: 0.6, panel: 0, dimAuto: true }, 'older host: its one blur/dim');
  // a slider dragged in light: previews light, saves glass.light, never glass.dark
  let pv = G.withPreview(null, { dim: 0.6 }, 'light');
  pv = G.withPreview(pv, { panel: -0.1 }, 'light');
  assert.deepEqual(pv, { dim: 0.6, dimAuto: false, panel: -0.1, theme: 'light' }, 'moving Dim takes the tint over (Manual)');
  assert.equal(G.paintedGlass(st, 'light', pv).dim, 0.6);
  assert.equal(G.paintedGlass(st, 'dark', pv).dim, 0.5, 'a light preview never shows in dark');
  assert.deepEqual(G.savePartial(pv), { glass: { light: { dim: 0.6, dimAuto: false, panel: -0.1 } } });
  assert.equal(G.paintedGlass(st, 'light', pv).dimAuto, false, 'the preview paints Manual at once');
  // Auto hands it back: dimAuto true, the value stays
  const back = G.withPreview(pv, { dimAuto: true }, 'light');
  assert.deepEqual(G.savePartial(back), { glass: { light: { dim: 0.6, dimAuto: true, panel: -0.1 } } });
  assert.deepEqual(G.savePartial(G.withPreview(null, { blur: 8 }, 'dark')), { glass: { dark: { blurPx: 8 } } }, 'dark sliders still save glass.dark');
  // theme flipped mid-drag: the other theme's values are dropped, not filed under this theme; photo/mode kept
  const flipped = G.withPreview({ dim: 0.6, file: 'a.jpg', theme: 'dark' }, { blur: 20 }, 'light');
  assert.deepEqual(G.savePartial(flipped), { background: { file: 'a.jpg' }, glass: { light: { blurPx: 20 } } });
  assert.deepEqual(G.savePartial(G.withPreview(null, { mode: 'own' }, 'light')), { background: { mode: 'own' } }, 'a picker change carries no theme');
  // the host takes it: glass.light changes, glass.dark and the legacy dark mirror do not
  const { settings } = makeSettings({ background: { file: 'snow-peak.jpg', blur: 5, dim: 0.5 }, theme: 'light' });
  settings.set(G.savePartial(pv));
  assert.deepEqual(settings.get().glass.light, { blurPx: 5, dim: 0.6, panel: -0.1, dimAuto: false });
  settings.set({ glass: { light: { dimAuto: true } } });
  assert.equal(settings.get().glass.light.dimAuto, true, 'Auto: dimAuto true, the value stays');
  assert.equal(settings.get().glass.light.dim, 0.6);
  assert.throws(() => settings.set({ glass: { dark: { dimAuto: 'yes' } } }), /glass.dark.dimAuto must be true or false/);
  assert.deepEqual(settings.get().glass.dark, { blurPx: 5, dim: 0.5, panel: 0 });
  assert.equal(settings.get().background.dim, 0.5, 'the legacy mirror stays the dark glass');
});

test('desktop.guard flows from Mantle\'s record; a glass change makes it stale with a reason; sync OFF ignores it', async () => {
  const dir = tmp('guard');
  const stills = path.join(dir, 'stills');
  fs.mkdirSync(stills, { recursive: true });
  const still = path.join(stills, 'wall-5.jpg');
  fs.copyFileSync(path.join(UI_BG, 'snow-peak.jpg'), still);
  const ctx = makeSettings({ background: { file: 'snow-peak.jpg', blur: 5, dim: 0.5 }, theme: 'dark' });
  const { look } = makeLook(ctx, dir);
  look.start();
  await until(() => look.state().sync.state === 'ok');
  ctx.settings.set({ glass: { dark: { blurPx: 5, dim: 0.5 } } });   // the seed (blur 0 / dim .30) may have been adopted
  const mantle = LS.create({ app: 'mantle', dir, enabled: true });
  const publish = (extra) => mantle.publishDesktop({ ok: true, reason: null, id: 'builtin:snow-peak', type: 'builtin', title: 'Snow peak', file: null, still, stillSize: null, ...extra });
  const paint = () => washFor({ theme: 'dark', ...ctx.settings.get().glass.dark }, 'desktop', look.state().desktop);
  try {
    assert.equal(look.state().desktop.guard, null);
    let r = await publish({ guard: { dark: { ...GUARD, alpha: 0.56 } } });
    assert.ok(r.ok, JSON.stringify(r));
    let d = await until(() => (look.state().desktop.guard ? look.state().desktop : null), 1500);
    assert.ok(d, 'guard arrived: ' + JSON.stringify(look.state().desktop));
    assert.deepEqual(d.guard, { alpha: 0.56, dim: 0.5, blurPx: 5 });
    assert.equal(d.guardReason, null);
    assert.equal(d.record.still, 'wall-5.jpg', 'the record reaches the page with only the still file name');
    assert.equal(d.unusable, null);
    assert.equal(paint().alpha, 0.56, 'Automatic: Helm paints max(dim, the shared alpha)');
    assert.equal(paint().raised, true);

    // Helm's dim changes: the guard Mantle computed for .50 is stale until Mantle republishes
    ctx.settings.set({ glass: { dark: { dim: 0.6 } } });
    d = await until(() => (look.state().desktop.guard === null ? look.state().desktop : null), 1000);
    assert.ok(d, 'went stale: ' + JSON.stringify(look.state().desktop));
    assert.match(d.guardReason, /out of date: worked out for dim 0\.50/);
    assert.equal(paint().alpha, 0.6, 'falls back to the dim');
    assert.match(paint().reason, /waiting for Mantle/);

    // Mantle republishes for the new glass
    r = await publish({ guard: { dark: { ...GUARD, alpha: 0.64, dim: 0.6 } } });
    d = await until(() => (look.state().desktop.guard?.alpha === 0.64 ? look.state().desktop : null), 1500);
    assert.ok(d, 'fresh again: ' + JSON.stringify(look.state().desktop));

    // Mantle could not compute it: no guard, its reason shows
    await publish({ guardReason: 'the still could not be decoded' });
    d = await until(() => (look.state().desktop.guard === null ? look.state().desktop : null), 1500);
    assert.ok(d); assert.match(d.guardReason, /the still could not be decoded/);

    // sync OFF: the record still flows, the guard is not used
    await publish({ guard: { dark: { ...GUARD, dim: 0.6 } } });
    await until(() => look.state().desktop.guard, 1500);
    ctx.settings.set({ lookSync: { enabled: false } });
    d = await until(() => (look.state().desktop.guard === null ? look.state().desktop : null), 1500);
    assert.ok(d, 'off ignores it: ' + JSON.stringify(look.state().desktop));
    assert.match(d.guardReason, /Look Sync is off/);
    assert.match(d.unusable, /Look Sync is off/);
    assert.equal(paint().alpha, 0.6, 'off: the dim'); assert.match(paint().reason, /Look Sync is off/);
  } finally { mantle.close(); look.close(); }
});

test('desktop.guard.light flows from Mantle\'s record into the light wash; a light glass change makes it stale with a reason', { skip: !HAS_WRITER && 'no ~/look-sync' }, async () => {
  const dir = tmp('guardl');
  const stills = path.join(dir, 'stills');
  fs.mkdirSync(stills, { recursive: true });
  const still = path.join(stills, 'wall-6.jpg');
  fs.copyFileSync(path.join(UI_BG, 'snow-peak.jpg'), still);
  const ctx = makeSettings({ background: { file: 'snow-peak.jpg', blur: 5, dim: 0.5 }, theme: 'light' });
  ctx.settings.set({ glass: { light: { blurPx: 12, dim: 0.45 } } });
  const { look } = makeLook(ctx, dir);
  look.start();
  await until(() => look.state().sync.state === 'ok');
  ctx.settings.set({ glass: { light: { blurPx: 12, dim: 0.45 } } });   // the seed may have adopted the shared glass
  const mantle = LS.create({ app: 'mantle', dir, enabled: true });
  const publish = (extra) => mantle.publishDesktop({ ok: true, reason: null, id: 'builtin:snow-peak', type: 'builtin', title: 'Snow peak', file: null, still, stillSize: null, ...extra });
  const paint = () => washFor({ theme: 'light', ...ctx.settings.get().glass.light }, 'desktop', look.state().desktop);
  try {
    // Mantle shares only the dark guard: the light wash is the light dim, and says why
    await publish({ guard: { dark: GUARD } });
    let d = await until(() => (look.state().desktop.source === 'mantle' && look.state().desktop.guardLightReason ? look.state().desktop : null), 1500);
    assert.ok(d, JSON.stringify(look.state().desktop));
    assert.equal(d.guardLight, null);
    assert.equal(d.guardLightReason, 'light top band not published by Mantle yet');
    assert.equal(paint().alpha, 0.45); assert.equal(paint().raised, false);
    assert.match(paint().reason, /has not published the light top band/);

    // guard.light published for the synced light glass: Helm's light wash = its alpha
    await publish({ guard: { dark: GUARD, light: { ...GUARD_L, alpha: 0.57 } } });
    d = await until(() => (look.state().desktop.guardLight ? look.state().desktop : null), 1500);
    assert.ok(d, 'light guard arrived: ' + JSON.stringify(look.state().desktop));
    assert.deepEqual(d.guardLight, { alpha: 0.57, dim: 0.45, blurPx: 12 });
    assert.equal(paint().alpha, 0.57, 'Helm paints the shared white alpha');

    // the light dim moves: stale until Mantle republishes; the dark guard is untouched
    ctx.settings.set({ glass: { light: { dim: 0.5 } } });
    d = await until(() => (look.state().desktop.guardLight === null ? look.state().desktop : null), 1000);
    assert.ok(d, 'went stale: ' + JSON.stringify(look.state().desktop));
    assert.match(d.guardLightReason, /light top band is stale: worked out for dim 0\.45/);
    assert.equal(paint().alpha, 0.5, 'falls back to the light dim');
    assert.match(paint().reason, /waiting for Mantle/);
    // Manual: exactly the dim, whatever Mantle publishes
    ctx.settings.set({ glass: { light: { dim: 0.45, dimAuto: false } } });
    assert.equal(paint().alpha, 0.45); assert.equal(paint().mode, 'manual'); assert.equal(paint().text, 'Manual: 0.45');
  } finally { mantle.close(); look.close(); }
});
