// Positions: the team cards in a chat (lane T7, docs/POSITIONS.md 10.4; shapes in section 11).
//   Ask card       mcp__team__team_ask / colleague_ask tool items, in the asker's chat: who is asked, a live state line,
//                  elapsed time, the chain of sub-asks (one indented line each), [Open Legal] [Cancel question]. On an
//                  answer it collapses to one line with the answer under a disclosure (5.4).
//   Asked-by       user items with origin ask | duty | answer | seed, in the answerer's chat: left-aligned and labelled
//                  ("Asked by CEO · Atlas Studio"), never the owner's right-hand bubble. Handed files show as chips.
//   Answer card    team item kind "answer": a late answer after the owner pressed Stop (5.5), [Show] [Send to CEO].
//   Proposal card  team item kind "proposal": create / edit / retire / company, [Approve] [Change…] [Decline]; decided
//                  ones collapse to "Approved 14:02 (your click)" (6.3).
//   Notice         team item kind "notice": one quiet line.
// The access card (request kind "access", 7.4) sits with the other request cards in requests.js.
// Every card is built from the request card's structure (.req-card / .req-head / .req-why / .req-actions).
// Dispatch (ui/chat/index.js): isTeamCard(item) keeps a team card out of tool groups, teamUnit(item, sid) renders it.
import { useState } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { Markdown } from '../lib/markdown.js';
import { rpc, send, toast, sessions, itemsBySession } from '../lib/store.js';
import { openSession } from '../shell/state.js';
import { now, useTicker, isOpen, toggle } from './state.js';
import { memo, fmtTime, fmtDuration, basename, resultText } from './util.js';
import { proposalChanges, excessHeadline, draftPowerChips, scopeWords, pathWords, cronWords, triggerWords as dutyTriggerWords, baseName, pathKey } from '../lib/positions-model.js';

export const ASK_TOOLS = new Set(['mcp__team__team_ask', 'mcp__team__colleague_ask']);
const ORIGINS = new Set(['ask', 'duty', 'answer', 'seed']);
export const isTeamCard = (it) => !!it && ((it.type === 'tool' && ASK_TOOLS.has(it.name)) || it.type === 'team'
  || (it.type === 'user' && ORIGINS.has(it.origin)));

// ---------- words ----------
const str = (v) => (typeof v === 'string' ? v.trim() : '');
// "payroll-tax" -> "Payroll tax"; a name ("Tax Specialist") stays as it is
export const nameOf = (id) => { const s = String(id ?? '').replace(/[-_]+/g, ' ').trim(); return s ? s[0].toUpperCase() + s.slice(1) : ''; };
const nm = (x) => (x && typeof x === 'object' ? str(x.name) || nameOf(x.id) : nameOf(x));
const firstLine = (s) => String(s ?? '').trim().split('\n')[0];
// a coarse clock for state lines: 45s, 2m, 1h 5m (the answered time uses fmtDuration: 3m 40s)
export function ago(ms) {
  const s = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}
const list = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const sessionOf = (sid) => (sessions.value || []).find((s) => s.id === sid) || null;

// ---------- ask: state + chain ----------
// Ticket states (crosstalk.jsonl): asked | delivered | answered | pending | late | refused | expired | cancelled. The
// card also takes "queued", "working", "waiting" and "access" (waiting for the owner's OK on an access request), and a
// state string with a reason ("queued: the owner is talking with Legal").
const STATE = { asked: 'queued', queued: 'queued', delivered: 'working', working: 'working', pending: 'working', late: 'working',
  waiting: 'working', access: 'access', answered: 'answered', refused: 'refused', expired: 'expired', cancelled: 'cancelled', canceled: 'cancelled' };
export const normState = (s) => { const k = String(s || '').trim().toLowerCase().split(/[\s:(·]/)[0]; return k ? STATE[k] || 'working' : ''; };
const OPEN = new Set(['queued', 'working', 'access']);
const reasonOf = (raw) => { const m = /^\s*\w+\s*[:(·]\s*(.+?)\)?\s*$/.exec(String(raw || '')); return m ? m[1] : ''; };
// The engine's words for a ticket (runtime.js stateWords, the chain row's `detail`): "queued: the owner is talking with
// Legal", "working 3m", "waiting on Tax Specialist", "waiting for the owner's OK on Tax's access request", any of them
// after "late: ". The detail says more than the display state: a 'pending' or 'late' ticket may still be queued.
// the engine names the owner (ownerName) to positions; the owner reads this card, so it says 'you'
const youWords = (note) => String(note || '').replace(/^.+? is talking with /i, 'you are talking with ');
function detailState(detail) {
  const d = str(detail).replace(/^late:\s*/i, '');
  if (!d) return null;
  const q = /^queued\s*:\s*(.+)$/i.exec(d);
  if (q) return { state: 'queued', note: youWords(q[1].trim()) };
  if (/^queued$/i.test(d)) return { state: 'queued', note: '' };
  if (/\bOK on\b.*\baccess request\b/i.test(d)) return { state: 'access', note: '' };
  // settled: 'late' is also the display state of an answer that came late, so the words decide
  if (/^answered\b/i.test(d)) return { state: 'answered', note: '' };
  const c = /^cancelled\b\s*:?\s*(.*)$/i.exec(d);
  if (c) return { state: 'cancelled', note: c[1].trim() };
  if (/^expired\b/i.test(d)) return { state: 'expired', note: '' };
  return null;
}
// "<someone> is talking with <position>": the ask waits for the owner's quiet window, so [Let it answer now] can skip it
export const talkingWith = (note) => /\b(?:is|are) talking with\b/i.test(String(note || ''));

// A chain row's sinceMs is the time in its state when the event was made (runtime.js snapshot). The card keeps
// counting from there: the first time a (ticket, sinceMs) value is seen, the wall clock is noted, and the row shows
// sinceMs + (wall now - wall then); the card re-renders with the ticker. Wall clock both times, never the ticker's
// value, which can be stale on a first render. An epoch value (old shape) counts from that moment (at - sinceMs).
const seen = new Map();   // ticket -> { since, wall }
export function liveSince(ticket, sinceMs, at, wall = Date.now()) {
  if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs)) return null;
  if (sinceMs > 1e11) return Math.max(0, at - sinceMs);
  if (!ticket) return sinceMs;
  let s = seen.get(ticket);
  if (!s || s.since !== sinceMs) {
    s = { since: sinceMs, wall };
    seen.delete(ticket);
    seen.set(ticket, s);
    if (seen.size > 400) seen.delete(seen.keys().next().value);
  }
  return sinceMs + Math.max(0, wall - s.wall);
}

// chain: the engine's [{ ticket, parentTicket, to, name, state, detail, sinceMs }] (older shapes: parent, note,
// tookMs, depth) -> rows with a depth from the root (0). Without parent links the chain is read as a straight line,
// each asked by the one before (CEO -> Legal -> Tax).
export function normChain(chain, at = Date.now(), wall = Date.now()) {
  const rows = (Array.isArray(chain) ? chain : []).filter((c) => c && (c.ticket || c.to));
  const byT = new Map(rows.map((c) => [c.ticket, c]));
  const pOf = (c) => c.parent || c.parentTicket || null;
  const linked = rows.some((c) => pOf(c) && byT.has(pOf(c)));
  const out = rows.map((c, i) => {
    let depth = i;
    if (Number.isFinite(c.depth)) depth = c.depth;
    else if (linked) { depth = 0; for (let p = pOf(c), n = 0; p && byT.has(p) && n < 16; p = pOf(byT.get(p)), n++) depth++; }
    const ds = detailState(c.detail);
    let state = normState(c.state);
    if (ds) state = ds.state;
    return { ticket: c.ticket || null, parent: linked ? pOf(c) : (i ? rows[i - 1].ticket || null : null), to: c.to || '', name: str(c.name) || nameOf(c.to),
      state, access: state === 'access' || c.access === true, note: youWords((ds && ds.note) || str(c.note) || reasonOf(c.state)), detail: str(c.detail),
      elapsed: liveSince(c.ticket, c.sinceMs ?? c.since, at, wall), took: Number.isFinite(c.tookMs) ? c.tookMs : null, depth };
  });
  const min = Math.min(...out.map((c) => c.depth));
  for (const c of out) c.depth -= min;
  return out;
}
const kidsOf = (e, chain) => chain.filter((c) => c !== e && c.parent && c.parent === e.ticket);
const openKid = (e, chain) => kidsOf(e, chain).filter((c) => OPEN.has(c.state)).pop() || null;
const sinceTxt = (e) => (e.elapsed == null ? '' : ` · ${ago(e.elapsed)}`);

// one chain row's state, short
export function stepWords(e, chain, at) {
  if (e.access && OPEN.has(e.state)) return 'waiting for your OK';
  switch (e.state) {
    case 'queued': return e.note ? `queued · ${e.note}` : 'queued';
    case 'working': { const k = openKid(e, chain); return k ? `waiting on ${k.name}` : `working${sinceTxt(e)}`; }
    case 'answered': return e.took ? `answered in ${fmtDuration(e.took)}` : 'answered';
    case 'refused': return e.note ? `refused · ${e.note}` : 'refused';
    case 'expired': return 'no answer in 2 h';
    case 'cancelled': return 'cancelled';
    default: return '';
  }
}
// the card's main line, from the root ticket
export function askLine(root, chain, at, to) {
  const acc = chain.find((c) => c.access && OPEN.has(c.state));
  if (acc) return { text: `Waiting for your OK on ${acc.name}${/s$/i.test(acc.name || '') ? "'" : "'s"} access request`, tone: 'waiting' };
  if (!root) return { text: `Waiting for ${to}`, tone: 'working' };
  if (root.state === 'queued') return { text: `Queued · ${root.note || `${root.name} takes it when it is free`}`, tone: 'idle' };
  const k = openKid(root, chain);
  if (k) return { text: `${root.name} asked ${k.name}${sinceTxt(k)}`, tone: 'working' };
  return { text: `${root.name} is working${sinceTxt(root)}`, tone: 'working' };
}
// the MCP tool result: { status: "answered"|"pending"|"refused", ticket, from, answer, took_s, chain, state, note, reason }
export function parseResult(result) {
  if (result && typeof result === 'object' && !Array.isArray(result) && typeof result.status === 'string') return result;
  let t = resultText(result);
  try { const j = JSON.parse(t); if (Array.isArray(j)) t = j.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join(''); else if (j && typeof j === 'object') return j; } catch { return null; }
  try { const j = JSON.parse(t); return j && typeof j === 'object' ? j : null; } catch { return null; }
}

// item (a team_ask / colleague_ask tool item) -> what the card shows
export function askModel(item, at = Date.now(), wall = Date.now()) {
  const input = item.input || {}, team = item.team || {}, res = parseResult(item.result);
  const ticket = team.ticket || res?.ticket || null;
  const chain = normChain(team.chain || res?.chain, at, wall);
  let root = chain.find((c) => ticket && c.ticket === ticket) || chain.find((c) => c.depth === 0) || null;
  const ds = detailState(team.detail);   // the root ticket's words, also when the event carried no chain
  if (ds && root && !detailState(root.detail)) { root.state = ds.state; root.access = ds.state === 'access'; root.note = ds.note || root.note; }
  if (!root && ds && ticket) root = { ticket, parent: null, to: input.to || '', name: nameOf(input.to) || 'the position', state: ds.state, access: ds.state === 'access', note: ds.note, detail: str(team.detail), elapsed: null, took: null, depth: 0 };
  const to = root?.name || nameOf(input.to) || nameOf(res?.from) || 'the position';
  let st = normState(team.state) || root?.state || normState(res?.status);
  if (ds) st = ds.state;
  const stopped = item.status === 'error' && !!item.interrupted;
  let phase;
  if (res?.status === 'refused' || st === 'refused') phase = 'refused';
  else if (st === 'answered' || res?.status === 'answered') phase = 'answered';
  else if (st === 'cancelled') phase = 'cancelled';
  else if (st === 'expired') phase = 'expired';
  else if (item.status === 'running') phase = 'live';
  else if (!ticket) phase = stopped ? 'unsent' : 'failed';
  else phase = stopped ? 'stopped' : 'pending';   // the call returned "pending" (or ended); the ticket goes on
  const asked = item.startedAt || item.ts || null;
  const answer = str(team.answer) || (res?.status === 'answered' ? str(res.answer) : '');
  const took = Number.isFinite(res?.took_s) ? res.took_s * 1000 : root?.took ?? (team.answeredAt && asked ? team.answeredAt - asked : null);
  const lost = chain.filter((c) => OPEN.has(c.state) || c.state === 'expired').pop();
  // [Let it answer now]: an open ask queued only because the owner is talking with that position (runtime.js 5.3 release)
  const held = [root, ...chain.filter((c) => c !== root)].find((c) => c && c.ticket && c.state === 'queued' && talkingWith(c.note)) || null;
  return {
    release: held && OPEN_PHASES.has(phase) ? { ticket: held.ticket, name: held.name, root: held === root } : null,
    phase, to, toId: input.to || root?.to || '', colleague: item.name === 'mcp__team__colleague_ask', question: str(input.question),
    ticket, chain, root, asked, answer, took, late: phase === 'answered' && (!!team.late || (!!res && res.status !== 'answered') || stopped),
    line: OPEN_PHASES.has(phase) ? askLine(root, chain, at, to) : null,
    reason: str(res?.reason) || str(team.reason) || (phase === 'failed' ? firstLine(resultText(item.result)) : '') || root?.note || '',
    where: phase === 'expired' && lost && lost !== root ? lost.name : '',
  };
}
export const OPEN_PHASES = new Set(['live', 'pending', 'stopped']);
// tickets the owner let through with [Let it answer now]: while its chat is still busy the engine keeps the "is talking
// with" reason, so the button would come back on the next event; it stays a quiet line instead
const released = new Set();

const DOT = { queued: 'idle', working: 'working live', access: 'waiting', answered: 'ok', refused: 'error', expired: 'error', cancelled: 'closed' };
const dotOf = (c) => (c.access && OPEN.has(c.state) ? 'waiting' : DOT[c.state] || 'idle');

function ChainTree({ chain, at }) {
  return html`<ol class="tc-chain" aria-label="Who is on it">
    ${chain.map((c) => html`<li key=${c.ticket || c.name} class=${'tc-step s-' + c.state + (c.depth ? ' kid' : '') + (c.depth > 3 ? ' deep-p' : '') + (c.depth > 4 ? ' deep-d' : '')}
        style=${`--d:${Math.min(c.depth, 4)}`} data-ticket=${c.ticket}>
      <span class=${'dot ' + dotOf(c)} aria-hidden="true"></span>
      <span class="tc-step-name" title=${c.name}><span class="tc-step-more">… › </span>${c.name}</span>
      <span class="tc-step-state">${stepWords(c, chain, at)}</span>
    </li>`)}
  </ol>`;
}

function recordWords(m) {
  switch (m.phase) {
    case 'answered': return { icon: 'check-circle', tone: 'ok', strong: m.to, tail: m.late ? ' answered (late)' : ' answered',
      meta: m.took ? `in ${fmtDuration(m.took)}` : m.answer ? '' : m.late ? 'its answer is further down' : '' };
    case 'refused': return { icon: 'ban', tone: 'bad', strong: m.to, tail: ' could not take the question', note: m.reason };
    case 'cancelled': return { icon: 'x', tone: 'dim', lead: 'Question to ', strong: m.to, tail: ' cancelled' };
    case 'expired': return { icon: 'clock', tone: 'bad', lead: 'No answer from ', strong: m.to, tail: ' in 2 h', meta: m.where ? `stopped at ${m.where}` : '' };
    case 'unsent': return { icon: 'x', tone: 'dim', lead: 'Question to ', strong: m.to, tail: ' not sent · you stopped' };
    default: return { icon: 'alert', tone: 'bad', lead: 'Could not ask ', strong: m.to, note: m.reason };
  }
}

function AskRecord({ m, k, id }) {
  const open = isOpen(k, false);
  const r = recordWords(m);
  const more = !!m.answer || m.chain.length > 1 || (m.phase !== 'answered' && !!m.question);
  const body = html`<${Icon} name=${r.icon} size=${13} />
    <span class="tc-rec-text">${r.lead || ''}<strong>${r.strong}</strong>${r.tail || ''}${r.meta ? html`<span class="tc-rec-meta"> · ${r.meta}</span>` : null}</span>
    ${r.note ? html`<span class="req-note tc-rec-note">“${r.note}”</span>` : null}`;
  if (!more) return html`<div class=${'req-record tc-rec ' + r.tone} data-item-id=${id} data-state=${m.phase}>${body}</div>`;
  return html`<div class=${'tc-rec-wrap' + (open ? ' open' : '')} data-item-id=${id} data-state=${m.phase} data-ticket=${m.ticket}>
    <button type="button" class=${'req-record tc-rec tc-rec-btn ' + r.tone} aria-expanded=${open} data-act="ask-toggle" onClick=${() => toggle(k, false)}>
      ${body}${!open && m.answer ? html`<span class="tc-peek">${firstLine(m.answer)}</span>` : html`<span class="grow" />`}
      <span class="trow-chev"><${Icon} name="chevron-right" size=${12} /></span>
    </button>
    ${open ? html`<div class="tc-reveal">
      ${m.question ? html`<div class="tc-q-full"><span class="tc-label">Asked</span>${m.question}</div>` : null}
      ${m.answer ? html`<div class="tc-answer"><${Markdown} text=${m.answer} /></div>` : null}
      ${m.chain.length > 1 ? html`<${ChainTree} chain=${m.chain} at=${now.peek ? now.peek() : now.value} />` : null}
    </div>` : null}
  </div>`;
}

function AskCardImpl({ item, sid }) {
  const [busy, setBusy] = useState(null);     // null | 'open' | 'cancel'
  const [local, setLocal] = useState(null);   // the state team.ask.cancel answered, until the item is patched
  const [, setLocalRel] = useState(null);     // re-render once team.ask.release answered (the ticket goes in `released`)
  const at = now.value;
  const m = askModel(local ? { ...item, team: { ...(item.team || {}), state: local, detail: '' } } : item, at);
  const live = OPEN_PHASES.has(m.phase);
  useTicker(live);
  const key = `${sid}:ask:${item.id}`;
  if (!live) return html`<${AskRecord} m=${m} k=${key} id=${item.id} />`;
  const s = sessionOf(sid);
  const company = s?.team?.company || s?.position?.company || item.team?.company;
  const openIt = async () => {
    setBusy('open');
    try { const r = await rpc('team.open', { company, id: m.toId }); if (r && r.sessionId) openSession(r.sessionId); }
    catch (e) { toast({ title: `Could not open ${m.to}`, error: e, kind: 'error' }); }
    finally { setBusy(null); }
  };
  const cancel = async () => {
    setBusy('cancel');
    try { const r = await rpc('team.ask.cancel', { ticket: m.ticket }); setLocal((r && r.state) || 'cancelled'); }
    catch (e) { toast({ title: 'Could not cancel the question', error: e, kind: 'error' }); }
    finally { setBusy(null); }
  };
  const release = async () => {
    const r0 = m.release;
    if (!r0) return;
    setBusy('release');
    try { await rpc('team.ask.release', { ticket: r0.ticket }); released.add(r0.ticket); setLocalRel(r0.ticket); }
    catch (e) { toast({ title: `Could not let ${r0.name} answer now`, error: e, kind: 'error' }); }
    finally { setBusy(null); }
  };
  const rel = m.release && !released.has(m.release.ticket) ? m.release : null;
  const relDone = m.release && released.has(m.release.ticket) ? m.release : null;
  const tone = m.line.tone;
  return html`<section class=${'req-card tc-card tc-ask' + (tone === 'waiting' ? ' is-waiting' : '')} data-item-id=${item.id} data-ticket=${m.ticket}
      data-state=${m.phase} aria-busy=${busy ? 'true' : undefined} aria-label=${`Question to ${m.to}`}>
    <div class="req-head"><${Icon} name="message" size=${16} />
      <div class="req-heading">
        <span class="req-title">Asking <strong>${m.to}</strong>${m.colleague ? html`<span class="tc-tag">colleague</span>` : null}</span>
        ${m.question ? html`<span class="req-desc tc-q" title=${m.question}>${m.question}</span>` : null}
      </div>
      ${m.asked ? html`<span class="req-kind tc-time" title=${`Asked at ${fmtTime(m.asked)}`}>${ago(at - m.asked)}</span>` : null}
    </div>
    <div class=${'tc-state tone-' + tone} data-tone=${tone}>
      <span class=${'dot ' + (tone === 'waiting' ? 'waiting' : tone === 'idle' ? 'idle' : 'working live')} aria-hidden="true"></span>
      <span class="tc-state-text">${m.line.text}</span>
    </div>
    ${m.phase === 'pending' ? html`<div class="tc-sub">Not answered in time. The answer comes into this chat as a Helm message.</div>`
      : m.phase === 'stopped' ? html`<div class="tc-sub">You stopped waiting. ${m.to} carries on, and its answer shows here.</div>` : null}
    ${relDone ? html`<div class="tc-sub" data-released=${relDone.ticket}>Let through: ${relDone.name} takes it as soon as its current turn ends.</div>` : null}
    ${m.chain.length > 1 ? html`<${ChainTree} chain=${m.chain} at=${at} />` : null}
    <div class="req-actions tc-actions">
      ${rel ? html`<button type="button" class="btn sm btn-primary tc-release" data-act="ask-release" disabled=${!!busy} onClick=${release}
        title=${`You are in ${rel.name}'s chat, so it waits until you go quiet. This lets it take the question now (it still never interrupts a running turn).`}>${busy === 'release' ? html`<span class="spinner sm" aria-hidden="true"></span>` : null}${rel.root ? 'Let it answer now' : `Let ${rel.name} answer now`}</button>` : null}
      <button type="button" class="btn sm" data-act="ask-open" disabled=${!!busy || !company || !m.toId} onClick=${openIt}
        title=${`Open ${m.to}'s chat`}>${busy === 'open' ? html`<span class="spinner sm" aria-hidden="true"></span>` : html`<${Icon} name="external" size=${13} />`}Open ${m.to}</button>
      <button type="button" class="btn sm btn-ghost" data-act="ask-cancel" disabled=${!!busy || !m.ticket} onClick=${cancel}
        title="Withdraws the question; work already done is logged but not passed back">${busy === 'cancel' ? html`<span class="spinner sm" aria-hidden="true"></span>` : null}Cancel question</button>
    </div>
  </section>`;
}
export const AskCard = memo(AskCardImpl);

// ---------- asked-by bubble (the answerer's chat) ----------
const attrsOf = (s) => { const o = {}; for (const m of String(s || '').matchAll(/([\w-]+)="([^"]*)"/g)) o[m[1]] = m[2]; return o; };
// The runtime quotes the body of a <helm-answer> / <helm-ask> block (& < > as entities, runtime.js quote()) so a
// position's text can never close the block early: decode them back, &amp; last so a written "&lt;" survives.
// Attributes are not entity-coded (runtime.js attr() turns " < > and newlines into spaces); <helm-duty> is not quoted.
const unquote = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
export function parseTagged(text, tag) {
  const m = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`).exec(String(text || ''));
  if (!m) return null;
  const body = m[2].replace(/^\s*\n/, '').trimEnd();
  return { attrs: attrsOf(m[1]), body: tag === 'helm-duty' ? body : unquote(body) };
}
const HANDED = /^Handed to you[^:\n]*:[ \t]*(.+)$/im;
export function splitHanded(body) {
  const m = HANDED.exec(body || '');
  if (!m) return { text: String(body || '').trim(), files: [] };
  const files = m[1].split(/\s*[,;]\s+(?=[A-Za-z]:[\\/]|[\\/~$])/).map((x) => x.trim()).filter(Boolean);
  return { text: (body.slice(0, m.index) + body.slice(m.index + m[0].length)).trim(), files };
}
// A duty run's trigger. The runtime sends duties.js triggerLabel's string: "schedule <cron>", "commit <folder> <branch>",
// "release <folder> <tag>", "file <path>", "manual", "onboarding" (the onboarding run; older items carry the object
// { kind: 'onboarding' }, both read "onboarding"). An
// object trigger from a position.json reads through positions-model's words.
const TRIGGER = { schedule: 'scheduled', scheduled: 'scheduled', event: 'on an event', manual: 'run by you', now: 'run by you', 'catch-up': 'catch-up after Helm was closed',
  catchup: 'catch-up after Helm was closed', onboarding: 'onboarding' };
// "C:/x/my app main" -> { folder: 'C:/x/my app', tail: 'main' }; a lone path (no branch / tag given) has no tail
function folderAnd(rest) {
  const s = String(rest || '').trim(), i = s.lastIndexOf(' ');
  if (i < 0) return { folder: s, tail: '' };
  const tail = s.slice(i + 1);
  return /^[A-Za-z]:|^[\\/~]/.test(tail) ? { folder: s, tail: '' } : { folder: s.slice(0, i), tail };
}
export function triggerWords(t) {
  if (!t) return '';
  if (typeof t === 'string') {
    const s = t.trim(), m = /^(schedule|commit|release|file)\s+(.+)$/i.exec(s);
    if (!m) return TRIGGER[s.toLowerCase()] || s;
    const kind = m[1].toLowerCase(), rest = m[2].trim();
    if (kind === 'schedule') return cronWords(rest);
    if (kind === 'file') return `when ${baseName(rest)} changes`;
    const { folder, tail } = folderAnd(rest);
    if (kind === 'commit') return `on a new commit to ${baseName(folder)}${tail ? ` (${tail})` : ''}`;
    return `on a new tag${tail ? ` ${tail}` : ''} in ${baseName(folder)}`;
  }
  if (str(t.words)) return str(t.words);
  if (t.kind === 'schedule' && t.cron) return cronWords(t.cron);
  if (t.kind === 'event' && t.event) { const w = dutyTriggerWords(t); return w[0].toLowerCase() + w.slice(1); }
  return TRIGGER[t.kind] || str(t.kind);
}

// ---------- the seed line: a position chat's first message (session.js teamFields: seed { handoff, seeded }) ----------
export function seedWords(seed) {
  const sd = seed && typeof seed === 'object' ? seed : {};
  if (str(sd.label)) return str(sd.label);
  if (sd.fromChat) return `Fresh chat · seeded from the brief and notebook, and the handoff of chat ${sd.fromChat}`;
  return sd.handoff ? 'Fresh chat · seeded from the brief and notebook, and the handoff the previous chat wrote' : 'Fresh chat · seeded from the brief and notebook';
}
// one quiet line above the first bubble, whoever sent it (the owner's own bubble gets it from ui/chat/index.js)
export function SeedLine({ item }) {
  return html`<div class="tc-seed tc-seed-note" data-seed-for=${item.id}><span class="tc-seed-line is-static" title="What this chat started from">
    <${Icon} name="info" size=${12} /><span>${seedWords(item.seed)}</span></span></div>`;
}

// item (user, origin ask | duty | answer | seed) -> { kind, icon, label, sub, text, files, replyBy, md }
export function askedByModel(item, session) {
  const o = item.origin, text = String(item.text || '');
  if (o === 'seed') return { kind: 'seed', text, line: seedWords(item.seed) };   // older shape: the seed as an item of its own
  if (o === 'duty') {
    const d = item.duty || {}, t = parseTagged(text, 'helm-duty');
    return { kind: 'duty', icon: 'clock', label: `Duty · ${str(d.title) || nameOf(d.id) || 'a duty run'}`, sub: triggerWords(d.trigger), text: t ? t.body : text.trim(), files: [] };
  }
  if (o === 'answer') {
    const t = parseTagged(text, 'helm-answer'), a = t?.attrs || {};
    const from = nm(item.ask?.from) || nameOf(a.from) || 'A position';
    const expired = a.state === 'expired', adds = a.kind === 'followup' || a.state === 'followup';
    return { kind: 'answer', icon: expired ? 'clock' : 'message', md: true, text: t ? t.body : text.trim(), files: [],
      label: expired ? `No answer from ${from}` : adds ? `${from} adds` : `Answer from ${from}`,
      sub: expired ? 'expired after 2 h' : adds ? (a.via ? `from ${nameOf(a.via)}` : 'follow-up') : 'late' };
  }
  const t = parseTagged(text, 'helm-ask'), a = t?.attrs || {}, ask = item.ask || {}, f = ask.from || {};
  const kind = f.kind || (/^CEO\b/.test(a.from || '') ? 'ceo' : 'position');
  const company = str(session?.position?.companyName) || (/\(([^)]+)\)\s*$/.exec(a.from || '') || [])[1] || '';
  const who = kind === 'owen' ? 'you' : kind === 'ceo' ? 'CEO' : nm(f) || (a.from || '').replace(/\s*\(.*\)\s*$/, '') || 'a colleague';
  const colleague = (ask.kind || a.kind) === 'colleague';
  const h = splitHanded(t ? t.body : text);
  return { kind: 'ask', icon: 'message', label: `Asked by ${who}`, sub: kind === 'ceo' ? company : colleague ? 'colleague' : '', text: h.text,
    files: Array.isArray(ask.handed) ? ask.handed : h.files, replyBy: a['reply-by'] || (ask.replyBy ? fmtTime(ask.replyBy) : '') };
}

function TeamUserImpl({ item, sid }) {
  const m = askedByModel(item, sessionOf(sid));
  const key = `${sid}:asked:${item.id}`;
  const open = isOpen(key, false);
  if (m.kind === 'seed') return html`<div class=${'tc-seed' + (open ? ' open' : '')} data-item-id=${item.id} data-origin="seed">
    <button type="button" class="tc-seed-line" aria-expanded=${open} data-act="seed-toggle" onClick=${() => toggle(key, false)} title="What this chat started from">
      <${Icon} name="info" size=${12} /><span>${m.line}</span>${m.text ? html`<span class="trow-chev"><${Icon} name="chevron-right" size=${11} /></span>` : null}</button>
    ${open && m.text ? html`<div class="tc-seed-text">${m.text}</div>` : null}
  </div>`;
  const long = m.text.length > 1200 || m.text.split('\n').length > 14;
  return html`${item.seed ? html`<${SeedLine} item=${item} />` : null}<div class=${'msg-ask o-' + m.kind} data-item-id=${item.id} data-origin=${item.origin}>
    <div class="ask-from"><${Icon} name=${m.icon} size=${13} /><span class="ask-who">${m.label}</span>${m.sub ? html`<span class="ask-sub">· ${m.sub}</span>` : null}</div>
    <div class=${'ask-bubble' + (m.md ? ' md-body' : '') + (long && !open ? ' clamp' : '')}>${m.md ? html`<${Markdown} text=${m.text} />` : m.text}</div>
    ${long ? html`<button type="button" class="ask-more" aria-expanded=${open} data-act="asked-more" onClick=${() => toggle(key, false)}>${open ? 'Show less' : 'Show all'}</button>` : null}
    ${m.files.length ? html`<div class="att-files ask-files" aria-label="Handed to you, read-only">${m.files.map((p) => html`<span class="att-file" title=${p}>
      <${Icon} name="file" size=${13} /><span>${basename(p)}</span></span>`)}</div>` : null}
    <div class="msg-meta ask-meta"><span class="msg-time">${fmtTime(item.ts)}</span>${m.replyBy ? html`<span>· reply by ${m.replyBy}</span>` : null}</div>
  </div>`;
}
export const TeamUserMsg = memo(TeamUserImpl);

// ---------- answer card (late answer after Stop) ----------
const askerOf = (s) => str(s?.position?.name) || 'CEO';
function AnswerCard({ item, sid }) {
  const a = item.answer || {};
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sentAt, setSentAt] = useState(null);
  const from = nm(a.from) || 'A position', to = askerOf(sessionOf(sid));
  const sent = a.forwardedAt || sentAt;
  const forward = async () => {
    setBusy(true);
    try { await rpc('team.answer.forward', { sessionId: sid, ticket: a.ticket }); setSentAt(Date.now()); }
    catch (e) { toast({ title: `Could not send it to ${to}`, error: e, kind: 'error' }); }
    finally { setBusy(false); }
  };
  if (sent) return html`<div class=${'tc-rec-wrap' + (open ? ' open' : '')} data-item-id=${item.id} data-team="answer" data-state="sent">
    <button type="button" class="req-record tc-rec tc-rec-btn ok" aria-expanded=${open} data-act="answer-toggle" onClick=${() => setOpen(!open)}>
      <${Icon} name="check" size=${13} class="tc-done-ic" /><span class="tc-rec-text">Sent <strong>${from}</strong>'s answer to ${to}<span class="tc-rec-meta"> · ${fmtTime(sent)}</span></span>
      <span class="grow" /><span class="trow-chev"><${Icon} name="chevron-right" size=${12} /></span></button>
    ${open ? html`<div class="tc-reveal"><div class="tc-answer"><${Markdown} text=${a.text || ''} /></div></div>` : null}
  </div>`;
  return html`<section class="req-card tc-card tc-answer-card" data-item-id=${item.id} data-team="answer" aria-busy=${busy ? 'true' : undefined}>
    <div class="req-head"><${Icon} name="message" size=${16} />
      <div class="req-heading">
        <span class="req-title"><strong>${from}</strong> answered after you stopped</span>
        <span class="req-desc">The answer is kept. Send it to ${to} to carry on from it, or just read it.</span>
      </div><span class="req-kind">Late answer</span></div>
    ${open ? html`<div class="tc-answer"><${Markdown} text=${a.text || ''} /></div>` : null}
    <div class="req-actions tc-actions">
      <button type="button" class="btn" data-act="answer-show" aria-expanded=${open} onClick=${() => setOpen(!open)}>${open ? 'Hide' : 'Show'}</button>
      <button type="button" class="btn btn-primary" data-act="answer-forward" disabled=${busy || !a.ticket} onClick=${forward}
        title=${`Puts the answer into this chat for ${to}, which starts a turn`}>${busy ? html`<span class="spinner sm" aria-hidden="true"></span>` : null}Send to ${to}</button>
    </div>
  </section>`;
}

// ---------- proposal card ----------
// The engine's public proposal (main/engine/team/proposals.js): { id, company, action, title, why, draft, diff?, excess?,
// status, by, target, parent, decision? }. Everything Approve changes is on the card before its buttons:
//   create   remit, reports to, scope, powers as chips (the ones its managers lack in red), duties, model, the brief
//   edit     each field from -> to, the brief as a line diff (+N −M lines), powers + / −, duties added / changed / removed
//   retire   who retires (draft.retires) and whose reports move where (draft.moves)
//   company  its name and folders
// and for create / edit the powers beyond its managers' (p.excess): they stay listed but are cut on approval.
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null && x !== '') : v ? [v] : []);
const dutyWords = (d) => `${str(d.title) || nameOf(d.id)}${d.trigger ? ` · ${triggerWords(d.trigger)}` : ''}`;

// id -> name for one proposal: the open position chats of its company, then what the proposal itself says (the
// target's current name, the create parent's name from the engine's title), else the id in words
export function namesFor(p) {
  const cid = (p && p.company) || null, d = (p && p.draft) || {}, known = new Map();
  for (const s of sessions.value || []) { const q = s && s.position; if (q && q.id && str(q.name) && (!cid || !q.company || q.company === cid)) known.set(q.id, str(q.name)); }
  if (p && p.target && p.action !== 'create' && p.action !== 'company') known.set(p.target, str(p.diff?.name?.from) || str(d.name) || known.get(p.target) || nameOf(p.target));
  const par = p && p.action === 'create' ? (d.parent !== undefined ? d.parent : p.parent) : null;
  const t = / under (.+)$/.exec(str(p && p.title));
  if (par && t) known.set(par, t[1]);
  return (id) => (id == null || id === '' ? 'the CEO' : known.get(id) || nameOf(id));
}

export function proposalModel(p, names = namesFor(p)) {
  const d = p.draft || {}, dec = p.decision || {}, by = p.by || {};
  const name = str(d.name) || str(p.name) || (p.target || d.id ? names(p.target || d.id) : '') || 'a position';
  const parentId = d.parent !== undefined ? d.parent : p.parent;
  const parentName = str(p.parentName) || str(d.parentName) || names(parentId);
  const title = str(p.title) || (p.action === 'create' ? `New position: ${name} under ${parentName}` : p.action === 'edit' ? `Change ${name}`
    : p.action === 'retire' ? `Retire ${name}` : p.action === 'company' ? `New company: ${name}` : 'Proposal');
  const changes = proposalChanges(p, names, { duties: [] });
  // retire (proposals.js check): retires = ids, deepest first, the target included; moves = [{ id, from, to }]
  const moves = arr(d.moves).filter((x) => x && x.id).map((x) => ({ name: names(x.id), to: names(x.to) }));
  const movesUp = p.movesUp ? { to: nm(p.movesUp.to) || 'its manager', names: arr(p.movesUp.names).map(nm) } : null;   // older shape
  return {
    id: p.id, action: p.action, title, name, parentName, d, why: str(p.why) || str(d.why), changes, diff: p.diff || null,
    who: p.action === 'create' ? name : str(p.diff?.name?.from) || name,
    status: p.status || dec.result || 'open', how: dec.how || p.decidedHow || '', quote: str(dec.quote) || str(p.quote), at: dec.at || p.decidedAt || null,
    note: str(dec.note) || str(p.note), proposer: by.kind === 'ceo' ? 'the CEO' : nm(by) || '', by,
    retires: (arr(d.retires).length ? arr(d.retires).map(names) : arr(p.retires).map(nm)).filter((x) => x !== name), mode: str(d.reports_on_retire) || 'move-up', moves, movesUp,
  };
}
export function proposalRecord(m, fmt = fmtTime) {
  const t = m.at ? ` ${fmt(m.at)}` : '';
  if (m.status === 'approved') return { icon: 'check', tone: 'ok', lead: `Approved${t} ${m.how === 'typed' ? `(your reply ‘${m.quote || 'yes'}’)` : '(your click)'} · ` };
  if (m.status === 'declined') return { icon: 'ban', tone: 'bad', lead: `Declined${t} · `, note: m.note };
  return { icon: 'x', tone: 'dim', lead: 'Replaced by a newer proposal · ' };
}

// one power as a chip: { label, mono, title, cut? }
// an edit's added power that the engine lists in excess is cut on approval, so its chip says so (as a create card's do).
// The engine expands tokens before comparing: $scope of a one-product scope is that folder; other tokens stay unmatched.
export function addedCut(c, excess, scope) {
  const ex = Array.isArray(excess) ? excess : [];
  if (c.power === 'read' || c.power === 'write') {
    const v = c.value === '$scope' ? (scope?.kind === 'product' ? scope.folder : null) : typeof c.value === 'string' && !c.value.startsWith('$') ? c.value : null;
    return v != null && ex.some((r) => r.power === c.power && pathKey(r.value) === pathKey(v));
  }
  if (c.power === 'tools') return ex.some((r) => r.power === 'tools' && r.value === c.value);
  if (c.power === 'bash') return c.value !== 'off' && ex.some((r) => r.power === 'bash');
  if (c.power === 'agents' || c.power === 'worktree') return c.value === true && ex.some((r) => r.power === c.power);
  return false;
}
const PowerChip = ({ c, sign }) => html`<span class=${'chip' + (c.mono ? ' tc-mono' : '') + (c.cut ? ' danger' : sign === '+' ? ' ok' : sign === '−' ? ' tc-removed' : '')}
  title=${c.cut ? `${c.label}: beyond its managers' powers, so cut on approval` : sign === '+' ? `Added: ${c.title || c.label}` : sign === '−' ? `Removed: ${c.title || c.label}` : c.title || c.label}>${sign ? `${sign} ` : ''}${c.label}</span>`;

// the powers its managers lack: what Approve will NOT give, one row each, with who cuts it
function ExcessNotice({ m }) {
  const rows = m.changes.excess;
  if (!rows.length) return null;
  const scope = m.d.scope;
  const cut = rows.filter((r) => !r.waits);
  return html`<div class="req-why tc-excess" role="note" data-excess=${rows.length}><${Icon} name="alert" size=${14} /><div class="req-why-body">
    <span class="tc-excess-head">${cut.length ? 'These powers would be cut' : 'Its powers are checked later'}</span>
    <span>${excessHeadline(rows, m.who)}.</span>
    <ul class="tc-cut">${rows.map((r) => html`<li key=${r.power + ':' + String(r.value)} data-power=${r.power} data-by=${r.by || ''}>
      <span class=${'tc-cut-what' + (r.mono ? ' tc-mono' : '')} title=${r.title || r.label}>${r.label}</span>
      <span class="tc-cut-why">${r.why}${r.kept && r.kept.length ? `; keeps only ${r.kept.map((v) => pathWords(v, scope)).join(', ')}` : ''}</span></li>`)}</ul>
  </div></div>`;
}

const BRIEF_INLINE = 10;   // a brief diff of up to this many rows shows open; a longer one sits under a disclosure with its counts
function BriefDiff({ b, k }) {
  const long = b.rows.length > BRIEF_INLINE;
  const open = !long || isOpen(k, false);
  const counts = `+${b.added} −${b.removed} line${b.added + b.removed === 1 ? '' : 's'}`;
  return html`${long ? html`<button type="button" class="tc-disc" aria-expanded=${open} data-act="brief-toggle" onClick=${() => toggle(k, false)}>
      <span class="trow-chev"><${Icon} name="chevron-right" size=${12} /></span>${open ? 'Hide the brief changes' : 'Show the brief changes'}<span class="tc-counts"> · ${counts}</span></button>`
    : html`<span class="tc-counts tc-counts-line">${counts}</span>`}
    ${open ? html`<div class="tc-bdiff" role="group" aria-label=${`Brief changes, ${counts}`}>${b.rows.map((r, i) => (r.t === 'gap'
      ? html`<div key=${i} class="tc-bd gap">… ${r.n} unchanged line${r.n === 1 ? '' : 's'}</div>`
      : html`<div key=${i} class=${'tc-bd ' + r.t}><span class="tc-bd-sign" aria-label=${r.t === 'add' ? 'added' : r.t === 'del' ? 'removed' : undefined}>${r.t === 'add' ? '+' : r.t === 'del' ? '−' : ' '}</span><span class="tc-bd-text">${r.text || ' '}</span></div>`))}</div>` : null}`;
}

function EditRows({ m, k }) {
  const c = m.changes;
  const pAdd = c.powers ? c.powers.added.map((x) => ({ ...x, cut: addedCut(x, c.excess, m.d.scope) })) : [], pRem = c.powers ? c.powers.removed : [];
  const du = c.duties || { added: [], changed: [], removed: [] };
  const dTitle = (x) => (x.title && x.title !== x.id ? x.title : nameOf(x.id));
  const dLine = (x) => `${dTitle(x)}${x.trigger ? ` · ${x.trigger}` : ''}`;
  const any = c.fields.length || pAdd.length || pRem.length || du.added.length || du.changed.length || du.removed.length || c.brief;
  return html`
    ${c.fields.map((f) => html`<dt key=${'f' + f.key}>${f.label}</dt><dd class="tc-change" data-field=${f.key}>
      ${f.from ? html`<s class="tc-old" title=${f.fromTitle || f.from}>${f.from}</s><span class="tc-arrow" aria-label="becomes">→</span>` : null}<span title=${f.toTitle || undefined}>${f.to}</span></dd>`)}
    ${pAdd.length || pRem.length ? html`<dt>Powers</dt><dd><span class="tc-chips">${pAdd.map((x) => html`<${PowerChip} c=${x} sign="+" />`)}${pRem.map((x) => html`<${PowerChip} c=${x} sign="−" />`)}</span></dd>` : null}
    ${du.added.length || du.changed.length || du.removed.length ? html`<dt>Duties</dt><dd class="tc-lines">
      ${du.added.map((x) => html`<span class="tc-add">+ New: ${dLine(x)}</span>`)}${du.changed.map((x) => html`<span class="tc-chg">~ Changed: ${dLine(x)}</span>`)}${du.removed.map((x) => html`<span class="tc-del">− Removed: ${dTitle(x)}</span>`)}</dd>` : null}
    ${c.brief ? html`<dt>Brief</dt><dd><${BriefDiff} b=${c.brief} k=${k + ':brief'} /></dd>` : null}
    ${any ? null : html`<dt>Changes</dt><dd class="tc-none">Nothing that differs from now</dd>`}`;
}

function ProposalBody({ m, k }) {
  const d = m.d;
  const briefOpen = isOpen(k + ':brief', false);
  const seed = d.seed || {};
  const chips = m.action === 'create' ? draftPowerChips(d.powers, d.scope, m.changes.excess.length ? m.changes.excess.map((r) => ({ power: r.power, value: r.value })) : []) : [];
  const lines = str(d.brief) ? d.brief.trimEnd().split('\n').length : 0;
  return html`<dl class="tc-facts">
    ${m.action === 'create' ? html`
      ${d.remit ? html`<dt>Remit</dt><dd>${d.remit}</dd>` : null}
      <dt>Reports to</dt><dd>${m.parentName}</dd>
      <dt>Scope</dt><dd title=${d.scope?.folder || undefined}>${scopeWords(d.scope)}</dd>
      ${chips.length ? html`<dt>Powers</dt><dd><span class="tc-chips">${chips.map((x) => html`<${PowerChip} c=${x} />`)}</span></dd>` : null}
      ${arr(d.duties).length ? html`<dt>Duties</dt><dd class="tc-lines">${arr(d.duties).map((x) => html`<span>${dutyWords(x)}</span>`)}</dd>` : null}
      ${d.model !== undefined || d.effort ? html`<dt>Model</dt><dd>${d.model ? nameOf(d.model) : 'Helm default'}${d.effort ? ` · ${d.effort} effort` : ''}</dd>` : null}` : null}
    ${m.action === 'edit' ? html`<${EditRows} m=${m} k=${k + ':diff'} />` : null}
    ${m.action === 'retire' ? html`
      ${m.retires.length ? html`<dt>Also retires</dt><dd>${list(m.retires)}</dd>` : null}
      <dt>Reports</dt><dd>${m.moves.length ? html`<span class="tc-lines">${m.moves.map((x) => html`<span>${x.name} moves up to ${x.to}</span>`)}</span>`
        : m.movesUp ? (m.movesUp.names.length ? `${list(m.movesUp.names)} move up to ${m.movesUp.to}` : `Move up to ${m.movesUp.to}`)
        : m.mode === 'retire-too' && m.retires.length ? 'They retire with it' : 'None: no one reports to it'}</dd>` : null}
    ${m.action === 'company' ? html`
      <dt>Name</dt><dd>${m.name}</dd>
      <dt>Folders</dt><dd>${arr(d.folders).length ? html`<span class="tc-chips">${arr(d.folders).map((f) => html`<span class="chip tc-mono" title=${f}>${f}</span>`)}</span>` : 'None yet'}</dd>` : null}
    ${arr(seed.files).length ? html`<dt>Reads first</dt><dd><span class="tc-chips">${arr(seed.files).map((f) => html`<span class="att-file" title=${[f.path || f, f.why].filter(Boolean).join(' · ')}>
        <${Icon} name="file" size=${13} /><span>${basename(f.path || f)}</span></span>`)}</span></dd>` : null}
    ${str(seed.notes) ? html`<dt>Seed notes</dt><dd class="tc-clip" title=${seed.notes}>${seed.notes}</dd>` : null}
    ${str(d.brief) && m.action === 'create' ? html`<dt>Brief</dt><dd><button type="button" class="tc-disc" aria-expanded=${briefOpen} data-act="brief-toggle" onClick=${() => toggle(k + ':brief', false)}>
        <span class="trow-chev"><${Icon} name="chevron-right" size=${12} /></span>${briefOpen ? 'Hide the brief' : 'Read the brief'}<span class="tc-counts"> · ${lines} line${lines === 1 ? '' : 's'}</span></button>
      ${briefOpen ? html`<div class="tc-brief"><${Markdown} text=${d.brief} /></div>` : null}</dd>` : null}
  </dl>`;
}

// the typed-yes rule (6.3): only while this is the session's one open proposal and no request card waits after it
function typedOk(sid, id) {
  const items = (itemsBySession.value || {})[sid];
  if (!Array.isArray(items)) return false;
  const open = items.filter((i) => i.type === 'team' && i.kind === 'proposal' && (i.proposal?.status || 'open') === 'open');
  if (open.length !== 1 || open[0].id !== id) return false;
  const at = items.indexOf(open[0]);
  return !items.slice(at + 1).some((i) => i.type === 'request' && i.status === 'pending');
}

function ProposalCard({ item, sid }) {
  const p = item.proposal || {};
  const [busy, setBusy] = useState(null);     // null | 'approve' | 'decline' | 'change'
  const [local, setLocal] = useState(null);   // { status, at } once team.decide answered, until the item is patched
  const [note, setNote] = useState('');
  const [change, setChange] = useState(null); // null = closed, string = the Change… box
  const [changed, setChanged] = useState(false);
  const m = proposalModel(local ? { ...p, status: local.status, decision: { ...(p.decision || {}), at: local.at, how: 'click' } } : p);
  const k = `${sid}:prop:${item.id}`;
  if (m.status !== 'open') {
    const r = proposalRecord(m);
    return html`<div class=${'req-record tc-rec ' + r.tone + (local ? ' fresh' : '')} data-item-id=${item.id} data-team="proposal" data-state=${m.status} data-proposal=${m.id}>
      <${Icon} name=${r.icon} size=${13} class="tc-done-ic" /><span class="tc-rec-text">${r.lead}<strong>${m.title}</strong></span>
      ${r.note ? html`<span class="req-note tc-rec-note">“${r.note}”</span>` : null}</div>`;
  }
  const decide = async (decision) => {
    setBusy(decision);
    try {
      const r = await rpc('team.decide', { proposal: m.id, decision, ...(decision === 'decline' && note.trim() ? { note: note.trim() } : {}) });
      if (r && r.ok === false) throw new Error(r.error || 'Helm could not do it');
      setLocal({ status: decision === 'approve' ? 'approved' : 'declined', at: Date.now() });
    } catch (e) { toast({ title: decision === 'approve' ? 'Could not approve' : 'Could not decline', error: e, kind: 'error' }); }
    finally { setBusy(null); }
  };
  const sendChange = async () => {
    const t = (change || '').trim();
    if (!t) return;
    setBusy('change');
    try { await send(m.by.sessionId || sid, t); setChange(null); setChanged(true); }
    catch (e) { toast({ title: 'Could not send your change', error: e, kind: 'error' }); }
    finally { setBusy(null); }
  };
  const here = !m.by.sessionId || m.by.sessionId === sid;
  const icon = m.action === 'retire' ? 'archive' : m.action === 'edit' ? 'pencil' : m.action === 'company' ? 'folder' : 'plus';
  const spin = (b) => (busy === b ? html`<span class="spinner sm" aria-hidden="true"></span>` : null);
  return html`<section class="req-card tc-card tc-prop" data-item-id=${item.id} data-team="proposal" data-state="open" data-proposal=${m.id}
      data-action=${m.action} aria-busy=${busy ? 'true' : undefined} aria-label=${m.title}>
    <div class="req-head"><${Icon} name=${icon} size=${16} />
      <div class="req-heading">
        <span class="req-title">${m.title}</span>
        ${m.why ? html`<span class="req-desc">${m.why}</span>` : null}
      </div><span class="req-kind">Proposal</span></div>
    <${ExcessNotice} m=${m} />
    <${ProposalBody} m=${m} k=${k} />
    ${change != null ? html`<div class="tc-change-box">
      <textarea class="textarea" data-act="proposal-change-text" rows="3" placeholder=${here ? 'What should change? This goes to Claude in this chat as your message.' : `What should change? This goes to ${m.proposer || 'the proposer'} as your message.`}
        value=${change} disabled=${!!busy} onInput=${(e) => setChange(e.currentTarget.value)} ref=${(el) => el && !el.dataset.f && (el.dataset.f = '1', el.focus())}
        onKeyDown=${(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChange(); } if (e.key === 'Escape') setChange(null); }} /></div>` : null}
    ${changed && change == null ? html`<div class="tc-sub">Sent. The proposal stays open until it is replaced or you decide.</div>` : null}
    <div class="req-actions tc-actions">
      ${change != null ? html`
        <span class="grow" />
        <button type="button" class="btn btn-ghost" data-act="proposal-back" disabled=${!!busy} onClick=${() => setChange(null)}>Back</button>
        <button type="button" class="btn btn-primary" data-act="proposal-send" disabled=${!!busy || !change.trim()} onClick=${sendChange}>${spin('change')}Send</button>`
      : html`
        <button type="button" class="btn btn-primary" data-act="proposal-approve" disabled=${!!busy} onClick=${() => decide('approve')}
          title="Helm writes the files now">${spin('approve')}Approve</button>
        <button type="button" class="btn" data-act="proposal-change" disabled=${!!busy} onClick=${() => setChange('')}>Change…</button>
        <span class="grow" />
        <button type="button" class="btn btn-ghost" data-act="proposal-decline" disabled=${!!busy} onClick=${() => decide('decline')}>${spin('decline')}Decline</button>
        <input class="input sm req-reason tc-note-line" data-act="proposal-note" placeholder="Note with a decline (optional)" value=${note} disabled=${!!busy} aria-label="Note with a decline (optional)"
          onInput=${(e) => setNote(e.currentTarget.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); decide('decline'); } }} />`}
    </div>
    ${change == null && typedOk(sid, item.id) ? html`<div class="tc-hint">Or reply “yes” to approve: it counts while this is the only open proposal here.</div>` : null}
  </section>`;
}

// ---------- notice ----------
function Notice({ item }) {
  const n = item.notice || {};
  return html`<div class="sys-line tc-notice" data-item-id=${item.id} data-team="notice" title=${str(n.text) || str(item.text)}>
    <${Icon} name=${n.icon || 'info'} size=${12} /><span>${str(n.text) || str(item.text)}</span></div>`;
}

function TeamItemImpl({ item, sid }) {
  if (item.kind === 'proposal') return html`<${ProposalCard} item=${item} sid=${sid} />`;
  if (item.kind === 'answer') return html`<${AnswerCard} item=${item} sid=${sid} />`;
  if (item.kind === 'notice') return html`<${Notice} item=${item} />`;
  return null;
}
export const TeamItem = memo(TeamItemImpl);
export { ProposalCard };   // Team view > Proposals can show the same card (6.3: every copy resolves together)

// The one call ui/chat/index.js makes: a team card for this item, or null (then the usual renderer runs).
export function teamUnit(it, sid) {
  if (!it) return null;
  if (it.type === 'tool' && ASK_TOOLS.has(it.name)) return html`<${AskCard} item=${it} sid=${sid} />`;
  if (it.type === 'team') return html`<${TeamItem} item=${it} sid=${sid} />`;
  if (it.type === 'user' && ORIGINS.has(it.origin)) return html`<${TeamUserMsg} item=${it} sid=${sid} />`;
  return null;
}

// Tool rows for the other mcp__team__* tools (for tools.js describe()): { icon, verb, target } or null.
const VERBS = {
  team_roster: ['list', 'Looked at the team', 'Looking at the team'], team_ticket: ['message', 'Checked a question', 'Checking a question'],
  team_cancel: ['x', 'Cancelled a question', 'Cancelling a question'], team_log: ['history', 'Read the team log', 'Reading the team log'],
  team_propose: ['sparkle', 'Proposed', 'Proposing'], notebook_add: ['pencil', 'Noted in the notebook', 'Noting in the notebook'],
  request_access: ['shield', 'Asked for access', 'Asking for access'], duty_report: ['check-circle', 'Reported the duty run', 'Reporting the duty run'],
  ask_followup: ['message', 'Sent a follow-up', 'Sending a follow-up'],
};
export function teamToolDescribe(item) {
  const t = /^mcp__team__(.+)$/.exec(item?.name || '')?.[1];
  const v = t && VERBS[t];
  if (!v) return null;
  const i = item.input || {};
  const target = t === 'notebook_add' ? str(i.section) : t === 'request_access' ? str(i.target)
    : t === 'team_propose' ? [i.action, str(i.name) || nameOf(i.id)].filter(Boolean).join(' ') : t === 'team_roster' ? nameOf(i.under) : str(i.ticket);
  return { icon: v[0], verb: item.status === 'running' ? v[2] : v[1], target };
}
