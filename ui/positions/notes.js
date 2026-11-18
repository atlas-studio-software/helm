// Team view: a position's brief.md / notebook.md, read and edited in place (Positions, lane T6). A copy of
// Settings > Claude Code's FileView (ui/shell/claude-config.js) on team.file.read / team.file.write: view as
// Markdown, Edit -> textarea, Save sends expectMtime and the host keeps a .bak; a file that changed underneath
// answers code "conflict" and the edit is kept (Copy my edit / Reload). Unsaved edits ask before they are dropped.
// The notebook's "- [ ]" lines are real checkboxes in view mode: ticking one writes the file (same mtime check).
import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { Markdown } from '../lib/markdown.js';
import { cx } from '../shell/util.js';
import { copyText } from '../shell/phone.js';
import { parseNotebook, toggleItem, agoShort } from '../lib/positions-model.js';
import { teamRpc, loadCompany } from './state.js';

const msg = (e) => (e && e.message) || String(e);

function NotebookView({ text, onTick, ticking }) {
  const { blocks } = parseNotebook(text);
  return html`<div class="pos-nb">${blocks.map((b) => (b.kind === 'md'
    ? (b.text.trim() ? html`<${Markdown} key=${`m${b.line}`} text=${b.text} class="pos-md" />` : null)
    : html`<label key=${`t${b.line}`} class=${cx('pos-task', b.checked && 'done')} style=${b.indent ? { marginLeft: `${Math.min(b.indent, 8) * 6}px` } : null}>
        <input type="checkbox" checked=${b.checked} disabled=${ticking} onChange=${(e) => onTick(b.line, e.currentTarget.checked)} />
        <span>${b.text}</span>
      </label>`))}</div>`;
}

export function Notes({ cid, id, file, name }) {
  const title = file === 'brief' ? 'brief.md' : 'notebook.md';
  const [doc, setDoc] = useState(null);             // { text, mtime }
  const [loadErr, setLoadErr] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(null);   // message
  const [saveErr, setSaveErr] = useState(null);
  const [discard, setDiscard] = useState(false);
  const [copied, setCopied] = useState(false);
  const [ticking, setTicking] = useState(false);
  const ta = useRef(null);
  const load = () => teamRpc('team.file.read', { company: cid, id, file }).then((d) => { setDoc(d); setLoadErr(null); return d; }, (e) => { setLoadErr(msg(e)); return null; });
  useEffect(() => { load(); }, [cid, id, file]);
  useEffect(() => { if (editing && ta.current) ta.current.focus(); }, [editing]);
  useEffect(() => { if (!discard) return undefined; const t = setTimeout(() => setDiscard(false), 3000); return () => clearTimeout(t); }, [discard]);
  useEffect(() => { if (!saved) return undefined; const t = setTimeout(() => setSaved(false), 4000); return () => clearTimeout(t); }, [saved]);

  const dirty = editing && doc && draft !== doc.text;
  const write = async (text) => {
    const r = await teamRpc('team.file.write', { company: cid, id, file, text, expectMtime: doc.mtime });
    setDoc({ text, mtime: r?.mtime ?? Date.now() });
    if (file === 'notebook') loadCompany(cid, { quiet: true });   // the tree's open-items count
    return r;
  };
  const failed = (e) => { if (e && e.code === 'conflict') setConflict(msg(e)); else setSaveErr(msg(e)); };
  const startEdit = () => { setDraft(doc.text); setEditing(true); setSaved(false); setConflict(null); setSaveErr(null); };
  const cancel = () => {
    if (dirty && !discard) { setDiscard(true); return; }
    setEditing(false); setDiscard(false); setConflict(null); setSaveErr(null);
  };
  const save = async () => {
    if (!dirty) { setEditing(false); return; }
    setSaving(true); setConflict(null); setSaveErr(null);
    try { await write(draft); setEditing(false); setDiscard(false); setSaved(true); }
    catch (e) { failed(e); }
    finally { setSaving(false); }
  };
  const tick = async (line, checked) => {
    const next = toggleItem(doc.text, line, checked);
    if (next == null) { setConflict('That line changed on disk. Reloaded: tick it again.'); load(); return; }
    setTicking(true); setConflict(null); setSaveErr(null);
    const before = doc;
    setDoc({ ...doc, text: next });   // the box flips at once; a failed write puts it back
    try { await write(next); }
    catch (e) { setDoc(before); failed(e); if (e?.code === 'conflict') load(); }
    finally { setTicking(false); }
  };
  const reload = async () => { const d = await load(); if (d) { if (editing) setDraft(d.text); setConflict(null); } };
  const copyDraft = async () => { if (await copyText(draft)) { setCopied(true); setTimeout(() => setCopied(false), 1600); } };
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
  };

  const open = doc && file === 'notebook' ? parseNotebook(doc.text).open : 0;
  const head = html`<div class="pos-file-head">
    <div class="pos-file-id">
      <span class="pos-file-title mono">${title}</span>
      <span class="hint truncate">${doc ? [doc.mtime && `edited ${agoShort(doc.mtime)}${agoShort(doc.mtime) === 'now' ? '' : ' ago'}`, file === 'notebook' && `${open} open item${open === 1 ? '' : 's'}`].filter(Boolean).join(' · ') : ''}</span>
    </div>
    <div class="pos-file-actions">
      ${saved && !editing && html`<span class="pos-saved" role="status"><${Icon} name="check" size=${14} />Saved · backup kept</span>`}
      ${editing
        ? html`<button type="button" class="btn btn-sm btn-ghost" onClick=${cancel}>${discard ? 'Discard changes?' : 'Cancel'}</button>
            <button type="button" class="btn btn-sm btn-primary" disabled=${saving || !dirty} onClick=${save}>${saving ? 'Saving…' : 'Save'}</button>`
        : doc && html`<button type="button" class="btn btn-sm" onClick=${startEdit}><${Icon} name="pencil" size=${13} />Edit</button>`}
    </div>
  </div>`;

  if (loadErr && !doc) return html`<div class="pos-file">${head}<div class="cc-health danger pos-notice" role="alert"><${Icon} name="x-circle" size=${14} /><span>Could not open ${title}: ${loadErr}</span><button type="button" class="btn btn-sm" onClick=${load}>Try again</button></div></div>`;
  if (!doc) return html`<div class="pos-file">${head}<div class="state-note pos-state"><span class="spinner"></span>Opening ${title}…</div></div>`;
  return html`<div class="pos-file">
    ${head}
    ${conflict && html`<div class="cc-health danger pos-notice pos-conflict" role="alert"><${Icon} name="alert" size=${14} />
      <span>${conflict}</span>
      <span class="pos-conflict-actions">
        ${editing && html`<button type="button" class="btn btn-sm" onClick=${copyDraft}><${Icon} name=${copied ? 'check' : 'copy'} size=${13} />${copied ? 'Copied' : 'Copy my edit'}</button>`}
        <button type="button" class="btn btn-sm" onClick=${reload}><${Icon} name="refresh" size=${13} />${editing ? 'Reload (drops my edit)' : 'Reload'}</button>
      </span>
    </div>`}
    ${saveErr && html`<div class="cc-health danger pos-notice" role="alert"><${Icon} name="x-circle" size=${14} /><span>Not saved: ${saveErr}</span></div>`}
    ${editing
      ? html`<div class="pos-editor">
          <textarea ref=${ta} class="pos-textarea mono" spellcheck="false" aria-label=${`Edit ${name}'s ${title}`} value=${draft}
            onInput=${(e) => { setDraft(e.currentTarget.value); setDiscard(false); }} onKeyDown=${onKey}></textarea>
          <p class="pos-foot">${dirty ? 'Unsaved changes.' : 'No changes yet.'} ${file === 'notebook' ? 'Keep the four headings; Helm reads Open items from them. ' : ''}Save keeps the old file as a .bak next to it.</p>
        </div>`
      : html`<div class="pos-doc">
          ${file === 'notebook' ? html`<${NotebookView} text=${doc.text} onTick=${tick} ticking=${ticking} />` : html`<${Markdown} text=${doc.text} class="pos-md" />`}
          ${!String(doc.text || '').trim() && html`<p class="pos-empty">${title} is empty.</p>`}
        </div>`}
  </div>`;
}
