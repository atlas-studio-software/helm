// Positions: proposals (docs/POSITIONS.md 6.1-6.5, PROTOCOL.md "Positions"): team_propose validates and shows a card,
// the owner decides on it (a click, or a typed yes in the proposing chat), and an approval writes the files.
//
//   const { createProposals, parseImport } = require('./proposals');
//   const P = createProposals({ store, runtime?, state?, emit?, notify?, sessions?, onboard?, onApplied?, clock?, log?, ownerName? (string | () => string) });
//   P.propose({ company, by, action, draft, excess? }) -> { proposal, status: 'shown', where } | { refused: true, reasons }
//   P.open(company)                                     open cards of a company (null: proposed companies)
//   P.list({ company?, status?, includeDecided? })      cards, newest first (open only unless includeDecided / status)
//   P.get(id) -> card | null
//   P.decide({ proposal, decision, note?, how, quote? }) -> { ok, created? } | { ok: false, error }
//                                                       throws { code: 'not_found' | 'refused' | 'bad_params' }
//   P.onUserMessage({ sessionId, text, origin, lastShownId }) -> null | { proposal, result }   6.3 typed approval
//   P.import(json, { by? }) -> { imported: [{ id, ref, action, target }], skipped: [{ ref, reason }] }
//   P.pendingCount(company) -> n
//   parseImport(json) -> { company, items, errors }      pure (the import tool's --dry-run)
//
// Rules:
// - Nothing here approves on its own. Only decide() (the owner's click through the RPC) and onUserMessage() (the owner's typed
//   reply, origin 'user', through mcp.js typedApproval) apply a proposal. propose() and import() only ever add OPEN cards.
// - Powers beyond the manager's are not a refusal: the card carries `excess` (tree.excess) so the owner sees what is cut.
// - An approval re-validates against the CURRENT tree. A failure leaves the card open with `error` and returns ok:false.
// - Cards live in the 'proposals' slice of team-state.json (open ones, and decided ones for 7 days). proposals.jsonl
//   gets one line per proposal and one per decision; a proposal whose company does not exist yet (action 'company',
//   or an imported create) is logged once that company is created.
'use strict';

const crypto = require('crypto');
const S = require('./schema');
const { createTree } = require('./tree');
const { typedApproval } = require('./mcp');
const { ownerWords } = require('./owner');
const { teamEvent } = require('./notice');

const ACTIONS = ['create', 'edit', 'retire', 'company'];
const KEEP_DECIDED_MS = 7 * 24 * 3600 * 1000;
const OPEN_TICKET_STATES = new Set(['queued', 'delivered', 'asked']);
const POSITION_FIELDS = ['id', 'name', 'parent', 'remit', 'scope', 'powers', 'duties', 'model', 'effort', 'repoRules'];
// status (pause) is operational (team.pause), not a proposal
const EDIT_FIELDS = ['name', 'parent', 'remit', 'scope', 'powers', 'duties', 'model', 'effort', 'repoRules'];
const NOTEBOOK_HEADINGS = (S.NOTEBOOK_SECTIONS || ['Decisions', 'Facts', 'Open items', 'Log']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const codeErr = (code, message) => Object.assign(new Error(message), { code });

// ---------- notebook ----------
// The owner's rule: a position is named by the job title that person would hold at a real company (General Counsel,
// Controller, Marketing Manager), never by a topic or department label. A name that looks like one is NOT refused:
// the card carries `nameWarning` and the proposer's tool result repeats it. Flagged: a bare department word
// ("Legal", "Finance", "Ops"), or a name joined by " & " with no role word in it ("Leads & Outreach"; "Finance &
// Operations Manager" passes).
const DEPARTMENT_LABELS = new Set(['legal', 'finance', 'marketing', 'sales', 'operations', 'ops', 'support', 'tax',
  'accounting', 'bookkeeping', 'compliance', 'privacy', 'outreach', 'growth', 'admin', 'hr', 'people', 'it', 'qa',
  'engineering', 'design', 'product', 'research', 'content', 'partnerships', 'communications', 'comms', 'security',
  'customer success', 'customer care', 'business development', 'money', 'paperwork', 'leads']);
const ROLE_WORD = /\b(manager|director|head|lead|officer|counsel|specialist|analyst|coordinator|representative|rep|engineer|accountant|controller|bookkeeper|assistant|associate|strategist|writer|copywriter|editor|designer|developer|administrator|agent|executive|consultant|advisor|adviser|clerk|chief|president|vp|scientist|architect|planner|producer|paralegal|recruiter|auditor|attorney|lawyer|marketer|buyer|technician|tester|partner|owner)\b/i;
function nameWarning(name) {
  const n = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!n) return null;
  if (!DEPARTMENT_LABELS.has(n.toLowerCase()) && !(/ & /.test(n) && !ROLE_WORD.test(n))) return null;
  return `"${n}" reads like a department or topic, not a job title. Name the position by the title that person would `
    + 'hold at a real company (e.g. General Counsel, Controller, Marketing Manager); the remit says what it covers.';
}

function hasAllHeadings(text) {
  return NOTEBOOK_HEADINGS.every((h) => new RegExp(`^##\\s+${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mi').test(text));
}
// A full notebook given with the proposal; missing headings are put back at the end (Helm keeps the four).
function fullNotebook(text, name) {
  let t = str(text).replace(/\r\n/g, '\n');
  if (!t.trim()) return null;
  if (!/^#\s/m.test(t)) t = `# ${name || 'Position'} · notebook\n${t}`;
  for (const h of NOTEBOOK_HEADINGS) {
    if (!new RegExp(`^##\\s+${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mi').test(t)) t = t.replace(/\n*$/, '\n') + `## ${h}\n`;
  }
  return t.endsWith('\n') ? t : t + '\n';
}

// ---------- diffs (edit cards) ----------
function lineDiff(a, b) {
  const A = str(a).replace(/\r\n/g, '\n').split('\n');
  const B = str(b).replace(/\r\n/g, '\n').split('\n');
  if (A.length * B.length > 4_000_000) return [...A.map((l) => `-${l}`), ...B.map((l) => `+${l}`)].join('\n');
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push(` ${A[i]}`); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push(`-${A[i++]}`);
    else out.push(`+${B[j++]}`);
  }
  while (i < n) out.push(`-${A[i++]}`);
  while (j < m) out.push(`+${B[j++]}`);
  return out.join('\n');
}
function powerEntries(p) {
  const out = [];
  if (!isObj(p)) return out;
  for (const k of ['read', 'write', 'tools']) {
    const v = p[k];
    if (Array.isArray(v)) for (const x of v) out.push(`${k}: ${x}`);
    else if (v !== undefined) out.push(`${k}: ${JSON.stringify(v)}`);
  }
  for (const k of Object.keys(p)) if (!['read', 'write', 'tools'].includes(k)) out.push(`${k}: ${JSON.stringify(p[k])}`);
  return out;
}
function setDiff(before, after) {
  const a = new Set(before), b = new Set(after);
  return { added: [...b].filter((x) => !a.has(x)), removed: [...a].filter((x) => !b.has(x)) };
}
function editDiff(cur, next, { briefBefore, briefAfter, excess }) {
  const d = {};
  if (briefAfter != null && briefBefore !== briefAfter) d.brief = lineDiff(briefBefore || '', briefAfter);
  const pw = setDiff(powerEntries(cur.powers), powerEntries(next.powers));
  if (pw.added.length || pw.removed.length) d.powers = pw;
  const dk = (list) => (Array.isArray(list) ? list.map((x) => `${x.id}: ${JSON.stringify(x)}`) : []);
  const du = setDiff(dk(cur.duties), dk(next.duties));
  if (du.added.length || du.removed.length) d.duties = { added: du.added.map((x) => x.slice(0, x.indexOf(':'))), removed: du.removed.map((x) => x.slice(0, x.indexOf(':'))) };
  if ((cur.parent == null ? null : cur.parent) !== (next.parent == null ? null : next.parent)) d.parent = { from: cur.parent == null ? null : cur.parent, to: next.parent == null ? null : next.parent };
  for (const k of ['name', 'remit', 'model', 'effort', 'status']) if (JSON.stringify(cur[k]) !== JSON.stringify(next[k])) d[k] = { from: cur[k] == null ? null : cur[k], to: next[k] == null ? null : next[k] };
  if (JSON.stringify(cur.scope) !== JSON.stringify(next.scope)) d.scope = { from: cur.scope, to: next.scope };
  if (excess && excess.length) d.excess = excess;
  return d;
}

// ---------- import (pure) ----------
// -> { company, draftedBy, items: [{ ref, action, company, target, parent, draft, why, notebook? }], errors: [{ ref, reason }] }
function parseImport(json) {
  const errors = [];
  let j = json;
  if (typeof j === 'string' || Buffer.isBuffer(j)) {
    try { j = JSON.parse(String(j).replace(/^﻿/, '')); } catch (e) { return { company: null, items: [], errors: [{ ref: null, reason: `not JSON: ${e.message}` }] }; }
  }
  if (!isObj(j)) return { company: null, items: [], errors: [{ ref: null, reason: 'the file must be a JSON object' }] };
  if (j.kind !== 'helm-team-proposals') return { company: null, items: [], errors: [{ ref: null, reason: 'kind: must be "helm-team-proposals"' }] };
  const company = typeof j.company === 'string' ? j.company : null;
  const cidErr = S.checkId(company, 'company');
  if (cidErr) return { company, items: [], errors: [{ ref: null, reason: cidErr }] };
  if (!Array.isArray(j.proposals)) return { company, items: [], errors: [{ ref: null, reason: 'proposals: must be a list' }] };
  const items = [];
  const refs = new Set();
  j.proposals.forEach((p, i) => {
    const ref = isObj(p) && p.ref != null ? String(p.ref) : `#${i + 1}`;
    const skip = (reason) => errors.push({ ref, reason });
    if (!isObj(p)) return skip('not an object');
    if (refs.has(ref)) return skip(`ref "${ref}" is used twice`);
    refs.add(ref);
    if ((p.status || 'pending') !== 'pending') return skip(`status "${p.status}" (only pending items load)`);
    const tp = p.team_propose;
    if (!isObj(tp)) return skip('team_propose: missing');
    const action = str(tp.action);
    if (!ACTIONS.includes(action)) return skip(`action: must be one of ${ACTIONS.join(', ')}`);
    const why = str(tp.why).trim();
    if (!why) return skip('why: required (one or two lines for the card)');
    if (action === 'company') {
      const id = tp.id != null ? String(tp.id) : company;
      if (id !== company) return skip(`id "${id}" is not the file's company "${company}"`);
      const v = S.validateCompany({ id, name: tp.name, folders: tp.folders }, { draft: true });
      if (!v.ok) return skip(v.errors.join('; '));
      items.push({ ref, action, company: null, target: id, parent: null, why, draft: { id, name: v.value.name, folders: v.value.folders } });
      return;
    }
    if (action === 'create') {
      const id = tp.id != null ? String(tp.id) : S.slugify(tp.name, items.filter((x) => x.action === 'create').map((x) => x.target));
      const pos = {};
      for (const k of POSITION_FIELDS) if (tp[k] !== undefined) pos[k] = clone(tp[k]);
      pos.id = id;
      if (pos.parent === undefined) pos.parent = null;
      const v = S.validatePosition({ ...pos, status: 'active' }, { draft: true });
      const b = S.validateBrief(tp.brief);
      const errs = [...(v.ok ? [] : v.errors), ...(b.ok ? [] : b.errors)];
      const seed = isObj(tp.seed) ? clone(tp.seed) : undefined;
      if (seed && seed.files !== undefined && (!Array.isArray(seed.files) || seed.files.some((f) => !isObj(f) || !str(f.path)))) errs.push('seed.files: must be a list of { path, why }');
      if (p.notebook_md !== undefined && typeof p.notebook_md !== 'string') errs.push('notebook_md: must be text');
      if (errs.length) return skip(errs.join('; '));
      const draft = { ...pos, brief: tp.brief };
      if (seed) draft.seed = seed;
      if (typeof p.notebook_md === 'string' && p.notebook_md.trim()) draft.notebook = p.notebook_md;
      items.push({ ref, action, company, target: id, parent: pos.parent, why, draft });
      return;
    }
    // edit / retire: of a position that must already exist (checked by P.import)
    if (tp.id == null) return skip(`${action} needs the id of the position`);
    const draft = {};
    for (const k of [...EDIT_FIELDS, 'brief', 'reports_on_retire', 'folders']) if (tp[k] !== undefined) draft[k] = clone(tp[k]);
    items.push({ ref, action, company, target: String(tp.id), parent: tp.parent === undefined ? undefined : tp.parent, why, draft });
  });
  return { company, draftedBy: typeof j.draftedBy === 'string' ? j.draftedBy : null, items, errors };
}

// ---------- the module ----------
function createProposals(opts = {}) {
  const { store, runtime } = opts;
  if (!store) throw new Error('proposals: store is required');
  const state = opts.state && typeof opts.state.get === 'function' ? opts.state : null;
  const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
  const notify = typeof opts.notify === 'function' ? opts.notify : () => {};
  const sessions = opts.sessions || {};
  const now = () => (opts.clock && typeof opts.clock.now === 'function' ? opts.clock.now() : Date.now());
  const iso = (ms = now()) => new Date(ms).toISOString();
  const logf = typeof opts.log === 'function' ? opts.log : () => {};
  const owner = () => ownerWords(opts.ownerName); // string or getter, resolved per message ('the owner' when unset)
  const safe = (fn, dflt) => { try { const v = fn(); return v === undefined ? dflt : v; } catch (e) { logf('warn', `proposals: ${e && e.message}`); return dflt; } };

  // ----- state -----
  let cards = [];
  {
    const s = state ? safe(() => state.get('proposals'), null) : null;
    const list = Array.isArray(s) ? s : isObj(s) && Array.isArray(s.items) ? s.items : [];
    cards = list.filter((c) => isObj(c) && typeof c.id === 'string' && ACTIONS.includes(c.action));
  }
  function save() {
    const cut = now() - KEEP_DECIDED_MS;
    cards = cards.filter((c) => c.status === 'open' || !c.decidedAt || Date.parse(c.decidedAt) >= cut);
    if (state && typeof state.set === 'function') safe(() => state.set('proposals', { v: 1, items: cards }), null);
  }
  const pub = (c) => {
    if (!c) return null;
    const out = {};
    for (const k of Object.keys(c)) if (!k.startsWith('_')) out[k] = clone(c[k]);
    return out;
  };
  const byId = (id) => cards.find((c) => c.id === id) || null;
  function newId(prefix) {
    for (;;) {
      const id = `${prefix}_${crypto.randomBytes(3).toString('hex')}`;
      if (prefix !== 'p' || !byId(id)) return id;
    }
  }

  // ----- store helpers -----
  const companyOf = (cid) => (cid ? safe(() => store.getCompany(cid), null) : null);
  const positionOf = (cid, pid) => (cid && pid ? safe(() => store.getPosition(cid, pid), null) : null);
  const treeOf = (cid) => safe(() => store.tree(cid), createTree([]));
  const nameOf = (cid, pid) => {
    if (pid == null) return 'the CEO';
    const p = positionOf(cid, pid);
    if (p) return p.name;
    const pending = cards.find((c) => c.status === 'open' && c.action === 'create' && c.company === cid && c.target === pid);
    return pending ? pending.draft.name : pid;
  };
  const openCreateFor = (cid, pid) => cards.find((c) => c.status === 'open' && c.action === 'create' && c.company === cid && c.target === pid) || null;
  const openCompanyFor = (cid) => cards.find((c) => c.status === 'open' && c.action === 'company' && c.target === cid) || null;
  function logLine(card, line) {
    const cid = card.action === 'company' ? (card.status === 'approved' ? card.target : null) : card.company;
    if (cid && companyOf(cid)) {
      try { store.append(cid, 'proposals', line); return; } catch (e) { logf('warn', `proposals.jsonl ${cid}: ${e.message}`); }
    }
    (card._unlogged = card._unlogged || []).push(line);
  }
  function flushLogs(cid) {
    for (const c of cards) {
      if (!c._unlogged || !c._unlogged.length) continue;
      const mine = c.action === 'company' ? c.target === cid && c.status === 'approved' : c.company === cid;
      if (!mine) continue;
      const lines = c._unlogged;
      c._unlogged = [];
      for (const l of lines) { try { store.append(cid, 'proposals', l); } catch (e) { logf('warn', `proposals.jsonl ${cid}: ${e.message}`); c._unlogged.push(l); } }
    }
  }
  const proposalLine = (c) => ({ at: c.at, id: c.id, action: c.action, by: c.by, ...(c.target != null ? { target: c.target } : {}), ...(c.parent !== undefined ? { parent: c.parent } : {}), why: c.why, draft: c.draft, ...(c.excess && c.excess.length ? { excess: c.excess } : {}) });
  const decisionLine = (c) => ({ at: c.decidedAt, id: c.id, action: c.action, by: c.by, ...(c.target != null ? { target: c.target } : {}), decision: c.decision });

  function openTicketsFn(cid) {
    if (!runtime || typeof runtime.list !== 'function') return null;
    const list = safe(() => runtime.list(cid), []) || [];
    const open = list.filter((t) => t && OPEN_TICKET_STATES.has(t.state) && (!t.company || t.company === cid));
    return (pid) => open.filter((t) => t.to === pid || (t.from && t.from.id === pid)).length;
  }

  function computeExcess(cid, powers, parent, { scope, workspaceId } = {}) {
    if (!powers || !cid || !companyOf(cid)) return undefined;
    const tr = treeOf(cid);
    if (parent != null && !tr.has(parent)) return undefined; // the parent is a pending create: computed once it exists
    return safe(() => tr.excess(powers, parent == null ? null : parent, store.powersCtx(cid), { scope, workspace: workspaceId ? store.workspaceOf(cid, workspaceId) : null }) || [], undefined);
  }

  // Folders a position's draft names must lie inside its company (scope.folder, event duty repos, file triggers).
  function folderErrors(company, pos) {
    if (!company) return [];
    const errs = [];
    const inside = (p) => company.folders.some((f) => S.isUnder(p, f));
    if (pos.scope && pos.scope.kind === 'product' && pos.scope.folder && !inside(pos.scope.folder)) errs.push(`scope.folder: ${pos.scope.folder} is not inside ${company.name}'s folders`);
    (pos.duties || []).forEach((d, i) => {
      const t = d && d.trigger;
      if (!isObj(t)) return;
      for (const k of ['repo', 'path']) if (typeof t[k] === 'string' && !t[k].startsWith('$') && !inside(t[k])) errs.push(`duties[${i}].trigger.${k}: ${t[k]} is not inside ${company.name}'s folders`);
    });
    return errs;
  }
  function companyFolderErrors(folders, exceptCid) {
    const errs = [];
    for (const c of safe(() => store.listCompanies(), []) || []) {
      if (c.id === exceptCid) continue;
      for (const f of folders) for (const g of c.folders || []) if (S.foldersOverlap(f, g)) errs.push(`folders: ${f} overlaps ${c.name}'s folder ${g} (a folder belongs to one company)`);
    }
    if (store.root) for (const f of folders) if (S.foldersOverlap(f, store.root)) errs.push(`folders: ${f} overlaps the team root ${S.normPath(store.root)}`);
    return errs;
  }

  // ----- validation: -> { errors, card fields } -----
  function check(cid, by, action, draftIn, { importing = false, selfId = null } = {}) {
    const d = isObj(draftIn) ? clone(draftIn) : {};
    const errors = [];
    const company = companyOf(cid);
    const why = str(d.why).trim();
    if (!why) errors.push('why: required (one or two lines for the card)');
    if (!ACTIONS.includes(action)) return { errors: [`action: must be one of ${ACTIONS.join(', ')}`] };

    // 6.1 who may propose what (mcp.js checks this too; this is the second lock)
    if (by.kind === 'none' && action !== 'company') return { errors: ['This chat is not in a company: only action "company" can be proposed here.'] };
    if (by.kind === 'ceo' && action === 'company') return { errors: ['This company exists; to change its folders use action "edit" without an id.'] };
    if (by.kind === 'position' && action === 'company') return { errors: ['A position cannot propose a company.'] };
    if (action !== 'company' && !cid) return { errors: ['company: required'] };
    if (action !== 'company' && !company && !(importing && action === 'create')) return { errors: [`company "${cid}" does not exist`] };

    if (action === 'company') {
      const taken = new Set((safe(() => store.listCompanies(), []) || []).map((c) => c.id));
      const id = d.id != null ? String(d.id) : S.slugify(d.name, taken);
      const v = S.validateCompany({ id, name: d.name, folders: d.folders }, { draft: true });
      if (!v.ok) errors.push(...v.errors);
      if (taken.has(id) || companyOf(id)) errors.push(`company "${id}" already exists`);
      if (v.ok) errors.push(...companyFolderErrors(v.value.folders, null));
      if (errors.length) return { errors };
      return { errors, fields: { company: null, target: id, draft: { id, name: v.value.name, folders: v.value.folders }, why, title: `New company: ${v.value.name}` } };
    }

    if (action === 'create') {
      const live = company ? treeOf(cid) : createTree([]);
      const used = new Set(company ? [...(safe(() => store.takenIds(cid), new Set()) || [])] : []); // live and retired
      const taken = new Set(used);
      for (const c of cards) if (c.status === 'open' && c.action === 'create' && c.company === cid && c.id !== selfId && !(by.sessionId && c.by.sessionId === by.sessionId)) taken.add(c.target);
      const id = d.id != null ? String(d.id) : S.slugify(d.name, taken);
      const pos = {};
      for (const k of POSITION_FIELDS) if (d[k] !== undefined) pos[k] = d[k];
      pos.id = id;
      if (pos.parent === undefined) pos.parent = by.kind === 'position' ? by.id : null;
      if (by.kind === 'position' && pos.parent !== by.id) errors.push(`parent: you can propose a new report only under yourself ("${by.id}")`);
      const v = S.validatePosition({ ...pos, status: 'active' }, { draft: true });
      if (!v.ok) errors.push(...v.errors);
      const b = S.validateBrief(d.brief);
      if (!b.ok) errors.push(...b.errors);
      if (d.seed !== undefined && (!isObj(d.seed) || (d.seed.files !== undefined && (!Array.isArray(d.seed.files) || d.seed.files.some((f) => !isObj(f) || !str(f.path)))))) errors.push('seed: must be { notes?, files?: [{ path, why }] }');
      if (d.notebook !== undefined && typeof d.notebook !== 'string') errors.push('notebook: must be text');
      const other = openCreateFor(cid, id);
      if (other && other.id !== selfId && !(by.sessionId && other.by.sessionId === by.sessionId)) errors.push(`id: "${id}" is already proposed in ${other.id}`);
      const parentPending = pos.parent != null && !live.has(pos.parent) && openCreateFor(cid, pos.parent);
      if (company) {
        if (live.has(id) || used.has(id)) errors.push(`id: "${id}" is already used in this company (ids stay unique, retired ones too)`);
        if (parentPending && importing) {
          // the parent waits for its own approval; the tree is checked again on approve
        } else if (parentPending) {
          errors.push(`parent: "${pos.parent}" is not a live position yet (approve ${parentPending.id} first)`);
        } else {
          const terr = live.checkCreate({ id, parent: pos.parent }, { taken: new Set() }).filter((e) => !/^id: /.test(e));
          errors.push(...terr);
        }
        if (v.ok) errors.push(...folderErrors(company, v.value));
      }
      if (errors.length) return { errors };
      const draft = { ...v.value, brief: b.value };
      delete draft.version; delete draft.status;
      if (isObj(d.seed)) draft.seed = clone(d.seed);
      if (typeof d.notebook === 'string' && d.notebook.trim()) draft.notebook = d.notebook;
      const parentName = pos.parent == null ? null : nameOf(cid, pos.parent);
      return { errors, fields: { company: cid, target: id, parent: pos.parent, draft, why, title: `New position: ${v.value.name}${parentName ? ` under ${parentName}` : ''}` } };
    }

    if (action === 'edit' && (d.id == null || d.id === '')) {
      // a company edit (the CEO's "edit" without an id): name and folders
      if (by.kind === 'position') return { errors: ['edit needs the id of a position in your subtree'] };
      const next = { id: cid, name: d.name !== undefined ? d.name : company.name, folders: d.folders !== undefined ? d.folders : company.folders };
      const v = S.validateCompany(next, { draft: true });
      if (!v.ok) errors.push(...v.errors);
      else {
        errors.push(...companyFolderErrors(v.value.folders, cid));
        const removed = setDiff(company.folders, v.value.folders).removed;
        if (!removed.length && !setDiff(company.folders, v.value.folders).added.length && v.value.name === company.name) errors.push('nothing to change: the name and folders are the same');
      }
      if (errors.length) return { errors };
      const f = setDiff(company.folders, v.value.folders);
      return { errors, fields: { company: cid, target: null, draft: { id: cid, name: v.value.name, folders: v.value.folders }, why, title: `Change ${company.name}${v.value.name !== company.name ? ` (now ${v.value.name})` : ''}: folders`, diff: { folders: f, ...(v.value.name !== company.name ? { name: { from: company.name, to: v.value.name } } : {}) } } };
    }

    const target = String(d.id);
    const tr = treeOf(cid);
    const cur = positionOf(cid, target);
    if (!cur || !tr.has(target)) return { errors: [`id: "${target}" is not a live position in ${company ? company.name : cid}`] };
    if (by.kind === 'position') {
      if (target === by.id) return { errors: ['You cannot propose changes to yourself. Use request_access for powers you need.'] };
      if (!safe(() => tr.subtree(by.id), []).includes(target)) return { errors: [`${cur.name} is not in your subtree`] };
    }

    if (action === 'retire') {
      const mode = d.reports_on_retire || 'move-up';
      const plan = tr.planRetire(target, mode);
      if (!plan.ok) return { errors: plan.errors };
      const busy = openTicketsFn(cid);
      if (busy) {
        const held = plan.retire.filter((id) => busy(id) > 0);
        if (held.length) return { errors: [`open tickets to or from ${held.map((id) => nameOf(cid, id)).join(', ')}: wait until they settle (or cancel them), then propose again`] };
      }
      const draft = { id: target, name: cur.name, reports_on_retire: mode, retires: plan.retire, moves: plan.moves };
      const extra = plan.retire.length > 1 ? ` and ${plan.retire.length - 1} report(s)` : plan.moves.length ? ` (${plan.moves.length} report(s) move up to ${nameOf(cid, tr.parentOf(target))})` : '';
      return { errors, fields: { company: cid, target, parent: cur.parent == null ? null : cur.parent, draft, why, title: `Retire ${cur.name}${extra}` } };
    }

    // edit of a position
    const changes = {};
    for (const k of EDIT_FIELDS) if (d[k] !== undefined) changes[k] = clone(d[k]);
    if (by.kind === 'position' && changes.parent !== undefined && changes.parent !== by.id && !safe(() => tr.subtree(by.id), []).includes(changes.parent)) errors.push('parent: a re-parent must stay inside your subtree');
    const next = { ...cur, ...changes, id: target };
    const v = S.validatePosition(next);
    if (!v.ok) errors.push(...v.errors);
    let briefBefore = null;
    if (d.brief !== undefined) {
      const b = S.validateBrief(d.brief);
      if (!b.ok) errors.push(...b.errors);
      briefBefore = safe(() => store.readBrief(cid, target).text, null);
    }
    const newParent = changes.parent === undefined ? cur.parent : changes.parent;
    if (changes.parent !== undefined && (changes.parent == null ? null : changes.parent) !== (cur.parent == null ? null : cur.parent)) errors.push(...tr.checkReparent(target, changes.parent));
    if (v.ok) errors.push(...folderErrors(company, v.value));
    if (errors.length) return { errors };
    const diff = editDiff(cur, v.value, { briefBefore, briefAfter: d.brief });
    if (!Object.keys(diff).length) return { errors: ['nothing to change: the edit matches the current position'] };
    const draft = { ...v.value, ...(d.brief !== undefined ? { brief: d.brief } : {}) };
    delete draft.version; delete draft.createdAt; delete draft.createdBy;
    return { errors, fields: { company: cid, target, parent: newParent == null ? null : newParent, draft, why, title: `Change ${cur.name}`, diff, _changes: { ...changes, ...(d.brief !== undefined ? { brief: d.brief } : {}) }, _scope: v.value.scope } };
  }

  // ----- propose -----
  function supersedeKey(c) { return c.action === 'company' ? 'company' : `${c.company}:${c.target == null ? '@company' : c.target}`; }

  function setStatus(c, result, { how, quote, note } = {}) {
    c.status = result;
    c.decidedAt = iso();
    c.decision = { at: c.decidedAt, ...(how ? { how } : {}), ...(quote ? { quote } : {}), result, ...(note ? { note } : {}) };
    if (how) c.decidedHow = how;
    if (quote) c.quote = quote;
    if (note) c.note = note;
    delete c.error;
  }
  function broadcast(c) {
    const card = pub(c);
    safe(() => emit('team.proposal.updated', { company: c.company, proposal: card }), null);
    if (c.by && c.by.sessionId && typeof sessions.patchCard === 'function') safe(() => sessions.patchCard(c.by.sessionId, c.id, { proposal: card }), false);
  }
  function inbox(cid, entry) {
    if (!cid || !companyOf(cid)) return null;
    const line = safe(() => store.append(cid, 'inbox', { id: newId('n'), ...entry }), null);
    if (line) safe(() => emit('team.inbox.appended', { company: cid, entry: line }), null);
    return line;
  }

  function propose({ company = null, by = {}, action, draft, excess } = {}, { importing = false } = {}) {
    by = isObj(by) ? { ...by } : { kind: 'none' };
    if (!['ceo', 'position', 'none', 'import'].includes(by.kind)) return { refused: true, reasons: ['by.kind: must be ceo, position, none or import'] };
    if (by.kind === 'import') importing = true;
    const cid = company || null;
    const r = check(cid, by, action, draft, { importing });
    if (r.errors.length) return { refused: true, reasons: r.errors };
    const f = r.fields;
    if (excess === undefined && (action === 'create' || action === 'edit') && f.draft.powers && (action === 'create' || (f._changes && f._changes.powers))) {
      excess = computeExcess(f.company, f.draft.powers, f.parent, { scope: f.draft.scope, workspaceId: action === 'edit' ? f.target : f.target });
    }
    const c = {
      id: newId('p'), company: f.company, action, title: f.title, why: f.why, draft: f.draft,
      ...(f.diff ? { diff: f.diff } : {}),
      ...(Array.isArray(excess) ? { excess } : {}),
      status: 'open', by, target: f.target, ...(f.parent !== undefined ? { parent: f.parent } : {}), at: iso(),
      ...(f._changes ? { _changes: f._changes } : {}),
    };
    if (c.diff && Array.isArray(excess) && excess.length) c.diff.excess = excess;
    const warnName = action === 'create' ? nameWarning(f.draft.name) : action === 'edit' && f.target != null && f.diff && f.diff.name ? nameWarning(f.diff.name.to) : null;
    if (warnName) c.nameWarning = warnName;
    // 6.2: a new proposal for the same target from the same session supersedes the older one
    if (by.sessionId) {
      for (const o of cards) {
        if (o.status !== 'open' || !o.by || o.by.sessionId !== by.sessionId || supersedeKey(o) !== supersedeKey(c)) continue;
        setStatus(o, 'superseded', { note: `replaced by ${c.id}` });
        logLine(o, decisionLine(o));
        broadcast(o);
      }
    }
    cards.push(c);
    logLine(c, proposalLine(c));
    save();
    const where = [];
    if (by.sessionId && typeof sessions.addCard === 'function') {
      const itemId = safe(() => sessions.addCard(by.sessionId, { kind: 'proposal', key: c.id, proposal: pub(c) }), null);
      if (itemId) where.push('this chat');
    }
    where.push('Team view');
    if (by.kind === 'position') {
      const who = nameOf(c.company, by.id);
      const what = action === 'create' ? `a new report: ${c.draft.name}` : action === 'retire' ? `retiring ${c.draft.name}` : `a change to ${c.draft.name || 'the company'}`;
      // the toast / phone push, titled by teamNotice (what 'proposal'; notice.js)
      const co = c.company ? safe(() => store.getCompany(c.company), null) : null;
      safe(() => notify(teamEvent({ what: 'proposal', action, subject: c.draft.name || (co && co.name) || null,
        company: { id: c.company, name: co && co.name }, position: { id: by.id, name: who },
        detail: c.why, sessionId: by.sessionId })), null);
      inbox(c.company, { position: by.id, kind: 'proposal', title: `${who} proposes ${what}`, text: c.why, proposal: c.id, needsOwen: true });
      where.push('phone');
    }
    safe(() => emit('team.proposal.updated', { company: c.company, proposal: pub(c) }), null);
    if (c.company) safe(() => emit('team.updated', { company: c.company }), null);
    return { proposal: c.id, status: 'shown', where, ...(c.nameWarning ? { nameWarning: c.nameWarning } : {}) };
  }

  // ----- views -----
  const newestFirst = (a, b) => String(b.at).localeCompare(String(a.at));
  function open(company) {
    const cid = company == null ? null : company;
    return cards.filter((c) => c.status === 'open' && (c.company == null ? null : c.company) === cid).sort(newestFirst).map(pub);
  }
  function list({ company, status, includeDecided = false } = {}) {
    return cards.filter((c) => {
      if (company !== undefined && (c.company == null ? null : c.company) !== (company == null ? null : company)) return false;
      if (status) return c.status === status;
      return includeDecided || c.status === 'open';
    }).sort(newestFirst).map(pub);
  }
  const get = (id) => pub(byId(id));
  const pendingCount = (company) => open(company).length;

  // ----- apply (approve) -----
  function applyCreate(c, how) {
    const cid = c.company;
    const company = companyOf(cid);
    if (!company) {
      const pc = openCompanyFor(cid);
      throw codeErr('order', pc ? `approve ${pc.draft.name} (${pc.id}) first: the company does not exist yet` : `company "${cid}" does not exist`);
    }
    const tr = treeOf(cid);
    if (c.parent != null && !tr.has(c.parent)) {
      const pp = openCreateFor(cid, c.parent);
      throw codeErr('order', pp ? `approve ${pp.draft.name} (${pp.id}) first: "${c.parent}" does not exist yet` : `parent: "${c.parent}" is not a live position in ${company.name}`);
    }
    const fe = folderErrors(company, c.draft);
    if (fe.length) throw codeErr('invalid', fe.join('; '));
    const pos = {};
    for (const k of POSITION_FIELDS) if (c.draft[k] !== undefined) pos[k] = clone(c.draft[k]);
    const excessNow = computeExcess(cid, pos.powers, pos.parent, { scope: pos.scope });
    if (excessNow) c.excess = excessNow;
    const createdBy = { proposal: c.id, by: c.by.kind === 'position' ? c.by.id : c.by.kind === 'import' ? (c.by.name || 'import') : c.by.kind, how };
    const value = store.createPosition(cid, pos, { brief: c.draft.brief, seed: c.draft.seed, createdBy });
    if (typeof c.draft.notebook === 'string' && c.draft.notebook.trim()) {
      const nb = fullNotebook(c.draft.notebook, value.name);
      try { store.writeNotebook(cid, value.id, nb); } catch (e) { logf('warn', `proposals: notebook of ${value.id}: ${e.message}`); c.warning = `the notebook could not be written (${e.message}); it starts from the template`; }
    }
    const parentName = value.parent == null ? null : nameOf(cid, value.parent);
    return { created: { company: cid, id: value.id }, position: value, text: `${value.name} created${parentName ? ` under ${parentName}` : ' (reports to the CEO)'}`, inboxPosition: value.id };
  }
  function applyCompany(c, how) {
    const createdBy = { proposal: c.id, how, ...(c.by.kind === 'import' ? { by: c.by.name || 'import' } : {}) };
    const value = store.createCompany({ id: c.draft.id, name: c.draft.name, folders: c.draft.folders }, { createdBy });
    c.company = value.id;
    return { created: { company: value.id }, text: `${value.name} created`, companyId: value.id };
  }
  function applyEdit(c) {
    const cid = c.company;
    if (c.target == null) {
      const v = store.updateCompany(cid, { name: c.draft.name, folders: c.draft.folders });
      return { text: `${v.name} updated (folders)` };
    }
    const ch = c._changes || {};
    const patch = {};
    for (const k of EDIT_FIELDS) if (ch[k] !== undefined) patch[k] = clone(ch[k]);
    if (ch.brief !== undefined) {
      const b = S.validateBrief(ch.brief);
      if (!b.ok) throw codeErr('invalid', b.errors.join('; '));
    }
    if (patch.powers) {
      const cur = positionOf(cid, c.target);
      const ex = computeExcess(cid, patch.powers, patch.parent !== undefined ? patch.parent : cur && cur.parent, { scope: patch.scope || (cur && cur.scope), workspaceId: c.target });
      if (ex) c.excess = ex;
    }
    const v = Object.keys(patch).length ? store.updatePosition(cid, c.target, patch) : positionOf(cid, c.target);
    if (!v) throw codeErr('not-found', `no live position "${c.target}"`);
    if (ch.brief !== undefined) store.writeBrief(cid, c.target, ch.brief);
    const moved = patch.parent !== undefined ? `, now under ${nameOf(cid, v.parent)}` : '';
    return { text: `${v.name} updated${moved}`, inboxPosition: c.target };
  }
  function applyRetire(c) {
    const cid = c.company;
    const name = nameOf(cid, c.target);
    const busy = openTicketsFn(cid);
    const r = store.retirePosition(cid, c.target, { mode: c.draft.reports_on_retire || 'move-up', ...(busy ? { openTickets: busy } : {}) });
    let tail = '';
    if (r.retired.length > 1) tail = ` with ${r.retired.length - 1} report(s)`;
    else if (r.moved.length) tail = ` (${r.moved.length} report(s) moved up to ${nameOf(cid, r.moved[0].to)})`;
    return { text: `${name} retired${tail}`, inboxPosition: c.target, retire: r };
  }

  // after a company or a position appears, cards waiting on it can now show their excess
  function refreshExcess(cid) {
    for (const c of cards) {
      if (c.status !== 'open' || c.company !== cid || c.action !== 'create' || c.excess) continue;
      const ex = computeExcess(cid, c.draft.powers, c.parent, { scope: c.draft.scope });
      if (ex) { c.excess = ex; broadcast(c); }
    }
  }

  function decide({ proposal, decision, note, how = 'click', quote } = {}) {
    const c = byId(proposal);
    if (!c) throw codeErr('not_found', `no proposal "${proposal}"`);
    if (c.status !== 'open') throw codeErr('refused', `${proposal} is no longer open (${c.status})`);
    if (!['approve', 'decline'].includes(decision)) throw codeErr('bad_params', 'decision: must be approve or decline');
    if (!['click', 'typed'].includes(how)) throw codeErr('bad_params', 'how: must be click or typed');
    note = note == null ? '' : str(note).trim().slice(0, 2000);
    const proposer = c.by && c.by.sessionId;

    if (decision === 'decline') {
      setStatus(c, 'declined', { how, quote, note });
      logLine(c, decisionLine(c));
      save();
      broadcast(c);
      if (c.company) safe(() => emit('team.updated', { company: c.company }), null);
      if (proposer && typeof sessions.note === 'function') safe(() => sessions.note(proposer, `${owner().Owner} declined ${c.id}: ${c.title}.${note ? ` Note: ${note}` : ''}`, { wake: false }), null);
      return { ok: true };
    }

    let res;
    try {
      if (c.action === 'create') res = applyCreate(c, how);
      else if (c.action === 'company') res = applyCompany(c, how);
      else if (c.action === 'edit') res = applyEdit(c);
      else res = applyRetire(c);
    } catch (e) {
      c.error = (e && e.message) || String(e);
      save();
      broadcast(c);
      return { ok: false, error: c.error };
    }
    setStatus(c, 'approved', { how, quote, note });
    c.decision.result = 'approved';
    c.result = res.text;
    const cid = c.company;
    if (c.action === 'company') flushLogs(cid);
    logLine(c, decisionLine(c));
    if (c.action !== 'company') flushLogs(cid);
    save();
    const how2 = how === 'typed' ? `Approved by your reply "${quote || ''}".` : 'Approved by your click.';
    inbox(cid, { position: res.inboxPosition || null, kind: 'proposal', title: res.text, text: how2, proposal: c.id, needsOwen: false });
    broadcast(c);
    safe(() => emit('team.updated', { company: cid }), null);

    // 6.3 / 6.5 step 4: notes
    const msg = `${owner().Owner} approved ${c.id}: ${res.text}.`;
    const told = new Set();
    if (proposer && typeof sessions.note === 'function') { safe(() => sessions.note(proposer, msg, { wake: c.by.kind === 'position' }), null); told.add(proposer); }
    if (c.action === 'create' && res.position && res.position.parent != null && typeof sessions.positionSession === 'function') {
      const mgr = safe(() => sessions.positionSession(cid, res.position.parent), null);
      if (mgr && !told.has(mgr) && typeof sessions.note === 'function') { safe(() => sessions.note(mgr, msg, { wake: false }), null); told.add(mgr); }
    }
    if (c.action !== 'company' && typeof sessions.ceoSessions === 'function' && typeof sessions.note === 'function') {
      for (const sid of safe(() => sessions.ceoSessions(cid), []) || []) {
        if (told.has(sid)) continue;
        safe(() => sessions.note(sid, `The team changed: ${res.text} (${c.id}). team_roster shows the current roster.`, { wake: false }), null);
        told.add(sid);
      }
    }
    if (c.action === 'company' || c.action === 'create') refreshExcess(cid);
    const files = c.action === 'create' && c.draft.seed && Array.isArray(c.draft.seed.files) ? c.draft.seed.files.filter((f) => isObj(f) && str(f.path)) : [];
    // position = the new position's id (wire.js onboard() looks it up by id; the object here once made runDuty throw)
    if (files.length && typeof opts.onboard === 'function') safe(() => opts.onboard({ company: cid, position: res.created.id, files: files.map((f) => ({ path: f.path, why: str(f.why) })), proposal: pub(c) }), null);
    if (typeof opts.onApplied === 'function') safe(() => opts.onApplied({ proposal: pub(c), ...(res.created ? { created: res.created } : {}), company: cid }), null);
    return { ok: true, ...(res.created ? { created: res.created } : {}) };
  }

  // ----- 6.3 typed approval -----
  function onUserMessage({ sessionId, text, origin, lastShownId } = {}) {
    if (!sessionId || origin !== 'user') return null;
    const mine = cards.filter((c) => c.status === 'open' && c.by && c.by.sessionId === sessionId).map((c) => c.id);
    const hit = typedApproval({ text, origin, openProposals: mine, lastShown: lastShownId });
    if (!hit) return null;
    let result;
    try { result = decide({ proposal: hit.proposal, decision: 'approve', how: 'typed', quote: hit.quote }); } catch (e) { result = { ok: false, error: e.message }; }
    return { proposal: hit.proposal, result };
  }

  // ----- import -----
  function importFile(json, { by } = {}) {
    const parsed = parseImport(json);
    const skipped = parsed.errors.slice();
    const imported = [];
    let raw = json;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw.replace(/^﻿/, '')); } catch { raw = null; } }
    const who = { kind: 'import', name: (isObj(by) && by.name) || parsed.draftedBy || 'import' };
    for (const it of parsed.items) {
      const dup = cards.find((c) => c.status === 'open' && c.action === it.action && (c.company == null ? null : c.company) === (it.company == null ? null : it.company) && c.target === it.target);
      if (dup) { skipped.push({ ref: it.ref, reason: `already open as ${dup.id}` }); continue; }
      const draft = { ...it.draft, why: it.why };
      if (it.action === 'edit' || it.action === 'retire') { draft.id = it.target; if (it.parent !== undefined) draft.parent = it.parent; }
      const r = propose({ company: it.company, by: who, action: it.action, draft }, { importing: true });
      if (r.refused) { skipped.push({ ref: it.ref, reason: r.reasons.join('; ') }); continue; }
      const c = byId(r.proposal);
      c.ref = it.ref;
      imported.push({ id: c.id, ref: it.ref, action: it.action, target: c.target });
    }
    save();
    if (parsed.company && companyOf(parsed.company)) safe(() => emit('team.updated', { company: parsed.company }), null);
    return { imported, skipped };
  }

  return { propose: (a) => propose(a), open, list, get, decide, onUserMessage, import: importFile, pendingCount };
}

module.exports = { createProposals, parseImport, lineDiff, nameWarning };
