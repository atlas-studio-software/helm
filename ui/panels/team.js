// Owner: lane team-panel. The right sidebar's Team panel (Positions; spec docs/POSITIONS.md 10): the current company's
// org tree, one line a row, so any position is one click away from a session.
//   Top: the company (a switcher only with more than one), its counts ("2 need you · 1 working") and a button to the
//   full Team view.
//   Tree: the CEO row (a click opens a CEO chat, as the Team view's "Talk to the CEO" does), then each department as a
//   header ("Legal · headed by General Counsel") with its head and staff nested under it, then the positions in no
//   department. Each row: chevron, status dot, name, Paused, the counts that need you (access requests, proposals).
//   A click (Enter) opens the Team view on that position; the row's chat button (Shift+Enter) opens its chat. The
//   active session's row (its position chat, or the CEO row for a CEO chat) is highlighted.
// Nothing here is a second copy: data, events, the company, open/closed rows and the actions are the Team view's
// (ui/positions/state.js); the rows are its tree (ui/positions/tree.js, compact); the rules ui/lib/positions-model.js.
// Off, no company, a refused team folder, an error: one short state, never made-up rows.
// Phone: the inspector is a sheet over the session; anything that leaves the panel closes the sheet first.
import { useEffect } from 'preact/hooks';
import { html, Icon, cx, Empty, Loading, ErrorState } from './util.js';
import { activeSession } from '../lib/store.js';
import { go, sheetOpen, isPhone } from '../shell/state.js';
import { companyCounts, countsText, CEO } from '../lib/positions-model.js';
import {
  teamList, listError, companyId, companies, proposed,
  loadList, loadCompany, ensureEvents, setCompany, select, openCeo, openChat,
} from '../positions/state.js';
import { Tree } from '../positions/tree.js';

const closeSheet = () => { if (sheetOpen.value) sheetOpen.value = false; };

// Settings > Team: open Settings and bring the Team section (settings.js: <section id="set-team">) into view
function openTeamSettings() {
  closeSheet();
  go('settings');
  setTimeout(() => { try { document.getElementById?.('set-team')?.scrollIntoView({ block: 'start' }); } catch { /* not there */ } }, 60);
}
function openTeam() { closeSheet(); go('team'); }

// a position: the Team view on it (its selection, its branch opened, its detail screen on narrow layouts);
// the CEO row: a CEO chat, the way "Talk to the CEO" opens one
export function openRow(cid, id) {
  closeSheet();
  if (id === CEO) { openCeo(cid); return; }
  select(id);
  go('team');
}
export function chatRow(cid, id) {
  closeSheet();
  if (id === CEO) openCeo(cid); else openChat(cid, id);
}

function Counts({ c }) {
  if (c.needsYou > 0 || c.working > 0) {
    return html`<span class="pn-team-counts tnum">
      ${c.needsYou > 0 && html`<span class="pn-team-count warn"><span class="dot waiting" aria-hidden="true"></span>${c.needsYou} need${c.needsYou === 1 ? 's' : ''} you</span>`}
      ${c.working > 0 && html`<span class="pn-team-count"><span class="dot working" aria-hidden="true"></span>${c.working} working</span>`}
    </span>`;
  }
  return html`<span class="pn-team-counts">${countsText(c)}</span>`;
}

export function TeamPanel() {
  // the shell reads team.list at start and keeps it fresh; mounting re-reads it quietly (team.list reads files only)
  useEffect(() => { ensureEvents(); loadList({ quiet: true }); }, []);
  const list = teamList.value;
  const cos = list?.companies || [];
  const cid = companyId.value;
  const co = cos.find((c) => c.id === cid) || null;
  const cs = cid ? companies.value[cid] : null;
  const data = cs?.data;
  const phone = !!isPhone.value;

  let body;
  if (listError.value && !list) {
    body = html`<${ErrorState} title="Could not read the team" error=${listError.value} onRetry=${() => loadList()} />`;
  } else if (!list) {
    body = html`<${Loading} label="Reading the team…" />`;
  } else if (!list.enabled) {
    body = html`<${Empty} icon="users" title="Team is off">
      Positions are AI staff for a company, under the CEO. Switch them on in Settings > Team > Positions.
      <div class="pn-team-act"><button type="button" class="btn btn-sm" data-act="team-settings" onClick=${openTeamSettings}><${Icon} name="settings" size=${14} />Open Settings</button></div>
    <//>`;
  } else if (list.rootProblem) {
    body = html`<${Empty} icon="alert" title="Can't use the team folder">
      <span class="mono">${list.root || ''}</span> ${list.rootProblem}
      <div class="pn-team-act"><button type="button" class="btn btn-sm" data-act="team-settings" onClick=${openTeamSettings}><${Icon} name="settings" size=${14} />Open Settings</button></div>
    <//>`;
  } else if (!cos.length) {
    const waiting = (proposed.value?.list || []).some((p) => p.action === 'company');
    body = html`<${Empty} icon="users" title="No company yet">
      ${waiting ? 'A proposed company waits for your approval in the Team view.'
        : 'In a chat inside your company\'s folders, ask Claude to propose a company. Approve the card and that chat becomes its CEO.'}
      ${waiting && html`<div class="pn-team-act"><button type="button" class="btn btn-sm" data-act="team-open" onClick=${openTeam}><${Icon} name="users" size=${14} />Open Team</button></div>`}
    <//>`;
  } else if (cs?.error && !data) {
    body = html`<${ErrorState} title="Could not read this company" error=${cs.error} onRetry=${() => loadCompany(cid)} />`;
  } else if (!data) {
    body = html`<${Loading} label="Reading the org tree…" />`;
  } else {
    // the highlighted row is the active session's place in this company: a position's chat (Session.position), or a
    // CEO chat (Session.team) on the CEO row
    const s = activeSession.value;
    const current = s?.position?.company === cid && s.position.id ? s.position.id : s?.team?.company === cid ? CEO : null;
    body = html`<div class="pn-team-tree">
      <${Tree} cid=${cid} data=${data} phone=${phone} compact=${true} current=${current}
        onSelect=${(id) => openRow(cid, id)} onChat=${(id) => chatRow(cid, id)} />
    </div>`;
  }

  const head = list?.enabled && !list.rootProblem && cos.length > 0 && cid;
  return html`<div class=${cx('pn pn-team', phone && 'is-phone')}>
    ${head && html`<div class="pn-bar pn-team-bar">
      ${cos.length > 1
        ? html`<select class="select pn-team-co" aria-label="Company" data-act="team-company" value=${cid} onChange=${(e) => setCompany(e.currentTarget.value)}>
            ${cos.map((c) => html`<option key=${c.id} value=${c.id}>${c.name}${c.needsYou > 0 ? ` · ${c.needsYou} need${c.needsYou === 1 ? 's' : ''} you` : ''}</option>`)}
          </select>`
        : html`<span class="pn-strong pn-team-name truncate" title=${co?.name || ''}>${co?.name || cid}</span>`}
      <span class="pn-bar-grow">${data && html`<${Counts} c=${companyCounts(data.tree, co?.needsYou)} />`}</span>
      <button type="button" class="icon-btn pn-team-open" data-act="team-open" title="Open the Team view (Ctrl+Shift+T)" aria-label="Open the Team view" onClick=${openTeam}>
        <${Icon} name="users" size=${15} />
      </button>
    </div>`}
    ${body}
  </div>`;
}
