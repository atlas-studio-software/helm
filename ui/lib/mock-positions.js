// Mock for Positions (lane T6): every team.* RPC and event in ?mock=1, over a FICTIONAL company, in the ENGINE's shapes
// (main/engine/team/wire.js, proposals.js, tree.js, access.js, runtime.js): proposal cards as proposals.js keeps them
// (`excess`, an edit's `diff`, `decision`), team.position's `effective` (expanded absolute paths, workspace first,
// `limits`) and `limitedBy` map, access request rows, and team.crosstalk's folded entries (one per ticket, ISO times,
// newest first). test/host/positions-engine-shapes.test.js compares these payloads key by key with the real engine's,
// so an engine rename fails a test instead of hiding behind this mock. The power rules (tree.js effective / excess)
// and proposals.js editDiff are small ports below, so every position's powers and every card's diff are computed.
// "Example Co" has a 3-level tree with one position working, one waiting on an access request, two open proposals (a
// new report listing powers beyond its manager's, an edit with a brief diff), a duty due within the day, a live ask
// chain and logged cross-talk; "Harbor Books" exists so the company switcher shows.
// No real people, folders or projects: paths are C:/Users/you/... placeholders (Helm ships open source).
//
// Wiring: ui/lib/transport.js (lane T10) adds one line to mockRpc's switch, before `default`:
//   if (method.startsWith('team.')) ...  or  case 'team.list': case 'team.get': ... :
//     return (await import('./mock-positions.js')).mockTeam(method, p, { state: S, emit });
// ?team=<mode> picks a state: one (single company), empty (no company), off (team disabled), root (team root
// refused), nopositions, error (team.get fails), loading (team.list never answers), conflict (the first file
// save conflicts), deep (two more levels under Payroll Tax, so depth 4 and 5 exist and the phone's
// "… › Manager ›" crumb shows), imported (no company yet: an import left a company card, company null, and four
// position cards for that company; approving a position card first is refused the way the engine refuses it,
// approving the company card creates the company). tools/positions-preview.js uses createMockTeam() directly.

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const HOME = 'C:/Users/you';
const TEAM_ROOT = `${HOME}/helm-team`;
const iso = (t) => new Date(t).toISOString();
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const workspaceOf = (cid, id) => `${TEAM_ROOT}/${cid}/positions/${id}`;   // store.workspaceOf

// ---------------------------------------------------------------- engine ports
// tree.js: effective(p) = own(p) ∩ effective(parent); the CEO level holds every company folder and tool. A position's
// own workspace is personal (always its own, never inherited). limitedBy / excess: [{ power, value, by, max?, kept? }],
// by = the highest level that lacks it ('company' = the CEO level: beyond the company folders).
const BASH_RANK = { off: 0, readonly: 1, on: 2 }, RANK_BASH = ['off', 'readonly', 'on'];
const AGENT_TOOLS = ['Agent', 'Task'];
const CEO_BY = 'company';
function normPath(p) {
  let s = String(p).replace(/\\/g, '/');
  if (s === '~' || s.startsWith('~/')) s = HOME + s.slice(1);
  if (s.endsWith('/**') && s.length > 3) s = s.slice(0, -3);
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}
const pkey = (p) => normPath(p).toLowerCase();
const hasGlob = (s) => /[*?[\]{}]/.test(s);
const globBase = (p) => { const segs = p.split('/'); const i = segs.findIndex(hasGlob); return i < 0 ? p : segs.slice(0, i).join('/') || '/'; };
const isUnder = (a, b) => { const x = pkey(a), y = pkey(b); return x === y || x.startsWith(y.endsWith('/') ? y : `${y}/`); };
const subset = (x, s) => pkey(x) === pkey(s) || (!hasGlob(s) && isUnder(hasGlob(x) ? globBase(x) : x, s));
const covered = (x, set) => set.some((s) => subset(x, s));
function intersectPaths(own, limit) {
  const out = [], seen = new Set();
  const add = (p) => { const k = pkey(p); if (!seen.has(k)) { seen.add(k); out.push(p); } };
  for (const o of own) { if (covered(o, limit)) add(o); else for (const l of limit) if (subset(l, o)) add(l); }
  return out;
}
function expandTokens(list, { workspace, folders, scopeFolder }) {
  const out = [], seen = new Set();
  const push = (p) => { const n = normPath(p), k = pkey(n); if (n && !seen.has(k)) { seen.add(k); out.push(n); } };
  for (const e of Array.isArray(list) ? list : []) {
    if (e === '$workspace') { if (workspace) push(workspace); }
    else if (e === '$company') folders.forEach(push);
    else if (e === '$scope') (scopeFolder ? [scopeFolder] : folders).forEach(push);
    else if (typeof e === 'string' && !e.startsWith('$')) push(e);
  }
  return out;
}
function ownExpanded(p, folders, workspace) {
  const pw = p.powers || {};
  const c = { workspace, folders, scopeFolder: p.scope && p.scope.kind === 'product' ? p.scope.folder : null };
  const strip = (list) => expandTokens(list, c).filter((x) => !(workspace && pkey(x) === pkey(workspace)));
  return { read: strip(pw.read), write: strip(pw.write), tools: (pw.tools || []).slice(), bash: pw.bash || 'off', agents: pw.agents === true, worktree: pw.worktree === true };
}
const ROOT_LEVEL = (folders) => { const f = expandTokens(['$company'], { folders }); return { read: f, write: f, tools: '*', bash: 'on', agents: true, worktree: true }; };
function meet(own, lim) {
  const agents = own.agents && lim.agents;
  const bash = RANK_BASH[Math.min(BASH_RANK[own.bash] ?? 0, BASH_RANK[lim.bash] ?? 0)];
  let tools = lim.tools === '*' ? own.tools.slice() : own.tools.filter((t) => lim.tools.includes(t));
  if (!agents) tools = tools.filter((t) => !AGENT_TOOLS.includes(t));
  if (bash === 'off') tools = tools.filter((t) => t !== 'Bash' && t !== 'PowerShell');
  return { read: intersectPaths(own.read, lim.read), write: intersectPaths(own.write, lim.write), tools, bash, agents, worktree: own.worktree && lim.worktree };
}
function containsPower(eff, power, value) {
  if (power === 'read' || power === 'write') return covered(value, eff[power]);
  if (power === 'tools') return eff.tools === '*' || eff.tools.includes(value);
  if (power === 'bash') return (BASH_RANK[eff.bash] ?? 0) >= (BASH_RANK[value] ?? 0);
  return eff[power] === true || !value;
}
function diffAgainst(own, levels) {
  const out = [];
  const firstCut = (power, value) => { for (const l of levels) if (!containsPower(l.eff, power, value)) return l.by; return null; };
  const lim = levels[levels.length - 1].eff;
  for (const power of ['read', 'write']) {
    for (const x of own[power]) {
      if (covered(x, lim[power])) continue;
      const kept = lim[power].filter((l) => subset(l, x));
      out.push({ power, value: x, by: firstCut(power, x), ...(kept.length ? { kept } : {}) });
    }
  }
  for (const t of own.tools) {
    let by = containsPower(lim, 'tools', t) ? null : firstCut('tools', t);
    if (!by && AGENT_TOOLS.includes(t) && !lim.agents) by = firstCut('agents', true);
    if (!by && (t === 'Bash' || t === 'PowerShell') && lim.bash === 'off') by = firstCut('bash', 'readonly');
    if (by) out.push({ power: 'tools', value: t, by });
  }
  if ((BASH_RANK[own.bash] ?? 0) > (BASH_RANK[lim.bash] ?? 0)) out.push({ power: 'bash', value: own.bash, max: lim.bash, by: firstCut('bash', own.bash) });
  for (const power of ['agents', 'worktree']) if (own[power] && !lim[power]) out.push({ power, value: true, by: firstCut(power, true) });
  return out;
}
// the levels above a position: the CEO, then each manager (farthest first), each the meet of its own and the one above
function levelsAbove(all, id, folders, cid) {
  const chain = [];
  for (let a = all[id] && all[id].parent; a != null && all[a] && chain.length < 50; a = all[a].parent) chain.push(a);
  let eff = ROOT_LEVEL(folders);
  const levels = [{ by: CEO_BY, eff }];
  for (const a of chain.reverse()) { eff = meet(ownExpanded(all[a], folders, workspaceOf(cid, a)), eff); levels.push({ by: a, eff }); }
  return levels;
}
// store.effectivePowers -> { read, write, tools, bash, agents, worktree, workspace, limitedBy, broken }
function effectivePowers(all, id, folders, cid) {
  const ws = normPath(workspaceOf(cid, id));
  const own = ownExpanded(all[id], folders, ws);
  const levels = levelsAbove(all, id, folders, cid);
  const eff = meet(own, levels[levels.length - 1].eff);
  return { read: [ws, ...eff.read], write: [ws, ...eff.write], tools: eff.tools, bash: eff.bash, agents: eff.agents, worktree: eff.worktree,
    workspace: ws, limitedBy: diffAgainst(own, levels), broken: null };
}
// proposals.js computeExcess: nothing (undefined) until the company and the manager exist
function computeExcess(all, folders, cid, powers, parent, { scope, workspaceId } = {}) {
  if (!powers || !all || !folders) return undefined;
  if (parent != null && !all[parent]) return undefined;
  const own = ownExpanded({ powers, scope: scope || { kind: 'company' } }, folders, workspaceId ? normPath(workspaceOf(cid, workspaceId)) : null);
  let levels = [{ by: CEO_BY, eff: ROOT_LEVEL(folders) }];
  if (parent != null) {
    const up = levelsAbove(all, parent, folders, cid);
    levels = [...up, { by: parent, eff: meet(ownExpanded(all[parent], folders, workspaceOf(cid, parent)), up[up.length - 1].eff) }];
  }
  return diffAgainst(own, levels);
}
// wire.js limitedMap: [{ power, value, by }] -> { "<power>[:<value>]": by }
function limitedMap(list) {
  const out = {};
  for (const x of Array.isArray(list) ? list : []) {
    const key = ['bash', 'agents', 'worktree'].includes(x.power) ? x.power : `${x.power}:${typeof x.value === 'string' ? x.value : JSON.stringify(x.value)}`;
    out[key] = x.by == null ? 'company' : x.by;
  }
  return out;
}
// proposals.js editDiff (lineDiff, powerEntries, setDiff): what an edit card shows
function lineDiff(a, b) {
  const A = String(a ?? '').replace(/\r\n/g, '\n').split('\n'), B = String(b ?? '').replace(/\r\n/g, '\n').split('\n');
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push(` ${A[i]}`); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push(`-${A[i++]}`); else out.push(`+${B[j++]}`);
  }
  while (i < n) out.push(`-${A[i++]}`);
  while (j < m) out.push(`+${B[j++]}`);
  return out.join('\n');
}
function powerEntries(p) {
  const out = [];
  if (!p || typeof p !== 'object') return out;
  for (const k of ['read', 'write', 'tools']) { const v = p[k]; if (Array.isArray(v)) for (const x of v) out.push(`${k}: ${x}`); else if (v !== undefined) out.push(`${k}: ${JSON.stringify(v)}`); }
  for (const k of Object.keys(p)) if (!['read', 'write', 'tools'].includes(k)) out.push(`${k}: ${JSON.stringify(p[k])}`);
  return out;
}
const setDiff = (before, after) => { const a = new Set(before), b = new Set(after); return { added: [...b].filter((x) => !a.has(x)), removed: [...a].filter((x) => !b.has(x)) }; };
function editDiff(cur, next, { briefBefore, briefAfter, excess }) {
  const d = {};
  if (briefAfter != null && briefBefore !== briefAfter) d.brief = lineDiff(briefBefore || '', briefAfter);
  const pw = setDiff(powerEntries(cur.powers), powerEntries(next.powers));
  if (pw.added.length || pw.removed.length) d.powers = pw;
  const dk = (list) => (Array.isArray(list) ? list.map((x) => `${x.id}: ${JSON.stringify(x)}`) : []);
  const du = setDiff(dk(cur.duties), dk(next.duties));
  if (du.added.length || du.removed.length) d.duties = { added: du.added.map((x) => x.slice(0, x.indexOf(':'))), removed: du.removed.map((x) => x.slice(0, x.indexOf(':'))) };
  if ((cur.parent ?? null) !== (next.parent ?? null)) d.parent = { from: cur.parent ?? null, to: next.parent ?? null };
  for (const k of ['name', 'remit', 'model', 'effort', 'status']) if (JSON.stringify(cur[k]) !== JSON.stringify(next[k])) d[k] = { from: cur[k] ?? null, to: next[k] ?? null };
  if (JSON.stringify(cur.scope) !== JSON.stringify(next.scope)) d.scope = { from: cur.scope, to: next.scope };
  if (excess && excess.length) d.excess = excess;
  return d;
}
const POSITION_FIELDS = ['id', 'name', 'parent', 'remit', 'scope', 'status', 'model', 'effort', 'powers', 'duties'];

// ---------------------------------------------------------------- the fictional data
// next local hh:mm (on weekday `dow` when given), strictly after now
function nextAt(now, h, m, dow = null) {
  const d = new Date(now); d.setSeconds(0, 0); d.setHours(h, m);
  while (d.getTime() <= now || (dow != null && d.getDay() !== dow)) d.setDate(d.getDate() + 1);
  return d.getTime();
}
function nextMonthDay(now, day, h) {
  const d = new Date(now); d.setHours(h, 0, 0, 0); d.setDate(1); d.setDate(day);
  if (d.getTime() <= now) { d.setDate(1); d.setMonth(d.getMonth() + 1); d.setDate(day); }
  return d.getTime();
}

const NONCODING = { read: ['$workspace', '$company'], write: ['$workspace'], tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'TodoWrite'], bash: 'off', agents: false, worktree: false };

function notebook(name, { decisions = [], facts = [], items = [], log = [] } = {}) {
  const sec = (h, lines) => `## ${h}\n${lines.length ? lines.join('\n') + '\n' : ''}`;
  return `# ${name} · notebook\n${sec('Decisions', decisions.map((x) => `- ${x}`))}${sec('Facts', facts.map((x) => `- ${x}`))}${sec('Open items', items.map(([done, t]) => `- [${done ? 'x' : ' '}] ${t}`))}${sec('Log', log.map((x) => `- ${x}`))}`;
}
function brief(name, covers, never, sources, reports) {
  return `# ${name}\n\n## What this role covers\n${covers}\n\n## Never\n${never.map((x) => `- ${x}`).join('\n')}\n\n## Sources it trusts\n${sources.map((x) => `- ${x}`).join('\n')}\n\n## How it reports\n${reports}\n`;
}
const plainBrief = (p) => brief(p.name, p.remit, ['Send, post, pay or publish anything.'], ['The company folders', 'You'], 'Short answers with sources. Drafts go in work/drafts/.');

export function buildMockTeam(now = Date.now()) {
  const P = (o) => ({ status: 'active', model: null, effort: 'high', scope: { kind: 'company' }, powers: NONCODING, duties: [], createdAt: iso(now - 20 * DAY), version: 1, ...o });
  const positions = {
    legal: P({ id: 'legal', name: 'Legal', parent: null, remit: 'Privacy pages, terms and contracts for every Example Co product.', version: 3,
      duties: [
        { id: 'privacy-recheck', title: 'Privacy text re-check', enabled: true, trigger: { kind: 'event', event: 'commit', repo: `${HOME}/example-site`, paths: ['**/privacy*', '**/cookies*', '**/terms*'] }, output: 'report', prompt: 'Re-check the privacy, cookies and terms text against what the code now does.' },
        { id: 'terms-weekly', title: 'Weekly terms review', enabled: true, trigger: { kind: 'schedule', cron: '0 10 * * 1', catchUp: 'once' }, output: 'report', prompt: 'List anything in the terms that the last week of changes made untrue.' },
      ] }),
    // lists more than Legal (its manager) has, as an "Approve always" or a hand edit can leave it: a tool Legal lacks,
    // Bash (Legal has none) and a folder outside the company folders -> effective.limits / limitedBy
    tax: P({ id: 'tax', name: 'Tax Specialist', parent: 'legal', remit: 'Sales tax, VAT and income-tax questions for Example Co products and payouts.',
      powers: { ...NONCODING, read: [...NONCODING.read, `${HOME}/tax-archive`], tools: [...NONCODING.tools, 'NotebookEdit'], bash: 'readonly' },
      duties: [{ id: 'quarterly-check', title: 'Quarterly deadlines check', enabled: true, trigger: { kind: 'schedule', cron: '0 9 1 1,4,7,10 *', catchUp: 'once' }, output: 'report', prompt: 'List tax deadlines due in the next 90 days and what each one needs.' }] }),
    payroll: P({ id: 'payroll', name: 'Payroll Tax', parent: 'tax', remit: 'Withholding rules for contractors and staff, per country.', createdAt: iso(now - 2 * DAY + 4 * MIN) }),
    contracts: P({ id: 'contracts', name: 'Contracts', parent: 'legal', remit: 'Reviews supplier and customer contracts and drafts redlines. Never signs.' }),
    marketing: P({ id: 'marketing', name: 'Marketing', parent: null, remit: 'Release posts, landing page copy and the monthly newsletter. Drafts only, never posts.',
      duties: [
        { id: 'release-post', title: 'Release post draft', enabled: true, trigger: { kind: 'event', event: 'release', repo: `${HOME}/example-app`, tag: 'v*' }, output: 'draft', prompt: 'Draft the release post from the commits since the last tag.' },
        { id: 'newsletter', title: 'Newsletter draft', enabled: true, trigger: { kind: 'schedule', cron: '0 9 1 * *', catchUp: 'once' }, output: 'draft', prompt: 'Draft this month\'s newsletter.' },
      ] }),
    social: P({ id: 'social', name: 'Social Posts', parent: 'marketing', status: 'paused', remit: 'Short posts for each release, in the house voice.',
      duties: [{ id: 'release-thread', title: 'Release thread', enabled: false, trigger: { kind: 'event', event: 'release', repo: `${HOME}/example-app`, tag: 'v*' }, output: 'draft' }] }),
    finance: P({ id: 'finance', name: 'Finance', parent: null, remit: 'Money check: subscriptions, payouts, refunds and runway.', model: 'claude-sonnet-5-5',
      duties: [
        { id: 'daily-cash', title: 'Daily cash check', enabled: true, trigger: { kind: 'schedule', cron: '0 9 * * *', catchUp: 'skip' }, output: 'report' },
        { id: 'monthly-money', title: 'Monthly money check', enabled: true, trigger: { kind: 'schedule', cron: '0 9 1 * *', catchUp: 'once' }, output: 'report' },
      ] }),
    qa: P({ id: 'qa', name: 'App QA', parent: null, remit: 'Tests the Example App before each release, in its own worktree.', scope: { kind: 'product', folder: `${HOME}/example-app` },
      powers: { read: ['$workspace', '$scope'], write: ['$workspace', '$scope'], tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash', 'TodoWrite'], bash: 'on', agents: false, worktree: true },
      duties: [{ id: 'release-checks', title: 'Release checks', enabled: true, trigger: { kind: 'event', event: 'commit', repo: '$scope', branch: 'main' }, output: 'report' }] }),
  };
  const harbor = { support: { id: 'support', name: 'Support', parent: null, remit: 'Answers reader emails, from drafts you approve.', status: 'active', scope: { kind: 'company' }, powers: NONCODING, duties: [], createdAt: iso(now - 6 * DAY), version: 1 } };
  const companies = [
    { id: 'example-co', name: 'Example Co', folders: [`${HOME}/example-site`, `${HOME}/example-app`, `${HOME}/example-docs`], createdAt: iso(now - 21 * DAY), version: 1 },
    { id: 'harbor-books', name: 'Harbor Books', folders: [`${HOME}/harbor-books`], createdAt: iso(now - 6 * DAY), version: 1 },
  ];
  const defs = { 'example-co': positions, 'harbor-books': harbor };   // company id -> { position id -> position.json }
  const live = {   // what team.get adds per row: live status, last activity
    legal: { status: 'waiting', lastActivity: { at: now - 12 * MIN, text: 'asked you for read access' } },
    tax: { status: 'idle', lastActivity: { at: now - 14 * MIN, text: 'answered Legal' } },
    payroll: { status: 'idle', lastActivity: { at: now - 2 * DAY, text: 'answered Tax Specialist' } },
    contracts: { status: 'idle', lastActivity: { at: now - 26 * HOUR, text: 'drafted an NDA redline' } },
    marketing: { status: 'working', lastActivity: { at: now - 1 * MIN, text: 'answering CEO' } },
    social: { status: 'paused', lastActivity: { at: now - 5 * DAY, text: 'paused by you' } },
    finance: { status: 'idle', lastActivity: { at: now - 3 * HOUR, text: 'sent a duty report' } },
    qa: { status: 'idle', lastActivity: { at: now - 6 * HOUR, text: 'ran the release checks' } },
  };
  const files = {   // `${company}/${position}` -> { brief, notebook }
    'example-co/legal': {
      brief: brief('Legal', 'Keeps every public legal text true to what the products actually do: privacy, cookies and terms pages for the site and the app, plus contract reviews through Contracts.', ['Publish, send or sign anything.', 'Give advice outside Example Co.'], ['The code in the company folders', 'Official regulator pages', 'You'], 'One short answer first, then the evidence (file and line, or URL). Drafts go in work/drafts/.'),
      notebook: notebook('Legal', {
        decisions: ['2026-11-10: the privacy page lists every stored field in plain words (CEO).'],
        facts: ['The app stores email and display name at sign-up (src/signup.js, 2026-11-16).', 'Analytics is off on the site (site/config.json, 2026-11-12).'],
        items: [[false, 'Add the display name to "What we collect" on the privacy page'], [false, 'Re-check the cookies text after the analytics change'], [true, 'Terms: new plan names'], [false, 'Ask Contracts for the supplier DPA list']],
        log: ['11-16 answered CEO: privacy page vs the new sign-up', '11-12 checked the cookies text on the site'],
      }),
    },
  };
  const ITEMS = { tax: [[false, 'Confirm the VAT threshold for digital goods'], [false, 'List states that need a sales-tax permit']],
    marketing: [[false, 'Landing page: new hero copy'], [false, 'Newsletter: November draft'], [false, 'Release post template'], [false, 'Ask Legal about "no tracking"']],
    finance: [[false, 'Cancel the unused design seat']], qa: [[false, 'Flaky sign-up test'], [false, 'Add a test for display names']] };
  const fileOf = (cid, id, file) => {
    const k = `${cid}/${id}`;
    files[k] ||= {};
    if (files[k][file] == null) {
      const p = (defs[cid] || {})[id] || { name: id, remit: '' };
      files[k][file] = file === 'brief' ? plainBrief(p) : notebook(p.name, { items: cid === 'example-co' ? ITEMS[id] || [] : [], log: [] });
    }
    return files[k][file];
  };
  const setFile = (cid, id, file, text) => { fileOf(cid, id, file); files[`${cid}/${id}`][file] = text; };
  const mtimes = {};
  const openItems = (cid, id) => (fileOf(cid, id, 'notebook').match(/^\s*[-*+] \[ \] /gm) || []).length;

  const nextOf = {
    'legal/terms-weekly': nextAt(now, 10, 0, 1), 'tax/quarterly-check': (() => { const y = new Date(now).getFullYear(); return [y, y + 1].flatMap((yr) => [0, 3, 6, 9].map((m) => new Date(yr, m, 1, 9).getTime())).find((t) => t > now); })(),
    'marketing/newsletter': nextMonthDay(now, 1, 9), 'finance/daily-cash': nextAt(now, 9, 0), 'finance/monthly-money': nextMonthDay(now, 1, 9),
  };
  const lastOf = {
    'legal/privacy-recheck': { at: now - 2 * DAY, state: 'done', costUsd: 0.04 }, 'legal/terms-weekly': { at: now - 6 * DAY, state: 'done', costUsd: 0.02 },
    'tax/quarterly-check': { at: now - 47 * DAY, state: 'done', costUsd: 0.06 }, 'marketing/release-post': { at: now - 9 * DAY, state: 'done', costUsd: 0.09 },
    'marketing/newsletter': { at: now - 17 * DAY, state: 'done', costUsd: 0.11 }, 'finance/daily-cash': { at: now - 15 * HOUR, state: 'done', costUsd: 0.01 },
    'finance/monthly-money': { at: now - 17 * DAY, state: 'failed', reason: 'Usage was over the 80% ceiling; it ran the next morning instead' }, 'qa/release-checks': { at: now - 6 * HOUR, state: 'done', costUsd: 0.21 },
  };
  const chats = {
    legal: [{ n: 1, helmSessionId: 's_legal_1', claudeSessionId: null, startedAt: iso(now - 9 * DAY), endedAt: iso(now - 2 * DAY), endReason: 'full', contextPct: 33.1, handoff: 'Done: privacy pages reviewed for the site and the app. In progress: terms update for the new plan names. Waiting on: nothing. Next: re-check the cookies text after the analytics change.' },
      { n: 2, helmSessionId: 's_legal_2', claudeSessionId: null, startedAt: iso(now - 2 * DAY) }],
    marketing: [{ n: 1, helmSessionId: 's_marketing_1', startedAt: iso(now - 12 * DAY) }],
    tax: [{ n: 1, helmSessionId: 's_tax_1', startedAt: iso(now - 8 * DAY) }],
  };
  const grants = {
    legal: [
      { at: iso(now - 3 * DAY), id: 'g_7a1', position: 'legal', request: { kind: 'read', target: `${HOME}/example-docs/contracts/**`, why: 'Supplier contracts, to answer the DPA question.' }, decision: 'always', savedTo: ['legal'] },
      { at: iso(now - 1 * DAY), id: 'g_7a2', position: 'legal', request: { kind: 'outward', target: 'Email the NDA redline to the supplier', why: 'They asked for it today.' }, decision: 'denied', note: 'Draft only. I will send it.' },
    ],
    qa: [{ at: iso(now - 4 * DAY), id: 'g_7b1', position: 'qa', request: { kind: 'bash', target: 'npm ci', why: 'Install the app\'s dependencies in the worktree.' }, decision: 'once' }],
  };
  // open access cards, as access.pending() lists them (publicRow): the access object is what the card shows
  const access = [
    { id: 'ac_legal_1', requestId: 'r_legal_1', company: 'example-co', position: 'legal', sessionId: 's_legal_2', kind: 'read', target: `${HOME}/example-analytics-export`, at: iso(now - 12 * MIN),
      access: { kind: 'read', target: `${HOME}/example-analytics-export`, why: 'The analytics export, to see what the site really collects before answering the privacy question.',
        position: { id: 'legal', name: 'Legal', path: ['Legal'] }, outward: false, onceOnly: true, waitMin: 30 } },
  ];

  // ---- proposal cards (proposals.js: newest first by `at`; decided ones stay 7 days)
  const folders = companies[0].folders;
  const ceoBy = { kind: 'ceo', sessionId: 's_ceo_1' };
  const proposals = [];
  {
    // an open create: Tax Specialist proposes a report listing powers beyond its own (excess)
    const draft = { id: 'state-filings', name: 'State Filings', parent: 'tax', remit: 'Tracks state sales-tax filings and their due dates.',
      powers: { ...NONCODING, read: [...NONCODING.read, `${HOME}/state-portal-exports`], tools: [...NONCODING.tools, 'NotebookEdit'], bash: 'readonly' },
      duties: [{ id: 'monthly-filings', title: 'Monthly filings list', enabled: true, trigger: { kind: 'schedule', cron: '0 9 25 * *', catchUp: 'once' }, prompt: 'List the state filings due next month and what each one needs.', output: 'report' }],
      scope: { kind: 'company' }, model: null, effort: 'high',
      brief: '# State Filings\n\n## What this role covers\nKeeps the list of state sales-tax filings, their due dates and what each needs.\n\n## Never\n- File, pay or send anything.\n' };
    const excess = computeExcess(positions, folders, 'example-co', draft.powers, 'tax', { scope: draft.scope, workspaceId: draft.id });
    proposals.push({ id: 'p_4c2e', company: 'example-co', action: 'create', title: 'New position: State Filings under Tax Specialist',
      why: 'Filing deadlines differ per state and the question keeps coming up.', draft, excess, status: 'open',
      by: { kind: 'position', id: 'tax', sessionId: 's_tax_1' }, target: 'state-filings', parent: 'tax', at: iso(now - 25 * MIN) });
  }
  {
    // an open edit by the CEO: name, remit, scope, brief, powers and a duty change for Contracts
    const cur = positions.contracts;
    const before = fileOf('example-co', 'contracts', 'brief');
    const after = before.replace(/^# Contracts$/m, '# Contracts & Suppliers').replace('- Send, post, pay or publish anything.\n', '- Send, post, pay or publish anything.\n- Sign or accept a contract.\n')
      + '\n## Suppliers\n- Keeps the supplier DPA list in example-docs/suppliers.md.\n';
    const next = { id: 'contracts', name: 'Contracts & Suppliers', parent: 'legal', remit: 'Supplier and customer contracts, DPAs and the supplier list. Drafts redlines; never signs.',
      scope: { kind: 'product', folder: `${HOME}/example-docs` }, status: 'active', model: null, effort: 'high',
      powers: { ...NONCODING, write: ['$workspace', '$scope'], tools: NONCODING.tools.filter((t) => t !== 'WebSearch'), bash: 'readonly' },
      duties: [{ id: 'supplier-dpa', title: 'Supplier DPA check', enabled: true, trigger: { kind: 'schedule', cron: '0 9 1 * *', catchUp: 'once' }, prompt: 'Check every supplier on the list has a signed DPA on file.', output: 'report' }],
      brief: after };
    const excess = computeExcess(positions, folders, 'example-co', next.powers, 'legal', { scope: next.scope, workspaceId: 'contracts' });
    const diff = editDiff(cur, next, { briefBefore: before, briefAfter: after, excess });
    proposals.push({ id: 'p_5d1a', company: 'example-co', action: 'edit', title: 'Change Contracts', why: 'Supplier paperwork lives in example-docs now; Contracts should own it.',
      draft: next, diff, excess, status: 'open', by: ceoBy, target: 'contracts', parent: 'legal', at: iso(now - 40 * MIN) });
  }
  {
    const dAt = iso(now - 2 * DAY + 4 * MIN);
    const p = positions.payroll;
    proposals.push({ id: 'p_19aa', company: 'example-co', action: 'create', title: 'New position: Payroll Tax under Tax Specialist', why: 'Payroll questions need their own owner.',
      draft: { id: 'payroll', name: p.name, parent: 'tax', remit: p.remit, powers: NONCODING, duties: [], scope: { kind: 'company' }, model: null, effort: 'high', brief: plainBrief(p) },
      excess: [], status: 'approved', by: { kind: 'position', id: 'tax', sessionId: 's_tax_1' }, target: 'payroll', parent: 'tax', at: iso(now - 2 * DAY),
      decidedAt: dAt, decision: { at: dAt, how: 'click', result: 'approved' }, decidedHow: 'click', result: 'Payroll Tax created under Tax Specialist' });
  }
  {
    const dAt = iso(now - 4 * DAY + 9 * MIN);
    const cur = positions.marketing;
    const next = { ...clone(cur), remit: 'Release posts, landing page copy and the monthly newsletter. Posts releases itself.' };
    delete next.createdAt; delete next.version;
    proposals.push({ id: 'p_0b7d', company: 'example-co', action: 'edit', title: 'Change Marketing', why: 'Release posts could go out without waiting for you.',
      draft: next, diff: editDiff(cur, next, {}), status: 'declined', by: ceoBy, target: 'marketing', parent: null, at: iso(now - 4 * DAY),
      decidedAt: dAt, decision: { at: dAt, how: 'click', result: 'declined', note: 'Keep it drafts only.' }, decidedHow: 'click', note: 'Keep it drafts only.' });
  }
  const inbox = [
    { at: iso(now - 3 * HOUR), id: 'n_31', position: 'finance', kind: 'duty-report', title: 'Weekly spend report', text: 'Spend is flat week over week. Two subscriptions renew next week: the design tool and the error tracker. The design tool has one unused seat.', files: ['work/drafts/weekly-spend.md'], needsOwen: true },
    { at: iso(now - 1 * DAY), id: 'n_30', position: 'legal', kind: 'flag', title: 'Brief edited by you', text: 'Legal\'s brief changed: "How it reports" now asks for the file and line first.', needsOwen: false },
    { at: iso(now - 2 * DAY), id: 'n_29', position: 'payroll', kind: 'proposal', title: 'Payroll Tax created under Tax Specialist', text: 'Approved by your click.', proposal: 'p_19aa', needsOwen: false },
    { at: iso(now - 5 * DAY), id: 'n_28', position: 'qa', kind: 'flag', title: 'One failing test before release', text: 'sign-up.test.js fails on a slow machine.', needsOwen: true, dismissedAt: iso(now - 4 * DAY) },
  ];
  const inboxes = { 'example-co': inbox, 'harbor-books': [] };
  // cross-talk, one entry per ticket as runtime.crosstalk folds crosstalk.jsonl (names are added per call)
  const crosstalk = [
    { ticket: 't_c1', chain: 't_c1', from: { kind: 'ceo' }, to: 'marketing', kind: 'report', state: 'delivered', question: 'Draft the release post for Example App 2.4 from its commits.', askedAt: iso(now - 70 * 1000) },
    { ticket: 't_a2', parentTicket: 't_a1', chain: 't_a1', from: { kind: 'position', id: 'legal' }, to: 'tax', kind: 'report', state: 'answered', question: 'Does storing a display name change anything for sales tax or VAT?', askedAt: iso(now - 15 * MIN),
      answer: 'No. A display name is not tax data, so nothing changes for sales tax or VAT.', answeredAt: iso(now - 14 * MIN), tookMs: 61_000, costUsd: 0.01 },
    { ticket: 't_a1', chain: 't_a1', from: { kind: 'ceo' }, to: 'legal', kind: 'report', state: 'answered', question: 'Does the privacy page still match what the app collects after this week\'s sign-up change?', askedAt: iso(now - 16 * MIN),
      answer: 'Not quite. The page says we keep the email only; the new sign-up also stores the display name. One sentence needs adding under "What we collect". The draft is in work/drafts/privacy-fix.md.', answeredAt: iso(now - 12 * MIN - 20_000), tookMs: 220_000, costUsd: 0.03 },
    { ticket: 't_b1', chain: 't_b1', from: { kind: 'position', id: 'marketing' }, to: 'legal', kind: 'colleague', state: 'answered', question: 'Can the landing page say "no tracking"?', askedAt: iso(now - 2 * HOUR),
      answer: 'Only while analytics stays off. It is off today, so yes, but say "no third-party tracking" to stay true if that changes.', answeredAt: iso(now - 2 * HOUR + 95_000), tookMs: 95_000, costUsd: 0.01 },
  ];
  return { now, companies, defs, positions, harbor, live, files, fileOf, setFile, mtimes, openItems, nextOf, lastOf, chats, grants, access, proposals, inbox, inboxes, crosstalk };
}

// ?team=imported: what team.proposals.import leaves in an empty team: the company card (company null) and the position
// cards for that company (company '<new id>'), no excess yet (the engine computes it once the company exists)
function importedCards(now) {
  const by = { kind: 'import', name: 'a planning chat' };
  const cid = 'example-studio';
  const NC = { ...NONCODING, tools: NONCODING.tools.filter((t) => t !== 'TodoWrite') };
  const job = (i, ref, o) => {
    const draft = { id: o.id, name: o.name, parent: o.parent, remit: o.remit, powers: o.powers || NC, duties: o.duties || [], scope: { kind: 'company' }, model: null, effort: 'high',
      brief: `# ${o.name}\n\n## What this role covers\n${o.remit}\n` };
    return { id: o.pid, company: cid, action: 'create', title: `New position: ${o.name}${o.parentName ? ` under ${o.parentName}` : ''}`, why: o.why, draft,
      status: 'open', by, target: o.id, parent: o.parent, at: iso(now - 10 * MIN + i * 2000), ref };
  };
  return [
    { id: 'p_c0a1', company: null, action: 'company', title: 'New company: Example Studio', why: 'A second business, with its own site and orders.',
      draft: { id: cid, name: 'Example Studio', folders: [`${HOME}/example-studio-site`] }, status: 'open', by, target: cid, at: iso(now - 10 * MIN), ref: 'company' },
    job(1, 'ops', { pid: 'p_c0a2', id: 'operations', name: 'Operations', parent: null, remit: 'Orders, suppliers and the weekly numbers.', why: 'Someone has to own the weekly numbers.' }),
    job(2, 'books', { pid: 'p_c0a3', id: 'bookkeeping', name: 'Bookkeeping', parent: 'operations', parentName: 'Operations', remit: 'Invoices, receipts and the monthly close.', why: 'Receipts pile up every month.',
      duties: [{ id: 'monthly-close', title: 'Monthly close', enabled: true, trigger: { kind: 'schedule', cron: '0 9 1 * *', catchUp: 'once' }, prompt: 'Close last month.', output: 'report' }] }),
    job(3, 'web', { pid: 'p_c0a4', id: 'web-copy', name: 'Web Copy', parent: null, remit: 'Copy for the studio site. Drafts only.', why: 'The site copy is out of date.',
      powers: { ...NC, read: [...NC.read, `${HOME}/old-studio-site`], bash: 'readonly' } }),
    job(4, 'support', { pid: 'p_c0a5', id: 'customer-care', name: 'Customer Care', parent: 'operations', parentName: 'Operations', remit: 'Answers customer emails, from drafts you approve.', why: 'Customer emails need a first draft.' }),
  ];
}

const err = (message, code) => Object.assign(new Error(message), { code });

// A team.* backend over buildMockTeam(). emit(event, data) receives team.updated and the other events.
export function createMockTeam({ mode = null, now = Date.now(), emit = () => {}, delay = 0 } = {}) {
  const D = buildMockTeam(now);
  if (mode === 'one') D.companies = D.companies.slice(0, 1);
  if (mode === 'nopositions') {
    D.companies = D.companies.slice(0, 1);
    for (const id of Object.keys(D.positions)) delete D.positions[id];
    D.proposals = []; D.inbox.length = 0; D.crosstalk = []; D.access = [];
  }
  if (mode === 'imported') { D.companies = []; D.proposals = importedCards(now); D.access = []; D.crosstalk = []; }
  if (mode === 'deep') {
    // depth 4 and 5 under Payroll Tax (legal > tax > payroll > contractor-wh > eu-contractors)
    const extra = {
      'contractor-wh': { id: 'contractor-wh', name: 'Contractor Withholding', parent: 'payroll', remit: 'Withholding for contractors paid from another country, per payout.',
        status: 'active', model: null, effort: 'high', scope: { kind: 'company' }, powers: NONCODING, duties: [], createdAt: iso(now - 4 * DAY), version: 1 },
      'eu-contractors': { id: 'eu-contractors', name: 'EU Contractors', parent: 'contractor-wh', remit: 'Reverse charge and withholding for contractors inside the EU.',
        status: 'active', model: null, effort: 'high', scope: { kind: 'company' }, powers: NONCODING, duties: [], createdAt: iso(now - 1 * DAY), version: 1 },
    };
    // re-insert in place (D.defs holds this same object), so the new rows sit right after Payroll Tax
    const order = Object.entries(D.positions);
    for (const [id] of order) delete D.positions[id];
    for (const [id, p] of order) { D.positions[id] = p; if (id === 'payroll') Object.assign(D.positions, extra); }
    D.live['contractor-wh'] = { status: 'idle', lastActivity: { at: now - 3 * HOUR, text: 'answered Payroll Tax' } };
    D.live['eu-contractors'] = { status: 'working', lastActivity: { at: now - 2 * MIN, text: 'answering Contractor Withholding' } };
  }
  let conflictOnce = mode === 'conflict';
  let seq = 0;
  const nid = (prefix) => `${prefix}_m${(++seq).toString(16).padStart(4, '0')}`;
  const stamp = () => iso(Math.max(Date.now(), D.now + seq));
  const companyRec = (id) => D.companies.find((x) => x.id === id) || null;
  const company = (id) => { const c = companyRec(id); if (!c) throw err(`No company "${id}"`, 'not_found'); return c; };
  const defs = (cid) => (D.defs[cid] ||= {});
  const pos = (cid, id) => { const p = defs(cid)[id]; if (!p) throw err(`No position "${id}" in ${company(cid).name}`, 'not_found'); return p; };
  const nameOf = (cid, id) => { if (id == null) return 'the CEO'; const p = defs(cid)[id]; if (p) return p.name; const c = D.proposals.find((y) => y.status === 'open' && y.action === 'create' && y.company === cid && y.target === id); return c ? c.draft.name : id; };
  // proposals.js list(): newest first; open only unless includeDecided / status; company undefined = every company
  const listCards = ({ company: co, status, includeDecided = false } = {}) => D.proposals.filter((c) => {
    if (co !== undefined && (c.company ?? null) !== (co ?? null)) return false;
    if (status) return c.status === status;
    return includeDecided || c.status === 'open';
  }).sort((a, b) => String(b.at).localeCompare(String(a.at))).map(clone);
  const accessOf = (cid) => D.access.filter((r) => r.company === cid);
  const inboxOf = (cid) => (D.inboxes[cid] ||= []);
  const needsYou = (cid) => accessOf(cid).length + listCards({ company: cid, status: 'open' }).length + inboxOf(cid).filter((e) => e.needsOwen && !e.dismissedAt).length;
  const nextDuty = (cid, p) => {
    if (cid !== 'example-co') return null;
    const list = (p.duties || []).filter((d) => d.enabled && D.nextOf[`${p.id}/${d.id}`]).map((d) => ({ id: d.id, title: d.title, at: D.nextOf[`${p.id}/${d.id}`] }));
    return list.sort((a, b) => a.at - b.at)[0] || null;
  };
  // team.get rows, depth-first from the roots (a root is depth 1; the CEO row is 0)
  const rows = (cid) => {
    const all = defs(cid);
    const props = listCards({ company: cid, status: 'open' });
    const out = [];
    const walk = (p, depth) => {
      const lv = cid === 'example-co' ? D.live[p.id] || {} : {};
      const reports = Object.values(all).filter((x) => x.parent === p.id).map((x) => x.id);
      out.push({ id: p.id, name: p.name, parent: p.parent ?? null, remit: p.remit || '', status: p.status === 'paused' ? 'paused' : 'active', depth, reports,
        ...(lv.status === 'working' && p.status !== 'paused' ? { busy: lv.lastActivity?.text || 'working' } : {}),
        openItems: D.openItems(cid, p.id), nextDuty: nextDuty(cid, p), lastActivity: lv.lastActivity || null,
        pending: { requests: accessOf(cid).filter((r) => r.position === p.id).length, proposals: props.filter((q) => q.target === p.id || q.parent === p.id).length } });
      if (depth < 50) for (const k of reports) walk(all[k], depth + 1);
    };
    for (const p of Object.values(all)) if (p.parent == null || !all[p.parent]) walk(p, 1);
    return out;
  };
  const updated = (cid) => { if (cid) emit('team.updated', { company: cid }); };
  const broadcast = (c) => emit('team.proposal.updated', { company: c.company, proposal: clone(c) });
  const inboxAdd = (cid, entry) => {
    if (!cid || !companyRec(cid)) return;
    const line = { at: stamp(), id: nid('n'), ...entry };
    inboxOf(cid).unshift(line);
    emit('team.inbox.appended', { company: cid, entry: clone(line) });
  };

  // ---- proposals.js decide(): approve applies the card against the CURRENT team; a failure leaves it open with `error`
  const setStatus = (c, result, { how, note }) => {
    c.status = result;
    c.decidedAt = stamp();
    c.decision = { at: c.decidedAt, how, result, ...(note ? { note } : {}) };
    c.decidedHow = how;
    if (note) c.note = note;
    delete c.error;
  };
  function applyCreate(c) {
    const cid = c.company;
    const co = companyRec(cid);
    if (!co) {
      const pc = D.proposals.find((y) => y.status === 'open' && y.action === 'company' && y.target === cid);
      throw new Error(pc ? `approve ${pc.draft.name} (${pc.id}) first: the company does not exist yet` : `company "${cid}" does not exist`);
    }
    const all = defs(cid);
    if (c.parent != null && !all[c.parent]) {
      const pp = D.proposals.find((y) => y.status === 'open' && y.action === 'create' && y.company === cid && y.target === c.parent);
      throw new Error(pp ? `approve ${pp.draft.name} (${pp.id}) first: "${c.parent}" does not exist yet` : `parent: "${c.parent}" is not a live position in ${co.name}`);
    }
    const p = { status: 'active' };
    for (const k of POSITION_FIELDS) if (c.draft[k] !== undefined) p[k] = clone(c.draft[k]);
    Object.assign(p, { createdAt: stamp(), createdBy: { proposal: c.id, by: c.by.kind === 'position' ? c.by.id : c.by.kind === 'import' ? c.by.name || 'import' : c.by.kind, how: 'click' }, version: 1 });
    const ex = computeExcess(all, co.folders, cid, p.powers, p.parent, { scope: p.scope });
    if (ex) c.excess = ex;
    all[p.id] = p;
    if (typeof c.draft.brief === 'string') D.setFile(cid, p.id, 'brief', c.draft.brief);
    return { created: { company: cid, id: p.id }, text: `${p.name} created${p.parent != null ? ` under ${nameOf(cid, p.parent)}` : ' (reports to the CEO)'}`, inboxPosition: p.id };
  }
  function applyCompany(c) {
    const co = { id: c.draft.id, name: c.draft.name, folders: c.draft.folders.slice(), version: 1, createdAt: stamp(),
      createdBy: { proposal: c.id, how: 'click', ...(c.by.kind === 'import' ? { by: c.by.name || 'import' } : {}) } };
    D.companies.push(co);
    defs(co.id);
    c.company = co.id;
    return { created: { company: co.id }, text: `${co.name} created`, companyId: co.id };
  }
  function applyEdit(c) {
    const cid = c.company, co = company(cid), all = defs(cid);
    const cur = all[c.target];
    if (!cur) throw new Error(`no live position "${c.target}"`);
    const next = { ...cur };
    for (const k of POSITION_FIELDS) if (k !== 'id' && c.draft[k] !== undefined) next[k] = clone(c.draft[k]);
    if (c.diff && c.diff.powers) { const ex = computeExcess(all, co.folders, cid, next.powers, next.parent, { scope: next.scope, workspaceId: c.target }); if (ex) c.excess = ex; }
    next.version = (cur.version || 1) + 1;
    all[c.target] = next;
    if (typeof c.draft.brief === 'string') D.setFile(cid, c.target, 'brief', c.draft.brief);
    return { text: `${next.name} updated${c.diff && c.diff.parent ? `, now under ${nameOf(cid, next.parent)}` : ''}`, inboxPosition: c.target };
  }
  function applyRetire(c) {
    const cid = c.company, all = defs(cid);
    const cur = all[c.target];
    if (!cur) throw new Error(`no live position "${c.target}"`);
    const moved = Object.values(all).filter((x) => x.parent === cur.id);
    for (const x of moved) x.parent = cur.parent ?? null;
    delete all[c.target];
    return { text: `${cur.name} retired${moved.length ? ` (${moved.length} report(s) moved up to ${nameOf(cid, cur.parent)})` : ''}`, inboxPosition: c.target };
  }
  // after a company or a position appears, cards waiting on it can show their excess
  function refreshExcess(cid) {
    const co = companyRec(cid);
    if (!co) return;
    for (const c of D.proposals) {
      if (c.status !== 'open' || c.company !== cid || c.action !== 'create' || c.excess) continue;
      const ex = computeExcess(defs(cid), co.folders, cid, c.draft.powers, c.parent, { scope: c.draft.scope });
      if (ex) { c.excess = ex; broadcast(c); }
    }
  }
  function decide(p) {
    if (typeof p.proposal !== 'string' || !p.proposal) throw err('proposal must be a proposal id', 'bad_params');
    if (p.decision !== 'approve' && p.decision !== 'decline') throw err('decision must be "approve" or "decline"', 'bad_params');
    const c = D.proposals.find((y) => y.id === p.proposal);
    if (!c) throw err(`no proposal "${p.proposal}"`, 'not_found');
    if (c.status !== 'open') throw err(`${p.proposal} is no longer open (${c.status})`, 'refused');
    const note = String(p.note ?? '').trim().slice(0, 2000);
    if (p.decision === 'decline') {
      setStatus(c, 'declined', { how: 'click', note });
      broadcast(c);
      updated(c.company);
      return { ok: true };
    }
    let res;
    try { res = c.action === 'create' ? applyCreate(c) : c.action === 'company' ? applyCompany(c) : c.action === 'edit' ? applyEdit(c) : applyRetire(c); }
    catch (e) { c.error = e.message; broadcast(c); return { ok: false, error: c.error }; }
    setStatus(c, 'approved', { how: 'click', note });
    c.result = res.text;
    inboxAdd(c.company, { position: res.inboxPosition || null, kind: 'proposal', title: res.text, text: 'Approved by your click.', proposal: c.id, needsOwen: false });
    broadcast(c);
    updated(c.company);
    if (c.action === 'company' || c.action === 'create') refreshExcess(c.company);
    return { ok: true, ...(res.created ? { created: res.created } : {}) };
  }

  async function rpc(method, p = {}) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    switch (method) {
      case 'team.list': {
        if (mode === 'loading') return new Promise(() => {});
        if (mode === 'off') return { enabled: false, root: TEAM_ROOT, companies: [] };
        if (mode === 'root') return { enabled: true, root: `${HOME}/example-site/team`, rootProblem: 'It is inside a git work tree (C:/Users/you/example-site). Pick a folder outside every repo in Settings > Team.', companies: [] };
        const out = { enabled: true, root: TEAM_ROOT, companies: mode === 'empty' ? [] : D.companies.map((c) => ({ id: c.id, name: c.name, folders: c.folders.slice(), positions: Object.keys(defs(c.id)).length, needsYou: needsYou(c.id) })) };
        const pending = mode === 'empty' ? [] : listCards({ company: null, status: 'open' });
        if (pending.length) out.proposals = pending;
        return out;
      }
      case 'team.get': {
        if (mode === 'error') throw err('Could not read C:/Users/you/helm-team/example-co/company.json: unexpected token } at line 4', 'bad_file');
        const c = company(p.company);
        return { company: { id: c.id, name: c.name, folders: c.folders.slice() }, tree: rows(c.id), proposals: listCards({ company: c.id, includeDecided: true }),
          limits: { depthCap: 5, reportsPerManager: 10, positionsPerCompany: 30 } };
      }
      case 'team.position': {
        const c = company(p.company), d = pos(c.id, p.id);
        const eff = effectivePowers(defs(c.id), d.id, c.folders, c.id);
        const x = cidIs(c.id);
        return { position: { ...clone(d), effective: { ...eff, limits: eff.limitedBy }, limitedBy: limitedMap(eff.limitedBy) }, chats: x ? D.chats[d.id] || [] : [],
          duties: (d.duties || []).map((y) => ({ ...y, nextAt: x && y.enabled ? D.nextOf[`${d.id}/${y.id}`] || null : null, last: x ? D.lastOf[`${d.id}/${y.id}`] || null : null })),
          grants: x ? D.grants[d.id] || [] : [],
          pending: { requests: accessOf(c.id).filter((r) => r.position === d.id).map((r) => ({ requestId: r.requestId, sessionId: r.sessionId, access: clone(r.access), kind: r.kind, target: r.target, at: r.at })),
            proposals: listCards({ company: c.id, status: 'open' }).filter((q) => q.target === d.id || q.parent === d.id) } };
      }
      case 'team.proposals': {
        if (p.company != null && typeof p.company !== 'string') throw err('company must be a company id', 'bad_params');
        return { proposals: listCards({ ...(p.company !== undefined ? { company: p.company } : {}), ...(p.status ? { status: String(p.status) } : {}), includeDecided: p.includeDecided !== false }) };
      }
      case 'team.file.read': {
        company(p.company); pos(p.company, p.id);
        const k = `${p.company}/${p.id}/${p.file}`;
        D.mtimes[k] ||= D.now - 2 * HOUR;
        return { text: D.fileOf(p.company, p.id, p.file), mtime: D.mtimes[k] };
      }
      case 'team.file.write': {
        const k = `${p.company}/${p.id}/${p.file}`;
        D.mtimes[k] ||= D.now - 2 * HOUR;
        if (conflictOnce || p.expectMtime !== D.mtimes[k]) {
          conflictOnce = false;
          D.mtimes[k] = Date.now();
          throw err(`${p.file === 'brief' ? 'brief.md' : 'notebook.md'} changed on disk after you opened it (the position or another editor wrote it). Copy your edit, reload, and apply it again.`, 'conflict');
        }
        D.setFile(p.company, p.id, p.file, String(p.text ?? ''));
        D.mtimes[k] = Math.max(Date.now(), D.mtimes[k] + 1);
        updated(p.company);
        return { mtime: D.mtimes[k] };
      }
      case 'team.open': return { sessionId: (cidIs(p.company) && D.chats[p.id] || []).slice(-1)[0]?.helmSessionId || `s_${p.id}_1` };
      case 'team.openCeo': return { sessionId: 's_ceo_1' };
      case 'team.openFolder': return { ok: true };
      case 'team.pause': {
        const d = pos(p.company, p.id); d.status = p.paused ? 'paused' : 'active';
        if (cidIs(p.company) && D.live[d.id]) D.live[d.id] = { ...D.live[d.id], status: p.paused ? 'paused' : 'idle', lastActivity: { at: Date.now(), text: p.paused ? 'paused by you' : 'resumed by you' } };
        updated(p.company); return { status: d.status };
      }
      case 'team.duty.toggle': { const x = (pos(p.company, p.id).duties || []).find((y) => y.id === p.duty); if (!x) throw err(`No duty "${p.duty}"`, 'not_found'); x.enabled = !!p.enabled; updated(p.company); return { ok: true }; }
      case 'team.duty.run': {
        const d = pos(p.company, p.id);
        if (d.status === 'paused') throw err(`${d.name} is paused. Resume it to run a duty.`, 'paused');
        const k = `${p.id}/${p.duty}`;
        D.lastOf[k] = { at: Date.now(), state: 'started' };
        updated(p.company);
        setTimeout(() => { D.lastOf[k] = { at: Date.now(), state: 'done', costUsd: 0.02 }; updated(p.company); }, 1800);
        return { ticket: `t_run${Date.now().toString(36)}` };
      }
      case 'team.decide': return decide(p);
      case 'team.crosstalk': {
        const c = company(p.company);
        const n = Math.min(200, Math.max(1, Number(p.limit) || 50));
        const named = (e) => ({ ...clone(e), from: { kind: e.from.kind, ...(e.from.id ? { id: e.from.id } : {}), name: e.from.kind === 'ceo' ? 'CEO' : e.from.id ? nameOf(c.id, e.from.id) : e.from.kind === 'owen' ? 'Owen' : 'Helm' }, toName: nameOf(c.id, e.to) });
        let list = (cidIs(c.id) ? D.crosstalk : []).map(named);
        if (p.position) list = list.filter((e) => e.to === p.position || e.from.id === p.position);
        list.sort((a, b) => String(b.askedAt).localeCompare(String(a.askedAt)));
        if (p.before) { const i = list.findIndex((e) => e.ticket === p.before); if (i >= 0) list = list.slice(i + 1); }
        return { entries: list.slice(0, n), hasMore: list.length > n };
      }
      case 'team.inbox': company(p.company); return { entries: inboxOf(p.company).slice() };
      case 'team.inbox.dismiss': { for (const e of inboxOf(p.company)) if ((p.ids || []).includes(e.id)) e.dismissedAt = new Date().toISOString(); updated(p.company); return { ok: true }; }
      case 'team.ask.cancel': case 'team.ask.release': {
        if (typeof p.ticket !== 'string') throw err('ticket must be a ticket id', 'bad_params');
        const t = D.crosstalk.find((e) => e.ticket === p.ticket);
        if (!t) throw err(`No ticket ${p.ticket}`, 'not_found');
        if (method === 'team.ask.cancel' && ['asked', 'queued', 'delivered', 'pending'].includes(t.state)) {
          t.state = 'cancelled';
          emit('team.ask.updated', { company: 'example-co', ticket: t.ticket, chainId: t.chain, state: t.state, to: t.to });
        }
        return { state: t.state };
      }
      default: throw err(`mock: no handler for ${method}`, 'unknown_method');
    }
  }
  function cidIs(cid) { return cid === 'example-co'; }   // the per-position extras (chats, grants, duty runs, cross-talk) are Example Co's
  return { rpc, data: D };
}
// transport.js entry (mock mode): one backend per page, emitting through the mock transport.
let shared = null;
export function mockTeam(method, p, { emit } = {}) {
  if (!shared) {
    const mode = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('team') : null;
    shared = createMockTeam({ mode, emit: emit || (() => {}) });
  }
  return shared.rpc(method, p);
}
