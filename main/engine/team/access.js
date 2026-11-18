'use strict';
// Positions: access requests (docs/POSITIONS.md 7.3-7.4, 2.6; PROTOCOL.md "Positions"). A position asks the owner for a
// power it lacks (request_access) or the guard asks before an outward call; each ask is a normal session `request`
// card (kind 'access') in the position's chat, answered Approve once / Approve always / Deny.
//
//   const A = createAccess({ store, sessions, emit, clock?, log?, waitMs? })
//     store:    the team store (getPosition, updatePosition, append, tree, powersCtx, effectivePowers)
//     sessions: { get(sessionId) -> es | null }; es.openRequest({ kind:'access', title, body, access, toolName?, input?,
//               toolUseId?, signal?, waitMs }) -> { requestId, itemId, result: Promise<answer> }, es.closeRequest?(id, why)
//               answer: { behavior:'allow', scope:'once'|'always' } | { behavior:'deny', message? } | { timedOut:true }
//                       | { cancelled:true, message? }
//               es.s.position = { company, id, name, ... } (used to find the position of a session)
//     emit(event, payload): 'team.access.updated' { company, request } when a card opens or closes;
//                           'team.updated' { company } after an 'always' wrote position.json files.
//     waitMs:   the card lifetime (30 min). An unused once-grant expires the same time after it was granted.
//
//   A.request({ company, position, sessionId, ticket, kind, target, why, warn })
//      -> Promise<{ decision: 'once'|'always'|'denied'|'no-answer'|'stopped', note?, savedTo? }>
//      Resolves when the CARD closes (answer, timeout, cancel), not at the mcp handler's 600 s: a late answer still
//      stores its grant, so the position's next try works. A second request for the same thing while its card is
//      open joins that card; one already approved once (grant unused) answers 'once' at once without a new card.
//   A.requestApproval(req)   the guard's port for outward calls (Bash / tool that leaves the machine):
//      req = { kind:'outward', sessionId, toolName, toolInput, toolUseID, signal, command, what, title, waitMs }
//      -> Promise<{ decision:'once' } | { behavior:'deny', message, timedOut? }>   ('always' is answered as once)
//   A.consumeGrant(sessionId, need) -> grant | null   removes and returns the first unexpired once-grant of that
//      session's position that need.matches(grant) accepts (guard.grantMatches); without need.matches, kind+target.
//   A.pending(company?) -> [{ id, requestId, company, position, sessionId, kind, target, at, access }]   open cards, oldest
//      first; requestId = es.openRequest's, access = the PROTOCOL access object on the card (Team view answers in place)
//   A.grants(company?, position?) -> [{ id, kind, target, at, expiresAt, sessionId, position, company }]  unused once-grants
//   A.cancelFor(sessionId, why) closes that session's open cards (decision 'stopped'). A.stop() closes all, clears timers.
//
// Decisions:
//   once    -> an in-memory once-grant { id, kind, target, at, sessionId, position } keyed by company/position (so a
//              rolled-over chat of the same position can use it), consumed by the guard on one use, gone after waitMs.
//   always  -> saved into position.json powers through store.updatePosition (version +1): read -> powers.read,
//              write -> powers.write AND powers.read (an Edit needs a Read first), tool -> powers.tools (Agent/Task
//              also set agents: true; Bash/PowerShell lift bash off -> readonly), bash -> powers.bash (never lowered).
//              Every ancestor whose OWN powers would cut it (tree.widens) is widened the same way, farthest first,
//              so the tree rule (a report never exceeds its manager) holds. The card lists them (access.ancestors).
//              Beyond the company (tree.widens beyondCompany: a path outside the company folders) can never be a
//              standing power (effective powers are capped by the company), so 'always' there is answered as ONCE
//              with a note; the card carries access.onceOnly: true so the UI can offer Approve once / Deny only.
//              A save that fails (validation, a broken hand edit, a lock) also falls back to once, with the reason.
//   outward -> once only, never always (request_access kind 'outward' and requestApproval alike).
//   denied / no-answer / stopped -> nothing stored.
// Every closed request is ONE grants.jsonl line (spec 2.6): { id, position, request: { kind, target, why },
//   decision, savedTo?, note?, sessionId?, ticket?, via? } (decision also 'stopped' for a cancelled card; via:'guard'
//   for an outward card the guard opened). Open cards are not on disk; pending() lists them.

const crypto = require('crypto');
const S = require('./schema');
const { subset } = require('./tree');
const { ownerWords } = require('./owner');
const { teamEvent } = require('./notice');

const WAIT_MS = 30 * 60_000;
const KINDS = ['read', 'write', 'tool', 'bash', 'outward'];
const BASH_RANK = { off: 0, readonly: 1, on: 2 };
const SHELL = ['Bash', 'PowerShell'];

const gid = () => `g_${crypto.randomBytes(3).toString('hex')}`;
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

function createAccess({ store, sessions, emit, clock, log, waitMs, ownerName } = {}) {
  const who = () => ownerWords(ownerName); // resolved per message, so a Settings > Team change applies at once
  const C = {
    now: (clock && clock.now) || (() => Date.now()),
    setTimeout: (clock && clock.setTimeout) || ((fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; }),
    clearTimeout: (clock && clock.clearTimeout) || ((t) => clearTimeout(t)),
  };
  const LIFE = Number.isFinite(waitMs) && waitMs > 0 ? waitMs : WAIT_MS;
  const say = (level, msg) => { try { if (typeof log === 'function') log(level, `team-access: ${msg}`); } catch {} };
  const fire = (ev, payload) => { try { if (typeof emit === 'function') emit(ev, payload); } catch (e) { say('warn', `emit ${ev} failed: ${e.message}`); } };
  const iso = (ms) => new Date(ms).toISOString();

  const open = new Map();       // card id -> { row, es, requestId, timer, settle, promise, key }
  const onceGrants = new Map(); // `${company}/${position}` -> [grant]

  const posKey = (cid, pid) => `${cid}/${pid}`;
  const reqKey = (cid, pid, kind, target) => `${cid}/${pid}/${kind}/${kind === 'read' || kind === 'write' ? S.pathKey(target) : oneLine(target)}`;

  function getEs(sessionId) {
    try { return sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) || null : null; } catch { return null; }
  }
  function positionOf(sessionId) {
    const es = getEs(sessionId);
    const p = es && es.s && es.s.position;
    return p && p.company && p.id ? p : null;
  }
  function safeStore(fn, fallback) {
    try { return fn(); } catch (e) { say('warn', e.message); return fallback; }
  }
  function logLine(cid, obj) {
    try { store.append(cid, 'grants', obj); } catch (e) { say('error', `grants.jsonl append failed for ${cid}: ${e.message}`); }
  }

  // ---------------------------------------------------------------- once-grants

  function purge(key) {
    const list = onceGrants.get(key);
    if (!list) return [];
    const now = C.now();
    const live = list.filter((g) => g.expiresAt > now);
    if (live.length) onceGrants.set(key, live); else onceGrants.delete(key);
    return live;
  }
  function addOnce(cid, pid, { id, kind, target, sessionId }) {
    const at = C.now();
    const g = { id, kind, target, at: iso(at), expiresAt: at + LIFE, sessionId: sessionId || null, position: pid, company: cid };
    const key = posKey(cid, pid);
    onceGrants.set(key, [...purge(key), g]);
    return g;
  }

  function consumeGrant(sessionId, need) {
    try {
      const p = positionOf(sessionId);
      if (!p || !need) return null;
      const key = posKey(p.company, p.id);
      const list = purge(key);
      const match = typeof need.matches === 'function'
        ? (g) => { try { return !!need.matches(g); } catch { return false; } }
        : (g) => g.kind === need.kind && reqKey('', '', g.kind, g.target) === reqKey('', '', need.kind, need.target);
      const i = list.findIndex(match);
      if (i < 0) return null;
      const [g] = list.splice(i, 1);
      if (list.length) onceGrants.set(key, list); else onceGrants.delete(key);
      say('info', `${p.company}/${p.id} used once-grant ${g.id} (${g.kind} ${oneLine(g.target).slice(0, 120)})`);
      return g;
    } catch (e) {
      say('error', `consumeGrant failed: ${e.message}`);
      return null;
    }
  }

  function grants(cid, pid) {
    const out = [];
    for (const key of [...onceGrants.keys()]) for (const g of purge(key)) {
      if ((cid == null || g.company === cid) && (pid == null || g.position === pid)) out.push({ ...g });
    }
    return out;
  }

  // ---------------------------------------------------------------- the tree side of "always"

  function namePath(cid, pid) {
    return safeStore(() => {
      const t = store.tree(cid);
      const ids = [...(t.ancestors(pid) || [])].reverse().concat(pid);
      return ids.map((id) => { const p = store.getPosition(cid, id); return (p && p.name) || id; });
    }, [pid]);
  }

  // Which ancestors an 'always' widens, and whether it is beyond the company (once-only).
  function plan(cid, pid, kind, target) {
    if (kind === 'outward') return { ancestors: [], onceOnly: true, beyondCompany: false };
    return safeStore(() => {
      const t = store.tree(cid);
      const ctx = store.powersCtx(cid);
      const kinds = kind === 'write' ? ['read', 'write'] : [kind];
      const anc = new Set();
      let beyond = false;
      for (const k of kinds) {
        const w = t.widens(pid, { kind: k, target }, ctx);
        for (const a of w.ancestors || []) anc.add(a);
        if (w.beyondCompany) beyond = true;
      }
      const order = [...(t.ancestors(pid) || [])]; // nearest first
      return { ancestors: order.filter((a) => anc.has(a)), onceOnly: beyond, beyondCompany: beyond };
    }, { ancestors: [], onceOnly: false, beyondCompany: false });
  }

  // Add the request to one position's own powers (fn for store.updatePosition).
  function widenFn(cid, kind, target) {
    return (cur) => {
      const coding = cur.scope && cur.scope.kind === 'product';
      const pw = { ...S.defaultPowers({ coding }), ...(cur.powers || {}) };
      const ctx = { workspace: null, companyFolders: (store.powersCtx(cid) || {}).companyFolders || [], scopeFolder: coding ? cur.scope.folder : null };
      const addPath = (k) => {
        const list = Array.isArray(pw[k]) ? pw[k].slice() : [];
        const n = S.normPath(target);
        const own = S.expandPathTokens(list, ctx);
        if (!own.some((e) => subset(n, e))) list.push(n);
        pw[k] = list;
      };
      if (kind === 'read') addPath('read');
      else if (kind === 'write') { addPath('read'); addPath('write'); }
      else if (kind === 'tool') {
        const tools = Array.isArray(pw.tools) ? pw.tools.slice() : [];
        if (!tools.includes(target)) tools.push(target);
        pw.tools = tools;
        if (S.AGENT_TOOLS.includes(target)) pw.agents = true;
        if (SHELL.includes(target) && (pw.bash || 'off') === 'off') pw.bash = 'readonly';
      } else if (kind === 'bash') {
        const want = String(target).replace(/^bash:/, '');
        if ((BASH_RANK[want] ?? 0) > (BASH_RANK[pw.bash] ?? 0)) pw.bash = want;
      }
      return { ...cur, powers: pw };
    };
  }

  function covers(cid, pid, kind, target) {
    const eff = safeStore(() => store.effectivePowers(cid, pid), null);
    if (!eff) return false;
    if (kind === 'read' || kind === 'write') return (eff[kind] || []).some((e) => subset(S.normPath(target), e));
    if (kind === 'tool') return (eff.tools || []).includes(target) || (SHELL.includes(target) && eff.bash !== 'off');
    if (kind === 'bash') return (BASH_RANK[eff.bash] ?? 0) >= (BASH_RANK[String(target).replace(/^bash:/, '')] ?? 9);
    return false;
  }

  // -> { ok: true, savedTo } | { ok: false, why }
  function saveAlways(cid, pid, kind, target) {
    const pl = plan(cid, pid, kind, target);
    if (pl.beyondCompany) return { ok: false, why: `${target} is outside the company's folders, so it cannot be a standing power` };
    const order = [...pl.ancestors].reverse(); // farthest first: a report never sits wider than its manager on disk
    const savedTo = [];
    try {
      for (const id of [...order, pid]) {
        store.updatePosition(cid, id, widenFn(cid, kind, target));
        savedTo.push(id);
      }
    } catch (e) {
      say('error', `always for ${cid}/${pid} (${kind} ${target}) failed after [${savedTo.join(', ')}]: ${e.message}`);
      if (savedTo.length) fire('team.updated', { company: cid });
      return { ok: false, why: `Helm could not save it (${e.message})`, savedTo };
    }
    fire('team.updated', { company: cid });
    // the save went in, but effective powers still cut it (a hand-edited tree, a rule tree.widens does not see):
    if (!covers(cid, pid, kind, target)) return { ok: false, why: 'it was saved, but your effective powers still do not include it', savedTo, saved: true };
    return { ok: true, savedTo };
  }

  // ---------------------------------------------------------------- cards

  function title(name, kind, target) {
    if (kind === 'read' || kind === 'write') return `${name} asks for ${kind} access`;
    if (kind === 'tool') return `${name} asks for the ${target} tool`;
    if (kind === 'bash') return `${name} asks for Bash ${String(target).replace(/^bash:/, '')}`;
    return `${name} asks to run an outward action`;
  }

  function publicRow(c) {
    const r = c.row;
    return { id: r.id, requestId: c.requestId, company: r.company, position: r.position, sessionId: r.sessionId, kind: r.kind, target: r.target, at: r.at, access: r.access };
  }

  // Open one card. -> { id, promise } where promise resolves with the raw outcome { answer } once it closes.
  function openCard({ company, position, sessionId, kind, target, why, warn, ticket, outward, onceOnly, ancestors, command, toolName, input, toolUseId, signal, wait, cardTitle, via }) {
    const es = getEs(sessionId);
    if (!es || typeof es.openRequest !== 'function') return { error: "the position's chat is not open, so Helm could not show the card" };
    const pos = safeStore(() => store.getPosition(company, position), null);
    const name = (pos && pos.name) || position;
    const id = gid();
    const lifeMs = Number.isFinite(wait) && wait > 0 ? wait : LIFE;
    const access = {
      kind, target, why, position: { id: position, name, path: namePath(company, position) },
      ...(ancestors && ancestors.length ? { ancestors } : {}),
      outward: !!outward,
      ...(onceOnly && !outward ? { onceOnly: true } : {}),
      ...(warn ? { warn: true } : {}),
      ...(command != null ? { command: String(command) } : {}),
      waitMin: Math.max(1, Math.round(lifeMs / 60_000)),
    };
    const body = [oneLine(target), why ? oneLine(why) : '', warn ? 'Note: this is inside ~/.claude (Claude settings and history).' : '']
      .filter(Boolean).join('\n');
    // the toast / phone push for the card, titled by teamNotice ("<position> needs your OK"; notice.js). The session
    // sends it once, when the card shows.
    const co = safeStore(() => store.getCompany(company), null);
    const isOut = !!outward || kind === 'outward';
    const ask = isOut ? oneLine(command != null ? command : target)
      : [cardTitle || title(name, kind, target), kind === 'read' || kind === 'write' ? oneLine(target) : ''].filter(Boolean).join(': ');
    const notice = teamEvent({ what: isOut ? 'outward' : 'access', company: { id: company, name: co && co.name }, position: { id: position, name },
      detail: ask, sessionId });
    let opened;
    try {
      opened = es.openRequest({
        kind: 'access', title: cardTitle || title(name, kind, target), body, access,
        ...(toolName ? { toolName } : {}), ...(input !== undefined ? { input } : {}), ...(toolUseId ? { toolUseId } : {}),
        ...(signal ? { signal } : {}), waitMs: lifeMs, notice,
      });
    } catch (e) {
      return { error: `Helm could not show the card (${e.message})` };
    }
    if (!opened || !opened.result || typeof opened.result.then !== 'function') return { error: 'Helm could not show the card' };
    const row = { id, company, position, sessionId, kind, target, why, ticket: ticket || null, at: iso(C.now()), via, access };
    const card = { row, es, requestId: opened.requestId, itemId: opened.itemId, timer: null, settle: null };
    card.promise = new Promise((resolve) => {
      let done = false;
      card.settle = (outcome) => {
        if (done) return;
        done = true;
        if (card.timer != null) { try { C.clearTimeout(card.timer); } catch {} card.timer = null; }
        open.delete(id);
        fire('team.access.updated', { company, request: { ...publicRow(card), state: 'closed' } });
        resolve(outcome);
      };
    });
    open.set(id, card);
    // backstop: the card should time itself out at lifeMs; if it does not, close it here
    card.timer = C.setTimeout(() => {
      card.timer = null;
      try { if (typeof es.closeRequest === 'function') es.closeRequest(opened.requestId, 'No answer in time; closed.'); } catch {}
      card.settle({ timedOut: true });
    }, lifeMs + 1000);
    Promise.resolve(opened.result).then(
      (answer) => card.settle(answer && typeof answer === 'object' ? answer : { cancelled: true, message: 'No answer came back.' }),
      (e) => card.settle({ cancelled: true, message: (e && e.message) || 'the card failed' }),
    );
    fire('team.access.updated', { company, request: { ...publicRow(card), state: 'open' } });
    say('info', `card ${id} open: ${company}/${position} ${kind} ${oneLine(target).slice(0, 160)}`);
    return { id, card };
  }

  // ---------------------------------------------------------------- request_access

  const joined = new Map(); // reqKey -> promise of the open card's decision

  async function request({ company, position, sessionId, ticket, kind, target, why, warn } = {}) {
    kind = String(kind || '');
    target = target == null ? '' : String(target);
    if (!KINDS.includes(kind) || !target || !company || !position) return { decision: 'denied', note: 'The request was not valid.' };
    if (kind === 'read' || kind === 'write') target = S.normPath(target);
    const pos = safeStore(() => store.getPosition(company, position), null);
    if (!pos || pos.status === 'retired') return { decision: 'denied', note: `No live position "${position}".` };
    const rk = reqKey(company, position, kind, target);
    if (joined.has(rk)) return joined.get(rk);
    const ready = purge(posKey(company, position)).find((g) => reqKey(company, position, g.kind, g.target) === rk);
    if (ready) return { decision: 'once', note: `${who().Owner} already approved this once; it is ready for your next try.` };

    const outward = kind === 'outward';
    const pl = plan(company, position, kind, target);
    const o = openCard({
      company, position, sessionId, kind, target, why, warn, ticket, outward, onceOnly: pl.onceOnly, ancestors: pl.ancestors,
      command: outward ? target : undefined, via: 'request_access',
    });
    if (o.error) {
      logLine(company, { id: gid(), position, request: { kind, target, why }, decision: 'denied', note: o.error, sessionId, ...(ticket ? { ticket } : {}) });
      return { decision: 'denied', note: o.error };
    }
    const p = o.card.promise.then((answer) => decideRequest(o.card, answer, { outward }));
    joined.set(rk, p);
    p.then(() => joined.delete(rk), () => joined.delete(rk));
    return p;
  }

  function decideRequest(card, answer, { outward }) {
    const { id, company, position, sessionId, kind, target, why, ticket } = card.row;
    const line = { id, position, request: { kind, target, why }, sessionId, ...(ticket ? { ticket } : {}) };
    let out;
    try {
      if (answer && answer.behavior === 'allow') {
        const wantAlways = answer.scope === 'always';
        if (wantAlways && !outward) {
          const r = saveAlways(company, position, kind, target);
          if (r.ok) {
            const widened = r.savedTo.filter((x) => x !== position);
            out = { decision: 'always', savedTo: r.savedTo, note: `Saved to your standing powers${widened.length ? ` (also widened ${widened.join(', ')})` : ''}.` };
            logLine(company, { ...line, decision: 'always', savedTo: r.savedTo });
          } else {
            addOnce(company, position, { id, kind, target, sessionId });
            out = { decision: 'once', note: `Approved once: ${r.why}.` };
            logLine(company, { ...line, decision: 'once', ...(r.savedTo && r.savedTo.length ? { savedTo: r.savedTo } : {}), note: `asked always; ${r.why}` });
          }
        } else {
          addOnce(company, position, { id, kind, target, sessionId });
          out = { decision: 'once', ...(wantAlways ? { note: 'Approved once (outward actions are never standing).' } : {}) };
          logLine(company, { ...line, decision: 'once', ...(wantAlways ? { note: 'asked always; outward is once only' } : {}) });
        }
      } else if (answer && answer.behavior === 'deny') {
        const msg = answer.message ? String(answer.message) : '';
        out = { decision: 'denied', note: `${who().Owner} declined this request. The decline covers this attempt; a later need may ask again.${msg ? ` Note from ${who().owner}: "${msg}"` : ''}` };
        logLine(company, { ...line, decision: 'denied', ...(msg ? { note: msg } : {}) });
      } else if (answer && answer.timedOut) {
        out = { decision: 'no-answer', note: `${who().Owner} did not answer in time. Continue without it and record an Open item.` };
        logLine(company, { ...line, decision: 'no-answer' });
      } else {
        const msg = (answer && answer.message) ? String(answer.message) : `The card was closed before ${who().owner} answered.`;
        out = { decision: 'stopped', note: msg };
        logLine(company, { ...line, decision: 'stopped', note: msg });
      }
    } catch (e) {
      say('error', `deciding card ${id} failed: ${e.message}`);
      out = { decision: 'denied', note: `Helm could not record the decision (${e.message}).` };
    }
    say('info', `card ${id} closed: ${company}/${position} ${kind} -> ${out.decision}`);
    return out;
  }

  // ---------------------------------------------------------------- the guard's outward port

  async function requestApproval(req = {}) {
    try {
      const p = positionOf(req.sessionId);
      if (!p) return { behavior: 'deny', message: 'Helm could not tell which position this chat belongs to.' };
      const command = req.command != null && req.command !== '' ? String(req.command)
        : (req.toolInput !== undefined ? safeStore(() => JSON.stringify(req.toolInput), '') : '');
      const what = Array.isArray(req.what) ? req.what.join(', ') : '';
      const target = command || req.toolName || 'outward action';
      const o = openCard({
        company: p.company, position: p.id, sessionId: req.sessionId, kind: 'outward', target,
        why: what ? `Leaves the machine: ${what}` : 'Leaves the machine', outward: true, onceOnly: true, command,
        toolName: req.toolName, input: req.toolInput, toolUseId: req.toolUseID, signal: req.signal, wait: req.waitMs, via: 'guard',
      });
      if (o.error) return { behavior: 'deny', message: o.error };
      const answer = await o.card.promise;
      const { id, position, sessionId, why } = o.card.row;
      const line = { id, position, request: { kind: 'outward', target, why }, sessionId, via: 'guard' };
      if (answer && answer.behavior === 'allow') {
        logLine(p.company, { ...line, decision: 'once', ...(answer.scope === 'always' ? { note: 'asked always; outward is once only' } : {}) });
        return { decision: 'once' };
      }
      if (answer && answer.behavior === 'deny') {
        logLine(p.company, { ...line, decision: 'denied', ...(answer.message ? { note: String(answer.message) } : {}) });
        return { behavior: 'deny', message: answer.message ? String(answer.message) : '' };
      }
      if (answer && answer.timedOut) {
        logLine(p.company, { ...line, decision: 'no-answer' });
        return { behavior: 'deny', timedOut: true, message: `${who().Owner} did not answer in time.` };
      }
      const msg = (answer && answer.message) ? String(answer.message) : `The card was closed before ${who().owner} answered.`;
      logLine(p.company, { ...line, decision: 'stopped', note: msg });
      return { behavior: 'deny', message: msg };
    } catch (e) {
      say('error', `requestApproval failed: ${e.message}`);
      return { behavior: 'deny', message: `Helm could not ask ${who().owner} (${e.message}).` };
    }
  }

  // ---------------------------------------------------------------- lists and teardown

  function pending(cid) {
    return [...open.values()].filter((c) => cid == null || c.row.company === cid).map(publicRow)
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  function closeCard(c, why) {
    try { if (c.es && typeof c.es.closeRequest === 'function') c.es.closeRequest(c.requestId, why); } catch (e) { say('warn', `closeRequest failed: ${e.message}`); }
    c.settle({ cancelled: true, message: why });
  }

  function cancelFor(sessionId, why = `The chat ended before ${who().owner} answered.`) {
    let n = 0;
    for (const c of [...open.values()]) if (c.row.sessionId === sessionId) { closeCard(c, why); n++; }
    return n;
  }

  function stop(why = 'Positions were turned off.') {
    for (const c of [...open.values()]) closeCard(c, why);
    onceGrants.clear();
  }

  return { request, requestApproval, consumeGrant, pending, grants, cancelFor, stop, WAIT_MS: LIFE };
}

module.exports = { createAccess, WAIT_MS };
