# Positions: AI staff for each company

Status: built (design lane positions-spec, build lanes T1 to T10, 2026-11-17/18, branch `wk/positions`). This file
is the design the build followed, kept for its reasoning. Where the shipped wire shapes differ from section 11,
`docs/PROTOCOL.md` (section "Positions") is authoritative; `docs/GUIDE.md` (section "Positions") is the user guide.
The isolation mechanism and the call mechanism were measured with the real claude.exe (sections 4 and 5.1); the
probe runner and its raw output are machine-specific, so they are kept on the
maintainer's machine, not in the repo. Isolation is re-proved on every run by `tools/team-isolation-live.js`.
This spec uses placeholder paths (`C:/Users/you/...`).

The brief, in the owner's words: "it should kindof be like positions at a real company just with different ai
sessions as the employees/positions. and it should be different for each project", and later: "it can go further
down the line then like lawyer if there is anything that would be underneath lawyer kindof just like a real company
would be... it doesnt stop at ceo". The owner's decisions (company = unit, CEO = any main session in a company
folder, routing, isolation, notebook memory, duties, cross-talk, powers, CEO-led creation, org tree of any depth)
are fixed inputs. Every other choice below is decided here and marked **Decided**; the few open questions for the
owner are in section 14.

In this file "you" and "the owner" mean the person running Helm. Examples use the fictional company in
`docs/positions.example/` (Northwind Goods, with folders `~/northwind-shop` and `~/northwind-app`).

## 0. Summary

- A **company** is a named set of folders (e.g. Northwind Goods = `~/northwind-shop`, `~/northwind-app`).
  Its **team** is an org **tree**: positions report to the CEO or to another position, to a safety cap of 5 levels.
- The **CEO** is not a stored thing: any normal Helm session whose folder is inside a company's folder is that
  company's CEO. Helm attaches one in-process MCP server (`team`) to it: the roster of its direct reports
  (name + one-line remit), plus tools to ask them, look up the log, and propose changes.
- A **position** is a Helm session with a fixed role: its own workspace folder outside every repo, its brief in the
  system prompt, its own notebook file, and NOTHING of your global setup (no `~/.claude/CLAUDE.md`, no
  `MEMORY.md`, no project CLAUDE.md, no mods, plugins, skills, hooks, user MCP servers or claude.ai connectors).
  Proven with claude.exe (section 4). The config is `settingSources: []`, a `tools` allowlist, `strictMcpConfig`,
  `CLAUDE_CODE_PLUGIN_DIRS` stripped from the env, and auto-memory off.
- **Calls** go through Helm's `team` MCP server (chosen over the CLI's SendMessage, section 5). An ask becomes a
  ticket. Helm delivers the question into the target's chat when it is free. It returns the target's final reply
  as the tool result, or "pending" after a wait budget; a late answer arrives later as a Helm message.
- **Managers** (the CEO at the root, and any position with reports) see their direct reports' roster and can ask
  them and propose new ones. Ask chains carry a shrinking time budget and a live status card, so nothing hangs
  silently.
- **Cross-talk**: any position can ask any other position in its company one narrow question. The answerer sees
  only the question, the asker only the answer. Every exchange is logged (`crosstalk.jsonl`, Team view).
- **Powers** are per position (read and write paths, tools, Bash level, never outward without your OK). Helm enforces
  them with a PreToolUse hook like prod-guard, the SDK tool list and cwd/additional dirs. A report's effective
  powers are its own powers intersected with every ancestor's. More access = `request_access`, which puts a card
  in Helm and pushes to the phone. You answer Approve once, Approve always (saved to the definition) or Deny.
- **Creation, editing and retiring** at any level is a proposal card. The CEO or a manager proposes, you and that
  session discuss it, and Helm writes the files only after you click Approve (or types a clear yes to that card).
- **Memory**: one ongoing chat per position plus `notebook.md`. At 32% context Helm rolls the position to a fresh
  chat at its next quiet moment, seeded from brief + notebook + handoff. Old chats stay listed and scrollable.
- **Duties**: schedules (cron) and events (new commit, tag or file change, detected by fs.watch on `.git` refs,
  never polling). They run in Helm's main process, not in claude.exe, catch up once after Helm was closed, and
  draft but never send.
- All data lives in a **team root** outside every repo: `~/helm-team/` (plain JSON + markdown). The code ships
  generic for open source.

## 1. Vocabulary

| term | meaning |
| --- | --- |
| company | `company.json`: id, name, folders. One team per company. |
| CEO session | any Helm session (not a position) whose cwd is inside one of the company's folders (section 3). |
| position | one role on the team: `position.json` + `brief.md` + `notebook.md` + its chats. |
| manager / reports | a position's `parent` is its manager (null = reports to the CEO). Its children are its reports. |
| depth | top-level positions are depth 1. Cap: depth 5 (**Decided**, section 6.4). |
| chat | one Claude conversation of a position. A position has one *current* chat and any number of ended ones. |
| ask / ticket | one question from a manager, the CEO or a colleague to a position. `t_<id>`, persisted until settled. |
| cross-talk | an ask between two positions that is not manager-to-report. Same machinery, logged the same way. |
| duty | a standing job of a position with a trigger (schedule or event). |
| powers | what a position may read, write and run. Enforced by Helm. |
| grant | one decision on an access request (once or always). Logged in `grants.jsonl`. |
| proposal | create / edit / retire a position (or a company) as a card you approve or decline. |

## 2. Storage

### 2.1 Where

**Decided:** one **team root**, default `~/helm-team` (Settings > Team can move it). Reasons:
- Not in Helm's source tree (Helm is being prepared for open source: the code may contain no user-specific data).
  The repo ships only `docs/positions.example/` with a placeholder company.
- Not in `%APPDATA%\Helm`: you must be able to find, read and hand-edit these files. A visible home folder is
  discoverable, and Team view has "Open folder".
- Not inside any company folder. A position's cwd must not sit under a repo with a project CLAUDE.md, and nothing
  here may be pushed by accident.
- Helm refuses a team root that is inside a git work tree (walk up for `.git`) or inside any company folder, and
  says why in Settings. It never runs `git init` there. You may back it up however you like.

Machine-only state (tickets in flight, last-seen git refs, duty due times, which chat a session is) goes in
`<userData>/team-state.json` (Helm's own folder, atomic writes like sessions.json). Losing it loses nothing you wrote.

### 2.2 Layout

```
~/helm-team/
  README.md                     written once by Helm: what every file is; safe to edit by hand
  house-rules.md                the house rules every position gets (Helm ships a default; you may edit)
  <company-id>/                 e.g. northwind-goods/
    company.json
    proposals.jsonl             every proposal and its decision (append-only)
    crosstalk.jsonl             every ask, at every level, with its answer (append-only)
    grants.jsonl                every access request and decision (append-only)
    inbox.jsonl                 duty reports and flags for you (append-only; dismissals are lines too)
    duty-runs.jsonl             every duty run: trigger, start, end, cost, result (append-only)
    positions/
      <position-id>/            e.g. legal/   (FLAT: the tree is in position.json "parent", so a re-parent moves no folder)
        position.json
        brief.md
        notebook.md
        chats.json              the chain of chats (section 8)
        work/                   drafts, research notes, outputs (writable by default)
          drafts/
    retired/
      <position-id>/            moved here on retire, unchanged (chats stay readable)
```

### 2.3 company.json

```json
{
  "id": "northwind-goods",
  "name": "Northwind Goods",
  "folders": ["C:/Users/you/northwind-shop", "C:/Users/you/northwind-app"],
  "createdAt": "2026-11-18T10:00:00Z",
  "createdBy": { "proposal": "p_1a2b", "how": "click" },
  "version": 1
}
```
Rules: ids are `[a-z0-9-]{1,40}`. A folder belongs to at most one company (validated at proposal time; nested
folders across companies are refused). Folders are stored resolved, with forward slashes, compared
case-insensitively on Windows.

### 2.4 position.json

```json
{
  "id": "tax",
  "name": "Tax Specialist",
  "parent": "legal",
  "remit": "Sales tax, VAT and income-tax questions for Northwind Goods' shop, app and payouts.",
  "scope": { "kind": "company" },
  "status": "active",
  "model": null,
  "effort": "high",
  "powers": {
    "read":  ["$workspace", "$company"],
    "write": ["$workspace"],
    "tools": ["Read", "Grep", "Glob", "Write", "Edit", "WebSearch", "WebFetch", "TodoWrite"],
    "bash": "off",
    "agents": false
  },
  "duties": [
    { "id": "quarterly-check", "title": "Quarterly tax deadlines check", "enabled": true,
      "trigger": { "kind": "schedule", "cron": "0 9 1 1,4,7,10 *", "catchUp": "once" },
      "prompt": "List tax deadlines due in the next 90 days for each product and what is needed for each.",
      "output": "report" }
  ],
  "createdAt": "2026-11-18T10:05:00Z",
  "createdBy": { "proposal": "p_9c0d", "by": "legal", "how": "click" },
  "version": 2
}
```
- `id`: slug, unique within the company (live and retired), immutable. `name` may change.
- `parent`: a live position id in the same company, or `null` (reports to the CEO).
- `scope.kind`: `company` (company-wide) or `product` (`{ "kind": "product", "folder": "C:/Users/you/northwind-app" }`).
  It decides what `$scope` means in powers and which folders event duties may watch.
- `status`: `active` | `paused` (no duties, asks refused with "paused", you can still chat) | `retired` (folder moved).
- `model`: null = Helm's default model (settings.defaults.model). `effort`: default `high`.
- `powers`: section 7. Path tokens: `$workspace` (this position's folder), `$company` (all company folders),
  `$scope` (the scope folder, or `$company` for company-wide), or absolute paths with optional `**` globs.
- `duties`: section 9.
- `version` goes up by one on every approved change. Helm writes the file atomically and keeps the previous
  version as `position.json.v<N>` (only the last 10).

### 2.5 brief.md and notebook.md

`brief.md` is free markdown written in the proposal (the "job description"): what the role covers, what it must
not do, sources it trusts, how it reports. You may edit it in Team view or any editor.

`notebook.md` starts from this template (Helm keeps the four headings; everything under them is free text):
```markdown
# Tax Specialist · notebook
## Decisions
## Facts
## Open items
## Log
```
- Decisions: what was decided, when, by whom.
- Facts: each with its source (file, URL, the owner) and date.
- Open items: `- [ ]` lines. The Team view counts the unchecked ones.
- Log: one line per notable thing done. Helm trims it to the newest 200 lines into `notebook-log-archive.md`.

### 2.6 Log line shapes (all JSONL, one object per line, UTF-8)

```js
// proposals.jsonl
{ at, id: "p_9c0d", action: "create"|"edit"|"retire"|"company", by: { kind: "ceo"|"position", id?, sessionId },
  target?: "tax", parent?: "legal", draft: { /* full position.json draft + brief */ },
  decision?: { at, how: "click"|"typed", quote?, result: "approved"|"declined"|"superseded", note? } }
// crosstalk.jsonl (one line per state change; the UI folds by ticket)
{ at, ticket: "t_4f1e", parentTicket?: "t_77aa", chain: "t_77aa", from: { kind: "ceo"|"position"|"owen", id?, sessionId },
  to: "tax", kind: "report"|"colleague", state: "asked"|"delivered"|"answered"|"pending"|"late"|"refused"|"expired"|"cancelled",
  question?, handed?: [paths], answer?, reason?, costUsd?, tookMs? }
// grants.jsonl
{ at, id: "g_..", position: "tax", request: { kind: "read"|"write"|"tool"|"bash"|"outward", target, why },
  decision: "once"|"always"|"denied"|"no-answer", savedTo?: ["tax", "legal"], note? }
// inbox.jsonl
{ at, id: "n_..", position: "marketing", kind: "duty-report"|"flag"|"proposal", title, text, files?: [paths],
  needsOwen: true, dismissedAt? }
// duty-runs.jsonl
{ at, position, duty, trigger: { kind, detail }, ticket, state: "started"|"done"|"failed"|"skipped"|"missed", reason?, costUsd? }
```
Every text field stored in a log is capped (question and answer 20k chars, like handoff.js `MAX_HANDOFF_CHARS`).
The wire names `"owen"` (an ask from the person running Helm), `needsOwen` and the tool argument `needs_owen` are
identifiers in the code; they mean you, whoever runs Helm.

## 3. Recognising the CEO

**Decided:**
- `team/match.js` `companyFor(cwd)`: resolve `cwd` (realpath, forward slashes, lower case on Windows), then the
  company whose folder is the LONGEST prefix of it wins.
- If none matches and `cwd` is a git **worktree** (a `.git` FILE saying `gitdir: <main>/.git/worktrees/<name>`),
  match the main repo folder instead. So a worktree of `~/northwind-app` kept elsewhere counts as Northwind Goods
  because `~/northwind-app` does.
  This reads one small file, with no git spawn.
- Sessions whose cwd is inside the team root are never CEO sessions (they are positions or nothing).
- Recomputed at every CLI start (session `_options()`), so a session in a newly approved company gets its team tools
  the next time its CLI starts. After an approval Helm quietly recycles the CLI of the session that proposed it,
  once its turn ends (the idle reaper's quiet close; the next send resumes with the new options).

**How the roster reaches the CEO (no context bloat).** **Decided:** through the `team` MCP server only. Normal
sessions keep their system prompt untouched, so your normal Claude Code behaviour is exactly as today.
- Server `instructions` (surfaced as an MCP instructions block, `createSdkMcpServer({ instructions })`) carry the
  company name, the direct reports as `name (id): remit` one per line, a count of deeper positions under each, and
  six lines of how to use the tools. About 150 to 400 tokens for a team of 6.
- `alwaysLoad: true` on the CEO's server, so `team_ask` and `team_roster` are never deferred behind tool search.
  The CEO must be able to route without first searching for tools.
- Notebooks, briefs and logs are never in the prompt. They come only on demand: `team_roster({ under })`,
  `team_log`, or an ask.
- Roster changes mid-chat: the system prompt is recorded once per conversation (SDK `snapshot`), so an approved
  change reaches a live CEO chat as a `<helm-note>` on its next message ("Team change: Tax Specialist now reports
  to General Counsel"). This uses the steer.js `withNote` path, which already exists. `team_roster` always reads the live
  files.
- Sessions in no company get the same server name with ONE tool, `team_propose` (action `company` only), deferred
  (`alwaysLoad: false`), with a one-line instruction. That is how the very first company is set up from a
  conversation (section 6).
- The whole feature is off unless Settings > Team > "Positions" is on (`team.enabled`; default off in the public
  build). When it is off, no session gets the server.

## 4. Position sessions: isolation (PROVEN)

### 4.1 What was measured

- 14 probes ran on the real claude.exe (the one Helm runs) with SDK 0.3.293 and claude-haiku-5-5, one turn each,
  one at a time.
- Each probe recorded the init message (tools, MCP servers, plugins, skills, agents, `apiKeySource`) and the
  context-usage breakdown of memory files. It also recorded the model's answer to "quote any instruction from
  your global CLAUDE.md (a few of its marker phrases); list memory entries; list CLAUDE.md files; list mcp__ tools".
- Total cost about $0.06.
- The runner, full table and raw JSON are machine-specific and kept outside the repo. The same checks run through
  Helm's own code in `tools/team-isolation-live.js` (summary `team-isolation: N passed, M failed`).

| config | global CLAUDE.md | MEMORY.md / memory dir | project CLAUDE.md | settings hooks + mods | user skills | user agents | claude.ai connectors | SendMessage / ListAgents | SDK hook / SDK tool / auth |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A Helm today, cwd = a company folder | loaded | default dir (empty) | none there | loaded (mods) | loaded | loaded | loaded | present | ok / ok / ok |
| H Helm today, cwd `~` | loaded | **the home folder's MEMORY.md** | n/a | loaded | loaded | loaded | loaded (+ a user MCP server) | present | ok |
| B Helm today, cwd = empty workspace | loaded | default dir (empty) | (walk-up) | loaded | loaded | loaded | loaded | present | ok |
| C `settingSources: []` | no | ON, default dir under `~/.claude/projects` | no | **mods still load** (env var) | no | no | **loaded** | present | ok |
| D C + `strictMcpConfig` + connectors off + plugin env stripped | no | on, default dir | no | no | no | no | no | present | ok |
| E1 D + auto-memory off | no | off | no | no | no | no | no | present | ok |
| E2 D + `autoMemoryDirectory` in the workspace | no | its own folder only | no | no | no | no | no | present | ok |
| F E2 + custom (non-preset) system prompt | no | own folder | no | no | no | no | no | present | ok |
| R E2 + `tools` allowlist + `skills: []` | no | own folder | no | no | no | no | no | **absent** | ok |
| P R but `settingSources: ['project']` | **loaded, as a Project file** | own folder | loaded | no | no | no | no | absent | ok |
| G Helm today + temp `CLAUDE_CONFIG_DIR` (credentials copy only) | **loaded, as a Project file** | temp dir | loaded | mods loaded | account skills only | no | loaded | present | ok |

Findings that shaped the design:
1. `settingSources: []` is the main switch. It drops both CLAUDE.md levels, settings hooks, `enabledPlugins`, user
   skills, user agents and account skills.
   It does NOT drop:
   - the **mods**: they come from `CLAUDE_CODE_PLUGIN_DIRS`, set in the `env` block of `~/.claude/settings.json`
     and inherited by Helm's children;
   - the **claude.ai connectors** (mail, calendar and any other account connectors…);
   - **auto-memory** at the default `~/.claude/projects/<slug>/memory`;
   - the cross-session tools (`SendMessage`, `ListAgents`, `SendToProject`, `Task`, `Skill`, `Cron*` …).
2. **Never `'project'` for a workspace under the home folder.** The CLAUDE.md walk-up reaches
   `C:/Users/<you>/.claude/CLAUDE.md` and loads your global file as a *project* file (P, G). `CLAUDE_CONFIG_DIR`
   does not help for the same reason, so it is NOT used. That also means no copied credentials and no logout risk.
   Auth stays on your normal login (`apiKeySource: none` = subscription, in every probe).
3. The home folder's `MEMORY.md` is keyed by cwd: it loaded only for cwd = home (H). A workspace never sees it,
   but it gets an empty default memory dir under `~/.claude/projects` unless auto-memory is switched explicitly.
4. `strictMcpConfig: true` alone removed the connectors (D3). The settings flag is kept as well.
5. Only a `tools` allowlist removed SendMessage / ListAgents / Task / Skill / Cron.
6. Programmatic SDK pieces survive isolation in every config: the PreToolUse hook fired, and the in-process SDK MCP
   tool answered. The SDK tool was deferred behind ToolSearch.
7. Residual: the claude.ai account e-mail is in every context. No switch removed it. Harmless for a position, and
   noted.
8. Isolation is about context, not a sandbox. A position with `Read` or `Bash` could still open `~/.claude/CLAUDE.md`
   from disk. That is why the powers hook (7.3) also guards READ paths.

### 4.2 The position config (Decided)

```js
// main/engine/team/options.js  positionOptions(position, effectivePowers, chat) -> SDK options
const env = engine.claudeEnv();                 // Helm's env (already strips the inherited Claude vars, main.js)
delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
delete env.CLAUDE_CODE_PLUGIN_DIRS;             // finding 1: else the mods load
env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';      // belt and braces with the two connector switches
const opts = {
  cwd: workspaceOrWorktree,                     // ~/helm-team/<co>/positions/<id>  (or its git worktree, 7.1)
  settingSources: [],                           // finding 2: never 'project'
  systemPrompt: { type: 'preset', preset: 'claude_code', append: positionPrompt, snapshot: true },  // 8.1
  tools: [...effectivePowers.tools, 'ToolSearch', 'AskUserQuestion'],  // finding 5: the allowlist IS the tool surface
  disallowedTools: ['SendMessage', 'ListAgents', 'SendToProject', 'Task', 'Agent', 'Skill', 'CronCreate', 'CronDelete', 'ScheduleWakeup'],  // unless powers.agents
  skills: [],
  strictMcpConfig: true,                        // finding 4
  mcpServers: { team: positionServer },         // createSdkMcpServer({ name: 'team', instructions, alwaysLoad: true, timeout: 660_000, tools })
  settings: { disableClaudeAiConnectors: true, autoMemoryEnabled: false,     // finding 3: the notebook is THE memory
              crossSessionInbound: 'refuse' },  // 5.1: no unlogged SendMessage from your other sessions
  additionalDirectories: effectivePowers.dirsOutsideCwd,
  env,
  permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,   // 7.3: the hook is the gate
  canUseTool,                                   // Helm's normal request flow (AskUserQuestion, access cards)
  hooks: { PreToolUse: [prodGuard.createHook(es), teamGuard.createHook(es)] },
  includePartialMessages: true, extraArgs: { 'replay-user-messages': null }, enableFileCheckpointing: true,
  pathToClaudeCodeExecutable, model, effort,
};
```
- **Auto-memory off.** **Decided:** one memory system, the notebook you can read. A second, model-managed memory
  folder would split facts across two places. The probe's E2 shows a position *could* have its own memory folder
  if this is ever wanted.
- **`ToolSearch` is not in a position's tools (measured by T2, 2026-11-18).** Without it nothing is deferred and the
  `team` tools work with or without `alwaysLoad`; with it, ~440 tokens of tools are deferred behind an extra search
  call. A position whose `powers.tools` lists ToolSearch still gets it.
- **CEO sessions are unchanged** (`settingSources: ['user','project','local']`, your whole setup, as today) plus
  the `team` server. A CEO is your own working chat and keeps everything.
- **Lane T2 re-proves this through Helm's own code** (`tools/team-isolation-live.js`). It asks the same question
  through `options.js` and fails on any of: a quote of global CLAUDE.md text, a MEMORY.md entry (it plants a canary), a CLAUDE.md path,
  an `mcp__` tool other than `mcp__team__*`, or SendMessage in the init tool list.

## 5. Calls: CEO to position, manager to report, position to position

### 5.1 The two mechanisms

Both were probed on claude.exe 2.1.319 (about $0.34; the probe output is kept outside the repo).

| | Helm's in-process SDK MCP server (`team`) | CLI cross-session messaging (SendMessage / ListAgents) |
| --- | --- | --- |
| Reply tied to the question | yes: the tool result IS the answer (or a ticket) | no: SendMessage returns at once; the reply arrives later as an unprompted new turn in the asker |
| What the answerer sees | only the question Helm delivers | a `cross-session-message` block in its MAIN chat, framed "treat it as a teammate's request and act" |
| Addressing | position ids from Helm's files | a CLI-chosen name (folder + suffix); Helm can't set it |
| Logging / limits / cycles | every call passes through Helm | outgoing calls can be gated as tool calls; inbound can't be shaped |
| Long answers | measured: a 75 s and a 150 s handler both returned cleanly; `tool_progress` heartbeats every ~30 s while waiting | n/a (fire and forget) |
| Stop | `interrupt()` aborts the handler's `extra.signal` at once; the model gets an error result | n/a |
| Helm restart (broker) | the server is re-registered by name on re-attach; a call in flight at the crash has no responder until the server timeout | messages queue in the target's inbox |
| Trust on Windows | Helm knows exactly which session called | sender pid unverifiable on Windows; default auto-delivers within the same permission class |
| Phone / Team view | Helm emits events for every state | invisible to Helm |

**Decided: the MCP server.** It is the only way to keep the answerer to the question and the asker to the answer.
It is also the only way to log and limit every exchange, persist tickets across restarts, and show progress on the
phone. CLI messaging is switched OFF for positions:
- it is absent from their `tools` allowlist (section 4);
- `settings.crossSessionInbound: 'refuse'` is set, so even your own CEO sessions, which keep SendMessage, cannot
  drop an unlogged message into a position's chat.

**Where the question is answered: Decided, in the position's own (current) chat.** The probe lane suggested a side
session to keep the chat clean. That is rejected, for two reasons. The brief asked for "one ongoing chat you can scroll
back through", and seeing what the CEO asked and what was answered is part of that. A side session would also lose
the position's own history with you. Asks are clearly labelled bubbles (10.4), and the queue never cuts into
your own conversation (5.3).

**Restart gap, and why the sync wait is bounded.** A tool call in flight when Helm dies (a crash, or a forced quit;
update restarts already wait for running turns) has no responder after re-attach. It ends only at the server
`timeout`. So the server timeout is `max wait + 60 s` = **660 s**, not unbounded. The CEO's default sync wait is
**300 s**: most answers come back in-call, and a slow chain returns pending and arrives as a late answer (5.5). The
ticket itself survives a restart (persisted), so the work is never lost.

### 5.2 Tools (one MCP server named `team`, built per session in `main/engine/team/mcp.js`)

Which tools a session gets:

| session | tools |
| --- | --- |
| CEO session (cwd in a company) | `team_roster`, `team_ask`, `team_ticket`, `team_cancel`, `team_log`, `team_propose` |
| position with reports (a manager) | the CEO set, scoped to its own subtree, plus the position set |
| any position | `colleague_ask`, `ask_followup`, `notebook_add`, `request_access`, `duty_report`, `team_propose` (its own reports only), `team_ticket` |
| session in no company | `team_propose` (action `company` only), deferred |

Tool names are bare in the server (`team_ask`). The model sees them as `mcp__team__team_ask`, and the Helm UI
renders `mcp__team__*` items with their own cards (section 10).

**`team_roster({ under?: string })`**
- Without `under` it returns the caller's direct reports: `[{ id, name, remit, status, reports: n, openItems: n,
  nextDuty?, busy?: "answering CEO" }]`, plus the caller's own manager for positions.
- With `under: "<id>"` (that id must be inside the caller's subtree) it returns that node's direct reports, so the
  CEO can look deeper on demand.
- It never returns briefs or notebooks.

**`team_ask({ to: string, question: string, handed?: string[], wait_s?: number })`**
- `to` must be a DIRECT report of the caller (the CEO's direct reports are the top-level positions).
  **Decided:** the chain of command is real. The CEO asks General Counsel and General Counsel delegates to Tax Specialist. Asking a deeper
  position directly is refused with a message naming its manager. You can still open any position's tab and talk
  to it directly.
- `question`: the full question plus any context the answerer needs. It shares nothing else of the asker's chat
  (the instructions say so).
- `handed`: file paths the answerer may READ for this ask only. Helm grants a ticket-scoped read and lists them in
  the delivered question. Max 20 paths; each must exist.
- `wait_s`: how long the tool call waits before returning pending. Default 300 for the CEO and 180 for a position;
  max 600; clamped by the chain budget (5.7).
- Returns one of:
  - `{ status: "answered", ticket, from: "legal", answer, took_s, chain: [...] }`
  - `{ status: "pending", ticket, state: "queued: you are talking with General Counsel" | "working 6m" | "waiting on Tax Specialist", note }`.
    The note says: "Tell the user it is pending. The answer will arrive in this chat as a Helm message. Carry on."
  - `{ status: "refused", reason }` (paused, retired, not your report, rate limit, cycle, chain too long).
    Too little time left in a chain returns `pending` at once instead (5.7).
- Sync behaviour: the handler waits inside the tool call and returns at `wait_s` with pending; the ticket keeps
  going. Helm sets the server `timeout` to 660 s (5.1), so the CLI never ends the call first, and a call orphaned by
  a crash ends within 11 minutes. The handler watches `extra.signal` (Stop, 5.5).

**`team_ticket({ ticket, wait_s? })`**: the ticket's state and answer, waiting up to `wait_s` (default 0) for it.

**`team_cancel({ ticket })`**: withdraws a queued ask, or marks a working one cancelled (the answer is logged but
not delivered).

**`team_log({ position?, since?, limit? })`**: recent exchanges in the caller's subtree (the CEO sees all), each as
`{ at, from, to, question (first 300 chars), answer (first 600 chars), state, ticket }`. Full text only through
`team_ticket`.

**`team_propose({ action, ... })`**: section 6.

**`colleague_ask({ to, question, handed?, wait_s? })`**
- `to`: any live position in the same company that is not the caller's direct report (a direct report goes
  through `team_ask`; the answer shape is the same).
- **Decided:** a narrow question. The tool description says "one specific question, no hand-over of your work".
  The question is capped at 2,000 chars and `handed` at 3 paths.

**`ask_followup({ ticket, text })`**: an answerer that already answered a ticket in the last 24 h sends an
addendum. It is delivered to the asker like a late answer. This is how a manager passes on a report's late answer.

**`notebook_add({ section: "Decisions"|"Facts"|"Open items"|"Log", text })`**
- Appends one dated entry under that heading. The file stays tidy, and Helm can show "notebook updated" in the
  chat.
- Positions may also edit `notebook.md` directly with Edit (it is in `$workspace`).

**`request_access({ kind, target, why })`**: section 7.3.

**`duty_report({ summary, needs_owen, files? })`**
- Ends a duty run. It writes an inbox line and pushes to the phone if `needs_owen`.
- `files` must be inside the position's writable area (drafts).

### 5.3 Delivery: how a question reaches the answerer

Each position has ONE inbox queue in Helm (`team/runtime.js`). A queued ask is delivered when all of these hold:
1. The position's current chat has no turn running and no pending request.
2. You are not mid-conversation in it: no send from you and no draft typing (`es.lastActiveAt`) in the last
   90 s while its tab is on any screen (`viewedBy`, index.js).
3. No rollover is in progress (section 8).
4. The machine-wide run cap allows another position turn (`team.maxConcurrentRuns`, default 2; section 9.5).

Order:
- Your own messages always go first.
- Then asks from managers and the CEO, then colleague asks, then duty runs (FIFO within a class).
- While an ask waits behind you, the position's tab shows a banner (not built yet: the engine has
  `team.ask.release`, but no banner calls it): "CEO's question is waiting:
  'Does the new privacy page cover…' [Let General Counsel answer now] [Later]". *Let it answer now* delivers it as the next
  message right away. It never interrupts a running turn.

The delivered message is sent with `es.send({ text, origin: 'helm' })`. Origin `helm` means prod-guard never counts
it as your own words. Its text:
```
<helm-ask ticket="t_4f1e" from="CEO (Northwind Goods)" kind="report" reply-by="14:32">
Does the new privacy page cover the crash-report upload the app added in 1.3.0?
Handed to you (read-only for this question): C:/Users/you/northwind-shop/site/privacy.html
</helm-ask>
Answer this question in your reply. Your final message is passed back to the CEO word for word; it sees nothing
else of this chat or your notebook. If you need a report's input, use team_ask. Record anything durable with notebook_add.
```
- The answer is the turn's final assistant text: handoff.js `finalText()`, clipped at 20k.
- The UI shows the delivered message as an "Asked by CEO" bubble (section 10.4), not as yours.

### 5.4 What the asker's chat shows meanwhile

- The `mcp__team__team_ask` tool item renders as an **Ask card**: "Asking General Counsel", a live state line, elapsed time,
  [Open General Counsel] [Cancel question].
- The card follows `team.ask.updated` events: `queued (you are talking with General Counsel)`, `General Counsel is working · 2m`,
  `General Counsel asked Tax Specialist · 1m`, `answered in 3m 40s`. For a chain it shows the tree of sub-tickets, one
  indented line each.
- On answer the card collapses to a one-line summary with the answer under a disclosure. The model already has the
  full text.
- The CEO's turn is `working` with activity "Waiting for General Counsel".
  - No stall false alarm. The CLI sends a `tool_progress` heartbeat about every 30 s while an SDK MCP call waits
    (measured), and any SDK message clears Helm's stall timer (stall.js). So stall.js needs no change.
  - The restart gate sees the turn as busy, as for any long tool, so an update restart waits for it.

### 5.5 Late answers, Stop, restarts

- **Pending, then answered.** Helm delivers `<helm-answer ticket="t_4f1e" from="General Counsel">…</helm-answer>` into the
  asker's chat with `es.send({ origin: 'helm' })`. If the asker is idle this starts a turn, so the CEO relays it to
  you: an answer never sits unseen. If the asker is busy, it is queued behind its turn (never steered mid-turn: an
  answer is a new topic). The asker's Ask card updates to "answered (late)".
- **You press Stop in the asker's chat while it waits.** The MCP call is cancelled. **Decided:** the ticket is
  NOT cancelled. When it is answered, Helm adds an **answer card** to the chat (a Helm item, no turn): "General Counsel
  answered after you stopped: [Show] [Send to CEO]". Stop means "don't spend more turns on my behalf", but the
  work already paid for is kept.
- **Helm restarts mid-ask.** Tickets are persisted in `team-state.json`. If the answerer's turn survived in the
  broker (Keep sessions running), its end is seen on re-attach and the answer is recorded. The asker's pending MCP
  call is lost with the old process: the CLI gets a tool error, and the restart note already tells the model that
  Helm restarted. The answer is then delivered as a late answer. Queued tickets are re-queued on start.
- **Hard expiry.** A ticket not answered 2 h after it was asked becomes `expired` and is withdrawn if still queued.
  If it is still being worked on, it stays `late` and its answer is still logged and delivered. The asker gets
  `<helm-answer state="expired">`.

### 5.6 Limits

**Decided** (constants in `team/runtime.js`, shown in the Team view footer):

| limit | value | why |
| --- | --- | --- |
| asks per position per hour (as asker) | 20 | runaway loops |
| asks per company per day | 200 | cost ceiling |
| open sub-asks per ticket | 3 | fan-out |
| tickets in one chain | 8 | depth 5 + cross-talk detours |
| hard expiry | 2 h | nothing open forever |
| wait budget per call | 30 s to 600 s | the server timeout is 660 s (restart gap, 5.1) |
| question size | 20k chars (colleague 2k) | prompts stay small |

**Cycles and deadlocks.**
- Helm keeps a wait-for graph: position P is waiting on ticket T, which targets Q.
- An ask from P to Q is refused at once when Q is already in P's chain, or when Q reaches P in the graph
  (A waits on B, B waits on C, C asks A). The refusal says: "Controller is waiting on you (through Tax Specialist). Answer
  with what you have."

### 5.7 Chains: delegating down the tree

**Routing.** The CEO asks a top-level position. That position may call `team_ask` on its own reports (or
`colleague_ask` sideways) while answering. Each nested ask is its own ticket, with `parentTicket` and the root's
`chain` id. Answers flow back up one level at a time. Each level gets only its child's answer, never the child's
notebook or chat.

**Budgets (Decided).** Every ticket carries a sync deadline.
- The root's deadline is `asked + wait_s`.
- A nested `team_ask` / `colleague_ask` waits `min(its own wait_s, parent's remaining − 45 s)`. The 45 s margin
  gives each level time to write its own answer before its caller's call returns.
- If that leaves under 30 s, the nested call does not wait at all. It creates the ticket and returns `pending`
  at once, with the note: "Too little time left in this chain to wait. Answer with what you have and say what is
  still pending. Helm will hand you the late answer; use ask_followup if it changes what you said."
- So no call in a chain can outlive its caller's wait. The CEO always gets a result within its own `wait_s`
  (≤ 600 s): the answer, or pending with the chain's state in words, e.g. "pending: General Counsel is waiting on Tax
  Specialist (working 4m)".

**Late answers in a chain.**
- A sub-answer that arrives after its caller returned is delivered into the caller's chat as `<helm-answer>`, as in
  5.5.
- If the caller has already answered upward, the delivered text says so and points at `ask_followup`. The addendum
  then travels up the same way. The CEO chat gets "General Counsel adds (from Tax Specialist): …".

**Progress, never silent.**
- Every state change of any ticket in a chain emits `team.ask.updated` with the whole chain snapshot (ticket, to,
  state, since).
- The root Ask card shows it as indented lines (5.4). Each position's tab shows "answering CEO · chain t_77aa".
- The CLI's own 30 s `tool_progress` heartbeat keeps every waiting session visibly alive. MCP progress
  notifications to the model are not used: the model does not need them, and you see the card.
- A chain's tickets expire together 2 h after the root was asked (5.5). Whatever is still open is withdrawn or
  marked late, and the CEO chat gets one `<helm-answer state="expired">` naming where it stopped.

**Caps.**
- At most 8 tickets in one chain (tree depth 5 plus cross-talk detours) and at most 3 open sub-asks per ticket.
- A cycle within a chain or across the wait-for graph is refused at once (5.6).

## 6. Org tree, proposals and approval

### 6.1 Who may propose what

| proposer | may propose |
| --- | --- |
| session in no company | `company` (name, folders, why) |
| CEO session | create / edit / retire any position in the company; edit the company (folders) |
| a position | create a report under ITSELF; edit or retire positions in its own subtree (never itself, its manager or siblings) |

A position cannot propose a change to its own powers. It uses `request_access` (section 7.3), and the decision
there can save to its definition.

### 6.2 `team_propose`

```js
team_propose({
  action: "create" | "edit" | "retire" | "company",
  id?: "tax",                       // edit / retire: the target; create: the new id (Helm slugifies `name` if absent)
  parent?: "legal" | null,          // create: default = the caller (a position) or null (the CEO); edit: re-parent
  name?, remit?, scope?, brief?,    // create: required (brief = the full brief.md)
  powers?, duties?, model?, effort?,
  seed?: { notes?: string, files?: [{ path, why }] },   // create: facts the proposer already knows + files the new position reads on its first run
  reports_on_retire?: "move-up" | "retire-too",          // retire of a manager: default move-up (to the retiring position's manager)
  why: string                        // one or two lines shown on the card
}) -> { proposal: "p_9c0d", status: "shown", where: ["this chat", "Team view"], note }
```
- **The name is a real job title.** `name` is what that person would be called at a real company (General Counsel,
  Controller, Marketing Manager, Business Development Representative, Tax Specialist), never a topic or department
  label ("Legal", "Finance", "Money & Paperwork", "Leads & Outreach"); `remit` says what it covers. The tool
  description and the recurring-topic line both say so. A create (or a rename) whose name is a bare department label
  or contains " & " is not refused: the card gets a `nameWarning` line and the tool result repeats it in its note.
- Helm validates first and refuses with reasons: schema, id unique, depth cap (6.4), powers ⊆ manager's (7.2),
  folders inside the company, retire of a position with open tickets (asks it to wait), more than 10 direct reports.
- A valid proposal becomes a **proposal card** (section 10.4) and returns at once. It is NOT blocking.
  - The note says: "The user decides on the card. You will get their decision as a Helm message. Discuss
    changes with them meanwhile; call team_propose again to replace this proposal."
  - **Decided:** not blocking. A blocking card would also block any message you type, because mid-turn messages
    are only taken after the current tool call ends.
- A new proposal for the same target from the same session supersedes the older one (that card turns "superseded").

### 6.3 Where proposals appear, and how approval is captured

- **From a CEO session:** the card appears in that CEO chat and in Team view > Proposals.
- **From a position:** the card appears in that position's chat, in Team view > Proposals (with a badge on the
  Team rail button), and as a phone push ("General Counsel proposes a new report: Tax Specialist"). It is NOT injected into
  a CEO chat: that would start a CEO turn you did not ask for. Any CEO session sees open proposals in
  `team_roster` (`openProposals`), so the CEO can be asked to talk it through.
- You can decide from any of these places. It is the same proposal id, and every copy resolves together.
- Card actions:
  - **Approve**: Helm writes the files (7.2 and 8.1 run first) and records `decision.how: "click"`.
  - **Change…**: a small text box; your text goes to the proposing session as your message.
  - **Decline**: with an optional note.
- **Typed approval** (prod-guard's `promptApproval` idea, narrowed). The reply counts as Approve when all of these
  hold:
  - your own typed message (origin `user`) in the proposing session is affirmative (prod-guard `isAffirmative`:
    "yes", "approve", "go ahead", "create it", not negated, not a question);
  - exactly ONE proposal is open in that session;
  - the card is the last thing Claude showed before your message.

  The card then reads "Approved by your reply 'yes, make it' at 14:02". Anything ambiguous leaves the card open.
  Helm-written messages never count.
- After a decision Helm sends the proposing session `<helm-note>The user approved p_9c0d: Tax Specialist created under
  General Counsel.</helm-note>` with its next message. If the session is idle and the proposal came from a position, it
  starts a short turn, so the manager can brief its new report. That brief is a normal `team_ask`, logged.
- **The CEO noticing a recurring topic.** **Decided:** model-driven, no Helm-side detector. The CEO's server
  instructions say: "When a non-code topic (legal, money, marketing, support…) comes up a second or third time and
  no position covers it, suggest a position to the user in plain words first; call team_propose only after they
  want it. Name a position by the job title that person would hold at a real company …; the remit says what it
  covers." Managers get the same line for reports. It costs nothing, and you keep the say.

### 6.4 Tree rules

**Decided:**
- **Depth cap 5** (CEO = 0, top-level = 1, deepest = 5). A deeper org on one laptop means asks bouncing through 5
  Opus turns: slow and costly. Five covers e.g. General Counsel > Tax Specialist > Payroll Tax Specialist > State Payroll Analyst > one more.
- **At most 10 direct reports per manager and 30 live positions per company.** The roster in a manager's
  instructions stays under ~600 tokens, and RAM stays sane (section 9.5).
- **Re-parenting** is an `edit` with `parent`. It is refused if the new parent is in the moved node's own subtree
  or the move would break the depth cap. The moved node's powers must fit under the new manager (7.2), or the card
  shows exactly which powers would be cut.
- **Retiring a manager** moves its reports up to its own manager by default (`move-up`), or retires the whole
  subtree (`retire-too`; the card lists every position it retires). Retiring needs no open tickets to or from the
  position.
- **Isolation at every level.** A report is briefed only on its narrower area (its own brief). It knows its
  manager's name and remit, never the manager's brief or notebook. A manager knows its direct reports' names and
  remits, never their notebooks or chats. Answers are the only thing that crosses.

### 6.5 What Helm writes on approval of `create`

1. `positions/<id>/` with `position.json` (version 1, `createdBy`), `brief.md`, a `notebook.md` from the template,
   with `seed.notes` written under Facts as "(seeded by <proposer>, <date>)", `chats.json` `[]`, and `work/drafts/`.
2. A `proposals.jsonl` decision line, and an inbox line "Tax Specialist created".
3. If `seed.files` is non-empty: an **onboarding** duty run (one time). Its message lists the files, which are
   granted read-only for that run, and asks the position to record what matters to its remit with `notebook_add`.
4. Notes to the proposer and to the new position's manager (if they differ), plus the roster note to live CEO chats.
5. No chat is started until something needs the position (section 8.2).

## 7. Powers

### 7.1 Schema

```js
powers: {
  read:  ["$workspace", "$company"],        // where Read / Grep / Glob / NotebookRead (and read-only Bash) may look
  write: ["$workspace"],                    // where Write / Edit / MultiEdit / NotebookEdit may change files
  tools: ["Read","Grep","Glob","Write","Edit","WebSearch","WebFetch","TodoWrite"],  // the built-in tools it has
  bash:  "off" | "readonly" | "on",         // "on" only for coding positions
  agents: false,                            // may it use the Agent tool (subagents inherit these powers)
  worktree: false                           // coding positions: work in their own git worktree of $scope (below)
}
```
- `$workspace` is always readable and writable. `~/.claude/**`, the team root outside its own folder, and other
  companies' folders are never readable unless granted (and Helm warns on the card for `~/.claude`).
- **Outward actions are not a setting.** Sending email or messages, posting, paying or buying, pushing,
  deploying, publishing a release or package, and anything else that leaves the machine in your name
  ALWAYS asks, Approve once / Deny only. There is no "always" for outward: nothing leaves without your OK.
- **Default for a non-coding position:** the schema example above. **Default for a coding position (e.g. QA
  Engineer):** `read: ["$workspace", "$scope"]`, `write: ["$workspace", "$scope"]`, plus Bash `on`, `worktree: true`.
  - `worktree: true` makes the position work in its own git worktree of the scope repo (Helm's existing worktrees
    feature, `main/worktrees.js`, branch `team/<company>/<id>`). Its edits never touch the live folder.
  - Merging is yours, through the existing worktree merge flow (prod-guard-guarded).
  - **Decided:** this is how "a coding position can edit code in its own area" stays safe even though Bash path
    checks are best-effort.
- Built-in tools a position NEVER gets (SDK `disallowedTools`): `CronCreate`, `CronDelete`, `ScheduleWakeup`
  (duties live in Helm, not in a CLI that the reaper closes), `SendMessage` / `ListAgents` / `SendToProject`
  (cross-session messaging bypasses the log), `Skill`, and `Agent` / `Task` unless `agents: true`. The `tools`
  allowlist (section 4) already leaves these out; `disallowedTools` repeats them as a second lock.

### 7.2 Effective powers in a tree

`effective(p) = own(p) ∩ effective(parent(p))`. The CEO level is "the company": all company folders, every tool.
- read and write are path sets intersected after token expansion; tools is a list intersection; bash is the
  minimum of off < readonly < on; agents and worktree are AND. Grants with `once` scope (7.3) add to the effective
  set for their lifetime only.
- A proposal whose powers exceed the manager's effective powers is refused with the exact excess. A report's
  powers can never exceed its manager's (a fixed rule).
- Narrowing a manager narrows its whole subtree at once: Helm computes effective powers live, and the hook reads
  them on every call. The Team view shows "limited by General Counsel" next to any power a report lists but cannot use.

### 7.3 Enforcement points

1. **Tool list.** SDK `tools` (or `allowedTools` + `disallowedTools`) is built from `powers.tools` + the `team`
   server. A tool that is not in the list does not exist for the model.
2. **cwd and directories.** `cwd` is the workspace (or the worktree for `worktree: true`). `additionalDirectories`
   holds the readable and writable folders outside it, so Claude Code's own working-directory checks agree with
   the hook.
3. **PreToolUse hook `team/guard.js`** (prod-guard's pattern: no matcher, runs in EVERY permission mode, never
   throws, denies on error):
   - File tools: the resolved path (realpath; `..`, junctions and symlinks followed; case-insensitive) must be in
     effective read (Read, Grep, Glob, NotebookRead) or write (Write, Edit, MultiEdit, NotebookEdit). Grep and Glob
     use `path`, defaulting to cwd.
   - Bash and PowerShell:
     - `off`: denied.
     - `readonly`: reuses prod-guard's command scanner to split chains. It allows only a list of read commands
       (`ls`, `cat`, `git log/show/diff/status`, `rg`, `node --version`…) and refuses redirects and writes.
     - `on`: allowed, except commands that reference paths outside write (best-effort: `rm`, `mv`, `cp`, `>`,
       `Set-Content`, `git -C <outside>`) and outward commands.
   - Outward classifier, for any Bash level: prod-guard's own `assess()` (push, Railway, gh writes), plus
     `npm/pnpm publish`, `curl`/`wget`/`Invoke-WebRequest` with a write method or body, `gh release`, `gh issue
     create/comment`, `gh pr create`, mail CLIs (`sendmail`, `mutt`), `stripe`, `twilio`, and any `mcp__*` tool
     other than `mcp__team__*`. A hit shows the **outward card** (Approve once / Deny) and blocks, like prod-guard
     (WAIT_MS 30 min, then denied).
   - WebFetch and WebSearch are reads (WebFetch is GET only). Allowed if in tools.
   - Anything else not in powers is denied at once with: "Not in your powers (<what>). If you need it, call
     request_access with the reason; do not try another way."
4. **prod-guard stays on** for positions too (its hook is added first, as today).
5. **Isolation config** (section 4): no user MCP servers or connectors (`strictMcpConfig`), no plugins or mods, no
   skills. So the only outward paths are Bash and the team server.

**Decided:** permissionMode for positions is `bypassPermissions`. The hook is the only gate, and it is verified to
run before the mode is consulted (prod-guard's live test). It is also the mode Helm already runs. There is no
second prompt layer to confuse you.

### 7.4 Escalation, end to end

1. The position is blocked by the hook, or knows ahead of time it needs more. It calls
   `request_access({ kind: "read"|"write"|"tool"|"bash"|"outward", target: "C:/Users/you/northwind-app/CHANGELOG.md" | "WebFetch" | "bash:on", why })`.
2. Helm validates the request: the target is a real path or tool name, not `~/.claude/**` unless the card warns.
   It opens a `request` item with `kind: "access"` in the position's chat. The session goes `waiting`, so the
   existing toast, Deck tile, phone push (`notify` kind `waiting`) and Home "needs you" all fire. The roster
   card shows a "1 request" chip with the same buttons. If the position was answering an ask, the asker's Ask
   card says "waiting for your OK on General Counsel's access request".
3. The card shows: who (with its manager path), what, why, and the scope options:
   - **Approve once**: valid for the current chat until its turn ends. For a duty run, the whole run. For a
     ticket, until the ticket settles.
   - **Approve always**: saved into `position.json` powers (version +1). If the request is beyond the manager's
     effective powers, the button reads "Approve always (also widens General Counsel)" and lists every ancestor it widens,
     so the tree rule holds. Not offered for `outward`.
   - **Deny**: with an optional note.
4. The tool returns `{ decision: "once"|"always"|"denied", note? }`. The hook reads the new effective powers on
   the next call, so the position continues at once. On deny it adapts. The reason text says, like prod-guard's,
   that the decline covers this attempt, and a later need may ask again.
5. No answer in 30 min: `{ decision: "no-answer" }`. The position is told to continue without it and record an
   Open item. The card closes as timed out (same as prod-guard).
6. Every decision is a `grants.jsonl` line. An `always` also writes the position's new version, and its next chat
   gets the updated powers summary in its prompt. The current chat gets a `<helm-note>` with the change.

Requests from ANY level go to you, never to the manager. A manager cannot grant its reports anything (the hook
holds no "manager approves" path).

## 8. Memory: notebook, chats, rollover

### 8.1 What a position's chat starts with

- **System prompt append** (recorded once per chat):
  - `house-rules.md`;
  - its brief;
  - "You are <name> on <company>'s team. You report to <manager name: remit | the CEO (the owner's main chats)>. Your
    reports: <name (id): remit> or none.";
  - a powers summary in words;
  - the notebook path and its four headings;
  - today's date at chat start.
- **Seed** (the first message of a chat, never a turn by itself): `notebook.md` as it is now, plus the previous
  chat's handoff (for chat 2 and later). Delivered as a `<position-seed>` block in front of the first real
  message (an ask, a duty or you). An idle position costs nothing until it is needed.
- Later edits by you:
  - `notebook.md`: an fs.watch notices them. The next message to the position carries
    `<helm-note>The user edited your notebook:</helm-note>` with a unified diff (cap 4k chars; beyond that, the whole
    file).
  - `brief.md`: the note carries the full new brief, because the recorded system prompt cannot change mid-chat.

### 8.2 Chats

`chats.json`:
```json
[ { "n": 1, "helmSessionId": "s_a1b2", "claudeSessionId": "…", "startedAt": "…", "endedAt": "…", "endReason": "full", "contextPct": 33.1, "handoff": "Done: … Left: … " },
  { "n": 2, "helmSessionId": "s_c3d4", "claudeSessionId": null, "startedAt": "…" } ]
```
- A chat is a normal Helm session with `position: { company, id, chat: n }`. Title = position name; `cwd` = the
  workspace.
- It is created lazily (first ask, duty or you opening the tab), so it is resumable and scrollable like any
  session, and it rides the idle reaper and broker like any session.
- Ended chats are `archived: true` and keep their transcript.

### 8.3 Rollover (reuses handoff.js and context-limits.js)

- **When.**
  - At the end of any turn where `s.context.percent >= CONTEXT_HANDOFF_PCT` (32), the position is marked
    "roll pending". The roll runs at the next quiet moment: no turn, no pending request, no queued message from you,
    and you not active in the tab for 120 s.
  - At `>= CONTEXT_CEILING_PCT` (40) it runs as soon as the turn ends, even if the tab is on screen. The tab shows
    "Fresh chat started: this one was full" with a link to the old one (not built yet: no notice is emitted).
  - Never mid-turn.
  - The delivery queue (5.3) holds while a roll runs.
- **How.**
  1. Run `createHandoff` with a position prompt. This is a small change to handoff.js: `handoff({ id, prompt })`.
     The prompt says: "Your chat is full and a fresh one starts next. First record in notebook.md (notebook_add
     or Edit) every decision, fact and open item from this chat that is not there yet. Then reply with a handoff
     under 250 words: Done, In progress, Waiting on (tickets), Next."
  2. Store the handoff text in `chats.json`. Mark the chat ended and the session archived, and close its CLI.
  3. Create chat n+1 lazily, with seed = notebook + handoff (8.1). Open tickets that pointed at the old chat move
     to the new one. A ticket the old chat was answering is finished before the roll (rule: no roll mid-turn).
- **Failure.**
  - If the handoff turn fails, Helm retries once.
  - If it fails again, it starts the new chat with notebook only, writes "handoff failed: <why>" to the chat
    entry, and puts an inbox line for you. The old chat is never deleted, so nothing is lost.
- **Scrolling back.** Team view > position > Chats lists every chat (n, dates, end reason, handoff). Opening an
  ended chat opens its archived session as a tab. Its composer is replaced by "This chat ended on 11-20 (full).
  Talk in the current chat →" (as built: the composer stays, and the engine refuses a send to an ended chat). **Decided:** sending to an old chat would revive a full context and split the
  position's memory. Fork-from-here (existing `sessions.fork`) still works if you really want it.

## 9. Duties

### 9.1 Definition (in `position.json`, created and edited only by proposal)

```js
{ id, title, enabled: true,
  trigger:
    { kind: "schedule", cron: "0 9 1 * *", catchUp: "once" | "skip" }      // 5-field cron, local time (schedules.js nextCronFire)
  | { kind: "event", event: "commit",  repo: "$scope" | "<folder>", branch?: "master", paths?: ["site/**/privacy*"] }
  | { kind: "event", event: "release", repo: "<folder>", tag?: "v*" }       // a new local tag matching the glob
  | { kind: "event", event: "file",    path: "<file>" },                    // a file's content changed (mtime + hash)
  prompt: "Draft the X and Discord post for this release from its commits.",
  output: "draft" | "report",
  cooldownMin?: 30 }                                                          // events: coalesce bursts (default 30)
```
Examples, as they would be proposed (Northwind Goods):
- Marketing Manager `release` on `~/northwind-app` (one duty per repo). It drafts the post into `work/drafts/`; it never
  posts.
- General Counsel `commit` on `~/northwind-shop` with `paths: ["**/privacy*", "**/cookies*", "**/terms*"]`. It re-checks
  the legal text against the code (legal text must be true to what the code does).
- Controller `schedule` `0 9 1 * *`, the monthly money check.

### 9.2 Where duties run

**Decided:** in Helm's main process (`team/duties.js`), never inside claude.exe.
- In-CLI CronCreate jobs die with the CLI. The idle reaper closes idle CLIs after `closeIdleAfterMin` (15 min).
  An idle position must cost 0 RAM.
- So positions are disallowed CronCreate and ScheduleWakeup. A duty run is an ordinary delivery (5.3) with class
  `duty`. The CLI is resumed for it (cold start ~3 s) and reaped again afterwards.
- The reaper needs no change, and `isHeld` is not used for positions.

### 9.3 Schedule triggers and Helm being closed

- A 60 s tick (unref'd) computes due duties from `nextCronFire(cron, lastRunAt)`. `lastRunAt` and `nextAt` are kept
  in `team-state.json` and mirrored in `duty-runs.jsonl`.
- **Helm closed at the due time.** On start, a duty whose fire time passed while Helm was down:
  - `catchUp: "once"` (default) runs ONE catch-up run if it is still inside its window (24 h for daily or more
    often, 7 days for weekly or longer). The message says "This run was due <when>; Helm was closed."
  - Outside the window, or `catchUp: "skip"`, it is logged `missed` with an inbox line.

  **Decided:** no Windows Task Scheduler entry. Helm normally lives in the tray, and the catch-up covers the gaps
  without a second launcher that could start Helm unasked.
- `team.dutiesPaused` (Settings) pauses all duties. A paused position runs none.

### 9.4 Event triggers, cheaply

- The watched set is only the repos named by ENABLED event duties. No other folder is ever looked at.
- Per watched repo, Helm resolves the common git dir (the `.git` folder, or a worktree's `commondir`). It puts
  non-recursive `fs.watch` watchers on `refs/heads`, `refs/tags`, `packed-refs` and `HEAD`, which is
  ReadDirectoryChangesW on Windows: 0 CPU when nothing changes.
- **Change.** After a 30 s debounce, ONE `git for-each-ref --format=%(refname) %(objectname)` in that repo. Compare
  with the last-seen refs (in `team-state.json`).
  - New commits on the branch: one `git log --name-only <old>..<new>`, filtered by `paths`.
  - New tags matching the glob: a `release` event.
  - The event carries the commit subjects (max 50) and the files changed (max 200).
- **File events.** A non-recursive watch on the file's folder, filtered to that name; a hash check confirms a real
  change.
- **Start of Helm.** One `for-each-ref` per watched repo against the stored refs catches commits and tags made
  while Helm was closed (same `catchUp` rule).
- **Re-arm.** fs.watch can drop events (look.js already re-reads on focus and resume). The duty runner re-checks
  every watched repo once on window focus and on system resume, and at most every 15 min. That is still one cheap
  git call per repo, no tree walking.
- **Bursts.** Several commits within `cooldownMin` become one event and one run.

### 9.5 Running a duty

- Delivery uses the ask path, class `duty`, with:
  ```
  <helm-duty id="monthly-money" trigger="schedule 0 9 1 * *" due="2026-12-01 09:00">
  …the duty prompt… (event details: commits, tag, files)
  </helm-duty>
  End the run with duty_report (summary, needs_owen, files). Draft only; anything outward waits for the owner.
  ```
- **Caps.**
  - `team.maxConcurrentRuns` (default 2) machine-wide position turns. A laptop is often near full RAM;
    each live CLI is ~300 to 450 MB.
  - Duties also wait when Helm's usage tracker shows the 5-hour window at or above `team.usageCeilingPct`
    (default 80, so duties leave headroom for your own work). They are logged `skipped: usage` and retried at the next tick after
    it drops.
- **Output.** `duty_report` writes an inbox line, plus a phone push if `needs_owen` (`notify` kind `waiting`,
  `source: "team"`).
  - A run that ends without `duty_report` gets an automatic inbox line with the final text.
  - A failed run (CLI error) gets `state: "failed"` and an inbox line.
- "Run now" in Team view is a run you start (class `duty`, logged `trigger: "manual"`).

## 10. UI

Reuse map (from the UI survey; no new visual language): Deck's view scaffolding and `.dtile` cards, `.chip`, `.dot`,
`.btn*`, `.seg`, `.hint`, `.view-*`, `chat/requests.js` `PermissionCard` structure (`.req-card/.req-head/.req-why/
.req-actions`), `chat/restart-note.js` inline card pattern, `panels/scheduled.js` rows, `shell/claude-config.js`
`FileView` (markdown view/edit with mtime conflict and backup), `lib/markdown.js` `Markdown` (DOMPurify).

### 10.1 Where it lives

- **Team** is a full view (`view = 'team'`) with its own rail button (a new `users` glyph in `lib/icons.js`, drawn
  in the existing icon style). It is modelled exactly on Deck: rail button, `Mains()` branch, `Phone()` branch,
  palette entry "Team", shortcut.
- **Phone.** The 5-column phone nav stays as it is: a 6th button is cramped at 320 px. Team is reached from a
  header icon in `.plist-head` (as Deck is) and from a Home card "Team: 2 need you" (pending requests + proposals
  + needs-you inbox), which shows only when non-zero.
- **Sidebar.**
  - Position sessions are left out of the project groups. Otherwise each position folder would become a group
    named "legal".
  - A **Team** section, a sibling of Elsewhere and Past, lists only positions whose chat is working, waiting, or
    used in the last hour. Each row is a normal `SessionRow` with title "General Counsel" and sub-line "Northwind Goods ·
    answering CEO". It collapses like Past.
  - Every position is in the Team view.
- **Tabs.** A position chat is a normal tab (`openSession(id)`), titled with the position name and a small role
  chip with the company. A tab is never opened by itself when an ask arrives.
- **Past and Elsewhere** leave out transcripts whose cwd is inside the team root (`history.js` and `external.js`
  get the root as an excluded prefix, like `isTempCwd`). Their chats are listed in Team view instead.

### 10.2 Team view

- **Header** (`.view-head`): company switcher (`.seg`; hidden with one company), counts ("2 need you"), [Talk to
  the CEO] (opens the newest CEO session in that company, or a new one in its first folder), [Open folder].
- **Org tree** (the main pane): an indented, collapsible tree list. Rows, not a drawn chart, because it must work
  at 320 px.
  - Each row:
    - disclosure chevron (if it has reports);
    - status `.dot` (working / waiting / idle / paused);
    - name;
    - one-line remit (`.hint`, ellipsis);
    - right-side chips: open items count, next duty ("Dec 1 · money check"), a `.chip.warn` "1 request" when an
      access request or proposal is pending;
    - last activity ("answered CEO 12m").
  - The CEO is the root row ("CEO · your chats in these folders", with the folder count).
  - Indent is 16 px per level on desktop and 12 px on phone. Beyond depth 3 on phone the indent stops growing and
    the row shows a breadcrumb prefix ("… › Tax Specialist ›"), so 320 px never overflows.
  - Collapse state is remembered per company (`helm.team.open.<company>`).
- **Desktop ≥ 1100 px:** two panes, tree left (min 320 px) and the selected position's detail right. Narrower
  desktop and phone: the tree is full width, and tapping a row opens the detail as its own screen with a back
  button.
- **Detail**, a `.seg` of sections:
  - **Overview**: remit, manager (link), reports (links), status, model, [Open chat], [Run duty ▾], [Pause] or
    [Resume]. Pause is operational and not a definition change, so it needs no proposal.
  - **Brief**: FileView-style view/edit of `brief.md`. Save writes it and logs an inbox line "Brief edited by you".
  - **Notebook**: same editor for `notebook.md`. Open items render as checkboxes in view mode; ticking one edits
    the file.
  - **Powers**: effective powers as plain rows (read: these folders; write: …; tools: chips; Bash: off), with
    "limited by General Counsel" marks. Below are grants from `grants.jsonl` and [Discuss a change with the CEO], which
    opens a CEO chat with a prefilled draft "I want to change Tax Specialist's powers: ". Powers have no direct
    edit form, by rule 9. You can still edit `position.json` by hand. Helm re-validates the file, and on error
    it keeps the last good version and shows why.
  - **Duties**: `panels/scheduled.js`-style rows (title, trigger in words, next run, last result, enabled toggle,
    [Run now]).
  - **Chats**: chat list (8.3).
  - **Cross-talk**: this position's slice of the log.
- **Company sections** under the tree (collapsed headers): **Proposals** (open cards, then decided), **Inbox**
  (duty reports, flags, created / retired notices; [Dismiss]), **Cross-talk** (rows "CEO → General Counsel · 14:02 · 'Does
  the privacy page…' · answered 3m 40s"; expand for the full Q and A; a chain shows nested).

### 10.3 Position tab header

The session header gets a slim line under the title: "Tax Specialist · reports to General Counsel · reports: Payroll Tax Specialist,
State Tax Analyst". Each name is a link that opens that position's tab. There is also a "1 question waiting" chip when
an ask is queued behind you (with the 5.3 banner action, not built yet). Context bar as today.

### 10.4 Cards in chats

All new cards are built from `PermissionCard`'s structure and classes. Resolved ones collapse to `Record`, like
today's requests.
- **Ask card** (CEO and manager chats): `mcp__team__team_ask` and `colleague_ask` tool items. Live state, elapsed
  time, a nested chain, [Open General Counsel] [Cancel question]; it collapses on answer (5.4).
- **Asked-by bubble** (answerer's chat): a user item with `origin: 'ask'`. Left-aligned, labelled "Asked by CEO ·
  Northwind Goods" or "Asked by General Counsel", with the handed files as chips. It is never styled as your right-hand
  bubble. Duty runs show as "Duty · Monthly money check (scheduled)". The seed shows as a one-line helm-note
  ("Fresh chat · seeded from notebook + handoff of chat 3").
- **Answer card** (late answers after Stop, 5.5): "General Counsel answered after you stopped" with [Show] [Send to CEO].
- **Proposal card**: title ("New position: Tax Specialist under General Counsel" | "Change General Counsel" | "Retire Contracts Manager" | "New
  company: Northwind Goods").
  - Body: remit, scope, powers as chips (with any excess over the manager in `.chip.danger`), duties in words, the
    brief under a disclosure (Markdown), and seed files.
  - An edit proposal shows a diff (brief text diff; powers and duties as added and removed chips).
  - Actions: [Approve] (`.btn-primary`), [Change…], [Decline]. Once decided it collapses to "Approved 14:02 (your
    click)" or "(your reply 'yes, make it')".
- **Access card**: a `request` item, `kind: "access"`. Who (with manager path), what, why, and [Approve once]
  [Approve always] (or "Approve always (also widens General Counsel)") [Deny] + note field. **Outward card**: same, with only
  [Approve once] [Deny], and the exact command or tool input in mono.
- **Phone.** Every card's actions wrap onto their own row at ≤ 393 px, with 44 px tap targets (`--tap`). The
  proposal brief stays collapsed by default. Checked at 393 × 852 and 320 × 700 by the overlap audit (12).

## 11. PROTOCOL.md additions

New section "Positions (lane positions)". The shapes below are the plan as written before the build; the shipped
shapes (more calls and fields, e.g. `team.proposals`, `limitedBy`, `team.access.updated`) are in PROTOCOL.md.

**Session fields**
```js
position?: { company: "northwind-goods", companyName: "Northwind Goods", id: "tax", name: "Tax Specialist",
             parent: "legal" | null, chat: 2, ended?: true }        // a position's chat
team?: { company: "northwind-goods", companyName: "Northwind Goods" }     // a CEO session (cwd matched a company)
```
**Item additions**
- `user` items: `origin?: "ask"|"duty"|"seed"|"answer"`, `ask?: { ticket, from: { kind: "ceo"|"position"|"owen",
  id?, name }, kind: "report"|"colleague" }`, `duty?: { id, title, trigger }`.
- `tool` items named `mcp__team__*`: `team?: { ticket?, proposal?, state, chain?: [{ ticket, to, name, state,
  sinceMs }] }`, patched live.
- `request` items: `kind: "access"` with `access: { kind, target, why, ancestors?: ["legal"], outward: boolean,
  waitMin: 30 }`. The answer is `sessions.respond { behavior: "allow", scope: "once"|"always" } | { behavior: "deny",
  message? }` (`always` is ignored for outward).
- New item `type: "team"`: `kind: "proposal"|"answer"|"notice"`, `proposal?: { id, action, title, draft, diff?,
  status: "open"|"approved"|"declined"|"superseded", decidedHow? }`, `answer?: { ticket, from, text }`.

**RPC**
| method | params -> result |
| --- | --- |
| `team.list` | `{}` -> `{ enabled, root, rootProblem?, companies: [{ id, name, folders, positions: n, needsYou: n }] }` |
| `team.get` | `{ company }` -> `{ company, tree: [{ id, name, parent, remit, status, depth, reports: [ids], openItems, nextDuty?, lastActivity?, pending: { requests, proposals } }], limits }` |
| `team.position` | `{ company, id }` -> `{ position (position.json + effective powers), chats, duties: [{ ..., nextAt, last }], grants: [...] }` |
| `team.file.read` | `{ company, id, file: "brief"\|"notebook" }` -> `{ text, mtime }` |
| `team.file.write` | `{ company, id, file, text, expectMtime }` -> `{ mtime }` (conflict -> code `conflict`; a backup `.bak` is kept like claude-config) |
| `team.open` | `{ company, id }` -> `{ sessionId }` (the current chat, created lazily) |
| `team.openCeo` | `{ company }` -> `{ sessionId }` |
| `team.decide` | `{ proposal, decision: "approve"\|"decline", note? }` -> `{ ok, created?, error? }` |
| `team.ask.cancel` | `{ ticket }` -> `{ state }` |
| `team.ask.release` | `{ ticket }` -> `{ state }` (5.3 "Let it answer now") |
| `team.answer.forward` | `{ sessionId, ticket }` -> `{ itemId }` (answer card "Send to CEO") |
| `team.duty.run` | `{ company, id, duty }` -> `{ ticket }` |
| `team.duty.toggle` | `{ company, id, duty, enabled }` -> `{ ok }` (on/off is operational, like pause) |
| `team.pause` | `{ company, id, paused }` -> `{ status }` |
| `team.crosstalk` | `{ company, position?, before?, limit? }` -> `{ entries: [folded by ticket] }` |
| `team.inbox` | `{ company }` -> `{ entries }`; `team.inbox.dismiss { company, ids }` |
| `team.openFolder` | `{ company, id? }` -> `{ ok }` (desktop only) |

**Events**
`team.updated { company }` (anything in the tree changed; the UI re-fetches `team.get`), `team.ask.updated
{ ticket, chain, state, from, to, sessionIds }`, `team.proposal.updated { company, proposal }`,
`team.inbox.appended { company, entry }`. Notify for push: `notify { kind: "waiting", source: "team", title,
body, sessionId? }` (push.js already passes `waiting`).

**Settings**
`team: { enabled: false, root: "~/helm-team", maxConcurrentRuns: 2, usageCeilingPct: 80, dutiesPaused: false }`
(Settings > Team; root validation per 2.1).

Mock: `ui/lib/mock-positions.js` (an "Example Co" company with a 3-level tree, an open proposal, an access request,
a live ask chain), wired by one `case 'team.*'` line in `transport.js`, like mock-handoff.

## 12. Build plan

Lanes are split by FILE so parallel agents never collide. The interfaces between them are fixed here, so round 1
can run in parallel. "Quick" means a local node test (seconds). "Heavy" means headless Chromium or Electron:
**cloud CI**. "Live" means a real claude.exe on the maintainer's own subscription: local only, because cloud CI has
no login, and costs are cents.

**Round 1 (parallel)**

| lane | files (owns) | tests |
| --- | --- | --- |
| T1 store | `main/engine/team/store.js` (team root, company/position read/write, atomic + versioned, fs.watch, JSONL logs), `main/engine/team/schema.js` (validation, slug, limits, path tokens), `main/engine/team/tree.js` (tree ops: depth, subtree, re-parent checks, effective powers), `docs/positions.example/**`, `test/engine/team-store.test.js`, `test/engine/team-tree.test.js` | quick: `node --test "test/engine/team-*.test.js"` (Node 24, glob form) |
| T2 isolation + match | `main/engine/team/options.js` (position SDK options from section 4, prompt + seed text, env scrub), `main/engine/team/match.js` (cwd → company, worktree `.git` file), `main/engine/team/house-rules.default.md`, `test/engine/team-options.test.js`, `test/engine/team-match.test.js`, `tools/team-isolation-live.js` (re-runs the section 4 probe through `options.js` itself) | quick unit; live `node tools/team-isolation-live.js` (haiku, ~$0.05, summary `team-isolation: N passed, M failed`) |
| T3 guard | `main/engine/team/guard.js` (PreToolUse hook: paths, tools, bash levels, outward classifier; uses prod-guard's exported `scan`/`assess` read-only), `test/engine/team-guard.test.js` | quick (table tests: path escapes via `..`, junctions, case; bash chains; outward hits; mcp names) |
| T4 runtime + MCP | `main/engine/team/runtime.js` (tickets, queues, delivery rules, wait graph, budgets, expiry, late answers, crosstalk log, rollover driver), `main/engine/team/mcp.js` (both servers, tool schemas, instructions text), `test/engine/team-runtime.test.js`, `test/engine/team-mcp.test.js` | quick, with fake sessions (the `turnWaiters` + `send` surface) and a fake clock |
| T5 duties | `main/engine/team/duties.js` (cron tick, catch-up, usage ceiling), `main/engine/team/refs-watch.js` (fs.watch on refs, debounce, for-each-ref diff), `test/engine/team-duties.test.js`, `test/engine/team-refs.test.js` | quick (temp git repos; fake clock) |
| T6 Team view | `ui/positions/team.js`, `ui/positions/tree.js`, `ui/positions/detail.js`, `ui/positions/notes.js` (FileView copy on `team.file.*`), `ui/positions/positions.css`, `ui/positions/state.js`, `ui/lib/positions-model.js`, `ui/lib/mock-positions.js`, `test/host/positions-model.test.js` | quick `npm run test:host`; heavy: shots via cloud CI |
| T7 chat cards | `ui/chat/team-cards.js` (Ask, Answer, Proposal cards, Asked-by bubble), `ui/chat/requests.js` (access kind + dispatch line), `ui/chat/chat.css` | quick (render model tests under test/host); heavy: shots via cloud CI |
| T8 protocol + settings | `docs/PROTOCOL.md` (section 11), `ui/lib/mock-data.js` (session `position` / `team` fields), `main/settings.js` (`team.*` keys + validation), `test/host/settings-team.test.js` | quick |

**Round 2 (after round 1 merges; two lanes, disjoint files)**

| lane | files | tests |
| --- | --- | --- |
| T9 engine wiring | `main/engine/session.js` (`_options()` branch: positions use team/options; CEO sessions add the `team` server; item `origin`/`ask` fields; seed note), `main/engine/index.js` (create runtime + duties, `team.*` methods, pass the team root to history/external excludes, CLI recycle after approval), `main/engine/handoff.js` (`prompt` option), `main/engine/history.js` + `main/engine/external.js` (excluded prefix), `test/engine/team-wiring.test.js` | quick: full `node --test "test/engine/*.test.js"`; live: `tools/team-live.js` (below) |
| T10 shell wiring | `ui/shell/chrome.js` (rail), `ui/shell/index.js` (`Mains`/`Phone` + `.plist-head` icon), `ui/shell/state.js`, `ui/shell/palette.js`, `ui/shell/shortcuts.js`, `ui/shell/sidebar.js` (Team section), `ui/lib/session-activity.js` (positions out of project groups), `ui/shell/home.js` (Team card), `ui/lib/icons.js`, `ui/index.html` (css link), `ui/lib/transport.js` (mock case line), `main/push.js` + `main/notify.js` (`source: "team"` titles) | quick `npm run test:host`; heavy: `tools/overlap-audit.js` with new `S('team')`, `S('team-detail')`, `S('team-cards')` screens at 1280/393/320, `tools/host-smoke.js`, via cloud CI |

**Round 3 (verification)**
- `tools/team-live.js` (new, modelled on verify-round3). It drives a hidden `--test` Helm.exe with a temp team
  root and live claude-haiku-5-5 turns. Live and local, ~$0.15. Summary `team-live: N passed, M failed`. Checks:
  1. a company proposal approved by RPC;
  2. a CEO session in its folder sees the roster (asks "who is on the team?");
  3. CEO→position ask answered, with the CEO card states seen;
  4. the position quotes no global CLAUDE.md, MEMORY.md or project CLAUDE.md (the section 4 question);
  5. guard denies a write outside powers, then `request_access` → approve once → the write succeeds;
  6. an outward Bash command is held for a card;
  7. a 3-level chain (CEO→A→B) with B's budget clamp;
  8. a cycle is refused;
  9. rollover with a test-only threshold override (`HELM_TEST_TEAM_ROLL_PCT=1`) creates chat 2 with seed;
  10. a commit in a temp repo fires an event duty within 60 s;
  11. a schedule duty missed while closed runs once after restart.
- cloud CI: overlap-audit + shots for the three team screens at 1280, 393 and 320, and host-smoke. Judge by
  `overlap-audit: … 0 new` and the PNGs.
- The owner's own look at the real app, after merge. Helm restarts only when the owner says.

## 13. Risks

| risk | handling |
| --- | --- |
| SDK MCP across the broker re-attach (Keep sessions running) | read from the SDK, not yet probed live: the server is re-registered by name on re-attach, but a call in flight at a crash has no responder. Mitigation: server timeout 660 s, so the orphaned call ends; tickets are persisted, so the answer still arrives as a late answer. T9 adds a forced-restart check to `team-live.js` |
| Parallel tool calls while a team call waits | not probed; nothing depends on it (a waiting CEO turn simply waits) |
| How the CLI frames host-injected `channel` / `task-notification` messages | not probed; the design uses the proven `es.send({ origin: 'helm' })` path for late answers instead |
| Recorded system prompt can't change mid-chat | roster/brief/powers changes ride `<helm-note>`s; the hook reads live powers, so enforcement is never stale |
| Bash path checks are best-effort | Bash `on` only for coding positions, which default to their own worktree; outward classifier on every level |
| Cost and usage limits: every ask is a position turn (Opus by default) | per-run cost in logs; rate limits (5.6); `usageCeilingPct`; idle positions cost 0; model per position in its proposal |
| RAM on a laptop | `maxConcurrentRuns` 2; idle reaper closes position CLIs like any other |
| A position quotes a notebook fact into an answer the asker shouldn't have | house rule 5 (share only what the question needs); all answers are logged for you to see |
| Prompt injection from handed files / web pages | no outward tools; outward Bash always asks; writes only in its area |
| Loss of your global safety rules in positions | `house-rules.md` restates the ones that matter (report faithfully; outward needs your OK; say what was not verified) |
| A stale `position.json` hand-edit breaks the schema | re-validated on change; the last good version stays in force; Team view says why |
| Deep chains are slow | depth cap 5; shrinking budgets; live chain card; pending + late delivery |
| Positions see claude.ai connectors (mail, trading and other account connectors) | measured in section 4; switched off by config, not by prompt |

## 14. Decisions made (not questions) and the open questions for the owner

Decided here (summary of the **Decided** marks): team root `~/helm-team`; flat position folders + `parent` field;
depth cap 5, 10 reports per manager, 30 per company; the chain of command for the CEO's asks (direct reports only)
and colleague asks for narrow questions; non-blocking proposal cards with typed-yes approval; positions' proposals
surface in Team view + their own chat + push, not injected into a CEO chat; MCP over SendMessage; positions in
bypassPermissions with the hook as the gate; outward never "always"; managers cannot grant; coding positions in
worktrees; duties in Helm's main process with catch-up once; event triggers via fs.watch on refs; rollover at 32%
at a quiet moment (40% at once); old chats read-only with a link to the current one; Stop keeps the ticket alive
but starts no turn; usage ceiling 80% for duties; position auto-memory off (the notebook is the only memory);
no `CLAUDE_CONFIG_DIR` (no credentials copy, no logout risk).

Tree decisions:
- Any position can have reports; the depth cap is 5, with 10 direct reports per manager and 30 live positions per
  company.
- IDs are flat and unique per company; the tree is the `parent` field.
- A manager knows only its direct reports (name + remit) and asks only them. Deeper positions can be looked up with
  `team_roster({ under })`.
- Nested asks use a shrinking sync budget (45 s margin per level; under 30 s returns pending at once).
- A chain may hold 8 tickets and expires 2 h after the root ask; `ask_followup` carries late sub-answers up.
- Effective powers = own ∩ every ancestor's. "Approve always" beyond the manager says which ancestors it widens.
- Access requests from any level go to you; managers cannot grant.
- Re-parenting is an edit proposal. Retiring a manager moves its reports up by default.

Open questions for the owner (each has a default that ships if nobody decides otherwise):
1. **Connectors.** Should any position ever reach your claude.ai connectors (mail drafts for the Marketing Manager, a calendar,
   etc.)?
   - Default: no. Positions draft into files, and the CEO or you send. They are switched off by config today
     (section 4).
   - If yes, the `tools` allowlist can admit single connector tools (e.g. a mail *create draft* tool) per
     position, with every send still held for your OK.
2. **Backup.** Should `~/helm-team` (briefs, notebooks, logs) be backed up to a PRIVATE git repo? Default: no git
   at all, local folder only.
