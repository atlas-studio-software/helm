// Positions screenshots + slim overlap audit (lane T6). Starts tools/positions-preview.js in-process, opens every Team
// view scene in headless Chromium at 1280x860 (desktop), 393x852 and 320x700 (phone, touch), and for each one:
//   - saves .shots/positions/<scene>-<width>.png (the viewport), plus <scene>-<width>-full.png when a pane scrolls
//     (the window made tall enough to show the whole scroller)
//   - audits the Team view (.pos-view) with tools/overlap-measure.js + tools/overlap-core.js the way
//     tools/overlap-audit.js does (:hover / :focus-visible forced through CDP, motion frozen): overlap, ring,
//     clipped-ring, text-clip, text-spill, outside, page-overflow, small-target, hover-shift, no-focus-style
//   - collects page errors (pageerror + console.error) and harness failures (a scene that never settled)
// Prints one line per finding and page error, then exactly `positions-shots: N shots, F findings, E page errors`;
// writes .shots/positions/report.json; exit 1 on any finding or page error.
// Usage: node tools/positions-shots.js [--only=tree-legal,notebook] [--widths=1280,393] [--out=<dir>] [--pages=3]
//          [--kinds=all] [--no-audit] [--list]
//   --kinds=all keeps every overlap-core kind (hit-overlap, text-collide, no-hover-style too).
//   --no-full skips the -full shots.
//   --emit-log (or POS_EMIT_LOG=1) prints every output file into stdout as base64 after the summary line, between
//     `@@posfile <name> <bytes> <sha256>@@` and `@@posend <name>@@` (report.json, then the viewport shots, then the -full
//     ones): the exact bytes, for when the CI can't upload artifacts (Actions storage quota). Turn the log back into
//     files with pos-shots-fetch.js (kept next to the scratch repo, outside Helm), which checks every sha256.
// Chromium: playwright-core; channel 'chrome' when CI is set (GitHub's runners have Chrome), else the bundled one.
// Heavy: run it through cloudtest, not on a laptop that is short on memory.
try { require('./lowcpu-optional'); } catch { /* not on this machine: cloud runner */ }
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const core = require('./overlap-core');
const { install } = require('./overlap-measure');
const { start, FREEZE } = require('./positions-preview');

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const flag = (k) => process.argv.includes('--' + k);
const WIDTHS = arg('widths', '1280,393,320').split(',').map(Number).filter(Boolean);
const ONLY = arg('only') ? arg('only').split(',').map((s) => s.trim()).filter(Boolean) : null;
const OUT = path.resolve(arg('out', path.join(__dirname, '..', '.shots', 'positions')));
const PAGES = Math.max(1, Number(arg('pages', '3')) || 3);
const AUDIT = !flag('no-audit');
const FULL = !flag('no-full');
const EMIT = flag('emit-log') || process.env.POS_EMIT_LOG === '1';
const HEIGHT = { 1280: 860, 393: 852, 320: 700 };
const KINDS = arg('kinds') === 'all' ? null
  : new Set(['overlap', 'ring', 'clipped-ring', 'text-clip', 'text-spill', 'outside', 'page-overflow', 'small-target', 'hover-shift', 'no-focus-style']);
const ROOT = '.pos-view';
const CLOSED_DETAILS = 'details:not([open]) > :not(summary) { display: none !important; }';

// ---- scenes. `q` = preview URL params; `detail: true` adds screen=detail at phone widths (the detail screen).
// Ids are the fictional Example Co in ui/lib/mock-positions.js.
const SCENES = [
  { name: 'tree-legal', q: { sel: 'legal' } },   // 1280: tree + General Counsel overview (access request card); phone: the tree list
  { name: 'tree-deep', q: { mode: 'deep', sel: 'eu-contractors', scroll: '[role="treeitem"][data-id="eu-contractors"]' } },   // phone: depth 4-5 crumb rows
  { name: 'legal-overview', q: { sel: 'legal', tab: 'overview' }, detail: true },
  { name: 'notebook', q: { sel: 'legal', tab: 'notebook' }, detail: true },   // checked + unchecked open items
  { name: 'brief-edit', q: { sel: 'legal', tab: 'brief', edit: '1' }, detail: true },
  { name: 'powers', q: { sel: 'tax', tab: 'powers' }, detail: true },   // "limited by General Counsel"
  { name: 'duties', q: { sel: 'finance', tab: 'duties' }, detail: true },   // daily due within the day, monthly failed last run
  { name: 'chats', q: { sel: 'legal', tab: 'chats', details: '1' }, detail: true },   // ended chat, handoff open
  { name: 'crosstalk', q: { sel: 'legal', tab: 'crosstalk', expand: 't_a1,t_a2' }, detail: true },   // nested chain, both open
  { name: 'sections', q: { sections: 'proposals,inbox,crosstalk', scroll: '.pos-csecs' } },
  { name: 'proposal-draft', q: { sections: 'proposals', details: '1', scroll: '.pos-csecs' } },   // the open proposal's draft details
  { name: 'ceo', q: { sel: '@ceo' }, detail: true },
  { name: 'paused', q: { sel: 'social', tab: 'overview' }, detail: true },   // a paused position (Resume, disabled duty)
  { name: 'harbor', q: { company: 'harbor-books', sel: 'support' } },   // second company: one position, nothing pending, no departments
  { name: 'departments', q: { sel: 'tax', tab: 'overview' } },   // Legal / Marketing / Finance headers + "No department" (QA Engineer); 1280: Tax Specialist's Overview says Legal (head: General Counsel)
  { name: 'dept-proposal', q: { sections: 'proposals', details: 'p_6e3b', scroll: '[data-proposal="p_6e3b"]' } },   // the open "New department: Business Development" card, its draft open
  { name: 'one', q: { mode: 'one', sel: 'legal' } },   // one company: no switcher, its name in the counts
  { name: 'off', q: { mode: 'off' } },
  { name: 'empty', q: { mode: 'empty' } },
  { name: 'root', q: { mode: 'root' } },   // team root refused
  { name: 'nopositions', q: { mode: 'nopositions' } },
  { name: 'imported', q: { mode: 'imported', details: '1' } },   // no company yet: an import's company card + its four position cards
  { name: 'loading', q: { mode: 'loading' } },
  { name: 'error', q: { mode: 'error' } },
  { name: 'light', q: { sel: 'legal', theme: 'light' } },
  { name: 'light-crosstalk', q: { sel: 'legal', tab: 'crosstalk', expand: 't_a1', theme: 'light' }, detail: true },
  // the right sidebar's Team panel (ui/panels/team.js) in the whole app, beside General Counsel's chat (its row is the
  // highlighted one); the phone: the panels sheet over that chat. `root` = what the audit measures.
  { name: 'sidebar-panel', q: { panel: 'team' }, root: '.insp' },
  { name: 'sidebar-panel-harbor', q: { panel: 'team', company: 'harbor-books', session: 's_storefront' }, root: '.insp' },   // no departments, nothing pending
  { name: 'sidebar-panel-off', q: { panel: 'team', mode: 'off', session: 's_storefront' }, root: '.insp' },   // Positions off: how to switch it on
];

const findings = [];
const pageErrors = [];
const shots = [];
let setupFails = 0;
const log = (s) => console.log(s);

function sceneUrl(base, sc, width) {
  const q = new URLSearchParams({ mock: '1', freeze: '1', ...sc.q });
  if (sc.detail && width < 1060) q.set('screen', 'detail');   // narrow layouts (phone, and a desktop window under ~1060 px: view < 1000) show the detail as its own screen
  return `${base}/positions-preview?${q}`;
}

function ink(p) {
  const reach = core.ringReach(p);
  const ringPx = Math.max(reach.l, reach.t, reach.r, reach.b);
  let box = p.painted || ringPx > 0.5 ? core.grow(p.rect, reach) : null;
  for (const ps of p.pseudoPaint || []) {
    const g = core.grow(ps.box, core.ringReach({ boxShadow: ps.boxShadow }));
    box = box ? { x: Math.min(box.x, g.x), y: Math.min(box.y, g.y), w: Math.max(box.x + box.w, g.x + g.w) - Math.min(box.x, g.x), h: Math.max(box.y + box.h, g.y + g.h) - Math.min(box.y, g.y) } : g;
  }
  return { ink: box, ring: ringPx > 0.5 };
}

// One audit pass over what is on screen now (tools/overlap-audit.js auditOnce, without its shots / quality tally).
async function auditOnce(page, cdp, root, width, tag) {
  const m = await page.evaluate((r) => window.__ovl.mark(r), root);
  if (m.missing) throw new Error(`audit root ${root} not found`);
  const { root: doc } = await cdp.send('DOM.getDocument', { depth: 0 });
  const hov = (await cdp.send('DOM.querySelectorAll', { nodeId: doc.nodeId, selector: '[data-ovlh]' })).nodeIds;
  for (const n of hov) await cdp.send('CSS.forcePseudoState', { nodeId: n, forcedPseudoClasses: ['hover'] }).catch(() => {});
  const hovSet = new Set(hov);
  const ctlNodes = (await cdp.send('DOM.querySelectorAll', { nodeId: doc.nodeId, selector: '[data-ovl]' })).nodeIds;
  const idOf = new Map();
  for (const n of ctlNodes) {
    const { attributes } = await cdp.send('DOM.getAttributes', { nodeId: n }).catch(() => ({ attributes: [] }));
    const k = attributes.indexOf('data-ovl'); if (k >= 0) idOf.set(+attributes[k + 1], n);
  }
  await page.waitForTimeout(30);
  const snap = await page.evaluate((r) => window.__ovl.collect(r), root);
  const keep = [];
  for (const rec of snap.els) {
    if (rec.kind !== 'ctl') { keep.push(rec); continue; }
    const nodeId = idOf.get(rec.id);
    if (nodeId == null) continue;
    const force = (on) => cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: on }).catch(() => {});
    const asHov = hovSet.has(nodeId);
    const wrap = rec.texty ? (await cdp.send('DOM.querySelectorAll', { nodeId: doc.nodeId, selector: `[data-ovlfa~="${rec.id}"]` }).catch(() => ({ nodeIds: [] }))).nodeIds : [];
    for (const w of wrap) await cdp.send('CSS.forcePseudoState', { nodeId: w, forcedPseudoClasses: hovSet.has(w) ? ['hover', 'focus-within'] : ['focus-within'] }).catch(() => {});
    await force(asHov ? ['hover', 'focus', 'focus-visible', 'focus-within'] : ['focus', 'focus-visible', 'focus-within']);
    const pf = await page.evaluate((id) => window.__ovl.probe(id), rec.id);
    for (const w of wrap) await cdp.send('CSS.forcePseudoState', { nodeId: w, forcedPseudoClasses: hovSet.has(w) ? ['hover'] : [] }).catch(() => {});
    await force(['hover']);
    const ph = await page.evaluate((id) => window.__ovl.probe(id), rec.id);
    await force(asHov ? ['hover'] : []);
    if (!pf || !ph) continue;
    const p = pf;
    if (!rec.disabled && !rec.ghost && rec.vis) {
      if (pf.sig === rec.rest && !asHov && !rec.focused) rec.noFocus = true;
      if (ph.sig === rec.rest && !asHov && rec.buttonish && !rec.selected && width > 820) rec.noHover = true;
    }
    if (!rec.vis || p.opacity < 0.05) continue;
    const k = ink(pf), kh = ink(ph);
    const u = (a, b) => (!a ? b : !b ? a : { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x), h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) });
    rec.ink = u(k.ink, kh.ink); rec.ring = k.ring || kh.ring;
    for (const qq of [ph]) if (Math.abs(qq.rect.x - rec.rect.x) + Math.abs(qq.rect.w - rec.rect.w) + Math.abs(qq.rect.y - rec.rect.y) + Math.abs(qq.rect.h - rec.rect.h) > 0.75) p.rect = qq.rect;
    const dx = Math.abs(p.rect.x - rec.rect.x) + Math.abs(p.rect.w - rec.rect.w), dy = Math.abs(p.rect.y - rec.rect.y) + Math.abs(p.rect.h - rec.rect.h);
    const moved = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.w - b.w) + Math.abs(a.y - b.y) + Math.abs(a.h - b.h) > 0.75;
    const again = dx > 0.75 || dy > 0.75 ? await page.evaluate((id) => window.__ovl.probe(id), rec.id) : null;
    if (again && moved(again.rect, p.rect)) rec.shift = `${Math.round(rec.rect.w)}x${Math.round(rec.rect.h)} -> ${Math.round(p.rect.w)}x${Math.round(p.rect.h)} at ${Math.round(p.rect.x - rec.rect.x)},${Math.round(p.rect.y - rec.rect.y)}`;
    keep.push(rec);
  }
  snap.els = keep;
  const found = core.analyze(snap, { scenario: tag, width });
  for (const r of keep) {
    if (r.noFocus) found.push({ kind: 'no-focus-style', scenario: tag, width, a: r.sel, b: '', rect: r.rect, detail: 'keyboard focus changes nothing visible' });
    if (r.noHover) found.push({ kind: 'no-hover-style', scenario: tag, width, a: r.sel, b: '', rect: r.rect, detail: 'hover changes nothing visible' });
    if (r.shift) found.push({ kind: 'hover-shift', scenario: tag, width, a: r.sel, b: '', rect: r.rect, detail: `moves on hover/focus: ${r.shift}` });
  }
  for (const n of hov) await cdp.send('CSS.forcePseudoState', { nodeId: n, forcedPseudoClasses: [] }).catch(() => {});
  return found;
}

// the pane that scrolls the most (for the -full shot): how much taller the window must be to show all of it
async function scrollExtra(page) {
  return page.evaluate(() => {
    let best = 0;
    for (const el of document.querySelectorAll('.app *')) {
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY)) continue;
      const extra = el.scrollHeight - el.clientHeight;
      if (extra > best && el.clientHeight > 80) best = extra;
    }
    return Math.round(best);
  });
}

async function runScene(ctx, base, sc, width) {
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${(e.stack || String(e)).split('\n').slice(0, 6).join(' | ')}`));
  page.on('console', (m) => { if (m.type() === 'error') { const loc = m.location(); errs.push(`console.error: ${m.text().slice(0, 600)}${loc?.url ? ` (${loc.url.replace(base, '')}:${loc.lineNumber})` : ''}`); } });
  const tag = sc.name;
  const found = [];
  try {
    await page.goto(sceneUrl(base, sc, width), { waitUntil: 'load', timeout: 20000 });
    await page.waitForFunction(() => window.__posReady !== undefined, null, { timeout: 15000 }).catch(() => {});
    const ready = await page.evaluate(() => window.__posReady);
    if (ready !== true) throw new Error(`scene did not settle: ${ready === undefined ? 'window.__posReady never set (a module failed to load?)' : ready}`);
    // the preview's scroll= uses scrollIntoView, which also scrolls the target's overflow:hidden ancestors (boxes no one
    // can scroll by hand, e.g. the view frame), cutting the Team header off the top; put those back to what a user sees
    if (sc.q && sc.q.scroll) {
      await page.evaluate((sel) => {
        for (let el = document.querySelector(sel)?.parentElement; el && el !== document.body; el = el.parentElement) {
          if (!el.scrollTop && !el.scrollLeft) continue;
          const cs = getComputedStyle(el);
          if (!/(auto|scroll)/.test(cs.overflowY)) el.scrollTop = 0;
          if (!/(auto|scroll)/.test(cs.overflowX)) el.scrollLeft = 0;
        }
      }, sc.q.scroll);
      await page.waitForTimeout(60);
    }
    await page.addStyleTag({ content: FREEZE });   // the page has it too (freeze=1); belt and braces for late styles
    fs.mkdirSync(OUT, { recursive: true });
    const shot = path.join(OUT, `${sc.name}-${width}.png`);
    await page.screenshot({ path: shot });
    shots.push(path.relative(OUT, shot));

    if (AUDIT) {
      // measuring pass only: a CLOSED <details> keeps its content laid out (content-visibility: hidden), so its unseen
      // text would "overlap" whatever follows; hide it like the screen does (pos-t6-look, run 20261118-080927)
      await page.evaluate((css) => { const st = document.createElement('style'); st.id = 'pos-audit-closed-details'; st.textContent = css; document.head.append(st); }, CLOSED_DETAILS);
      await page.evaluate(`(${install})()`);
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
      const root = sc.root || ROOT;
      const sc0 = (await page.evaluate((r) => window.__ovl.scrollers(r), root))[0];
      const pages = sc0 ? Math.min(PAGES, Math.ceil(sc0.sh / Math.max(1, sc0.h * 0.85))) : 1;
      let top = sc0 ? await page.evaluate(([k]) => { const n = document.querySelector('[data-ovl-scroll="' + k + '"]'); return n ? n.scrollTop : 0; }, [sc0.key]) : 0;
      for (let i = 0; i < pages; i++) {
        if (i > 0) {
          const want = top + Math.round(sc0.h * 0.85);
          const got = await page.evaluate(([k, t]) => window.__ovl.scrollTo(k, t), [sc0.key, want]);
          if (got == null || got <= top) break;
          top = got;
          await page.waitForTimeout(120);
        }
        found.push(...await auditOnce(page, cdp, root, width, pages > 1 ? `${tag}@${i + 1}` : tag));
      }
      if (sc0) await page.evaluate(([k]) => window.__ovl.scrollTo(k, 0), [sc0.key]);
      await cdp.detach().catch(() => {});
      await page.evaluate(() => document.getElementById('pos-audit-closed-details')?.remove());
    }

    // -full: grow the window so the biggest scroller shows everything (same width, so the same layout)
    const extra = FULL ? await scrollExtra(page) : 0;
    if (extra > 40) {
      const h = HEIGHT[width] || 860;
      await page.setViewportSize({ width, height: Math.min(h + extra + 8, 6000) });
      await page.waitForTimeout(250);
      const more = await scrollExtra(page);   // a pane that grows with the window can uncover more: one more step
      if (more > 8) { await page.setViewportSize({ width, height: Math.min(h + extra + more + 8, 6000) }); await page.waitForTimeout(250); }
      const full = path.join(OUT, `${sc.name}-${width}-full.png`);
      await page.screenshot({ path: full });
      shots.push(path.relative(OUT, full));
      await page.setViewportSize({ width, height: h });
    }
  } catch (e) {
    setupFails++;
    errs.push(`harness: ${String(e.message || e).split('\n')[0]}`);
    // still save what the page shows, so a broken scene can be looked at
    try { fs.mkdirSync(OUT, { recursive: true }); const p = path.join(OUT, `${sc.name}-${width}.png`); await page.screenshot({ path: p }); shots.push(path.relative(OUT, p)); } catch { /* page gone */ }
  } finally {
    await page.close().catch(() => {});
  }
  for (const t of errs) pageErrors.push({ scene: tag, width, text: t });
  return found;
}

// the output files into stdout, base64 in 4000-char lines (see --emit-log above)
async function emitFiles() {   // awaits each write: process.exit() right after a big piped write cut run 2 off at ~64 KB
  const crypto = require('crypto');
  const names = fs.readdirSync(OUT).filter((n) => fs.statSync(path.join(OUT, n)).isFile());
  const rank = (n) => (n === 'report.json' ? 0 : /-full\.png$/.test(n) ? 2 : 1);
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  let total = 0;
  for (const n of names) {
    const buf = fs.readFileSync(path.join(OUT, n));
    total += buf.length;
    const b64 = buf.toString('base64');
    const lines = [`@@posfile ${n} ${buf.length} ${crypto.createHash('sha256').update(buf).digest('hex')}@@`];
    for (let i = 0; i < b64.length; i += 4000) lines.push(b64.slice(i, i + 4000));
    lines.push(`@@posend ${n}@@`);
    await new Promise((r) => process.stdout.write(lines.join('\n') + '\n', r));
  }
  await new Promise((r) => process.stdout.write(`@@posfiles ${names.length} files ${total} bytes@@\n`, r));
}

(async () => {
  if (flag('list')) {
    for (const s of SCENES) console.log(`${s.name}  ?${new URLSearchParams({ mock: '1', ...s.q })}${s.detail ? '  (+screen=detail on phone)' : ''}`);
    return;
  }
  const scenes = SCENES.filter((s) => !ONLY || ONLY.includes(s.name));
  if (ONLY) for (const o of ONLY) if (!SCENES.some((s) => s.name === o)) throw new Error(`--only: no scene "${o}" (try --list)`);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await start(0);
  const browser = await chromium.launch(process.env.CI ? { channel: 'chrome' } : {});
  const t0 = Date.now();
  try {
    for (const width of WIDTHS) {
      const phone = width <= 820;
      const ctx = await browser.newContext({ viewport: { width, height: HEIGHT[width] || 860 }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
      for (const sc of scenes) {
        const t1 = Date.now();
        findings.push(...await runScene(ctx, srv.base, sc, width));
        console.log(`  .. ${width} ${sc.name} ${Math.round((Date.now() - t1) / 100) / 10} s`);
      }
      await ctx.close();
    }
  } finally {
    await browser.close().catch(() => {});
    await srv.close();
  }
  const uniq = core.dedupe(findings).filter((f) => !KINDS || KINDS.has(f.kind));
  const byKind = {}, byScene = {};
  for (const f of uniq) {
    byKind[f.kind] = (byKind[f.kind] || 0) + 1;
    const s = `${f.scenario.replace(/@.*$/, '')}@${f.width}`;
    byScene[s] = (byScene[s] || 0) + 1;
    log(`  FIND ${f.scenario} ${f.width} ${f.kind} ${f.a}${f.b ? ' x ' + f.b : ''}${f.count > 1 ? ` (x${f.count})` : ''} :: ${f.detail}`);
  }
  for (const e of pageErrors) log(`  ERROR ${e.scene} ${e.width} :: ${e.text}`);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ at: new Date().toISOString(), widths: WIDTHS, scenes: scenes.map((s) => s.name),
    seconds: Math.round((Date.now() - t0) / 1000), shots, byKind, byScene, findings: uniq, pageErrors }, null, 1));
  console.log('by kind:', JSON.stringify(byKind));
  console.log('by scene:', JSON.stringify(byScene));
  console.log(`shots in ${OUT} (${Math.round((Date.now() - t0) / 1000)} s, ${setupFails} scene failures)`);
  console.log(`positions-shots: ${shots.length} shots, ${uniq.length} findings, ${pageErrors.length} page errors`);
  if (EMIT) await emitFiles();
  process.exit(uniq.length || pageErrors.length ? 1 : 0);
})().catch((e) => { console.error(e); console.log(`positions-shots: crashed: ${e.message}`); process.exit(1); });
