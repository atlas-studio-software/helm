// Duties: a position's standing jobs (docs/POSITIONS.md section 9). They run in Helm's main process, never inside
// claude.exe: a run is an ordinary delivery (5.3) of class `duty` through the runtime, so the CLI is resumed for it
// and reaped again afterwards. Anything outward a run wants still waits for the owner's card (guard.js); this module only
// decides WHEN a run happens and logs it.
//
// Schedules: a 60 s unref'd tick computes each enabled schedule duty's next fire from nextCronFire(cron, cursor)
//   (schedules.js: 5 fields, local time). `cursor` is when the duty last ran, was last judged missed, or was first
//   seen / re-enabled, so a new or re-enabled duty never fires for the past.
//   Helm closed (or the computer asleep) at the due time: catchUp "once" (default) queues ONE run if the newest
//   missed fire is inside its window (24 h for daily or more often, 7 days for weekly or longer, the period in
//   between), with "This run was due <when>; Helm was closed."; outside it, or catchUp "skip", the fire is logged
//   `missed` with an inbox line. Several missed fires never make more than one run.
// Events: refs-watch.js (fs.watch on git refs, one for-each-ref per change; file triggers by mtime + hash) reports
//   commits / tags / file changes for the targets this module hands it (the repos named by ENABLED event duties).
//   Several events within cooldownMin (default 30) become one run. An event found at start (made while Helm was
//   closed) follows the same catch-up rule: one run, 7-day window, unless the trigger says catchUp "skip".
// Caps: at most team.maxConcurrentRuns (default 2) duty runs in flight; while the 5-hour usage is at or above
//   team.usageCeilingPct (default 80) queued runs wait, logged `skipped` reason `usage` once, and start at the
//   first tick after it drops. team.dutiesPaused, a paused / retired position or a disabled duty runs nothing.
// The queue and the per-duty records persist in the injected state (team-state.json keys 'duties', 'dutyQueue'),
// so a run queued behind the usage ceiling survives a restart. "Run now" (team.duty.run) starts at once: the owner asked.
//
// createDuties({
//   listPositions: () => [{ company: { id, name, folders }, position }]     live positions (position.json shape 2.4)
//   runDuty: async (req) => { ticket, done: Promise<{ state: 'done'|'failed', finalText?, reported?, costUsd?, error? }> }
//            req = { company, companyName, position, positionName, duty: { id, title, trigger }, text,
//                    trigger: { kind, detail }, due, catchUp, manual }
//            (runtime.js: deliver `text` as a class 'duty' message; `reported` = the run called duty_report)
//   appendRun: (companyId, line) => void          duty-runs.jsonl (2.6)
//   appendInbox: (companyId, entry) => void       inbox.jsonl (2.6)
//   settings: () => ({ maxConcurrentRuns, usageCeilingPct, dutiesPaused })   the `team.*` settings
//   usagePct: () => number | null                 the 5-hour window %, null when unknown (unknown never blocks)
//   state?: { get(name), set(name, value) }       team-state.json slices; in-memory when absent
//   refsWatch?: false | (opts) => instance | instance   default: createRefsWatch(opts) fed by this module; an
//                                                 instance passed in gets its events through _onEvent(ev)
//   resumeRun?: (ticket) => Promise<result> | null  re-attach a run that was in flight when Helm quit
//   emit?: (company) => void                      'team.updated { company }' after a visible change
//   ownerName?: string | () => string             who outward steps wait for, in the delivered text ('the owner')
//   notify?: (event) => void                      toast / phone push (notice.js teamEvent shape): a failed run
//                                                 ('duty-failed'), or a run that ended without duty_report ('duty')
//   now?, timers?, tickMs?, log?
// }) -> { start(), stop(), tick(), refresh(), runNow(company, position, duty) -> Promise<{ ticket }>,
//         poke(reason), info(company, position) -> { [dutyId]: { nextAt, lastRunAt, last, queued, running, problem? } },
//         nextDuty(company, position) -> { id, title, at } | null, queue(), running(), watchStatus() }
'use strict';

const crypto = require('crypto');
const path = require('path');
const { nextCronFire } = require('../schedules');
const { createRefsWatch } = require('./refs-watch');
const { ownerWords } = require('./owner');
const { teamEvent } = require('./notice');

const TICK_MS = 60_000;
const LATE_MS = 5 * 60_000; // a fire seen this much after its time was slept / closed through: catch-up rule
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, WEEK = 7 * DAY;
const EVENT_CATCHUP_WINDOW_MS = WEEK;
const DEFAULT_COOLDOWN_MIN = 30;
const RUN_TIMEOUT_MS = 2 * HOUR + 15 * MIN; // runtime tickets expire at 2 h; never hold a run slot longer
const TEXT_MAX = 20_000; // log text cap (2.6)
const MAX_SUBJECTS = 50, MAX_FILES = 200;
const DEFAULTS = { maxConcurrentRuns: 2, usageCeilingPct: 80, dutiesPaused: false };

const isWin = process.platform === 'win32';
const slash = (p) => String(p).replace(/\\/g, '/');
const pathKey = (p) => { const s = slash(path.resolve(p)).replace(/\/+$/, ''); return isWin ? s.toLowerCase() : s; };
const inside = (child, parent) => { const c = pathKey(child), p = pathKey(parent); return c === p || c.startsWith(p + '/'); };
const clip = (s, n = TEXT_MAX) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const pad = (n) => String(n).padStart(2, '0');
function localStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const neutral = (s) => String(s).replace(/<\/?helm-duty/gi, (m) => m.replace('<', '‹')); // repo text cannot close the block
const newId = (p) => p + crypto.randomBytes(4).toString('hex');

// The shortest gap between the next few fires: "0 9 * * 1-5" is daily (1 day), not "every 3 days" after Friday.
function cronPeriodMs(cron, from) {
  let best = Infinity, t = from;
  for (let i = 0; i < 4; i++) {
    const a = nextCronFire(cron, t);
    if (a == null) break;
    const b = nextCronFire(cron, a);
    if (b == null) break;
    best = Math.min(best, b - a);
    t = a;
  }
  return best;
}
// 9.3: 24 h for daily or more often, 7 days for weekly or longer; a period in between is its own window.
function catchUpWindowMs(cron, from) {
  const p = cronPeriodMs(cron, from);
  if (!Number.isFinite(p)) return WEEK;
  if (p <= DAY + HOUR) return DAY; // DST slack
  if (p >= WEEK - HOUR) return WEEK;
  return p;
}
// The newest fire time in (max(cursor, now - window), now], or null.
function latestFireWithin(cron, cursor, now, windowMs) {
  let t = Math.max(cursor, now - windowMs - 1), last = null;
  for (let guard = 0; guard < 3000; guard++) {
    const f = nextCronFire(cron, t);
    if (f == null || f > now) break;
    last = f;
    t = f;
  }
  return last;
}

// "schedule 0 9 1 * *", "commit C:/x/site master", "release C:/x/app v1.3.0", "file C:/x/pricing.json"
function triggerLabel(trigger, ev) {
  if (!trigger) return 'manual';
  if (trigger.kind === 'schedule') return `schedule ${trigger.cron}`;
  const folder = slash((ev && ev.folder) || trigger.repo || '');
  if (trigger.event === 'commit') return `commit ${folder} ${(ev && ev.branch) || trigger.branch || ''}`.trim();
  if (trigger.event === 'release') return `release ${folder} ${(ev && ev.tag) || trigger.tag || ''}`.trim();
  if (trigger.event === 'file') return `file ${slash(trigger.path || '')}`;
  return String(trigger.kind || 'event');
}

// Event details for the delivered text (9.4: subjects max 50, files max 200 across a coalesced burst).
function eventText(events) {
  const lines = [];
  let subjects = 0, files = 0;
  for (const ev of events || []) {
    if (ev.kind === 'commit') {
      lines.push(`New commits on ${ev.branch} in ${slash(ev.folder)} (${ev.count}${ev.truncated ? '+' : ''}):`);
    } else if (ev.kind === 'release') {
      lines.push(`New tag ${ev.tag} in ${slash(ev.folder)}${ev.prevTag ? ` (since ${ev.prevTag})` : ''}, ${ev.count}${ev.truncated ? '+' : ''} commit(s):`);
    } else if (ev.kind === 'file') {
      lines.push(`Changed file: ${slash(ev.path)}`);
      continue;
    }
    for (const c of ev.commits || []) {
      if (subjects >= MAX_SUBJECTS) { lines.push('- …'); break; }
      lines.push(`- ${String(c.sha).slice(0, 7)} ${c.subject}`);
      subjects++;
    }
    if (ev.files && ev.files.length) {
      lines.push('Files changed:');
      for (const f of ev.files) {
        if (files >= MAX_FILES) { lines.push('- …'); break; }
        lines.push('- ' + f);
        files++;
      }
    }
  }
  return lines.join('\n');
}

// Merge a new event into a queued item's list: the same branch / tag / file keeps one entry (newest wins, commits
// merged newest-first) so a burst stays small.
function mergeEvents(list, ev) {
  const sameAs = (a) => a.kind === ev.kind && pathKey(a.folder || a.path || '') === pathKey(ev.folder || ev.path || '')
    && (ev.kind !== 'commit' || a.branch === ev.branch) && (ev.kind !== 'release' || a.tag === ev.tag);
  const i = list.findIndex(sameAs);
  if (i < 0) return [...list, ev];
  const a = list[i];
  const merged = { ...ev };
  if (ev.kind === 'commit') {
    const seen = new Set();
    merged.commits = [...(ev.commits || []), ...(a.commits || [])].filter((c) => !seen.has(c.sha) && seen.add(c.sha)).slice(0, MAX_SUBJECTS);
    merged.files = [...new Set([...(ev.files || []), ...(a.files || [])])].slice(0, MAX_FILES);
    merged.count = (a.count || 0) + (ev.count || 0);
    merged.old = a.old;
    merged.truncated = !!(a.truncated || ev.truncated);
  }
  const out = list.slice();
  out[i] = merged;
  return out;
}

function eventDetail(events) {
  const parts = [];
  for (const ev of events || []) {
    if (ev.kind === 'commit') parts.push(`${ev.branch} ${ev.count} commit${ev.count === 1 ? '' : 's'}`);
    else if (ev.kind === 'release') parts.push(ev.tag);
    else if (ev.kind === 'file') parts.push(path.basename(ev.path));
  }
  return parts.join(', ');
}

function createDuties(opts = {}) {
  const now = opts.now || Date.now;
  const T = { setTimeout, clearTimeout, setInterval, clearInterval, ...(opts.timers || {}) };
  const tickMs = opts.tickMs ?? TICK_MS;
  const log = opts.log || (() => {});
  const listPositions = opts.listPositions || (() => []);
  const runDuty = opts.runDuty;
  const appendRun = opts.appendRun || (() => {});
  const appendInbox = opts.appendInbox || (() => {});
  const emitUpdate = opts.emit || (() => {});
  const notify = typeof opts.notify === 'function' ? opts.notify : () => {};
  const mem = new Map();
  const state = opts.state || { get: (k) => mem.get(k), set: (k, v) => mem.set(k, v) };
  const settings = () => { try { return { ...DEFAULTS, ...((opts.settings && opts.settings()) || {}) }; } catch { return { ...DEFAULTS }; } };
  const usagePct = () => { try { const v = opts.usagePct ? opts.usagePct() : null; return Number.isFinite(v) ? v : null; } catch { return null; } };

  let records = { ...(state.get('duties') || {}) }; // key -> { cron?, cursor, nextAt, lastRunAt, last, off, problem }
  let queue = Array.isArray(state.get('dutyQueue')) ? state.get('dutyQueue').slice() : [];
  const running = new Map(); // key -> { ticket, startedAt, timer }
  let started = false, stopped = false, interval = null;
  let dirty = false;
  const targetMap = new Map(); // refs-watch target id -> { key, folder }
  let refsWatch = null;

  const keyOf = (companyId, positionId, dutyId) => `${companyId}/${positionId}/${dutyId}`;
  const save = () => {
    if (!dirty) return;
    dirty = false;
    try { state.set('duties', records); state.set('dutyQueue', queue); } catch (e) { log('duties: state save failed: ' + e.message); }
  };
  const touch = () => { dirty = true; };
  const iso = (ms) => new Date(ms).toISOString();

  // ----- the duty table, read fresh from the store (it caches) -----
  function table() {
    const out = new Map();
    let list = [];
    try { list = listPositions() || []; } catch (e) { log('duties: listPositions failed: ' + e.message); return null; }
    for (const { company, position } of list) {
      if (!company || !position || !Array.isArray(position.duties)) continue;
      for (const duty of position.duties) {
        if (!duty || !duty.id || !duty.trigger) continue;
        out.set(keyOf(company.id, position.id, duty.id), { company, position, duty });
      }
    }
    return out;
  }
  const isOn = (row, s = settings()) => !!row && !s.dutiesPaused && (row.position.status || 'active') === 'active' && row.duty.enabled !== false;

  // Folders an event duty may watch: its repo inside the position's scope (2.4 `$scope`), never anything else.
  function eventFolders(row) {
    const { company, position, duty } = row;
    const companyFolders = (company.folders || []).filter(Boolean);
    const scope = position.scope && position.scope.kind === 'product' && position.scope.folder ? [position.scope.folder] : companyFolders;
    const t = duty.trigger;
    if (t.event === 'file') {
      if (!t.path) return { problem: 'no path' };
      return scope.some((f) => inside(t.path, f)) ? { files: [path.resolve(t.path)] } : { problem: 'outside scope' };
    }
    const repo = t.repo || '$scope';
    const want = repo === '$scope' ? scope : repo === '$company' ? companyFolders : [repo];
    const ok = want.filter((f) => scope.some((s) => inside(f, s)));
    if (!ok.length) return { problem: 'outside scope' };
    return { folders: ok.map((f) => path.resolve(f)) };
  }

  // ----- refs-watch wiring -----
  // Called every tick; refs-watch is only told when the set of enabled event duties (or their triggers / scope)
  // changed. A failed store read (tab null) never reaches refs-watch: an empty list would drop every baseline.
  let targetSig = null;
  function syncTargets(tab) {
    if (!refsWatch || !tab) return;
    const s = settings();
    const sigRows = [];
    for (const [key, row] of tab) {
      if (row.duty.trigger.kind === 'event' && isOn(row, s)) sigRows.push([key, row.duty.trigger, row.position.scope || null, row.company.folders]);
    }
    const sig = JSON.stringify(sigRows);
    if (sig === targetSig) return;
    targetSig = sig;
    const targets = [];
    targetMap.clear();
    for (const [key, row] of tab) {
      if (row.duty.trigger.kind !== 'event' || !isOn(row, s)) continue;
      const t = row.duty.trigger;
      const where = eventFolders(row);
      const rec = records[key] || (records[key] = { cursor: now() });
      if (where.problem) { if (rec.problem !== where.problem) { rec.problem = where.problem; touch(); } continue; }
      if (rec.problem) { delete rec.problem; touch(); }
      (where.folders || where.files).forEach((f, i) => {
        const id = `${key}#${i}`;
        targetMap.set(id, { key, folder: f });
        if (t.event === 'file') targets.push({ id, kind: 'file', path: f });
        else if (t.event === 'release') targets.push({ id, kind: 'release', folder: f, tag: t.tag || '*' });
        else targets.push({ id, kind: 'commit', folder: f, branch: t.branch || undefined, paths: t.paths });
      });
    }
    refsWatch.setTargets(targets);
  }

  function onEvent(ev) {
    if (stopped) return;
    const target = targetMap.get(ev.id);
    if (!target) return;
    const tab = table();
    const row = tab && tab.get(target.key);
    if (!isOn(row)) return; // paused / disabled since: refs-watch still advanced its baseline, nothing runs
    const t = row.duty.trigger;
    const kind = t.event || 'event';
    if (ev.catchUp) {
      const tooOld = ev.newestAt && now() - ev.newestAt > EVENT_CATCHUP_WINDOW_MS;
      if (t.catchUp === 'skip' || tooOld) {
        missed(row, target.key, { kind, detail: eventDetail([ev]) }, ev.newestAt || now(),
          t.catchUp === 'skip' ? 'Helm was closed (catch-up off)' : 'Helm was closed (outside the 7-day window)');
        return;
      }
    }
    enqueue(row, {
      trigger: { kind, detail: eventDetail([ev]) },
      due: now(),
      events: [ev],
      catchUp: !!ev.catchUp,
      note: ev.catchUp ? `This happened while Helm was closed${ev.newestAt ? ` (around ${localStamp(ev.newestAt)})` : ''}.` : null,
    });
  }

  // ----- queue -----
  function enqueue(row, it) {
    const key = keyOf(row.company.id, row.position.id, row.duty.id);
    const rec = records[key] || (records[key] = { cursor: now() });
    const existing = queue.find((q) => q.key === key);
    if (existing) { // coalesce: one queued run per duty
      if (it.events) {
        let evs = existing.events || [];
        for (const ev of it.events) evs = mergeEvents(evs, ev);
        existing.events = evs;
        existing.trigger = { kind: existing.trigger.kind, detail: eventDetail(evs) };
      }
      existing.catchUp = existing.catchUp && it.catchUp;
      touch();
      save();
      return existing;
    }
    let notBefore = 0;
    if (row.duty.trigger.kind === 'event') {
      const cd = (Number.isFinite(row.duty.cooldownMin) && row.duty.cooldownMin >= 0 ? row.duty.cooldownMin : DEFAULT_COOLDOWN_MIN) * MIN;
      // the last run (or the one still running) started less than cooldownMin ago: wait out the rest
      if (rec.lastRunAt && now() - rec.lastRunAt < cd) notBefore = rec.lastRunAt + cd;
    }
    const item = {
      id: newId('q_'), key, company: row.company.id, position: row.position.id, duty: row.duty.id,
      trigger: it.trigger, due: it.due, catchUp: !!it.catchUp, note: it.note || null, events: it.events || null,
      notBefore, queuedAt: now(), usageLogged: false,
    };
    queue.push(item);
    touch();
    save();
    pump();
    return item;
  }

  function line(row, fields) {
    const key = keyOf(row.company.id, row.position.id, row.duty.id);
    const l = { at: iso(now()), position: row.position.id, duty: row.duty.id, ...fields };
    try { appendRun(row.company.id, l); } catch (e) { log('duties: appendRun failed: ' + e.message); }
    const rec = records[key] || (records[key] = { cursor: now() });
    rec.last = { state: l.state, at: now(), ...(l.reason ? { reason: l.reason } : {}), ...(l.ticket ? { ticket: l.ticket } : {}) };
    touch();
    try { emitUpdate(row.company.id); } catch {}
  }
  function inbox(row, entry) {
    try {
      appendInbox(row.company.id, { at: iso(now()), id: newId('n_'), position: row.position.id, ...entry });
    } catch (e) { log('duties: appendInbox failed: ' + e.message); }
  }
  function missed(row, key, trigger, dueAt, why) {
    line(row, { trigger: { ...trigger, due: iso(dueAt) }, ticket: null, state: 'missed', reason: why });
    inbox(row, { kind: 'flag', title: `${row.duty.title || row.duty.id} missed`,
      text: `${row.position.name || row.position.id}: "${row.duty.title || row.duty.id}" was due ${localStamp(dueAt)}; ${why}. It did not run.`,
      needsOwen: false });
  }

  function pump() {
    if (!started || stopped) return;
    const s = settings();
    const max = Math.max(1, Number.isInteger(s.maxConcurrentRuns) ? s.maxConcurrentRuns : DEFAULTS.maxConcurrentRuns);
    const tab = table();
    if (!tab) return;
    let changed = false;
    for (const item of queue.slice()) {
      if (running.size >= max) break;
      const row = tab.get(item.key);
      if (!isOn(row, s)) {
        if (!row || row.duty.enabled === false) { // gone or switched off: drop it (a pause keeps it waiting)
          queue = queue.filter((q) => q !== item);
          changed = true;
        }
        continue;
      }
      if (running.has(item.key)) continue;
      if (item.notBefore && item.notBefore > now()) continue;
      const pct = usagePct();
      const ceiling = Number.isFinite(s.usageCeilingPct) ? s.usageCeilingPct : DEFAULTS.usageCeilingPct;
      if (pct != null && pct >= ceiling) {
        if (!item.usageLogged) {
          item.usageLogged = true;
          changed = true;
          line(row, { trigger: { ...item.trigger, due: iso(item.due) }, ticket: null, state: 'skipped', reason: 'usage',
            usagePct: pct });
        }
        continue;
      }
      queue = queue.filter((q) => q !== item);
      changed = true;
      start(row, item);
    }
    if (changed) touch();
    save();
  }

  function dutyText(row, item) {
    const t = row.duty.trigger;
    const label = item.manual ? 'manual' : triggerLabel(t, item.events && item.events[0]);
    const head = `<helm-duty id="${attr(row.duty.id)}" trigger="${attr(label)}" due="${attr(localStamp(item.due))}">`;
    const body = [neutral(String(row.duty.prompt || '').trim())];
    if (item.note) body.push(item.note);
    const ev = eventText(item.events);
    if (ev) body.push(neutral(ev));
    return `${head}\n${body.join('\n\n')}\n</helm-duty>\n`
      + `End the run with duty_report (summary, needs_owen, files). Draft only; anything outward waits for ${ownerWords(opts.ownerName).owner}.`;
  }

  async function start(row, item) {
    const key = item.key;
    const rec = records[key] || (records[key] = { cursor: now() });
    rec.lastRunAt = now();
    touch();
    const slot = { ticket: null, startedAt: now(), timer: null, done: false };
    running.set(key, slot);
    const label = item.manual ? 'manual' : triggerLabel(row.duty.trigger, item.events && item.events[0]);
    const trigger = { ...item.trigger, due: iso(item.due), ...(item.catchUp ? { catchUp: true } : {}) };
    const finish = (result, why) => {
      if (slot.done) return;
      slot.done = true;
      if (slot.timer) T.clearTimeout(slot.timer);
      running.delete(key);
      persistRunning();
      const res = result || {};
      const ok = res.state !== 'failed' && !why;
      const reason = why || (ok ? undefined : clip(res.error || 'the run failed', 500));
      line(row, { trigger, ticket: slot.ticket, state: ok ? 'done' : 'failed', ...(reason ? { reason } : {}),
        ...(Number.isFinite(res.costUsd) ? { costUsd: res.costUsd } : {}) });
      const title = row.duty.title || row.duty.id;
      // a run that called duty_report already notified through it; every other end notifies here, once
      const tell = (what, detail) => {
        try {
          notify(teamEvent({ what, subject: title, detail, sessionId: res.sessionId,
            company: { id: row.company.id, name: row.company.name }, position: { id: row.position.id, name: row.position.name } }));
        } catch (e) { log('duties: notify failed: ' + (e && e.message)); }
      };
      if (!ok) {
        inbox(row, { kind: 'duty-report', title: `${title} failed`, text: clip(`${row.position.name || row.position.id}: ${reason}`), needsOwen: true });
        tell('duty-failed', reason);
      } else if (!res.reported) {
        const text = clip(String(res.finalText || '').trim() || '(the run ended without a reply)');
        inbox(row, { kind: 'duty-report', title, text, needsOwen: false });
        tell('duty', text);
      }
      save();
      pump();
    };
    let handle;
    try {
      if (typeof runDuty !== 'function') throw new Error('no runtime');
      handle = await runDuty({
        company: row.company.id, companyName: row.company.name, position: row.position.id, positionName: row.position.name,
        duty: { id: row.duty.id, title: row.duty.title || row.duty.id, trigger: label },
        text: dutyText(row, item), trigger: item.trigger, due: item.due, catchUp: !!item.catchUp, manual: !!item.manual,
      });
    } catch (e) {
      finish({ state: 'failed', error: e && e.message ? e.message : String(e) });
      return slot;
    }
    slot.ticket = (handle && handle.ticket) || null;
    line(row, { trigger, ticket: slot.ticket, state: 'started' });
    persistRunning();
    save();
    slot.timer = T.setTimeout(() => finish(null, 'no result after 2 h 15 min'), RUN_TIMEOUT_MS);
    slot.timer?.unref?.();
    Promise.resolve(handle && handle.done).then((r) => finish(r || { state: 'done' }), (e) => finish({ state: 'failed', error: e && e.message ? e.message : String(e) }));
    return slot;
  }

  function persistRunning() {
    const out = {};
    for (const [key, s] of running) if (s.ticket) out[key] = { ticket: s.ticket, startedAt: s.startedAt };
    try { state.set('dutyRunning', out); } catch {}
  }

  // ----- schedules -----
  function tick({ startup = false } = {}) {
    if (!started || stopped) return;
    const tab = table();
    if (!tab) return;
    syncTargets(tab);
    const s = settings();
    const t = now();
    for (const [key, row] of tab) {
      const trig = row.duty.trigger;
      let rec = records[key];
      if (!rec) { rec = records[key] = { cursor: t }; touch(); }
      if (!isOn(row, s)) {
        if (!rec.off) { rec.off = true; rec.nextAt = null; touch(); }
        continue;
      }
      if (rec.off) { rec.off = false; rec.cursor = t; touch(); } // back on: no fires for the time it was off
      if (trig.kind !== 'schedule') continue;
      if (rec.cron !== trig.cron) { if (rec.cron != null) rec.cursor = t; rec.cron = trig.cron; touch(); }
      const due = nextCronFire(trig.cron, rec.cursor);
      if (due == null) {
        if (rec.problem !== 'bad cron') { rec.problem = 'bad cron'; rec.nextAt = null; touch(); }
        continue;
      }
      if (rec.problem) { delete rec.problem; touch(); }
      if (due > t) { if (rec.nextAt !== due) { rec.nextAt = due; touch(); } continue; }
      // due now (or in the past)
      const prevCursor = rec.cursor;
      rec.cursor = t;
      rec.nextAt = nextCronFire(trig.cron, t);
      touch();
      const detail = trig.cron;
      if (queue.some((q) => q.key === key) || running.has(key)) continue; // the queued / running one covers it
      if (!startup && t - due <= LATE_MS) {
        enqueue(row, { trigger: { kind: 'schedule', detail }, due, catchUp: false });
        continue;
      }
      const why = startup ? 'Helm was closed' : 'Helm was asleep';
      const windowMs = catchUpWindowMs(trig.cron, due);
      const latest = latestFireWithin(trig.cron, prevCursor, t, windowMs);
      if (trig.catchUp === 'skip' || latest == null) {
        missed(row, key, { kind: 'schedule', detail }, latest || due,
          trig.catchUp === 'skip' ? `${why} (catch-up off)` : `${why} (outside the ${windowMs >= WEEK ? '7-day' : windowMs <= DAY ? '24-hour' : Math.round(windowMs / DAY) + '-day'} window)`);
        continue;
      }
      enqueue(row, { trigger: { kind: 'schedule', detail }, due: latest, catchUp: true,
        note: `This run was due ${localStamp(latest)}; ${why}.` });
    }
    for (const key of Object.keys(records)) if (!tab.has(key)) { delete records[key]; touch(); }
    pump();
    save();
  }

  // ----- public -----
  // team.updated / a settings change: re-read now instead of at the next tick
  function refresh() {
    if (!started || stopped) return;
    tick();
  }

  function start_() {
    if (started || stopped) return;
    started = true;
    if (opts.refsWatch !== false) {
      const make = typeof opts.refsWatch === 'function' ? opts.refsWatch : (o) => createRefsWatch(o);
      refsWatch = opts.refsWatch && typeof opts.refsWatch === 'object' ? opts.refsWatch // events via _onEvent
        : make({ state, onEvent, log, now, timers: opts.timers });
    }
    // runs that were in flight when Helm quit
    const was = state.get('dutyRunning') || {};
    const tab0 = table();
    for (const [key, r] of Object.entries(was)) {
      const row = tab0 && tab0.get(key);
      const done = row && typeof opts.resumeRun === 'function' ? opts.resumeRun(r.ticket) : null;
      if (!done) continue;
      const slot = { ticket: r.ticket, startedAt: r.startedAt, timer: null, done: false };
      running.set(key, slot);
      Promise.resolve(done).then((res) => {
        if (slot.done) return;
        slot.done = true;
        running.delete(key);
        persistRunning();
        const ok = res && res.state !== 'failed';
        line(row, { trigger: { kind: 'resumed', detail: 'in flight at restart' }, ticket: r.ticket, state: ok ? 'done' : 'failed',
          ...(ok ? {} : { reason: clip((res && res.error) || 'the run failed', 500) }) });
        save();
        pump();
      }, () => { slot.done = true; running.delete(key); persistRunning(); pump(); });
    }
    persistRunning();
    tick({ startup: true }); // also hands refs-watch its targets (baseline / catch-up check per repo)
    interval = T.setInterval(() => tick(), tickMs);
    interval?.unref?.();
  }

  function stop() {
    stopped = true;
    if (interval) { T.clearInterval(interval); interval = null; }
    for (const s of running.values()) if (s.timer) T.clearTimeout(s.timer);
    if (refsWatch && typeof opts.refsWatch !== 'object') refsWatch.stop();
    touch();
    save();
  }

  // "Run now" (team.duty.run): the owner asked, so it starts at once (no usage ceiling, no run cap of its own; the
  // runtime's machine-wide cap still orders the delivery). Refused for a paused / retired position or unknown duty.
  async function runNow(companyId, positionId, dutyId) {
    const err = (message, code) => Object.assign(new Error(message), { code });
    if (!started || stopped) throw err('duties are not running', 'unavailable');
    const tab = table();
    const key = keyOf(companyId, positionId, dutyId);
    const row = tab && tab.get(key);
    if (!row) throw err('no such duty', 'not_found');
    if ((row.position.status || 'active') !== 'active') throw err(`${row.position.name || positionId} is ${row.position.status}`, 'paused');
    const cur = running.get(key);
    if (cur) {
      if (cur.ticket) return { ticket: cur.ticket, already: true };
      throw err('this duty is starting', 'busy');
    }
    const queued = queue.find((q) => q.key === key);
    if (queued) queue = queue.filter((q) => q !== queued);
    const item = {
      id: newId('q_'), key, company: companyId, position: positionId, duty: dutyId,
      trigger: { kind: 'manual', detail: 'Run now' }, due: now(), catchUp: false, manual: true,
      note: null, events: queued ? queued.events : null, // a queued event run folds into this one
    };
    touch();
    const slot = await start(row, item);
    if (!slot.ticket) throw err((row.duty.title || dutyId) + ' could not start', 'failed');
    return { ticket: slot.ticket };
  }

  function info(companyId, positionId) {
    const out = {};
    const tab = table();
    if (!tab) return out;
    for (const [key, row] of tab) {
      if (row.company.id !== companyId || row.position.id !== positionId) continue;
      const rec = records[key] || {};
      out[row.duty.id] = {
        nextAt: rec.off ? null : rec.nextAt ?? null,
        lastRunAt: rec.lastRunAt ?? null,
        last: rec.last || null,
        queued: queue.some((q) => q.key === key),
        running: running.has(key) ? running.get(key).ticket || true : null,
        ...(rec.problem ? { problem: rec.problem } : {}),
      };
    }
    return out;
  }

  function nextDuty(companyId, positionId) {
    let best = null;
    const tab = table();
    if (!tab) return null;
    for (const [key, row] of tab) {
      if (row.company.id !== companyId || row.position.id !== positionId) continue;
      const rec = records[key];
      if (!rec || rec.off || !rec.nextAt) continue;
      if (!best || rec.nextAt < best.at) best = { id: row.duty.id, title: row.duty.title || row.duty.id, at: rec.nextAt };
    }
    return best;
  }

  // Window focus / system resume (9.4 re-arm): one cheap re-check of every watched repo; a resume also ticks at
  // once so a fire slept through is judged now rather than up to a minute later.
  function poke(reason) {
    if (!started || stopped) return;
    if (reason === 'resume') tick();
    if (refsWatch) refsWatch.poke(reason);
  }

  return {
    start: start_, stop, tick: () => tick(), refresh, runNow, info, nextDuty, poke,
    queue: () => queue.map((q) => ({ ...q })),
    watchStatus: () => (refsWatch && refsWatch.status ? refsWatch.status() : []), // Team view: "not a repo" etc.
    running: () => [...running].map(([key, s]) => ({ key, ticket: s.ticket, startedAt: s.startedAt })),
    _onEvent: onEvent, _refsWatch: () => refsWatch,
  };
}

module.exports = { createDuties, catchUpWindowMs, latestFireWithin, cronPeriodMs, eventText, mergeEvents,
  TICK_MS, LATE_MS, DEFAULTS };
