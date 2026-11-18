'use strict';
// Positions runtime (docs/POSITIONS.md sections 5 and 8.3): tickets, delivery queues, the wait-for graph, sync
// budgets, chain caps and expiry, late answers, the cross-talk log and the rollover driver. Pure engine logic: it
// never touches claude.exe itself, only Helm sessions through the narrow surface below, so the tests drive it with
// fake sessions and a fake clock.
//
// A ticket is one question (an ask from the CEO, a manager or a colleague, or a duty run). It is persisted until it
// settles (team-state.json slice 'tickets'), so it survives a restart and is delivered as a late answer.
//
//   queued     waiting for the answerer's chat to be free (5.3). Never injected while the owner is mid-conversation.
//   delivered  the question was sent into the answerer's current chat; the answer is that turn's final text.
//              `late: true` once the chain passed its 2 h expiry while it was still being worked on.
//   answered | cancelled | expired   settled.
//
// The asker side (`asker`): 'waiting' while a tool call waits in-call (team_ask / colleague_ask / team_ticket);
// 'received' when it got the answer in-call; 'pending' when the call returned pending (the answer then arrives in
// its chat as a <helm-answer> turn); 'stopped' when the owner pressed Stop (no turn: an answer card instead); 'lost' when
// Helm restarted mid-call (a late-answer turn, like pending); 'none' for duty runs (duties.js gets the result).
//
// createRuntime({
//   store,        T1 team store: getCompany(cid), listPositions(cid), getPosition(cid, pid),
//                 append(cid, 'crosstalk', line), readLog(cid, 'crosstalk', { since, limit, filter })
//   sessions: {
//     get(sessionId) -> es | null                 any Helm session (CEO chats, position chats)
//     current(cid, pid) -> es | null              the position's current chat if it exists (never creates one)
//     open(cid, pid) -> Promise<es>               the position's current chat, created lazily (8.2)
//     isViewed(sessionId) -> boolean              its tab is on some client's screen (index.js viewedBy)
//     ownerActiveAt?(es) -> ms                    the owner's last send / draft keystroke there (default es.lastActiveAt)
//     positionTurnsRunning?() -> n                position turns running machine-wide (default: this runtime's own)
//     addCard?(sessionId, item)                   a Helm item in a chat, no turn (answer card after Stop, 5.5)
//     handoff?(es, prompt) -> Promise<{ text }>   handoff.js with a prompt (8.3)
//     endChat?({ company, position, sessionId, handoff, error, contextPct, reason }) -> Promise  chats.json + archive
//   }
//   state?: { get(name), set(name, value) }      team-state.json slices (in memory when absent)
//   emit?(event, payload)                        'team.ask.updated' | 'team.updated'
//   inbox?(cid, entry)                           inbox.jsonl line (a failed rollover)
//   settings?() -> { maxConcurrentRuns }
//   exists?(path) -> boolean                     handed paths must exist (default fs.existsSync)
//   readArea?(cid, pid) -> powers | null         a position's read area as the guard sees it (wire.js powersFor:
//                                                tree.effective + worktree + onboarding reads). Default:
//                                                store.effectivePowers(cid, pid) with the company folders. A position
//                                                may hand only paths inside it (fix 2); null = it cannot hand any.
//   clock?: { now, setTimeout, clearTimeout, setInterval, clearInterval }
//   tickMs?, rollPct?, ceilingPct?, log?(level, msg)
// })
//
// The session surface used (EngineSession, main/engine/session.js): s.id, s.status, s.costUsd, s.context.percent,
// s.position, turnActive, starting, compacting, closing, requests (Map), pendingQueue (array), turnWaiters (array,
// the one-shot turn-end waiters handoff.js uses), lastActiveAt, items, ensureLoaded(), send({ text, origin, team }).
// A message Helm sends is origin 'helm' (prod-guard never counts it as the owner's) and carries `team` = the user item's
// PROTOCOL fields ({ origin: 'ask'|'duty'|'answer', ask?, duty?, answer? }).

const crypto = require('crypto');
const fs = require('fs');
const { finalText } = require('../handoff');
const S = require('./schema');
const { ownerWords } = require('./owner');

// guard.js's path area (realResolve + area().canRead): a handed path is checked exactly as the guard checks a read.
let guardLib = null;
const guard = () => guardLib || (guardLib = require('./guard'));

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

// 5.6 (Decided): shown in the Team view footer.
const LIMITS = Object.freeze({
  asksPerPositionHour: 20,
  asksPerCompanyDay: 200,
  openSubAsksPerTicket: 3,
  ticketsPerChain: 8,
  expiryMs: 2 * HOUR,
  minWaitS: 30,
  maxWaitS: 600,
  defaultWaitCeoS: 300,
  defaultWaitPositionS: 180,
  chainMarginS: 45,
  serverTimeoutMs: 660_000,
  questionChars: 20_000,
  colleagueQuestionChars: 2_000,
  handedMax: 20,
  colleagueHandedMax: 3,
  answerChars: 20_000,
  followupWindowMs: DAY,
  maxConcurrentRuns: 2,
});

const OWNER_QUIET_MS = 90_000;        // 5.3 rule 2: no send / draft from the owner in the position's on-screen tab
const ASKER_QUIET_MS = 15_000;        // a late answer into a CEO chat waits only for the owner to stop typing there
const ROLL_QUIET_MS = 120_000;        // 8.3: a soft roll waits for the owner to be away from the tab this long
const ROLL_PCT = 32, CEILING_PCT = 40; // ui/lib/context-limits.js (the same numbers; see rollThresholds below)
const KEEP_SETTLED_MS = DAY;          // settled tickets stay for team_ticket / ask_followup / rate counts
const TICK_MS = 5_000;
const ATTEMPTS = 2;                   // a failed answer turn (CLI died) is delivered once more

const OPEN = new Set(['queued', 'delivered']);
const CLASS_RANK = { answer: 0, report: 1, colleague: 2, duty: 3 }; // 5.3 order (the owner's own messages go first)

const ROLL_PROMPT = 'Your chat is full and a fresh one starts next. First record in notebook.md (notebook_add or '
  + 'Edit) every decision, fact and open item from this chat that is not there yet. Then reply with a handoff under '
  + '250 words: Done, In progress, Waiting on (tickets), Next.';

const pendingNote = (w) => `Tell ${w.owner} it is pending. The answer will arrive in this chat as a Helm message. Carry on.`;
const PENDING_NOTE_POSITION = 'It is pending. The answer will arrive in your chat as a Helm message. Answer with what '
  + 'you have and say what is still pending; use ask_followup if the late answer changes what you said.';
const SHORT_BUDGET_NOTE = 'Too little time left in this chain to wait. Answer with what you have and say what is '
  + 'still pending. Helm will hand you the late answer; use ask_followup if it changes what you said.';

function realClock() {
  const unref = (t) => { if (t && t.unref) t.unref(); return t; };
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => unref(setTimeout(fn, ms)),
    clearTimeout: (t) => clearTimeout(t),
    setInterval: (fn, ms) => unref(setInterval(fn, ms)),
    clearInterval: (t) => clearInterval(t),
  };
}

function memoryState() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => { m.set(k, v); } };
}

const clip = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n).trimEnd() + '\n…' : t;
};
const attr = (s) => String(s == null ? '' : s).replace(/["<>\r\n]+/g, ' ').trim();
// The body of a <helm-answer> / <helm-ask> block is quoted data: a position's (or an asker's) text can never close
// the block early or forge a tag of its own. & first, so an "&lt;" already in the text survives as written.
const quote = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 40s | 6m | 1h52m
function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
}

function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// The thresholds: 32 / 40 from the user's rule; a test-only override (HELM_TEST_TEAM_ROLL_PCT, passed in by the
// engine in --test runs only) lowers both so a live check can roll a tiny chat.
function rollThresholds(rollPct, ceilingPct) {
  const r = Number.isFinite(rollPct) && rollPct > 0 ? rollPct : ROLL_PCT;
  const c = Number.isFinite(ceilingPct) && ceilingPct > 0 ? ceilingPct : (r === ROLL_PCT ? CEILING_PCT : r + (CEILING_PCT - ROLL_PCT));
  return { roll: r, ceiling: Math.max(c, r) };
}

function newId(prefix, taken) {
  for (;;) {
    const id = `${prefix}_${crypto.randomBytes(3).toString('hex')}`;
    if (!taken || !taken(id)) return id;
  }
}

function createRuntime(opts = {}) {
  const store = opts.store;
  if (!store) throw new Error('createRuntime: store is required');
  const sessions = opts.sessions || {};
  const clock = opts.clock || realClock();
  const state = opts.state || memoryState();
  const emitRaw = typeof opts.emit === 'function' ? opts.emit : () => {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const settingsOf = typeof opts.settings === 'function' ? opts.settings : () => ({});
  const ow = () => ownerWords(opts.ownerName); // string or getter, read per message ('the owner' when empty)
  const exists = typeof opts.exists === 'function' ? opts.exists : (p) => { try { return fs.existsSync(p); } catch { return false; } };
  const tickMs = opts.tickMs || TICK_MS;
  const TH = rollThresholds(opts.rollPct, opts.ceilingPct);
  const now = () => clock.now();
  const iso = (ms) => new Date(ms == null ? now() : ms).toISOString();

  const tickets = new Map();     // id -> ticket (persisted)
  const outbox = [];             // late deliveries into an asker's chat (persisted)
  const waiters = new Map();     // ticket id -> Set({ deadline, done(reason) }) the asker's live in-call waits
  const watchers = new Map();    // ticket id -> Set(...) anyone else's team_ticket wait (no effect on the asker)
  const running = new Map();     // ticket id -> { sessionId } an answer turn this runtime started and is waiting on
  const turnCause = new Map();   // session id -> { ticket } the late answer that started its current turn
  const delivering = new Set();  // target keys with a send in flight
  const starting = new Set();    // position keys with a send in flight: a run about to start (counts against the cap)
  const rolling = new Set();     // position keys with a rollover running (their queue holds, 8.3)
  const rolls = new Map();       // position key -> { hard, pct } roll pending at the next quiet moment
  const waitingOn = new Map();   // session id -> text (e.g. waiting for the owner's OK on an access request)
  const listeners = new Map();   // event -> Set(fn) ('settled', 'updated')
  let tickTimer = null;
  let started = false;
  let stopped = false;
  let loaded = false; // prime(): the persisted tickets are in memory
  let kicking = false;
  let again = false;

  // ---------- small helpers ----------
  const keyOf = (cid, pid) => `${cid}/${pid}`;
  const posOf = (cid, pid) => { try { return store.getPosition(cid, pid) || null; } catch { return null; } };
  const livePositions = (cid) => { try { return store.listPositions(cid) || []; } catch { return []; } };
  const companyName = (cid) => { try { const c = store.getCompany(cid); return (c && c.name) || cid; } catch { return cid; } };
  const nameOf = (cid, pid) => { const p = posOf(cid, pid); return (p && p.name) || pid; };
  const isOpen = (t) => !!t && OPEN.has(t.state);
  const liveWaiters = (id) => { const w = waiters.get(id); return w ? w.size : 0; };
  // The .catch of every promise the runtime starts and does not await (a send, a roll, a turn-end waiter): a failure
  // there is logged, never an unhandled rejection.
  const logged = (what) => (e) => { try { log('error', `team runtime: ${what} failed: ${(e && (e.stack || e.message)) || e}`); } catch {} };

  function on(ev, fn) {
    if (!listeners.has(ev)) listeners.set(ev, new Set());
    listeners.get(ev).add(fn);
    return () => listeners.get(ev).delete(fn);
  }
  function fire(ev, arg) {
    const set = listeners.get(ev);
    if (!set) return;
    for (const fn of [...set]) { try { fn(arg); } catch (e) { log('warn', `team runtime: ${ev} listener failed: ${e.message}`); } }
  }

  // ---------- persistence ----------
  function persist() {
    const list = [...tickets.values()].map((t) => {
      const c = { ...t };
      if (c.asker === 'waiting') c.asker = 'lost'; // a live wait never survives a restart
      return c;
    });
    try {
      state.set('tickets', list);
      state.set('teamOutbox', outbox.slice());
    } catch (e) { log('warn', `team runtime: saving tickets failed: ${e.message}`); }
  }

  function load() {
    let list = [];
    let box = [];
    try { list = state.get('tickets') || []; } catch { list = []; }
    try { box = state.get('teamOutbox') || []; } catch { box = []; }
    for (const t of Array.isArray(list) ? list : []) {
      if (!t || typeof t.id !== 'string' || !t.company) continue;
      if (t.asker === 'waiting') t.asker = 'lost';
      if (t.state === 'delivered') t.recover = true; // its turn may have survived in the broker, or ended meanwhile
      tickets.set(t.id, t);
    }
    for (const o of Array.isArray(box) ? box : []) if (o && o.ticket && o.text) outbox.push(o);
  }

  // ---------- the cross-talk log (2.6: one line per state change) ----------
  function logLine(t, st, extra = {}) {
    const line = {
      at: iso(), ticket: t.id, ...(t.parentTicket ? { parentTicket: t.parentTicket } : {}), chain: t.chain,
      from: { kind: t.from.kind, ...(t.from.id ? { id: t.from.id } : {}), ...(t.from.sessionId ? { sessionId: t.from.sessionId } : {}) },
      to: t.to, kind: t.kind, state: st, ...extra,
    };
    try { store.append(t.company, 'crosstalk', line); } catch (e) { log('warn', `team runtime: crosstalk log failed (${t.id}): ${e.message}`); }
  }

  // ---------- tree (from position.json parent fields) ----------
  function treeOf(cid) {
    const list = livePositions(cid).filter((p) => p && p.status !== 'retired');
    const byId = new Map(list.map((p) => [p.id, p]));
    const reports = (id) => list.filter((p) => (p.parent || null) === (id || null)).map((p) => p.id);
    const ancestors = (id) => {
      const out = [];
      const seen = new Set([id]);
      let cur = byId.get(id);
      while (cur && cur.parent && !seen.has(cur.parent)) { out.push(cur.parent); seen.add(cur.parent); cur = byId.get(cur.parent); }
      return out;
    };
    const inSubtree = (id, root) => (root == null ? byId.has(id) : ancestors(id).includes(root));
    return { byId, reports, ancestors, inSubtree };
  }

  // ---------- chains ----------
  const chainTickets = (chain) => [...tickets.values()].filter((t) => t.chain === chain);
  const children = (id) => [...tickets.values()].filter((t) => t.parentTicket === id);
  const parentOf = (t) => (t && t.parentTicket ? tickets.get(t.parentTicket) || null : null);

  // The ask a session's current turn is answering (open and delivered there).
  function answering(sessionId) {
    if (!sessionId) return null;
    for (const t of tickets.values()) if (t.state === 'delivered' && t.delivery && t.delivery.sessionId === sessionId) return t;
    return null;
  }

  // The live sync deadline of a ticket: the latest of its in-call waits. null when nobody waits in-call.
  function syncDeadline(id) {
    const w = waiters.get(id);
    if (!w || !w.size) return null;
    let d = 0;
    for (const x of w) d = Math.max(d, x.deadline);
    return d;
  }

  // Wait-for edges: an open ticket whose asker (a position) is still waiting on it: a live in-call wait, or its
  // asker's current answer turn depends on it (its parent is still open and being answered by the asker).
  function edges(cid) {
    const out = [];
    for (const t of tickets.values()) {
      if (t.company !== cid || !isOpen(t) || t.from.kind !== 'position' || t.kind === 'duty') continue;
      const p = parentOf(t);
      const live = liveWaiters(t.id) > 0 || (p && isOpen(p) && p.to === t.from.id);
      if (live) out.push({ from: t.from.id, to: t.to, ticket: t.id });
    }
    return out;
  }

  // Path of positions from `start` to `goal` through the wait-for graph (BFS), or null.
  function pathTo(cid, start, goal) {
    const es = edges(cid);
    const prev = new Map([[start, null]]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === goal) {
        const path = [];
        for (let x = cur; x != null; x = prev.get(x)) path.unshift(x);
        return path;
      }
      for (const e of es) if (e.from === cur && !prev.has(e.to)) { prev.set(e.to, cur); queue.push(e.to); }
    }
    return null;
  }

  // P's chain as the line of askers above it: the positions waiting, directly or through others, on P's answer.
  // Returns [nearest .. root] position ids (the CEO is not a position and can't be asked).
  function askerLine(parent) {
    const out = [];
    for (let t = parent; t; t = parentOf(t)) if (t.from.kind === 'position' && t.from.id) out.push(t.from.id);
    return out;
  }

  // ---------- state words ----------
  function stateWords(t, depth = 0) {
    if (t.state === 'queued') return `queued: ${t.queueReason || `waiting for ${t.toName} to be free`}`;
    if (t.state === 'delivered') {
      const late = t.late ? 'late: ' : '';
      const wait = t.delivery && waitingOn.get(t.delivery.sessionId);
      if (wait) return `${late}${wait}`;
      const kid = children(t.id).filter(isOpen).sort((a, b) => a.askedAt - b.askedAt)[0];
      if (kid && depth < 6) return `${late}waiting on ${kid.toName}`;
      return `${late}working ${dur(now() - (t.deliveredAt || t.askedAt))}`;
    }
    if (t.state === 'answered') return `answered in ${dur((t.settledAt || now()) - t.askedAt)}${t.late ? ' (late)' : ''}`;
    if (t.state === 'cancelled') return `cancelled${t.reason ? `: ${t.reason}` : ''}`;
    if (t.state === 'expired') return 'expired';
    return t.state;
  }

  // "Legal is waiting on Tax Specialist (working 4m)": where an open chain stands, in words.
  function whereWords(t) {
    let cur = t;
    const names = [];
    for (let i = 0; i < 8 && cur; i++) {
      if (cur.state !== 'delivered') break;
      const kid = children(cur.id).filter(isOpen).sort((a, b) => a.askedAt - b.askedAt)[0];
      if (!kid) break;
      names.push(cur.toName);
      cur = kid;
    }
    if (!names.length) return `${t.toName}: ${stateWords(t)}`;
    const tail = cur.state === 'queued' ? stateWords(cur) : stateWords(cur).replace(/^late: /, '');
    return `${names[0]} is waiting on ${[...names.slice(1), cur.toName].join(' → ')} (${tail})`;
  }

  // PROTOCOL "Ticket states": asked (queued) · delivered · pending (the asker's call returned, the ticket goes on)
  // · answered · late (answered after its caller stopped waiting, or past expiry and still worked on) · expired ·
  // cancelled (refused asks never become tickets; they are only logged).
  function displayState(t) {
    if (isOpen(t)) {
      if (t.late) return 'late';
      if (t.asker === 'pending' || t.asker === 'lost' || t.asker === 'stopped') return 'pending';
      return t.state === 'queued' ? 'asked' : 'delivered';
    }
    if (t.state === 'answered' && (t.late || t.answeredLate)) return 'late';
    return t.state;
  }

  function snapshot(chain) {
    const at = now();
    return chainTickets(chain).sort((a, b) => a.askedAt - b.askedAt).map((x) => ({
      ticket: x.id, parentTicket: x.parentTicket || null, to: x.to, name: x.toName, state: displayState(x),
      detail: stateWords(x), sinceMs: Math.max(0, at - (x.stateAt || x.askedAt)),
    }));
  }

  function sessionIdsOf(chain) {
    const ids = new Set();
    for (const x of chainTickets(chain)) {
      if (x.from.sessionId) ids.add(x.from.sessionId);
      if (x.delivery && x.delivery.sessionId) ids.add(x.delivery.sessionId);
    }
    return [...ids];
  }

  function emitTicket(t) {
    try {
      // PROTOCOL team.ask.updated (+ kind, parentTicket, toolUseId: the tool item to patch, when the CLI told us)
      emitRaw('team.ask.updated', {
        company: t.company, ticket: t.id, chainId: t.chain, state: displayState(t), detail: stateWords(t),
        from: { kind: t.from.kind, ...(t.from.id ? { id: t.from.id } : {}), name: t.from.name }, to: t.to, toName: t.toName,
        chain: snapshot(t.chain), sessionIds: sessionIdsOf(t.chain),
        kind: t.kind, parentTicket: t.parentTicket || null, toolUseId: t.toolUseId || null,
      });
    } catch (e) { log('warn', `team runtime: emit failed: ${e.message}`); }
    fire('updated', t);
  }

  function setState(t, st) {
    t.state = st;
    t.stateAt = now();
  }

  // ---------- results returned to a tool call ----------
  function subtreeSummary(t) {
    return children(t.id).sort((a, b) => a.askedAt - b.askedAt).map((k) => ({
      ticket: k.id, to: k.to, name: k.toName, state: displayState(k),
      ...(k.state === 'answered' ? { took_s: Math.round((k.tookMs || 0) / 1000) } : {}),
      ...(children(k.id).length ? { chain: subtreeSummary(k) } : {}),
    }));
  }

  function resultOf(t, { short = false } = {}) {
    if (t.state === 'answered') {
      return { status: 'answered', ticket: t.id, from: t.to, answer: t.answer || '', took_s: Math.round((t.tookMs || 0) / 1000), ...(t.late ? { late: true } : {}), chain: subtreeSummary(t) };
    }
    if (t.state === 'cancelled') return { status: 'cancelled', ticket: t.id, reason: t.reason || 'cancelled', ...(t.answer ? { partial: t.answer } : {}) };
    if (t.state === 'expired') return { status: 'expired', ticket: t.id, reason: t.reason || 'No answer 2 h after it was asked.' };
    const st = stateWords(t);
    const where = whereWords(t);
    const note = short ? SHORT_BUDGET_NOTE : t.from.kind === 'position' ? PENDING_NOTE_POSITION : pendingNote(ow());
    return { status: 'pending', ticket: t.id, state: st, ...(where !== `${t.toName}: ${st}` ? { where } : {}), note };
  }

  // ---------- in-call waits ----------
  // Resolves 'settled' | 'timeout' | 'aborted'. An asker's wait (mine) makes the asker 'waiting' and sets the live
  // sync deadline its sub-asks are clamped by; when it ends without the answer the asker side changes at once (so an
  // answer landing a moment later is never lost between the two). Anyone else's wait (a manager reading a subtree
  // ticket) only watches.
  function waitOn(t, ms, signal, mine = true) {
    if (!isOpen(t)) return Promise.resolve('settled');
    if (signal && signal.aborted) { if (mine) afterWait(t, 'aborted'); return Promise.resolve('aborted'); }
    if (!(ms > 0)) { if (mine) afterWait(t, 'timeout'); return Promise.resolve('timeout'); }
    const map = mine ? waiters : watchers;
    return new Promise((resolve) => {
      let timer = null;
      const w = { deadline: now() + ms, done: null };
      const finish = (why) => {
        if (!w.done) return;
        w.done = null;
        if (timer) clock.clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        const set = map.get(t.id);
        if (set) { set.delete(w); if (!set.size) map.delete(t.id); }
        if (mine && why !== 'settled') afterWait(t, why);
        resolve(why);
      };
      const onAbort = () => finish('aborted');
      w.done = finish;
      if (!map.has(t.id)) map.set(t.id, new Set());
      map.get(t.id).add(w);
      if (mine && t.asker !== 'none') t.asker = 'waiting';
      timer = clock.setTimeout(() => finish('timeout'), ms);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // After an in-call wait ended without the answer: what the asker side becomes.
  function afterWait(t, why) {
    if (stopped) return; // Helm is quitting: a live wait is persisted as 'lost'
    if (!isOpen(t) || liveWaiters(t.id) > 0 || t.asker === 'none') return;
    if (why === 'aborted') {
      // 5.5 (Decided): Stop keeps the ticket but starts no new turn; the answer comes as a card.
      t.asker = 'stopped';
    } else if (t.asker !== 'pending') {
      t.asker = 'pending';
      logLine(t, 'pending', { reason: stateWords(t) });
    }
    persist();
    emitTicket(t);
  }

  // ---------- asking ----------
  function refuse(base, reason) {
    const id = newId('t', (x) => tickets.has(x));
    const line = {
      at: iso(), ticket: id, chain: base.chain || id, ...(base.parentTicket ? { parentTicket: base.parentTicket } : {}),
      from: { kind: base.from.kind, ...(base.from.id ? { id: base.from.id } : {}), ...(base.from.sessionId ? { sessionId: base.from.sessionId } : {}) },
      to: base.to, kind: base.kind, state: 'refused', question: clip(base.question, LIMITS.questionChars), reason,
    };
    if (base.company) { try { store.append(base.company, 'crosstalk', line); } catch (e) { log('warn', `team runtime: crosstalk log failed: ${e.message}`); } }
    return { status: 'refused', reason };
  }

  // A position's read area as the guard sees it (opts.readArea), else its effective powers from the store. null when
  // it cannot be worked out.
  function readPowers(cid, pid) {
    try {
      if (typeof opts.readArea === 'function') return opts.readArea(cid, pid) || null;
      if (typeof store.effectivePowers !== 'function') return null;
      const eff = store.effectivePowers(cid, pid);
      if (!eff) return null;
      const c = store.getCompany(cid) || {};
      const pos = posOf(cid, pid) || {};
      return { ...eff, companyFolders: c.folders || [], scopeFolder: (pos.scope && pos.scope.folder) || null };
    } catch (e) {
      log('warn', `team runtime: the read area of ${cid}/${pid} failed: ${e.message}`);
      return null;
    }
  }

  // Handed paths become a ticket-scoped read for the answerer (guard.js handedReads), so an asker hands only what it
  // can read itself: a position, its own read area (and what was handed to the ask it is answering); the CEO, the
  // owner's own session, anything inside the company folders. Paths are compared resolved (absolute, '..' folded,
  // links followed, case-insensitive on Windows) and are stored in that form, so the grant is exactly what passed.
  // -> { paths } | { error }
  function handedArea(cid, company, from, parent, list) {
    if (!list.length) return { paths: [] };
    let G, real, A;
    try {
      G = guard();
      real = list.map((x) => G.realResolve(S.expandHome(x)));
    } catch (e) { return { error: `Helm could not check the handed paths (${e.message}); none were handed.` }; }
    let powers;
    const position = from.kind === 'position';
    if (position) {
      powers = readPowers(cid, from.id);
      if (!powers) return { error: 'Helm could not work out what you may read, so you cannot hand files. Put what the answerer needs in the question.' };
      const passed = parent && Array.isArray(parent.handed) ? parent.handed : [];
      if (passed.length) powers = { ...powers, read: [...(Array.isArray(powers.read) ? powers.read : []), ...passed] };
    } else {
      powers = { read: (company && Array.isArray(company.folders)) ? company.folders : [] };
    }
    try { A = G.area(powers); } catch (e) { return { error: `Helm could not check the handed paths (${e.message}); none were handed.` }; }
    const outside = list.filter((x, i) => !A.canRead(real[i]));
    if (outside.length) {
      return { error: position
        ? `You can hand only files you can read yourself. Outside your read area: ${outside.join(', ')}. Put what the answerer needs in the question instead.`
        : `Handed paths must be inside the company folders (${((company && company.folders) || []).join(', ') || 'none'}). Outside: ${outside.join(', ')}` };
    }
    const seen = new Set();
    return { paths: real.filter((x) => { const k = S.pathKey(x); if (seen.has(k)) return false; seen.add(k); return true; }) };
  }

  function countRecent(pred, windowMs) {
    const since = now() - windowMs;
    let n = 0;
    for (const t of tickets.values()) if (t.askedAt >= since && pred(t)) n++;
    return n;
  }

  // Validates and creates a ticket. -> { ticket } | { refused: { status: 'refused', reason } }
  function createTicket(p) {
    const cid = p.company;
    const kind = p.kind === 'colleague' ? 'colleague' : 'report';
    const from = p.from || {};
    const to = String(p.to || '').trim();
    const question = String(p.question == null ? '' : p.question).trim();
    let handed = Array.isArray(p.handed) ? p.handed.map((x) => String(x).trim()).filter(Boolean) : [];
    const parent = from.kind === 'position' ? answering(from.sessionId) : null;
    const base = { company: cid, from, to, kind, question, chain: parent ? parent.chain : null, parentTicket: parent ? parent.id : null };
    const no = (reason) => ({ refused: refuse(base, reason) });

    let company = null;
    try { company = cid ? store.getCompany(cid) : null; } catch { company = null; }
    if (!company) return { refused: { status: 'refused', reason: 'This chat is not in a company.' } };
    const tree = treeOf(cid);
    const target = posOf(cid, to);
    if (!to || !target) return no(`No position "${to}" in ${companyName(cid)}.`);
    if (target.status === 'retired') return no(`${target.name} is retired.`);
    if (target.status === 'paused') return no(`${target.name} is paused. ${ow().Owner} can resume it in Team view.`);
    if (from.kind === 'position' && from.id === to) return no('You cannot ask yourself.');
    const callerId = from.kind === 'position' ? from.id : null;
    if (kind === 'report') {
      if ((target.parent || null) !== callerId) {
        if (tree.inSubtree(to, callerId)) {
          const mgr = target.parent ? nameOf(cid, target.parent) : 'the CEO';
          // go through the caller's own report on the path down (for a grandchild that is the manager itself)
          const via = [to, ...tree.ancestors(to)].find((id) => ((tree.byId.get(id) || {}).parent || null) === callerId) || target.parent;
          return no(`${target.name} reports to ${mgr}, not to you. Ask ${nameOf(cid, via)} (team_ask to "${via}"); the chain of command is real.`);
        }
        return no(`${target.name} is not your report.${from.kind === 'position' ? ' For one narrow question use colleague_ask.' : ''}`);
      }
    } else {
      if (from.kind !== 'position') return no('colleague_ask is for positions; ask your reports with team_ask.');
      if ((target.parent || null) === callerId) return no(`${target.name} is your report: use team_ask.`);
    }
    if (!question) return no('The question is empty.');
    const qMax = kind === 'colleague' ? LIMITS.colleagueQuestionChars : LIMITS.questionChars;
    if (question.length > qMax) return no(`The question is ${question.length} characters; the limit is ${qMax}${kind === 'colleague' ? ' for a colleague (one narrow question)' : ''}.`);
    const hMax = kind === 'colleague' ? LIMITS.colleagueHandedMax : LIMITS.handedMax;
    if (handed.length > hMax) return no(`At most ${hMax} handed paths${kind === 'colleague' ? ' for a colleague' : ''}.`);
    const relative = handed.filter((x) => !S.isAbsoluteAny(S.expandHome(x)));
    if (relative.length) return no(`Handed paths must be absolute: ${relative.join(', ')}`);
    const missing = handed.filter((x) => !exists(S.expandHome(x)));
    if (missing.length) return no(`Handed paths must exist: ${missing.join(', ')}`);
    const placed = handedArea(cid, company, from, parent, handed);
    if (placed.error) return no(placed.error);
    handed = placed.paths;

    // 5.6 limits
    if (from.kind === 'position' && countRecent((t) => t.kind !== 'duty' && t.from.kind === 'position' && t.from.id === from.id && t.company === cid, HOUR) >= LIMITS.asksPerPositionHour) {
      return no(`Rate limit: at most ${LIMITS.asksPerPositionHour} asks per position per hour.`);
    }
    if (countRecent((t) => t.kind !== 'duty' && t.company === cid, DAY) >= LIMITS.asksPerCompanyDay) {
      return no(`Rate limit: at most ${LIMITS.asksPerCompanyDay} asks per company per day.`);
    }
    if (parent) {
      if (chainTickets(parent.chain).length >= LIMITS.ticketsPerChain) return no(`Chain too long: at most ${LIMITS.ticketsPerChain} tickets in one chain. Answer with what you have.`);
      if (children(parent.id).filter(isOpen).length >= LIMITS.openSubAsksPerTicket) return no(`At most ${LIMITS.openSubAsksPerTicket} open sub-asks per question. Wait for one, or answer with what you have.`);
    }
    // 5.6 cycles: Q already waits on P, in P's own line of askers or anywhere in the wait-for graph.
    if (callerId) {
      const line = askerLine(parent);
      let through = null;
      const at = line.indexOf(to);
      if (at >= 0) through = line.slice(0, at).reverse();
      else {
        const path = pathTo(cid, to, callerId);
        if (path) through = path.slice(1, -1);
      }
      if (through) {
        const via = through.length ? ` (through ${through.map((x) => nameOf(cid, x)).join(', ')})` : '';
        return no(`${target.name} is waiting on you${via}. Answer with what you have.`);
      }
    }

    const id = newId('t', (x) => tickets.has(x));
    const t = {
      id, company: cid, chain: parent ? parent.chain : id, parentTicket: parent ? parent.id : null,
      from: { kind: from.kind, ...(from.id ? { id: from.id } : {}), ...(from.sessionId ? { sessionId: from.sessionId } : {}), name: from.name || (from.kind === 'ceo' ? `CEO (${companyName(cid)})` : from.id ? nameOf(cid, from.id) : ow().Owner) },
      to, toName: target.name || to, kind, question, handed,
      state: 'queued', stateAt: now(), askedAt: now(), rootAskedAt: parent ? parent.rootAskedAt || parent.askedAt : now(),
      // 'waiting' until ask() starts its in-call wait (or returns pending at once): the first event says asked
      asker: 'waiting', attempts: 0, ...(p.toolUseId ? { toolUseId: p.toolUseId } : {}),
    };
    tickets.set(id, t);
    logLine(t, 'asked', { question: clip(question, LIMITS.questionChars), ...(handed.length ? { handed } : {}) });
    return { ticket: t, parent };
  }

  // The sync budget of a new ask (5.7): its own wait_s, clamped by the parent's live in-call deadline minus 45 s.
  function budgetMs(p, parent) {
    const def = p.from && p.from.kind === 'ceo' ? LIMITS.defaultWaitCeoS : LIMITS.defaultWaitPositionS;
    const raw = Number(p.waitS);
    const own = Math.min(LIMITS.maxWaitS, Math.max(LIMITS.minWaitS, Number.isFinite(raw) && raw > 0 ? raw : def)) * 1000;
    const dl = parent ? syncDeadline(parent.id) : null;
    if (dl == null) return { ms: own, short: false };
    const left = dl - now() - LIMITS.chainMarginS * 1000;
    const ms = Math.min(own, left);
    if (ms < LIMITS.minWaitS * 1000) return { ms: 0, short: true };
    return { ms, short: false };
  }

  // team_ask / colleague_ask. -> answered | pending | refused | cancelled | expired (the tool result object)
  async function ask(p = {}) {
    const again = sameCall(p);
    if (again) return resumeAsk(again, p);
    const made = createTicket(p);
    if (made.refused) return made.refused;
    const t = made.ticket;
    const budget = budgetMs(p, made.parent);
    if (!budget.short) t.waitUntil = now() + budget.ms; // where a resumed call's wait ends (resumeAsk)
    persist();
    emitTicket(t);
    if (budget.short) {
      afterWait(t, 'timeout');
      kick();
      return resultOf(t, { short: true });
    }
    const wait = waitOn(t, budget.ms, p.signal);
    kick();
    const why = await wait;
    if (why === 'settled') { if (t.asker !== 'none') t.asker = 'received'; persist(); }
    return resultOf(t);
  }

  // Keep-through-restart: a CEO or position chat's CLI kept running while Helm restarted is still inside the
  // team_ask / colleague_ask it was waiting on, and the broker re-delivers that unanswered call to this Helm
  // (broker.js). The same tool call (same tool_use id, same asker) is not a new question: it takes up its own ticket.
  function sameCall(p) {
    if (!p || !p.toolUseId) return null;
    const from = p.from || {};
    for (const t of tickets.values()) {
      if (t.toolUseId !== p.toolUseId || t.company !== p.company || t.kind === 'duty' || !t.from || t.from.kind !== from.kind) continue;
      if (from.kind === 'position' ? t.from.id === from.id : t.from.sessionId === from.sessionId) return t;
    }
    return null;
  }

  // Waits again until the original call's deadline. Already settled (answered while Helm was away): the answer goes
  // back in this call and the late-answer turn it would have started is dropped. The deadline passed: pending, as at
  // the end of any wait (the answer then arrives as a late answer).
  async function resumeAsk(t, p) {
    log('info', `team runtime: ${t.id} was asked again by the same tool call after a restart (${t.asker}, ${t.state}): taking it up again`);
    if (!isOpen(t)) {
      if (t.asker !== 'none' && t.asker !== 'stopped') { t.asker = 'received'; dropOutbox(t.id, 'answer'); persist(); emitTicket(t); }
      return resultOf(t);
    }
    if (t.asker !== 'lost' && t.asker !== 'waiting') return resultOf(t); // that call already returned (pending / stopped)
    const left = (Number(t.waitUntil) || 0) - now();
    if (!(left > 0)) { afterWait(t, 'timeout'); return resultOf(t); }
    const why = await waitOn(t, left, p.signal);
    if (why === 'settled') { if (t.asker !== 'none') t.asker = 'received'; dropOutbox(t.id, 'answer'); persist(); }
    return resultOf(t);
  }

  // team_ticket: the ticket's state and answer, waiting up to waitS (default 0).
  async function ticket(id, { waitS = 0, signal, caller } = {}) {
    const t = tickets.get(String(id || ''));
    if (!t) return { status: 'unknown', ticket: id, reason: 'No such ticket (settled tickets are kept 24 h; see team_log).' };
    if (caller && !mayRead(caller, t)) return { status: 'refused', reason: 'That ticket is not yours or in your subtree.' };
    const ms = Math.min(LIMITS.maxWaitS, Math.max(0, Number(waitS) || 0)) * 1000;
    const mine = !!caller && isAsker(caller, t) && t.asker !== 'none';
    if (isOpen(t) && ms > 0) {
      const why = await waitOn(t, ms, signal, mine);
      if (why === 'settled' && mine) { t.asker = 'received'; dropOutbox(t.id, 'answer'); persist(); }
      return resultOf(t);
    }
    if (!isOpen(t) && mine && t.asker !== 'none') {
      // the asker fetched it itself: no late delivery needed any more
      t.asker = 'received';
      dropOutbox(t.id, 'answer');
      persist();
    }
    return resultOf(t);
  }

  const isAsker = (caller, t) => (caller.kind === 'ceo' ? t.from.kind === 'ceo' && t.from.sessionId === caller.sessionId
    : t.from.kind === 'position' && t.from.id === caller.id);

  // The CEO sees all; a manager its own tickets and its subtree's; any position the tickets it asked or answers.
  function mayRead(caller, t) {
    if (caller.kind === 'ceo') return caller.company ? t.company === caller.company : true;
    if (caller.kind === 'owen') return true;
    if (t.company !== caller.company) return false;
    if (isAsker(caller, t) || t.to === caller.id) return true;
    const tree = treeOf(t.company);
    return tree.inSubtree(t.to, caller.id) || (t.from.id && tree.inSubtree(t.from.id, caller.id));
  }

  // ---------- cancel / release / followup ----------
  function cancel(id, { by = null, reason = null } = {}) {
    const t = tickets.get(String(id || ''));
    if (!t) return { state: 'unknown' };
    if (by && by.kind !== 'owen' && !isAsker(by, t)) return { state: t.state, refused: 'Only the asker can cancel a question.' };
    if (!isOpen(t)) return { state: t.state };
    cancelTree(t, reason || (by && by.kind === 'owen' ? `cancelled by ${ow().owner}` : 'withdrawn by the asker'));
    kick();
    return { state: t.state };
  }

  // A queued ask is withdrawn; a working one is marked cancelled (its answer is logged, not delivered). Its open
  // sub-asks go the same way: nobody is waiting for them any more.
  function cancelTree(t, reason) {
    for (const k of children(t.id)) if (isOpen(k)) cancelTree(k, 'its parent question was cancelled');
    if (!isOpen(t)) return;
    t.asker = t.asker === 'none' ? 'none' : 'received'; // the canceller needs no late delivery
    settle(t, 'cancelled', { reason });
  }

  // 5.3 "Let it answer now": skips the owner's 90 s window and the run cap; still never interrupts a running turn.
  function release(id) {
    const t = tickets.get(String(id || ''));
    if (!t) return { state: 'unknown' };
    if (t.state === 'queued') { t.released = true; persist(); emitTicket(t); kick(); }
    return { state: t.state };
  }

  // ask_followup: an answerer adds to an answer it gave in the last 24 h. Delivered like a late answer.
  function followup({ ticket: id, text, caller } = {}) {
    const t = tickets.get(String(id || ''));
    const body = String(text == null ? '' : text).trim();
    if (!t) return { status: 'refused', reason: 'No such ticket (or it is older than 24 h).' };
    if (!caller || caller.kind !== 'position' || t.to !== caller.id || t.company !== caller.company) return { status: 'refused', reason: 'Only the position that answered a ticket can follow it up.' };
    if (t.state !== 'answered') return { status: 'refused', reason: `That ticket is ${t.state}; you can follow up only an answered one.` };
    if (now() - (t.settledAt || 0) > LIMITS.followupWindowMs) return { status: 'refused', reason: 'Follow-ups are taken for 24 h after the answer.' };
    if (!body) return { status: 'refused', reason: 'The follow-up is empty.' };
    if (t.kind === 'duty' || t.asker === 'none') return { status: 'refused', reason: 'Nobody is waiting on that ticket (a duty run).' };
    // "(from Tax Specialist)": this turn was started by a late answer from a report
    const cause = caller.sessionId && turnCause.get(caller.sessionId);
    const via = cause && tickets.get(cause.ticket);
    const fromWords = via && via.toName ? ` (from ${via.toName})` : '';
    const textOut = clip(body, LIMITS.answerChars);
    logLine(t, 'answered', { answer: textOut, followup: true });
    const msg = `<helm-answer ticket="${t.id}" from="${attr(t.toName)}" state="followup">\n${quote(`${t.toName} adds${fromWords}: ${textOut}`)}\n</helm-answer>\n`
      + `${quote(t.toName)} sent this addendum to its earlier answer.${t.from.kind === 'ceo' ? ` Tell ${ow().owner} what changed.` : ''}`;
    deliverToAsker(t, 'followup', msg, { text: textOut, via: via ? via.toName : null });
    kick();
    return { status: 'sent', ticket: t.id };
  }

  // ---------- settling ----------
  function settle(t, st, data = {}) {
    if (!isOpen(t)) return;
    const wasDelivered = t.state === 'delivered';
    setState(t, st);
    t.settledAt = now();
    if (data.answer != null) t.answer = clip(data.answer, LIMITS.answerChars);
    if (data.reason) t.reason = data.reason;
    if (data.costUsd != null) t.costUsd = data.costUsd;
    if (st === 'answered') t.tookMs = t.settledAt - t.askedAt;
    const extra = {};
    if (st === 'answered') Object.assign(extra, { answer: t.answer, tookMs: t.tookMs, ...(t.costUsd != null ? { costUsd: t.costUsd } : {}), ...(t.late ? { late: true } : {}) });
    else if (t.reason) extra.reason = t.reason;
    logLine(t, st, extra);
    if (st === 'cancelled' && wasDelivered && running.has(t.id)) t.cancelledWhileWorking = true; // answer logged at turn end
    const watch = watchers.get(t.id);
    if (watch) for (const x of [...watch]) if (x.done) x.done('settled');
    const w = waiters.get(t.id);
    if (st === 'answered' && !(w && w.size) && t.asker !== 'none') t.answeredLate = true;
    if (w && w.size) {
      for (const x of [...w]) if (x.done) x.done('settled');
      if (t.asker !== 'none') t.asker = 'received';
    } else if (t.asker === 'pending' || t.asker === 'lost') {
      deliverToAsker(t, 'answer', lateText(t), { text: t.answer || t.reason || '' });
    } else if (t.asker === 'stopped') {
      cardToAsker(t);
    }
    persist();
    emitTicket(t);
    fire('settled', t);
  }

  function lateText(t) {
    const st = t.state === 'answered' ? (t.late ? 'late' : 'answered') : t.state;
    const body = t.state === 'answered' ? (t.answer || '') : (t.reason || t.state);
    let tail;
    if (t.from.kind === 'ceo') tail = `This answers your earlier team_ask, which returned pending. Tell ${ow().owner}.`;
    else {
      const p = parentOf(t);
      if (p && !isOpen(p) && p.to === t.from.id) {
        tail = `You already answered ${quote(p.from.name)} (ticket ${p.id}) without this. If it changes what you said, send the change with ask_followup({ ticket: "${p.id}", text }). If it changes nothing, reply in one line; nothing is sent.`;
      } else tail = 'This answers your earlier question, which returned pending.';
    }
    return `<helm-answer ticket="${t.id}" from="${attr(t.toName)}" state="${st}">\n${quote(body)}\n</helm-answer>\n${tail}`;
  }

  // The asker's chat gets a message (a turn) at its next free moment. A position asker is addressed by position,
  // so a rollover in between delivers into its new chat (8.3: open tickets move with the position).
  function deliverToAsker(t, kind, text, meta = {}) {
    if (t.asker === 'stopped') { cardToAsker(t, meta.text != null ? meta.text : text, kind); return; }
    const target = t.from.kind === 'position' ? { company: t.company, position: t.from.id } : t.from.sessionId ? { sessionId: t.from.sessionId } : null;
    if (!target) return;
    pushOutbox(t, kind, text, target, meta.via || null, { body: meta.text != null ? meta.text : null });
  }

  // PROTOCOL answer.state of a late delivery: answered | late | expired (cancelled passes through as is)
  function answerState(t, kind) {
    if (kind === 'expired' || t.state === 'expired') return 'expired';
    if (t.state === 'answered') return t.answeredLate || t.late ? 'late' : 'answered';
    return t.state;
  }

  // extra: { body: the text without the <helm-answer> wrapping, forced: the owner's own "Send to CEO" (a turn even in a
  // closed or archived chat) }
  function pushOutbox(t, kind, text, target, via, extra = {}) {
    outbox.push({ id: newId('o', (x) => outbox.some((o) => o.id === x)), ticket: t.id, company: t.company, kind, text, at: now(), target,
      from: { id: t.to, name: t.toName }, state: answerState(t, kind), via,
      ...(extra.body != null ? { body: String(extra.body) } : {}), ...(extra.forced ? { forced: true } : {}) });
  }

  // 5.5 (fix 5): a CEO chat the owner closed (status 'closed': Close, or Archive), archived or deleted is never brought
  // back by a late answer: no turn starts there (session.js send() would un-archive and resume it). The answer goes in
  // as an answer card instead (a Helm item, no turn; none for a deleted chat) plus an inbox line, so it is never
  // dropped unseen, and team_ticket still fetches it. The owner's own "Send to CEO" on a card (forward) does start a turn.
  const chatAsleep = (es) => (!es || es.removed ? 'deleted' : es.s && es.s.archived ? 'archived' : es.s && es.s.status === 'closed' ? 'closed' : null);

  function inboxAnswer(cid, ticket, from, body, kind, why) {
    const name = (from && (from.name || from.id)) || 'A position';
    const title = kind === 'expired' ? `No answer from ${name} (2 h)` : kind === 'followup' ? `${name} added to an answer` : `${name} answered`;
    const where = why === 'deleted' ? 'The chat that asked was deleted' : `The chat that asked is ${why}, so Helm did not reopen it`;
    if (!cid || typeof opts.inbox !== 'function') { log('warn', `team runtime: the answer for ${ticket} has no inbox to go to (${where})`); return; }
    try {
      opts.inbox(cid, { kind: 'flag', position: (from && from.id) || null, title,
        text: `${clip(String(body == null ? '' : body).trim() || '(no text)', 4000)}\n\n${where} (ticket ${ticket}).`, ticket, needsOwen: true });
    } catch (e) { log('warn', `team runtime: inbox line failed (${ticket}): ${e.message}`); }
  }

  function parkAnswer(o, es, why) {
    const at = outbox.indexOf(o);
    if (at >= 0) outbox.splice(at, 1);
    const t = tickets.get(o.ticket) || null;
    const body = o.body != null ? o.body : t ? (t.state === 'answered' ? t.answer || '' : t.reason || t.state) : '';
    const sid = o.target && o.target.sessionId;
    let carded = false;
    if (es && sid && typeof sessions.addCard === 'function') {
      try {
        sessions.addCard(sid, { type: 'team', kind: 'answer', answer: { ticket: o.ticket, from: o.from, text: body, state: o.state, ...(o.kind === 'followup' ? { followup: true } : {}) } });
        carded = true;
      } catch (e) { log('warn', `team runtime: answer card failed (${o.ticket}): ${e.message}`); }
    }
    inboxAnswer(o.company || (t && t.company) || null, o.ticket, o.from, body, o.kind === 'expired' || o.state === 'expired' ? 'expired' : o.kind, why);
    log('info', `team runtime: the late answer for ${o.ticket} is ${carded ? 'an answer card and ' : ''}an inbox line: chat ${sid} is ${why}, no turn started`);
  }

  function dropOutbox(ticketId, kind) {
    for (let i = outbox.length - 1; i >= 0; i--) if (outbox[i].ticket === ticketId && (!kind || outbox[i].kind === kind)) outbox.splice(i, 1);
  }

  // 5.5: the owner stopped the asker while it waited: an answer card (a Helm item), no turn.
  function cardToAsker(t, text = null, kind = 'answer') {
    let sid = t.from.sessionId || null;
    if (t.from.kind === 'position' && typeof sessions.current === 'function') {
      const cur = sessions.current(t.company, t.from.id); // its current chat (a rollover may have moved it)
      if (cur && cur.s && cur.s.id) sid = cur.s.id;
    }
    const body = text != null ? text : t.state === 'answered' ? t.answer || '' : t.reason || t.state;
    const item = { type: 'team', kind: 'answer', answer: { ticket: t.id, from: { id: t.to, name: t.toName }, text: body, state: answerState(t, kind), ...(kind === 'followup' ? { followup: true } : {}) } };
    const gone = !sid || typeof sessions.addCard !== 'function' || (typeof sessions.get === 'function' && !sessions.get(sid));
    if (gone) {
      log('warn', `team runtime: no chat for the answer card of ${t.id}; an inbox line instead`);
      inboxAnswer(t.company, t.id, { id: t.to, name: t.toName }, body, kind, 'deleted');
      return;
    }
    try { sessions.addCard(sid, item); } catch (e) { log('warn', `team runtime: answer card failed (${t.id}): ${e.message}`); }
  }

  // team.answer.forward (the answer card's "Send to CEO"): the answer goes into that chat as a message (a turn).
  function forward(sessionId, id) {
    const t = tickets.get(String(id || ''));
    if (!t || isOpen(t)) return { ok: false, reason: t ? 'not answered yet' : 'unknown ticket' };
    pushOutbox(t, 'answer', lateText(t), { sessionId }, null, { body: t.state === 'answered' ? t.answer || '' : t.reason || t.state, forced: true });
    persist();
    kick();
    return { ok: true };
  }

  // ---------- expiry (5.5, 5.7) ----------
  function checkExpiry() {
    const at = now();
    const roots = new Map();
    for (const t of tickets.values()) if (isOpen(t) && at - (t.rootAskedAt || t.askedAt) >= LIMITS.expiryMs) roots.set(t.chain, true);
    for (const chain of roots.keys()) {
      const list = chainTickets(chain).sort((a, b) => a.askedAt - b.askedAt);
      const root = list.find((x) => x.id === chain) || list[0];
      const rootWasOpen = root && isOpen(root);
      const where = rootWasOpen ? whereWords(root) : null;
      for (const t of list) {
        if (t.state === 'queued') {
          // withdrawn; only the root's asker hears about it (one message for the whole chain)
          const keep = t.asker;
          if (t.asker !== 'none') t.asker = 'received';
          settle(t, 'expired', { reason: t === root ? `No answer 2 h after it was asked (${where}). Withdrawn.` : 'Its chain expired 2 h after the first question.' });
          if (t === root && keep !== 'none') {
            t.asker = keep;
            expiredToAsker(t, where);
            if (t.asker !== 'stopped') t.asker = 'received';
          }
        } else if (t.state === 'delivered' && !t.late) {
          t.late = true;
          logLine(t, 'late', { reason: 'still being worked on 2 h after the first question; the answer is still delivered' });
          emitTicket(t);
        }
      }
      if (root && root.state === 'delivered' && !root.expiredSent) {
        root.expiredSent = true;
        expiredToAsker(root, where);
      }
      persist();
    }
  }

  function expiredToAsker(root, where) {
    if (root.asker === 'none' || root.asker === 'received') return;
    const still = isOpen(root) ? ' If an answer still comes, Helm delivers it here.' : '';
    const text = `<helm-answer ticket="${root.id}" from="${attr(root.toName)}" state="expired">\n${quote(`No answer 2 h after you asked. Where it stopped: ${where || stateWords(root)}.${still}`)}\n</helm-answer>\n`
      + (root.from.kind === 'ceo' ? `Tell ${ow().owner}.` : 'Carry on without it.');
    if (root.asker === 'stopped') cardToAsker(root, `No answer 2 h after you asked. Where it stopped: ${where || stateWords(root)}.${still}`, 'expired');
    else if (root.asker !== 'none') {
      const target = root.from.kind === 'position' ? { company: root.company, position: root.from.id } : root.from.sessionId ? { sessionId: root.from.sessionId } : null;
      if (target) pushOutbox(root, 'expired', text, target, null, { body: `No answer 2 h after you asked. Where it stopped: ${where || stateWords(root)}.${still}` });
    }
    // the late root answer (if any) still comes as a normal late answer
    if (isOpen(root) && root.asker !== 'stopped' && root.asker !== 'none') root.asker = 'pending';
  }

  // ---------- duties (duties.js contract) ----------
  // runDuty(req) -> { ticket, done: Promise<{ state: 'done'|'failed', finalText, reported, costUsd, error }> }
  function runDuty(req = {}) {
    const cid = req.company;
    const pos = posOf(cid, req.position);
    if (!pos || pos.status !== 'active') throw new Error(pos ? `${pos.name} is ${pos.status}` : `no position "${req.position}"`);
    const id = newId('t', (x) => tickets.has(x));
    const duty = req.duty || {};
    const t = {
      id, company: cid, chain: id, parentTicket: null,
      from: { kind: req.manual ? 'owen' : 'helm', name: req.manual ? ow().Owner : 'Helm (duty)' },
      to: pos.id, toName: pos.name || pos.id, kind: 'duty', question: clip(req.text || '', LIMITS.questionChars), handed: [],
      duty: { id: duty.id, title: duty.title || duty.id, trigger: duty.trigger || null, due: req.due || null, manual: !!req.manual },
      text: req.text || '', state: 'queued', stateAt: now(), askedAt: now(), rootAskedAt: now(), asker: 'none', attempts: 0,
      ...(req.manual ? { released: true } : {}),
    };
    tickets.set(id, t);
    logLine(t, 'asked', { question: clip(t.text, LIMITS.questionChars), duty: t.duty.id });
    persist();
    emitTicket(t);
    kick();
    return { ticket: id, done: dutyDone(t) };
  }

  function dutyDone(t) {
    return new Promise((resolve) => {
      const finish = (x) => {
        if (x.id !== t.id || isOpen(x)) return;
        off();
        if (x.state === 'answered') resolve({ state: 'done', finalText: x.answer || '', reported: !!x.reported, costUsd: x.costUsd != null ? x.costUsd : null });
        else resolve({ state: 'failed', error: x.reason || x.state, finalText: x.answer || '', reported: !!x.reported });
      };
      const off = on('settled', finish);
      if (!isOpen(t)) finish(t);
    });
  }

  // duties.js resumeRun(ticket): a run that was in flight when Helm quit.
  function resumeRun(id) {
    const t = tickets.get(String(id || ''));
    if (!t || t.kind !== 'duty') return null;
    return dutyDone(t);
  }

  // duty_report from the position running a duty: marks the run reported (duties.js skips its automatic inbox line).
  function noteDutyReport(sessionId) {
    const t = answering(sessionId);
    if (!t || t.kind !== 'duty') return null;
    t.reported = true;
    persist();
    return t.id;
  }

  // ---------- delivery (5.3) ----------
  function sessionBusy(es) {
    if (!es) return false;
    if (es.turnActive || es.starting || es.compacting || es.closing) return true;
    const st = es.s && es.s.status;
    if (st === 'working' || st === 'waiting') return true;
    if (es.requests && es.requests.size) return true;
    if (es.pendingQueue && es.pendingQueue.length) return true;
    if (es.turnWaiters && es.turnWaiters.length) return true;
    return false;
  }

  const ownerActiveAt = (es) => {
    if (!es) return 0;
    try { if (typeof sessions.ownerActiveAt === 'function') return Number(sessions.ownerActiveAt(es)) || 0; } catch {}
    return Number(es.lastActiveAt) || 0;
  };
  const viewed = (es) => { try { return !!(es && sessions.isViewed && sessions.isViewed(es.s.id)); } catch { return false; } };

  // Position turns that count against team.maxConcurrentRuns. A turn blocked in a tool call on its own sub-ask
  // does not count: its slot passes to the report it waits on, so a chain deeper than the cap never starves
  // (CEO > Legal > Tax > Payroll needs one running turn at a time, not three).
  function blockedSessions() {
    const out = new Set();
    for (const t of tickets.values()) if (isOpen(t) && t.from.kind === 'position' && t.from.sessionId && liveWaiters(t.id) > 0) out.add(t.from.sessionId);
    return out;
  }

  function runsNow() {
    const blocked = blockedSessions();
    if (typeof sessions.positionTurnsRunning === 'function') {
      try { const n = Number(sessions.positionTurnsRunning()); if (Number.isFinite(n)) return Math.max(0, n - blocked.size) + starting.size; } catch {}
    }
    let n = rolling.size + starting.size;
    for (const r of running.values()) if (!blocked.has(r.sessionId)) n++;
    return n;
  }

  function runCap() {
    let s = {};
    try { s = settingsOf() || {}; } catch {}
    const n = Number(s.maxConcurrentRuns);
    return Number.isInteger(n) && n >= 1 ? n : LIMITS.maxConcurrentRuns;
  }

  // The delivered question (5.3) or duty run (9.5).
  function askText(t, again = false) {
    // again: 'failed' after a failed answer turn, any other truthy value after a restart
    if (t.kind === 'duty') return (again ? (again === 'failed' ? '(Delivered again: the last run failed before it finished.)\n' : '(Delivered again: Helm restarted before this run finished.)\n') : '') + (t.text || t.question);
    const dl = syncDeadline(t.id);
    const by = dl ? ` reply-by="${hhmm(dl)}"` : '';
    const handed = t.handed && t.handed.length ? `\nHanded to you (read-only for this question): ${t.handed.join(', ')}` : '';
    const who = t.from.kind === 'ceo' ? 'the CEO' : quote(t.from.name);
    const lines = [
      ...(again ? [again === 'failed' ? '(Asked again: your last turn on this question failed before it answered.)' : '(Asked again: Helm restarted before your answer was recorded.)'] : []),
      `<helm-ask ticket="${t.id}" from="${attr(t.from.name)}" kind="${t.kind}"${by}>`,
      quote(`${t.question}${handed}`),
      '</helm-ask>',
      `Answer this question in your reply. Your final message is passed back to ${who} word for word; it sees nothing`
        + ' else of this chat or your notebook.'
        + (t.kind === 'colleague' ? ' It is a colleague\'s one narrow question: answer only it.' : ' If you need a report\'s input, use team_ask.')
        + ' Record anything durable with notebook_add.',
    ];
    return lines.join('\n');
  }

  function teamMeta(t) {
    if (t.kind === 'duty') return { origin: 'duty', duty: { id: t.duty.id, title: t.duty.title, trigger: t.duty.trigger, ...(t.duty.due ? { due: t.duty.due } : {}) }, ticket: t.id };
    return { origin: 'ask', ask: { ticket: t.id, from: { kind: t.from.kind, id: t.from.id || null, name: t.from.name }, kind: t.kind, handed: t.handed || [] } };
  }

  function attachWaiter(es) {
    let resolve;
    const p = new Promise((r) => { resolve = r; });
    if (!Array.isArray(es.turnWaiters)) es.turnWaiters = [];
    es.turnWaiters.push(resolve);
    return { p, detach: () => { es.turnWaiters = (es.turnWaiters || []).filter((f) => f !== resolve); } };
  }

  // Something started a turn between the check and the send: take the message back out of the queue (as
  // handoff.js does), so it is delivered as a turn of its own later.
  function withdraw(es, itemId) {
    try {
      if (typeof es.withdrawQueued === 'function') { es.withdrawQueued(itemId); return; }
      if (Array.isArray(es.pendingQueue)) es.pendingQueue = es.pendingQueue.filter((q) => !(q && q.item && q.item.id === itemId));
      if (es.s) es.s.queued = (es.pendingQueue || []).length;
      if (es.norm && es.norm.store && es.norm.store.patch) es.norm.store.patch(itemId, { queued: false, cancelled: true });
      if (typeof es.touch === 'function') es.touch();
    } catch (e) { log('warn', `team runtime: withdrawing a queued message failed: ${e.message}`); }
  }

  const itemUuid = (es, itemId) => {
    const it = Array.isArray(es.items) ? es.items.find((x) => x && x.id === itemId) : null;
    return (it && it.uuid) || null;
  };

  // Work per target: open queued tickets (by position) and outbox entries (by position or session).
  function workByTarget() {
    const pos = new Map(); // key -> { cid, pid, items: [{ cls, at, released, t?, o? }] }
    const ses = new Map(); // sessionId -> [outbox]
    const add = (cid, pid, entry) => {
      const k = keyOf(cid, pid);
      if (!pos.has(k)) pos.set(k, { cid, pid, items: [] });
      pos.get(k).items.push(entry);
    };
    for (const t of tickets.values()) if (t.state === 'queued') add(t.company, t.to, { cls: t.kind, at: t.askedAt, released: !!t.released, t });
    for (const o of outbox) {
      if (o.target.position) add(o.target.company, o.target.position, { cls: 'answer', at: o.at, released: false, o });
      else if (o.target.sessionId) { if (!ses.has(o.target.sessionId)) ses.set(o.target.sessionId, []); ses.get(o.target.sessionId).push(o); }
    }
    for (const w of pos.values()) w.items.sort((a, b) => (b.released - a.released) || (CLASS_RANK[a.cls] - CLASS_RANK[b.cls]) || (a.at - b.at));
    for (const list of ses.values()) list.sort((a, b) => a.at - b.at);
    return { pos, ses };
  }

  function setQueueReason(w, reason) {
    for (const it of w.items) {
      if (!it.t || it.t.queueReason === reason) continue;
      it.t.queueReason = reason;
      emitTicket(it.t);
    }
  }

  async function deliverAll() {
    const { pos, ses } = workByTarget();
    // rolls first: a pending roll at a quiet moment holds that position's queue (8.3)
    for (const [k, r] of rolls) {
      if (rolling.has(k)) continue;
      const [cid, pid] = k.split('/');
      const es = sessions.current ? sessions.current(cid, pid) : null;
      if (!es || es.s.position && es.s.position.ended) { rolls.delete(k); continue; }
      if (sessionBusy(es) || delivering.has(k)) continue;
      if (!r.hard && now() - ownerActiveAt(es) < ROLL_QUIET_MS) continue;
      runRoll(k, cid, pid, es, r).catch(logged(`rolling ${k}`));
    }
    let runs = runsNow();
    const cap = runCap();
    for (const [k, w] of pos) {
      if (delivering.has(k) || rolling.has(k)) { if (rolling.has(k)) setQueueReason(w, `${nameOf(w.cid, w.pid)} is starting a fresh chat`); continue; }
      const p = posOf(w.cid, w.pid);
      if (!p || p.status === 'retired') {
        for (const it of w.items) {
          if (it.t) settle(it.t, 'cancelled', { reason: p ? `${p.name} was retired` : `${w.pid} no longer exists` });
          else if (it.o && outbox.includes(it.o)) outbox.splice(outbox.indexOf(it.o), 1);
        }
        persist();
        continue;
      }
      if (p.status === 'paused') { setQueueReason(w, `${p.name} is paused`); continue; }
      const head = w.items[0];
      const es = sessions.current ? sessions.current(w.cid, w.pid) : null;
      if (rolls.has(k) && rolls.get(k).hard) { setQueueReason(w, `${p.name} is starting a fresh chat`); continue; }
      if (es && sessionBusy(es)) {
        setQueueReason(w, viewed(es) && now() - ownerActiveAt(es) < OWNER_QUIET_MS ? `${ow().Owner} is talking with ${p.name}` : `${p.name} is busy`);
        continue;
      }
      if (!head.released && es && viewed(es) && now() - ownerActiveAt(es) < OWNER_QUIET_MS) { setQueueReason(w, `${ow().Owner} is talking with ${p.name}`); continue; }
      if (!head.released && runs >= cap) { setQueueReason(w, `waiting for a free slot (${cap} positions running)`); continue; }
      runs++;
      if (head.t) deliverTicket(k, head.t).catch(logged(`delivering ${head.t.id}`));
      else deliverOutbox(k, head.o, { cid: w.cid, pid: w.pid }).catch(logged(`the late answer for ${head.o.ticket}`));
    }
    for (const [sid, all] of ses) {
      if (delivering.has(sid)) continue;
      const es = sessions.get ? sessions.get(sid) : null;
      const why = chatAsleep(es);
      if (why) {
        for (const o of all) if (!o.forced || why === 'deleted') parkAnswer(o, es, why);
        persist();
      }
      const list = all.filter((o) => outbox.includes(o));
      if (!list.length || !es) continue;
      if (sessionBusy(es)) continue;
      if (viewed(es) && now() - ownerActiveAt(es) < ASKER_QUIET_MS) continue;
      deliverOutbox(sid, list[0], { sessionId: sid }).catch(logged(`the late answer for ${list[0].ticket}`));
    }
  }

  async function deliverTicket(k, t) {
    delivering.add(k);
    starting.add(k);
    let es = null;
    try {
      es = await sessions.open(t.company, t.to);
      if (es && typeof es.ensureLoaded === 'function') await es.ensureLoaded();
      if (stopped || t.state !== 'queued') return;
      if (!es) throw new Error('no chat for the position');
      // something started meanwhile, or the owner started typing there: next kick
      if (sessionBusy(es) || rolling.has(k)) return;
      if (!t.released && viewed(es) && now() - ownerActiveAt(es) < OWNER_QUIET_MS) return;
      const again = t.redeliver || false;
      const w = attachWaiter(es);
      const costBefore = Number(es.s && es.s.costUsd) || 0;
      let sent;
      try {
        sent = await es.send({ text: askText(t, again), origin: 'helm', team: teamMeta(t) });
      } catch (e) {
        w.detach();
        throw e;
      }
      if (sent && sent.queued) { w.detach(); withdraw(es, sent.itemId); return; }
      if (t.state !== 'queued') {
        // cancelled while the send was in flight: the turn runs, its answer is logged only
        running.set(t.id, { sessionId: es.s.id });
        w.p.then((info) => onAnswerTurnEnd(t.id, es, info)).catch(logged(`the answer turn end of ${t.id}`));
        return;
      }
      setState(t, 'delivered');
      t.deliveredAt = now();
      delete t.queueReason;
      delete t.redeliver;
      t.delivery = { sessionId: es.s.id, itemId: sent ? sent.itemId : null, uuid: sent ? itemUuid(es, sent.itemId) : null, costBefore };
      running.set(t.id, { sessionId: es.s.id });
      logLine(t, 'delivered', { sessionId: es.s.id });
      persist();
      emitTicket(t);
      w.p.then((info) => onAnswerTurnEnd(t.id, es, info)).catch(logged(`the answer turn end of ${t.id}`));
    } catch (e) {
      log('warn', `team runtime: delivering ${t.id} to ${t.to} failed: ${e.message}`);
      t.attempts = (t.attempts || 0) + 1;
      if (t.attempts >= ATTEMPTS) settle(t, 'cancelled', { reason: `Could not deliver the question to ${t.toName}: ${e.message}` });
      else persist();
    } finally {
      delivering.delete(k);
      starting.delete(k);
    }
  }

  function onAnswerTurnEnd(id, es, info = {}) {
    running.delete(id);
    if (stopped) return; // Helm is quitting: the ticket stays delivered and is recovered at the next start
    const t = tickets.get(id);
    if (!t) return;
    const text = clip(finalText(es.items, t.delivery && t.delivery.itemId, info.result) || '', LIMITS.answerChars);
    const after = Number(es.s && es.s.costUsd);
    const costUsd = t.delivery && Number.isFinite(after) && after >= (t.delivery.costBefore || 0) ? Math.round((after - (t.delivery.costBefore || 0)) * 1e6) / 1e6 : null;
    if (!isOpen(t)) {
      // cancelled while it worked: the answer is logged but not delivered
      if (text) logLine(t, 'cancelled', { answer: text, reason: 'answered after it was cancelled; not delivered' });
      if (t.kind === 'duty') fire('settled', t);
    } else if (info.failed && !info.interrupted) {
      t.attempts = (t.attempts || 0) + 1;
      if (t.attempts < ATTEMPTS) {
        setState(t, 'queued');
        t.redeliver = 'failed';
        t.delivery = null;
        t.queueReason = `${t.toName}'s turn failed; asking again`;
        persist();
        emitTicket(t);
      } else settle(t, 'cancelled', { reason: `${t.toName}'s turn failed: ${info.error || 'unknown error'}`, ...(text ? { answer: text } : {}) });
    } else if (info.interrupted) {
      settle(t, 'cancelled', { reason: `Stopped in ${t.toName}'s chat before it answered`, ...(text ? { answer: text } : {}) });
    } else {
      settle(t, 'answered', { answer: text || `(${t.toName} ended its turn without a reply.)`, costUsd });
    }
    noteTurnEnd(es.s.id);
  }

  async function deliverOutbox(k, o, where) {
    delivering.add(k);
    if (where.pid) starting.add(k);
    try {
      const es = where.sessionId ? (sessions.get ? sessions.get(where.sessionId) : null) : await sessions.open(where.cid, where.pid);
      if (es && typeof es.ensureLoaded === 'function') await es.ensureLoaded();
      if (stopped || !outbox.includes(o)) return;
      if (where.sessionId) {
        const why = chatAsleep(es);
        if (why && (!o.forced || why === 'deleted')) { parkAnswer(o, es, why); persist(); return; }
      }
      if (!es) {
        const at = outbox.indexOf(o);
        if (at >= 0) outbox.splice(at, 1);
        log('warn', `team runtime: the late answer for ${o.ticket} found no chat for ${where.cid}/${where.pid}`);
        persist();
        return;
      }
      if (sessionBusy(es)) return;
      const posTarget = !!where.pid;
      const w = posTarget ? attachWaiter(es) : null;
      let sent;
      try {
        sent = await es.send({ text: o.text, origin: 'helm', team: { origin: 'answer', answer: { ticket: o.ticket, from: o.from, state: o.state, ...(o.kind === 'followup' ? { followup: true } : {}) } } });
      } catch (e) {
        if (w) w.detach();
        throw e;
      }
      if (sent && sent.queued) { if (w) w.detach(); withdraw(es, sent.itemId); return; }
      const at = outbox.indexOf(o);
      if (at >= 0) outbox.splice(at, 1);
      if (posTarget) {
        // a position's turn: counted as a run while it lasts; remember what started it (ask_followup's "from")
        const runKey = `o:${o.id}`;
        running.set(runKey, { sessionId: es.s.id });
        turnCause.set(es.s.id, { ticket: o.ticket });
        w.p.then(() => { running.delete(runKey); if (turnCause.get(es.s.id) && turnCause.get(es.s.id).ticket === o.ticket) turnCause.delete(es.s.id); if (!stopped) noteTurnEnd(es.s.id); }).catch(logged(`the late-answer turn end of ${o.ticket}`));
      }
      persist();
      const t = tickets.get(o.ticket);
      if (t) emitTicket(t);
    } catch (e) {
      log('warn', `team runtime: late answer for ${o.ticket} failed: ${e.message}`);
      o.attempts = (o.attempts || 0) + 1;
      if (o.attempts >= 3) { const at = outbox.indexOf(o); if (at >= 0) outbox.splice(at, 1); }
      persist();
    } finally {
      delivering.delete(k);
      starting.delete(k);
    }
  }

  // ---------- restart recovery (5.5) ----------
  async function recover() {
    for (const t of tickets.values()) {
      if (!t.recover || stopped) continue;
      delete t.recover;
      if (t.state !== 'delivered') continue;
      const es = t.delivery && sessions.get ? sessions.get(t.delivery.sessionId) : null;
      if (!es) { requeue(t, 'its chat was not found after a restart'); continue; }
      try { if (typeof es.ensureLoaded === 'function') await es.ensureLoaded(); } catch {}
      if (es.turnActive) {
        // the answer turn survived in the broker (Keep sessions running): its end is the answer
        const w = attachWaiter(es);
        running.set(t.id, { sessionId: es.s.id });
        w.p.then((info) => onAnswerTurnEnd(t.id, es, info)).catch(logged(`the answer turn end of ${t.id}`));
        continue;
      }
      const items = Array.isArray(es.items) ? es.items : [];
      const asked = items.find((x) => x && ((t.delivery.uuid && x.uuid === t.delivery.uuid) || (!t.delivery.uuid && x.id === t.delivery.itemId)));
      const text = asked ? finalText(items, asked.id, null) : '';
      if (text) settle(t, 'answered', { answer: text });
      else requeue(t, 'Helm restarted before the answer was recorded');
    }
  }

  function requeue(t, why) {
    setState(t, 'queued');
    t.redeliver = true;
    t.delivery = null;
    t.queueReason = why;
    logLine(t, 'asked', { reason: `re-queued: ${why}` });
    persist();
    emitTicket(t);
  }

  // ---------- rollover (8.3) ----------
  // The engine calls this at the end of every turn of any session (cheap: a field check). A position chat at or
  // over 32% is marked "roll pending"; at 40% it rolls as soon as it is free, even with its tab on screen.
  function noteTurnEnd(sessionId) {
    if (stopped) return;
    const es = sessions.get ? sessions.get(sessionId) : null;
    const pos = es && es.s && es.s.position;
    if (pos && pos.company && pos.id && !pos.ended) {
      const k = keyOf(pos.company, pos.id);
      const pct = Number(es.s.context && es.s.context.percent);
      if (!rolling.has(k) && Number.isFinite(pct) && pct >= TH.roll) {
        const hard = pct >= TH.ceiling;
        const cur = rolls.get(k);
        if (!cur || (hard && !cur.hard)) rolls.set(k, { hard, pct });
      }
    }
    kick();
  }

  async function runRoll(k, cid, pid, es, r) {
    if (rolling.has(k)) return;
    rolling.add(k);
    rolls.delete(k);
    emitTeam(cid);
    let text = null;
    let why = null;
    try {
      for (let i = 0; i < 2 && !text && !stopped; i++) {
        try {
          if (typeof sessions.handoff !== 'function') throw new Error('handoff is not available');
          const res = await sessions.handoff(es, ROLL_PROMPT);
          text = res && typeof res.text === 'string' && res.text.trim() ? res.text.trim() : null;
          if (!text) why = 'the handoff reply was empty';
        } catch (e) { why = (e && e.message) || String(e); }
      }
      if (stopped) return;
      try {
        if (typeof sessions.endChat === 'function') {
          await sessions.endChat({ company: cid, position: pid, sessionId: es.s.id, handoff: text, error: text ? null : `handoff failed: ${why}`, contextPct: r.pct, reason: 'full' });
        }
      } catch (e) { log('warn', `team runtime: ending ${k}'s chat failed: ${e.message}`); }
      // 8.3 (fix 12): the new chat opens now and starts with a quiet notice line (a Helm item, no turn); its CLI starts
      // only with its first message, as for any chat.
      let n = null;
      if (!stopped && typeof sessions.open === 'function' && typeof sessions.addCard === 'function') {
        try {
          const fresh = await sessions.open(cid, pid);
          if (fresh && fresh.s && fresh.s.id !== es.s.id) {
            n = fresh.s.position && fresh.s.position.chat != null ? fresh.s.position.chat : null;
            const chat = n != null ? ` (chat ${n})` : '';
            sessions.addCard(fresh.s.id, { type: 'team', kind: 'notice', text: text
              ? `Fresh chat started${chat}; the handoff and notebook carried over.`
              : `Fresh chat started${chat}; the handoff failed, so only the notebook carried over. The old chat is kept.` });
          } else log('warn', `team runtime: no fresh chat for ${k} after the roll; no notice`);
        } catch (e) { log('warn', `team runtime: the fresh-chat notice for ${k} failed: ${e.message}`); }
      }
      if (!text && typeof opts.inbox === 'function') {
        try {
          opts.inbox(cid, { kind: 'flag', position: pid, title: `${nameOf(cid, pid)}: fresh chat without a handoff`,
            text: `Its chat was full and the handoff failed twice (${why}). The new chat${n != null ? ` (chat ${n})` : ''} starts from the notebook only: `
              + 'whatever the old chat knew that is not in the notebook did not carry over. The old chat is kept and can still be read.', needsOwen: true });
        } catch (e) { log('warn', `team runtime: inbox line failed: ${e.message}`); }
      }
      log('info', `team runtime: ${k} rolled to a fresh chat at ${r.pct}%${text ? '' : ` (handoff failed: ${why})`}`);
    } finally {
      rolling.delete(k);
      if (!stopped) { emitTeam(cid); kick(); }
    }
  }

  function emitTeam(cid) {
    try { emitRaw('team.updated', { company: cid }); } catch {}
  }

  // ---------- the loop ----------
  function pruneSettled() {
    const at = now();
    const openChains = new Set([...tickets.values()].filter(isOpen).map((t) => t.chain));
    let changed = false;
    for (const [id, t] of tickets) {
      if (isOpen(t) || openChains.has(t.chain)) continue;
      if (at - (t.settledAt || t.askedAt) > KEEP_SETTLED_MS && !outbox.some((o) => o.ticket === id)) { tickets.delete(id); changed = true; }
    }
    if (changed) persist();
  }

  // Re-evaluates everything: expiry, recovery, deliveries, rolls. Safe to call any time (coalesced).
  function kick() {
    if (stopped || !started) return Promise.resolve();
    if (kicking) { again = true; return kicking; }
    kicking = (async () => {
      try {
        do {
          again = false;
          checkExpiry();
          await recover();
          await deliverAll();
        } while (again && !stopped);
      } catch (e) {
        log('error', `team runtime: ${e.stack || e.message}`);
      } finally {
        kicking = false;
      }
    })();
    return kicking;
  }

  // The persisted tickets, loaded without running anything (no delivery, recovery or timer): wire.js prepare(), for
  // the engine's re-attach pass, so a team_ask the broker re-delivers to a kept CEO chat finds its ticket (resumeAsk)
  // before start(). start() primes too when nothing did.
  function prime() {
    if (loaded) return;
    loaded = true;
    load();
    // a live call can't survive a restart: their answers come as late answers (5.5), unless the same tool call comes
    // back (a CLI kept through the restart, resumeAsk)
    persist();
  }

  function start() {
    if (started) return;
    started = true;
    stopped = false;
    prime();
    tickTimer = clock.setInterval(() => { pruneSettled(); kick(); }, tickMs);
    kick();
  }

  // Helm is quitting: nothing settles from here on (turn ends seen during shutdown are not answers); everything open
  // stays persisted and is picked up at the next start.
  function stop() {
    if (stopped) return;
    stopped = true;
    if (tickTimer) clock.clearInterval(tickTimer);
    tickTimer = null;
    for (const [id, set] of waiters) for (const w of [...set]) if (w.done) w.done('aborted');
    waiters.clear();
    persist();
  }

  // ---------- read side (roster, Team view, guard) ----------
  // "answering CEO" | "running duty Monthly money check" | "starting a fresh chat" | null
  function busyText(cid, pid) {
    if (rolling.has(keyOf(cid, pid))) return 'starting a fresh chat';
    for (const t of tickets.values()) {
      if (t.company !== cid || t.to !== pid || t.state !== 'delivered') continue;
      return t.kind === 'duty' ? `running duty ${t.duty.title}` : `answering ${t.from.kind === 'ceo' ? 'CEO' : t.from.name}`;
    }
    return null;
  }

  function queued(cid, pid) {
    return [...tickets.values()].filter((t) => t.company === cid && t.to === pid && t.state === 'queued')
      .sort((a, b) => a.askedAt - b.askedAt).map((t) => ({ ticket: t.id, from: t.from.name, kind: t.kind, question: clip(t.question, 300), reason: t.queueReason || null, askedAt: t.askedAt }));
  }

  // Paths handed to the ask a session is answering (ticket-scoped read, 5.2): the guard reads this live.
  function handedReads(sessionId) {
    const t = answering(sessionId);
    return t && Array.isArray(t.handed) ? t.handed.slice() : [];
  }

  // request_access while answering: the asker's Ask card says so (7.4 step 2).
  function setWaitingOn(sessionId, text) {
    if (!sessionId) return;
    if (text) waitingOn.set(sessionId, String(text)); else waitingOn.delete(sessionId);
    const t = answering(sessionId);
    if (t) emitTicket(t);
  }

  // team_log: recent exchanges folded by ticket, newest first (question 300 chars, answer 600).
  function logEntries({ company, caller = null, position = null, since = null, limit = 20 } = {}) {
    const n = Math.min(100, Math.max(1, Number(limit) || 20));
    const sinceMs = since == null ? null : typeof since === 'number' ? since : Date.parse(since);
    let lines = [];
    try { lines = (store.readLog(company, 'crosstalk', { ...(Number.isFinite(sinceMs) ? { since: sinceMs } : {}) }) || {}).lines || []; } catch { lines = []; }
    const folded = new Map();
    for (const l of lines) {
      if (!l || !l.ticket) continue;
      let e = folded.get(l.ticket);
      if (!e) { e = { at: l.at, ticket: l.ticket, from: l.from, to: l.to, kind: l.kind, chain: l.chain, parentTicket: l.parentTicket || null, state: l.state }; folded.set(l.ticket, e); }
      e.state = l.state;
      e.lastAt = l.at;
      if (l.question && !e.question) e.question = clip(l.question, 300);
      if (l.answer && !l.followup) e.answer = clip(l.answer, 600);
      if (l.reason) e.reason = l.reason;
    }
    const tree = treeOf(company);
    let list = [...folded.values()].filter((e) => {
      if (position && e.to !== position && !(e.from && e.from.id === position)) return false;
      if (!caller || caller.kind === 'ceo' || caller.kind === 'owen') return true;
      const mine = (id) => id && (id === caller.id || tree.inSubtree(id, caller.id));
      return mine(e.to) || mine(e.from && e.from.id);
    });
    list = list.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt))).slice(0, n);
    return list.map((e) => ({ at: e.at, from: e.from && (e.from.kind === 'ceo' ? 'CEO' : e.from.id || e.from.kind), to: e.to, question: e.question || '', answer: e.answer || '', state: e.state, ticket: e.ticket, ...(e.reason && e.state !== 'answered' ? { reason: e.reason } : {}), ...(e.parentTicket ? { parentTicket: e.parentTicket } : {}) }));
  }

  // team.crosstalk RPC (PROTOCOL): one entry per ticket, newest first; `before` = a ticket id; limit 50 (max 200).
  function crosstalk({ company, position = null, before = null, limit = 50 } = {}) {
    const n = Math.min(200, Math.max(1, Number(limit) || 50));
    let lines = [];
    try { lines = (store.readLog(company, 'crosstalk', {}) || {}).lines || []; } catch { lines = []; }
    const folded = new Map();
    for (const l of lines) {
      if (!l || !l.ticket) continue;
      let e = folded.get(l.ticket);
      if (!e) {
        const from = l.from || { kind: 'ceo' };
        e = { ticket: l.ticket, ...(l.parentTicket ? { parentTicket: l.parentTicket } : {}), chain: l.chain || l.ticket,
          from: { kind: from.kind, ...(from.id ? { id: from.id } : {}), name: from.kind === 'ceo' ? 'CEO' : from.id ? nameOf(company, from.id) : from.kind === 'owen' ? ow().Owner : 'Helm' },
          to: l.to, toName: nameOf(company, l.to), kind: l.kind, state: l.state, question: '', askedAt: l.at };
        folded.set(l.ticket, e);
      }
      if (l.state !== 'pending' || e.state === 'asked' || e.state === 'delivered') e.state = l.state;
      if (l.question && !e.question) e.question = l.question;
      if (Array.isArray(l.handed) && l.handed.length) e.handed = l.handed;
      if (l.answer && !l.followup) e.answer = l.answer;
      if (l.answer && l.followup) (e.followups = e.followups || []).push({ at: l.at, text: l.answer });
      if (l.reason) e.reason = l.reason;
      if (l.state === 'answered' && !l.followup) { e.answeredAt = l.at; if (l.tookMs != null) e.tookMs = l.tookMs; if (l.costUsd != null) e.costUsd = l.costUsd; if (l.late) e.state = 'late'; }
    }
    let list = [...folded.values()];
    if (position) list = list.filter((e) => e.to === position || e.from.id === position);
    list.sort((a, b) => String(b.askedAt).localeCompare(String(a.askedAt)));
    if (before) { const i = list.findIndex((e) => e.ticket === before); if (i >= 0) list = list.slice(i + 1); }
    return { entries: list.slice(0, n), hasMore: list.length > n };
  }

  // ---------- notebook echo (the store's change events don't say who edited) ----------
  // The position's own writes (notebook_add, or its Edit / Write on notebook.md seen by the hook) open a short
  // window; a change event for that file inside it, or later with the same content hash, is the position's own
  // echo, never "the owner edited your notebook". A hash given with the write narrows it: a different hash is the owner's.
  const ownWrites = new Map(); // `${cid}/${pid}/${file}` -> { until, hash }
  const OWN_WRITE_MS = 15_000;
  const fileKey = (cid, pid, file) => `${cid}/${pid}/${String(file || 'notebook.md').replace(/\\/g, '/').split('/').pop().toLowerCase()}`;
  function noteOwnWrite(cid, pid, file = 'notebook.md', { hash = null } = {}) {
    const k = fileKey(cid, pid, file);
    const cur = ownWrites.get(k);
    ownWrites.set(k, { until: now() + OWN_WRITE_MS, hash: hash || (cur && cur.hash) || null, exact: !!hash });
  }
  function isOwnEdit(cid, pid, file = 'notebook.md', { hash = null } = {}) {
    const k = fileKey(cid, pid, file);
    const w = ownWrites.get(k);
    if (!w) return false;
    if (hash && w.hash && w.exact) return hash === w.hash;
    if (now() <= w.until) { if (hash) w.hash = hash; return true; }
    if (hash && w.hash && hash === w.hash) return true;
    ownWrites.delete(k);
    return false;
  }

  return {
    LIMITS,
    prime, start, stop, kick,
    crosstalk, noteOwnWrite, isOwnEdit,
    ask, ticket, cancel, release, followup, forward,
    runDuty, resumeRun, noteDutyReport,
    noteTurnEnd, setWaitingOn, handedReads, busyText, queued, logEntries,
    answering: (sessionId) => { const t = answering(sessionId); return t ? { ticket: t.id, chain: t.chain, from: t.from, kind: t.kind } : null; },
    get: (id) => { const t = tickets.get(id); return t ? { ...t } : null; },
    list: (cid) => [...tickets.values()].filter((t) => !cid || t.company === cid).map((t) => ({ ...t })),
    on,
    // tests and diagnostics
    _internals: { tickets, outbox, waiters, running, rolls, rolling, edges, stateWords, whereWords },
  };
}

// The runtime's part of team.get `limits` (PROTOCOL); the tree caps (depthCap, reportsPerManager,
// positionsPerCompany) come from schema.js.
const PROTOCOL_LIMITS = Object.freeze({
  asksPerPositionHour: LIMITS.asksPerPositionHour, asksPerCompanyDay: LIMITS.asksPerCompanyDay,
  subAsksPerTicket: LIMITS.openSubAsksPerTicket, chainTickets: LIMITS.ticketsPerChain, expiryH: LIMITS.expiryMs / HOUR,
  waitS: [LIMITS.minWaitS, LIMITS.maxWaitS], questionChars: LIMITS.questionChars, colleagueChars: LIMITS.colleagueQuestionChars,
});

module.exports = { createRuntime, LIMITS, PROTOCOL_LIMITS, ROLL_PROMPT, rollThresholds, dur };
