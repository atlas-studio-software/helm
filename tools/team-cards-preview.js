// Positions: a gallery of every team card state, in the real mock app (lane T7 preview, docs/POSITIONS.md 10.4 / 11).
// The chat (ui/chat/index.js) does not dispatch to the team cards yet, so this harness renders them itself: it serves ui/
// like tools/serve-ui.js, with two in-memory changes:
//   /lib/transport.js   mockRpc() first asks window.__previewRpc (the gallery's fake engine: team.decide, team.ask.cancel, ...)
//   /, /index.html      a <script type="module" src="/__team-cards/gallery.js"> before </body>; that module is gallery() below
// The gallery opens a mock session as the CEO chat (A) and another as a position chat (B), hides the chat's own items and
// renders the cards (teamUnit / RequestItem) into the active .chat-col. window.__tcGroup('asker'|'approvals'|'answerer'|'states'|null)
// shows one group; window.__previewHold = true makes every faked call hang (the busy state).
// Usage:
//   node tools/team-cards-preview.js --serve [port]     serve only (default 4871; 0 = random), open http://127.0.0.1:PORT/?mock=1
//   node tools/team-cards-preview.js --shots <outDir>   playwright-core chromium: <group>-<width>.png at 1280 / 393 / 320 plus the
//                                                       interaction states at 1280 / 393; prints
//                                                       "team-cards-preview: N shots, M problems" and exits 1 on problems.
// CPU-heavy: run --shots on cloudtest (Linux), not on a low-RAM laptop.
const http = require('http');
const fs = require('fs');
const path = require('path');

const UI = path.join(__dirname, '..', 'ui');
const BG = path.join(UI, 'assets', 'backgrounds');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};
const RPC_HEAD = 'async function mockRpc(method, p = {}) {';
const RPC_HOOK = ' if (window.__previewRpc) { const r = await window.__previewRpc(method, p); if (r !== undefined) return r; }';
const GALLERY_TAG = '<script type="module" src="/__team-cards/gallery.js"></script>';

// ---------------------------------------------------------------------------------------------------------------------
// The gallery module. Never run in node: its source is served as /__team-cards/gallery.js and runs in the mock app.
// ---------------------------------------------------------------------------------------------------------------------
async function gallery() {
  const { render, Fragment } = await import('preact');
  const { signal } = await import('@preact/signals');
  const { html } = await import('/lib/html.js');
  const store = await import('/lib/store.js');
  const { openSession } = await import('/shell/state.js');
  const { teamUnit, SeedLine } = await import('/chat/team-cards.js');
  const { RequestItem } = await import('/chat/requests.js');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 300 && !(store.sessions.value || []).length; i++) await wait(50);
  const list = store.sessions.value || [];
  if (list.length < 2) throw new Error('team-cards gallery: the mock has fewer than two sessions');
  const A = list[0], B = list[1];
  const TEAM = { company: 'example-co', companyName: 'Example Co' };
  const POS = { company: 'example-co', companyName: 'Example Co', id: 'tax', name: 'Tax Specialist', parent: 'legal', parentName: 'Legal', chat: 2 };
  const patchSessions = () => {
    const cur = store.sessions.value || [];
    if (cur.some((s) => (s.id === A.id && !s.team) || (s.id === B.id && !s.position))) {
      store.sessions.value = cur.map((s) => (s.id === A.id ? { ...s, team: TEAM } : s.id === B.id ? { ...s, position: POS } : s));
    }
  };
  patchSessions();
  store.sessions.subscribe(() => patchSessions());

  // ---------- data ----------
  const T = Date.now(), S = 1000, M = 60 * S;
  const ANSWER_MD = 'Mostly, yes. The page names the crash reports and says they go to our error service, but it does not say how long we keep them.\n\n'
    + 'Two lines would close the gap. Nothing else in 1.3.0 collects new data.\n\n'
    + '- Add the 30-day retention to the **Crash reports** section\n- Link the opt-out toggle in Settings > Privacy\n- No change needed to the cookie list';
  const Q1 = 'Does the new privacy page cover the crash-report upload the app added in 1.3.0?';
  const ask = (id, extra) => ({ id, type: 'tool', name: 'mcp__team__team_ask', toolUseId: 'tu_' + id, status: 'running', startedAt: T - 2 * M,
    input: { to: 'legal', question: Q1 }, ...extra });
  // Every card below carries the ENGINE's payload shapes (test/host/fixtures/team-engine.js builds the same ones with the
  // real main/engine/team code; copied here because this runs in a browser):
  //   ask tool item  team: { ticket, state, detail, chain, company } (wire.js patchAsk); chain rows from runtime.js
  //                  snapshot(): { ticket, parentTicket, to, name, state, detail, sinceMs } (sinceMs = time in that state)
  //   proposal       proposals.js public card: { id, company, action, title, why, draft, diff?, excess?, status, by, target, parent }
  //   access         session.openRequest item: { type: 'request', kind: 'access', requestId, status, title, description,
  //                  access: { kind, target, why, position: { id, name, path }, ancestors?, outward, onceOnly?, warn?, waitMin } }
  //   duty / seed    user items: duty.trigger is duties.js triggerLabel's string; seed: { handoff, seeded } on a first message
  const row = (ticket, parentTicket, to, name, state, detail, sinceMs) => ({ ticket, parentTicket, to, name, state, detail, sinceMs });
  const root = (ticket, state, detail, sinceMs) => row(ticket, null, 'legal', 'Legal', state, detail, sinceMs);
  const tm = (ticket, state, detail, chain) => ({ ticket, state, detail, chain, company: 'example-co' });
  const answered = (ticket) => JSON.stringify({ status: 'answered', ticket, from: 'legal', answer: ANSWER_MD, took_s: 220 });
  const LONGQ = ('We are filing for contractors in four states this quarter and the seasonal staff were paid through two different payroll runs. '
    + 'Please check which of them need the state withholding forms, whether the quarterly estimated payments cover the new hires, and if any '
    + 'penalty notice from last year is still open. Name the exact files you read and say where you are unsure. ').repeat(2).slice(0, 600);
  const LONGN = 'Payroll tax for contractors and seasonal staff';
  const OK_WAIT = "waiting for the owner's OK on Tax Specialist's access request";
  const asker = [
    { type: 'divider', id: 'd-asker', text: "In the CEO's chat: questions" },
    ask('g-ask-queued', { startedAt: T - 40 * S, team: tm('t_q1', 'asked', 'queued: The owner is talking with Legal', [root('t_q1', 'asked', 'queued: The owner is talking with Legal', 40 * S)]) }),
    ask('g-ask-queued-busy', { startedAt: T - 25 * S, team: tm('t_q2', 'asked', 'queued: Legal is busy', [root('t_q2', 'asked', 'queued: Legal is busy', 25 * S)]) }),
    ask('g-ask-working', { team: tm('t_w1', 'delivered', 'working 2m', [root('t_w1', 'delivered', 'working 2m', 2 * M)]) }),
    ask('g-ask-chain', { startedAt: T - 6 * M, input: { to: 'legal', question: 'What do we owe in payroll tax for the seasonal staff this quarter?' },
      team: tm('t_c1', 'delivered', 'waiting on Tax Specialist', [
        root('t_c1', 'delivered', 'waiting on Tax Specialist', 6 * M),
        row('t_c2', 't_c1', 'tax', 'Tax Specialist', 'delivered', 'waiting on Payroll Tax', 4 * M),
        row('t_c3', 't_c2', 'payroll-tax', 'Payroll Tax', 'asked', 'queued: The owner is talking with Payroll Tax', 1 * M),
      ]) }),
    ask('g-ask-access', { startedAt: T - 9 * M, input: { to: 'legal', question: 'Are the contractor payments filed correctly for 2026?' },
      team: tm('t_a1', 'delivered', 'waiting on Tax Specialist', [
        root('t_a1', 'delivered', 'waiting on Tax Specialist', 9 * M),
        row('t_a2', 't_a1', 'tax', 'Tax Specialist', 'delivered', OK_WAIT, 3 * M),
      ]) }),
    ask('g-ask-pending', { status: 'done', startedAt: T - 32 * M, result: JSON.stringify({ status: 'pending', ticket: 't_p1' }),
      team: tm('t_p1', 'pending', 'working 32m', [root('t_p1', 'pending', 'working 32m', 32 * M)]) }),
    ask('g-ask-stopped', { status: 'error', interrupted: true, startedAt: T - 12 * M, result: 'Interrupted by the user',
      team: tm('t_s1', 'pending', 'working 12m', [root('t_s1', 'pending', 'working 12m', 12 * M)]) }),
    ask('g-ask-answered', { status: 'done', startedAt: T - 20 * M, result: answered('t_d1'),
      team: tm('t_d1', 'answered', 'answered in 3m 40s', [root('t_d1', 'answered', 'answered in 3m 40s', 16 * M)]) }),
    ask('g-ask-answered-open', { status: 'done', startedAt: T - 25 * M, result: answered('t_d2'),
      team: tm('t_d2', 'answered', 'answered in 3m 40s', [root('t_d2', 'answered', 'answered in 3m 40s', 21 * M),
        row('t_d3', 't_d2', 'tax', 'Tax Specialist', 'answered', 'answered in 1m 30s', 23 * M)]) }),
    ask('g-ask-late', { status: 'done', startedAt: T - 70 * M, result: JSON.stringify({ status: 'pending', ticket: 't_l1' }),
      team: tm('t_l1', 'late', 'answered in 41m (late)', [root('t_l1', 'late', 'answered in 41m (late)', 29 * M)]) }),
    ask('g-ask-refused', { status: 'done', startedAt: T - 3 * M, input: { to: 'finance', question: 'Can you confirm the Q3 tax total before I answer Tax Specialist?' },
      result: JSON.stringify({ status: 'refused', ticket: 't_r1', reason: 'Finance is waiting on you (through Tax Specialist). Answer with what you have.' }) }),
    ask('g-ask-cancelled', { status: 'done', startedAt: T - 15 * M, result: JSON.stringify({ status: 'pending', ticket: 't_x1' }),
      team: tm('t_x1', 'cancelled', 'cancelled', [root('t_x1', 'cancelled', 'cancelled', 14 * M)]) }),
    ask('g-ask-expired', { status: 'done', startedAt: T - 150 * M, result: JSON.stringify({ status: 'pending', ticket: 't_e1' }),
      team: tm('t_e1', 'expired', 'expired', [root('t_e1', 'expired', 'expired', 30 * M),
        row('t_e2', 't_e1', 'tax', 'Tax Specialist', 'expired', 'expired', 30 * M)]) }),
    { id: 'g-ask-colleague', type: 'tool', name: 'mcp__team__colleague_ask', toolUseId: 'tu_col', status: 'running', startedAt: T - 75 * S,
      input: { to: 'finance', question: 'What did we spend on ads in October?' },
      team: { ticket: 't_f1', state: 'delivered', detail: 'working 1m', company: 'example-co', chain: [row('t_f1', null, 'finance', 'Finance', 'delivered', 'working 1m', 75 * S)] } },
    ask('g-ask-stress', { startedAt: T - 48 * M, input: { to: 'legal', question: LONGQ },
      team: tm('st1', 'delivered', 'waiting on Tax Specialist', [
        root('st1', 'delivered', 'waiting on Tax Specialist', 48 * M),
        row('st2', 'st1', 'tax', 'Tax Specialist', 'delivered', `waiting on ${LONGN}`, 44 * M),
        row('st3', 'st2', 'payroll-tax', LONGN, 'delivered', 'waiting on State filings for contractors in every state we operate in', 40 * M),
        row('st4', 'st3', 'state-filings', 'State filings for contractors in every state we operate in', 'delivered', 'waiting on Quarterly estimated payments and penalty notices', 30 * M),
        row('st5', 'st4', 'estimates', 'Quarterly estimated payments and penalty notices', 'delivered', "waiting for the owner's OK on Quarterly estimated payments and penalty notices's access request", 20 * M),
        row('st6', 'st5', 'notices', 'Penalty notices archive for contractors and seasonal staff', 'asked', 'queued: waiting for a free slot (3 positions running)', 8 * M),
        row('st7', 'st2', 'finance', 'Finance', 'answered', 'answered in 5m', 38 * M),
        row('st8', 'st1', 'marketing', 'Marketing', 'expired', 'expired', 7 * M),
      ]) }),
    { id: 'g-team-answer', type: 'team', kind: 'answer', ts: T - 5 * M, answer: { ticket: 't_s1', from: 'Legal', text: ANSWER_MD } },
    { id: 'g-team-notice', type: 'team', kind: 'notice', ts: T - 4 * M, notice: { text: 'Tax Specialist created under Legal' } },
  ].map((x) => ({ ...x, _g: 'asker', _sid: A.id }));

  // proposals (proposals.js public cards, the shapes F.proposals.* has)
  const BRIEF = '# Payroll Tax\n\nPayroll tax filings for the company\'s two part-time staff: due dates, forms and amounts to set aside.\n\n'
    + 'You report to the Tax Specialist. Answer only payroll questions; send anything else back with "not my area".\n';
  const BRIEF_DIFF = ' # Payroll Tax\n \n Payroll tax filings for the company\'s two part-time staff: due dates, forms and amounts to set aside.\n \n'
    + ' You report to the Tax Specialist. Answer only payroll questions; send anything else back with "not my area".\n \n+## Contractors\n+- Withholding rules for contractors abroad.\n+';
  const POWERS = { read: ['$workspace', '$company'], write: ['$workspace'], tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'WebSearch', 'WebFetch'], bash: 'off', agents: false, worktree: false };
  const DUTY = { id: 'monthly-deadlines', title: 'Monthly deadlines', enabled: true, trigger: { kind: 'schedule', cron: '0 9 1 * *', catchUp: 'once' }, prompt: 'List the filings due this month.', output: 'report' };
  const createDraft = (more) => ({ id: 'state-payroll', name: 'State Payroll', parent: 'payroll-tax', remit: 'State payroll filings and their deadlines.',
    powers: POWERS, duties: [DUTY], scope: { kind: 'company' }, model: null, effort: 'high', brief: '# State Payroll\n\nState payroll filings and their deadlines.\n', ...more });
  const prop = (id, p) => ({ id, type: 'team', kind: 'proposal', ts: T - 3 * M,
    proposal: { id: 'p_' + id, company: 'example-co', by: { kind: 'ceo', sessionId: A.id }, status: 'open', at: new Date(T - 3 * M).toISOString(), ...p } });
  const create = (more = {}, p = {}) => ({ action: 'create', title: 'New position: State Payroll under Payroll Tax', why: 'State filings keep coming up in payroll questions.',
    draft: createDraft(more), target: more.id || 'state-payroll', parent: more.parent !== undefined ? more.parent : 'payroll-tax', ...p });
  const approvals = [
    { type: 'divider', id: 'd-approvals', text: "In the CEO's chat: proposals" },
    prop('g-prop-create', create({ powers: { ...POWERS, tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'] } })),
    prop('g-prop-excess', create({ powers: { ...POWERS, bash: 'on', agents: true } }, {
      excess: [{ power: 'tools', value: 'WebFetch', by: 'payroll-tax' }, { power: 'bash', value: 'on', max: 'off', by: 'legal' }, { power: 'agents', value: true, by: 'legal' }] })),
    prop('g-prop-edit', { action: 'edit', title: 'Change Payroll Tax', why: 'Contractor questions land on payroll anyway.', target: 'payroll-tax', parent: 'tax',
      draft: { id: 'payroll-tax', name: 'Payroll & Contractors', parent: 'tax', remit: 'Payroll tax and contractor withholding.', scope: { kind: 'product', folder: 'C:/Users/you/example-app' },
        status: 'active', model: null, effort: 'high', powers: { read: ['$workspace', '$company'], write: ['$workspace', '$scope'], tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'], bash: 'readonly', agents: false, worktree: false },
        duties: [{ id: 'quarterly-withholding', title: 'Quarterly withholding check', enabled: true, trigger: { kind: 'schedule', cron: '0 9 1 1,4,7,10 *', catchUp: 'once' }, prompt: 'Check the withholding tables.', output: 'report' }],
        brief: BRIEF + '\n## Contractors\n- Withholding rules for contractors abroad.\n' },
      diff: { brief: BRIEF_DIFF, powers: { added: ['write: $scope', 'bash: "readonly"'], removed: ['tools: WebSearch', 'bash: "off"'] }, duties: { added: ['quarterly-withholding'], removed: [] },
        name: { from: 'Payroll Tax', to: 'Payroll & Contractors' }, remit: { from: 'Payroll tax filings for the two part-time staff.', to: 'Payroll tax and contractor withholding.' },
        scope: { from: { kind: 'company' }, to: { kind: 'product', folder: 'C:/Users/you/example-app' } },
        excess: [{ power: 'write', value: 'C:/Users/you/example-app', by: 'legal' }, { power: 'bash', value: 'readonly', max: 'off', by: 'legal' }] },
      excess: [{ power: 'write', value: 'C:/Users/you/example-app', by: 'legal' }, { power: 'bash', value: 'readonly', max: 'off', by: 'legal' }] }),
    prop('g-prop-reparent', { action: 'edit', title: 'Change Tax Specialist', why: 'Tax answers to the CEO directly now.', target: 'tax', parent: null,
      draft: { id: 'tax', name: 'Tax Specialist', parent: null, remit: 'Sales tax and VAT questions for Example Co orders and payouts.', scope: { kind: 'company' }, status: 'active', model: null, effort: 'high', powers: POWERS, duties: [] },
      diff: { parent: { from: 'legal', to: null } } }),
    prop('g-prop-retire', { action: 'retire', title: 'Retire Tax Specialist (2 report(s) move up to Legal)', why: 'The tax work is done by the accountant now.', target: 'tax', parent: 'legal',
      draft: { id: 'tax', name: 'Tax Specialist', reports_on_retire: 'move-up', retires: ['tax'], moves: [{ id: 'payroll-tax', from: 'tax', to: 'legal' }, { id: 'state-filings', from: 'tax', to: 'legal' }] } }),
    prop('g-prop-company', { action: 'company', company: null, title: 'New company: Example Co', target: 'example-co', by: { kind: 'none', sessionId: A.id },
      draft: { id: 'example-co', name: 'Example Co', folders: ['C:/Users/you/example-co', 'C:/Users/you/example-app'] },
      why: 'You keep asking about the site and the app together; one company with a CEO can answer across both.' }),
    prop('g-prop-approved', create({ name: 'Marketing', id: 'marketing', parent: null }, { title: 'New position: Marketing under the CEO', status: 'approved', decision: { result: 'approved', at: T - 50 * M, how: 'click' } })),
    prop('g-prop-typed', create({ name: 'Finance', id: 'finance', parent: null }, { title: 'New position: Finance under the CEO', status: 'approved', decision: { result: 'approved', at: T - 40 * M, how: 'typed', quote: 'yes, make it' } })),
    prop('g-prop-declined', create({}, { status: 'declined', decision: { result: 'declined', at: T - 30 * M, how: 'click', note: 'Not until the books are closed' } })),
    prop('g-prop-superseded', { action: 'edit', title: 'Change Payroll Tax', target: 'payroll-tax', draft: { id: 'payroll-tax', name: 'Payroll Tax' }, diff: { remit: { from: 'a', to: 'b' } }, status: 'superseded', decision: { at: T - 20 * M } }),
  ].map((x) => ({ ...x, _g: 'approvals', _sid: A.id }));

  const askText = (from, kind, body, more = '') => `<helm-ask ticket="t_4f1e" from="${from}" kind="${kind}" reply-by="14:32"${more}>\n${body}\n</helm-ask>\n`
    + 'Answer this question in your reply. Helm sends your reply back to the asker; you do not need a tool for it.';
  const HANDED = 'Handed to you (read-only for this question): C:/Users/you/example-co/site/privacy.html, C:/Users/you/example-co/CHANGELOG.md';
  const LONGBODY = Array.from({ length: 30 }, (_, i) => `${i + 1}. Check the ${['payroll run', 'contractor invoice', 'state form', 'quarterly estimate', 'penalty notice'][i % 5]} for item ${i + 1} against the ledger and note any difference over ten dollars.`).join('\n');
  const LONGASK = askText('CEO (Example Co)', 'report', (LONGBODY + '\n' + 'Say where you are unsure. '.repeat(40)).slice(0, 2500));
  // access.js openCard's item (session.openRequest); position.path = names from the top-level manager down to itself
  const TAXP = { id: 'tax', name: 'Tax Specialist', path: ['Legal', 'Tax Specialist'] };
  const PAYP = { id: 'payroll-tax', name: 'Payroll Tax', path: ['Legal', 'Tax Specialist', 'Payroll Tax'] };
  const acc = (id, access, more) => ({ id, type: 'request', kind: 'access', requestId: 'rq_' + id, toolName: 'request_access', input: {}, status: 'pending', ts: T - 2 * M,
    access: { position: TAXP, outward: false, waitMin: 30, ...access }, ...more });
  const answerer = [
    { type: 'divider', id: 'd-answerer', text: "In Tax Specialist's chat" },
    { id: 'g-seed-own', type: 'user', ts: T - 65 * M, text: 'Pick up the Q3 payroll check where the last chat stopped.', seed: { handoff: true, seeded: true }, _own: true },
    { id: 'g-seed', type: 'user', origin: 'ask', ts: T - 60 * M, seed: { handoff: false, seeded: true }, ask: { ticket: 't_3a0c', from: { kind: 'ceo', id: null, name: 'CEO' }, kind: 'report', handed: [] },
      text: askText('CEO (Example Co)', 'report', 'Which payroll forms are due before the end of the month?') },
    { id: 'g-by-ceo', type: 'user', origin: 'ask', ts: T - 50 * M, ask: { ticket: 't_4f1e', from: { kind: 'ceo', id: null, name: 'CEO' }, kind: 'report', handed: [] },
      text: askText('CEO (Example Co)', 'report', `${Q1}\n${HANDED}`) },
    { id: 'g-by-legal', type: 'user', origin: 'ask', ts: T - 45 * M, ask: { ticket: 't_5a2b', from: { kind: 'position', id: 'legal', name: 'Legal' }, kind: 'report', handed: [] },
      text: askText('Legal', 'report', 'Which payroll forms are due before the end of the month?') },
    { id: 'g-by-finance', type: 'user', origin: 'ask', ts: T - 40 * M, ask: { ticket: 't_6c3d', from: { kind: 'position', id: 'finance', name: 'Finance' }, kind: 'colleague', handed: [] },
      text: askText('Finance', 'colleague', 'Is the October tax payment already in the ledger, or should I hold it?') },
    { id: 'g-duty', type: 'user', origin: 'duty', ts: T - 35 * M, duty: { id: 'monthly-deadlines', title: 'Monthly deadlines', trigger: 'schedule 0 9 1 * *' },
      text: '<helm-duty id="monthly-deadlines">\nList the filings due this month and what each needs.\n</helm-duty>' },
    { id: 'g-duty-commit', type: 'user', origin: 'duty', ts: T - 33 * M, duty: { id: 'release-notes', title: 'Release notes check', trigger: 'commit C:/Users/you/example-app main' },
      text: '<helm-duty id="release-notes">\nCheck the new commits for anything the privacy page should mention.\n</helm-duty>' },
    { id: 'g-duty-onboarding', type: 'user', origin: 'duty', ts: T - 64 * M, duty: { id: 'onboarding', title: 'Onboarding', trigger: { kind: 'onboarding' } },
      text: 'Read your brief and the company folders, then write what you learned to your notebook.' },
    { id: 'g-ans-late', type: 'user', origin: 'answer', ts: T - 30 * M, text: `<helm-answer ticket="t_1" from="legal">\n${ANSWER_MD}\n</helm-answer>` },
    { id: 'g-ans-expired', type: 'user', origin: 'answer', ts: T - 25 * M, text: '<helm-answer ticket="t_2" from="legal" state="expired">\nLegal did not answer within 2 hours. Go on with what you have.\n</helm-answer>' },
    { id: 'g-ans-followup', type: 'user', origin: 'answer', ts: T - 20 * M, text: '<helm-answer ticket="t_3" from="legal" kind="followup" via="tax">\nOne more thing: the **state filings** are due on the 15th, not the 30th.\n</helm-answer>' },
    { id: 'g-by-long', type: 'user', origin: 'ask', ts: T - 15 * M, ask: { ticket: 't_7e4f', from: { kind: 'ceo', id: null, name: 'CEO' }, kind: 'report', handed: [] }, text: LONGASK },
    { type: 'divider', id: 'd-access', text: 'Access requests' },
    acc('g-acc-read', { kind: 'read', target: 'C:/Users/you/.claude/settings.json', why: 'To see which model the CLI defaults to.', ancestors: ['legal'], onceOnly: true, warn: true },
      { title: 'Tax Specialist asks for read access', description: 'C:/Users/you/.claude/settings.json\nTo see which model the CLI defaults to.\nNote: this is inside ~/.claude (Claude settings and history).' }),
    acc('g-acc-write', { kind: 'write', target: 'C:/Users/you/example-co/site/privacy.html', why: 'Add the 30-day retention line Legal asked for.', ancestors: ['legal'] }),
    acc('g-acc-tool', { kind: 'tool', target: 'WebFetch', why: 'Read the state tax office page for the new due dates.' }),
    acc('g-acc-bash', { kind: 'bash', target: 'bash:readonly', why: 'To list the payroll exports.', position: PAYP, ancestors: ['tax', 'legal'] }),
    acc('g-acc-outward', { kind: 'outward', outward: true, target: 'git push origin main', why: 'Leaves the machine: push', command: 'git push origin main' },
      { toolName: 'Bash', input: { command: 'git push origin main', description: 'Push the release branch' } }),
    acc('g-acc-rec-once', { kind: 'read', target: 'C:/Users/you/example-co/finance/payroll-2026.csv', why: 'Q3 numbers.' }, { status: 'answered', answer: { behavior: 'allow', scope: 'once' } }),
    acc('g-acc-rec-always', { kind: 'bash', target: 'bash:readonly', why: 'Payroll exports.', position: PAYP, ancestors: ['tax', 'legal'] }, { status: 'answered', answer: { behavior: 'allow', scope: 'always' } }),
    acc('g-acc-rec-onceonly', { kind: 'read', target: 'C:/Users/you/.claude/settings.json', why: 'CLI model.', onceOnly: true, warn: true }, { status: 'answered', answer: { behavior: 'allow', scope: 'always' } }),
    acc('g-acc-rec-deny', { kind: 'bash', target: 'bash:on', why: 'Export script.' }, { status: 'answered', answer: { behavior: 'deny', message: 'Not this week' } }),
    acc('g-acc-rec-timeout', { kind: 'write', target: 'C:/Users/you/example-co/site/privacy.html', why: 'Retention line.' }, { status: 'cancelled', answer: { timedOut: true } }),
  ].map((x) => ({ ...x, _g: 'answerer', _sid: B.id }));

  // the interaction-state group: proposals and access cards the harness hovers, focuses, presses and clicks
  const states = [
    { type: 'divider', id: 'd-states', text: 'Interaction states' },
    prop('g-st-prop1', create()),
    prop('g-st-prop2', create({ name: 'Payroll Clerk', id: 'payroll-clerk' }, { title: 'New position: Payroll Clerk under Payroll Tax' })),
    prop('g-st-prop3', create({ name: 'Marketing', id: 'marketing', parent: null }, { title: 'New position: Marketing under the CEO' })),
  ].map((x) => ({ ...x, _g: 'states', _sid: A.id })).concat([
    acc('g-st-acc1', { kind: 'tool', target: 'WebFetch', why: 'Read the state tax office page for the new due dates.' }),
    acc('g-st-acc2', { kind: 'read', target: 'C:/Users/you/example-co/finance/payroll-2026.csv', why: 'The Q3 numbers are in this file.', ancestors: ['legal'] }),
  ].map((x) => ({ ...x, _g: 'states', _sid: B.id })));

  const items = signal([...asker, ...approvals, ...answerer, ...states]);
  const group = signal(null);
  const reqIds = new Set(items.value.filter((x) => x.type === 'request').map((x) => x.requestId));

  // ---------- the fake engine ----------
  const never = () => new Promise(() => {});
  window.__previewRpc = async (method, p) => {
    const faked = method === 'team.decide' || method === 'team.ask.cancel' || method === 'team.ask.release' || method === 'team.answer.forward' || method === 'team.open'
      || (method === 'sessions.respond' && reqIds.has(p.requestId)) || (method === 'sessions.send' && (p.id === A.id || p.id === B.id));
    if (!faked) return undefined;
    if (window.__previewHold) return never();
    if (method === 'team.decide') { await wait(600); return { ok: true }; }
    if (method === 'team.ask.cancel') return { state: 'cancelled' };
    if (method === 'team.ask.release') return { state: 'queued' };
    if (method === 'team.answer.forward') return { itemId: 'x' };
    if (method === 'team.open') return { sessionId: A.id };
    if (method === 'sessions.respond') {
      items.value = items.value.map((x) => (x.requestId === p.requestId ? { ...x, status: 'answered', answer: p.response } : x));
      return {};
    }
    return {};   // sessions.send (the Change… box)
  };
  window.__tcGroup = (name) => { group.value = name || null; };
  window.__tcItems = items;

  // ---------- render ----------
  function Gallery() {
    const g = group.value;
    return items.value.filter((x) => !g || x._g === g).map((x) => {
      if (x.type === 'divider') return html`<div class="sys-divider" key=${x.id} data-item-id=${x.id}><span>${x.text}</span></div>`;
      if (x.type === 'request') return html`<${Fragment} key=${x.id}><${RequestItem} item=${x} sid=${x._sid} cwd="C:/Users/you/example-co" /></${Fragment}>`;
      // the owner's own first message: index.js renders SeedLine + its UserMsg (not exported); the bubble here borrows its classes
      if (x._own) return html`<${Fragment} key=${x.id}><${SeedLine} item=${x} /><div class="msg-user" data-item-id=${x.id}><div class="bubble">${x.text}</div></div></${Fragment}>`;
      const v = teamUnit(x, x._sid);
      return html`<${Fragment} key=${x.id}>${v || html`<div class="tc-missing" data-item-id=${x.id}>teamUnit returned null for ${x.id}</div>`}</${Fragment}>`;
    });
  }
  const style = document.createElement('style');
  style.textContent = '.chat-col > :not(.tc-gallery) { display: none !important; } .tc-gallery { display: flex; flex-direction: column; gap: 14px; min-width: 0; }';
  document.head.appendChild(style);
  const host = document.createElement('div');
  host.className = 'tc-gallery';
  openSession(A.id);
  const mount = () => {
    if (host.isConnected) return true;
    const col = document.querySelector('.chat-col');
    if (!col) return false;
    col.appendChild(host);
    return true;
  };
  for (let i = 0; i < 300 && !mount(); i++) await wait(50);
  if (!host.isConnected) throw new Error('team-cards gallery: no .chat-col to render into');
  render(html`<${Gallery} />`, host);
  setInterval(mount, 250);   // the chat may re-render its column: put the gallery back
  window.__tcReady = { A: A.id, B: B.id };
}

const GALLERY_JS = `// team-cards gallery (tools/team-cards-preview.js)\n(${gallery.toString()})().catch((e) => { window.__tcError = String(e && e.stack || e); console.error(e); });\n`;

// ---------------------------------------------------------------------------------------------------------------------
// static server (tools/serve-ui.js, plus the two in-memory changes)
// ---------------------------------------------------------------------------------------------------------------------
function startServer(port, { live = false } = {}) {
  const clients = new Set();
  if (live) {
    let timer = null;
    fs.watch(UI, { recursive: true }, (_e, name) => {
      if (!name || name.includes('backgrounds')) return;
      clearTimeout(timer);
      timer = setTimeout(() => { for (const res of clients) res.write(`data: ${JSON.stringify({ file: name })}\n\n`); }, 300);
    });
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__live') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': hi\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/__team-cards/gallery.js') {
      res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
      res.end(GALLERY_JS);
      return;
    }
    const base = url.pathname.startsWith('/bg/') ? BG : UI;
    const rel = url.pathname.startsWith('/bg/') ? url.pathname.slice(3) : url.pathname;
    let file = path.normalize(path.join(base, decodeURIComponent(rel)));
    if (!file.startsWith(base)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      let body = buf;
      if (file === path.join(UI, 'lib', 'transport.js')) {
        const s = buf.toString('utf8');
        if (!s.includes(RPC_HEAD)) console.error('team-cards-preview: mockRpc() not found in lib/transport.js; the fake engine is not hooked');
        body = s.replace(RPC_HEAD, RPC_HEAD + RPC_HOOK);
      } else if (file === path.join(UI, 'index.html')) {
        const s = buf.toString('utf8');
        body = s.includes('</body>') ? s.replace('</body>', `${GALLERY_TAG}\n</body>`) : s + GALLERY_TAG;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// ---------------------------------------------------------------------------------------------------------------------
// shots
// ---------------------------------------------------------------------------------------------------------------------
const GROUPS = ['asker', 'approvals', 'answerer'];
const WIDTHS = [1280, 393, 320];
const STATE_WIDTHS = [1280, 393];
const BASE_H = { 1280: 900, 393: 852, 320: 640 };

// runs in the page: layout checks for the visible gallery
function pageChecks(width) {
  const out = [];
  const se = document.scrollingElement;
  if (se.scrollWidth > se.clientWidth) out.push(`document overflows horizontally: scrollWidth ${se.scrollWidth} > clientWidth ${se.clientWidth}`);
  const col = document.querySelector('.chat-col');
  const gal = document.querySelector('.tc-gallery');
  if (!col || !gal) { out.push('no .chat-col / .tc-gallery'); return out; }
  const cs = getComputedStyle(col), cr = col.getBoundingClientRect();
  const right = cr.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const label = (el) => {
    const id = el.closest('[data-item-id]')?.getAttribute('data-item-id') || el.closest('[data-request-id]')?.getAttribute('data-request-id') || '?';
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).slice(0, 2).join('.');
    return `${id} ${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`;
  };
  const cards = new Set([...gal.children, ...gal.querySelectorAll('.req-card, .msg-ask, .tc-rec-wrap, .req-record')]);
  for (const el of cards) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > right + 0.5) out.push(`card past the column: ${label(el)} right ${Math.round(r.right)} > ${Math.round(right)}`);
    if (r.left < cr.left + parseFloat(cs.paddingLeft) - 0.5) out.push(`card left of the column: ${label(el)} left ${Math.round(r.left)}`);
  }
  if (width <= 820) {
    for (const b of gal.querySelectorAll('.req-actions .btn, .tc-rec-btn')) {
      if (!vis(b)) continue;
      const h = b.getBoundingClientRect().height;
      if (h < 44) out.push(`touch target under 44 px: ${label(b)} "${b.textContent.trim().slice(0, 40)}" ${Math.round(h)} px`);
    }
  }
  for (const b of gal.querySelectorAll('button')) {
    if (!vis(b)) continue;
    if (b.scrollWidth > b.clientWidth + 1) out.push(`button text overflows: ${label(b)} "${b.textContent.trim().slice(0, 40)}" ${b.scrollWidth} > ${b.clientWidth}`);
  }
  for (const m of gal.querySelectorAll('.tc-missing')) out.push(m.textContent);
  return out;
}

async function shots(outDir) {
  try { require('./lowcpu-optional'); } catch { /* not on this machine: cloud runner */ }
  const { chromium } = require('playwright-core');
  fs.mkdirSync(outDir, { recursive: true });
  const server = await startServer(0);
  const url = `http://127.0.0.1:${server.address().port}/?mock=1`;
  // HELM_SHOT_CHANNEL wins; on CI (GitHub's runners have Chrome, not Playwright's download) the 'chrome' channel, as
  // tools/positions-shots.js does; else the bundled Chromium
  const channel = process.env.HELM_SHOT_CHANNEL || (process.env.CI ? 'chrome' : null);
  const browser = await chromium.launch(channel ? { channel } : {});
  let nShots = 0;
  const problems = [];
  try {
    for (const width of WIDTHS) {
      const page = await browser.newPage({ viewport: { width, height: BASE_H[width] }, deviceScaleFactor: 1 });
      let errs = [];
      page.on('pageerror', (e) => errs.push(`page error: ${e && e.stack ? e.stack : e}`));
      page.on('console', (m) => { if (m.type() === 'error') errs.push(`console error: ${m.text()}${m.location()?.url ? ` (${m.location().url})` : ''}`); });
      await page.goto(url, { waitUntil: 'networkidle' });
      try { await page.waitForFunction(() => window.__tcReady || window.__tcError, null, { timeout: 20000 }); } catch { /* reported below */ }
      const gErr = await page.evaluate(() => window.__tcError || (window.__tcReady ? '' : 'gallery never became ready'));
      if (gErr) { problems.push(`[${width}] gallery failed: ${gErr}`); console.log(`[${width}] gallery failed: ${gErr}`); for (const e of errs) console.log('  ' + e); await page.close(); continue; }
      await page.waitForTimeout(500);
      // expand the second answered card (its disclosure)
      const opened = await page.evaluate(() => {
        window.__tcGroup('asker');
        const b = document.querySelector('[data-item-id="g-ask-answered-open"] [data-act="ask-toggle"], [data-item-id="g-ask-answered-open"][data-act="ask-toggle"]');
        if (b) b.click();
        return !!b;
      });
      if (!opened) problems.push(`[${width}] no [data-act="ask-toggle"] on g-ask-answered-open`);

      const shoot = async (name, opts = {}) => {
        await page.waitForTimeout(opts.settle ?? 250);
        if (opts.fit !== false) {
          for (let i = 0; i < 3; i++) {
            const extra = await page.evaluate(() => { const s = document.querySelector('.chat-scroll'); if (!s) return 0; s.scrollTop = 0; return s.scrollHeight - s.clientHeight; });
            const vh = page.viewportSize().height;
            if (extra <= 0 || vh >= 7000) break;
            await page.setViewportSize({ width, height: Math.min(7000, vh + extra) });
            await page.waitForTimeout(150);
          }
          await page.evaluate(() => { const s = document.querySelector('.chat-scroll'); if (s) s.scrollTop = 0; });
        }
        const file = path.join(outDir, `${name}.png`);
        await page.screenshot({ path: file });
        nShots++;
        const found = [...(await page.evaluate(pageChecks, width)), ...errs];
        errs = [];
        console.log(`shot ${name}.png (${width}x${page.viewportSize().height}): ${found.length} problem${found.length === 1 ? '' : 's'}`);
        for (const f of found) { console.log('  - ' + f); problems.push(`${name}: ${f}`); }
      };
      for (const g of GROUPS) {
        await page.setViewportSize({ width, height: BASE_H[width] });
        await page.evaluate((g) => window.__tcGroup(g), g);
        await shoot(`${g}-${width}`, { settle: 400 });
      }
      if (STATE_WIDTHS.includes(width)) await stateShots(page, width, shoot, problems);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`team-cards-preview: ${nShots} shots, ${problems.length} problems`);
  for (const p of problems) console.log('  ' + p);
  process.exit(problems.length ? 1 : 0);
}

async function stateShots(page, width, shoot, problems) {
  await page.setViewportSize({ width, height: BASE_H[width] });
  await page.evaluate(() => { window.__previewHold = false; window.__tcGroup('states'); });
  await page.waitForTimeout(400);
  const sel = (id, act) => `[data-item-id="${id}"] [data-act="${act}"], [data-request-id="rq_${id}"] [data-act="${act}"]`;
  const need = async (s, what) => { const n = await page.locator(s).count(); if (!n) problems.push(`states-${width}: missing ${what} (${s})`); return n > 0; };
  // fit the group first, so every card is on screen for each state
  const fit = async () => {
    for (let i = 0; i < 3; i++) {
      const extra = await page.evaluate(() => { const s = document.querySelector('.chat-scroll'); if (!s) return 0; s.scrollTop = 0; return s.scrollHeight - s.clientHeight; });
      const vh = page.viewportSize().height;
      if (extra <= 0 || vh >= 7000) break;
      await page.setViewportSize({ width, height: Math.min(7000, vh + extra) });
      await page.waitForTimeout(150);
    }
  };
  await fit();
  const approve1 = sel('g-st-prop1', 'proposal-approve');
  if (await need(approve1, 'Approve on the first proposal')) {
    await page.hover(approve1);
    await shoot(`states-${width}-hover`, { fit: false });
  }
  // keyboard focus ring on Change…: focus Approve, then Tab (keyboard modality, so :focus-visible applies)
  const change1 = sel('g-st-prop1', 'proposal-change');
  if (await need(change1, 'Change… on the first proposal')) {
    await page.mouse.move(1, 1);
    await page.focus(approve1);
    await page.keyboard.press('Tab');
    const ok = await page.evaluate(() => { const a = document.activeElement; return !!a && a.getAttribute('data-act') === 'proposal-change' && a.matches(':focus-visible'); });
    if (!ok) problems.push(`states-${width}: Tab from Approve did not land on Change… with :focus-visible`);
    await shoot(`states-${width}-focus`, { fit: false });
  }
  // pressed: mouse down on Decline, shoot, release away from it
  const decline1 = sel('g-st-prop1', 'proposal-decline');
  if (await need(decline1, 'Decline on the first proposal')) {
    const box = await page.locator(decline1).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await shoot(`states-${width}-pressed`, { fit: false, settle: 120 });
    await page.mouse.move(1, 1);
    await page.mouse.up();
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
  }
  // busy: hold the fake engine, click Approve on the second proposal and Approve once on the first access card
  await page.evaluate(() => { window.__previewHold = true; });
  const approve2 = sel('g-st-prop2', 'proposal-approve');
  const once1 = sel('g-st-acc1', 'access-once');
  if (await need(approve2, 'Approve on the second proposal')) await page.click(approve2);
  if (await need(once1, 'Approve once on the first access card')) await page.click(once1);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(200);
  const busy = await page.evaluate(() => {
    const card = document.querySelector('[data-item-id="g-st-prop2"]');
    const acc = document.querySelector('[data-request-id="rq_g-st-acc1"]');
    const all = (el) => !!el && [...el.querySelectorAll('.req-actions button')].every((b) => b.disabled);
    return { prop: !!card?.querySelector('.spinner') && all(card), acc: !!acc?.querySelector('.spinner') && all(acc) };
  });
  if (!busy.prop) problems.push(`states-${width}: the held proposal shows no spinner or has an enabled button`);
  if (!busy.acc) problems.push(`states-${width}: the held access card shows no spinner or has an enabled button`);
  await shoot(`states-${width}-busy`, { fit: false });
  // done: hold off, approve the third proposal and the second access card
  await page.evaluate(() => { window.__previewHold = false; });
  const approve3 = sel('g-st-prop3', 'proposal-approve');
  const once2 = sel('g-st-acc2', 'access-once');
  if (await need(approve3, 'Approve on the third proposal')) await page.click(approve3);
  if (await need(once2, 'Approve once on the second access card')) await page.click(once2);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(700);
  const done = await page.evaluate(() => ({
    prop: document.querySelector('[data-item-id="g-st-prop3"]')?.getAttribute('data-state') || '',
    propText: document.querySelector('[data-item-id="g-st-prop3"]')?.textContent.trim().slice(0, 80) || '',
    acc: !!document.querySelector('[data-request-id="rq_g-st-acc2"] .req-actions'),
  }));
  if (done.prop !== 'approved') problems.push(`states-${width}: third proposal is "${done.prop}" after 700 ms, not approved (${done.propText})`);
  if (done.acc) problems.push(`states-${width}: second access card still shows its buttons after Approve once`);
  await shoot(`states-${width}`, { settle: 100 });
}

// ---------------------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv[0] === '--serve') {
  const port = Number(argv[1] ?? 4871);
  startServer(port, { live: true }).then((s) => console.log(`team cards on http://127.0.0.1:${s.address().port}/?mock=1`));
} else if (argv[0] === '--shots') {
  shots(argv[1] || path.join(__dirname, '..', '.shots', 'team-cards')).catch((e) => {
    console.log(`team-cards-preview: 0 shots, 1 problems\n  harness crashed: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  });
} else {
  console.log('usage: node tools/team-cards-preview.js --serve [port] | --shots <outDir>');
  process.exit(2);
}
