// Native notifications, taskbar badge, frame flash and the tray icon.
//  - protocol `notify` events -> a Windows notification when the window isn't focused
//    (filtered by settings.notifications[kind]); clicking it shows the window on that session
//    (selectSession: the window's store + `app.select { sessionId }` to every client)
//  - taskbar overlay badge = number of sessions waiting on the user; flashFrame when one starts waiting
//  - context hand-off: a running subagent crossing 32% / 40% of its window -> one `notify` per agent per
//    threshold (ContextAlerts in engine/fleet.js; settings.notifyContextHandoff) + a frame flash if unfocused
//  - tray: Show Helm / Quick prompt / N waiting / Quit
// Icons come from ui/assets (icon.png for toasts, icon.ico for the tray); the painted
// placeholder in icons.js is only the fallback when those files are missing.
//  - team notices (Positions, source "team": a position's access / outward card, a proposal, a duty run):
//    titled from the owner's point of view by teamNotice() below; clicking one without a session opens the
//    Team view (`app.select { view: 'team', company }`). They obey notifications.waiting like any wait.
// Owner: lane host (B).
const fs = require('fs');
const path = require('path');
const { badgeBitmap, appIconBitmap } = require('./icons');

// ----- team notices (pure; the engine and main/push.js require this file for them) -----
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const cap = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const blankTitle = (t) => !t || t === 'Session';

/**
 * teamNotice({ what, position: { id, name }, company: { id, name }, detail?, title?, action?, sessionId? })
 *   what: 'access' | 'outward' | 'proposal' | 'duty' | 'duty-failed'
 *   detail: the body: what the card asks for / the outward command / the proposal's why / the report summary / the error
 *   title: the subject: the duty's name (duty, duty-failed) or the proposal's target name (proposal)
 *   action: proposals only, 'create' (default) | 'edit' | 'retire' | 'company'
 * -> { kind: 'waiting', source: 'team', title, body, sessionId?, team: { what, company, position, companyName,
 *      positionName, subject, action } }   (company / position = ids; the names ride along so outputs can re-title)
 * Titles are one line, never empty, at most 120 chars; the body is one line, at most 900 (push cuts it to 400).
 */
function teamNotice(evt) {
  const e = evt && typeof evt === 'object' ? evt : {};
  const what = oneLine(e.what) || 'waiting';
  const pos = e.position && typeof e.position === 'object' ? e.position : {};
  const co = e.company && typeof e.company === 'object' ? e.company : {};
  const positionName = cap(oneLine(pos.name), 60) || null;
  const companyName = cap(oneLine(co.name), 60) || null;
  const subject = cap(oneLine(e.title), 80) || null;
  const action = what === 'proposal' ? (oneLine(e.action) || 'create') : null;
  const who = positionName || 'Your team';
  let title;
  if (what === 'access' || what === 'outward') title = `${who} needs your OK`;
  else if (what === 'proposal') {
    if (action === 'retire') title = `${who} proposes retiring ${subject || 'a report'}`;
    else if (action === 'edit') title = `${who} proposes a change to ${subject || 'a report'}`;
    else if (action === 'company') title = `${who} proposes a change to ${subject || companyName || 'the company'}`;
    else title = subject ? `${who} proposes a new report: ${subject}` : `${who} proposes a new report`;
  } else if (what === 'duty') title = subject ? `${who}: ${subject} is done` : `${who} finished a duty`;
  else if (what === 'duty-failed') title = subject ? `${who}'s duty failed: ${subject}` : `${who}'s duty failed`;
  else title = `${who} needs you`;
  let body = oneLine(e.detail);
  // an access / outward card names the company it is for (once: re-titling an already built notice adds nothing)
  if ((what === 'access' || what === 'outward') && companyName && !body.includes(companyName)) body = body ? `${body} · ${companyName}` : companyName;
  const sessionId = e.sessionId ? String(e.sessionId) : null;
  return {
    kind: 'waiting', source: 'team', title: cap(title, 120), body: cap(body, 900), ...(sessionId ? { sessionId } : {}),
    team: { what, company: co.id != null ? String(co.id) : null, position: pos.id != null ? String(pos.id) : null, companyName, positionName, subject, action },
  };
}

// Any `notify` event -> the one both outputs (desktop toast, phone push) show. Only source "team" changes:
// with n.team it is re-titled by teamNotice (a caller's own title wins only when n.team carries no position
// name); without it the title is kept, cleaned, and an empty / "Session" one becomes "Team needs you".
function normalizeNotice(n) {
  if (!n || typeof n !== 'object' || n.source !== 'team') return n;
  const own = cap(oneLine(n.title), 120);
  const t = n.team && typeof n.team === 'object' && n.team.what ? n.team : null;
  if (!t) return { ...n, title: blankTitle(own) ? 'Team needs you' : own, body: cap(oneLine(n.body), 900) };
  const built = teamNotice({
    what: t.what, position: { id: t.position, name: t.positionName }, company: { id: t.company, name: t.companyName },
    title: t.subject, action: t.action, detail: n.body,
  });
  return { ...n, title: t.positionName || blankTitle(own) ? built.title : own, body: built.body };
}

/**
 * createNotifier({ electron, getWindow, showWindow, broadcast, selectSession?, getSettings, iconDir, onQuit,
 *                  onQuickPrompt?, enableTray, record?, log })
 *   selectSession(id): show the window on that session (default: showWindow + broadcast app.select)
 *   record: { overlay: [], flash: [] } (test mode) receives every badge / flash the notifier makes
 * -> { onEngineEvent(event, data), seed(sessions), notify(n), info(title, body), handleClick(n),
 *      showToast(n, { closeAfterMs }), trayInfo(), refreshTray(), destroy(), waitingCount(), appIcon }
 */
function createNotifier(opts) {
  // The 32% / 40% context tracker lives with the fleet code (pure JS, no SDK), so the fallback engine can't break it.
  // Required here, not at the top, so requiring this file for teamNotice() loads no engine code.
  let ContextAlerts = null;
  try { ({ ContextAlerts } = require('./engine/fleet')); } catch { ContextAlerts = null; }
  const { electron, getWindow, showWindow, broadcast, getSettings, iconDir, onQuit, onRestart = null, onQuickPrompt = null, enableTray = true, record = null, log = () => {} } = opts;
  // onContextAlert(n): every context hand-off alert this notifier raises, after its own toast; main.js sends it
  // to the phone (main/push.js pushDecision), since these alerts never pass through the engine's `notify` event.
  const onContextAlert = typeof opts.onContextAlert === 'function' ? opts.onContextAlert : null;
  // overlay:false = main/badge.js owns the taskbar overlay (waiting + unseen errors); the tray keeps its waiting count.
  const ownOverlay = opts.overlay !== false;
  const selectSession = opts.selectSession || ((id) => { showWindow(); if (id) broadcast('app.select', { sessionId: id }); });
  const { Notification, nativeImage, Tray, Menu } = electron;
  const status = new Map(); // sessionId -> status
  const live = new Set();   // keep Notification objects referenced so their click handlers survive GC
  let tray = null;
  let trayTemplate = null;
  let lastBadge = -1;
  const titles = new Map(); // sessionId -> title, to name the session in a context alert
  // Context hand-off alerts: a running subagent crossing 32% / 40% raises ONE protocol `notify` each
  // (broadcast to every client for the in-app toast, plus the native toast + frame flash when the
  // window isn't focused). settings.notifyContextHandoff=false silences them.
  const contextAlerts = ContextAlerts ? new ContextAlerts({
    enabled: () => (getSettings() || {}).notifyContextHandoff !== false,
    sessionTitle: (id) => titles.get(id) || null,
    notify: (n) => {
      broadcast('notify', n);
      api.notify(n);
      if (!windowFocused()) {
        const w = getWindow();
        if (w && !w.isDestroyed()) { w.flashFrame(true); if (record) record.flash.push({ sessionId: n.sessionId, at: Date.now(), context: n.threshold }); }
      }
      if (onContextAlert) { try { onContextAlert(n); } catch (e) { log('context alert hook', e); } }
    },
  }) : null;

  const appIcon = loadIcon(['icon.png', 'icon.ico']);
  const trayIcon = loadIcon(['icon.ico', 'icon.png']);

  function loadIcon(files) {
    for (const f of files) {
      const p = path.join(iconDir, f);
      if (fs.existsSync(p)) { const img = nativeImage.createFromPath(p); if (!img.isEmpty()) return { img, file: p }; }
    }
    log(`no ${files.join(' / ')} in ${iconDir}; using the painted placeholder icon`);
    const bm = appIconBitmap();
    return { img: nativeImage.createFromBitmap(bm.buffer, { width: bm.width, height: bm.height, scaleFactor: 2 }), file: null };
  }

  function windowFocused() {
    const w = getWindow();
    return !!(w && !w.isDestroyed() && w.isVisible() && !w.isMinimized() && w.isFocused());
  }

  function waitingCount() { let n = 0; for (const s of status.values()) if (s === 'waiting') n++; return n; }

  function refresh() {
    const n = waitingCount();
    if (n !== lastBadge) {
      lastBadge = n;
      const w = getWindow();
      if (ownOverlay && w && !w.isDestroyed()) {
        try {
          if (n) { const bm = badgeBitmap(n); w.setOverlayIcon(nativeImage.createFromBitmap(bm.buffer, { width: bm.width, height: bm.height, scaleFactor: 2 }), `${n} waiting`); }
          else w.setOverlayIcon(null, '');
          if (record) record.overlay.push({ n, at: Date.now() });
        } catch (e) { log('overlay icon failed:', e.message); }
      }
      buildTrayMenu();
    }
  }

  function seed(sessions) {
    status.clear();
    for (const s of sessions || []) { status.set(s.id, s.status); if (typeof s.title === 'string') titles.set(s.id, s.title); }
    lastBadge = -1;
    refresh();
  }

  function onEngineEvent(event, data) {
    if (!data) return;
    if (event === 'session.created' || event === 'session.updated') {
      const prev = status.get(data.id);
      if (typeof data.title === 'string') titles.set(data.id, data.title);
      status.set(data.id, data.status);
      if (data.status === 'waiting' && prev !== 'waiting' && !windowFocused()) {
        const w = getWindow();
        if (w && !w.isDestroyed()) { w.flashFrame(true); if (record) record.flash.push({ sessionId: data.id, at: Date.now() }); }
      }
      refresh();
    } else if (event === 'session.removed') {
      status.delete(data.id);
      titles.delete(data.id);
      if (contextAlerts) contextAlerts.forget(data.id);
      refresh();
    } else if (event === 'fleet.updated') {
      if (contextAlerts && data.sessionId) contextAlerts.check(data.sessionId, data.agents);
    } else if (event === 'notify') {
      api.notify(data); // via the returned object, so main.js's test-mode stub really silences engine toasts
    } else if (event === 'settings.updated') {
      buildTrayMenu(); // the Quick prompt item shows the current hotkey
    }
  }

  function notify(n) {
    n = normalizeNotice(n); // team notices: owner-facing title (a waiting notice, so notifications.waiting gates it)
    if (!n || !n.title) return;
    const prefs = (getSettings() || {}).notifications || {};
    if (n.kind && prefs[n.kind] === false && n.source !== 'context') return; // context alerts have their own switch
    if (windowFocused()) return; // the UI shows its own toast
    showToast(n);
  }

  // What clicking a notification does: bring the window up on that session; a team notice with no session
  // (a duty run, a proposal from a scheduled turn) opens the Team view on its company instead.
  function handleClick(n) {
    if (n && n.sessionId) selectSession(n.sessionId);
    else if (n && n.source === 'team') { showWindow(); broadcast('app.select', { view: 'team', company: (n.team && n.team.company) || null }); }
    else showWindow();
  }

  // Show one toast. Resolves { shown, failed?, error? } once Windows accepts or rejects it.
  function showToast(n, { closeAfterMs = 0 } = {}) {
    if (!Notification.isSupported()) return Promise.resolve({ shown: false, error: 'notifications not supported' });
    n = normalizeNotice(n);
    const note = new Notification({ title: String(n.title).slice(0, 120), body: String(n.body || '').slice(0, 900), icon: appIcon.img, silent: n.kind === 'info' });
    live.add(note);
    const drop = () => live.delete(note);
    const done = new Promise((resolve) => {
      note.on('show', () => {
        resolve({ shown: true });
        if (closeAfterMs) setTimeout(() => { try { note.close(); } catch {} drop(); }, closeAfterMs);
      });
      note.on('failed', (_e, err) => { drop(); log('notification failed:', err); resolve({ shown: false, failed: true, error: String(err) }); });
      setTimeout(() => resolve({ shown: false, error: 'no show event within 5 s' }), 5000).unref?.();
    });
    note.on('click', () => { drop(); handleClick(n); });
    note.on('close', drop);
    note.show();
    setTimeout(drop, 10 * 60_000).unref?.();
    return done;
  }

  function info(title, body) {
    if (!Notification.isSupported()) return;
    const note = new Notification({ title, body, icon: appIcon.img, silent: true });
    live.add(note);
    note.on('click', () => { live.delete(note); showWindow(); });
    note.on('close', () => live.delete(note));
    note.on('failed', (_e, err) => { live.delete(note); log('notification failed:', err); });
    note.show();
  }

  function toolTip() { const n = waitingCount(); return n ? `Helm: ${n} waiting on you` : 'Helm'; }

  function buildTrayMenu() {
    if (!tray) return;
    const n = waitingCount();
    const hotkey = (getSettings() || {}).quickPromptHotkey;
    tray.setToolTip(toolTip());
    trayTemplate = [
      { label: 'Show Helm', click: showWindow },
      ...(onQuickPrompt ? [{ label: 'Quick prompt', accelerator: hotkey || undefined, registerAccelerator: false, click: onQuickPrompt }] : []),
      { label: n ? `${n} waiting on you` : 'Nothing waiting', enabled: n > 0, click: showWindow },
      { type: 'separator' },
      ...(onRestart ? [{ label: 'Restart Helm', click: onRestart }] : []),
      { label: 'Quit Helm', click: onQuit },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(trayTemplate));
  }

  if (enableTray) {
    try {
      // The .ico carries 16/24/32 px frames, so Windows picks the right one per DPI.
      tray = new Tray(trayIcon.file && trayIcon.file.endsWith('.ico') ? trayIcon.file : trayIcon.img.resize({ width: 16, height: 16, quality: 'best' }));
      tray.on('click', showWindow);
      buildTrayMenu();
    } catch (e) { log('tray failed:', e.message); tray = null; }
  }

  function trayInfo() {
    if (!tray || tray.isDestroyed()) return null;
    return { iconFile: trayIcon.file, labels: (trayTemplate || []).filter((i) => i.label).map((i) => i.label), toolTip: toolTip() };
  }

  const api = {
    onEngineEvent, seed, notify, info, handleClick, showToast, trayInfo, waitingCount, appIcon, refreshTray: buildTrayMenu,
    destroy() { if (tray) { tray.destroy(); tray = null; } live.clear(); },
  };
  return api;
}

module.exports = { createNotifier, teamNotice, normalizeNotice };
