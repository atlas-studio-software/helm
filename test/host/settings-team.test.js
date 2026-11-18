// Unit tests for the Positions keys in main/settings.js (team.*: defaults, validation, hand-edit repair, team root
// rules from docs/POSITIONS.md 2.1). Temp folders only; nothing outside os.tmpdir() is touched.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSettings, defaults, TEAM_DEFAULTS, resolveTeamRoot, teamRootProblem } = require('../../main/settings.js');

const tmpRoots = [];
after(() => { for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true }); });

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-settings-team-'));
  tmpRoots.push(root);
  const dirs = { root, userDataDir: path.join(root, 'userData'), home: path.join(root, 'home') };
  for (const d of [dirs.userDataDir, dirs.home]) fs.mkdirSync(d, { recursive: true });
  return dirs;
}
function make(dirs, extra = {}) {
  const logs = [];
  const events = [];
  const st = createSettings({ userDataDir: dirs.userDataDir, home: dirs.home, appDataDir: null, uiBgDir: null,
    emit: (e, d) => events.push([e, d]), log: (...a) => logs.push(a.join(' ')), ...extra });
  return { st, logs, events };
}
const writeRaw = (dirs, obj) => fs.writeFileSync(path.join(dirs.userDataDir, 'settings.json'), JSON.stringify(obj));
const readRaw = (dirs) => JSON.parse(fs.readFileSync(path.join(dirs.userDataDir, 'settings.json'), 'utf8'));
const badParams = (re) => (e) => e.code === 'bad_params' && re.test(e.message);

describe('team defaults', () => {
  test('match the spec (POSITIONS 11, 5.1, 5.2, 8.3, 9.5)', () => {
    assert.deepEqual({ ...TEAM_DEFAULTS }, {
      enabled: false, root: '~/helm-team', maxConcurrentRuns: 2, usageCeilingPct: 80, dutiesPaused: false,
      rollPct: 32, rollNowPct: 40, askWaitS: 300, askWaitPositionS: 180, askWaitMaxS: 600, ownerName: '',
    });
    assert.ok(Object.isFrozen(TEAM_DEFAULTS));
  });

  test('a fresh settings.json gets them, and defaults() returns a copy', () => {
    const dirs = sandbox();
    const { st } = make(dirs);
    assert.deepEqual(st.get().team, { ...TEAM_DEFAULTS });
    assert.deepEqual(readRaw(dirs).team, { ...TEAM_DEFAULTS });
    const d = defaults(dirs.home);
    d.team.enabled = true;
    assert.equal(TEAM_DEFAULTS.enabled, false);
    assert.equal(defaults(dirs.home).team.enabled, false);
  });

  test('teamRoot() resolves ~ under home', () => {
    const dirs = sandbox();
    const { st } = make(dirs);
    assert.equal(st.teamRoot(), path.join(dirs.home, 'helm-team'));
  });
});

describe('team.set', () => {
  test('a partial team object merges and is saved and broadcast', () => {
    const dirs = sandbox();
    const { st, events } = make(dirs);
    const out = st.set({ team: { enabled: true } });
    assert.equal(out.team.enabled, true);
    assert.equal(out.team.maxConcurrentRuns, 2);
    st.set({ team: { maxConcurrentRuns: 3, usageCeilingPct: 70, dutiesPaused: true } });
    const t = st.get().team;
    assert.deepEqual([t.enabled, t.maxConcurrentRuns, t.usageCeilingPct, t.dutiesPaused], [true, 3, 70, true]);
    assert.equal(readRaw(dirs).team.usageCeilingPct, 70);
    assert.ok(events.some(([e, d]) => e === 'settings.updated' && d.team.dutiesPaused === true));
  });

  test('refuses unknown keys, wrong types and out-of-range numbers', () => {
    const dirs = sandbox();
    const { st } = make(dirs);
    assert.throws(() => st.set({ team: 'on' }), badParams(/team must be an object/));
    assert.throws(() => st.set({ team: [] }), badParams(/team must be an object/));
    assert.throws(() => st.set({ team: { colour: 'red' } }), badParams(/unknown team key colour/));
    assert.throws(() => st.set({ team: { enabled: 'yes' } }), badParams(/team\.enabled must be true or false/));
    assert.throws(() => st.set({ team: { dutiesPaused: 1 } }), badParams(/team\.dutiesPaused/));
    assert.throws(() => st.set({ team: { maxConcurrentRuns: 0 } }), badParams(/maxConcurrentRuns must be a whole number 1 to 8/));
    assert.throws(() => st.set({ team: { maxConcurrentRuns: 2.5 } }), badParams(/maxConcurrentRuns/));
    assert.throws(() => st.set({ team: { maxConcurrentRuns: 9 } }), badParams(/maxConcurrentRuns/));
    assert.throws(() => st.set({ team: { usageCeilingPct: 101 } }), badParams(/usageCeilingPct must be a whole number 1 to 100/));
    assert.throws(() => st.set({ team: { usageCeilingPct: '80' } }), badParams(/usageCeilingPct/));
    assert.throws(() => st.set({ team: { askWaitS: 29 } }), badParams(/askWaitS must be a whole number 30 to 600/));
    assert.throws(() => st.set({ team: { askWaitMaxS: 601 } }), badParams(/askWaitMaxS must be a whole number 30 to 600/));
    assert.throws(() => st.set({ team: { rollNowPct: 96 } }), badParams(/rollNowPct/));
    assert.throws(() => st.set({ team: { root: '' } }), badParams(/team\.root must be a folder path/));
    assert.throws(() => st.set({ team: { root: 42 } }), badParams(/team\.root must be a folder path/));
    // nothing was changed by the refused calls
    assert.deepEqual(st.get().team, { ...TEAM_DEFAULTS });
  });

  test('checks that tie two values together run on the merged result', () => {
    const dirs = sandbox();
    const { st } = make(dirs);
    assert.throws(() => st.set({ team: { rollPct: 40 } }), badParams(/rollPct \(40\) must be below team\.rollNowPct \(40\)/));
    assert.throws(() => st.set({ team: { rollNowPct: 30 } }), badParams(/below/));
    st.set({ team: { rollPct: 25, rollNowPct: 35 } });
    assert.deepEqual([st.get().team.rollPct, st.get().team.rollNowPct], [25, 35]);
    assert.throws(() => st.set({ team: { askWaitMaxS: 200 } }), badParams(/askWaitS \(300 s\) can't be above team\.askWaitMaxS \(200 s\)/));
    st.set({ team: { askWaitS: 120, askWaitPositionS: 90, askWaitMaxS: 200 } });
    assert.deepEqual([st.get().team.askWaitS, st.get().team.askWaitPositionS, st.get().team.askWaitMaxS], [120, 90, 200]);
    assert.throws(() => st.set({ team: { askWaitPositionS: 201 } }), badParams(/askWaitPositionS \(201 s\)/));
  });
});

describe('team root (POSITIONS 2.1)', () => {
  test('resolveTeamRoot', () => {
    const home = path.join(os.tmpdir(), 'h');
    assert.equal(resolveTeamRoot('~/helm-team', home), path.join(home, 'helm-team'));
    assert.equal(resolveTeamRoot('~\\team\\x', home), path.join(home, 'team', 'x'));
    assert.equal(resolveTeamRoot('~', home), path.resolve(home));
    assert.equal(resolveTeamRoot('  ~/t  ', home), path.join(home, 't'));
    const abs = path.join(os.tmpdir(), 'abs-team');
    assert.equal(resolveTeamRoot(abs, home), abs);
    assert.equal(resolveTeamRoot('relative/team', home), null);
    assert.equal(resolveTeamRoot('~other/team', home), null);
    assert.equal(resolveTeamRoot('', home), null);
    assert.equal(resolveTeamRoot(null, home), null);
  });

  test('a plain folder outside every repo and company is fine, whether or not it exists yet', () => {
    const dirs = sandbox();
    assert.equal(teamRootProblem('~/helm-team', { home: dirs.home }), null);
    fs.mkdirSync(path.join(dirs.home, 'helm-team'));
    assert.equal(teamRootProblem('~/helm-team', { home: dirs.home }), null);
    assert.equal(teamRootProblem(path.join(dirs.root, 'elsewhere', 'team'), { home: dirs.home }), null);
  });

  test('refuses a relative path, a drive root and the home folder itself', () => {
    const dirs = sandbox();
    assert.match(teamRootProblem('team', { home: dirs.home }), /full path/);
    assert.match(teamRootProblem(path.parse(dirs.root).root, { home: dirs.home }), /drive root/);
    assert.match(teamRootProblem('~', { home: dirs.home }), /home folder itself/);
    assert.match(teamRootProblem(dirs.home + path.sep, { home: dirs.home }), /home folder itself/);
  });

  test('refuses a folder inside a git work tree (a .git folder, or a worktree .git file, at any level)', () => {
    const dirs = sandbox();
    const repo = path.join(dirs.home, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    assert.match(teamRootProblem(repo, { home: dirs.home }), /inside the git repo at .*repo/);
    assert.match(teamRootProblem(path.join(repo, 'a', 'team'), { home: dirs.home }), /inside the git repo/);
    const wt = path.join(dirs.home, 'repo-wt', 'lane');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ../../repo/.git/worktrees/lane\n');
    assert.match(teamRootProblem(path.join(wt, 'team'), { home: dirs.home }), /inside the git repo at .*lane/);
    // a sibling of the repo is fine
    assert.equal(teamRootProblem(path.join(dirs.home, 'helm-team'), { home: dirs.home }), null);
  });

  test('refuses a folder inside a company folder, or one that contains a company folder', () => {
    const dirs = sandbox();
    const co = path.join(dirs.home, 'code', 'shop');
    fs.mkdirSync(co, { recursive: true });
    const companyFolders = [co.replace(/\\/g, '/')];
    assert.match(teamRootProblem(path.join(co, 'team'), { home: dirs.home, companyFolders }), /inside a company folder/);
    assert.match(teamRootProblem(path.join(dirs.home, 'code'), { home: dirs.home, companyFolders }), /contains a company folder/);
    assert.equal(teamRootProblem(path.join(dirs.home, 'code-team'), { home: dirs.home, companyFolders }), null);   // a prefix, not a parent
    if (process.platform === 'win32') {
      assert.match(teamRootProblem(path.join(co.toUpperCase(), 'team'), { home: dirs.home, companyFolders }), /inside a company folder/);
    }
    // junk in the list is ignored
    assert.equal(teamRootProblem('~/helm-team', { home: dirs.home, companyFolders: [null, 3, ''] }), null);
  });

  test('settings.set refuses a bad root with the reason, and uses the engine\'s company folders', () => {
    const dirs = sandbox();
    const co = path.join(dirs.home, 'shop');
    fs.mkdirSync(path.join(co, '.git'), { recursive: true });
    const other = path.join(dirs.home, 'docs-co');
    fs.mkdirSync(other, { recursive: true });
    const { st } = make(dirs, { teamCompanyFolders: () => [other] });
    assert.throws(() => st.set({ team: { root: path.join(co, 'team') } }), badParams(/inside the git repo/));
    assert.throws(() => st.set({ team: { root: path.join(other, 'team') } }), badParams(/inside a company folder/));
    assert.throws(() => st.set({ team: { root: 'team' } }), badParams(/full path/));
    assert.equal(st.get().team.root, '~/helm-team');
    const moved = path.join(dirs.root, 'my-team');
    st.set({ team: { root: `  ${moved}  ` } });
    assert.equal(st.get().team.root, moved);
    assert.equal(st.teamRoot(), moved);
  });

  test('a teamCompanyFolders hook that throws does not block the set', () => {
    const dirs = sandbox();
    const { st, logs } = make(dirs, { teamCompanyFolders: () => { throw new Error('store not ready'); } });
    st.set({ team: { root: path.join(dirs.root, 't2') } });
    assert.equal(st.teamRoot(), path.join(dirs.root, 't2'));
    assert.ok(logs.some((l) => /team company folders/.test(l)));
  });

  test('re-saving the current root never fails, even if it has a problem now', () => {
    const dirs = sandbox();
    const bad = path.join(dirs.home, 'repo', 'team');
    fs.mkdirSync(path.join(dirs.home, 'repo', '.git'), { recursive: true });
    writeRaw(dirs, { team: { root: bad, enabled: true } });
    const { st } = make(dirs);
    assert.equal(st.get().team.root, bad, 'a hand-edited root is kept; the engine reports it as rootProblem');
    st.set({ team: { root: bad, maxConcurrentRuns: 1 } });   // the Settings panel echoing the whole object back
    assert.equal(st.get().team.maxConcurrentRuns, 1);
  });
});

describe('hand-edited settings.json', () => {
  test('each bad team value falls back to its default; good ones and other settings stay', () => {
    const dirs = sandbox();
    writeRaw(dirs, { theme: 'light', team: { enabled: true, root: '  D:/team  ', maxConcurrentRuns: 'two', usageCeilingPct: 150,
      dutiesPaused: 'no', askWaitS: 240, askWaitPositionS: 7, askWaitMaxS: 600, rollPct: 30, rollNowPct: 38, extra: 1 } });
    const { st, logs } = make(dirs);
    const t = st.get().team;
    assert.deepEqual(t, { enabled: true, root: 'D:/team', maxConcurrentRuns: 2, usageCeilingPct: 80, dutiesPaused: false,
      rollPct: 30, rollNowPct: 38, askWaitS: 240, askWaitPositionS: 180, askWaitMaxS: 600, ownerName: '' });
    assert.equal(st.get().theme, 'light');
    assert.ok(!('extra' in readRaw(dirs).team));
    assert.ok(logs.some((l) => /team values reset to defaults: .*maxConcurrentRuns/.test(l)));
  });

  test('a team that is not an object, or a missing one, becomes the defaults', () => {
    for (const team of ['on', null, [1, 2], 5]) {
      const dirs = sandbox();
      writeRaw(dirs, { team });
      assert.deepEqual(make(dirs).st.get().team, { ...TEAM_DEFAULTS });
    }
    const dirs = sandbox();
    writeRaw(dirs, { theme: 'dark' });
    assert.deepEqual(make(dirs).st.get().team, { ...TEAM_DEFAULTS });
  });

  test('crossed thresholds and waits are repaired', () => {
    const dirs = sandbox();
    writeRaw(dirs, { team: { rollPct: 45, rollNowPct: 40, askWaitS: 500, askWaitPositionS: 400, askWaitMaxS: 300, root: '' } });
    const t = make(dirs).st.get().team;
    assert.deepEqual([t.rollPct, t.rollNowPct], [32, 40]);
    assert.deepEqual([t.askWaitS, t.askWaitPositionS, t.askWaitMaxS], [300, 300, 300]);
    assert.equal(t.root, '~/helm-team');
  });
});
