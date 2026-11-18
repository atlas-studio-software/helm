#!/usr/bin/env node
// Load a "helm-team-proposals" JSON file into a RUNNING Helm as open proposal cards (docs/POSITIONS.md 6).
// Nothing is approved: every pending item becomes an open card that the owner approves or declines in Team view.
//
//   node tools/team-import-proposals.js <file.json> [--dry-run] [--port N] [--user-data <dir>]
//
//   --dry-run        parse only (no Helm needed): one line per item, then the summary
//   --port N         Helm's port (default 4871, main.js)
//   --user-data DIR  Helm's user data folder, for token.txt (default %APPDATA%/Helm)
// Without --dry-run it calls the RPC `team.proposals.import { json }` over ws://127.0.0.1:<port>/ws.
// Last line: `team-import: N valid, M skipped`.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseImport } = require('../main/engine/team/proposals');

function args(argv) {
  const out = { file: null, dryRun: false, port: 4871, userData: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const eq = a.indexOf('='); return eq > 0 ? a.slice(eq + 1) : argv[++i]; };
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--port' || a.startsWith('--port=')) out.port = Number(val());
    else if (a === '--user-data' || a.startsWith('--user-data=')) out.userData = val();
    else if (a === '-h' || a === '--help') out.help = true;
    else if (!out.file) out.file = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  return out;
}

function line(it) {
  const parent = it.action === 'create' ? ` parent=${it.parent == null ? '(CEO)' : it.parent}` : '';
  const name = it.draft && it.draft.name ? ` "${it.draft.name}"` : '';
  const extra = [];
  if (it.draft && it.draft.notebook) extra.push('notebook');
  if (it.draft && it.draft.seed && Array.isArray(it.draft.seed.files) && it.draft.seed.files.length) extra.push(`${it.draft.seed.files.length} seed file(s)`);
  return `  ok    ${it.ref}: ${it.action} ${it.target}${name}${parent}${extra.length ? ` [${extra.join(', ')}]` : ''}`;
}

function defaultUserData() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Helm');
}

function rpc(port, token, method, params) {
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, { origin: `http://127.0.0.1:${port}` });
    const timer = setTimeout(() => { try { ws.terminate(); } catch {} reject(new Error('no answer from Helm within 30 s')); }, 30_000);
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
    ws.once('open', () => ws.send(JSON.stringify({ id: 1, type: 'rpc', method, params })));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type !== 'result' || m.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (m.error) reject(Object.assign(new Error(m.error.message || 'rpc failed'), { code: m.error.code }));
      else resolve(m.result);
    });
  });
}

async function main() {
  let a;
  try { a = args(process.argv.slice(2)); } catch (e) { console.error(`team-import: ${e.message}`); return 2; }
  if (a.help || !a.file) {
    console.log('usage: node tools/team-import-proposals.js <file.json> [--dry-run] [--port N] [--user-data <dir>]');
    return a.help ? 0 : 2;
  }
  let text;
  try { text = fs.readFileSync(a.file, 'utf8'); } catch (e) { console.error(`team-import: cannot read ${a.file}: ${e.message}`); return 2; }
  const parsed = parseImport(text);
  if (a.dryRun) {
    console.log(`company: ${parsed.company || '(none)'}`);
    for (const it of parsed.items) console.log(line(it));
    for (const s of parsed.errors) console.log(`  skip  ${s.ref == null ? '(file)' : s.ref}: ${s.reason}`);
    console.log(`team-import: ${parsed.items.length} valid, ${parsed.errors.length} skipped`);
    return parsed.items.length ? 0 : 1;
  }
  if (!Number.isInteger(a.port) || a.port <= 0 || a.port > 65535) { console.error('team-import: --port must be a port number'); return 2; }
  const userData = a.userData || defaultUserData();
  let token;
  try { token = fs.readFileSync(path.join(userData, 'token.txt'), 'utf8').trim(); } catch (e) { console.error(`team-import: no token in ${userData} (${e.message}); is Helm installed there?`); return 2; }
  if (!/^[0-9a-f]{64}$/.test(token)) { console.error(`team-import: ${path.join(userData, 'token.txt')} does not hold a Helm token`); return 2; }
  let r;
  try { r = await rpc(a.port, token, 'team.proposals.import', { json: text }); } catch (e) { console.error(`team-import: ${e.code ? `${e.code}: ` : ''}${e.message}`); return 1; }
  const imported = (r && r.imported) || [];
  const skipped = (r && r.skipped) || [];
  for (const it of imported) console.log(`  open  ${it.ref}: ${it.action} ${it.target} -> ${it.id}`);
  for (const s of skipped) console.log(`  skip  ${s.ref == null ? '(file)' : s.ref}: ${s.reason}`);
  console.log(`team-import: ${imported.length} valid, ${skipped.length} skipped`);
  return 0;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(`team-import: ${e && e.stack || e}`); process.exitCode = 1; });
