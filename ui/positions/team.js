// Team view (Positions, lane T6; spec docs/POSITIONS.md 10.1-10.2): a company's AI staff as an org tree under
// the CEO. Modelled on the Deck: a full view (view === 'team', wired by the shell lane T10) inside the main
// panel on desktop and the phone screen on the phone.
//   Header: title, counts ("2 need you · 1 working"), company switcher (.seg, hidden with one company),
//           [Talk to the CEO], [Open folder] (desktop only).
//   Wide (the view >= 1000 px, i.e. a ~1100 px window): tree left (min 320 px) + the selected detail right.
//   Narrower and phone: the tree full width; a row opens its detail as its own screen with a back button.
//   Under the tree: Proposals, Inbox and Cross-talk (collapsed headers, remembered).
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { isPhone, go } from '../shell/state.js';
import { cx, useTick } from '../shell/util.js';
import { companyCounts, countsText, splitProposals, liveInbox, countCrosstalk, agoShort, baseName, liveStatus, needsYou, proposalStatus, CEO } from '../lib/positions-model.js';
import {
  teamList, listError, companyId, companies, selected, screen, sections, crosstalk, inbox, busy, pkey,
  loadList, loadCompany, loadCrosstalk, loadInbox, ensureEvents, setCompany, select, back, toggleSection, openCeo, openFolder, dismiss,
  proposed, proposedSel, loadProposed, showProposed,
} from './state.js';
import { Tree } from './tree.js';
import { Detail, CeoDetail, ProposalCard, CrosstalkList } from './detail.js';

const WIDE = 1000;   // view width (px) for two panes
const ts = (v) => (typeof v === 'number' ? v : Date.parse(v) || 0);

// open company cards (companies not created yet), oldest first
const pendingCompanies = () => proposed.value.list.filter((p) => p.action === 'company' && proposalStatus(p) === 'open').sort((a, b) => ts(a.at) - ts(b.at));

// A proposed company (an import, or a chat's proposal) and the position proposals waiting for it: the full cards,
// Approve / Decline / Discuss. The position cards cannot be approved before the company is (the engine refuses),
// so their Approve waits; once the company is approved it opens, and they are its Proposals.
function Proposed({ only = null }) {
  const all = proposed.value.list;
  const cos = pendingCompanies().filter((p) => !only || p.id === only);
  const coIds = new Set(cos.map((p) => p.draft?.id || p.target));
  const known = new Set(pendingCompanies().map((p) => p.draft?.id || p.target));
  const names = Object.fromEntries(all.filter((p) => p.action === 'create').map((p) => [p.target || p.draft?.id, p.draft?.name || p.target]));
  // position cards for a company nobody proposed (its card was declined): they can only be declined now
  const orphans = only ? [] : all.filter((p) => p.action !== 'company' && proposalStatus(p) === 'open' && p.company && !known.has(p.company));
  return html`<div class="pos-proposed">
    ${proposed.value.error && html`<div class="cc-health danger pos-notice" role="alert"><${Icon} name="x-circle" size=${14} /><span>Could not read the proposals: ${proposed.value.error}</span><button type="button" class="btn btn-sm" onClick=${() => loadProposed()}>Try again</button></div>`}
    ${cos.map((c) => {
      const id = c.draft?.id || c.target;
      const kids = all.filter((p) => p.action !== 'company' && p.company === id && proposalStatus(p) === 'open').sort((a, b) => ts(a.at) - ts(b.at));
      const name = c.draft?.name || id;
      return html`<section key=${c.id} class="pos-proposed-co" aria-label=${`Proposed company ${name}`}>
        <p class="pos-sublabel">New company · waits for your approval</p>
        <${ProposalCard} cid=${null} p=${c} names=${names} folder=${(c.draft?.folders || [])[0] || null} />
        ${kids.length > 0 && html`<p class="pos-sublabel">${kids.length} position proposal${kids.length === 1 ? '' : 's'} for ${name}</p>
          <p class="pos-foot pos-proposed-foot">They wait for the company. Approve ${name} first; its team then opens with these under Proposals, in this order.</p>
          ${kids.map((p) => html`<${ProposalCard} key=${p.id} cid=${null} p=${p} names=${names} waitsFor=${name} folder=${(c.draft?.folders || [])[0] || null} />`)}`}
      </section>`;
    })}
    ${orphans.length > 0 && html`<section class="pos-proposed-co" aria-label="Proposals without a company">
      <p class="pos-sublabel">Waiting for a company that was not approved</p>
      ${orphans.map((p) => html`<${ProposalCard} key=${p.id} cid=${null} p=${p} names=${names} waitsFor=${p.company} />`)}
    </section>`}
    ${!cos.length && !orphans.length && !coIds.size && html`<p class="pos-empty">No proposed company is waiting.</p>`}
  </div>`;
}

function Head({ list, cid, data, phone, wideNarrowDetail }) {
  const cos = list?.companies || [];
  const pending = pendingCompanies();
  const co = cos.find((c) => c.id === cid);
  const counts = data ? companyCounts(data.tree, co?.needsYou) : null;
  return html`<header class=${cx('pos-head', wideNarrowDetail && 'is-hidden')}>
    <div class="pos-head-text">
      <h1 class="view-title">Team</h1>
      ${counts ? html`<p class="pos-counts tnum">
          ${cos.length === 1 && html`<span class="pos-co-name">${co?.name}</span><span class="pos-sep" aria-hidden="true">·</span>`}
          ${counts.needsYou > 0 && html`<span class="pos-count warn"><span class="dot waiting" aria-hidden="true"></span>${counts.needsYou} need${counts.needsYou === 1 ? 's' : ''} you</span>`}
          ${counts.working > 0 && html`<span class="pos-count"><span class="dot working" aria-hidden="true"></span>${counts.working} working</span>`}
          ${!counts.needsYou && !counts.working && html`<span class="pos-count">${countsText(counts)}</span>`}
        </p>`
        : html`<p class="view-sub">Your AI staff for each company, under the CEO.</p>`}
    </div>
    ${cid && html`<div class="pos-head-actions">
      ${!phone && html`<button type="button" class="icon-btn" title="Open this company's team folder" aria-label="Open the team folder" disabled=${!!busy.value['folder:']} onClick=${() => openFolder(cid)}><${Icon} name="folder-open" size=${16} /></button>`}
      <button type="button" class="btn btn-sm pos-ceo-btn" disabled=${!!busy.value.ceo} onClick=${() => openCeo(cid)}><${Icon} name="chat" size=${14} />${phone ? 'Talk to CEO' : 'Talk to the CEO'}</button>
    </div>`}
    ${(cos.length > 1 || (cos.length > 0 && pending.length > 0)) && html`<div class="seg pos-companies" role="group" aria-label="Company">
      ${cos.map((c) => html`<button type="button" key=${c.id} aria-pressed=${c.id === cid && !proposedSel.value ? 'true' : 'false'} onClick=${() => setCompany(c.id)}>
        <span class="truncate">${c.name}</span>${c.needsYou > 0 && html`<span class="pos-seg-n tnum" aria-label=${`${c.needsYou} need you`}>${c.needsYou}</span>`}</button>`)}
      ${pending.map((p) => html`<button type="button" key=${p.id} class="pos-seg-proposed" aria-pressed=${proposedSel.value === p.id ? 'true' : 'false'} title=${`${p.draft?.name || p.target}: a proposed company, waiting for your approval`} onClick=${() => showProposed(p.id)}>
        <span class="truncate">${p.draft?.name || p.target}</span><span class="pos-seg-new">proposed</span></button>`)}
    </div>`}
  </header>`;
}

function Empty({ icon = 'agents', title, children, action }) {
  return html`<div class="deck-empty pos-empty-view">
    <div class="deck-empty-mark" aria-hidden="true"><${Icon} name=${icon} size=${26} stroke=${1.4} /></div>
    <h2 class="deck-empty-title">${title}</h2>
    <p class="deck-empty-sub">${children}</p>
    ${action && html`<div class="deck-empty-actions">${action}</div>`}
  </div>`;
}

function Section({ k, title, count, warn, children }) {
  const open = !!sections.value[k];
  return html`<section class=${cx('pos-csec', open && 'open')} aria-label=${title}>
    <button type="button" class="pos-csec-head" aria-expanded=${open ? 'true' : 'false'} onClick=${() => toggleSection(k)}>
      <${Icon} name="chevron-right" size=${14} class=${cx('pos-csec-chev', open && 'open')} />
      <span class="pos-csec-title">${title}</span>
      ${warn > 0 && html`<span class="chip warn pos-chip">${warn} open</span>`}
      <span class="pos-csec-n tnum">${count}</span>
    </button>
    ${open && html`<div class="pos-csec-body">${children}</div>`}
  </section>`;
}

function CompanySections({ cid, data, names }) {
  const props = splitProposals(data?.proposals);
  const ib = inbox.value[cid];
  const ct = crosstalk.value[pkey(cid, null)];
  const live = liveInbox(ib?.entries);
  // inbox + cross-talk load the first time their section opens (or at once when it was left open)
  useEffect(() => { if (sections.value.inbox && !ib) loadInbox(cid); }, [cid, sections.value.inbox]);
  useEffect(() => { if (sections.value.crosstalk && !ct) loadCrosstalk(cid, null); }, [cid, sections.value.crosstalk]);
  useEffect(() => { if (!ib) loadInbox(cid, { quiet: true }); }, [cid]);   // for the header count
  const needs = live.filter((e) => e.needsOwen).length;
  const sorted = live.slice().sort((a, b) => ts(b.at) - ts(a.at));
  return html`<div class="pos-csecs">
    <${Section} k="proposals" title="Proposals" count=${props.open.length + props.decided.length} warn=${props.open.length}>
      ${props.open.length + props.decided.length === 0 ? html`<p class="pos-empty">No proposals yet. The CEO or a manager proposes new positions and changes; each one waits here for your Approve.</p>`
        : html`${props.open.map((p) => html`<${ProposalCard} key=${p.id} cid=${cid} p=${p} names=${names} />`)}
          ${props.decided.length > 0 && html`<p class="pos-sublabel">Decided</p>${props.decided.slice(0, 20).map((p) => html`<${ProposalCard} key=${p.id} cid=${cid} p=${p} names=${names} />`)}`}`}
    <//>
    <${Section} k="inbox" title="Inbox" count=${live.length} warn=${needs}>
      ${ib?.error && !ib.entries ? html`<div class="cc-health danger pos-notice" role="alert"><${Icon} name="x-circle" size=${14} /><span>Could not read the inbox: ${ib.error}</span><button type="button" class="btn btn-sm" onClick=${() => loadInbox(cid)}>Try again</button></div>`
        : !ib?.entries ? html`<div class="state-note pos-state"><span class="spinner"></span>Reading the inbox…</div>`
        : !sorted.length ? html`<p class="pos-empty">Nothing here. Duty reports, flags and created or retired notices land here.</p>`
        : html`<ul class="pos-list">${sorted.map((e) => html`<li key=${e.id} class=${cx('pos-li pos-inbox', e.needsOwen && 'needs')}>
            <span class="pos-li-l1">
              <${Icon} name=${e.kind === 'duty-report' ? 'file-text' : e.kind === 'proposal' ? 'file-plus' : 'bell'} size=${14} />
              <span class="pos-li-title truncate">${e.title}</span>
              <span class="pos-ago tnum">${agoShort(ts(e.at))}</span>
            </span>
            <span class="pos-li-sub">${names[e.position] || e.position}${e.needsOwen ? html` · <span class="pos-needs-word">needs you</span>` : ''}</span>
            ${e.text && html`<p class="pos-inbox-text">${e.text}</p>`}
            <span class="pos-li-foot">
              ${(e.files || []).map((f) => html`<span key=${f} class="chip mono pos-chip" title=${f}><span class="truncate">${baseName(f)}</span></span>`)}
              <span class="grow"></span>
              <button type="button" class="btn btn-sm btn-ghost" disabled=${!!busy.value[`dismiss:${e.id}`]} onClick=${() => dismiss(cid, [e.id])}>Dismiss</button>
            </span>
          </li>`)}</ul>`}
    <//>
    <${Section} k="crosstalk" title="Cross-talk" count=${ct?.entries ? countCrosstalk(ct.entries) : ''}>
      ${ct?.error && !ct.entries ? html`<div class="cc-health danger pos-notice" role="alert"><${Icon} name="x-circle" size=${14} /><span>Could not read the log: ${ct.error}</span><button type="button" class="btn btn-sm" onClick=${() => loadCrosstalk(cid, null)}>Try again</button></div>`
        : !ct?.entries ? html`<div class="state-note pos-state"><span class="spinner"></span>Reading the log…</div>`
        : html`<${CrosstalkList} entries=${ct.entries} names=${names} empty="No questions between positions yet. Every ask, at every level, is logged here." />`}
    <//>
  </div>`;
}

// first position that needs you, else the first working one, else the CEO row (wide layout opens on something)
function pickDefault(tree) {
  const rows = tree || [];
  return rows.find((r) => needsYou(r) > 0)?.id || rows.find((r) => liveStatus(r) === 'working')?.id || CEO;
}

export function TeamView() {
  useTick(30000);
  const root = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => { ensureEvents(); loadList(); }, []);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return undefined;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const phone = isPhone.value;
  const wide = !phone && width >= WIDE;
  const list = teamList.value;
  const cid = companyId.value;
  const cs = cid ? companies.value[cid] : null;
  const data = cs?.data;
  const names = Object.fromEntries((data?.tree || []).map((r) => [r.id, r.name]));
  const raw = cid ? selected.value[cid] : null;
  // a selection that left the tree (retired, or another company's) counts as none
  const sel = raw === CEO || (raw && (data?.tree || []).some((r) => r.id === raw)) ? raw : null;
  // wide: never an empty right pane
  useEffect(() => { if (wide && data && !sel) select(pickDefault(data.tree), { show: false }); }, [wide, !!data, cid, sel]);
  const showingProposed = !!proposedSel.value && pendingCompanies().some((p) => p.id === proposedSel.value);
  const inDetail = !wide && screen.value === 'detail' && !!sel && !showingProposed;

  let body;
  if (listError.value && !list) {
    body = html`<div class="pos-pad"><div class="cc-health danger pos-notice" role="alert"><${Icon} name="x-circle" size=${14} /><span>Could not read the team: ${listError.value}</span><button type="button" class="btn btn-sm" onClick=${() => loadList()}>Try again</button></div></div>`;
  } else if (!list) {
    body = html`<div class="pos-pad"><div class="state-note pos-state"><span class="spinner"></span>Reading the team…</div></div>`;
  } else if (!list.enabled) {
    body = html`<${Empty} icon="agents" title="Team is off" action=${html`<button type="button" class="btn btn-primary" onClick=${() => go('settings')}><${Icon} name="settings" size=${15} />Open Settings</button>`}>
      Positions are AI staff for a company: a Legal, a Marketing, a QA, each with its own brief, notebook and powers, under the CEO (your normal chats in the company's folders). Turn it on in Settings > Team.<//>`;
  } else if (list.rootProblem) {
    body = html`<div class="pos-pad"><div class="cc-health danger pos-notice" role="alert"><${Icon} name="alert" size=${14} />
      <span>Helm can't use the team folder <span class="mono">${list.root}</span>: ${list.rootProblem}</span>
      <button type="button" class="btn btn-sm" onClick=${() => go('settings')}>Settings</button></div></div>`;
  } else if (!(list.companies || []).length && (pendingCompanies().length || proposed.value.list.length)) {
    // no company yet, but one is proposed (an import, or a chat's proposal): its card and its positions' cards
    body = html`<div class="pos-scroll"><${Proposed} /></div>`;
  } else if (!(list.companies || []).length) {
    body = html`<${Empty} icon="agents" title="No company yet">
      A company is a set of folders with a team. In any Helm chat inside those folders, ask Claude to propose a company (its name and folders); you approve the card, and that chat becomes its CEO. The team's files live in <span class="mono">${list.root || 'the team folder'}</span>.<//>`;
  } else if (showingProposed) {
    body = html`<div class="pos-scroll"><${Proposed} only=${proposedSel.value} /></div>`;
  } else if (cs?.error && !data) {
    body = html`<div class="pos-pad"><div class="cc-health danger pos-notice" role="alert"><${Icon} name="x-circle" size=${14} /><span>Could not read this company: ${cs.error}</span><button type="button" class="btn btn-sm" onClick=${() => loadCompany(cid)}>Try again</button></div></div>`;
  } else if (!data) {
    body = html`<div class="pos-pad"><div class="state-note pos-state"><span class="spinner"></span>Reading the org tree…</div></div>`;
  } else {
    const node = sel && sel !== CEO ? data.tree.find((r) => r.id === sel) : null;
    const detail = sel === CEO ? html`<${CeoDetail} cid=${cid} data=${data} narrow=${!wide} onBack=${back} names=${names} />`
      : node ? html`<${Detail} key=${`${cid}/${sel}`} cid=${cid} id=${sel} node=${node} names=${names} narrow=${!wide} onBack=${back} />`
      : null;
    const treePane = html`<${Tree} cid=${cid} data=${data} phone=${phone} onTalk=${() => openCeo(cid)} /><${CompanySections} cid=${cid} data=${data} names=${names} />`;
    if (wide) {
      body = html`<div class="pos-panes">
        <div class="pos-tree-pane">${treePane}</div>
        <div class="pos-detail-pane">${detail || html`<p class="pos-empty pos-pad">Pick a position on the left.</p>`}</div>
      </div>`;
    } else if (inDetail && detail) {
      body = html`<div class="pos-detail-screen">${detail}</div>`;
    } else {
      body = html`<div class="pos-scroll">${treePane}</div>`;
    }
  }
  return html`<section ref=${root} class=${cx('view view-team pos-view', wide && 'is-wide', phone && 'is-phone', inDetail && 'in-detail')} aria-label="Team">
    <${Head} list=${list} cid=${list?.enabled && !list.rootProblem && !showingProposed ? cid : null} data=${showingProposed ? null : data} phone=${phone} wideNarrowDetail=${inDetail} />
    ${body}
  </section>`;
}
