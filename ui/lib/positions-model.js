// Team view (Positions, lane T6): the pure rules. Imports nothing, so node tests load it directly
// (test/host/positions-model.test.js). ui/positions/* render it; ui/positions/state.js owns the data.
// Spec: docs/POSITIONS.md section 10.2 (Team view), 2 (data shapes), 11 (RPC).
//
// Shapes read here (team.get / team.position / team.crosstalk, PROTOCOL "Positions"):
//   tree row  { id, name, parent, remit, status, depth, reports, openItems, nextDuty?, lastActivity?, pending: { requests, proposals } }
//     status       'working' | 'waiting' | 'idle' | 'paused' (live) or position.json's 'active' | 'paused' (active = idle)
//     nextDuty     { id?, title, at }            -> "in 2h · Money check" | "Dec 1 · Money check"
//     lastActivity { at, text } or a plain text  -> "answered CEO" + "12m"
//   position  position.json + effective: { read, write, tools, bash, agents, worktree, limits?: [{ kind, value, by }] }

export const DEPTH_CAP = 5;                       // spec 6.4 (Decided)
export const INDENT = { desktop: 16, phone: 12 }; // px per level (spec 10.2)
export const PHONE_LEVELS = 3;                    // phone: the indent stops growing here and a breadcrumb takes over
export const CEO = '@ceo';                        // the root row's id (never a slug: slugs are [a-z0-9-])

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// epoch ms from a number or an ISO string (engine logs carry ISO); null when neither
export const toMs = (v) => { if (typeof v === 'number') return Number.isFinite(v) ? v : null; const t = typeof v === 'string' && v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pad = (n) => String(n).padStart(2, '0');
export const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');

// ---------------------------------------------------------------- time
export function clock(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
export function dayLabel(ts, now = Date.now()) {
  const d = new Date(ts), n = new Date(now);
  if (d.toDateString() === n.toDateString()) return clock(ts);
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === n.getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}
export function agoShort(ts, now = Date.now()) {
  if (!num(ts)) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60); if (m < 60) return `${m}m`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h`;
  const d = Math.round(h / 24); if (d < 7) return `${d}d`;
  return dayLabel(ts, now);
}
export function fmtDuration(ms) {
  const v = num(ms); if (v == null) return '';
  const s = Math.round(Math.max(0, v) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}
// "in 40m" / "in 5h" (under a day), "Dec 1" after; "due now" once past
export function untilLabel(at, now = Date.now()) {
  const d = at - now;
  if (d <= 0) return 'due now';
  const m = Math.max(1, Math.round(d / MIN));
  if (m < 60) return `in ${m}m`;                 // 59m50s rounds up: "in 1h", never "in 60m"
  const h = Math.round(d / HOUR);
  if (h < 24) return `in ${h}h`;                 // and never "in 24h"
  return dayLabel(at, now);
}

// ---------------------------------------------------------------- status
const LIVE = new Set(['working', 'waiting', 'idle', 'paused']);
export function liveStatus(row) {
  if (!row) return 'idle';
  if (row.status === 'paused' || row.paused) return 'paused';
  if (LIVE.has(row.status)) return row.status;
  if (LIVE.has(row.chatStatus)) return row.chatStatus;
  // PROTOCOL team.get: status is 'active' | 'paused'; a pending access request means its chat waits on you,
  // and `busy` ("answering CEO") means a turn is running
  if ((+row.pending?.requests || 0) > 0) return 'waiting';
  if (row.busy) return 'working';
  return 'idle';
}
// what a row says it is doing: the live `busy` text while working, else its last activity
export function rowActivity(row, now = Date.now()) {
  const last = fmtActivity(row?.lastActivity, now);
  return row?.busy ? { text: String(row.busy), ago: last.ago, title: String(row.busy) } : last;
}
export const STATUS_TEXT = { working: 'Working', waiting: 'Waiting on you', idle: 'Idle', paused: 'Paused' };
export const statusText = (st) => STATUS_TEXT[st] || 'Idle';
// the .dot class for a status (paused reads as an outlined, dimmed dot like a closed session)
export const dotClass = (st) => (st === 'paused' ? 'closed' : st === 'working' || st === 'waiting' ? st : 'idle');

export function fmtActivity(la, now = Date.now()) {
  if (!la) return { text: '', ago: '', title: '' };
  if (typeof la === 'string') return { text: la, ago: '', title: la };
  const at = num(la.at);
  return { text: String(la.text || ''), ago: at ? agoShort(at, now) : '', title: at ? `${la.text || 'Last activity'} · ${new Date(at).toLocaleString()}` : String(la.text || '') };
}
export function fmtNextDuty(nd, now = Date.now()) {
  if (!nd || !num(nd.at)) return null;
  const when = untilLabel(nd.at, now);
  const title = String(nd.title || 'Duty');
  return { label: `${when} · ${title}`, when, title, soon: nd.at - now < DAY, full: `Next duty: ${title}, ${new Date(nd.at).toLocaleString()}` };
}
export function pendingChips(pending) {
  const r = Math.max(0, +pending?.requests || 0), p = Math.max(0, +pending?.proposals || 0);
  const out = [];
  if (r) out.push({ kind: 'request', n: r, label: plural(r, 'request') });
  if (p) out.push({ kind: 'proposal', n: p, label: plural(p, 'proposal') });
  return out;
}
export const needsYou = (row) => Math.max(0, +row?.pending?.requests || 0) + Math.max(0, +row?.pending?.proposals || 0);

// header counts: "2 need you · 1 working". needsYou from team.list (includes the inbox lines that need you) wins.
export function companyCounts(tree, listNeedsYou) {
  const rows = Array.isArray(tree) ? tree : [];
  const st = (s) => rows.filter((r) => liveStatus(r) === s).length;
  const fromRows = rows.reduce((n, r) => n + needsYou(r), 0);
  return { positions: rows.length, needsYou: num(listNeedsYou) ?? fromRows, working: st('working'), waiting: st('waiting'), paused: st('paused') };
}
export function countsText(c) {
  const parts = [];
  if (c.needsYou) parts.push(`${c.needsYou} need${c.needsYou === 1 ? 's' : ''} you`);
  if (c.working) parts.push(`${c.working} working`);
  if (!parts.length) parts.push(c.positions ? `${plural(c.positions, 'position')}, all quiet` : 'No positions yet');
  return parts.join(' · ');
}

// ---------------------------------------------------------------- tree
// Index a flat tree. Depth is recomputed from parents (the stored value is only a hint); a row whose parent is
// missing, or that sits on a cycle, is shown at the top level and flagged `orphan` so nothing silently vanishes.
export function indexTree(tree) {
  const rows = (Array.isArray(tree) ? tree : []).filter((r) => r && r.id);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parentOf = (r) => (r.parent && byId.has(r.parent) && r.parent !== r.id ? r.parent : null);
  const depth = new Map(), orphan = new Set();
  for (const r of rows) {
    const seen = new Set([r.id]);
    let d = 1, cur = r, onCycle = false;
    while (parentOf(cur)) {
      const up = parentOf(cur);
      // only a row ON the cycle is an orphan; one that merely hangs below a cycle stays under its parent
      if (seen.has(up)) { onCycle = up === r.id; break; }
      seen.add(up); d++; cur = byId.get(up);
    }
    if (onCycle || r.parent === r.id || (r.parent && !byId.has(r.parent))) { orphan.add(r.id); depth.set(r.id, 1); } else depth.set(r.id, d);
  }
  const kids = new Map([[null, []]]);
  for (const r of rows) {
    const p = orphan.has(r.id) ? null : parentOf(r);
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(r.id);
  }
  // fix depths below an orphan (they hang under a row now shown at depth 1)
  const walk = (id, d) => { depth.set(id, d); for (const k of kids.get(id) || []) walk(k, d + 1); };
  for (const id of kids.get(null)) walk(id, 1);
  return { byId, kids, depth, orphan, roots: kids.get(null) };
}
export const isOpen = (open, id) => !open || open[id] !== false;   // default: everything open

export function ancestorsOf(ix, id) {
  const out = [];
  let cur = ix.byId.get(id);
  const seen = new Set();
  while (cur && cur.parent && ix.byId.has(cur.parent) && !ix.orphan.has(cur.id) && !seen.has(cur.parent)) {
    seen.add(cur.parent); out.unshift(cur.parent); cur = ix.byId.get(cur.parent);
  }
  return out;
}

// The rows on screen, CEO root first. Each: { id, depth, level, hasKids, open, indent, crumb, parentId, posinset, setsize }
export function visibleRows(tree, open, { phone = false } = {}) {
  const ix = indexTree(tree);
  const step = phone ? INDENT.phone : INDENT.desktop;
  const out = [{ id: CEO, ceo: true, depth: 0, level: 1, hasKids: ix.roots.length > 0, open: true, indent: 0, crumb: null, parentId: null, posinset: 1, setsize: 1 }];
  const add = (id, parentId, i, n) => {
    const d = ix.depth.get(id);
    const kids = ix.kids.get(id) || [];
    const o = kids.length > 0 && isOpen(open, id);
    const levels = phone ? Math.min(d, PHONE_LEVELS) : d;
    const parentName = parentId && parentId !== CEO ? ix.byId.get(parentId)?.name : null;
    out.push({ id, depth: d, level: d + 1, hasKids: kids.length > 0, open: o, indent: levels * step,
      crumb: phone && d > PHONE_LEVELS && parentName ? parentName : null,
      parentId: parentId || CEO, posinset: i + 1, setsize: n, orphan: ix.orphan.has(id) });
    if (o) kids.forEach((k, j) => add(k, id, j, kids.length));
  };
  ix.roots.forEach((id, i) => add(id, null, i, ix.roots.length));
  return out;
}

// Keyboard on the tree (WAI-ARIA tree pattern). Returns { focus } and/or { toggle: { id, open } } / { select }.
export function treeKey(rows, id, key) {
  const i = rows.findIndex((r) => r.id === id);
  const r = rows[i];
  if (!r) return rows.length ? { focus: rows[0].id } : {};
  switch (key) {
    case 'ArrowDown': return i < rows.length - 1 ? { focus: rows[i + 1].id } : {};
    case 'ArrowUp': return i > 0 ? { focus: rows[i - 1].id } : {};
    case 'Home': return { focus: rows[0].id };
    case 'End': return { focus: rows[rows.length - 1].id };
    case 'ArrowRight':
      if (r.hasKids && !r.open) return { toggle: { id: r.id, open: true } };
      if (r.hasKids && r.open && rows[i + 1]) return { focus: rows[i + 1].id };
      return {};
    case 'ArrowLeft':
      if (r.hasKids && r.open && !r.ceo) return { toggle: { id: r.id, open: false } };
      return r.parentId ? { focus: r.parentId } : {};
    case 'Enter': case ' ': return { select: r.id };
    default: return {};
  }
}

// Opening a row's ancestors so a selected (or linked) position is visible
export function revealOpen(tree, open, id) {
  const ix = indexTree(tree);
  const next = { ...(open || {}) };
  let changed = false;
  for (const a of ancestorsOf(ix, id)) if (next[a] === false) { delete next[a]; changed = true; }
  return changed ? next : open;
}

// ---------------------------------------------------------------- powers
// position.powers (own) holds tokens ($workspace, $company, $scope) and paths as written; position.effective holds
// the EXPANDED absolute paths (workspace first) the engine computed: own ∩ every manager's (tree.effective). Who cut
// what comes from the engine only: effective.limits [{ power, value, by, kept?, max? }] (value = an expanded path, a
// tool name, the own bash level, true), or PROTOCOL's position.limitedBy { "read:<path>" | "write:<path>" |
// "tools:<T>" | "bash" | "agents" | "worktree": "<ancestor id>" | "company" } (company = beyond the company folders).
export const BASH_TEXT = { off: 'Off', readonly: 'Read-only commands', on: 'On' };
export function tokenLabel(tok, scope) {
  if (tok === '$workspace') return 'Its workspace';
  if (tok === '$company') return 'Company folders';
  if (tok === '$scope') return scope?.kind === 'product' && scope.folder ? `Its scope: ${baseName(scope.folder)}` : 'Its scope (company folders)';
  return String(tok);
}
// a path key for comparing a UI-side path with an engine-normalised one (forward slashes, no trailing / or /**)
export function pathKey(p) {
  let s = String(p ?? '').trim().replace(/\\/g, '/');
  if (s.endsWith('/**')) s = s.slice(0, -3);
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s.toLowerCase();
}
const nameOr = (names, id) => (id === 'ceo' || id == null ? 'the CEO' : id === 'company' ? 'the company folders' : names?.[id] || id);
const uniq = (a) => [...new Set(a)];
// ctx: { companyFolders } (team.get company.folders) to see which of a token's folders the engine cut
// -> [{ key, label, items: [{ value, label, mono, limitedBy, partly?, title }] } | { key, label, text, limitedBy, title? }]
export function powerRows(pos, names = {}, ctx = {}) {
  const own = pos?.powers || {};
  const eff = pos?.effective && typeof pos.effective === 'object' ? pos.effective : null;
  const map = pos?.limitedBy && typeof pos.limitedBy === 'object' ? pos.limitedBy : {};
  // the engine's cut entries for one power
  const cuts = (power) => {
    if (Array.isArray(eff?.limits)) return eff.limits.filter((x) => x && x.power === power);
    const out = [];
    for (const [k, by] of Object.entries(map)) {
      if (k === power) out.push({ power, value: true, by });
      else if (k.startsWith(`${power}:`)) out.push({ power, value: k.slice(power.length + 1), by });
    }
    return out;
  };
  const isCo = (c) => c.by == null || c.by === 'company';
  // limitedBy: who cut it (names); limitNote: the words beside it, 'limited by General Counsel' | 'outside the company folders'
  const lim = (list) => {
    if (!list.length) return { limitedBy: null, limitNote: null };
    const ppl = uniq(list.filter((c) => !isCo(c)).map((c) => nameOr(names, c.by)));
    return { limitedBy: uniq(list.map((c) => nameOr(names, c.by))).join(', '),
      limitNote: [ppl.length ? `limited by ${ppl.join(', ')}` : '', list.some(isCo) ? 'outside the company folders' : ''].filter(Boolean).join(' · ') };
  };
  const folders = Array.isArray(ctx.companyFolders) ? ctx.companyFolders : [];
  const expand = (v) => {
    if (v === '$workspace') return eff?.workspace ? [eff.workspace] : [];
    if (v === '$company') return folders;
    if (v === '$scope') return pos?.scope?.kind === 'product' && pos.scope.folder ? [pos.scope.folder] : folders;
    return [v];
  };
  const matches = (v, c) => {
    const ck = pathKey(c.value);
    if (/^~[\\/]/.test(String(v))) return ck.endsWith(pathKey(String(v).slice(1)));
    return expand(v).some((x) => pathKey(x) === ck);
  };
  const paths = (power) => {
    const list = Array.isArray(own[power]) ? own[power] : [];
    const cs = cuts(power);
    const used = new Set();
    const items = list.map((v) => {
      const hit = cs.filter((c) => matches(v, c));
      hit.forEach((c) => used.add(c));
      const tok = String(v).startsWith('$');
      const n = tok ? expand(v).length : 1;
      const kept = uniq(hit.flatMap((c) => (Array.isArray(c.kept) ? c.kept : [])));
      return { value: v, label: tok ? tokenLabel(v, pos?.scope) : String(v), mono: !tok, ...lim(hit),
        partly: hit.length > 0 && hit.length < n,
        title: [tok ? expand(v).join('\n') : String(v), kept.length ? `Keeps only: ${kept.join(', ')}` : ''].filter(Boolean).join('\n') };
    });
    // a cut the UI could not tie to one listed entry (a ~ path, folders it does not know): listed on its own
    for (const c of cs) if (!used.has(c)) items.push({ value: String(c.value), label: String(c.value), mono: true, ...lim([c]), title: String(c.value) });
    return items;
  };
  const tools = () => {
    const cs = cuts('tools');
    return (Array.isArray(own.tools) ? own.tools : []).map((t) => {
      const hit = cs.filter((c) => c.value === t);
      return { value: t, label: t, mono: false, ...lim(hit), title: t };
    });
  };
  const flag = (kind, yes, no) => {
    const o = !!own[kind], e = eff ? !!eff[kind] : o;
    const hit = cuts(kind);
    return { key: kind, text: e ? yes : no, ...lim(hit), title: hit.length && o && !e ? `Listed: ${yes}` : undefined };
  };
  const ob = own.bash || 'off', eb = eff?.bash || ob;
  const bc = cuts('bash');
  return [
    { key: 'read', label: 'Read', items: paths('read') },
    { key: 'write', label: 'Write', items: paths('write') },
    { key: 'tools', label: 'Tools', items: tools() },
    { key: 'bash', label: 'Bash', text: BASH_TEXT[eb] || eb, ...lim(bc), title: bc.length ? `Listed: ${BASH_TEXT[ob] || ob}` : undefined },
    { ...flag('agents', 'May use subagents', 'No subagents'), label: 'Agents' },
    { ...flag('worktree', 'Works in its own git worktree', 'No worktree'), label: 'Worktree' },
  ];
}
export const GRANT_TEXT = { once: 'Approved once', always: 'Approved always', denied: 'Denied', 'no-answer': 'No answer' };
export const grantTone = (d) => (d === 'denied' ? 'danger' : d === 'no-answer' ? '' : 'ok');

// ---------------------------------------------------------------- duties
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const listWords = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const isInt = (s) => /^\d+$/.test(s);
export function cronWords(cron) {
  const f = String(cron || '').trim().split(/\s+/);
  if (f.length !== 5) return cron ? `Schedule ${cron}` : 'No schedule';
  const [m, h, dom, mon, dow] = f;
  const raw = `Schedule ${f.join(' ')}`;
  const every = (n, unit) => (+n === 1 ? `Every ${unit}` : `Every ${+n} ${unit}s`);
  if (/^\*\/\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return every(m.slice(2), 'minute');
  if (isInt(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every hour at :${pad(+m)}`;
  if (isInt(m) && /^\*\/\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') return every(h.slice(2), 'hour');
  if (!isInt(m) || !isInt(h)) return raw;
  const at = `at ${pad(+h)}:${pad(+m)}`;
  const days = dow === '*' ? null : dow.split(',');
  if (dom === '*' && mon === '*' && !days) return `Every day ${at}`;
  if (dom === '*' && mon === '*' && days) {
    if (dow === '1-5') return `Weekdays ${at}`;
    if (days.every(isInt) && days.every((d) => +d <= 7)) return `Every ${listWords(days.map((d) => DAYS[+d % 7]))} ${at}`;
    return raw;
  }
  if (isInt(dom) && dow === '*') {
    if (mon === '*') return `Monthly on the ${ordinal(+dom)} ${at}`;
    const ms = mon.split(',');
    if (ms.every(isInt) && ms.every((x) => +x >= 1 && +x <= 12)) return `On the ${ordinal(+dom)} of ${listWords(ms.map((x) => MONTHS[+x - 1]))} ${at}`;
  }
  return raw;
}
export function triggerWords(t, scope) {
  if (!t) return 'No trigger';
  const where = (repo) => (repo === '$scope' ? (scope?.kind === 'product' && scope.folder ? baseName(scope.folder) : 'its scope') : baseName(repo));
  if (t.kind === 'schedule') return cronWords(t.cron) + (t.catchUp === 'skip' ? ' · skips missed runs' : '');
  if (t.kind === 'event' && t.event === 'commit') {
    const paths = Array.isArray(t.paths) && t.paths.length ? ` touching ${t.paths.join(', ')}` : '';
    return `On a new commit to ${where(t.repo)}${t.branch ? ` (${t.branch})` : ''}${paths}`;
  }
  if (t.kind === 'event' && t.event === 'release') return `On a new tag${t.tag ? ` ${t.tag}` : ''} in ${where(t.repo)}`;
  if (t.kind === 'event' && t.event === 'file') return `When ${baseName(t.path)} changes`;
  return 'Custom trigger';
}
export const RUN_TEXT = { started: 'Running', done: 'Done', failed: 'Failed', skipped: 'Skipped', missed: 'Missed' };
export const runTone = (s) => (s === 'failed' ? 'danger' : s === 'missed' || s === 'skipped' ? 'warn' : s === 'done' ? 'ok' : '');

// ---------------------------------------------------------------- cross-talk
const TERMINAL = new Set(['answered', 'late', 'refused', 'expired', 'cancelled']);
export const ASK_TEXT = { asked: 'asked', delivered: 'answering', pending: 'still working', answered: 'answered', late: 'answered late', refused: 'refused', expired: 'expired', cancelled: 'cancelled' };
export const askTone = (s) => (s === 'refused' || s === 'expired' ? 'danger' : s === 'cancelled' ? '' : TERMINAL.has(s) ? 'ok' : 'live');
// Fold crosstalk.jsonl lines (one per state change) into one entry per ticket, chains nested under their parent.
// Idempotent: already-folded entries pass through. Newest chain first; a chain's children oldest first.
export function foldCrosstalk(lines) {
  const by = new Map();
  // already-folded input carries its chain in `children`: flatten it so a re-fold keeps every ticket
  const flat = [];
  // times arrive as ISO strings (crosstalk.jsonl `at`, team.crosstalk's folded askedAt / answeredAt) or epoch ms
  const norm = (l) => { const o = { ...l }; for (const k of ['at', 'askedAt', 'answeredAt', 'doneAt', 'updatedAt']) if (k in o) o[k] = toMs(o[k]); return o; };
  const flatten = (list) => { for (const l of list) { if (!l) continue; flat.push(norm(l)); if (Array.isArray(l.children)) flatten(l.children); } };
  flatten(Array.isArray(lines) ? lines : []);
  const sorted = flat.filter((l) => l.ticket)
    .sort((a, b) => (a.at ?? a.askedAt ?? 0) - (b.at ?? b.askedAt ?? 0));
  for (const l of sorted) {
    const cur = by.get(l.ticket) || { ticket: l.ticket, children: [] };
    const { at, children, ...rest } = l;
    for (const [k, v] of Object.entries(rest)) if (v != null && v !== '') cur[k] = v;
    const t = num(at);
    if (t != null) {
      if (cur.askedAt == null || (l.state === 'asked' && t < cur.askedAt)) cur.askedAt = t;
      if (TERMINAL.has(l.state)) cur.doneAt = t;
      cur.updatedAt = Math.max(cur.updatedAt || 0, t);
    }
    by.set(l.ticket, cur);
  }
  const all = [...by.values()];
  for (const e of all) {
    e.children = [];
    if (e.doneAt == null && e.answeredAt != null && TERMINAL.has(e.state)) e.doneAt = e.answeredAt;
    if (e.updatedAt == null) e.updatedAt = e.doneAt ?? e.askedAt ?? null;
    if (e.tookMs == null && e.doneAt != null && e.askedAt != null) e.tookMs = e.doneAt - e.askedAt;
  }
  const top = [];
  // a parentTicket loop (bad data) would hide every ticket on it: such entries stay top-level
  const loops = (e) => { const seen = new Set([e.ticket]); for (let t = e.parentTicket; t && by.has(t); t = by.get(t).parentTicket) { if (seen.has(t)) return t === e.ticket; seen.add(t); } return false; };
  for (const e of all) {
    const p = e.parentTicket && by.get(e.parentTicket);
    if (p && p !== e && !loops(e)) p.children.push(e); else top.push(e);
  }
  const t0 = (e) => e.askedAt ?? e.updatedAt ?? 0;
  for (const e of all) e.children.sort((a, b) => t0(a) - t0(b));
  return top.sort((a, b) => t0(b) - t0(a));
}
export function partyName(p, names = {}) {
  if (!p) return '?';
  if (typeof p === 'string') return names[p] || p;
  if (p.kind === 'ceo') return 'CEO';
  if (p.kind === 'owen') return 'You';
  return names[p.id] || p.name || p.id || '?';
}
export function oneLine(t, n = 80) { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
export function crosstalkLine(e, names = {}, now = Date.now()) {
  const state = e.state || 'asked';
  const live = !TERMINAL.has(state);
  return {
    from: partyName(e.from, names), to: typeof e.to === 'string' && !names?.[e.to] && e.toName ? e.toName : partyName(e.to, names),   // team.crosstalk's toName: a position no longer in the tree
    when: e.askedAt ? dayLabel(e.askedAt, now) : '',
    q: oneLine(e.question, 90),
    state, stateText: ASK_TEXT[state] || state, tone: askTone(state),
    took: live ? (e.askedAt ? fmtDuration(now - e.askedAt) : '') : fmtDuration(e.tookMs),
    colleague: e.kind === 'colleague',
  };
}
export function countCrosstalk(entries) { let n = 0; const walk = (l) => { for (const e of l) { n++; walk(e.children || []); } }; walk(entries || []); return n; }

// ---------------------------------------------------------------- notebook
// Checkbox lines ("- [ ] x" / "- [x] x"), outside code fences. Each block is markdown text or one checkbox item.
const TASK = /^(\s*)([-*+]) \[( |x|X)\] (.*)$/;
export function parseNotebook(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const blocks = [];
  let fence = null, buf = [], start = 0, open = 0, done = 0;
  const flush = (i) => { if (buf.length) blocks.push({ kind: 'md', text: buf.join('\n'), line: start }); buf = []; start = i; };
  lines.forEach((l, i) => {
    const f = l.match(/^\s*(```+|~~~+)/);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; }
    const m = !fence && !f ? l.match(TASK) : null;
    if (m) {
      flush(i);
      const checked = m[3] !== ' ';
      if (checked) done++; else open++;
      blocks.push({ kind: 'task', line: i, checked, text: m[4], indent: m[1].length });
      start = i + 1;
    } else { if (!buf.length) start = i; buf.push(l); }
  });
  flush(lines.length);
  return { blocks, open, done };
}
export const countOpenItems = (text) => parseNotebook(text).open;
// Tick or untick checkbox `line`. Returns the new text, or null when that line is no longer a checkbox
// (the file changed underneath: reload). Line endings are kept.
export function toggleItem(text, line, checked) {
  const src = String(text ?? '');
  const eol = /\r\n/.test(src) ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const m = lines[line]?.match(TASK);
  if (!m) return null;
  lines[line] = `${m[1]}${m[2]} [${checked ? 'x' : ' '}] ${m[4]}`;
  return lines.join(eol);
}

// ---------------------------------------------------------------- chats
const END_TEXT = { full: 'was full', 'handoff-failed': 'handoff failed', manual: 'ended by you', retired: 'position retired' };
export function chatRows(chats, now = Date.now()) {
  const list = (Array.isArray(chats) ? chats : []).filter((c) => c && num(c.n) != null).slice().sort((a, b) => b.n - a.n);
  return list.map((c, i) => {
    const current = !c.endedAt && i === 0;
    const started = c.startedAt ? dayLabel(Date.parse(c.startedAt) || c.startedAt, now) : '';
    const ended = c.endedAt ? dayLabel(Date.parse(c.endedAt) || c.endedAt, now) : '';
    return { n: c.n, current, sessionId: c.helmSessionId || null, label: `Chat ${c.n}`,
      sub: current ? `Current${started ? ` · started ${started}` : ''}` : `${started ? `${started} – ` : ''}${ended || 'ended'}${c.endReason ? ` · ${END_TEXT[c.endReason] || c.endReason}` : ''}`,
      pct: num(c.contextPct), handoff: c.handoff || null };
  });
}

// ---------------------------------------------------------------- proposals + inbox
export function proposalTitle(p, names = {}) {
  if (!p) return '';
  if (p.title) return p.title;
  const d = p.draft || {};
  const who = (id) => names[id] || d.name || id;
  if (p.action === 'create') return `New position: ${d.name || p.target} under ${p.parent || d.parent ? names[p.parent || d.parent] || p.parent || d.parent : 'the CEO'}`;
  if (p.action === 'edit') return `Change ${who(p.target)}`;
  if (p.action === 'retire') return `Retire ${who(p.target)}`;
  if (p.action === 'company') return `New company: ${d.name || ''}`.trim();
  return 'Proposal';
}
export function proposalStatus(p) { return p?.status || p?.decision?.result || 'open'; }
export function decidedText(p) {
  const d = p?.decision;
  const st = proposalStatus(p);
  if (st === 'open') return '';
  if (st === 'superseded') return 'Superseded by a newer proposal';
  const at = d?.at ? ` ${clock(Date.parse(d.at) || d.at)}` : '';
  const how = d?.how === 'typed' ? (d.quote ? ` (your reply '${oneLine(d.quote, 40)}')` : ' (your reply)') : d?.how === 'click' ? ' (your click)' : '';
  return `${st === 'approved' ? 'Approved' : 'Declined'}${at}${how}`;
}
export function splitProposals(list) {
  const all = Array.isArray(list) ? list : [];
  const t = (p) => Date.parse(p.at) || p.at || 0;
  return { open: all.filter((p) => proposalStatus(p) === 'open').sort((a, b) => t(b) - t(a)), decided: all.filter((p) => proposalStatus(p) !== 'open').sort((a, b) => t(b) - t(a)) };
}
// ---------------------------------------------------------------- proposal changes (engine shapes)
// What a proposal card must show before Approve, built from main/engine/team/proposals.js:
//   p.excess (an edit also carries it as p.diff.excess): [{ power, value, by, kept?, max? }] = what the draft lists
//     beyond its manager's effective powers (tree.excess). Approving keeps them listed, but effective powers are
//     own ∩ the manager's, so the position will NOT have them: they are cut. read / write values are expanded
//     absolute paths; by = the ancestor that lacks it ('company' = beyond the company folders); kept = the narrower
//     part that stays; max = the highest Bash level allowed. { power: 'parent', by: null } = its manager is not
//     approved yet (checked again when it is).
//   p.diff (edit): { brief?: line diff (" x" / "-x" / "+x" lines), powers?: { added, removed } of entries such as
//     "read: $workspace", "tools: WebFetch", 'bash: "on"', "agents: true", duties?: { added: [id], removed: [id] },
//     parent | name | remit | model | effort | status | scope?: { from, to } }
//   p.draft.scope: { kind: 'company' } | { kind: 'product', folder }
const nameFn = (names) => (typeof names === 'function' ? names : (id) => names?.[id] || id);
const arrOf = (v) => (Array.isArray(v) ? v.filter((x) => x != null && x !== '') : []);
export function scopeWords(scope) {
  if (scope && typeof scope === 'object') {
    if (scope.kind === 'product') return scope.folder ? `One product: ${baseName(scope.folder)}` : 'One product';
    if (scope.kind === 'company' || !scope.kind) return 'The whole company';
    return String(scope.kind);
  }
  return typeof scope === 'string' && scope ? scope : 'The whole company';
}
const PATH_WORD = { $workspace: 'its workspace', $company: 'company folders' };
export function pathWords(v, scope) {
  if (v === '$scope') return scope?.kind === 'product' && scope.folder ? `its scope (${baseName(scope.folder)})` : 'its scope (company folders)';
  return PATH_WORD[v] || String(v);
}
// "read: $workspace" / 'bash: "on"' / "agents: true" (proposals.js powerEntries) -> { power, value }
export function parsePowerEntry(s) {
  const t = String(s ?? '');
  const i = t.indexOf(': ');
  if (i < 0) return { power: t, value: true };
  const power = t.slice(0, i), raw = t.slice(i + 2);
  let value = raw;
  if (!['read', 'write', 'tools'].includes(power) || /^["[{]/.test(raw)) { try { value = JSON.parse(raw); } catch { value = raw; } }
  return { power, value };
}
const BASH_WORD = { off: 'off', readonly: 'read-only', on: 'on' };
// one power in words -> { label, mono, title }
export function powerWords(power, value, scope) {
  if (power === 'read' || power === 'write') {
    const tok = typeof value === 'string' && value.startsWith('$');
    return { label: `${power === 'read' ? 'Read' : 'Write'} ${pathWords(value, scope)}`, mono: !tok, title: String(value) };
  }
  if (power === 'tools') return { label: Array.isArray(value) ? value.join(', ') : String(value), mono: false, title: 'Tool' };
  if (power === 'bash') return { label: `Bash ${BASH_WORD[value] || value}`, mono: false, title: 'Shell commands' };
  if (power === 'agents') return { label: value ? 'Subagents' : 'No subagents', mono: false, title: '' };
  if (power === 'worktree') return { label: value ? 'Own git worktree' : 'No git worktree', mono: false, title: '' };
  return { label: `${power}: ${typeof value === 'string' ? value : JSON.stringify(value)}`, mono: false, title: '' };
}
// excess -> rows the card lists under "would be cut"
export function excessRows(list, names = {}, scope) {
  const nm = nameFn(names);
  return arrOf(list).filter((x) => x && x.power).map((x) => {
    if (x.power === 'parent') return { power: 'parent', value: x.value, waits: true, label: `Its manager (${nm(x.value)}) is not approved yet`, why: 'its powers are checked against the manager once that is approved', title: '' };
    const w = powerWords(x.power, x.value, scope);
    const company = x.by == null || x.by === 'company';
    const byName = company ? null : nm(x.by);
    const why = company ? 'outside the company folders'
      : x.power === 'bash' && x.max === 'off' ? `${byName} has no Bash`
      : x.power === 'bash' && x.max ? `${byName} allows Bash ${BASH_WORD[x.max] || x.max} at most` : `${byName} does not have it`;
    return { power: x.power, value: x.value, label: w.label, mono: w.mono, title: w.title, by: company ? 'company' : x.by, byName, why, kept: arrOf(x.kept), max: x.max || null };
  });
}
export function excessOf(p) {
  if (Array.isArray(p?.excess) && p.excess.length) return p.excess;
  return Array.isArray(p?.diff?.excess) ? p.diff.excess : [];
}
// the notice's first line: what Approve really gives
export function excessHeadline(rows, who = 'the position') {
  const cut = rows.filter((r) => !r.waits);
  if (!cut.length) return rows.length ? 'Its powers are checked once its manager is approved' : '';
  return `${cut.length === 1 ? 'One power goes' : `${cut.length} powers go`} beyond its manager's, so ${who} will not have ${cut.length === 1 ? 'it' : 'them'} even if you approve`;
}
// the engine's line diff -> rows with 2 lines of context around each change, long unchanged runs folded
export function briefDiffRows(text, ctx = 2) {
  const src = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const lines = src.map((l) => ({ t: l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'same', text: l.length ? l.slice(1) : '' }));
  while (lines.length && lines[lines.length - 1].t === 'same' && !lines[lines.length - 1].text) lines.pop();
  const keep = lines.map(() => false);
  lines.forEach((l, i) => { if (l.t !== 'same') for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) keep[j] = true; });
  const rows = [];
  let gap = 0;
  lines.forEach((l, i) => { if (keep[i]) { if (gap) rows.push({ t: 'gap', n: gap }); gap = 0; rows.push(l); } else gap++; });
  if (gap) rows.push({ t: 'gap', n: gap });
  return { rows, added: lines.filter((l) => l.t === 'add').length, removed: lines.filter((l) => l.t === 'del').length };
}
const FIELDS = [['name', 'Name'], ['parent', 'Reports to'], ['remit', 'Remit'], ['scope', 'Scope'], ['model', 'Model'], ['effort', 'Effort'], ['status', 'Status']];
const STATUS_WORD = { active: 'Active', paused: 'Paused', retired: 'Retired' };
export function fieldChanges(diff, names = {}) {
  const nm = nameFn(names);
  const word = (k, v) => {
    if (k === 'parent') return v == null ? 'the CEO' : nm(v);
    if (k === 'scope') return scopeWords(v);
    if (k === 'status') return STATUS_WORD[v] || String(v ?? '');
    if (k === 'model' || k === 'effort') return v == null ? 'Helm default' : String(v);
    return v == null ? '' : String(v);
  };
  const title = (k, v) => (k === 'scope' && v?.folder ? v.folder : undefined);
  return FIELDS.filter(([k]) => diff && diff[k] && typeof diff[k] === 'object' && 'to' in diff[k])
    .map(([k, label]) => ({ key: k, label, from: word(k, diff[k].from), to: word(k, diff[k].to), fromTitle: title(k, diff[k].from), toTitle: title(k, diff[k].to) }));
}
// Everything a proposal changes, in words. names: { id: name } or id => name. current: the position's duties now
// (to name a removed duty). -> { fields, brief, powers, duties, excess }
export function proposalChanges(p, names = {}, { duties: current = [] } = {}) {
  const diff = p?.diff && typeof p.diff === 'object' ? p.diff : null;
  const d = p?.draft || {};
  const scope = d.scope;
  const pw = (list) => arrOf(list).map((s) => { const e = parsePowerEntry(s); return { ...e, ...powerWords(e.power, e.value, scope) }; });
  const duty = (id, from) => { const x = arrOf(from).find((y) => y && y.id === id); return { id, title: x?.title || id, trigger: x?.trigger ? triggerWords(x.trigger, scope) : '' }; };
  let duties = null;
  if (diff?.duties) {
    const add = arrOf(diff.duties.added), rem = arrOf(diff.duties.removed);
    const both = add.filter((x) => rem.includes(x));
    duties = { added: add.filter((x) => !both.includes(x)).map((id) => duty(id, d.duties)), changed: both.map((id) => duty(id, d.duties)),
      removed: rem.filter((x) => !both.includes(x)).map((id) => duty(id, current)) };
  }
  return {
    fields: diff ? fieldChanges(diff, names) : [],
    brief: typeof diff?.brief === 'string' ? briefDiffRows(diff.brief) : null,
    powers: diff?.powers ? { added: pw(diff.powers.added), removed: pw(diff.powers.removed) } : null,
    duties,
    excess: excessRows(excessOf(p), names, scope),
  };
}
// a create card's powers as chips; cut = the engine listed it in excess (a token's folders are listed in the notice)
export function draftPowerChips(powers, scope, excess = []) {
  if (!powers || typeof powers !== 'object') return [];
  const ex = arrOf(excess);
  const cutPath = (power, v) => typeof v === 'string' && !v.startsWith('$') && ex.some((x) => x.power === power && pathKey(x.value) === pathKey(v));
  const out = [];
  for (const power of ['read', 'write']) for (const v of arrOf(powers[power])) out.push({ power, value: v, ...powerWords(power, v, scope), cut: cutPath(power, v) });
  for (const t of arrOf(powers.tools)) out.push({ power: 'tools', value: t, ...powerWords('tools', t, scope), cut: ex.some((x) => x.power === 'tools' && x.value === t) });
  if (powers.bash) out.push({ power: 'bash', value: powers.bash, ...powerWords('bash', powers.bash, scope), cut: ex.some((x) => x.power === 'bash') });
  for (const k of ['agents', 'worktree']) if (powers[k]) out.push({ power: k, value: true, ...powerWords(k, true, scope), cut: ex.some((x) => x.power === k) });
  return out;
}
export const liveInbox = (entries) => (Array.isArray(entries) ? entries : []).filter((e) => e && !e.dismissedAt);
