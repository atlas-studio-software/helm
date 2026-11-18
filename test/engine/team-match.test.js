'use strict';
// lane pos-t2: team/match.js, cwd -> company (docs/POSITIONS.md section 3).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { companyFor, matchCompany, normPath, isInside, worktreeOf } = require('../../main/engine/team/match');

const WIN = { platform: 'win32', realpath: false };
const NIX = { platform: 'linux', realpath: false };

const acme = { id: 'acme', name: 'Acme', folders: ['C:/Users/you/acme', 'C:/Users/you/app'] };
const tools = { id: 'tools', name: 'Tools Co', folders: ['C:/Users/you/app/packages/tools'] };

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'helm-team-match-')); }

test('normPath: forward slashes, no trailing slash, lower case on Windows, roots kept', () => {
  assert.strictEqual(normPath('C:\\Users\\You\\Acme\\', WIN), 'c:/users/you/acme');
  assert.strictEqual(normPath('c:/users/you/acme//', WIN), 'c:/users/you/acme');
  assert.strictEqual(normPath('C:\\', WIN), 'c:/');
  assert.strictEqual(normPath('C:', WIN).startsWith('c:/'), true);
  assert.strictEqual(normPath('\\\\?\\C:\\Users\\you', WIN), 'c:/users/you');
  assert.strictEqual(normPath('C:/Users/you/acme/../app', WIN), 'c:/users/you/app');
  assert.strictEqual(normPath('/Home/x/', NIX), '/Home/x');
  assert.strictEqual(normPath('/', NIX), '/');
  assert.strictEqual(normPath('', WIN), '');
  assert.strictEqual(normPath(null, WIN), '');
  assert.strictEqual(normPath(42, WIN), '');
});

test('isInside: whole segments only', () => {
  assert.strictEqual(isInside('C:/Users/you/helm', 'C:/Users/you/helm', WIN), true);
  assert.strictEqual(isInside('C:/Users/you/helm/main', 'C:/Users/you/helm', WIN), true);
  assert.strictEqual(isInside('C:/Users/you/helm-wt/positions', 'C:/Users/you/helm', WIN), false);
  assert.strictEqual(isInside('C:/Users/you/helmet', 'C:/Users/you/helm', WIN), false);
  assert.strictEqual(isInside('C:/anything', 'C:/', WIN), true);
  assert.strictEqual(isInside('/home/a/b', '/home/a', NIX), true);
  assert.strictEqual(isInside('/home/ab', '/home/a', NIX), false);
});

test('companyFor: inside a folder, case-insensitive and slash-insensitive on Windows', () => {
  const cos = [acme, tools];
  assert.strictEqual(companyFor('C:/Users/you/acme', cos, WIN), acme);
  assert.strictEqual(companyFor('c:\\USERS\\YOU\\ACME\\src\\deep', cos, WIN), acme);
  assert.strictEqual(companyFor('C:/Users/you/app/', cos, WIN), acme);
  assert.strictEqual(companyFor('C:/Users/you/acme-wt/feature', cos, WIN), null, 'a sibling with a longer name is not inside');
  assert.strictEqual(companyFor('C:/Users/you', cos, WIN), null, 'a parent of the folder is not inside');
  assert.strictEqual(companyFor('D:/Users/you/acme', cos, WIN), null, 'another drive');
});

test('companyFor: the LONGEST matching folder wins', () => {
  const cos = [acme, tools];
  assert.strictEqual(companyFor('C:/Users/you/app/packages/tools/src', cos, WIN), tools);
  assert.strictEqual(companyFor('C:/Users/you/app/packages/other', cos, WIN), acme);
  // order of the list does not matter
  assert.strictEqual(companyFor('C:/Users/you/app/packages/tools', [tools, acme], WIN), tools);
  const m = matchCompany('C:/Users/you/app/packages/tools/src', cos, WIN);
  assert.deepStrictEqual({ id: m.company.id, folder: m.folder, via: m.via }, { id: 'tools', folder: 'C:/Users/you/app/packages/tools', via: 'folder' });
});

test('companyFor: case matters where the file system is case-sensitive', () => {
  const co = { id: 'x', folders: ['/home/you/acme'] };
  assert.strictEqual(companyFor('/home/you/acme/src', [co], NIX), co);
  assert.strictEqual(companyFor('/home/you/Acme/src', [co], NIX), null);
  assert.strictEqual(companyFor('/home/you/Acme/src', [co], { ...NIX, caseInsensitive: true }), co);
});

test('companyFor: the team root is never a CEO session', () => {
  const cos = [{ id: 'odd', folders: ['C:/Users/you'] }];
  const opts = { ...WIN, teamRoot: 'C:/Users/you/helm-team' };
  assert.strictEqual(companyFor('C:/Users/you/helm-team/acme/positions/legal', cos, opts), null);
  assert.strictEqual(companyFor('C:/Users/you/helm-team', cos, opts), null);
  assert.strictEqual(companyFor('C:/Users/you/helm-teamwork', cos, opts).id, 'odd', 'only inside the team root');
});

test('companyFor: bad input and empty lists', () => {
  assert.strictEqual(companyFor('', [acme], WIN), null);
  assert.strictEqual(companyFor(undefined, [acme], WIN), null);
  assert.strictEqual(companyFor('C:/Users/you/acme', [], WIN), null);
  assert.strictEqual(companyFor('C:/Users/you/acme', null, WIN), null);
  assert.strictEqual(companyFor('C:/Users/you/acme', [null, { id: 'nofolders' }, { id: 'bad', folders: [7, ''] }], WIN), null);
  assert.strictEqual(companyFor('C:/Users/you/acme', () => [acme], WIN), acme, 'a function returning the list works');
});

// ---- real folders: worktrees, junctions

function mkWorktree(root, main, name, gitdirLine) {
  const wt = path.join(root, name);
  fs.mkdirSync(path.join(wt, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(main, '.git', 'worktrees', name), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), gitdirLine || `gitdir: ${path.join(main, '.git', 'worktrees', name).replace(/\\/g, '/')}\n`);
  return wt;
}

test('worktree: a git worktree counts as its main repo (one .git file read, no git spawn)', () => {
  const root = tmp();
  try {
    const main = path.join(root, 'helm');
    fs.mkdirSync(path.join(main, '.git'), { recursive: true });
    const wt = mkWorktree(path.join(root, 'helm-wt'), main, 'positions');
    const co = { id: 'studio', folders: [main] };
    const m = matchCompany(wt, [co]);
    assert.ok(m, 'worktree matched');
    assert.strictEqual(m.company, co);
    assert.strictEqual(m.via, 'worktree');
    assert.strictEqual(m.worktree, normPath(wt));
    assert.strictEqual(companyFor(path.join(wt, 'src', 'deep'), [co]), co, 'a folder inside the worktree too');
    const w = worktreeOf(path.join(wt, 'src', 'deep'));
    assert.strictEqual(normPath(w.root), normPath(wt));
    assert.strictEqual(normPath(w.mapped), normPath(path.join(main, 'src', 'deep')));
    // the main repo itself is a plain folder match
    assert.strictEqual(matchCompany(path.join(main, 'x'), [co]).via, 'folder');
    // a direct folder match wins over the worktree rule
    const wtCo = { id: 'wt-co', folders: [path.join(root, 'helm-wt')] };
    assert.strictEqual(companyFor(wt, [co, wtCo]), wtCo);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('worktree: maps to the same place in the main repo (a company folder deep in a monorepo)', () => {
  const root = tmp();
  try {
    const main = path.join(root, 'mono');
    fs.mkdirSync(path.join(main, '.git'), { recursive: true });
    const wt = mkWorktree(root, main, 'mono-feature');
    fs.mkdirSync(path.join(wt, 'packages', 'tools'), { recursive: true });
    const pkg = { id: 'pkg', folders: [path.join(main, 'packages', 'tools')] };
    assert.strictEqual(companyFor(path.join(wt, 'packages', 'tools'), [pkg]), pkg);
    assert.strictEqual(companyFor(path.join(wt, 'src'), [pkg]), null, 'elsewhere in the worktree is outside the package');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('worktree: relative gitdir, CRLF, and case of the gitdir path', () => {
  const root = tmp();
  try {
    const main = path.join(root, 'repo');
    fs.mkdirSync(path.join(main, '.git'), { recursive: true });
    const wt = mkWorktree(root, main, 'wt-rel', 'gitdir: ../repo/.git/worktrees/wt-rel\r\n');
    const co = { id: 'r', folders: [main] };
    assert.strictEqual(companyFor(wt, [co]), co);
    if (process.platform === 'win32') {
      const wt2 = mkWorktree(root, main, 'wt-case', `gitdir: ${path.join(main, '.git', 'worktrees', 'wt-case').toUpperCase()}\n`);
      assert.strictEqual(companyFor(wt2, [co]), co, 'Windows: gitdir in another case still matches');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('worktree: submodule .git files, broken .git files and plain repos do not map', () => {
  const root = tmp();
  try {
    const main = path.join(root, 'super');
    fs.mkdirSync(path.join(main, '.git', 'modules', 'lib'), { recursive: true });
    const co = { id: 's', folders: [path.join(root, 'elsewhere')] };
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${path.join(main, '.git', 'modules', 'lib')}\n`);
    assert.strictEqual(worktreeOf(sub), null, 'submodule');
    const broken = path.join(root, 'broken');
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, '.git'), 'not a gitdir line\n');
    assert.strictEqual(worktreeOf(broken), null, 'no gitdir line');
    const plain = path.join(root, 'plain');
    fs.mkdirSync(path.join(plain, '.git', 'worktrees', 'x'), { recursive: true });
    assert.strictEqual(worktreeOf(path.join(plain)), null, 'a .git folder is a normal repo');
    assert.strictEqual(companyFor(plain, [co]), null);
    // a plain repo nested inside a worktree stops the walk at its own .git folder
    const outerMain = path.join(root, 'outer');
    fs.mkdirSync(path.join(outerMain, '.git'), { recursive: true });
    const wt = mkWorktree(root, outerMain, 'outer-wt');
    const inner = path.join(wt, 'vendor', 'inner');
    fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
    assert.strictEqual(companyFor(inner, [{ id: 'o', folders: [outerMain] }]), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real paths: junctions and symlinks are followed both ways', { skip: process.platform !== 'win32' && 'junctions are Windows' }, () => {
  const root = tmp();
  try {
    const real = path.join(root, 'real-acme');
    fs.mkdirSync(path.join(real, 'src'), { recursive: true });
    const link = path.join(root, 'link-acme');
    fs.symlinkSync(real, link, 'junction');
    const byReal = { id: 'a', folders: [real] };
    const byLink = { id: 'b', folders: [link] };
    assert.strictEqual(companyFor(path.join(link, 'src'), [byReal]), byReal, 'cwd through the junction');
    assert.strictEqual(companyFor(path.join(real, 'src'), [byLink]), byLink, 'folder stored through the junction');
    // a not-yet-existing folder under the junction still resolves through it
    assert.strictEqual(companyFor(path.join(link, 'new', 'deeper'), [byReal]), byReal);
    // team root reached through a junction is still the team root
    const team = path.join(root, 'team');
    fs.mkdirSync(path.join(team, 'acme'), { recursive: true });
    const teamLink = path.join(real, 'team-link');
    fs.symlinkSync(team, teamLink, 'junction');
    assert.strictEqual(companyFor(teamLink, [byReal], { teamRoot: team }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real paths: Windows case is ignored on disk too', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const root = tmp();
  try {
    const dir = path.join(root, 'MixedCase');
    fs.mkdirSync(dir);
    const co = { id: 'm', folders: [dir.toUpperCase()] };
    assert.strictEqual(companyFor(dir.toLowerCase(), [co]), co);
    assert.strictEqual(companyFor(dir.replace(/\\/g, '/'), [co]), co);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
