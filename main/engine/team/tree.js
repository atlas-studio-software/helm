// Positions: the org tree of one company, as pure functions over its position.json values (docs/POSITIONS.md 6.4, 7.2).
// The tree is the `parent` field (flat ids); the CEO is depth 0 and is not a stored position.
//
//   const t = createTree(positions)            positions: array of validated position values (retired ones are ignored)
//   t.get(id) / t.has(id) / t.ids() / t.liveCount()
//   t.parentOf(id) / t.reports(id | null)      direct reports (null = the CEO's)
//   t.ancestors(id)                            nearest first, CEO not included
//   t.depth(id)                                1 for a top-level position; Infinity on a cycle or a missing parent
//   t.subtree(id)                              every descendant (not id itself), breadth first
//   t.height(id)                               levels below id (0 for a leaf)
//   t.problems()                               [{ id, reason }]: cycles, missing parents, depth, report and company caps
//   t.checkCreate({ id, parent }, { taken })   -> [errors]   (taken: every id ever used, live and retired)
//   t.checkReparent(id, newParent)             -> [errors]
//   t.withParent(id, newParent)                -> a new tree with that one change (for previews)
//   t.planRetire(id, mode)                     -> { ok, errors, retire: [ids, deepest first], moves: [{ id, from, to }] }
//   t.effective(id, ctx)                       -> effective powers (own ∩ every ancestor's) + limitedBy
//   t.excess(powers, parent, ctx, selfCtx)     -> [{ power, value, ... }] what a draft lists beyond its manager
//   t.widens(id, request, ctx)                 -> { ancestors: [ids nearest first], beyondCompany } for "Approve always"
//   t.cutsAfterReparent(id, newParent, ctx)    -> [{ id, power, value, by }] what a move would cut in the moved subtree
// ctx: { companyFolders: [abs], workspaceOf: (id) => abs, home? }
'use strict';

const S = require('./schema');

const BASH_RANK = { off: 0, readonly: 1, on: 2 };
const RANK_BASH = ['off', 'readonly', 'on'];
const CEO = 'company'; // the name used in limitedBy / widens for the CEO level (all company folders, every tool)

// ---------- path-set algebra ----------
// An entry without a glob means that file or folder and everything under it. An entry with a glob is matched as a
// pattern; its "base" is the literal folder before the first glob segment. The algebra is conservative: when two
// globs overlap in a way it cannot prove, the intersection drops them (a report can only ever get LESS).
function globBase(p) {
  const segs = p.split('/');
  const i = segs.findIndex((s) => S.hasGlob(s));
  return i < 0 ? p : segs.slice(0, i).join('/') || '/';
}

// x ⊆ s ?
function subset(x, s) {
  if (S.pathKey(x) === S.pathKey(s)) return true;
  if (S.hasGlob(s)) return false;
  return S.isUnder(S.hasGlob(x) ? globBase(x) : x, s);
}

const covered = (x, set) => set.some((s) => subset(x, s));

function intersectPaths(own, limit) {
  const out = [];
  const seen = new Set();
  const add = (p) => { const k = S.pathKey(p); if (!seen.has(k)) { seen.add(k); out.push(p); } };
  for (const o of own) {
    if (covered(o, limit)) add(o);
    else for (const l of limit) if (subset(l, o)) add(l);
  }
  return out;
}

// ---------- the tree ----------
function createTree(positions) {
  const byId = new Map();
  const kids = new Map(); // parent id | null -> [ids] in input order
  for (const p of positions || []) {
    if (!p || !p.id || p.status === 'retired') continue;
    byId.set(p.id, p);
  }
  for (const p of byId.values()) {
    const par = p.parent == null ? null : p.parent;
    if (!kids.has(par)) kids.set(par, []);
    kids.get(par).push(p.id);
  }

  const get = (id) => byId.get(id) || null;
  const has = (id) => byId.has(id);
  const parentOf = (id) => { const p = get(id); return p ? (p.parent == null ? null : p.parent) : undefined; };
  const reports = (id) => (kids.get(id == null ? null : id) || []).slice();

  // nearest first; stops (and flags) on a cycle or a dangling parent
  function walk(id) {
    const out = [];
    const seen = new Set([id]);
    let cur = parentOf(id);
    while (cur != null) {
      if (seen.has(cur)) return { chain: out, broken: 'cycle' };
      if (!has(cur)) return { chain: out, broken: 'missing', missing: cur };
      seen.add(cur);
      out.push(cur);
      cur = parentOf(cur);
    }
    return { chain: out, broken: null };
  }
  const ancestors = (id) => walk(id).chain;
  function depth(id) {
    if (!has(id)) return Infinity;
    const w = walk(id);
    return w.broken ? Infinity : w.chain.length + 1;
  }
  function subtree(id) {
    const out = [];
    const seen = new Set([id]);
    const q = reports(id);
    while (q.length) {
      const c = q.shift();
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      q.push(...reports(c));
    }
    return out;
  }
  function height(id) {
    let h = 0;
    const seen = new Set([id]);
    const rec = (n, d) => {
      for (const c of reports(n)) {
        if (seen.has(c)) continue;
        seen.add(c);
        h = Math.max(h, d + 1);
        rec(c, d + 1);
      }
    };
    rec(id, 0);
    return h;
  }

  function problems() {
    const out = [];
    for (const id of byId.keys()) {
      const w = walk(id);
      if (w.broken === 'cycle') out.push({ id, reason: `"${id}" is in a reporting cycle (${[id, ...w.chain].join(' -> ')} -> ...)` });
      else if (w.broken === 'missing') out.push({ id, reason: `"${id}" reports to "${w.missing}", which is not a live position` });
      else if (w.chain.length + 1 > S.LIMITS.maxDepth) out.push({ id, reason: `"${id}" is at depth ${w.chain.length + 1}; the cap is ${S.LIMITS.maxDepth}` });
    }
    for (const [par, list] of kids) {
      if (list.length > S.LIMITS.maxReports) out.push({ id: par, reason: `${par == null ? 'The CEO' : `"${par}"`} has ${list.length} direct reports; the cap is ${S.LIMITS.maxReports}` });
    }
    if (byId.size > S.LIMITS.maxPositions) out.push({ id: null, reason: `${byId.size} live positions; the cap is ${S.LIMITS.maxPositions} per company` });
    return out;
  }

  function checkCreate({ id, parent = null } = {}, { taken = [] } = {}) {
    const errors = [];
    const takenSet = taken instanceof Set ? taken : new Set(taken);
    const idErr = S.checkId(id);
    if (idErr) errors.push(idErr);
    else if (has(id) || takenSet.has(id)) errors.push(`id: "${id}" is already used in this company (ids stay unique, retired ones too)`);
    if (parent != null) {
      if (!has(parent)) errors.push(`parent: "${parent}" is not a live position in this company`);
      else {
        const d = depth(parent);
        if (!Number.isFinite(d)) errors.push(`parent: "${parent}" has a broken reporting line; fix it first`);
        else if (d + 1 > S.LIMITS.maxDepth) errors.push(`parent: a report under "${parent}" would be at depth ${d + 1}; the cap is ${S.LIMITS.maxDepth}`);
      }
    }
    if (reports(parent).length >= S.LIMITS.maxReports) errors.push(`parent: ${parent == null ? 'the CEO' : `"${parent}"`} already has ${S.LIMITS.maxReports} direct reports (the cap)`);
    if (byId.size >= S.LIMITS.maxPositions) errors.push(`company: already ${S.LIMITS.maxPositions} live positions (the cap)`);
    return errors;
  }

  function checkReparent(id, newParent) {
    const errors = [];
    newParent = newParent == null ? null : newParent;
    if (!has(id)) return [`id: "${id}" is not a live position`];
    if (newParent === id) return ['parent: a position cannot report to itself'];
    if (newParent === parentOf(id)) return errors; // no move
    if (newParent != null) {
      if (!has(newParent)) return [`parent: "${newParent}" is not a live position in this company`];
      if (subtree(id).includes(newParent)) return [`parent: "${newParent}" reports (directly or not) to "${id}"; that move would make a cycle`];
      const d = depth(newParent);
      if (!Number.isFinite(d)) return [`parent: "${newParent}" has a broken reporting line; fix it first`];
      const deepest = d + 1 + height(id);
      if (deepest > S.LIMITS.maxDepth) errors.push(`parent: the move puts "${id}"'s subtree down to depth ${deepest}; the cap is ${S.LIMITS.maxDepth}`);
    }
    if (reports(newParent).length >= S.LIMITS.maxReports) errors.push(`parent: ${newParent == null ? 'the CEO' : `"${newParent}"`} already has ${S.LIMITS.maxReports} direct reports (the cap)`);
    return errors;
  }

  function withParent(id, newParent) {
    const list = [...byId.values()].map((p) => (p.id === id ? { ...p, parent: newParent == null ? null : newParent } : p));
    return createTree(list);
  }

  function planRetire(id, mode = 'move-up') {
    if (!has(id)) return { ok: false, errors: [`id: "${id}" is not a live position`], retire: [], moves: [] };
    if (!['move-up', 'retire-too'].includes(mode)) return { ok: false, errors: ['reports_on_retire: must be move-up or retire-too'], retire: [], moves: [] };
    const to = parentOf(id);
    if (mode === 'retire-too') {
      const sub = subtree(id);
      const retire = [...sub].sort((a, b) => depth(b) - depth(a));
      retire.push(id);
      return { ok: true, errors: [], retire, moves: [] };
    }
    const mine = reports(id);
    const errors = [];
    const after = reports(to).length - 1 + mine.length;
    if (after > S.LIMITS.maxReports) {
      errors.push(`reports_on_retire: moving ${mine.length} report(s) up would give ${to == null ? 'the CEO' : `"${to}"`} ${after} direct reports (cap ${S.LIMITS.maxReports}); re-parent some first or use retire-too`);
    }
    return { ok: errors.length === 0, errors, retire: [id], moves: mine.map((r) => ({ id: r, from: id, to })) };
  }

  // ---------- powers ----------
  const ROOT = (ctx) => {
    const folders = S.expandPathTokens(ctx.companyFolders || [], ctx);
    return { read: folders, write: folders, tools: '*', bash: 'on', agents: true, worktree: true };
  };

  // own powers of a position (or draft) with tokens expanded, its workspace taken out (that is personal: always on
  // for the position itself, never inherited by its reports, so a report can never reach its manager's notebook)
  function ownExpanded(p, ctx, workspace) {
    const pw = p.powers || S.defaultPowers();
    const c = {
      workspace,
      companyFolders: ctx.companyFolders || [],
      scopeFolder: p.scope && p.scope.kind === 'product' ? p.scope.folder : null,
      home: ctx.home,
    };
    const strip = (list) => S.expandPathTokens(list, c).filter((x) => !(workspace && S.pathKey(x) === S.pathKey(S.normPath(workspace))));
    return {
      read: strip(pw.read || []),
      write: strip(pw.write || []),
      tools: (pw.tools || []).slice(),
      bash: pw.bash || 'off',
      agents: pw.agents === true,
      worktree: pw.worktree === true,
    };
  }

  function meet(own, lim) {
    const agents = own.agents && lim.agents;
    const bash = RANK_BASH[Math.min(BASH_RANK[own.bash] ?? 0, BASH_RANK[lim.bash] ?? 0)];
    let tools = lim.tools === '*' ? own.tools.slice() : own.tools.filter((t) => lim.tools.includes(t));
    if (!agents) tools = tools.filter((t) => !S.AGENT_TOOLS.includes(t));
    if (bash === 'off') tools = tools.filter((t) => t !== 'Bash' && t !== 'PowerShell');
    return {
      read: intersectPaths(own.read, lim.read),
      write: intersectPaths(own.write, lim.write),
      tools, bash, agents,
      worktree: own.worktree && lim.worktree,
    };
  }

  const wsOf = (ctx, id) => (ctx.workspaceOf ? ctx.workspaceOf(id) : null);

  // inherited limits, top down: levels[0] = CEO, then each ancestor (farthest first). Throws nothing; a broken line
  // (cycle, missing parent) limits to nothing at all.
  function levelsAbove(id, ctx) {
    const w = walk(id);
    const root = ROOT(ctx);
    if (w.broken) return { levels: [{ by: CEO, eff: { read: [], write: [], tools: [], bash: 'off', agents: false, worktree: false } }], broken: w.broken };
    const levels = [{ by: CEO, eff: root }];
    let eff = root;
    for (const a of w.chain.slice().reverse()) {
      eff = meet(ownExpanded(get(a), ctx, wsOf(ctx, a)), eff);
      levels.push({ by: a, eff });
    }
    return { levels, broken: null };
  }

  function containsPower(eff, power, value) {
    if (power === 'read' || power === 'write') return covered(value, eff[power]);
    if (power === 'tools') return eff.tools === '*' || eff.tools.includes(value);
    if (power === 'bash') return (BASH_RANK[eff.bash] ?? 0) >= (BASH_RANK[value] ?? 0);
    return eff[power] === true || !value; // agents / worktree
  }

  function diffAgainst(own, levels) {
    const out = [];
    const firstCut = (power, value) => {
      for (const l of levels) if (!containsPower(l.eff, power, value)) return l.by;
      return null;
    };
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
      if (!by && S.AGENT_TOOLS.includes(t) && !lim.agents) by = firstCut('agents', true);
      if (!by && (t === 'Bash' || t === 'PowerShell') && lim.bash === 'off') by = firstCut('bash', 'readonly');
      if (by) out.push({ power: 'tools', value: t, by });
    }
    if ((BASH_RANK[own.bash] ?? 0) > (BASH_RANK[lim.bash] ?? 0)) out.push({ power: 'bash', value: own.bash, max: lim.bash, by: firstCut('bash', own.bash) });
    for (const power of ['agents', 'worktree']) if (own[power] && !lim[power]) out.push({ power, value: true, by: firstCut(power, true) });
    return out;
  }

  // effective(p) = own(p) ∩ effective(parent(p)); the CEO level is the company (all folders, every tool).
  // -> { read, write, tools, bash, agents, worktree, workspace, limitedBy: [{ power, value, by, kept?, max? }], broken }
  function effective(id, ctx = {}) {
    const p = get(id);
    if (!p) return null;
    const ws = wsOf(ctx, id);
    const own = ownExpanded(p, ctx, ws);
    const { levels, broken } = levelsAbove(id, ctx);
    const eff = meet(own, levels[levels.length - 1].eff);
    const wsN = ws ? S.normPath(ws) : null;
    return {
      read: wsN ? [wsN, ...eff.read] : eff.read,
      write: wsN ? [wsN, ...eff.write] : eff.write,
      tools: eff.tools, bash: eff.bash, agents: eff.agents, worktree: eff.worktree,
      workspace: wsN,
      limitedBy: diffAgainst(own, levels),
      broken,
    };
  }

  // What a draft's powers list beyond its (future) manager's effective powers. selfCtx: { workspace } of the draft.
  // -> [{ power, value, by, max?, kept? }]; empty = fits.
  function excess(powers, parent, ctx = {}, selfCtx = {}) {
    const draft = { powers, scope: selfCtx.scope || { kind: 'company' } };
    const own = ownExpanded(draft, ctx, selfCtx.workspace || null);
    let levels;
    if (parent == null) levels = [{ by: CEO, eff: ROOT(ctx) }];
    else if (!has(parent)) return [{ power: 'parent', value: parent, by: null }];
    else {
      const up = levelsAbove(parent, ctx);
      const pe = meet(ownExpanded(get(parent), ctx, wsOf(ctx, parent)), up.levels[up.levels.length - 1].eff);
      levels = [...up.levels, { by: parent, eff: pe }];
    }
    return diffAgainst(own, levels);
  }

  // For "Approve always": which ancestors' OWN powers do not cover the request, so saving it also widens them.
  // request: { kind: 'read'|'write'|'tool'|'bash', target }. beyondCompany: the CEO level itself does not cover it.
  function widens(id, request, ctx = {}) {
    const p = get(id);
    if (!p) return { ancestors: [], beyondCompany: false };
    const map = { read: 'read', write: 'write', tool: 'tools', bash: 'bash' };
    const power = map[request && request.kind];
    if (!power) return { ancestors: [], beyondCompany: false };
    let value = request.target;
    if (power === 'bash') value = String(value || '').replace(/^bash:/, '');
    if (power === 'read' || power === 'write') value = S.normPath(S.expandHome(String(value || ''), ctx.home));
    const out = [];
    for (const a of ancestors(id)) {
      const own = ownExpanded(get(a), ctx, wsOf(ctx, a));
      if (!containsPower(own, power, value)) out.push(a);
    }
    return { ancestors: out, beyondCompany: !containsPower(ROOT(ctx), power, value) };
  }

  // Only what the move itself cuts: a limit the position already had under its current manager is not listed.
  function cutsAfterReparent(id, newParent, ctx = {}) {
    const next = withParent(id, newParent);
    const out = [];
    const key = (c) => `${c.power}\u0000${c.power === 'read' || c.power === 'write' ? S.pathKey(c.value) : c.value}`;
    for (const n of [id, ...next.subtree(id)]) {
      const before = new Set(((effective(n, ctx) || {}).limitedBy || []).map(key));
      const e = next.effective(n, ctx);
      if (e) for (const c of e.limitedBy) if (!before.has(key(c))) out.push({ id: n, ...c });
    }
    return out;
  }

  return {
    get, has, parentOf, reports, ancestors, depth, subtree, height, problems,
    ids: () => [...byId.keys()],
    liveCount: () => byId.size,
    checkCreate, checkReparent, withParent, planRetire,
    effective, excess, widens, cutsAfterReparent,
  };
}

module.exports = { createTree, intersectPaths, subset, globBase, CEO };
