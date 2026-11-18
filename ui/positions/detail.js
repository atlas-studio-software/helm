// Team view: one position's detail (Positions, lane T6; spec docs/POSITIONS.md 10.2 "Detail"). A .seg of
// sections: Overview, Brief, Notebook, Powers, Duties, Chats, Cross-talk. Powers have no edit form (rule 9):
// a change is discussed with the CEO and lands as a proposal. Pause and duty on/off are operational, so they
// act at once. Also exports the pieces team.js reuses: ProposalCard, CrosstalkList, CeoDetail.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { Markdown } from '../lib/markdown.js';
import { respond } from '../lib/store.js';
import { cx, useMenu, Menu } from '../shell/util.js';
import {
  liveStatus, statusText, dotClass, rowActivity, fmtNextDuty, powerRows, GRANT_TEXT, grantTone, triggerWords, RUN_TEXT, runTone,
  untilLabel, agoShort, dayLabel, chatRows, crosstalkLine, proposalTitle, proposalStatus, decidedText, partyName, baseName, CEO,
  proposalChanges, draftPowerChips, excessOf, excessHeadline, scopeWords, pathKey,
} from '../lib/positions-model.js';
import {
  positions, crosstalk, detailTab, busy, pkey, loadPosition, loadCompany, loadCrosstalk, select, openChat, openCeo, openOld, companies,
  discussWithCeo, discussIn, setPaused, runDuty, toggleDuty, decide,
} from './state.js';
import { Notes } from './notes.js';

const TABS = [['overview', 'Overview'], ['brief', 'Brief'], ['notebook', 'Notebook'], ['powers', 'Powers'], ['duties', 'Duties'], ['chats', 'Chats'], ['crosstalk', 'Cross-talk']];
const ts = (v) => (typeof v === 'number' ? v : Date.parse(v) || 0);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

// ---------------------------------------------------------------- shared bits
function Notice({ tone = '', icon = 'info', children, action }) {
  return html`<div class=${cx('cc-health pos-notice', tone)} role=${tone === 'danger' ? 'alert' : undefined}><${Icon} name=${icon} size=${14} /><span>${children}</span>${action || null}</div>`;
}
const Loading = ({ text }) => html`<div class="state-note pos-state"><span class="spinner"></span>${text}</div>`;
const Link = ({ onClick, children, title }) => html`<button type="button" class="pos-link" title=${title} onClick=${onClick}>${children}</button>`;

// Everything the proposal changes, from the engine's card (proposals.js): an edit's diff (fields from -> to, the
// brief's changed lines, powers and duties added / removed), a create's remit, scope, powers (cut ones marked),
// duties and brief, a company's folders, a retire's moves; and the excess notice (powers beyond the manager's,
// which the position will not have). Nothing that changes sits behind a control without a count.
// an edit's added power the engine lists in excess is cut on approval: its chip says so, like a create card's
// (the engine compares expanded tokens: $scope of a one-product scope is that folder; other tokens stay unmatched)
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
function ProposalFacts({ p, names, duties }) {
  const d = p.draft || {};
  const ch = proposalChanges(p, names, { duties });
  if (ch.powers) ch.powers.added = ch.powers.added.map((c) => ({ ...c, cut: addedCut(c, ch.excess, d.scope) }));
  const chips = p.action === 'create' ? draftPowerChips(d.powers, d.scope, excessOf(p)) : [];
  const who = d.name || names[p.target] || p.target || 'the position';
  const Chip = ({ c, sign = '' }) => html`<span class=${cx('chip pos-chip', c.mono && 'mono', c.cut && 'danger', !c.cut && sign === '+' && 'ok', sign === '−' && 'pos-chip-del')}
    title=${c.cut ? `${c.title || c.label}: beyond its manager's powers, so cut` : c.title || c.label}><span class="truncate">${sign ? `${sign} ` : ''}${c.label}</span></span>`;
  const brief = ch.brief;
  return html`<div class="pos-prop-facts">
    ${ch.excess.length > 0 && html`<div class="pos-excess" role="note">
      <p class="pos-excess-head"><${Icon} name="alert" size=${13} />${excessHeadline(ch.excess, who)}</p>
      <ul class="pos-excess-list">${ch.excess.map((x) => html`<li key=${`${x.power}:${x.value}`}><span class=${cx(x.mono && 'mono')} title=${x.title}>${x.label}</span><span class="pos-dim"> · ${x.why}${x.kept.length ? `; keeps only ${x.kept.join(', ')}` : ''}</span></li>`)}</ul>
    </div>`}
    <dl class="pos-facts">
      ${ch.fields.map((f) => html`<div key=${f.key}><dt>${f.label}</dt><dd class="pos-change"><s class="pos-old" title=${f.fromTitle}>${f.from || '(none)'}</s><span class="pos-arrow" aria-label="becomes">→</span><span title=${f.toTitle}>${f.to || '(none)'}</span></dd></div>`)}
      ${ch.powers && html`<div><dt>Powers</dt><dd class="pos-chips">${ch.powers.added.map((c) => html`<${Chip} key=${`a${c.label}`} c=${c} sign="+" />`)}${ch.powers.removed.map((c) => html`<${Chip} key=${`r${c.label}`} c=${c} sign="−" />`)}</dd></div>`}
      ${ch.duties && html`<div><dt>Duties</dt><dd class="pos-lines">
        ${ch.duties.added.map((x) => html`<span key=${`a${x.id}`} class="pos-add">+ ${x.title}${x.trigger ? html`<span class="pos-dim"> · ${x.trigger}</span>` : ''}</span>`)}
        ${ch.duties.changed.map((x) => html`<span key=${`c${x.id}`}>~ ${x.title} changed${x.trigger ? html`<span class="pos-dim"> · ${x.trigger}</span>` : ''}</span>`)}
        ${ch.duties.removed.map((x) => html`<span key=${`r${x.id}`} class="pos-del">− ${x.title}</span>`)}</dd></div>`}
      ${p.action === 'create' && d.remit && html`<div><dt>Remit</dt><dd>${d.remit}</dd></div>`}
      ${p.action === 'create' && html`<div><dt>Scope</dt><dd title=${d.scope?.folder || ''}>${scopeWords(d.scope)}</dd></div>`}
      ${p.action === 'create' && chips.length > 0 && html`<div><dt>Powers</dt><dd class="pos-chips">${chips.map((c) => html`<${Chip} key=${`${c.power}:${c.value}`} c=${c} />`)}</dd></div>`}
      ${p.action === 'create' && (d.duties || []).length > 0 && html`<div><dt>Duties</dt><dd class="pos-lines">${d.duties.map((x) => html`<span key=${x.id}>${x.title || x.id}<span class="pos-dim"> · ${triggerWords(x.trigger, d.scope)}</span></span>`)}</dd></div>`}
      ${p.action === 'create' && html`<div><dt>Model</dt><dd>${d.model || 'Helm default'}<span class="pos-dim"> · effort ${d.effort || 'high'}</span></dd></div>`}
      ${(p.action === 'company' || (p.action === 'edit' && p.target == null)) && (d.folders || []).length > 0 && html`<div><dt>Folders</dt><dd class="pos-chips">${d.folders.map((f) => html`<span key=${f} class="chip pos-chip mono" title=${f}><span class="truncate">${f}</span></span>`)}</dd></div>`}
      ${p.action === 'retire' && html`<div><dt>Retires</dt><dd>${(d.retires || [p.target]).map((id) => names[id] || id).join(', ')}</dd></div>`}
      ${p.action === 'retire' && (d.moves || []).length > 0 && html`<div><dt>Reports</dt><dd class="pos-lines">${d.moves.map((m) => html`<span key=${m.id}>${names[m.id] || m.id} moves up to ${m.to == null ? 'the CEO' : names[m.to] || m.to}</span>`)}</dd></div>`}
    </dl>
    ${brief && html`<details class="pos-more pos-brief-diff">
      <summary>Brief changes<span class="pos-dim tnum"> · +${brief.added} −${brief.removed} lines</span></summary>
      <div class="pos-diff" role="group" aria-label="Brief changes">${brief.rows.map((r, i) => r.t === 'gap'
        ? html`<div key=${i} class="pos-diff-gap">… ${r.n} unchanged line${r.n === 1 ? '' : 's'}</div>`
        : html`<div key=${i} class=${cx('pos-diff-l', r.t)}><span class="pos-diff-sign" aria-hidden="true">${r.t === 'add' ? '+' : r.t === 'del' ? '−' : ' '}</span><span class="sr-only">${r.t === 'add' ? 'Added: ' : r.t === 'del' ? 'Removed: ' : ''}</span>${r.text || ' '}</div>`)}</div>
    </details>`}
    ${p.action === 'create' && d.brief && html`<details class="pos-more"><summary>Brief<span class="pos-dim tnum"> · ${String(d.brief).split('\n').length} lines</span></summary><div class="pos-more-body"><${Markdown} text=${d.brief} class="pos-md pos-md-sm" /></div></details>`}
  </div>`;
}

export function ProposalCard({ cid, p, names, duties, waitsFor = null, folder = null }) {
  const st = proposalStatus(p);
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');
  const k = `decide:${p.id}`;
  const by = p.by?.kind === 'ceo' ? 'the CEO' : p.by?.kind === 'import' ? `an import${p.by.name ? ` (${p.by.name})` : ''}` : partyName(p.by, names);
  const icon = p.action === 'retire' ? 'archive' : p.action === 'edit' ? 'pencil' : 'file-plus';
  // Discuss: the chat that proposed it; else (an import) a CEO chat, or a new chat in the proposed company's folder
  const about = `About the proposal "${proposalTitle(p, names)}" (${p.id}): `;
  const discuss = p.by?.sessionId ? { key: 'none', title: 'Talk it through in the chat that proposed it', go: () => openOld(p.by.sessionId) }
    : cid ? { key: 'ceo', title: 'Talk it through with the CEO', go: () => discussWithCeo(cid, about) }
    : folder ? { key: `discuss:${folder}`, title: `Talk it through in a new chat in ${baseName(folder)}`, go: () => discussIn(folder, about) } : null;
  return html`<article class=${cx('pos-prop', st === 'open' ? 'is-open' : 'is-done')} data-proposal=${p.id}>
    <header class="pos-prop-head">
      <${Icon} name=${icon} size=${14} />
      <span class="pos-prop-title">${proposalTitle(p, names)}</span>
      <span class="pos-ago tnum" title=${new Date(ts(p.at)).toLocaleString()}>${agoShort(ts(p.at))}</span>
    </header>
    ${st === 'open' ? html`
      <p class="pos-prop-by">Proposed by ${by}${p.why ? html`: <span class="pos-prop-why">${p.why}</span>` : ''}</p>
      <${ProposalFacts} p=${p} names=${names} duties=${duties} />
      ${p.error && html`<p class="pos-prop-err" role="alert"><${Icon} name="x-circle" size=${13} />Last try failed: ${p.error}</p>`}
      ${waitsFor && html`<p class="pos-prop-wait"><${Icon} name="clock" size=${13} />Waits for ${waitsFor}: approve the company first.</p>`}
      ${declining ? html`<div class="pos-actions">
          <input class="input sm pos-note-in" type="text" value=${note} placeholder="Note for the proposer (optional)" aria-label="Decline note"
            onInput=${(e) => setNote(e.currentTarget.value)} onKeyDown=${(e) => { if (e.key === 'Enter') decide(cid, p.id, 'decline', note.trim()); if (e.key === 'Escape') setDeclining(false); }} />
          <button type="button" class="btn btn-sm btn-danger" disabled=${!!busy.value[k]} onClick=${() => decide(cid, p.id, 'decline', note.trim())}>Decline</button>
          <button type="button" class="btn btn-sm btn-ghost" onClick=${() => setDeclining(false)}>Cancel</button>
        </div>`
      : html`<div class="pos-actions">
          <button type="button" class="btn btn-sm btn-primary" disabled=${!!busy.value[k] || !!waitsFor} title=${waitsFor ? `Approve ${waitsFor} first` : undefined} onClick=${() => decide(cid, p.id, 'approve')}><${Icon} name="check" size=${13} />Approve</button>
          <button type="button" class="btn btn-sm" disabled=${!!busy.value[k]} onClick=${() => setDeclining(true)}>Decline</button>
          ${discuss && html`<button type="button" class="btn btn-sm btn-ghost" title=${discuss.title} disabled=${!!busy.value[discuss.key]} onClick=${discuss.go}><${Icon} name="chat" size=${13} />Discuss</button>`}
        </div>`}`
    : html`<p class=${cx('pos-prop-done', st === 'approved' ? 'ok' : st === 'declined' ? 'no' : '')}>${decidedText(p)}${p.decision?.note ? html` · <span class="pos-dim">${p.decision.note}</span>` : ''}</p>`}
  </article>`;
}

function CtItem({ e, names, depth = 0 }) {
  const [open, setOpen] = useState(false);
  const l = crosstalkLine(e, names);
  const kids = e.children || [];
  return html`<li class="pos-ct" data-ticket=${e.ticket}>
    <button type="button" class="pos-ct-head" aria-expanded=${open ? 'true' : 'false'} onClick=${() => setOpen(!open)}>
      <span class="pos-ct-l1">
        <${Icon} name="chevron-right" size=${12} class=${cx('pos-ct-chev', open && 'open')} />
        <span class="pos-ct-who truncate">${l.from}<span class="pos-ct-arrow" aria-label="asked"> → </span>${l.to}</span>
        ${l.colleague && html`<span class="pos-ct-kind">colleague</span>`}
        <span class=${cx('pos-ct-state', `t-${l.tone}`)}>${l.stateText}${l.took ? ` ${l.took}` : ''}</span>
        <span class="pos-ago tnum">${l.when}</span>
      </span>
      <span class="pos-ct-q truncate">${l.q ? `“${l.q}”` : 'No question text'}</span>
    </button>
    ${open && html`<div class="pos-ct-body">
      <p class="pos-ct-label">Question</p><p class="pos-ct-text">${e.question || '—'}</p>
      ${(e.handed || []).length > 0 && html`<p class="pos-ct-files">${e.handed.map((f) => html`<span class="chip mono pos-chip" key=${f} title=${f}><span class="truncate">${baseName(f)}</span></span>`)}</p>`}
      ${e.answer ? html`<p class="pos-ct-label">Answer</p><p class="pos-ct-text">${e.answer}</p>`
        : e.reason ? html`<p class="pos-ct-label">${cap(l.stateText)}</p><p class="pos-ct-text">${e.reason}</p>`
        : html`<p class="pos-ct-text pos-dim">No answer yet.</p>`}
      ${e.costUsd > 0 && html`<p class="pos-ct-cost tnum">$${(+e.costUsd).toFixed(2)}</p>`}
    </div>`}
    ${kids.length > 0 && html`<ul class="pos-ct-kids" aria-label=${`Asked while answering: ${kids.length}`}>${kids.map((c) => html`<${CtItem} key=${c.ticket} e=${c} names=${names} depth=${depth + 1} />`)}</ul>`}
  </li>`;
}
export function CrosstalkList({ entries, names, empty = 'Nothing asked yet.' }) {
  if (!entries?.length) return html`<p class="pos-empty">${empty}</p>`;
  return html`<ul class="pos-ct-list">${entries.map((e) => html`<${CtItem} key=${e.ticket} e=${e} names=${names} />`)}</ul>`;
}

// an access request waiting in the position's chat, answerable here (same answer as the chat card, PROTOCOL request kind "access")
function AccessCard({ cid, id, r, names }) {
  const a = r.access || {};
  const [busyA, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const answer = async (response) => {
    setBusy(true); setErr(null);
    try { await respond(r.sessionId, r.requestId, response); await Promise.all([loadPosition(cid, id, { quiet: true }), loadCompany(cid, { quiet: true })]); }
    catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  };
  const widens = (a.ancestors || []).map((x) => names[x] || x);
  const once = !a.outward && !!a.onceOnly;   // beyond the company folders: the engine never saves it, so no Approve always
  return html`<div class="pos-req">
    <div class="pos-req-head"><${Icon} name=${a.outward ? 'send' : 'shield'} size=${14} />
      <span>${a.outward ? 'Wants to act outside: ' : `Wants ${a.kind || 'more'} access: `}</span></div>
    <p class="pos-req-target mono" title=${a.target}>${a.target}</p>
    ${a.why && html`<p class="pos-req-why">${a.why}</p>`}
    ${a.warn && html`<p class="pos-req-warn"><${Icon} name="alert" size=${12} /><span>This is inside ~/.claude (Claude settings and history).</span></p>`}
    ${once && html`<p class="pos-req-once">It is beyond the company folders, so it can only be approved once.</p>`}
    ${err && html`<p class="pos-req-err">${err}</p>`}
    <div class="pos-actions">
      <button type="button" class="btn btn-sm btn-primary" disabled=${busyA} onClick=${() => answer({ behavior: 'allow', scope: 'once' })}>Approve once</button>
      ${!a.outward && !once && html`<button type="button" class="btn btn-sm" disabled=${busyA} title=${widens.length ? `Saved to the definition. Also widens ${widens.join(', ')}` : 'Saved to the definition'}
        onClick=${() => answer({ behavior: 'allow', scope: 'always' })}>${widens.length ? `Approve always (also widens ${widens.join(', ')})` : 'Approve always'}</button>`}
      <button type="button" class="btn btn-sm" disabled=${busyA} onClick=${() => answer({ behavior: 'deny' })}>Deny</button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- sections
function Overview({ cid, id, node, d, names }) {
  const p = d.position;
  const st = liveStatus(node || p);
  const act = rowActivity(node || {});
  const duty = fmtNextDuty(node?.nextDuty);
  const reports = node?.reports || [];
  const reqs = d.pending?.requests || [];
  const props = d.pending?.proposals || [];
  const missingReqs = Math.max(0, (node?.pending?.requests || 0) - reqs.length);
  const open = Math.max(0, +node?.openItems || 0);
  const created = p.createdAt ? dayLabel(ts(p.createdAt)) : null;
  return html`<div class="pos-sec">
    <p class="pos-remit-big">${p.remit || 'No remit yet.'}</p>
    ${node?.problem && html`<${Notice} tone="danger" icon="alert">position.json did not validate, so the last good version is in force: ${node.problem}<//>`}
    ${(reqs.length > 0 || props.length > 0 || missingReqs > 0) && html`<div class="pos-needs">
      <p class="pos-needs-title"><span class="dot waiting" aria-hidden="true"></span>Waiting on you</p>
      ${reqs.map((r) => html`<${AccessCard} key=${r.requestId} cid=${cid} id=${id} r=${r} names=${names} />`)}
      ${missingReqs > 0 && html`<${Notice} tone="warn" icon="shield" action=${html`<button type="button" class="btn btn-sm" onClick=${() => openChat(cid, id)}>Open chat</button>`}>${missingReqs === 1 ? 'An access request is' : `${missingReqs} access requests are`} waiting in its chat.<//>`}
      ${props.map((x) => html`<${ProposalCard} key=${x.id} cid=${cid} p=${x} names=${names} duties=${d.position?.duties} />`)}
    </div>`}
    <dl class="pos-kv">
      <div><dt>Status</dt><dd><span class=${cx('dot', dotClass(st))} aria-hidden="true"></span>${statusText(st)}${act.text ? html`<span class="pos-dim"> · ${act.text}${act.ago ? ` ${act.ago}` : ''}</span>` : ''}</dd></div>
      <div><dt>Manager</dt><dd>${p.parent ? html`<${Link} onClick=${() => select(p.parent)}>${names[p.parent] || p.parent}<//>` : html`<${Link} onClick=${() => select(CEO)}>CEO<//>`}</dd></div>
      <div><dt>Reports</dt><dd class="pos-links">${reports.length ? reports.map((r, i) => html`${i ? html`<span class="pos-dim">, </span>` : ''}<${Link} key=${r} onClick=${() => select(r)}>${names[r] || r}<//>`) : html`<span class="pos-dim">None</span>`}</dd></div>
      <div><dt>Scope</dt><dd>${p.scope?.kind === 'product' ? html`<span class="mono" title=${p.scope.folder}>${baseName(p.scope.folder)}</span>` : 'Company-wide'}</dd></div>
      <div><dt>Model</dt><dd>${p.model || 'Helm default'}<span class="pos-dim"> · effort ${p.effort || 'high'}</span></dd></div>
      <div><dt>Open items</dt><dd>${open ? html`<${Link} onClick=${() => { detailTab.value = 'notebook'; }}>${open} in the notebook<//>` : html`<span class="pos-dim">None</span>`}</dd></div>
      <div><dt>Next duty</dt><dd>${duty ? html`<span title=${duty.full}>${duty.label}</span>` : html`<span class="pos-dim">None scheduled</span>`}</dd></div>
      ${created && html`<div><dt>Created</dt><dd>${created}<span class="pos-dim"> · version ${p.version || 1}</span></dd></div>`}
    </dl>
  </div>`;
}

function Powers({ cid, d, names }) {
  const p = d.position;
  const rows = powerRows(p, names, { companyFolders: companies.value[cid]?.data?.company?.folders });
  const grants = (d.grants || []).slice().sort((a, b) => ts(b.at) - ts(a.at));
  return html`<div class="pos-sec">
    <dl class="pos-kv pos-powers">
      ${rows.map((r) => html`<div key=${r.key}><dt>${r.label}</dt><dd>
        ${r.items ? (r.items.length ? html`<span class="pos-chips">${r.items.map((it) => html`<span key=${it.value} class=${cx('chip pos-chip', it.mono && 'mono', it.limitedBy && 'limited')} title=${[it.title || it.value, it.limitNote && `Listed, but ${it.partly ? 'partly ' : ''}${it.limitNote}`].filter(Boolean).join('\n')}>
            <span class="truncate">${it.label}</span>${it.limitNote && html`<span class="pos-lim">${it.partly ? 'partly ' : ''}${it.limitNote}</span>`}</span>`)}</span>` : html`<span class="pos-dim">None</span>`)
          : html`<span>${r.text}</span>${r.limitNote && html`<span class="chip pos-chip limited pos-lim-chip" title=${r.title}>${r.limitNote}</span>`}`}
      </dd></div>`)}
    </dl>
    <p class="pos-foot">Powers change only by a proposal, so a report never gets more than its manager. Outward actions (send, post, pay, push) always ask you, once.</p>
    <div class="pos-actions"><button type="button" class="btn btn-sm" disabled=${!!busy.value.ceo} onClick=${() => discussWithCeo(cid, `I want to change ${p.name}'s powers: `)}><${Icon} name="chat" size=${13} />Discuss a change with the CEO</button></div>
    <h3 class="pos-h3">Access decisions</h3>
    ${grants.length ? html`<ul class="pos-list">${grants.map((g) => html`<li key=${g.id} class="pos-li">
        <span class="pos-li-l1"><span class="pos-li-title truncate" title=${g.request?.target}>${cap(g.request?.kind || 'access')}: <span class=${cx(g.request?.kind !== 'outward' && 'mono')}>${g.request?.target}</span></span>
          <span class=${cx('chip pos-chip', grantTone(g.decision))}>${GRANT_TEXT[g.decision] || g.decision}</span></span>
        <span class="pos-li-sub">${[g.request?.why, g.note && `Note: ${g.note}`, dayLabel(ts(g.at))].filter(Boolean).join(' · ')}</span>
      </li>`)}</ul>` : html`<p class="pos-empty">No access requests yet.</p>`}
  </div>`;
}

function Duties({ cid, id, d }) {
  const p = d.position;
  const list = d.duties || [];
  const paused = p.status === 'paused';
  if (!list.length) return html`<div class="pos-sec"><p class="pos-empty">No duties. A duty (a schedule or an event such as a new commit) is added by a proposal: ask the CEO or ${p.parent ? 'its manager' : 'this position'} to propose one.</p></div>`;
  return html`<div class="pos-sec">
    ${paused && html`<${Notice} tone="warn" icon="pause">Paused: no duty runs until you resume ${p.name}.<//>`}
    <ul class="pos-list">${list.map((x) => {
      const last = x.last;
      const kRun = `run:${id}/${x.id}`, kTog = `duty:${id}/${x.id}`;
      return html`<li key=${x.id} class=${cx('pos-li pos-duty-row', !x.enabled && 'off')}>
        <span class="pos-li-l1">
          <span class="pos-li-title truncate">${x.title}</span>
          <span class="pos-li-tag">${x.output === 'draft' ? 'draft' : 'report'}</span>
          <button type="button" class="toggle" role="switch" aria-checked=${x.enabled ? 'true' : 'false'} aria-label=${`${x.title}: ${x.enabled ? 'on' : 'off'}`}
            disabled=${!!busy.value[kTog]} onClick=${() => toggleDuty(cid, id, x.id, !x.enabled)}></button>
        </span>
        <span class="pos-li-sub">${triggerWords(x.trigger, p.scope)}</span>
        <span class="pos-li-sub pos-duty-meta tnum">
          <span>${x.enabled ? (x.nextAt ? html`Next <span title=${new Date(x.nextAt).toLocaleString()}>${untilLabel(x.nextAt)}</span>` : x.trigger?.kind === 'event' ? 'Runs on the event' : 'Not scheduled') : 'Off'}</span>
          ${last && html`<span class="pos-dim"> · </span><span class=${cx('pos-run', `t-${runTone(last.state)}`)} title=${last.reason || ''}>Last: ${RUN_TEXT[last.state] || last.state}${last.at ? ` ${agoShort(ts(last.at))}` : ''}${last.costUsd > 0 ? ` · $${(+last.costUsd).toFixed(2)}` : ''}</span>`}
          <span class="grow"></span>
          <button type="button" class="btn btn-sm pos-run-btn" disabled=${paused || !!busy.value[kRun] || last?.state === 'started'} onClick=${() => runDuty(cid, id, x.id)}>
            <${Icon} name="play" size=${12} />${last?.state === 'started' ? 'Running…' : 'Run now'}</button>
        </span>
        ${last?.state === 'failed' && last.reason && html`<span class="pos-li-sub pos-run-why">${last.reason}</span>`}
      </li>`;
    })}</ul>
  </div>`;
}

function Chats({ cid, id, d }) {
  const rows = chatRows(d.chats);
  if (!rows.length) return html`<div class="pos-sec"><p class="pos-empty">No chat yet. The first one starts when you open it, or with the first question or duty.</p>
    <div class="pos-actions"><button type="button" class="btn btn-sm" onClick=${() => openChat(cid, id)}><${Icon} name="chat" size=${13} />Open chat</button></div></div>`;
  return html`<div class="pos-sec"><ul class="pos-list">${rows.map((c) => html`<li key=${c.n} class=${cx('pos-li pos-chat', c.current && 'current')}>
      <span class="pos-li-l1">
        <span class="pos-li-title">${c.label}</span>
        ${c.current && html`<span class="chip pos-chip on">Current</span>`}
        ${c.pct != null && html`<span class="pos-dim tnum">${Math.round(c.pct)}% context</span>`}
        <span class="grow"></span>
        <button type="button" class="btn btn-sm" onClick=${() => (c.current ? openChat(cid, id) : openOld(c.sessionId))} disabled=${!c.current && !c.sessionId}
          title=${c.current ? 'Open the current chat' : 'Opens read-only: talk in the current chat'}>${c.current ? 'Open' : 'View'}</button>
      </span>
      <span class="pos-li-sub">${c.sub}</span>
      ${c.handoff && html`<details class="pos-more"><summary>Handoff</summary><p class="pos-more-body pos-handoff">${c.handoff}</p></details>`}
    </li>`)}</ul>
    <p class="pos-foot">A chat rolls to a fresh one when its context fills up, seeded from the notebook and a handoff. Old chats stay readable.</p>
  </div>`;
}

function Crosstalk({ cid, id, names }) {
  const k = pkey(cid, id);
  const c = crosstalk.value[k];
  useEffect(() => { loadCrosstalk(cid, id, { quiet: !!c?.entries }); }, [cid, id]);
  if (c?.error && !c.entries) return html`<div class="pos-sec"><${Notice} tone="danger" icon="x-circle" action=${html`<button type="button" class="btn btn-sm" onClick=${() => loadCrosstalk(cid, id)}>Try again</button>`}>Could not read the cross-talk log: ${c.error}<//></div>`;
  if (!c?.entries) return html`<div class="pos-sec"><${Loading} text="Reading the log…" /></div>`;
  return html`<div class="pos-sec"><${CrosstalkList} entries=${c.entries} names=${names} empty=${`Nobody has asked ${names[id] || 'this position'} anything yet, and it has asked nobody.`} /></div>`;
}

// ---------------------------------------------------------------- the CEO row's detail
export function CeoDetail({ cid, data, narrow, onBack, names }) {
  const co = data?.company || {};
  const tops = (data?.tree || []).filter((r) => !r.parent);
  return html`<div class="pos-detail">
    <header class="pos-dhead">
      ${narrow && html`<button type="button" class="icon-btn pos-back" aria-label="Back to the team" onClick=${onBack}><${Icon} name="chevron-left" size=${18} /></button>`}
      <div class="pos-dtitle">
        <h2 class="pos-dname"><span class="pos-ceo-mark" aria-hidden="true"><${Icon} name="chat" size=${13} /></span>CEO</h2>
        <p class="pos-dsub">Any of your Helm chats in ${co.name || 'this company'}'s folders. It sees its direct reports and can ask them, look up the log and propose changes.</p>
      </div>
      ${narrow && html`<div class="pos-dactions"><button type="button" class="btn btn-sm" disabled=${!!busy.value.ceo} onClick=${() => openCeo(cid)}><${Icon} name="chat" size=${13} />Talk to the CEO</button></div>`}
    </header>
    <div class="pos-dscroll"><div class="pos-sec">
      <h3 class="pos-h3">Folders</h3>
      <ul class="pos-list">${(co.folders || []).map((f) => html`<li key=${f} class="pos-li"><span class="pos-li-l1"><${Icon} name="folder" size=${14} /><span class="pos-li-title">${baseName(f)}</span></span><span class="pos-li-sub mono truncate" title=${f}>${f}</span></li>`)}</ul>
      <h3 class="pos-h3">Reports to the CEO</h3>
      ${tops.length ? html`<ul class="pos-list">${tops.map((r) => { const st = liveStatus(r); return html`<li key=${r.id} class="pos-li">
          <span class="pos-li-l1"><span class=${cx('dot', dotClass(st))} aria-hidden="true"></span><${Link} onClick=${() => select(r.id)}>${r.name}<//><span class="pos-dim">${statusText(st)}</span></span>
          <span class="pos-li-sub truncate">${r.remit}</span></li>`; })}</ul>`
        : html`<p class="pos-empty">None yet. In a CEO chat, say what you want covered; the CEO proposes a position for you to approve.</p>`}
    </div></div>
  </div>`;
}

// ---------------------------------------------------------------- the detail
function RunMenu({ cid, id, duties, paused }) {
  const m = useMenu();
  const list = (duties || []).filter((x) => x.enabled);
  if (!list.length) return null;
  return html`<span class="pos-menu-wrap">
    <button type="button" ref=${m.anchor} class="btn btn-sm" aria-haspopup="menu" aria-expanded=${m.open ? 'true' : 'false'} disabled=${paused} title=${paused ? 'Paused: resume to run a duty' : ''} onClick=${m.toggle}>
      <${Icon} name="play" size=${12} />Run duty<${Icon} name="chevron-down" size=${12} /></button>
    ${m.open && html`<${Menu} m=${m} align="end" width=${240}>${list.map((x) => html`<button type="button" key=${x.id} role="menuitem" class="menu-item" onClick=${() => runDuty(cid, id, x.id)}>
      <span><span>${x.title}</span><span class="menu-desc">${triggerWords(x.trigger)}</span></span></button>`)}<//>`}
  </span>`;
}

export function Detail({ cid, id, node, names, narrow, onBack }) {
  const k = pkey(cid, id);
  const s = positions.value[k];
  const tab = detailTab.value;
  const d = s?.data;
  const p = d?.position;
  const st = liveStatus(node || p);
  const name = node?.name || p?.name || id;
  const paused = p?.status === 'paused' || st === 'paused';
  useEffect(() => { if (!s) loadPosition(cid, id); }, [k]);
  // narrow layouts swap the tree for this screen: focus its heading so a screen reader (and the next Tab) starts here
  const headRef = useRef(null);
  useEffect(() => { if (narrow) headRef.current?.focus({ preventScroll: true }); }, [k, narrow]);
  const head = html`<header class="pos-dhead">
    ${narrow && html`<button type="button" class="icon-btn pos-back" aria-label="Back to the team" onClick=${onBack}><${Icon} name="chevron-left" size=${18} /></button>`}
    <div class="pos-dtitle">
      <h2 class="pos-dname" ref=${headRef} tabindex="-1"><span class=${cx('dot', dotClass(st), st === 'working' && 'live')} aria-hidden="true"></span><span class="truncate">${name}</span>${paused && html`<span class="chip pos-chip pos-paused">Paused</span>`}</h2>
      <p class="pos-dsub">${statusText(st)}${node?.parent !== undefined || p ? html`<span class="pos-dim"> · reports to ${(node?.parent ?? p?.parent) ? names[node?.parent ?? p?.parent] || (node?.parent ?? p?.parent) : 'the CEO'}</span>` : ''}</p>
    </div>
    ${p && html`<div class="pos-dactions">
      <button type="button" class="btn btn-sm" disabled=${!!busy.value[`open:${id}`]} onClick=${() => openChat(cid, id)}><${Icon} name="chat" size=${13} />Open chat</button>
      <${RunMenu} cid=${cid} id=${id} duties=${d.duties} paused=${paused} />
      <button type="button" class="btn btn-sm btn-ghost" disabled=${!!busy.value[`pause:${id}`]} onClick=${() => setPaused(cid, id, !paused)}
        title=${paused ? 'Resume: duties run and questions are answered again' : 'Pause: no duties, and questions are refused with "paused". You can still chat.'}>
        <${Icon} name=${paused ? 'play' : 'pause'} size=${12} />${paused ? 'Resume' : 'Pause'}</button>
    </div>`}
  </header>`;
  let body;
  if (s?.error && !d) body = html`<div class="pos-sec"><${Notice} tone="danger" icon="x-circle" action=${html`<button type="button" class="btn btn-sm" onClick=${() => loadPosition(cid, id)}>Try again</button>`}>Could not read ${name}: ${s.error}<//></div>`;
  else if (!d) body = html`<div class="pos-sec"><${Loading} text=${`Opening ${name}…`} /></div>`;
  else if (tab === 'brief') body = html`<${Notes} key=${`${k}/brief`} cid=${cid} id=${id} file="brief" name=${name} />`;
  else if (tab === 'notebook') body = html`<${Notes} key=${`${k}/notebook`} cid=${cid} id=${id} file="notebook" name=${name} />`;
  else if (tab === 'powers') body = html`<${Powers} cid=${cid} d=${d} names=${names} />`;
  else if (tab === 'duties') body = html`<${Duties} cid=${cid} id=${id} d=${d} />`;
  else if (tab === 'chats') body = html`<${Chats} cid=${cid} id=${id} d=${d} />`;
  else if (tab === 'crosstalk') body = html`<${Crosstalk} cid=${cid} id=${id} names=${names} />`;
  else body = html`<${Overview} cid=${cid} id=${id} node=${node} d=${d} names=${names} />`;
  return html`<div class="pos-detail" data-position=${id}>
    ${head}
    <div class="seg pos-tabs" role="tablist" aria-label=${`${name} sections`}>
      ${TABS.map(([t, label]) => html`<button type="button" key=${t} role="tab" id=${`pos-tab-${t}`} class=${tab === t ? 'on' : ''} aria-selected=${tab === t ? 'true' : 'false'}
        onClick=${() => { detailTab.value = t; }}>${label}${t === 'overview' && (node?.pending?.requests || 0) + (node?.pending?.proposals || 0) > 0 ? html`<span class="pos-tab-dot" aria-label="needs you"></span>` : ''}</button>`)}
    </div>
    <div class="pos-dscroll" role="tabpanel" aria-labelledby=${`pos-tab-${tab}`}>${body}</div>
  </div>`;
}
