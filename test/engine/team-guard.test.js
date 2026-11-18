// Positions: the team guard, a PreToolUse hook that checks a position's tool calls against its effective powers
// (main/engine/team/guard.js, docs/POSITIONS.md 7.3). Policy tables over temp dirs; no network, no real git push.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../../main/engine/team/schema');
const { createTree } = require('../../main/engine/team/tree');
const guard = require('../../main/engine/team/guard');

const WIN = process.platform === 'win32';
const real = (p) => S.normPath(fs.realpathSync.native(p));

// root/
//   co/app (a company folder: has src/x.js)   co/docs (a company folder)
//   team/acme/positions/tax (the workspace)    outside/secret.txt
//   live/ (a repo)  wt/ (its worktree: .git file pointing into live/.git/worktrees/wt)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'team-guard-'));
const D = {
  app: path.join(ROOT, 'co', 'app'), docs: path.join(ROOT, 'co', 'docs'),
  ws: path.join(ROOT, 'team', 'acme', 'positions', 'tax'), outside: path.join(ROOT, 'outside'),
  live: path.join(ROOT, 'live'), wt: path.join(ROOT, 'wt'),
};
for (const d of Object.values(D)) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(path.join(D.app, 'src'), { recursive: true });
fs.writeFileSync(path.join(D.app, 'src', 'x.js'), '1');
fs.writeFileSync(path.join(D.outside, 'secret.txt'), 's');
fs.mkdirSync(path.join(D.live, '.git', 'worktrees', 'wt'), { recursive: true });
fs.writeFileSync(path.join(D.wt, '.git'), `gitdir: ${path.join(D.live, '.git', 'worktrees', 'wt').replace(/\\/g, '/')}\n`);
test.after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

const CO = [real(D.app), real(D.docs)];
const base = (over = {}) => ({
  read: [real(D.ws), ...CO], write: [real(D.ws)],
  tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'WebFetch'], bash: 'off', agents: false,
  workspace: real(D.ws), ...over,
});

// A hook over a mutable powers value, a grant list and a scripted approval.
function rig(powers, { grants = [], approve = null } = {}) {
  const st = { powers, grants, asked: [], logs: [] };
  const { hooks, timeout } = guard.createHook({
    sessionId: 's1',
    getEffectivePowers: (sid) => (sid === 's1' ? st.powers : null),
    consumeGrant: (sid, need) => {
      const i = st.grants.findIndex((g) => need.matches(g));
      if (i < 0) return null;
      return st.grants.splice(i, 1)[0];
    },
    requestApproval: async (req) => { st.asked.push(req); return approve ? approve(req) : { decision: 'denied' }; },
    log: (level, msg) => st.logs.push(`${level} ${msg}`),
    home: ROOT,
  });
  assert.ok(timeout > 1800, 'hook timeout is past the 30 min wait');
  st.call = async (tool_name, tool_input, cwd = D.ws) => {
    const r = await hooks[0]({ tool_name, tool_input, cwd, session_id: 'cli-1' }, 'tu1', { signal: new AbortController().signal });
    const o = r && r.hookSpecificOutput;
    return o && o.permissionDecision === 'deny' ? { deny: o.permissionDecisionReason } : { allow: true };
  };
  return st;
}

async function table(st, rows) {
  for (const [tool, input, want, cwd, re] of rows) {
    const r = await st.call(tool, input, cwd);
    const label = `${tool} ${JSON.stringify(input)} in ${cwd || 'ws'}`;
    if (want === 'allow') assert.ok(r.allow, `${label}: expected allow, got deny: ${r.deny}`);
    else {
      assert.ok(r.deny, `${label}: expected deny`);
      if (re) assert.match(r.deny, re, label);
    }
  }
}

test('files: inside vs outside the workspace and company folders', async () => {
  const st = rig(base());
  await table(st, [
    ['Read', { file_path: path.join(D.ws, 'notebook.md') }, 'allow'],
    ['Read', { file_path: path.join(D.app, 'src', 'x.js') }, 'allow'],
    ['Read', { file_path: path.join(D.docs, 'new', 'not-yet.md') }, 'allow'], // nearest existing ancestor is inside
    ['Read', { file_path: path.join(D.outside, 'secret.txt') }, 'deny', undefined, /^Outside your area: .*secret\.txt\. If you need it, call request_access with the reason\.$/],
    ['Read', { file_path: path.join(ROOT, 'team', 'acme', 'positions', 'legal', 'notebook.md') }, 'deny', undefined, /Outside your area/],
    ['Grep', { pattern: 'x' }, 'allow'],                                // no path: cwd (the workspace)
    ['Grep', { pattern: 'x' }, 'deny', D.outside, /Outside your area/], // no path, cwd outside
    ['Grep', { pattern: 'x', path: D.app }, 'allow'],
    ['Glob', { pattern: '**/*.js', path: D.app }, 'allow'],
    ['Glob', { pattern: `${D.outside.replace(/\\/g, '/')}/**/*.txt` }, 'deny', undefined, /Outside your area/],
    ['Grep', { pattern: 'x', path: path.join(ROOT, 'co') }, 'deny', undefined, /Outside your area/], // the parent of two roots
    ['Write', { file_path: path.join(D.ws, 'notes', 'a.md'), content: 'x' }, 'allow'],
    ['Edit', { file_path: path.join(D.ws, 'notes.md'), old_string: 'a', new_string: 'b' }, 'allow'],
    ['Edit', { file_path: path.join(D.ws, 'brief.md'), old_string: 'a', new_string: 'b' }, 'deny', undefined, /part of a position's definition/], // fix 1
    ['WebFetch', { url: 'https://example.com' }, 'allow'],
  ]);
});

test('files: relative paths, mixed case, slash styles and a .. that leaves the area', async () => {
  const st = rig(base());
  await table(st, [
    ['Read', { file_path: 'notebook.md' }, 'allow'],                                   // relative to cwd
    ['Read', { file_path: 'src/x.js' }, 'allow', D.app],
    ['Read', { file_path: 'src\\x.js' }, 'allow', D.app],
    ['Read', { file_path: D.app.replace(/\\/g, '/') + '/src/x.js' }, 'allow'],
    ['Read', { file_path: '../../../../outside/secret.txt' }, 'deny', undefined, /Outside your area: .*outside\/secret\.txt/],
    ['Read', { file_path: path.join(D.app, '..', '..', 'outside', 'secret.txt') }, 'deny', undefined, /Outside your area/],
    ['Read', { file_path: path.join(D.app, 'src', '..', 'src', 'x.js') }, 'allow'],
    ['Write', { file_path: './sub/../ok.md', content: '' }, 'allow'],
    ['Write', { file_path: '../legal/notebook.md', content: '' }, 'deny', undefined, /Outside your area/],
  ]);
  if (WIN) {
    await table(st, [
      ['Read', { file_path: D.app.toUpperCase() + '\\SRC\\X.JS' }, 'allow'],
      ['Read', { file_path: D.app.toLowerCase().replace(/\\/g, '/') + '/src/x.js' }, 'allow'],
      ['Read', { file_path: D.outside.toUpperCase() + '\\SECRET.TXT' }, 'deny'],
    ]);
  }
});

test('files: a link inside the area that points outside it is followed (realpath)', async (t) => {
  const link = path.join(D.ws, 'escape');
  try { fs.symlinkSync(D.outside, link, 'junction'); } catch (e) { t.skip(`cannot make a link here (${e.code})`); return; }
  const st = rig(base());
  await table(st, [
    ['Read', { file_path: path.join(link, 'secret.txt') }, 'deny', undefined, /Outside your area/],
    ['Write', { file_path: path.join(link, 'new.txt'), content: '' }, 'deny', undefined, /Outside your area/],
  ]);
  fs.rmSync(link, { recursive: false, force: true });
});

test('files: a write to a read-only root, and $tokens in raw powers', async () => {
  const st = rig(base());
  await table(st, [
    ['Write', { file_path: path.join(D.app, 'src', 'x.js'), content: '2' }, 'deny', undefined, /^Outside your write area: .*x\.js \(you may read it, not change it\)/],
    ['Edit', { file_path: path.join(D.docs, 'a.md'), old_string: 'a', new_string: 'b' }, 'deny', undefined, /write area/],
    ['NotebookEdit', { notebook_path: path.join(D.app, 'n.ipynb'), new_source: '' }, 'deny'],
  ]);
  // own (unexpanded) powers work too
  const raw = rig({ read: ['$workspace', '$company'], write: ['$workspace'], tools: ['Read', 'Write'], bash: 'off', workspace: real(D.ws), companyFolders: CO });
  await table(raw, [
    ['Read', { file_path: path.join(D.docs, 'a.md') }, 'allow'],
    ['Write', { file_path: path.join(D.docs, 'a.md'), content: '' }, 'deny', undefined, /write area/],
    ['Write', { file_path: path.join(D.ws, 'a.md'), content: '' }, 'allow'],
  ]);
  // a glob root
  const g = rig(base({ read: [real(D.ws), S.normPath(real(D.app)) + '/src/*.js'] }));
  await table(g, [
    ['Read', { file_path: path.join(D.app, 'src', 'x.js') }, 'allow'],
    ['Read', { file_path: path.join(D.app, 'package.json') }, 'deny'],
  ]);
});

test('tools: not in the list, non-team mcp, never tools, agents', async () => {
  const st = rig(base());
  await table(st, [
    ['WebSearch', { query: 'x' }, 'deny', undefined, /^Not in your powers \(WebSearch\)\. If you need it, call request_access with the reason; do not try another way\.$/],
    ['mcp__team__colleague_ask', { to: 'legal' }, 'allow'],
    ['mcp__gmail__send_message', {}, 'deny', undefined, /Not in your powers \(mcp__gmail__send_message\)/],
    ['mcp__claude_ai_Gmail__send', {}, 'deny'],
    ['SendMessage', { to: 'x' }, 'deny', undefined, /never available/],
    ['CronCreate', {}, 'deny', undefined, /never available/],
    ['Agent', { prompt: 'x' }, 'deny', undefined, /subagents/],
    ['Task', { prompt: 'x' }, 'deny'],
    ['AskUserQuestion', { questions: [] }, 'allow'],
    ['TodoWrite', { todos: [] }, 'deny'],
  ]);
  st.powers = base({ agents: true });
  await table(st, [['Agent', { prompt: 'x' }, 'allow'], ['Task', { prompt: 'x' }, 'allow']]);
});

test('bash off / readonly / on', async () => {
  const st = rig(base({ tools: ['Read', 'Bash'] }));
  await table(st, [
    ['Bash', { command: 'ls' }, 'deny', undefined, /Bash is off/],
    ['PowerShell', { command: 'Get-ChildItem' }, 'deny', undefined, /Not in your powers \(PowerShell\)/],
  ]);
  st.powers = base({ tools: ['Read', 'Bash', 'PowerShell'], bash: 'readonly' });
  const appRel = path.relative(D.ws, D.app).replace(/\\/g, '/');
  await table(st, [
    ['Bash', { command: 'ls -la' }, 'allow'],
    ['Bash', { command: 'git status && git log --oneline -5 | head -3' }, 'allow'],
    ['Bash', { command: 'git diff HEAD~1 2>&1' }, 'allow'],
    ['Bash', { command: `cat ${D.app.replace(/\\/g, '/')}/src/x.js` }, 'allow'],
    ['Bash', { command: `git -C ${appRel} show HEAD` }, 'allow'],
    ['Bash', { command: 'node --test test/a.test.js' }, 'allow'],
    ['Bash', { command: 'node --version' }, 'allow'],
    ['Bash', { command: 'grep -r "a > b" .' }, 'allow'],
    ['PowerShell', { command: 'Get-ChildItem | Select-Object Name' }, 'allow'],
    ['PowerShell', { command: 'Get-Content notebook.md' }, 'allow'],
    ['Bash', { command: 'rm -rf build' }, 'deny', undefined, /Your Bash is read-only, and this command is not: rm is not on the read-only list/],
    ['Bash', { command: 'ls > out.txt' }, 'deny', undefined, /writes to a file/],
    ['Bash', { command: 'echo hi >> notes.md' }, 'deny', undefined, /writes to a file/],
    ['Bash', { command: 'git commit -m x' }, 'deny', undefined, /git commit is not a read-only git command/],
    ['Bash', { command: 'git -c core.pager=sh log' }, 'deny'],
    ['Bash', { command: 'git branch -D main' }, 'deny'],
    ['Bash', { command: 'find . -delete' }, 'deny', undefined, /find may not/],
    ['Bash', { command: 'node script.js' }, 'deny'],
    ['Bash', { command: 'cat $HOME/.ssh/id_rsa' }, 'deny', undefined, /variable/],
    ['Bash', { command: `cat ${D.outside.replace(/\\/g, '/')}/secret.txt` }, 'deny', undefined, /reads outside your area/],
    ['Bash', { command: 'cd ../../../../outside && cat secret.txt' }, 'deny', undefined, /reads outside your area/],
    ['Bash', { command: 'ls | xargs rm' }, 'deny', undefined, /rm is not/],
    ['Bash', { command: 'bash -c "ls"' }, 'deny'],
    ['PowerShell', { command: 'gci | % { Remove-Item $_ }' }, 'deny', undefined, /remove-item|Remove-Item/],
    ['PowerShell', { command: 'Set-Content a.txt hi' }, 'deny'],
    ['Bash', { command: 'git push' }, 'deny', undefined, /read-only/],
  ]);
  st.powers = base({ tools: ['Read', 'Bash'], bash: 'on', write: [real(D.ws)] });
  await table(st, [
    ['Bash', { command: 'npm test && node build.js > out.txt' }, 'allow'],
    ['Bash', { command: 'git commit -am "wip"' }, 'allow'],
    ['Bash', { command: 'rm -rf build' }, 'allow'],
    ['Bash', { command: 'curl https://example.com/data.json' }, 'allow'],
    ['Bash', { command: `rm -rf ${D.app.replace(/\\/g, '/')}/src` }, 'deny', undefined, /^Outside your write area: .*\/src/],
    ['Bash', { command: `cp notebook.md ${D.outside.replace(/\\/g, '/')}/copy.md` }, 'deny', undefined, /Outside your write area/],
    ['Bash', { command: `cp ${D.app.replace(/\\/g, '/')}/src/x.js ./x.js` }, 'allow'],                 // copying FROM a read root is fine
    ['Bash', { command: `echo x > ${D.outside.replace(/\\/g, '/')}/o.txt` }, 'deny', undefined, /Outside your write area/],
  ]);
  assert.equal(st.asked.length, 0, 'nothing above is outward');
});

test('outward commands ask the owner; a once-approval is used exactly once; never always', async () => {
  const st = rig(base({ tools: ['Read', 'Bash', 'PowerShell'], bash: 'on' }));
  const outward = [
    ['Bash', 'git push origin main', /git push/],
    ['Bash', 'git add . && git commit -m x && git push', /git push/],
    ['Bash', 'npm publish --access public', /npm publish/],
    ['Bash', 'pnpm publish', /pnpm publish/],
    ['Bash', 'curl -X POST https://api.example.com/x -d "{}"', /curl POST/],
    ['Bash', 'curl --data "a=1" https://example.com', /curl with a body/],
    ['Bash', 'gh issue create --title x --body y', /gh issue create/],
    ['Bash', 'gh pr create --fill', /gh pr create/],
    ['Bash', 'gh release create v1.0.0', /gh/],
    ['Bash', 'gh api -X POST repos/o/r/issues', /gh api POST/],
    ['Bash', 'railway up', /railway|Railway/],
    ['Bash', 'echo hi | sendmail someone@example.com', /mail/],
    ['Bash', 'bash -c "npm publish"', /npm publish/],
    ['PowerShell', 'Invoke-RestMethod -Uri https://x.example/api -Method Post -Body $b', /POST/],
    ['PowerShell', 'Invoke-WebRequest https://x.example -Method PUT', /PUT/],
    ['PowerShell', 'Send-MailMessage -To a@example.com -Subject s', /mail/],
  ];
  for (const [tool, command, re] of outward) {
    const before = st.asked.length;
    const r = await st.call(tool, { command });
    assert.ok(r.deny, `${command}: denied when the owner says no`);
    assert.match(r.deny, /The owner declined this outward action/, command);
    assert.equal(st.asked.length, before + 1, `${command}: asked the owner once`);
    const req = st.asked[st.asked.length - 1];
    assert.equal(req.kind, 'outward');
    assert.equal(req.sessionId, 's1');
    assert.equal(req.command, command);
    assert.match(req.what.join(' | '), re, command);
  }
  // not outward
  for (const command of ['git fetch', 'gh pr view 12', 'gh issue list', 'gh api repos/o/r', 'curl -s https://example.com', 'npm install', 'git log']) {
    const before = st.asked.length;
    assert.ok((await st.call('Bash', { command })).allow, command);
    assert.equal(st.asked.length, before, `${command}: not asked`);
  }

  // the owner approves once: allowed; the next identical call asks again (outward has no "always")
  let answers = [{ decision: 'once' }, { decision: 'always' }, { decision: 'denied', note: 'not today' }];
  const ap = rig(base({ tools: ['Bash'], bash: 'on' }), { approve: () => answers.shift() });
  assert.ok((await ap.call('Bash', { command: 'npm publish' })).allow);
  assert.ok((await ap.call('Bash', { command: 'npm publish' })).allow, 'an always answer counts for this call only');
  const third = await ap.call('Bash', { command: 'npm publish' });
  assert.match(third.deny, /Note from the owner: "not today"/);
  assert.equal(ap.asked.length, 3, 'every outward call asked');

  // a once-grant (request_access kind outward) is consumed exactly once, with no card
  const g = rig(base({ tools: ['Bash'], bash: 'on' }), { grants: [{ kind: 'outward', target: 'git  push origin main' }] });
  assert.ok((await g.call('Bash', { command: 'git push origin main' })).allow, 'the grant covers the first push');
  assert.equal(g.asked.length, 0, 'no card while a grant covered it');
  assert.equal(g.grants.length, 0, 'the grant is used up');
  assert.ok((await g.call('Bash', { command: 'git push origin main' })).deny, 'the second push asks (and is declined)');
  assert.equal(g.asked.length, 1);
});

test('once-grants for paths, tools and bash: used exactly once and never on an allowed call', async () => {
  const secret = path.join(D.outside, 'secret.txt');
  const st = rig(base({ tools: ['Read'] }), { grants: [
    { kind: 'read', target: S.normPath(D.outside) },
    { kind: 'tool', target: 'WebSearch' },
    { kind: 'bash', target: 'bash:readonly' },
  ] });
  assert.ok((await st.call('Read', { file_path: path.join(D.ws, 'a.md') })).allow);
  assert.equal(st.grants.length, 3, 'an allowed call spends no grant');
  assert.ok((await st.call('Read', { file_path: secret })).allow);
  assert.ok((await st.call('Read', { file_path: secret })).deny, 'the read grant was used up');
  assert.ok((await st.call('WebSearch', { query: 'x' })).allow);
  assert.ok((await st.call('WebSearch', { query: 'x' })).deny);
  assert.ok((await st.call('Bash', { command: 'ls' })).allow);
  assert.ok((await st.call('Bash', { command: 'ls' })).deny);
  assert.equal(st.grants.length, 0);
  // a write grant does not unlock other folders; a permanent grant (powers changed) applies at once
  st.grants.push({ kind: 'write', target: S.normPath(path.join(D.app, 'src')) });
  assert.ok((await st.call('Write', { file_path: path.join(D.docs, 'a.md'), content: '' })).deny);
  assert.equal(st.grants.length, 1);
  st.powers = base({ tools: ['Read'], read: [...base().read, S.normPath(D.outside)] });
  assert.ok((await st.call('Read', { file_path: secret })).allow, 'powers are read live on every call');
  assert.ok((await st.call('Read', { file_path: secret })).allow);
});

test('a report\'s powers are clipped by its manager (tree.js effective)', async () => {
  const pos = (id, parent, powers) => {
    const v = S.validatePosition({ id, name: id, remit: `${id} things`, parent, version: 1, powers });
    assert.ok(v.ok, v.errors && v.errors.join('; '));
    return v.value;
  };
  const appN = real(D.app), docsN = real(D.docs);
  const tree = createTree([
    pos('legal', null, { read: ['$workspace', docsN], write: ['$workspace'], tools: ['Read', 'Grep'], bash: 'readonly', agents: false, worktree: false }),
    pos('tax', 'legal', { read: ['$workspace', '$company'], write: ['$workspace', docsN], tools: ['Read', 'Grep', 'Write', 'Bash'], bash: 'on', agents: false, worktree: false }),
  ]);
  const ctx = { companyFolders: CO, workspaceOf: (id) => (id === 'tax' ? real(D.ws) : S.normPath(path.join(ROOT, 'team', 'acme', 'positions', id))) };
  const st = rig(null);
  st.powers = tree.effective('tax', ctx);
  await table(st, [
    ['Read', { file_path: path.join(D.docs, 'a.md') }, 'allow'],
    ['Read', { file_path: path.join(appN, 'src', 'x.js') }, 'deny', undefined, /Outside your area/], // $company cut to legal's docs
    ['Write', { file_path: path.join(D.docs, 'a.md'), content: '' }, 'deny', undefined, /Not in your powers \(Write\)/], // legal has no Write
    ['Bash', { command: 'ls' }, 'allow'],                                                            // bash min(on, readonly)
    ['Bash', { command: 'touch a' }, 'deny', undefined, /read-only/],
  ]);
});

test('worktree positions: the worktree is the write area; the live checkout is read-only', async () => {
  const liveN = real(D.live), wtN = real(D.wt);
  const powers = base({ read: [real(D.ws), liveN], write: [real(D.ws), liveN], tools: ['Read', 'Write', 'Edit', 'Bash'], bash: 'on', worktree: true, worktreePath: wtN });
  const st = rig(powers);
  await table(st, [
    ['Write', { file_path: path.join(D.wt, 'src', 'a.js'), content: '' }, 'allow', D.wt],
    ['Edit', { file_path: 'src/a.js', old_string: 'a', new_string: 'b' }, 'allow', D.wt],
    ['Read', { file_path: path.join(D.live, 'README.md') }, 'allow', D.wt],
    ['Read', { file_path: path.join(D.wt, 'README.md') }, 'allow', D.wt],
    ['Write', { file_path: path.join(D.live, 'src', 'a.js'), content: '' }, 'deny', D.wt, /^You work in your own worktree at .*wt; the live folder is read-only for you/],
    ['Bash', { command: `rm ${D.live.replace(/\\/g, '/')}/README.md` }, 'deny', D.wt, /You work in your own worktree/],
    ['Bash', { command: 'rm -f src/old.js' }, 'allow', D.wt],
  ]);
  // the live folder from worktreeOf (explicit) is honoured too, and a grant cannot reopen it
  const g = rig({ ...powers, worktreePath: undefined, worktree: { path: wtN, of: liveN } }, { grants: [{ kind: 'write', target: liveN }] });
  assert.match((await g.call('Write', { file_path: path.join(D.live, 'a.js'), content: '' }, D.wt)).deny, /worktree/);
  assert.equal(g.grants.length, 1, 'the worktree rule is not a grant question');
});

test('internal errors deny, never throw', async () => {
  const boom = guard.createHook({ getEffectivePowers: () => { throw new Error('store offline'); } });
  const r = await boom.hooks[0]({ tool_name: 'Read', tool_input: { file_path: 'x' }, cwd: D.ws }, 't', {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(r.hookSpecificOutput.permissionDecisionReason, 'Helm could not check this call (store offline); denied to be safe.');
  const asyncBoom = guard.createHook({ getEffectivePowers: async () => { throw new Error('x'); } });
  assert.equal((await asyncBoom.hooks[0]({ tool_name: 'Bash', tool_input: { command: 'ls' } }, 't', {})).hookSpecificOutput.permissionDecision, 'deny');
  const none = guard.createHook({ getEffectivePowers: () => null });
  assert.match((await none.hooks[0]({ tool_name: 'Read', tool_input: { file_path: 'x' }, cwd: D.ws }, 't', {})).hookSpecificOutput.permissionDecisionReason, /^Helm could not check this call/);
  const noDeps = guard.createHook({});
  assert.equal((await noDeps.hooks[0]({ tool_name: 'Read', tool_input: {} }, 't', {})).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await noDeps.hooks[0](null, 't', {})).hookSpecificOutput.permissionDecision, 'deny');
  const badGrant = rig(base(), {});
  badGrant.grants = null; // consumeGrant throws on .findIndex
  assert.match((await badGrant.call('Read', { file_path: path.join(D.outside, 'secret.txt') })).deny, /^Helm could not check this call/);
  const badAsk = guard.createHook({ getEffectivePowers: () => base({ tools: ['Bash'], bash: 'on' }), requestApproval: () => { throw new Error('no window'); } });
  assert.match((await badAsk.hooks[0]({ tool_name: 'Bash', tool_input: { command: 'npm publish' }, cwd: D.ws }, 't', {})).hookSpecificOutput.permissionDecisionReason, /could not ask the owner/);
});

test('outward approval: no answer in time and a stopped turn both deny', async () => {
  const hang = guard.createHook({ getEffectivePowers: () => base({ tools: ['Bash'], bash: 'on' }), requestApproval: () => new Promise(() => {}), waitMs: 30 });
  const r = await hang.hooks[0]({ tool_name: 'Bash', tool_input: { command: 'npm publish' }, cwd: D.ws }, 't', {});
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /did not answer/);
  const ac = new AbortController();
  const stop = guard.createHook({ getEffectivePowers: () => base({ tools: ['Bash'], bash: 'on' }), requestApproval: () => { setTimeout(() => ac.abort(), 5); return new Promise(() => {}); }, waitMs: 60000 });
  const s = await stop.hooks[0]({ tool_name: 'Bash', tool_input: { command: 'npm publish' }, cwd: D.ws }, 't', { signal: ac.signal });
  assert.match(s.hookSpecificOutput.permissionDecisionReason, /stopped before the owner answered/);
});

test('handedReads: handed files and folders are readable for the call, never writable', async () => {
  const handedFile = path.join(D.outside, 'secret.txt');
  let handed = [handedFile.replace(/\\/g, '/')];
  const st = { logs: [] };
  const { hooks } = guard.createHook({
    sessionId: 's1', getEffectivePowers: () => base({ tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'] }),
    handedReads: (sid) => (sid === 's1' ? handed : []), log: (l, m) => st.logs.push(m), home: ROOT,
  });
  const call = async (tool_name, tool_input) => {
    const o = ((await hooks[0]({ tool_name, tool_input, cwd: D.ws }, 't', {})) || {}).hookSpecificOutput;
    return o && o.permissionDecision === 'deny' ? { deny: o.permissionDecisionReason } : { allow: true };
  };
  assert.ok((await call('Read', { file_path: handedFile })).allow, 'a handed file is readable');
  assert.match((await call('Write', { file_path: handedFile, content: 'x' })).deny, /Outside your write area|Outside your area/);
  assert.match((await call('Edit', { file_path: handedFile, old_string: 's', new_string: 't' })).deny, /Outside/);
  assert.ok((await call('Read', { file_path: path.join(D.live, 'x') })).deny, 'not handed: still outside');
  handed = [D.outside]; // a folder (native separators) brings what is inside it
  assert.ok((await call('Grep', { pattern: 'x', path: D.outside })).allow);
  assert.ok((await call('Read', { file_path: handedFile })).allow);
  handed = ['relative/path', 42, null];
  assert.ok((await call('Read', { file_path: handedFile })).deny, 'non-absolute entries are dropped');
  const boom = guard.createHook({ sessionId: 's1', getEffectivePowers: () => base(), handedReads: () => { throw new Error('gone'); }, home: ROOT });
  const r = await boom.hooks[0]({ tool_name: 'Read', tool_input: { file_path: path.join(D.ws, 'brief.md') }, cwd: D.ws }, 't', {});
  assert.equal(r.hookSpecificOutput, undefined, 'a handedReads failure hands nothing but does not deny the in-powers call');
  const r2 = await boom.hooks[0]({ tool_name: 'Read', tool_input: { file_path: handedFile }, cwd: D.ws }, 't', {});
  assert.equal(r2.hookSpecificOutput.permissionDecision, 'deny');
  // readonly Bash may read a handed path too
  const sh = guard.createHook({ sessionId: 's1', getEffectivePowers: () => base({ bash: 'readonly' }), handedReads: () => [handedFile], home: ROOT });
  const c = await sh.hooks[0]({ tool_name: 'Bash', tool_input: { command: `cat "${handedFile.replace(/\\/g, '/')}"` }, cwd: D.ws }, 't', {});
  assert.equal(c.hookSpecificOutput, undefined, 'cat of a handed file under readonly bash');
});

test('noteOwnWrite: fires after an allowed write to the own notebook only', async () => {
  const seen = [];
  let throwIt = false;
  const { hooks } = guard.createHook({
    sessionId: 's1', getEffectivePowers: () => base({ tools: ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'], write: [real(D.ws), real(D.app)] }),
    noteOwnWrite: (sid, p) => { seen.push([sid, p]); if (throwIt) throw new Error('boom'); }, home: ROOT,
  });
  const call = async (tool_name, tool_input, cwd = D.ws) => {
    const o = ((await hooks[0]({ tool_name, tool_input, cwd }, 't', {})) || {}).hookSpecificOutput;
    return o && o.permissionDecision === 'deny' ? { deny: o.permissionDecisionReason } : { allow: true };
  };
  const nb = path.join(D.ws, 'notebook.md');
  assert.ok((await call('Edit', { file_path: nb, old_string: 'a', new_string: 'b' })).allow);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 's1');
  assert.equal(S.pathKey(seen[0][1]), S.pathKey(S.normPath(path.join(real(D.ws), 'notebook.md'))));
  assert.ok((await call('Write', { file_path: 'notebook.md', content: 'x' })).allow, 'relative to cwd');
  assert.equal(seen.length, 2);
  if (WIN) {
    assert.ok((await call('MultiEdit', { file_path: nb.toUpperCase(), edits: [] })).allow);
    assert.equal(seen.length, 3, 'case-insensitive on Windows');
  }
  const n = seen.length;
  assert.ok((await call('Read', { file_path: nb })).allow);
  assert.ok((await call('Write', { file_path: path.join(D.ws, 'notes.md'), content: 'x' })).allow);
  assert.ok((await call('Write', { file_path: path.join(D.ws, 'brief.md'), content: 'x' })).deny, 'a definition file is never writable (fix 1)');
  assert.ok((await call('Write', { file_path: path.join(D.app, 'notebook.md'), content: 'x' })).allow);
  assert.ok((await call('Write', { file_path: path.join(D.ws, 'sub', 'notebook.md'), content: 'x' })).allow);
  assert.ok((await call('Write', { file_path: path.join(D.outside, 'notebook.md'), content: 'x' })).deny);
  assert.equal(seen.length, n, 'reads, other files, other notebooks and denied writes do not fire');
  throwIt = true;
  assert.ok((await call('Edit', { file_path: nb, old_string: 'a', new_string: 'b' })).allow, 'a throwing noteOwnWrite never changes the decision');
  assert.equal(seen.length, n + 1);
  const rej = guard.createHook({ sessionId: 's1', getEffectivePowers: () => base(), noteOwnWrite: async () => { throw new Error('async boom'); }, home: ROOT });
  const r = await rej.hooks[0]({ tool_name: 'Write', tool_input: { file_path: nb, content: 'x' }, cwd: D.ws }, 't', {});
  assert.equal(r.hookSpecificOutput, undefined);
});

test('owner name: outward denials and log lines use ownerName (string or getter, read per call); empty reads the owner', async () => {
  let name = 'Jordan';
  const logs = [];
  const mk = (approve) => guard.createHook({ getEffectivePowers: () => base({ tools: ['Bash'], bash: 'on' }), requestApproval: approve,
    ownerName: () => name, log: (l, m) => logs.push(m), waitMs: 30 });
  const call = async (h) => (await h.hooks[0]({ tool_name: 'Bash', tool_input: { command: 'npm publish' }, cwd: D.ws }, 't', {})).hookSpecificOutput.permissionDecisionReason;
  const no = mk(async () => ({ behavior: 'deny', message: 'Not now.' }));
  assert.match(await call(no), /^Jordan declined this outward action \(npm publish\)\..* Note from Jordan: "Not now\."$/);
  assert.ok(logs.some((m) => /asking Jordan: /.test(m)) && logs.some((m) => /Jordan declined/.test(m)));
  assert.match(await call(mk(() => new Promise(() => {}))), /^Jordan did not answer the outward approval/);
  name = '';
  assert.match(await call(no), /^The owner declined this outward action .* Note from the owner: "Not now\."$/);
  assert.match(await call(mk(() => { throw new Error('no window'); })), /could not ask the owner about this outward action/);
});
