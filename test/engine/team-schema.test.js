// position.json schema (main/engine/team/schema.js): the optional repoRules switch that options.js reads
// (unset = on for coding positions; true / false force it). Pure checks, no files.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../main/engine/team/schema');

const base = (extra = {}) => ({ id: 'release', name: 'Release', remit: 'Release notes and checks', parent: null, version: 1, ...extra });

test('repoRules: left out stays left out (options.js decides: on for coding positions)', () => {
  const r = S.validatePosition(base());
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(Object.hasOwn(r.value, 'repoRules'), false);
});

test('repoRules: true and false are kept as given', () => {
  for (const v of [true, false]) {
    const r = S.validatePosition(base({ repoRules: v }));
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.equal(r.value.repoRules, v);
  }
});

test('repoRules: null means unset', () => {
  const r = S.validatePosition(base({ repoRules: null }));
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(Object.hasOwn(r.value, 'repoRules'), false);
});

test('repoRules: anything else is refused in words', () => {
  for (const v of ['yes', 1, 0, {}, []]) {
    const r = S.validatePosition(base({ repoRules: v }));
    assert.equal(r.ok, false, JSON.stringify(v));
    assert.ok(r.errors.some((e) => /^repoRules: must be true or false/.test(e)), r.errors.join('; '));
  }
});

test('repoRules: a draft keeps it too, and the input object is not changed', () => {
  const input = { id: 'docs', name: 'Docs', remit: 'Docs things', repoRules: false };
  const r = S.validatePosition(input, { draft: true });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.value.repoRules, false);
  const nul = { ...input, repoRules: null };
  S.validatePosition(nul, { draft: true });
  assert.equal(nul.repoRules, null);
});

// ---------------------------------------------------------------- review fix 10: company folders vs the home folder

const co = (folders) => ({ id: 'acme', name: 'Acme', folders, version: 1 });
const WINHOME = 'C:\\Users\\owen';

test('fix 10: a company folder may not be the home folder itself (any spelling)', () => {
  for (const f of ['C:\\Users\\owen', 'C:/Users/owen', 'C:/Users/owen/', 'c:\\users\\OWEN', 'C:/Users/owen//', '~']) {
    S.setCaseInsensitive(true);
    try {
      const r = S.validateCompany(co([f]), { home: WINHOME });
      assert.equal(r.ok, false, f);
      assert.ok(r.errors.some((e) => /^folders\[0\]: a company folder can't be your home folder itself/.test(e)), `${f}: ${r.errors.join('; ')}`);
    } finally { S.setCaseInsensitive(process.platform === 'win32'); }
  }
});

test('fix 10: a company folder may not hold the home folder (C:\\Users, a drive root, /home)', () => {
  S.setCaseInsensitive(true);
  try {
    const r = S.validateCompany(co(['C:\\Users']), { home: WINHOME });
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /^folders\[0\]: a company folder can't hold your home folder \(C:\/Users holds C:\/Users\/owen\)/);
    const low = S.validateCompany(co(['c:/users']), { home: WINHOME });
    assert.equal(low.ok, false, 'case-insensitive on Windows');
    const drive = S.validateCompany(co(['C:\\']), { home: WINHOME });
    assert.match(drive.errors[0], /a whole drive cannot be a company folder/, 'a drive root keeps its own reason');
  } finally { S.setCaseInsensitive(process.platform === 'win32'); }
  const nix = S.validateCompany(co(['/home']), { home: '/home/owen' });
  assert.equal(nix.ok, false);
  assert.match(nix.errors[0], /can't hold your home folder/);
});

test('fix 10: folders inside the home folder, next to it or elsewhere are fine; the default home is os.homedir()', () => {
  S.setCaseInsensitive(true);
  try {
    const r = S.validateCompany(co(['~/acme', 'C:\\Users\\owen\\work\\site', 'C:\\Users\\owenx', 'D:\\projects\\acme']), { home: WINHOME });
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.deepEqual(r.value.folders, ['C:/Users/owen/acme', 'C:/Users/owen/work/site', 'C:/Users/owenx', 'D:/projects/acme']);
  } finally { S.setCaseInsensitive(process.platform === 'win32'); }
  const os = require('os');
  const home = S.normPath(os.homedir());
  const r = S.validateCompany(co([home]));
  assert.equal(r.ok, false, 'os.homedir() is the default home');
  assert.match(r.errors[0], /your home folder itself/);
  const inside = S.validateCompany(co([home + '/some-company']));
  assert.equal(inside.ok, true, inside.errors.join('; '));
  const draft = S.validateCompany({ id: 'acme', name: 'Acme', folders: [home] }, { draft: true });
  assert.equal(draft.ok, false, 'drafts (proposals) are refused too');
});

// ---------- department (2.4): only a top-level position heads one; staff derive theirs (tree.departmentOf) ----------
test('department: kept trimmed on a position that reports to the CEO', () => {
  const r = S.validatePosition(base({ department: '  Legal & Compliance ' }));
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.value.department, 'Legal & Compliance');
  const draft = S.validatePosition({ id: 'gc', name: 'General Counsel', remit: 'Contracts', department: 'Legal' }, { draft: true });
  assert.equal(draft.ok, true, draft.errors.join('; '));
  assert.equal(draft.value.department, 'Legal', 'a draft defaults parent to null, so it may head one');
});
test('department: null, "" and blank mean none and the key is dropped (byte-identical to a position without one)', () => {
  const plain = S.validatePosition(base());
  for (const v of [null, '', '   ', undefined]) {
    const r = S.validatePosition(base({ department: v }));
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.equal(Object.hasOwn(r.value, 'department'), false);
    assert.equal(JSON.stringify(r.value), JSON.stringify(plain.value));
  }
});
test('department: refused below the top level, on more than one line, too long, or not text', () => {
  const staff = S.validatePosition(base({ parent: 'legal', department: 'Legal' }));
  assert.equal(staff.ok, false);
  assert.deepEqual(staff.errors, ['department: only a position that reports to the CEO (parent null) can head a department; its reports are in that department already']);
  assert.equal(S.validatePosition(base({ parent: 'legal', department: null })).ok, true, 'null below the top level is fine');
  assert.match(S.validatePosition(base({ department: 'Legal\nOps' })).errors.join(), /^department: one line, at most 60/);
  assert.match(S.validatePosition(base({ department: 'x'.repeat(61) })).errors.join(), /^department: one line/);
  assert.equal(S.validatePosition(base({ department: 'x'.repeat(60) })).ok, true);
  assert.match(S.validatePosition(base({ department: 7 })).errors.join(), /^department:/);
});
