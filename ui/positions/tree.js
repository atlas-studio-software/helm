// Team view: the org tree (Positions, lane T6; spec docs/POSITIONS.md 10.2). Rows, not a drawn chart, so it
// works at 320 px. Each row is a roster card: status dot, name, one-line remit, what it did last and when, and
// chips for what needs you (requests, proposals), open notebook items and the next duty.
// Indent: 16 px a level on desktop, 12 px on the phone, where it stops at level 3 and the row names its
// manager instead ("… › Tax ›"). Keyboard: the WAI-ARIA tree pattern (roving tabindex; arrows, Home/End, Enter).
// Departments: when the company has one, the CEO's top level is grouped under a header per department (then "No
// department"); the header is not a tree item, so the keyboard model is unchanged.
import { useEffect, useRef } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { cx } from '../shell/util.js';
import { visibleRows, treeKey, liveStatus, statusText, dotClass, rowActivity, fmtNextDuty, pendingChips, needsYou, baseName, CEO, INDENT } from '../lib/positions-model.js';
import { opens, selected, setOpen, select } from './state.js';

// remembered across re-renders and company switches: which row holds the roving tab stop
const focusOf = new Map();
const justOpened = new Set();   // rows whose children should play the reveal (cleared after it ran)

function Chev({ row, name }) {
  const flip = (e) => {
    e.stopPropagation();
    if (!row.open) { justOpened.add(row.id); setTimeout(() => justOpened.delete(row.id), 600); }
    setOpen(row.id, !row.open);
  };
  return html`<button type="button" class=${cx('pos-chev', row.open && 'open')} tabindex="-1" aria-hidden="true"
    title=${row.open ? `Collapse ${name}` : `Expand ${name}`} onClick=${flip}><${Icon} name="chevron-right" size=${14} /></button>`;
}

function CeoRow({ row, company, sel, tab, onSelect, positions }) {
  const n = company?.folders?.length || 0;
  const names = (company?.folders || []).map(baseName).join(', ');
  return html`<div role="none" class="pos-row" style=${{ '--indent': '0px' }}>
    <div role="treeitem" class=${cx('pos-card pos-ceo', sel && 'sel')} data-id=${CEO} tabindex=${tab ? 0 : -1}
      aria-level="1" aria-expanded=${row.hasKids ? 'true' : undefined} aria-selected=${sel ? 'true' : 'false'}
      aria-label=${`CEO: your chats in ${n === 1 ? 'this folder' : `these ${n} folders`}. ${positions} direct and indirect positions.`}
      onClick=${() => onSelect(CEO)}>
      <span class="pos-l1">
        <span class="pos-ceo-mark" aria-hidden="true"><${Icon} name="chat" size=${13} /></span>
        <span class="pos-name">CEO</span>
        <span class="pos-ceo-sub truncate">your chats in these folders</span>
        <span class="pos-ago tnum">${n} folder${n === 1 ? '' : 's'}</span>
      </span>
      <span class="pos-remit truncate mono" title=${(company?.folders || []).join('\n')}>${names || 'No folders'}</span>
    </div>
  </div>`;
}

function Row({ row, node, sel, tab, onSelect, enter }) {
  const st = liveStatus(node);
  const act = rowActivity(node);
  const duty = fmtNextDuty(node.nextDuty);
  const chips = pendingChips(node.pending);
  const open = Math.max(0, +node.openItems || 0);
  const label = [`${node.name}`, statusText(st), node.remit, chips.map((c) => c.label).join(', '), open ? `${open} open items` : '', duty ? duty.full : ''].filter(Boolean).join('. ');
  return html`<div role="none" class=${cx('pos-row', enter && 'enter')} style=${{ '--indent': `${row.indent}px` }}>
    <div role="treeitem" class=${cx('pos-card', `st-${st}`, sel && 'sel', needsYou(node) > 0 && 'needs')} data-id=${row.id}
      tabindex=${tab ? 0 : -1} aria-level=${row.level} aria-setsize=${row.setsize} aria-posinset=${row.posinset}
      aria-expanded=${row.hasKids ? String(row.open) : undefined} aria-selected=${sel ? 'true' : 'false'} aria-label=${label}
      onClick=${() => onSelect(row.id)}>
      <span class="pos-l1">
        ${row.hasKids ? html`<${Chev} row=${row} name=${node.name} />` : html`<span class="pos-chev-sp" aria-hidden="true"></span>`}
        <span class=${cx('dot', dotClass(st), st === 'working' && 'live')} aria-hidden="true"></span>
        ${row.crumb && html`<span class="pos-crumb" title=${`Reports to ${row.crumb}`}>… › ${row.crumb} ›</span>`}
        <span class="pos-name truncate" title=${node.name}>${node.name}</span>
        ${st === 'paused' && html`<span class="chip pos-chip pos-paused">Paused</span>`}
        ${act.ago && html`<span class="pos-ago tnum" title=${act.title}>${act.ago}</span>`}
      </span>
      <span class="pos-remit truncate" title=${node.remit}>${node.remit || 'No remit yet'}</span>
      <span class="pos-meta">
        <span class=${cx('pos-act', `st-${st}`)} title=${act.title || statusText(st)}>${statusText(st)}${act.text ? html`<span class="pos-act-sep"> · </span>${act.text}` : ''}</span>
        ${node.problem && html`<span class="chip danger pos-chip" title=${`position.json did not validate, so the last good version is in force: ${node.problem}`}><${Icon} name="alert" size=${12} />Definition error</span>`}
        ${chips.map((c) => html`<span class="chip warn pos-chip" key=${c.kind}><${Icon} name=${c.kind === 'request' ? 'shield' : 'file-plus'} size=${12} />${c.label}</span>`)}
        ${open > 0 && html`<span class="chip pos-chip" title=${`${open} unchecked in the notebook's Open items`}><${Icon} name="list-todo" size=${12} />${open} open</span>`}
        ${duty && html`<span class=${cx('chip pos-chip pos-duty', duty.soon && 'soon')} title=${duty.full}><${Icon} name="clock" size=${12} /><span class="truncate">${duty.label}</span></span>`}
      </span>
    </div>
  </div>`;
}

// A department's header (spec 2.4): its name, its head and how many positions it holds (the head included). It is
// not a tree item: arrows skip it, and the group around the department carries the same words for a screen reader.
const deptLabel = (g) => (g.none ? `No department, ${g.count} position${g.count === 1 ? '' : 's'}`
  : `${g.name} department, headed by ${g.headName}, ${g.count} position${g.count === 1 ? '' : 's'}`);
function DeptHead({ g, indent }) {
  const name = g.none ? 'No department' : g.name;
  return html`<div class=${cx('pos-row pos-dept', g.none && 'none')} style=${{ '--indent': `${indent}px` }} aria-hidden="true">
    <span class="pos-dept-l1">
      <${Icon} name=${g.none ? 'circle' : 'users'} size=${12} />
      <span class="pos-dept-name truncate" title=${name}>${name}</span>
      ${!g.none && g.headName && html`<span class="pos-dept-head truncate" title=${`Headed by ${g.headName}`}>headed by ${g.headName}</span>`}
      <span class="pos-dept-n tnum" title=${`${g.count} position${g.count === 1 ? '' : 's'}${g.none ? '' : ', the head included'}`}>${g.count}<span class="pos-dept-n-word"> position${g.count === 1 ? '' : 's'}</span></span>
    </span>
  </div>`;
}

export function Tree({ cid, data, phone, onSelect = select, onTalk }) {
  const tree = data?.tree || [];
  const rows = visibleRows(tree, opens.value[cid], { phone });
  const byId = new Map(tree.map((r) => [r.id, r]));
  const sel = selected.value[cid] || null;
  const root = useRef(null);
  const stop = focusOf.get(cid);
  const tabId = rows.some((r) => r.id === stop) ? stop : rows.some((r) => r.id === sel) ? sel : CEO;
  const focusRow = (id) => {
    focusOf.set(cid, id);
    const el = root.current?.querySelector(`[role="treeitem"][data-id="${CSS.escape(id)}"]`);
    if (el) { el.focus(); el.scrollIntoView({ block: 'nearest' }); }
  };
  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const item = e.target.closest?.('[role="treeitem"]');
    if (!item) return;
    const r = treeKey(rows, item.dataset.id, e.key);
    if (!r.focus && !r.toggle && !r.select) return;
    e.preventDefault();
    if (r.toggle) { if (r.toggle.open) justOpened.add(r.toggle.id); setOpen(r.toggle.id, r.toggle.open); }
    if (r.focus) focusRow(r.focus);
    if (r.select) { focusOf.set(cid, r.select); onSelect(r.select); }
  };
  // a row clicked or selected elsewhere takes the tab stop
  useEffect(() => { if (sel) focusOf.set(cid, sel); }, [cid, sel]);
  const parentsOpened = new Set([...justOpened]);
  const one = (r) => (r.ceo
    ? html`<${CeoRow} key=${CEO} row=${r} company=${data?.company} sel=${sel === CEO} tab=${tabId === CEO} onSelect=${onSelect} positions=${tree.length} />`
    : html`<${Row} key=${r.id} row=${r} node=${byId.get(r.id)} sel=${sel === r.id} tab=${tabId === r.id} onSelect=${onSelect} enter=${parentsOpened.has(r.parentId)} />`);
  // with departments, each one (its header, its head and everyone under it) is a labelled group; none: rows as before
  const parts = [];
  let seg = null;
  for (const r of rows) {
    if (r.group) { seg = { g: r.group, indent: r.indent, rows: [] }; parts.push(seg); }
    if (seg) seg.rows.push(r); else parts.push(r);
  }
  return html`<div ref=${root} class=${cx('pos-tree', phone && 'is-phone')} role="tree" aria-label=${`${data?.company?.name || 'Company'} org tree`}
      style=${{ '--step': `${phone ? INDENT.phone : INDENT.desktop}px` }} onKeyDown=${onKey}
      onFocusIn=${(e) => { const it = e.target.closest?.('[role="treeitem"]'); if (it) focusOf.set(cid, it.dataset.id); }}>
    ${parts.map((x) => (x.g
      ? html`<div key=${x.g.key} role="group" class="pos-dept-group" aria-label=${deptLabel(x.g)} data-dept=${x.g.none ? '' : x.g.name}>
          <${DeptHead} g=${x.g} indent=${x.indent} />${x.rows.map(one)}</div>`
      : one(x)))}
    ${!tree.length && html`<div class="pos-tree-empty" role="none">
      <p><strong>No positions yet.</strong> Open a CEO chat and say what you want covered, for example legal or money. The CEO proposes a position, and you approve it here or in that chat.</p>
      ${onTalk && html`<button type="button" class="btn btn-sm" onClick=${onTalk}><${Icon} name="chat" size=${14} />Talk to the CEO</button>`}
    </div>`}
  </div>`;
}
