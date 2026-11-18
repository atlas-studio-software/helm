// Request cards: permission prompts, production-guard approvals, AskUserQuestion, ExitPlanMode. Answered/cancelled ones
// collapse to a one-line record.
import { useState, useEffect, useRef } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Markdown } from '../lib/markdown.js';
import { respond, toast, activeId, sessions } from '../lib/store.js';
import { Icon } from '../lib/icons.js';
import { CodeView, DiffView, JsonView } from './views.js';
import { memo, relPath, langFromPath, hostOf } from './util.js';

async function answer(sid, item, response, setBusy) {
  setBusy(true);
  try { await respond(sid, item.requestId, response); }
  catch (e) { toast({ title: 'Could not send your answer', error: e, kind: 'error' }); setBusy(false); }
}

// ---------- records (answered / cancelled) ----------
function recordText(item, session) {
  const a = item.answer || {};
  if (item.guard) {   // production guard (main/engine/prod-guard.js)
    const t = item.title || item.guard.title || 'Production action';
    if (item.status === 'cancelled') return item.timedOut
      ? { icon: 'ban', text: `Blocked · no answer in ${item.guard.waitMin || 30} min · `, strong: t, tone: 'bad' }
      : { icon: 'x', text: 'Cancelled · ', strong: t, tone: 'dim' };
    if (a.behavior === 'allow') return { icon: 'check', text: 'Allowed once · ', strong: t, tone: 'ok' };
    return { icon: 'ban', text: 'Denied · ', strong: t, note: a.message, tone: 'bad' };
  }
  if (item.kind === 'access') {   // Positions (7.4): a position asked for more access
    const m = accessModel(item, session);
    const t = m.targetShort;
    // a timeout: session.openRequest patches { status: 'cancelled', answer: { timedOut: true } }
    if (item.status === 'cancelled') return a.timedOut || item.timedOut || a.decision === 'no-answer'
      ? { icon: 'ban', text: `No answer in ${m.waitMin} min · ${m.who} carries on without `, strong: t, tone: 'bad' }
      : { icon: 'x', text: 'Request withdrawn · ', strong: t, tone: 'dim' };
    if (a.behavior === 'allow' || a.decision === 'once' || a.decision === 'always') {
      const always = (a.scope || (a.decision === 'always' ? 'always' : 'once')) === 'always';
      // access.js decideRequest saves an "always" on an outward or once-only card as once: say so, never "always"
      if (always && (m.outward || m.onceOnly)) return { icon: 'check', text: `Approved once (${m.outward ? 'outward actions are never standing' : 'beyond the company folders, so once only'}) · ${m.who} · `, strong: t, tone: 'ok' };
      if (always) return { icon: 'check', text: `Approved always · saved to ${m.savedTo} · `, strong: t, tone: 'ok' };
      return { icon: 'check', text: `Approved once · ${m.who} · `, strong: t, tone: 'ok' };
    }
    return { icon: 'ban', text: `Denied · ${m.who} · `, strong: t, note: a.message || a.note, tone: 'bad' };
  }
  if (item.status === 'cancelled') return { icon: 'x', text: 'Request cancelled', tone: 'dim' };
  if (item.kind === 'permission') {
    if (a.behavior === 'allow') return { icon: 'check', text: `Allowed ${item.toolName}${a.always ? ' for this session' : ''}`, tone: 'ok' };
    return { icon: 'ban', text: `Denied ${item.toolName}`, note: a.message, tone: 'bad' };
  }
  if (item.kind === 'plan') {
    if (a.behavior === 'allow') return { icon: 'check', text: a.mode === 'acceptEdits' ? 'Plan approved · auto-accept edits' : a.mode === 'bypassPermissions' ? 'Plan approved · bypass permissions' : 'Plan approved', tone: 'ok' };
    return { icon: 'map', text: 'Kept planning', note: a.message, tone: 'dim' };
  }
  if (item.kind === 'question') {
    const entries = Object.entries(a.answers || {});
    if (!entries.length) return { icon: 'question', text: 'Answered', tone: 'dim' };
    if (entries.length === 1) return { icon: 'check', text: 'You chose: ', strong: entries[0][1], tone: 'ok' };
    const qs = item.questions || [];
    const parts = entries.map(([q, v]) => `${qs.find((x) => x.question === q)?.header || q}: ${v}`);
    return { icon: 'check', text: 'You chose: ', strong: parts.join('  ·  '), tone: 'ok' };
  }
  return { icon: 'check', text: 'Answered', tone: 'dim' };
}
function Record({ item, sid }) {
  const r = recordText(item, item.kind === 'access' ? sessionOf(sid) : null);
  return html`<div class=${'req-record ' + r.tone}><${Icon} name=${r.icon} size=${13} />
    <span>${r.text}${r.strong ? html`<strong>${r.strong}</strong>` : null}</span>
    ${r.note ? html`<span class="req-note">“${r.note}”</span>` : null}</div>`;
}

// ---------- permission ----------
function PermissionPreview({ item, cwd }) {
  const input = item.input || {};
  const t = item.toolName;
  if (t === 'Bash' || t === 'PowerShell') return html`<div class="req-preview">
    ${input.description ? html`<div class="req-sub">${input.description}</div>` : null}
    <${CodeView} code=${input.command || ''} lang=${t === 'PowerShell' ? 'powershell' : 'bash'} numbers=${false} copy=${false} wrap=${true} max=${10} />
  </div>`;
  if (t === 'Edit' || t === 'MultiEdit') {
    const hunks = (Array.isArray(input.edits) ? input.edits : [input]).map((e) => ({ old: e.old_string || '', new: e.new_string || '' }));
    return html`<div class="req-preview"><${DiffView} path=${relPath(input.file_path, cwd)} hunks=${hunks} lang=${langFromPath(input.file_path)} max=${24} /></div>`;
  }
  if (t === 'Write') return html`<div class="req-preview"><${CodeView} code=${input.content || ''} lang=${langFromPath(input.file_path)} max=${12}
    head=${html`<span class="cv-path">${relPath(input.file_path, cwd)}</span>`} /></div>`;
  if (t === 'WebFetch') return html`<div class="req-preview"><div class="req-sub">${hostOf(input.url)}</div><code class="req-url">${input.url}</code></div>`;
  if (t === 'Read') return html`<div class="req-preview"><code class="req-url">${relPath(input.file_path, cwd)}</code></div>`;
  return html`<div class="req-preview"><${JsonView} value=${input} max=${12} /></div>`;
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

function PermissionCard({ item, sid, cwd }) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const deny = () => answer(sid, item, reason.trim() ? { behavior: 'deny', message: reason.trim() } : { behavior: 'deny' }, setBusy);
  // optional engine fields: title (heading), description (subline), reason + blockedPath (why it asks)
  const title = str(item.title), desc = str(item.description), why = str(item.reason), path = str(item.blockedPath);
  return html`<div class="req-card" data-request-id=${item.requestId}>
    <div class="req-head"><${Icon} name="shield" size=${16} />
      <div class="req-heading">
        <span class="req-title">${title || html`Allow <strong>${item.toolName || 'this tool'}</strong>?`}</span>
        ${desc ? html`<span class="req-desc">${desc}</span>` : null}
      </div>
      <span class="req-kind">Permission</span></div>
    ${why || path ? html`<div class="req-why"><${Icon} name="info" size=${14} /><div class="req-why-body">
      ${why ? html`<span>${why}</span>` : null}${path ? html`<code class="req-path" title=${path}>${path}</code>` : null}</div></div>` : null}
    <${PermissionPreview} item=${item} cwd=${cwd} />
    <div class="req-actions">
      <button type="button" class="btn btn-primary" disabled=${busy} onClick=${() => answer(sid, item, { behavior: 'allow' }, setBusy)}>Allow</button>
      <button type="button" class="btn" disabled=${busy} onClick=${() => answer(sid, item, { behavior: 'allow', always: true }, setBusy)}>Allow for this session</button>
      <span class="grow" />
      <input class="input sm req-reason" placeholder="Reason (optional)" value=${reason} disabled=${busy}
        onInput=${(e) => setReason(e.currentTarget.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); deny(); } }} />
      <button type="button" class="btn btn-ghost" disabled=${busy} onClick=${deny}>Deny</button>
    </div>
  </div>`;
}

// ---------- access (Positions, docs/POSITIONS.md 7.4) ----------
// A position asks the owner for more than its powers: request_access, or the team guard holding an outward command. The owner
// answers Approve once / Approve always / Deny. "Always" saves to position.json, and beyond the manager's powers it
// widens those ancestors too, so the button names them. Outward actions (send, post, pay, push, publish) and anything
// beyond the company folders (onceOnly) only ever get Approve once / Deny. Answer: sessions.respond
// { behavior: 'allow', scope: 'once'|'always' } | { behavior: 'deny', message? }.
// The item (session.openRequest, access.js openCard): { type: 'request', kind: 'access', requestId, status, title,
// description, access: { kind, target, why, position: { id, name, path: [names, top-level manager .. itself] },
// ancestors?: [ids, nearest first: the ones an always widens], outward, onceOnly?, warn?: true, command?, waitMin } }.
const sessionOf = (sid) => (sessions.value || []).find((s) => s.id === sid) || null;
const nameOf = (id) => { const s = String(id ?? '').replace(/[-_]+/g, ' ').trim(); return s ? s[0].toUpperCase() + s.slice(1) : ''; };
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const list = (n) => (n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`);
const ASKS = { read: 'asks to read', write: 'asks to write to', tool: 'asks to use', bash: 'asks to run shell commands', outward: 'wants to act outside this PC' };
const BASH_WORD = { on: 'Bash on: any command inside its write area', readonly: 'Bash read-only: listing and reading commands', off: 'no shell' };
const WARN = 'This is inside ~/.claude (Claude settings and history).';
const ONCE_FOR = { duty: 'for this duty run', ticket: 'until this question is answered', turn: 'until this turn ends' };

// ancestor ids -> names: the request's own names map first (access.names, the engine: { ancestorId: name }), then the
// open position chats of the company, then the request's name path (all of the position's managers, top-down: when
// every one is widened the two line up; else a name whose slug is the id), else the id in words
function ancestorNames(ids, path, company, own = {}) {
  const known = new Map();
  for (const s of sessions.value || []) { const q = s && s.position; if (q && q.id && str(q.name) && (!company || !q.company || q.company === company)) known.set(q.id, str(q.name)); }
  const managers = path.slice(0, -1).reverse();   // nearest first, like ids
  return ids.map((id, i) => ({ id, name: str(own[id]) || known.get(id) || (managers.length === ids.length ? managers[i] : '') || managers.find((n) => slug(n) === id) || nameOf(id) }));
}

export function accessModel(item, session) {
  const a = item.access || {}, pos = session?.position || null, ap = (a.position && typeof a.position === 'object' ? a.position : null) || a.who || {};
  const name = str(ap.name) || str(pos?.name) || 'This position';
  const outward = !!a.outward || a.kind === 'outward';
  const onceOnly = !outward && !!a.onceOnly;
  const target = str(a.target) || str(item.input?.command) || '';
  const company = str(ap.company) || pos?.company || '';
  // path: names from the top-level manager down to the position itself (access.js namePath); older shape: managers only
  const own = a.names && typeof a.names === 'object' ? a.names : {};   // the engine: { ancestorId: name }
  let path = Array.isArray(ap.path) ? ap.path.map((x) => (typeof x === 'string' ? x : str(x?.name) || str(own[x?.id]) || nameOf(x?.id))).filter(Boolean) : [];
  if (!path.length && pos?.parent) path = [str(pos.parentName) || str(own[pos.parent]) || nameOf(pos.parent)];
  if (path[path.length - 1] !== name) path = [...path, name];
  const ancestors = (Array.isArray(a.ancestors) ? a.ancestors : []).filter(Boolean);
  const anc = ancestors.every((x) => typeof x === 'string') ? ancestorNames(ancestors, path, company, own)
    : ancestors.map((x) => (typeof x === 'string' ? { id: x, name: str(own[x]) || nameOf(x) } : { id: x.id, name: str(x.name) || str(own[x.id]) || nameOf(x.id) }));
  const companyName = str(ap.companyName) || str(pos?.companyName);
  const line = [companyName, 'CEO', ...path.filter((x) => x && x !== 'CEO')].filter(Boolean);
  const kind = outward ? 'outward' : ASKS[a.kind] ? a.kind : 'read';
  const bashLevel = kind === 'bash' ? (/:(\w+)$/.exec(target) || [])[1] || 'on' : '';
  const always = outward || onceOnly ? null : anc.length === 0 ? 'Approve always'
    : anc.length <= 2 ? `Approve always (also widens ${list(anc.map((x) => x.name))})` : `Approve always (also widens ${anc.length} managers)`;
  return {
    who: name, path: line.length > 1 ? line.join(' › ') : '', kind, outward, onceOnly, target, why: str(a.why) || str(item.reason),
    warn: a.warn === true ? WARN : str(a.warn), command: outward ? str(a.command) : '',
    targetShort: kind === 'bash' ? `Bash ${bashLevel === 'readonly' ? 'read-only' : bashLevel}` : kind === 'tool' || outward ? target : basenameOf(target),
    verb: ASKS[kind], bashLevel, ancestors: anc, always, waitMin: a.waitMin || 30, onceFor: str(a.onceFor) || ONCE_FOR[a.during] || 'for its next try',
    savedTo: list([name, ...anc.map((x) => x.name)]),
  };
}
const basenameOf = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');

function AccessCard({ item, sid, cwd }) {
  const [busy, setBusy] = useState(null);   // null | 'once' | 'always' | 'deny'
  const [reason, setReason] = useState('');
  const m = accessModel(item, sessionOf(sid));
  const go = (b, response) => { setBusy(b); answer(sid, item, response, (v) => { if (!v) setBusy(null); }); };
  const deny = () => go('deny', reason.trim() ? { behavior: 'deny', message: reason.trim() } : { behavior: 'deny' });
  const spin = (b) => (busy === b ? html`<span class="spinner sm" aria-hidden="true"></span>` : null);
  // the guard held a tool call: show its exact input; an outward request_access shows the command it named
  const cmd = m.outward && item.toolName && item.toolName !== 'request_access' && item.input && Object.keys(item.input).length > 0;
  return html`<div class=${'req-card access-card' + (m.outward ? ' outward-card' : '')} data-request-id=${item.requestId} data-access=${m.kind} aria-busy=${busy ? 'true' : undefined}>
    <div class="req-head"><${Icon} name="shield" size=${16} />
      <div class="req-heading">
        <span class="req-title"><strong>${m.who}</strong> ${m.verb}${m.kind === 'tool' ? html` <strong>${m.target}</strong>` : null}</span>
        ${m.path ? html`<span class="req-desc">${m.path}</span>` : null}
      </div>
      <span class="req-kind">${m.outward ? 'Outward' : 'Access'}</span></div>
    <div class="req-why"><${Icon} name="info" size=${14} /><div class="req-why-body">
      ${m.why ? html`<span>${m.why}</span>` : null}
      ${m.kind === 'bash' ? html`<span class="req-sub">${BASH_WORD[m.bashLevel] || m.target}</span>`
        : m.kind !== 'tool' && !cmd && !m.command && m.target ? html`<code class="req-path" title=${m.target}>${m.target}</code>` : null}
      ${m.warn ? html`<span class="access-warn"><${Icon} name="alert" size=${12} />${m.warn}</span>` : null}
    </div></div>
    ${cmd ? html`<${PermissionPreview} item=${item} cwd=${cwd} />`
      : m.command ? html`<div class="req-preview"><${CodeView} code=${m.command} lang="bash" numbers=${false} copy=${false} wrap=${true} max=${10} /></div>` : null}
    <div class="tc-decide"><div class="req-actions tc-actions">
      <button type="button" class="btn btn-primary" data-act="access-once" disabled=${!!busy} title=${`Allowed ${m.onceFor}`}
        onClick=${() => go('once', { behavior: 'allow', scope: 'once' })}>${spin('once')}Approve once</button>
      ${m.always ? html`<button type="button" class="btn access-always" data-act="access-always" disabled=${!!busy}
        title=${`Saved to ${m.savedTo}'s powers`} onClick=${() => go('always', { behavior: 'allow', scope: 'always' })}>${spin('always')}${m.always}</button>` : null}
    </div><div class="req-actions tc-actions tc-deny-row">
      <input class="input sm req-reason" data-act="access-note" placeholder="Note (optional)" value=${reason} disabled=${!!busy} aria-label="Note with a deny (optional)"
        onInput=${(e) => setReason(e.currentTarget.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); deny(); } }} />
      <button type="button" class="btn btn-ghost" data-act="access-deny" disabled=${!!busy} onClick=${deny}>${spin('deny')}Deny</button>
    </div></div>
    <div class="access-scope">
      <span><strong>Once</strong> ${m.onceFor}.</span>
      ${m.always ? html`<span><strong>Always</strong> saves it to ${m.savedTo}'s powers.</span>`
        : m.onceOnly ? html`<span class="access-once-only">It is beyond the company folders, so it can only be approved once.</span>` : html`<span>Outward actions ask every time.</span>`}
      <span>No answer in ${m.waitMin} min counts as Deny.</span>
    </div>
  </div>`;
}

// ---------- production guard ----------
// A push to a protected repo or branch (prod-guard.json), or a Railway deploy (main/engine/prod-guard.js). Asked in every
// permission mode; only "Allow once" (no "for this session") and Deny.
function GuardCard({ item, sid, cwd }) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const g = item.guard || {};
  const deny = () => answer(sid, item, reason.trim() ? { behavior: 'deny', message: reason.trim() } : { behavior: 'deny' }, setBusy);
  const desc = str(item.description);
  return html`<div class="req-card guard-card" data-request-id=${item.requestId} data-guard=${g.kind || 'push'}>
    <div class="req-head"><${Icon} name="shield" size=${16} />
      <div class="req-heading">
        <span class="req-title">${item.title || g.title || 'Production action'}</span>
        ${desc ? html`<span class="req-desc">${desc}</span>` : null}
      </div>
      <span class="req-kind">Production</span></div>
    <div class="req-why"><${Icon} name="info" size=${14} /><div class="req-why-body">
      <span>Helm's production guard stopped this, whatever the permission mode. Nothing runs until you choose; no answer in ${g.waitMin || 30} min counts as Deny.</span></div></div>
    <${PermissionPreview} item=${item} cwd=${cwd} />
    <div class="req-actions">
      <button type="button" class="btn btn-primary" data-act="guard-allow" disabled=${busy} onClick=${() => answer(sid, item, { behavior: 'allow' }, setBusy)}>Allow once</button>
      <span class="grow" />
      <input class="input sm req-reason" placeholder="Reason (optional)" value=${reason} disabled=${busy}
        onInput=${(e) => setReason(e.currentTarget.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); deny(); } }} />
      <button type="button" class="btn btn-ghost" data-act="guard-deny" disabled=${busy} onClick=${deny}>Deny</button>
    </div>
  </div>`;
}

// ---------- question (AskUserQuestion) ----------
const OTHER = '__other__';
function QuestionCard({ item, sid }) {
  const qs = item.questions || [];
  const [picks, setPicks] = useState(() => qs.map(() => []));   // per question: [labels | OTHER]
  const [other, setOther] = useState(() => qs.map(() => ''));
  const [active, setActive] = useState(0);                     // question with keyboard focus
  const [focusOpt, setFocusOpt] = useState(null);              // { q, i } for the preview pane
  const [busy, setBusy] = useState(false);
  const root = useRef(null);
  const otherRefs = useRef([]);

  const valueOf = (qi) => {
    const p = picks[qi] || [];
    const labels = p.filter((x) => x !== OTHER);
    if (p.includes(OTHER) && other[qi].trim()) labels.push(other[qi].trim());
    return labels.join(', ');
  };
  const complete = qs.every((_, qi) => valueOf(qi));
  const submit = () => {
    if (!complete || busy) return;
    const answers = {};
    qs.forEach((q, qi) => { answers[q.question] = valueOf(qi); });
    answer(sid, item, { answers }, setBusy);
  };
  const pick = (qi, label) => {
    const q = qs[qi];
    setActive(qi);
    setPicks((prev) => prev.map((p, i) => {
      if (i !== qi) return p;
      if (q.multiSelect) return p.includes(label) ? p.filter((x) => x !== label) : [...p, label];
      return [label];
    }));
    if (label === OTHER) setTimeout(() => otherRefs.current[qi]?.focus(), 0);
  };
  const onKey = (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    if (e.key === 'Enter' && !e.shiftKey && (!typing || t.classList.contains('q-other-input'))) {
      if (complete) { e.preventDefault(); submit(); }
      return;
    }
    if (typing) return;
    const n = parseInt(e.key, 10);
    const q = qs[active];
    if (q && n >= 1 && n <= 9) {
      e.preventDefault();
      if (n <= q.options.length) pick(active, q.options[n - 1].label);
      else if (n === q.options.length + 1) pick(active, OTHER);
    }
  };
  // Number keys also work when nothing is focused (the user just looked over at the card).
  useEffect(() => {
    const h = (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (sid && activeId.value && sid !== activeId.value) return;   // split view: only the focused pane's card
      const a = document.activeElement;
      if (a && a !== document.body && !root.current?.contains(a)) return;
      if (root.current?.contains(a)) return; // handled by onKey
      onKey(e);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const fo = focusOpt && qs[focusOpt.q]?.options[focusOpt.i];
  const anyPreview = qs.some((q) => q.options.some((o) => o.preview));
  return html`<div class=${'req-card q-card' + (anyPreview ? ' has-preview' : '')} ref=${root} onKeyDown=${onKey} data-request-id=${item.requestId}>
    <div class="req-head"><${Icon} name="question" size=${16} /><div class="req-heading"><span class="req-title">${qs.length > 1 ? `Claude has ${qs.length} questions` : 'Claude has a question'}</span></div>
      <span class="req-kind">Answer to continue</span></div>
    <div class="q-body">
      <div class="q-list">
        ${qs.map((q, qi) => html`<fieldset class=${'q-block' + (active === qi ? ' active' : '')} onFocusIn=${() => setActive(qi)}>
          <legend class="q-legend">${q.header ? html`<span class="q-chip">${q.header}</span>` : null}<span class="q-text">${q.question}</span>
            ${q.multiSelect ? html`<span class="q-hint">Choose any</span>` : null}</legend>
          <div class="q-opts" role=${q.multiSelect ? 'group' : 'radiogroup'}>
            ${q.options.map((o, i) => {
              const on = (picks[qi] || []).includes(o.label);
              return html`<button type="button" class=${'q-opt' + (on ? ' on' : '')} role=${q.multiSelect ? 'checkbox' : 'radio'} aria-checked=${on}
                onClick=${() => pick(qi, o.label)} onFocus=${() => setFocusOpt({ q: qi, i })} onMouseEnter=${() => o.preview && setFocusOpt({ q: qi, i })}>
                <span class=${'q-mark' + (q.multiSelect ? ' box' : '')}>${on ? html`<${Icon} name="check" size=${11} />` : null}</span>
                <span class="q-opt-main"><span class="q-opt-label">${o.label}</span>${o.description ? html`<span class="q-opt-desc">${o.description}</span>` : null}</span>
                <span class="kbd q-key">${i + 1}</span>
              </button>`;
            })}
            <div class=${'q-opt q-other' + ((picks[qi] || []).includes(OTHER) ? ' on' : '')} onClick=${() => !(picks[qi] || []).includes(OTHER) && pick(qi, OTHER)}>
              <span class=${'q-mark' + (q.multiSelect ? ' box' : '')}>${(picks[qi] || []).includes(OTHER) ? html`<${Icon} name="check" size=${11} />` : null}</span>
              <input class="q-other-input" placeholder="Other…" value=${other[qi]} ref=${(el) => { otherRefs.current[qi] = el; }}
                onFocus=${() => { setActive(qi); if (!(picks[qi] || []).includes(OTHER)) pick(qi, OTHER); }}
                onInput=${(e) => { const v = e.currentTarget.value; setOther((prev) => prev.map((x, i) => (i === qi ? v : x))); }} />
              <span class="kbd q-key">${q.options.length + 1}</span>
            </div>
          </div>
        </fieldset>`)}
      </div>
      ${anyPreview ? html`<div class="q-preview">${fo?.preview ? html`<pre>${fo.preview}</pre>` : html`<div class="q-preview-empty">Focus an option to preview it</div>`}</div>` : null}
    </div>
    <div class="req-actions">
      <span class="q-help"><span class="kbd">1</span>–<span class="kbd">${Math.min(9, (qs[active]?.options.length || 0) + 1)}</span> pick · <span class="kbd">Enter</span> submit</span>
      <span class="grow" />
      <button type="button" class="btn btn-primary" disabled=${!complete || busy} onClick=${submit}>Submit</button>
    </div>
  </div>`;
}

// ---------- plan (ExitPlanMode) ----------
function PlanCard({ item, sid }) {
  const [busy, setBusy] = useState(false);
  const [fb, setFb] = useState(null);   // null = closed, string = feedback box open
  const [bypass, setBypass] = useState(false);   // "Approve + bypass permissions" asks once more first
  const plan = item.plan || item.input?.plan || '';
  return html`<div class="req-card plan-card" data-request-id=${item.requestId}>
    <div class="req-head"><${Icon} name="map" size=${16} /><div class="req-heading"><span class="req-title">Ready to code?</span></div><span class="req-kind">Plan</span></div>
    <div class="plan-body"><${Markdown} text=${plan} /></div>
    ${fb != null ? html`<div class="plan-fb"><textarea class="textarea" rows="3" placeholder="What should Claude change in the plan?" value=${fb}
        onInput=${(e) => setFb(e.currentTarget.value)} ref=${(el) => el && !el.dataset.f && (el.dataset.f = '1', el.focus())}
        onKeyDown=${(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && fb.trim()) answer(sid, item, { behavior: 'deny', message: fb.trim() }, setBusy); }} /></div>` : null}
    ${bypass && fb == null ? html`<div class="plan-bypass" role="alert"><${Icon} name="shield" size=${15} />
        <span>Claude will run every tool, including shell commands and file edits, without asking for the rest of this session. You can change the mode again from the composer.</span></div>` : null}
    <div class="req-actions">
      ${fb == null && bypass ? html`
        <span class="grow" />
        <button type="button" class="btn btn-ghost" disabled=${busy} onClick=${() => setBypass(false)}>Cancel</button>
        <button type="button" class="btn btn-danger" data-act="confirm-bypass" disabled=${busy} onClick=${() => answer(sid, item, { behavior: 'allow', mode: 'bypassPermissions' }, setBusy)}>Approve + bypass permissions</button>`
      : fb == null ? html`
        <button type="button" class="btn btn-primary" disabled=${busy} onClick=${() => answer(sid, item, { behavior: 'allow' }, setBusy)}>Approve</button>
        <button type="button" class="btn" disabled=${busy} onClick=${() => answer(sid, item, { behavior: 'allow', mode: 'acceptEdits' }, setBusy)}>Approve + auto-accept edits</button>
        <button type="button" class="btn btn-ghost" data-act="bypass" disabled=${busy} onClick=${() => setBypass(true)} title="Asks you to confirm first">Approve + bypass permissions…</button>
        <span class="grow" />
        <button type="button" class="btn btn-ghost" disabled=${busy} onClick=${() => setFb('')}>Keep planning</button>`
      : html`
        <span class="grow" />
        <button type="button" class="btn btn-ghost" disabled=${busy} onClick=${() => setFb(null)}>Back</button>
        <button type="button" class="btn btn-primary" disabled=${busy || !fb.trim()} onClick=${() => answer(sid, item, { behavior: 'deny', message: fb.trim() }, setBusy)}>Send feedback</button>`}
    </div>
  </div>`;
}

function RequestImpl({ item, sid, cwd }) {
  if (item.status !== 'pending') return html`<${Record} item=${item} sid=${sid} />`;
  if (item.kind === 'access') return html`<${AccessCard} item=${item} sid=${sid} cwd=${cwd} />`;   // Positions: a position asks for more access
  if (item.kind === 'question') return html`<${QuestionCard} item=${item} sid=${sid} />`;
  if (item.kind === 'plan') return html`<${PlanCard} item=${item} sid=${sid} />`;
  if (item.guard) return html`<${GuardCard} item=${item} sid=${sid} cwd=${cwd} />`;
  return html`<${PermissionCard} item=${item} sid=${sid} cwd=${cwd} />`;
}
export const RequestItem = memo(RequestImpl);

