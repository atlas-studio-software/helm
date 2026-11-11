#!/usr/bin/env node
// Re-vendor look-sync (~/look-sync, the shared look file for Helm, Quartz and Mantle) from a COMMITTED revision:
//   main/look-sync.js   the whole module (host side), with the vendoring header
//   ui/lib/look-pure.js the "pure (browser-safe)" block as an ES module (seeds, ranges, washAlpha) for the page
// Both say which commit they came from; test/host/look-pure.test.js checks they agree. Never edit the copies by hand.
//
//   node tools/vendor-look-sync.js [ref] [--repo=C:\path\to\look-sync]     (ref default: main)
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const repo = (args.find((a) => a.startsWith('--repo=')) || '').slice(7) || path.join(os.homedir(), 'look-sync');
const ref = args.find((a) => !a.startsWith('--')) || 'main';
const root = path.join(__dirname, '..');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });

const sha = git('rev-parse', '--short', `${ref}^{commit}`).trim();
// Helm is public: the vendored text names "the user", not a person (the earlier copies did the same by hand)
const scrub = (t) => t.replace(/\bOwen's\b/g, "the user's").replace(/\bOwen\b/g, 'the user');
const src = scrub(git('show', `${sha}:look-sync.js`)).replace(/\r\n/g, '\n');

const BEGIN = '// ==== pure (browser-safe): begin ====', END = '// ==== pure (browser-safe): end ====';
const b = src.indexOf(BEGIN), e = src.indexOf(END);
if (b < 0 || e < b) throw new Error(`look-sync ${sha} has no pure (browser-safe) block`);
const block = src.slice(b, e + END.length);
const names = [...block.matchAll(/^(?:const|function|let)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
if (!names.includes('washAlpha')) throw new Error(`look-sync ${sha}: the pure block has no washAlpha`);

const host = `// VENDORED from the look-sync project (look-sync.js at commit ${sha}). Do not edit here:\n`
  + `// change it in look-sync, run its tests, and re-copy (node tools/vendor-look-sync.js). Spec: ~/look-sync/CONTRACT.md.\n`
  + src;
const page = `// VENDORED from the look-sync project: the pure (browser-safe) block of look-sync.js at commit ${sha}, as an ES\n`
  + `// module for the page (ui/lib/wash.js). Do not edit here: change look-sync and run node tools/vendor-look-sync.js.\n`
  + `// test/host/look-pure.test.js checks it matches main/look-sync.js. Spec: ~/look-sync/CONTRACT.md.\n\n`
  + block + '\n\n' + `export { ${names.join(', ')} };\n`;

fs.writeFileSync(path.join(root, 'main', 'look-sync.js'), host);
fs.writeFileSync(path.join(root, 'ui', 'lib', 'look-pure.js'), page);
console.log(`vendored look-sync ${sha}: main/look-sync.js + ui/lib/look-pure.js (exports ${names.join(', ')})`);
