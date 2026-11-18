// Positions preview (lane T6): a static server for ui/ plus a harness page that mounts the Team view (ui/positions/team.js)
// in the real chrome, on the fictional mock company (ui/lib/mock-positions.js), one scene per URL. tools/positions-shots.js
// runs it in-process and shoots every scene at 1280 / 393 / 320 px; you can also open it by hand.
//   GET /positions-preview?<params>   the harness page (index.html's importmap + every stylesheet + /positions/positions.css)
//   everything else                   ui/ as files (like tools/serve-ui.js, without the live-reload watcher); /bg/<file>
//                                     serves ui/assets/backgrounds/<file>
// Params (all optional):
//   mode=<mock mode>    createMockTeam's mode: one, empty, off, root, nopositions, error, loading, conflict, deep,
//                       imported (no company yet: a proposed company card + the position cards waiting for it)
//   company=<id>        example-co (default) or harbor-books
//   sel=<id>|@ceo       the selected position (or the CEO row)
//   tab=<tab>           detail tab: overview, brief, notebook, powers, duties, chats, crosstalk
//   screen=detail       narrow layouts: open the detail screen (default: the tree)
//   sections=a,b        company sections to open: proposals, inbox, crosstalk
//   collapse=a,b        tree rows to start collapsed (helm.team.open.<company>)
//   expand=t1,t2        cross-talk tickets to open (clicks their .pos-ct-head after render)
//   edit=1              clicks Edit in Brief / Notebook so the editor shows
//   details=1           opens every <details> in the view (handoffs, proposal drafts)
//   details=p1,p2       opens only the <details> inside those proposal cards ([data-proposal="<id>"])
//   scroll=<css>        scrolls that element into view (block: center) once the scene settled
//   theme=light         the light look (ui/lib/mock-data.js reads it into the mock settings)
//   freeze=1            no transitions / animations (screenshots measure the end state)
//   panel=team          the right sidebar's Team panel (ui/panels/team.js) instead of the Team view: the whole app
//                       (ui/shell/index.js Shell) on a session with the inspector open on Team; the phone shows it in
//                       the panels sheet. session=<id> picks the session (default s_pos_legal, General Counsel's chat,
//                       so its row is the highlighted one). Desktop also checks the inspector's tab strip fits.
// The page sets window.__posReady = true once the data loaded and the asked-for clicks are done, or
// 'error: <why>' when the scene could not be built (that is also logged with console.error).
// Usage: node tools/positions-preview.js [port]   (default 4890; 0 = random), then open the printed URL.
const http = require('http');
const fs = require('fs');
const path = require('path');

const UI = process.env.HELM_UI_DIR ? path.resolve(process.env.HELM_UI_DIR) : path.join(__dirname, '..', 'ui');
const BG = path.join(UI, 'assets', 'backgrounds');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};
const FREEZE = '*, *::before, *::after { transition-duration: 0s !important; transition-delay: 0s !important; animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; caret-color: transparent !important; }';

// Runs in the page (serialized with toString; dynamic imports only, so a broken module is caught and reported).
async function pageMain() {
  const q = new URLSearchParams(location.search);
  const list = (k) => (q.get(k) || '').split(',').map((s) => s.trim()).filter(Boolean);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const waitFor = async (fn, ms, what) => {
    const end = Date.now() + ms;
    for (;;) {
      let v = false;
      try { v = fn(); } catch { v = false; }
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
      await sleep(40);
    }
  };
  window.__posReady = undefined;
  try {
    const [{ render }, { html }, store, shell, chrome, util, mockMod, T, team] = await Promise.all([
      import('preact'), import('/lib/html.js'), import('/lib/store.js'), import('/shell/state.js'), import('/shell/chrome.js'),
      import('/shell/util.js'), import('/lib/mock-positions.js'), import('/positions/state.js'), import('/positions/team.js'),
    ]);
    const { Background, Rail, Strip, PhoneNav, PhoneConn, Toasts } = chrome;
    const { UpdateChip } = await import('/shell/update.js');
    const mode = q.get('mode') || null;
    const cid = q.get('company') || 'example-co';
    const panel = q.get('panel') === 'team';
    const [shellIndex, panels] = panel ? await Promise.all([import('/shell/index.js'), import('/panels/index.js')]) : [];

    // the mock team backend, with a local emitter so its team.* events reach positions/state.js
    const subs = new Map();
    const on = (ev, fn) => { let s = subs.get(ev); if (!s) subs.set(ev, (s = new Set())); s.add(fn); return () => s.delete(fn); };
    const emit = (ev, data) => { for (const fn of [...(subs.get(ev) || [])]) { try { fn(data); } catch (e) { console.error(e); } } };
    const mock = mockMod.createMockTeam({ mode, emit });
    T.setTeamClient({ rpc: mock.rpc, on });
    window.__posMock = mock;

    // seed the scene before the first render (localStorage was seeded by the inline script in <head>)
    T.companyId.value = cid;
    const sel = q.get('sel');
    if (sel) T.selected.value = { [cid]: sel };
    if (q.get('tab')) T.detailTab.value = q.get('tab');
    T.screen.value = q.get('screen') === 'detail' ? 'detail' : 'tree';
    T.sections.value = Object.fromEntries(list('sections').map((k) => [k, true]));
    const collapsed = Object.fromEntries(list('collapse').map((k) => [k, false]));
    if (Object.keys(collapsed).length) T.opens.value = { [cid]: collapsed };
    shell.view.value = panel ? 'session' : 'team';

    // the real chrome around the view, as ui/shell/index.js Desktop() / Phone() lay it out for a non-session view
    const { cx } = util;
    function App() {
      const v = shell.view.value;
      if (shell.isPhone.value) {
        return html`<div class=${cx('app phone', `view-${v}`)}>
          <${Background} />
          <${PhoneConn} />
          <${UpdateChip} />
          <main class="pscreen"><${team.TeamView} /></main>
          <${PhoneNav} />
        </div>
        <${Toasts} />`;
      }
      const a = store.appInfo.value;
      return html`<div class=${cx('app desktop', `view-${v}`, shell.sidebarOpen.value ? 'with-sidebar' : 'no-sidebar', a.platform === 'electron' && 'is-electron', a.engine === 'fallback' && 'has-banner')}>
        <${Background} />
        <${Rail} />
        <${Strip} />
        <div class="deck"><main class="main panel"><${team.TeamView} /></main></div>
      </div>
      <${Toasts} />`;
    }
    render(panel ? html`<${shellIndex.Shell} />` : html`<${App} />`, document.getElementById('app'));

    await waitFor(() => store.ready.value && store.settings.value, 8000, 'app.hello (mock transport)');
    if (panel) {
      // the session first (the inspector shows beside a session; the phone's panels sheet over one), then the Team tab
      const sid = q.get('session') || 's_pos_legal';
      await waitFor(() => store.sessions.value.some((s) => s.id === sid), 8000, `mock session ${sid}`);
      shell.openSession(sid);
      panels.inspectorOpen.value = true;
      panels.inspectorPanel.value = 'team';
      if (shell.isPhone.value) shell.sheetOpen.value = true;
    }
    if (panel && mode === 'loading') {
      await waitFor(() => document.querySelector('.pn-team .pn-loading'), 4000, 'the loading state (.pn-team .pn-loading)');
      await sleep(300);
    } else if (panel) {
      await waitFor(() => {
        const L = T.teamList.value;
        if (!L && !T.listError.value) return false;
        const el = document.querySelector('.insp .pn-team');
        if (!el || el.querySelector('.pn-loading')) return false;
        if (L && L.enabled && !L.rootProblem && (L.companies || []).length) {
          const c = T.companies.value[T.companyId.value];
          if (!c || (!c.data && !c.error)) return false;
          if (c.data && !el.querySelector('[role="tree"]')) return false;
        }
        return true;
      }, 8000, 'the Team panel (.insp .pn-team, no loading state)');
      if (!shell.isPhone.value) {
        // the default 360 px column holds every tab, whichever is open (the longest labels: Changes, Railway, Preview)
        const strip = document.querySelector('.insp-tabs');
        const over = [];
        for (const id of ['changes', 'railway', 'team']) {
          panels.inspectorPanel.value = id;
          await frames();
          const d = strip.scrollWidth - strip.clientWidth;
          if (d > 0) over.push(`${id} open: ${d} px`);
        }
        panels.inspectorPanel.value = 'team';
        await waitFor(() => document.querySelector('.insp .pn-team [role="tree"]') || !T.companies.value[T.companyId.value]?.data, 4000, 'the Team panel again');
        if (over.length && document.querySelector('.insp-col')?.getBoundingClientRect().width >= 352) console.error(`positions-preview: the inspector tab strip overflows its ${Math.round(strip.clientWidth)} px (${over.join(', ')})`);
      }
    } else if (mode === 'loading') {
      await waitFor(() => document.querySelector('.pos-view .spinner'), 4000, 'the loading spinner');
      await sleep(300);
    } else {
      const secs = T.sections.value;
      await waitFor(() => {
        const L = T.teamList.value;
        if (!L && !T.listError.value) return false;
        const view = document.querySelector('.pos-view');
        if (!view || view.querySelector('.spinner')) return false;
        // a proposed company (team.list proposals) loads its cards with team.proposals: wait for those too
        if (L && (L.proposals || []).length && !(T.proposed?.value?.list || []).length && !T.proposed?.value?.error) return false;
        if (L && L.enabled && !L.rootProblem && (L.companies || []).length) {
          const c = T.companies.value[T.companyId.value];
          if (!c || (!c.data && !c.error)) return false;
          if (secs.inbox && !T.inbox.value[cid]?.entries && !T.inbox.value[cid]?.error) return false;
          if (secs.crosstalk && !T.crosstalk.value[T.pkey(cid, null)]?.entries && !T.crosstalk.value[T.pkey(cid, null)]?.error) return false;
        }
        return true;
      }, 8000, 'the team data (no spinner left in .pos-view)');
    }
    await frames();

    if (q.get('edit')) {
      const btn = await waitFor(() => [...document.querySelectorAll('.pos-file-actions button')].find((b) => /\bEdit\b/.test(b.textContent)), 3000, 'the Edit button (.pos-file-actions)');
      btn.click();
      await waitFor(() => document.querySelector('.pos-textarea'), 3000, 'the editor (.pos-textarea)');
    }
    for (const t of list('expand')) {
      const head = await waitFor(() => document.querySelector(`.pos-ct[data-ticket="${CSS.escape(t)}"] > .pos-ct-head`), 3000, `cross-talk ticket ${t} (.pos-ct-head)`);
      if (head.getAttribute('aria-expanded') !== 'true') head.click();
      await waitFor(() => document.querySelector(`.pos-ct[data-ticket="${CSS.escape(t)}"] > .pos-ct-body`), 3000, `cross-talk ticket ${t} body`);
    }
    if (q.get('details') === '1') {
      const all = [...document.querySelectorAll('.pos-view details')];
      if (!all.length) throw new Error('details=1: no <details> in the view');
      for (const d of all) d.open = true;
    } else if (q.get('details')) {
      for (const id of list('details')) {
        const card = await waitFor(() => document.querySelector(`.pos-view [data-proposal="${CSS.escape(id)}"]`), 3000, `proposal card ${id} ([data-proposal])`);
        const all = [...card.querySelectorAll('details')];
        if (!all.length) throw new Error(`details=${id}: the card has no <details>`);
        for (const d of all) d.open = true;
      }
    }
    if (q.get('scroll')) {
      const el = await waitFor(() => document.querySelector(q.get('scroll')), 3000, `scroll target ${q.get('scroll')}`);
      el.scrollIntoView({ block: 'center' });
    }
    if (document.fonts?.ready) await document.fonts.ready;
    await frames();
    await sleep(120);
    window.__posReady = true;
  } catch (e) {
    console.error('positions-preview: scene failed:', e && e.stack ? e.stack : e);
    window.__posReady = `error: ${(e && e.message) || e}`;
  }
}

// Before any module runs: a clean, scene-only localStorage (the Team view reads helm.team.* at import time).
function seedScript() {
  const q = new URLSearchParams(location.search);
  const list = (k) => (q.get(k) || '').split(',').map((s) => s.trim()).filter(Boolean);
  const company = q.get('company') || 'example-co';
  try {
    localStorage.clear();
    localStorage.setItem('helm.team.company', JSON.stringify(company));
    localStorage.setItem('helm.team.sections', JSON.stringify(Object.fromEntries(list('sections').map((k) => [k, true]))));
    const collapsed = Object.fromEntries(list('collapse').map((k) => [k, false]));
    if (Object.keys(collapsed).length) localStorage.setItem(`helm.team.open.${company}`, JSON.stringify(collapsed));
  } catch { /* storage off: the module seeds the signals anyway */ }
}

function previewPage(freeze) {
  const index = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  const importmap = (/<script type="importmap">[\s\S]*?<\/script>/.exec(index) || [''])[0];
  if (!importmap) throw new Error('ui/index.html has no importmap');
  const heads = index.match(/<meta (?:charset|name="viewport"|name="color-scheme")[^>]*>|<link rel="icon"[^>]*>/g) || [];
  const sheets = index.match(/<link rel="stylesheet"[^>]*>/g) || [];
  const theme = (/<html[^>]*data-theme="([^"]+)"/.exec(index) || [, 'dark'])[1];
  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
  ${heads.join('\n  ')}
  <title>Helm · Team preview</title>
  <script>(${seedScript.toString()})();</script>
  ${importmap}
  ${sheets.join('\n  ')}
  <link rel="stylesheet" href="/positions/positions.css">
  ${freeze ? `<style id="pos-freeze">${FREEZE}</style>` : ''}
</head>
<body>
  <div id="app"></div>
  <script type="module">(${pageMain.toString()})();</script>
  <script type="module" src="/shell/phone.js"></script>
</body>
</html>`;
}

function handler(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400).end(); return; }
  if (url.pathname === '/positions-preview' || url.pathname === '/positions-preview/') {
    // the app transport (ui/lib/transport.js) only goes mock with ?mock in the page URL: never talk to a real host
    if (!url.searchParams.has('mock')) { url.searchParams.set('mock', '1'); res.writeHead(302, { location: url.pathname + url.search }).end(); return; }
    try {
      const body = previewPage(url.searchParams.get('freeze') === '1');
      res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' });
      res.end(body);
    } catch (e) { res.writeHead(500, { 'content-type': 'text/plain' }).end(String(e.message || e)); }
    return;
  }
  if (url.pathname === '/favicon.ico' || url.pathname === '/__live') { res.writeHead(204).end(); return; }
  const isBg = url.pathname.startsWith('/bg/');
  const base = isBg ? BG : UI;
  const rel = isBg ? url.pathname.slice(3) : url.pathname;
  let file;
  try { file = path.normalize(path.join(base, decodeURIComponent(rel))); } catch { res.writeHead(400).end(); return; }
  if (file !== base && !file.startsWith(base + path.sep)) { res.writeHead(403).end(); return; }
  try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch { /* not there: 404 below */ }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // the parent lane writes positions.css; until it exists the page links it anyway, so answer empty CSS, not a 404
      if (url.pathname === '/positions/positions.css') { res.writeHead(200, { 'content-type': TYPES['.css'], 'cache-control': 'no-store' }).end('/* positions.css not written yet */'); return; }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}

// start(port) -> Promise<{ server, port, base, url, close }>; base = http://127.0.0.1:<port>
function start(port = 4890) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      const base = `http://127.0.0.1:${p}`;
      resolve({ server, port: p, base, url: `${base}/positions-preview?mock=1`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

module.exports = { start, previewPage, FREEZE };

if (require.main === module) {
  start(Number(process.argv[2] ?? 4890)).then((s) => console.log(`positions preview on ${s.url}  (add &sel=legal&tab=notebook ...)`),
    (e) => { console.error(e.message || e); process.exit(1); });
}
