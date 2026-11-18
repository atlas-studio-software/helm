// Positions review fixes, guard / options / schema lane (main/engine/team/guard.js, options.js, schema.js).
// Fix 1: a position never changes its own (or another position's) definition: position.json (+ .v<N> copies),
// brief.md and chats.json, though its folder is its always-writable workspace. notebook.md stays its own.
// Fix 7: a position's claude.exe gets a minimal environment (an allowlist; tokens and keys dropped).
// Fix 10: a company folder may not be the home folder or a folder above it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../../main/engine/team/schema');
const guard = require('../../main/engine/team/guard');
const O = require('../../main/engine/team/options');

const WIN = process.platform === 'win32';
const real = (p) => S.normPath(fs.realpathSync.native(p));

// ROOT/team/acme/positions/{tax,ceo2}  ROOT/team/acme/retired/old  ROOT/team/beta/positions/ops  ROOT/proj
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'team-fix-guard-'));
const TEAM = path.join(ROOT, 'team');
const P = {
  tax: path.join(TEAM, 'acme', 'positions', 'tax'), ceo2: path.join(TEAM, 'acme', 'positions', 'ceo2'),
  old: path.join(TEAM, 'acme', 'retired', 'old'), ops: path.join(TEAM, 'beta', 'positions', 'ops'),
};
const PROJ = path.join(ROOT, 'proj');
for (const d of [...Object.values(P), PROJ]) {
  fs.mkdirSync(d, { recursive: true });
  for (const f of ['position.json', 'position.json.v3', 'brief.md', 'chats.json', 'notebook.md']) fs.writeFileSync(path.join(d, f), 'x');
}
test.after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

// The tax position may write its own folder, the other positions' folders and the whole team root (as a wide
// grant would), so every deny below is the definition rule, not the area rule.
const powers = (over = {}) => ({
  read: [real(ROOT)], write: [real(P.tax), real(TEAM), real(PROJ)],
  tools: ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'PowerShell'], bash: 'on', agents: false,
  workspace: real(P.tax), ...over,
});

function rig(pw = powers(), extra = {}) {
  const st = { grants: [], used: 0 };
  const { hooks } = guard.createHook({
    sessionId: 's1', getEffectivePowers: () => pw, home: ROOT,
    consumeGrant: (sid, need) => { st.used++; const i = st.grants.findIndex((g) => need.matches(g)); return i < 0 ? null : st.grants.splice(i, 1)[0]; },
    ...extra,
  });
  st.call = async (tool_name, tool_input, cwd = P.tax) => {
    const o = ((await hooks[0]({ tool_name, tool_input, cwd }, 't', {})) || {}).hookSpecificOutput;
    return o && o.permissionDecision === 'deny' ? { deny: o.permissionDecisionReason } : { allow: true };
  };
  return st;
}
const DEF = /part of a position's definition/;

async function expect(st, rows) {
  for (const [tool, input, want, cwd] of rows) {
    const r = await st.call(tool, input, cwd);
    const label = `${tool} ${JSON.stringify(input)}`;
    if (want === 'allow') assert.ok(r.allow, `${label}: expected allow, got: ${r.deny}`);
    else assert.match(r.deny || '', DEF, `${label}: expected the definition deny, got ${r.deny || 'allow'}`);
  }
}

test('fix 1: write tools are denied on every definition file of every position; notebook.md and other files stay writable', async () => {
  const st = rig();
  const rows = [];
  for (const dir of Object.values(P)) {
    for (const f of ['position.json', 'position.json.v3', 'position.json.v12', 'brief.md', 'chats.json']) {
      rows.push(['Write', { file_path: path.join(dir, f), content: 'x' }, 'deny']);
      rows.push(['Edit', { file_path: path.join(dir, f), old_string: 'x', new_string: 'y' }, 'deny']);
    }
  }
  rows.push(
    ['MultiEdit', { file_path: path.join(P.tax, 'brief.md'), edits: [] }, 'deny'],
    ['NotebookEdit', { notebook_path: path.join(P.tax, 'chats.json'), new_source: 'x' }, 'deny'],
    ['Write', { file_path: path.join(P.tax, 'notebook.md'), content: 'x' }, 'allow'],
    ['Edit', { file_path: path.join(P.tax, 'notebook.md'), old_string: 'x', new_string: 'y' }, 'allow'],
    ['Write', { file_path: path.join(P.tax, 'drafts', 'brief.md'), content: 'x' }, 'allow'],      // deeper: not a definition
    ['Write', { file_path: path.join(P.tax, 'worktree', 'position.json'), content: 'x' }, 'allow'],
    ['Write', { file_path: path.join(PROJ, 'brief.md'), content: 'x' }, 'allow'],                 // a project's own brief.md
    ['Write', { file_path: path.join(P.tax, 'brief.md.bak'), content: 'x' }, 'allow'],
    ['Write', { file_path: path.join(P.tax, 'position.json.vx'), content: 'x' }, 'allow'],
    ['Read', { file_path: path.join(P.tax, 'brief.md') }, 'allow'],                                 // reads stay
    ['Read', { file_path: path.join(P.ceo2, 'position.json') }, 'allow'],
  );
  await expect(st, rows);
});

test('fix 1: the path match survives relative paths, .., slash styles, case, trailing dots and stream names', async () => {
  const st = rig();
  const fwd = (p) => p.replace(/\\/g, '/');
  const rows = [
    ['Write', { file_path: 'brief.md', content: 'x' }, 'deny'],
    ['Write', { file_path: './chats.json', content: 'x' }, 'deny'],
    ['Write', { file_path: '../ceo2/position.json', content: 'x' }, 'deny'],
    ['Write', { file_path: '../../../beta/positions/ops/brief.md', content: 'x' }, 'deny'],
    ['Write', { file_path: 'drafts/../brief.md', content: 'x' }, 'deny'],
    ['Write', { file_path: fwd(path.join(P.tax, 'brief.md')), content: 'x' }, 'deny'],
    ['Write', { file_path: path.join(P.tax, 'sub', '..', 'brief.md').replace(/\//g, '\\'), content: 'x' }, 'deny'],
    ['Write', { file_path: 'brief.md', content: 'x' }, 'deny', path.join(P.tax, 'drafts', '..')],
  ];
  if (WIN) {
    rows.push(
      ['Write', { file_path: path.join(P.tax, 'BRIEF.MD'), content: 'x' }, 'deny'],
      ['Write', { file_path: path.join(P.tax.toUpperCase(), 'Position.Json'), content: 'x' }, 'deny'],
      ['Write', { file_path: path.join(P.tax, 'brief.md.'), content: 'x' }, 'deny'],
      ['Write', { file_path: path.join(P.tax, 'brief.md. .'), content: 'x' }, 'deny'],
      ['Write', { file_path: path.join(P.tax, 'brief.md::$DATA'), content: 'x' }, 'deny'],
      ['Write', { file_path: path.join(P.tax, 'chats.json:alt'), content: 'x' }, 'deny'],
    );
  }
  await expect(st, rows);
});

test('fix 1: a symlink or junction in the workspace that points at another position is followed', async (t) => {
  const link = path.join(P.tax, 'peer');
  try { fs.symlinkSync(P.ceo2, link, 'junction'); } catch (e) { t.skip(`no junction: ${e.code}`); return; }
  const st = rig();
  await expect(st, [
    ['Write', { file_path: path.join(link, 'brief.md'), content: 'x' }, 'deny'],
    ['Write', { file_path: 'peer/position.json', content: 'x' }, 'deny'],
    ['Write', { file_path: 'peer/notebook.md', content: 'x' }, 'allow'], // the area rule decides that one (team root is writable here)
  ]);
});

test('fix 1: no write or once-grant unlocks a definition file, and no grant is spent on it', async () => {
  const st = rig(powers({ write: [real(P.tax)] }));
  st.grants.push({ kind: 'write', target: real(P.ceo2) }, { kind: 'bash', target: 'bash:on' });
  const r = await st.call('Write', { file_path: path.join(P.ceo2, 'brief.md'), content: 'x' });
  assert.match(r.deny, DEF);
  const r2 = await st.call('Bash', { command: 'echo x > brief.md' });
  assert.match(r2.deny, DEF);
  assert.equal(st.grants.length, 2, 'both grants still there');
  assert.equal(st.used, 0, 'consumeGrant was never asked');
});

test('fix 1: the team root comes from deps.teamRoot when the workspace is not under positions/', async () => {
  const ws = path.join(ROOT, 'elsewhere-ws');
  fs.mkdirSync(ws, { recursive: true });
  const st = rig(powers({ workspace: real(ws), write: [real(ws), real(TEAM)] }), { teamRoot: TEAM });
  await expect(st, [
    ['Write', { file_path: path.join(ws, 'brief.md'), content: 'x' }, 'deny'],   // its own folder, whatever its parent
    ['Write', { file_path: path.join(P.ops, 'chats.json'), content: 'x' }, 'deny'],
    ['Write', { file_path: path.join(ws, 'notebook.md'), content: 'x' }, 'allow'],
  ]);
});

test('fix 1: shell commands that write, delete, move, copy over or link a definition file are denied (Bash and PowerShell)', async () => {
  const st = rig();
  const bash = (command, want, cwd) => ['Bash', { command }, want, cwd];
  const ps = (command, want, cwd) => ['PowerShell', { command }, want, cwd];
  await expect(st, [
    // redirects
    bash('echo x > brief.md', 'deny'), bash('echo x >> chats.json', 'deny'), bash('echo x 2> position.json', 'deny'),
    bash('echo x &> position.json.v4', 'deny'), bash('ls > out.txt; echo x >brief.md', 'deny'),
    bash('echo x > ../ceo2/brief.md', 'deny'), bash('cd ../ceo2 && echo x > brief.md', 'deny'),
    bash(`echo x > "${P.ops.replace(/\\/g, '/')}/position.json"`, 'deny'),
    bash('echo x > "$PWD/brief.md"', 'deny'), bash('echo x > $(pwd)/chats.json', 'deny'),
    bash('bash -c "echo x > brief.md"', 'deny'), bash('sh -c \'cat a >> chats.json\'', 'deny'),
    bash('cmd /c "echo x > brief.md"', 'deny'), bash('powershell -Command "Set-Content brief.md x"', 'deny'),
    // write / delete / move / link commands
    bash('tee brief.md < x', 'deny'), bash('echo x | tee -a chats.json', 'deny'), bash('touch position.json', 'deny'),
    bash('truncate -s0 brief.md', 'deny'), bash('chmod 444 brief.md', 'deny'), bash('rm brief.md', 'deny'),
    bash('rm -f position.json.v3', 'deny'), bash('mv brief.md brief.old', 'deny'), bash('mv draft.md brief.md', 'deny'),
    bash('rm -rf .', 'deny'), bash(`rm -rf "${P.tax.replace(/\\/g, '/')}"`, 'deny'), bash('rm -rf ../ceo2', 'deny'),
    bash('rm -rf ../*', 'deny'), bash('rm -f *', 'deny'), bash('rm -f *.json', 'deny'), bash('rm brief.*', 'deny'),
    bash('mv ../ceo2 /tmp/x', 'deny'), bash('cp new.md brief.md', 'deny'), bash('cp ../ceo2/brief.md .', 'deny'),
    bash('cp -t . ../ceo2/chats.json', 'deny'), bash('cp x.md --target-directory=. brief.md', 'deny'),
    bash('ln brief.md hard', 'deny'), bash('ln -s ../ceo2/brief.md mine.md', 'deny'), bash('cmd /c mklink /H h.md brief.md', 'deny'),
    bash('fsutil hardlink create h.md brief.md', 'deny'), bash('sed -i s/a/b/ brief.md', 'deny'),
    bash('sed --in-place=.bak s/a/b/ chats.json', 'deny'), bash('perl -pi -e s/a/b/ brief.md', 'deny'),
    bash('dd if=/dev/zero of=brief.md count=1', 'deny'), bash('robocopy ../ceo2 . brief.md', 'deny'), bash('robocopy ../ceo2 . /MIR', 'deny'),
    ps('Set-Content -Path brief.md -Value x', 'deny'), ps('Add-Content chats.json "x"', 'deny'), ps('"x" | Out-File -FilePath position.json', 'deny'),
    ps('Clear-Content brief.md', 'deny'), ps('Remove-Item -Recurse -Force .', 'deny'), ps('Remove-Item ..\\ceo2\\brief.md', 'deny'),
    ps('Move-Item brief.md x.md', 'deny'), ps('Rename-Item chats.json c.json', 'deny'), ps('Copy-Item x.md -Destination brief.md', 'deny'),
    ps('Copy-Item -Path ..\\ceo2\\brief.md -Destination .', 'deny'), ps('New-Item -ItemType HardLink -Path h.md -Target brief.md', 'deny'),
    ps('New-Item brief.md -Force', 'deny'), ps('Set-ItemProperty brief.md -Name IsReadOnly -Value $true', 'deny'),
    ps("[IO.File]::WriteAllText('brief.md', 'x')", 'deny'), ps('[System.IO.File]::Delete("chats.json")', 'deny'),
    ps('"x" > BRIEF.MD', WIN ? 'deny' : 'allow'), ps('icacls brief.md /deny Everyone:W', 'deny'),
    // reads and other files: allowed
    bash('cat brief.md'), bash('head -5 position.json; wc -l chats.json'), bash('grep -n x brief.md > found.txt'),
    bash('cp brief.md brief-copy.md'), bash('cp brief.md ../../../proj/'), bash('sed s/a/b/ brief.md > new.md'),
    bash('echo x > notebook.md'), bash('echo x >> notes/brief-ideas.md'), bash('rm -f *.tmp'), bash('rm -rf drafts'),
    bash('mv drafts/a.md drafts/b.md'), bash('cat brief.md | tee copy.md'), bash('diff brief.md ../ceo2/brief.md'),
    bash('echo x > /dev/null 2>&1'), bash(`echo x > "${PROJ.replace(/\\/g, '/')}/brief.md"`), bash('git log > log.txt'),
    ps('Get-Content brief.md'), ps('Set-Content -Path notes.md -Value brief.md'), ps('Copy-Item brief.md -Destination backup.md'),
    ps('Get-Content position.json | ConvertFrom-Json'), ps('Select-String x brief.md > hits.txt'),
    bash('robocopy . ../../../proj notes.md'),
    // moves: the sources are removals, the destination is checked like a copy (moving INTO the folder is fine)
    bash('mv drafts/a.md .'), bash('mv a.md drafts/'), bash('mv -t drafts a.md b.md'), ps('Move-Item drafts\\a.md -Destination .'),
    ps('Rename-Item a.md -NewName b.md'),
    bash('mv ../ceo2/brief.md .', 'deny'), bash('mv -t . ../ceo2/chats.json', 'deny'), ps('Rename-Item a.md -NewName brief.md', 'deny'),
    ps('Move-Item -Path . -Destination ..\\x', 'deny'),
  ].map(([t, i, w, c]) => [t, i, w || 'allow', c]));
});

test('fix 1: a read-only shell is refused with the definition reason first (no bash:on grant spent)', async () => {
  const st = rig(powers({ bash: 'readonly' }));
  st.grants.push({ kind: 'bash', target: 'bash:on' });
  const r = await st.call('Bash', { command: 'echo x > brief.md' });
  assert.match(r.deny, DEF);
  assert.equal(st.grants.length, 1);
  assert.ok((await st.call('Bash', { command: 'cat brief.md' })).allow);
});

test('fix 1: the deny reason is plain and names the file', async () => {
  const st = rig();
  const r = await st.call('Write', { file_path: path.join(P.tax, 'brief.md'), content: 'x' });
  assert.ok(r.deny.includes(real(path.join(P.tax, 'brief.md'))) || r.deny.toLowerCase().includes('brief.md'));
  assert.match(r.deny, /only the owner and Helm's approval flow/);
  assert.match(r.deny, /notebook\.md/);
  assert.doesNotMatch(r.deny, /request_access/, 'no grant can unlock it, so the reason does not offer one');
});

// ---------------------------------------------------------------- fix 7: a minimal env for a position's CLI

test('fix 7: positionEnv keeps an allowlist: OS, folders, locale, proxy, TLS and the CLI settings', () => {
  const env = O.positionEnv({
    Path: 'C:/bin', PATHEXT: '.EXE', SystemRoot: 'C:/Windows', SystemDrive: 'C:', windir: 'C:/Windows', ComSpec: 'cmd.exe',
    TEMP: 't', TMP: 't', USERPROFILE: 'u', HOME: 'h', HOMEDRIVE: 'C:', HOMEPATH: '/u', APPDATA: 'a', LOCALAPPDATA: 'l',
    ProgramData: 'pd', ProgramFiles: 'pf', 'ProgramFiles(x86)': 'pf86', ProgramW6432: 'pw', OS: 'Windows_NT',
    PROCESSOR_ARCHITECTURE: 'AMD64', NUMBER_OF_PROCESSORS: '8', PSModulePath: 'm', LANG: 'en_US.UTF-8', LC_ALL: 'C',
    TERM: 'xterm', HTTPS_PROXY: 'http://p:8080', no_proxy: 'localhost', NODE_EXTRA_CA_CERTS: 'ca.pem', XDG_CONFIG_HOME: 'x',
    CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_GIT_BASH_PATH: 'bash.exe', CLAUDE_AGENT_SDK_CLIENT_APP: 'helm/0.1.0',
    ANTHROPIC_BASE_URL: 'https://gw', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1', JAVA_HOME: 'j',
    NoDefaultCurrentDirectoryInExePath: '1',
  });
  for (const k of ['Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'HOME',
    'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'OS',
    'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'PSModulePath', 'LANG', 'LC_ALL', 'TERM', 'HTTPS_PROXY', 'no_proxy',
    'NODE_EXTRA_CA_CERTS', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_AGENT_SDK_CLIENT_APP',
    'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'JAVA_HOME', 'NoDefaultCurrentDirectoryInExePath']) {
    assert.ok(k in env, `${k} kept`);
  }
  assert.equal(env.Path, 'C:/bin', 'the original name case is kept');
  assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
});

test('fix 7: positionEnv drops tokens, keys, secrets, passwords and anything not on the list (deny wins over allow)', () => {
  const dropped = ['GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_PAT', 'NPM_TOKEN', 'npm_config_registry', 'RAILWAY_TOKEN', 'RAILWAY_API_TOKEN',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
    'ATLAS_GEMINI_KEY', 'STRIPE_SECRET_KEY', 'DATABASE_URL', 'PGPASSWORD', 'MY_PASSWORD_FILE', 'SOME_SECRET', 'X_CLIENT_SECRET',
    'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'GIT_CONFIG_PARAMETERS', 'NODE_OPTIONS', 'HELM_ADMIN', 'OneDrive', 'DISCORD_BOT_TOKEN',
    'GOOGLE_APPLICATION_CREDENTIALS', 'AZURE_CLIENT_SECRET', 'SENTRY_DSN',
    // CLI-family names that carry a secret, or the parent session's channel, are still dropped
    'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_SECRET_THING', 'ANTHROPIC_ADMIN_KEY', 'CLAUDE_CODE_CLIENT_KEY',
    'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH', 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
    'ENABLE_CLAUDEAI_MCP_SERVERS_X'];
  const base = { PATH: '/bin' };
  for (const k of dropped) base[k] = 'v';
  base.LC_SECRET_TOKEN = 'v'; // a kept prefix still loses to the deny pattern
  base.XDG_PASSWORD = 'v';
  const env = O.positionEnv(base);
  for (const k of [...dropped, 'LC_SECRET_TOKEN', 'XDG_PASSWORD']) assert.ok(!(k in env), `${k} dropped`);
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'ENABLE_CLAUDEAI_MCP_SERVERS', 'PATH']);
  for (const k of dropped) assert.equal(O.envKept(k), false, k);
  assert.equal(O.envKept('gh_token'), false, 'case-insensitive');
});

test('fix 7: sign-in carriers pass only when the base env has them (the main chats sign in the same way)', () => {
  const sub = O.positionEnv({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/cfg' });
  for (const k of O.ENV_AUTH) assert.ok(!(k in sub), `${k} is not invented`);
  assert.ok(!Object.keys(sub).some((k) => O.ENV_AUTH_RE.test(k)), 'no OAuth sign-in variable is invented');
  const api = O.positionEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'o', ANTHROPIC_AUTH_TOKEN: 'a' });
  assert.equal(api.ANTHROPIC_API_KEY, 'k');
  assert.equal(api.CLAUDE_CODE_OAUTH_REFRESH_TOKEN, 'o'); // the OAuth family (ENV_AUTH_RE)
  assert.equal(api.ANTHROPIC_AUTH_TOKEN, 'a');
});

test('fix 7: process.env is the default base, the input is not changed, and positionOptions carries the minimal env', () => {
  const base = { PATH: '/bin', GH_TOKEN: 't', CLAUDE_CODE_PLUGIN_DIRS: '/mods' };
  const env = O.positionEnv(base);
  assert.deepEqual(base, { PATH: '/bin', GH_TOKEN: 't', CLAUDE_CODE_PLUGIN_DIRS: '/mods' });
  assert.ok(!('GH_TOKEN' in env));
  const prev = process.env.HELM_FIX7_PROBE_TOKEN;
  process.env.HELM_FIX7_PROBE_TOKEN = 'x';
  try {
    const d = O.positionEnv();
    assert.ok(!Object.keys(d).some((k) => /HELM_FIX7_PROBE_TOKEN/i.test(k)));
    assert.ok(Object.keys(d).some((k) => k.toUpperCase() === 'PATH'), 'PATH from process.env');
  } finally { if (prev === undefined) delete process.env.HELM_FIX7_PROBE_TOKEN; else process.env.HELM_FIX7_PROBE_TOKEN = prev; }
});
