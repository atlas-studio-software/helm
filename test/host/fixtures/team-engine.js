'use strict';
// Positions UI fixtures made by the REAL engine (main/engine/team/*), so a UI test fails when the engine's payloads
// change shape instead of passing against a hand-written mock. Used by test/host/positions-engine-shapes.test.js
// (and any UI test that wants a real proposal / access card / team.position payload).
//
//   const F = await engineFixtures()   // builds once per process (a temp copy of docs/positions.example)
//   F.proposals.create   create under payroll-tax listing powers its managers lack  -> excess [{ power, value, by, max? }]
//   F.proposals.edit     edit of payroll-tax: name, remit, scope, brief, powers, duties  -> diff { ... } + excess
//   F.proposals.reparent edit moving tax under the CEO                              -> diff.parent { from, to }
//   F.proposals.company  a new company (no company yet)                               -> action 'company'
//   F.proposals.retire   retire marketing
//   F.access.onceOnly    the request item an access card is (session.openRequest): a read beyond the company,
//                        inside ~/.claude (warn) -> access.onceOnly + access.warn
//   F.access.widens      payroll-tax asks for Bash read-only: an always also widens tax and legal -> access.ancestors
//   F.effective          store.effectivePowers('payroll-tax') (tree.effective: expanded paths + limitedBy list)
//   F.positionPayload    team.position's `position` built the way wire.js builds it (effective.limits + limitedBy map)
//   F.companyFolders     the example company's folders; F.outside = the path outside them payroll-tax lists
//   F.accessRows         access.pending(company): the open access cards (wire.js maps them into team.position pending.requests)
//   F.listProposals      team.list `proposals` (open cards with company null: F.proposals.company)
//   F.crosstalk          team.crosstalk -> { entries, hasMore } (runtime.crosstalk: folded, ISO askedAt / answeredAt)
//   F.imported           the import flow in an empty team root (see importedFixtures below)
// The temp folder is removed at process exit.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const EXAMPLE = path.join(ROOT, 'docs', 'positions.example');
const CID = 'northwind-goods';
const { createTeamStore } = require(path.join(ROOT, 'main', 'engine', 'team', 'store'));
const { createProposals } = require(path.join(ROOT, 'main', 'engine', 'team', 'proposals'));
const { createAccess } = require(path.join(ROOT, 'main', 'engine', 'team', 'access'));

// wire.js limitedMap (not exported): tree.effective limitedBy [{ power, value, by }] -> { "<power>[:<value>]": by }
function limitedMap(list) {
  const out = {};
  for (const x of Array.isArray(list) ? list : []) {
    const key = ['bash', 'agents', 'worktree'].includes(x.power) ? x.power : `${x.power}:${typeof x.value === 'string' ? x.value : JSON.stringify(x.value)}`;
    out[key] = x.by == null ? 'company' : x.by;
  }
  return out;
}

let built = null;
function engineFixtures() {
  if (built) return built;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-ui-team-fx-'));
  process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
  fs.cpSync(EXAMPLE, root, { recursive: true });
  let now = Date.parse('2026-11-17T12:00:00Z');
  const store = createTeamStore({ root, houseRulesDefault: '# House rules\n', now: () => now });
  const slices = new Map();
  const P = createProposals({
    store, runtime: { list: () => [] }, clock: { now: () => (now += 1000) },
    state: { get: (n) => slices.get(n), set: (n, v) => slices.set(n, JSON.parse(JSON.stringify(v))) },
    sessions: { addCard: () => 'i1', patchCard: () => true, note: () => {}, ceoSessions: () => [], positionSession: () => null },
    emit: () => {}, notify: () => {}, onboard: () => {}, onApplied: () => {}, ownerName: 'Owner',
  });
  const ceo = { kind: 'ceo', sessionId: 's_ceo' };
  const card = (r, what) => { if (!r || !r.proposal) throw new Error(`engine refused the ${what} fixture: ${JSON.stringify(r && r.reasons)}`); return JSON.parse(JSON.stringify(P.get(r.proposal))); };
  const folders = store.getCompany ? (store.getCompany(CID) || {}).folders : JSON.parse(fs.readFileSync(path.join(root, CID, 'company.json'), 'utf8')).folders;
  const shop = folders[0], app = folders[1];

  const proposals = {};
  proposals.create = card(P.propose({ company: CID, by: ceo, action: 'create', draft: {
    id: 'state-payroll', name: 'State Payroll', parent: 'payroll-tax', remit: 'State payroll filings and their deadlines.',
    brief: '# State Payroll\n\nState payroll filings and their deadlines.\n',
    powers: { read: ['$workspace', '$company'], write: ['$workspace'], tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'WebSearch', 'WebFetch'], bash: 'on', agents: true, worktree: false },
    duties: [{ id: 'monthly-deadlines', title: 'Monthly deadlines', enabled: true, trigger: { kind: 'schedule', cron: '0 9 1 * *', catchUp: 'once' }, prompt: 'List the filings due this month.' }],
    why: 'State filings keep coming up in payroll questions.' } }), 'create');
  const briefNow = fs.readFileSync(path.join(root, CID, 'positions', 'payroll-tax', 'brief.md'), 'utf8');
  proposals.edit = card(P.propose({ company: CID, by: ceo, action: 'edit', draft: {
    id: 'payroll-tax', name: 'Payroll & Contractors', remit: 'Payroll tax and contractor withholding.', scope: { kind: 'product', folder: app },
    brief: briefNow.replace(/\n*$/, '\n') + '\n## Contractors\n- Withholding rules for contractors abroad.\n',
    powers: { read: ['$workspace', '$company'], write: ['$workspace', '$scope'], tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'], bash: 'readonly', agents: false, worktree: false },
    duties: [{ id: 'quarterly-withholding', title: 'Quarterly withholding check', enabled: true, trigger: { kind: 'schedule', cron: '0 9 1 1,4,7,10 *', catchUp: 'once' }, prompt: 'Check the withholding tables.' }],
    why: 'Contractor questions land on payroll anyway.' } }), 'edit');
  proposals.reparent = card(P.propose({ company: CID, by: ceo, action: 'edit', draft: { id: 'tax', parent: null, why: 'Tax answers to the CEO directly now.' } }), 'reparent');
  proposals.retire = card(P.propose({ company: CID, by: ceo, action: 'retire', draft: { id: 'marketing', why: 'Marketing moves to an agency.' } }), 'retire');
  proposals.company = card(P.propose({ company: null, by: { kind: 'none', sessionId: 's_any' }, action: 'company', draft: {
    id: 'harbor-studio', name: 'Harbor Studio', folders: [path.join(os.tmpdir(), 'harbor-studio-site').replace(/\\/g, '/')], why: 'A second business with its own site.' } }), 'company');

  // access cards: the request item session.openRequest adds (main/engine/session.js openRequest)
  const opened = [];
  const es = (pid) => ({
    s: { id: `s_${pid}`, position: { company: CID, id: pid } },
    openRequest(arg) {
      const requestId = `req_${opened.length + 1}`;
      const item = { id: `i${opened.length + 1}`, type: 'request', ts: now, requestId, kind: arg.kind, toolName: arg.toolName || 'request_access', input: arg.input || {}, status: 'pending',
        ...(arg.title ? { title: arg.title } : {}), ...(arg.body ? { description: arg.body } : {}), ...(arg.access ? { access: arg.access } : {}) };
      opened.push(item);
      return { requestId, itemId: item.id, result: new Promise(() => {}) };
    },
  });
  const sessions = new Map([['s_tax', es('tax')], ['s_payroll-tax', es('payroll-tax')]]);
  const A = createAccess({ store, sessions: { get: (sid) => sessions.get(sid) || null }, emit: () => {}, clock: { now: () => now, setTimeout: () => 0, clearTimeout: () => {} }, waitMs: 30 * 60_000 });
  const home = os.homedir().replace(/\\/g, '/');
  A.request({ company: CID, position: 'tax', sessionId: 's_tax', kind: 'read', target: `${home}/.claude/settings.json`, why: 'To see which model the CLI defaults to.', warn: true });
  A.request({ company: CID, position: 'payroll-tax', sessionId: 's_payroll-tax', kind: 'bash', target: 'bash:readonly', why: 'To list the payroll exports.' });
  const access = { onceOnly: opened[0], widens: opened[1] };
  if (!access.onceOnly || !access.widens) throw new Error('access fixtures: a card did not open');
  const accessRows = JSON.parse(JSON.stringify(A.pending(CID)));   // access.pending(): what wire.js maps into pending.requests

  // payroll-tax lists more than its managers have (as an "Approve always" or a hand edit can leave it): a tool tax
  // lacks, Bash legal lacks, and a path outside the company folders -> effective.limitedBy / team.position limitedBy
  const cur = store.getPosition(CID, 'payroll-tax');
  const outside = `${home}/northwind-archive`;
  store.updatePosition(CID, 'payroll-tax', { powers: { ...cur.powers, read: [...cur.powers.read, outside], tools: [...cur.powers.tools, 'TodoWrite'], bash: 'readonly' } });
  const effective = JSON.parse(JSON.stringify(store.effectivePowers(CID, 'payroll-tax')));
  const pos = JSON.parse(JSON.stringify(store.getPosition(CID, 'payroll-tax')));
  const positionPayload = { ...pos, effective: { ...effective, limits: effective.limitedBy || [] }, limitedBy: limitedMap(effective.limitedBy) };

  // team.list `proposals`: open cards of companies that do not exist yet (wire.js proposalList({ company: null, status: 'open' }))
  const listProposals = JSON.parse(JSON.stringify(P.list({ company: null, status: 'open' })));

  // team.crosstalk: runtime.crosstalk over the example log plus a chain (CEO -> Legal, Legal -> Tax answered, as a child)
  const { createRuntime } = require(path.join(ROOT, 'main', 'engine', 'team', 'runtime'));
  const ctLine = (dt, o) => { now += dt; store.append(CID, 'crosstalk', o); };
  const ceoAsk = { ticket: 't_fx1', chain: 't_fx1', from: { kind: 'ceo', sessionId: 's_ceo' }, to: 'legal', kind: 'report' };
  const legalAsk = { ticket: 't_fx2', parentTicket: 't_fx1', chain: 't_fx1', from: { kind: 'position', id: 'legal', sessionId: 's_legal' }, to: 'tax', kind: 'report' };
  ctLine(1000, { ...ceoAsk, state: 'asked', question: 'Does the returns page match the shop?' });
  ctLine(2000, { ...ceoAsk, state: 'delivered' });
  ctLine(30_000, { ...legalAsk, state: 'asked', question: 'Do refunds change the VAT we owe?' });
  ctLine(61_000, { ...legalAsk, state: 'answered', answer: 'Only for the quarter the refund lands in.', tookMs: 61_000, costUsd: 0.01 });
  const runtime = createRuntime({ store, clock: { now: () => now, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} } });
  const crosstalk = JSON.parse(JSON.stringify(runtime.crosstalk({ company: CID })));

  built = { root, company: CID, companyFolders: folders, shop, app, outside, proposals, access, effective, positionPayload, limitedMap,
    accessRows, listProposals, crosstalk, imported: importedFixtures() };
  return built;
}

// The import flow (team.proposals.import into an EMPTY team root): a company card + position cards for that company,
// then: approving a position card first (refused: the company does not exist yet), then the company card (creates it;
// the cards waiting on it get their excess). Every step is the engine's own output.
//   F.imported.result      P.import(...)                     { imported: [{ id, ref, action, target }], skipped }
//   F.imported.open        P.list({ status: 'open' })        the company card (company null) + 4 create cards (company '<new id>')
//   F.imported.early       decide(create, 'approve') before the company  -> { ok: false, error }
//   F.imported.earlyCard   that card afterwards (still open, with `error`)
//   F.imported.approved    decide(company, 'approve')        -> { ok: true, created: { company } }
//   F.imported.companyCard the company card afterwards (approved, company set, decision, result)
//   F.imported.after       P.list({ company: id, status: 'open' }) once the company exists (root cards carry excess)
//   F.imported.events      [event, data] emitted along the way;  F.imported.companyRecord  store.getCompany(id)
function importedFixtures() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-ui-team-imp-'));
  process.on('exit', () => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ } });
  const root = path.join(base, 'team');   // the team root; the company's folders sit beside it (never inside)
  const site = path.join(base, 'harbor-site').replace(/\\/g, '/');
  const oldSite = path.join(base, 'old-site').replace(/\\/g, '/');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(site, { recursive: true });
  let now = Date.parse('2026-11-17T13:00:00Z');
  const store = createTeamStore({ root, houseRulesDefault: '# House rules\n', now: () => now });
  const slices = new Map();
  const events = [];
  const P = createProposals({
    store, runtime: { list: () => [] }, clock: { now: () => (now += 1000) },
    state: { get: (n) => slices.get(n), set: (n, v) => slices.set(n, JSON.parse(JSON.stringify(v))) },
    sessions: { addCard: () => 'i1', patchCard: () => true, note: () => {}, ceoSessions: () => [], positionSession: () => null },
    emit: (e, d) => events.push([e, JSON.parse(JSON.stringify(d))]), notify: () => {}, onboard: () => {}, onApplied: () => {}, ownerName: 'Owner',
  });
  const NC = { read: ['$workspace', '$company'], write: ['$workspace'], tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'WebSearch'], bash: 'off', agents: false, worktree: false };
  const brief = (name) => `# ${name}\n\n## What this role covers\n${name} for Harbor Studio.\n`;
  const job = (o) => ({ team_propose: { action: 'create', brief: brief(o.name), powers: NC, ...o } });
  const file = { kind: 'helm-team-proposals', company: 'harbor-studio', draftedBy: 'a planning chat', proposals: [
    { ref: 'company', team_propose: { action: 'company', id: 'harbor-studio', name: 'Harbor Studio', folders: [site], why: 'A second business with its own site.' } },
    { ref: 'ops', ...job({ id: 'operations', name: 'Operations', parent: null, remit: 'Orders, suppliers and the weekly numbers.', why: 'Someone has to own the weekly numbers.' }) },
    { ref: 'books', ...job({ id: 'bookkeeping', name: 'Bookkeeping', parent: 'operations', remit: 'Invoices, receipts and the monthly close.', why: 'Receipts pile up every month.',
      duties: [{ id: 'monthly-close', title: 'Monthly close', enabled: true, trigger: { kind: 'schedule', cron: '0 9 1 * *', catchUp: 'once' }, prompt: 'Close last month.' }] }) },
    { ref: 'web', ...job({ id: 'web-copy', name: 'Web Copy', parent: null, remit: 'Copy for the studio site. Drafts only.', why: 'The site copy is out of date.',
      powers: { ...NC, read: [...NC.read, oldSite], bash: 'readonly' } }) },
    { ref: 'support', ...job({ id: 'support', name: 'Support', parent: 'operations', remit: 'Answers customer emails, from drafts the owner approves.', why: 'Customer emails need a first draft.' }) },
  ] };
  const result = P.import(file, {});
  if (result.skipped.length) throw new Error(`import fixture skipped: ${JSON.stringify(result.skipped)}`);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const open = clone(P.list({ status: 'open' }));
  const companyCardId = open.find((c) => c.action === 'company').id;
  const opsId = open.find((c) => c.target === 'operations').id;
  const early = clone(P.decide({ proposal: opsId, decision: 'approve', how: 'click' }));
  const earlyCard = clone(P.get(opsId));
  const mark = events.length;
  const approved = clone(P.decide({ proposal: companyCardId, decision: 'approve', how: 'click' }));
  return {
    root, site, oldSite, company: 'harbor-studio', file, result: clone(result), open, early, earlyCard, approved,
    companyCard: clone(P.get(companyCardId)), after: clone(P.list({ company: 'harbor-studio', status: 'open' })),
    companyRecord: clone(store.getCompany('harbor-studio')), events, approveEvents: events.slice(mark),
  };
}

module.exports = { engineFixtures, limitedMap, CID };
