// Team view state (Positions, lane T6): what team.* returned, what is selected and open, and the actions.
// Data comes over team.* RPCs (docs/PROTOCOL.md "Positions"); team.updated / team.ask.updated /
// team.proposal.updated / team.inbox.appended keep it fresh. Pure rules live in ui/lib/positions-model.js.
// The client is the app transport; tools/positions-preview.js swaps in the mock with setTeamClient().
import { signal } from '@preact/signals';
import { rpc as wsRpc, on as wsOn } from '../lib/transport.js';
import { toast } from '../lib/store.js';
import { openSession } from '../shell/state.js';
import { saveDraft } from '../composer/util.js';
import { foldCrosstalk, revealOpen, CEO } from '../lib/positions-model.js';

let client = { rpc: wsRpc, on: wsOn };
let unsubs = [];
export function setTeamClient(c) { for (const u of unsubs) u(); unsubs = []; client = c; }
export const teamRpc = (method, params) => client.rpc(method, params);

const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode / full */ } },
};
const msg = (e) => (e && e.message) || String(e || 'Unknown error');

// ---------------------------------------------------------------- signals
export const teamList = signal(null);        // team.list result
export const listError = signal(null);
export const companyId = signal(ls.get('helm.team.company', null));
export const companies = signal({});         // { [company]: { data?, error?, loading } }   data = team.get result
export const selected = signal({});          // { [company]: position id | CEO | null }
export const opens = signal({});             // { [company]: { [id]: false } } collapsed rows (helm.team.open.<company>)
export const screen = signal('tree');        // narrow layouts: 'tree' | 'detail'
export const detailTab = signal('overview');
export const positions = signal({});         // { 'company/id': { data?, error?, loading } }   data = team.position result
export const crosstalk = signal({});         // { 'company/id' | 'company/*': { entries?, error?, loading } }
export const inbox = signal({});             // { [company]: { entries?, error?, loading } }
export const sections = signal(ls.get('helm.team.sections', {}));   // { proposals, inbox, crosstalk }: open?
export const busy = signal({});              // { [key]: true } while an action runs (buttons disable)
export const proposed = signal({ list: [], error: null });   // open proposals of companies not created yet
export const proposedSel = signal(null);     // the proposed company (its card id) shown instead of a company

const put = (sig, key, val) => { sig.value = { ...sig.value, [key]: val }; };
const merge = (sig, key, val) => { sig.value = { ...sig.value, [key]: { ...(sig.value[key] || {}), ...val } }; };
export const pkey = (cid, id) => `${cid}/${id || '*'}`;

// ---------------------------------------------------------------- loading
let listSeq = 0;
export async function loadList({ quiet = false } = {}) {
  const seq = ++listSeq;
  if (!quiet) listError.value = null;
  try {
    const r = await client.rpc('team.list', {});
    if (seq !== listSeq) return;
    teamList.value = r;
    listError.value = null;
    const ids = (r?.companies || []).map((c) => c.id);
    if (!ids.includes(companyId.value)) companyId.value = ids[0] || null;
    if (companyId.value && !companies.value[companyId.value]?.data) loadCompany(companyId.value);
    // a proposed company (team.list proposals) brings its position proposals along: they wait for the company
    if ((r?.proposals || []).length || proposed.value.list.length) loadProposed({ ids });
    else if (proposedSel.value) proposedSel.value = null;
  } catch (e) { if (seq === listSeq) listError.value = msg(e); }
}
// Open proposals for companies that do not exist yet (an import leaves a company card + its position cards; a
// position card for that company cannot be approved before the company is). -> proposed.value = { list, error }
let propSeq = 0;
export async function loadProposed({ ids = (teamList.value?.companies || []).map((c) => c.id) } = {}) {
  const seq = ++propSeq;
  try {
    const r = await client.rpc('team.proposals', { status: 'open' });
    if (seq !== propSeq) return;
    const list = (r?.proposals || []).filter((p) => p && (p.company == null || !ids.includes(p.company)));
    proposed.value = { list, error: null };
    if (proposedSel.value && !list.some((p) => p.id === proposedSel.value)) proposedSel.value = null;
  } catch (e) { if (seq === propSeq) proposed.value = { list: proposed.value.list, error: msg(e) }; }
}
export async function loadCompany(cid, { quiet = false } = {}) {
  if (!cid) return;
  if (!quiet) merge(companies, cid, { loading: true, error: null });
  try {
    const data = await client.rpc('team.get', { company: cid });
    merge(companies, cid, { data, loading: false, error: null });
    if (!opens.value[cid]) put(opens, cid, ls.get(`helm.team.open.${cid}`, {}));
  } catch (e) { merge(companies, cid, { loading: false, error: msg(e) }); }
}
export async function loadPosition(cid, id, { quiet = false } = {}) {
  if (!cid || !id || id === CEO) return;
  const k = pkey(cid, id);
  if (!quiet) merge(positions, k, { loading: true, error: null });
  try { merge(positions, k, { data: await client.rpc('team.position', { company: cid, id }), loading: false, error: null }); }
  catch (e) { merge(positions, k, { loading: false, error: msg(e) }); }
}
export async function loadCrosstalk(cid, id = null, { quiet = false } = {}) {
  const k = pkey(cid, id);
  if (!quiet) merge(crosstalk, k, { loading: true, error: null });
  try {
    const r = await client.rpc('team.crosstalk', { company: cid, ...(id ? { position: id } : {}), limit: 200 });
    merge(crosstalk, k, { entries: foldCrosstalk(r?.entries || []), loading: false, error: null });
  } catch (e) { merge(crosstalk, k, { loading: false, error: msg(e) }); }
}
export async function loadInbox(cid, { quiet = false } = {}) {
  if (!quiet) merge(inbox, cid, { loading: true, error: null });
  try { merge(inbox, cid, { entries: (await client.rpc('team.inbox', { company: cid }))?.entries || [], loading: false, error: null }); }
  catch (e) { merge(inbox, cid, { loading: false, error: msg(e) }); }
}

// ---------------------------------------------------------------- live updates
const timers = new Map();
const later = (key, fn, ms = 150) => { clearTimeout(timers.get(key)); timers.set(key, setTimeout(() => { timers.delete(key); fn(); }, ms)); };
export function refreshCompany(cid) {
  loadList({ quiet: true });
  if (!cid) return;
  if (companies.value[cid]) loadCompany(cid, { quiet: true });
  for (const k of Object.keys(positions.value)) if (k.startsWith(`${cid}/`)) loadPosition(cid, k.slice(cid.length + 1), { quiet: true });
  for (const k of Object.keys(crosstalk.value)) if (k.startsWith(`${cid}/`)) { const id = k.slice(cid.length + 1); loadCrosstalk(cid, id === '*' ? null : id, { quiet: true }); }
  if (inbox.value[cid]) loadInbox(cid, { quiet: true });
}
// Subscribe once (the view calls this on mount; a second call is a no-op until setTeamClient swaps the client).
export function ensureEvents() {
  if (unsubs.length) return;
  unsubs = [
    client.on('team.updated', (d) => later(`u:${d?.company}`, () => refreshCompany(d?.company))),
    // an access card opened or closed / a ticket moved: badges, needs-you counts, Waiting dots and busy lines change
    client.on('team.access.updated', (d) => later(`u:${d?.company}`, () => refreshCompany(d?.company))),
    client.on('team.ask.updated', (d) => later(d?.company ? `u:${d.company}` : 'ask', () => {
      if (d?.company) refreshCompany(d.company);
      else for (const k of Object.keys(crosstalk.value)) { const [cid, id] = k.split('/'); loadCrosstalk(cid, id === '*' ? null : id, { quiet: true }); }
    }, 300)),
    // the socket came back: events were missed while it was down, so re-read everything already loaded
    client.on('transport.open', () => later('reconnect', () => {
      const ids = new Set([...Object.keys(companies.value), ...Object.keys(inbox.value)]);
      for (const k of [...Object.keys(positions.value), ...Object.keys(crosstalk.value)]) ids.add(k.split('/')[0]);
      if (!ids.size) loadList({ quiet: true });
      for (const cid of ids) refreshCompany(cid);
    }, 300)),
    client.on('team.proposal.updated', (d) => {
      if (d?.proposal && (d.company == null || !companies.value[d.company])) later('proposed', () => loadProposed(), 150);
      const cur = companies.value[d?.company]?.data;
      if (!cur || !d.proposal) return;
      const list = (cur.proposals || []).filter((p) => p.id !== d.proposal.id);
      merge(companies, d.company, { data: { ...cur, proposals: [d.proposal, ...list] } });
    }),
    client.on('team.inbox.appended', (d) => {
      const cur = inbox.value[d?.company];
      if (cur?.entries && d.entry) merge(inbox, d.company, { entries: [d.entry, ...cur.entries.filter((e) => e.id !== d.entry.id)] });
      loadList({ quiet: true });
    }),
  ].filter((u) => typeof u === 'function');
}

// ---------------------------------------------------------------- selection + tree
export function setCompany(cid) {
  if (cid) proposedSel.value = null;
  if (!cid || cid === companyId.value) return;
  companyId.value = cid; ls.set('helm.team.company', cid);
  screen.value = 'tree';
  if (!companies.value[cid]?.data) loadCompany(cid);
}
export function select(id, { show = true } = {}) {
  const cid = companyId.value;
  if (!cid) return;
  put(selected, cid, id);
  if (id && id !== CEO) {
    const tree = companies.value[cid]?.data?.tree;
    const next = revealOpen(tree, opens.value[cid], id);
    if (next !== opens.value[cid]) setOpenMap(cid, next);
    if (!positions.value[pkey(cid, id)]?.data) loadPosition(cid, id); else loadPosition(cid, id, { quiet: true });
  }
  if (show) screen.value = 'detail';
}
export function back() { screen.value = 'tree'; }
function setOpenMap(cid, map) { put(opens, cid, map); ls.set(`helm.team.open.${cid}`, map); }
export function setOpen(id, open) {
  const cid = companyId.value;
  const cur = { ...(opens.value[cid] || {}) };
  if (open) delete cur[id]; else cur[id] = false;
  setOpenMap(cid, cur);
}
export function toggleSection(k) { const next = { ...sections.value, [k]: !sections.value[k] }; sections.value = next; ls.set('helm.team.sections', next); }

// ---------------------------------------------------------------- actions
// Each runs once at a time per key (its buttons disable), and says what failed in a toast.
async function act(key, title, fn) {
  if (busy.value[key]) return undefined;
  put(busy, key, true);
  try { return await fn(); }
  catch (e) { toast({ title, error: e, kind: 'error' }); return undefined; }
  finally { const b = { ...busy.value }; delete b[key]; busy.value = b; }
}
export const openChat = (cid, id) => act(`open:${id}`, 'Could not open the chat', async () => { const r = await client.rpc('team.open', { company: cid, id }); if (r?.sessionId) openSession(r.sessionId); });
export const openCeo = (cid) => act('ceo', 'Could not open a CEO chat', async () => { const r = await client.rpc('team.openCeo', { company: cid }); if (r?.sessionId) openSession(r.sessionId); });
export const openFolder = (cid, id) => act(`folder:${id || ''}`, 'Could not open the folder', () => client.rpc('team.openFolder', { company: cid, ...(id ? { id } : {}) }));
export const openOld = (sessionId) => { if (sessionId) openSession(sessionId); };
// "Discuss a change with the CEO": a CEO chat with the sentence already in its composer (spec 10.2 Powers)
export const discussWithCeo = (cid, text) => act('ceo', 'Could not open a CEO chat', async () => {
  const r = await client.rpc('team.openCeo', { company: cid });
  if (!r?.sessionId) return;
  saveDraft(r.sessionId, text);
  openSession(r.sessionId);
});
// Discuss a proposal whose company does not exist yet (no CEO chat to open): a new chat in its folder, the
// sentence already in the composer
export const discussIn = (folder, text) => act(`discuss:${folder}`, 'Could not open a chat', async () => {
  const r = await client.rpc('sessions.create', { cwd: folder });
  const id = r?.id || r?.sessionId;
  if (!id) return;
  saveDraft(id, text);
  openSession(id);
});
export const setPaused =(cid, id, paused) => act(`pause:${id}`, paused ? 'Could not pause' : 'Could not resume', async () => {
  await client.rpc('team.pause', { company: cid, id, paused });
  await Promise.all([loadPosition(cid, id, { quiet: true }), loadCompany(cid, { quiet: true })]);
});
export const runDuty = (cid, id, duty) => act(`run:${id}/${duty}`, 'Could not run the duty', async () => {
  const r = await client.rpc('team.duty.run', { company: cid, id, duty });
  await loadPosition(cid, id, { quiet: true });
  return r;
});
export const toggleDuty = (cid, id, duty, enabled) => act(`duty:${id}/${duty}`, 'Could not change the duty', async () => {
  await client.rpc('team.duty.toggle', { company: cid, id, duty, enabled });
  await Promise.all([loadPosition(cid, id, { quiet: true }), loadCompany(cid, { quiet: true })]);
});
export const decide = (cid, proposal, decision, note) => act(`decide:${proposal}`, decision === 'approve' ? 'Could not approve' : 'Could not decline', async () => {
  const r = await client.rpc('team.decide', { proposal, decision, ...(note ? { note } : {}) });
  if (r && r.ok === false) throw new Error(r.error || 'The proposal was not changed');
  await Promise.all([cid ? loadCompany(cid, { quiet: true }) : null, loadList({ quiet: true })]);
  // an approved company card: open the new company (its position proposals are waiting there)
  const made = r?.created?.company;
  if (made && !r.created.id) { proposedSel.value = null; await loadList({ quiet: true }); setCompany(made); }
  return r;
});
export function showProposed(id) { proposedSel.value = id || null; screen.value = 'tree'; }
export const dismiss = (cid, ids) => act(`dismiss:${ids.join(',')}`, 'Could not dismiss', async () => {
  const cur = inbox.value[cid];
  if (cur?.entries) merge(inbox, cid, { entries: cur.entries.map((e) => (ids.includes(e.id) ? { ...e, dismissedAt: new Date().toISOString() } : e)) });
  await client.rpc('team.inbox.dismiss', { company: cid, ids });
  loadList({ quiet: true });
});
