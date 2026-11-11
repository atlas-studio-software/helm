'use strict';
// ui/lib/look-pure.js is look-sync's pure (browser-safe) block, vendored for the page by tools/vendor-look-sync.js.
// It must be the SAME code as the host's main/look-sync.js (same commit), so the page's tint (washAlpha) and the
// seeds match what Quartz and Mantle run. Lane look-helm (sharp glass, 2026-11-11).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const LS = require('../../main/look-sync');

const ROOT = path.join(__dirname, '..', '..');
const BEGIN = '// ==== pure (browser-safe): begin ====', END = '// ==== pure (browser-safe): end ====';
const block = (t) => t.slice(t.indexOf(BEGIN), t.indexOf(END) + END.length).replace(/\r\n/g, '\n');
const commitOf = (t) => (t.match(/at commit ([0-9a-f]{7,40})/) || [])[1];

test('the page copy is the host copy\'s pure block, from the same look-sync commit', () => {
  const host = fs.readFileSync(path.join(ROOT, 'main', 'look-sync.js'), 'utf8');
  const page = fs.readFileSync(path.join(ROOT, 'ui', 'lib', 'look-pure.js'), 'utf8');
  assert.ok(host.includes(BEGIN) && page.includes(BEGIN), 'both carry the pure block');
  assert.equal(block(page), block(host), 'block text identical (re-run node tools/vendor-look-sync.js)');
  assert.ok(commitOf(host), 'host copy names its commit');
  assert.equal(commitOf(page), commitOf(host), 'same commit');
});

test('washAlpha, SEED and RANGES agree between the page and the host', async () => {
  const P = await import('../../ui/lib/look-pure.js');
  assert.deepEqual(P.SEED, LS.SEED);
  assert.deepEqual(P.RANGES, LS.RANGES);
  assert.deepEqual(P.SEED.glass.dark, { blurPx: 0, dim: 0.3, panel: 0 }, 'the 2026-11-11 seed');
  const g = (o) => ({ glass: { dark: { blurPx: 0, dim: 0.3, panel: 0, ...o }, light: { blurPx: 0, dim: 0.3, panel: 0, ...o } } });
  const rec = (guard, extra) => ({ rev: 2, ok: true, still: 'a.png', guard, ...extra });
  const cases = [
    [g(), rec({ dark: { alpha: 0.46, dim: 0.3, blurPx: 0 } }), 'dark'],
    [g(), rec({ dark: { alpha: 0.2, dim: 0.3, blurPx: 0 } }), 'dark'],
    [g({ dimAuto: false }), rec({ dark: { alpha: 0.46, dim: 0.3, blurPx: 0 } }), 'dark'],
    [g(), rec({ light: { alpha: 0.5, dim: 0.3, blurPx: 0 } }), 'light'],
    [g({ dim: 0.5 }), rec({ dark: { alpha: 0.6, dim: 0.3, blurPx: 0 } }), 'dark'],
    [g(), rec(null, { guardReason: 'decode failed' }), 'dark'],
    [g(), rec({ dark: { alpha: 0.95, dim: 0.3, blurPx: 0 } }), 'dark'],
    [g(), null, 'dark'],
    [{}, null, 'light'],
  ];
  for (const [look, desk, theme] of cases) {
    assert.deepEqual(P.washAlpha(look, desk, theme), LS.washAlpha(look, desk, theme), JSON.stringify([look, desk, theme]));
  }
  assert.deepEqual(P.washAlpha(g(), cases[0][1], 'dark', { unusable: 'own picture' }), LS.washAlpha(g(), cases[0][1], 'dark', { unusable: 'own picture' }));
});
