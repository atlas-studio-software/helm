# Helm guide

Short how-tos. Shortcuts are written with Ctrl; the full table is in the [README](../README.md).

## Home

Helm opens on Home: your wallpaper with no blur, a greeting and the time, and your sessions as cards.

- Get there by clicking the **Helm logo** in the top-left corner, with **Ctrl+Shift+H**, or with **Go home** in the
  command palette (**Ctrl+K**). Closing your last tab also lands here.
- The row under the greeting shows how many sessions are working now (one with only agents running counts),
  how many need you, your **5H** and **Week** usage, and **Active today** (the same count as Usage → Active hours).
- **Jump back in** has a card per session: your open tabs first, in tab order, then your other active sessions.
  The dot is the session's status, and a session waiting on you has an amber edge and says **Needs you**.
  The line underneath says what it is doing, how long it has run, how many agents are running and the time left
  when the eta mod has an estimate. Click a card to open the session as a tab.
- **New session** starts one, as **Ctrl+N** does.
- Only the top bar stays on Home: tabs, search and the update chip all still work. Clicking a tab or card, or using
  **Ctrl+Tab**, **Ctrl+1–9**, the palette or a notification, brings the panels and the blur back. **Ctrl+H**,
  **Ctrl+,** and **Ctrl+Shift+D** open History, Settings and Deck; pressing the same key again comes back to Home.
  The sidebar button (or **Ctrl+B**) leaves Home with the sidebar open.
- Your tabs come back after a restart. Helm still opens on Home, with none of them active.
- On the phone, **Home** is the first item in the bottom bar and the phone opens there too. The cards stack in
  one column, and tapping the Helm mark on the Sessions list also goes Home.
- If your system is set to reduce motion, Home appears and disappears instantly instead of fading.

## Sign in (Settings → Account)

Helm never signs you in. Its sessions use whatever your installed Claude Code is signed in with: your
Claude account or your own API key.

- To sign in, open a terminal, run `claude`, and sign in there. Then press **Check again** in
  Settings → Account.
- Settings → Account shows what Claude Code reports: signed in or not, the method, plan, email and
  organization. Helm checks at startup, when you open the panel, and after a session fails because
  Claude Code isn't signed in.
- Optional: paste an Anthropic API key there to make sessions use it instead. Helm shows only its last
  4 characters. **Remove key and use Claude Code's sign-in** goes back to it. Running sessions restart onto the change.
- With an API key, a Console login or a cloud provider there are no 5-hour or weekly limits: the usage
  panels show cost and say so.

## Start a session in a project

1. Press **Ctrl+N** (or **New session** on the welcome screen, or the **+** next to a project in the sidebar).
2. Pick the project folder (type a path or **Browse…**).
3. Choose model, effort and permission mode. The defaults come from Settings → New session defaults.
4. Optionally type a first prompt, then **Start session** (or Ctrl+Enter).

The session appears under its project in the sidebar. It is a real Claude Code session, so the
project's `CLAUDE.md`, your hooks, MCP servers and skills all load.

## Answer a question or a permission request

When Claude needs you, the session's dot turns to "waiting", the sidebar shows a badge, and (if
the window isn't focused) a Windows notification appears. Clicking it opens the session.

- **Permission**: **Allow**, **Allow for this session** (stops asking for that tool), or type a reason and **Deny** (Enter in the reason box also denies).
- **Question**: click options, or press **1–9**; the number after the last option is "Other" with a text box. **Enter** or **Submit** sends.

## Approve a plan

In plan mode, Claude ends with a "Ready to code?" card showing the plan.

- **Approve** starts work with your current permission mode.
- **Approve + auto-accept edits** starts work and lets file edits through without asking.
- **Approve + bypass permissions…** asks once more (an inline warning), then starts work with every
  tool allowed for the rest of the session. Change the mode back from the composer any time.
- **Keep planning** opens a box: say what to change, then **Send feedback** (or Ctrl+Enter).

## Send a message while it works

Just type and press **Enter** while Claude is working. Claude reads the message at its next step
(after the current tool call): the turn is not interrupted and background agents keep running.
Slash commands, and the moments a session is starting, compacting or being stopped, can't go in
mid-turn: those messages wait instead, a "N queued" chip shows next to the context meter, and
they are sent as soon as the current turn ends. This works from the phone and the quick-prompt
box too.

## Talk instead of typing

Click the **mic** in the composer (or press **Ctrl+M**), speak, then click it or press **Ctrl+M**
again. Holding Ctrl+M (or the mic) and letting go works as push-to-talk; **Esc** throws the
take away. The words land at the cursor and are never sent by themselves, so you can fix them
first. The line above the buttons shows what is happening: listening with a timer and a level
meter, transcribing, or the reason it could not (mic blocked, no mic, nothing heard, engine
missing) with **Try again**.

It runs Whisper (`base.en`) on this PC: nothing goes to a cloud service and no audio is saved.
The first take after a while loads the model (a few seconds, while you talk). On the phone the
audio goes over Tailscale to the laptop's Whisper; the phone needs the `https://` link for the mic.
If the line says the engine is missing, install it once: `py -m pip install faster-whisper`.

## Stop a turn

With the composer empty, press **Esc** in the composer or click the square stop button. This
interrupts the current turn; the session stays open and you can keep talking.

To end the whole Claude process for a session, use the session's **⋯** menu → **Stop session**.
It can be resumed later from History.

## Find, archive and delete sessions

- **Filter**: the box at the top of the sidebar (**Ctrl+Shift+F**) filters by title, project or
  folder as you type; Enter opens the first match, Esc clears it. The **Working / Waiting / Error**
  chips show only sessions in that state (combine them freely).
- **Archive** (session menu, the **...** on a row or in the header): stops its Claude Code and
  moves it into the collapsed **Archived** group at the end of the list. Open it to read it; send a
  message to resume it, which also brings it back. **Unarchive** puts it back without starting anything.
- **Close**: stops its Claude Code now; the session stays in the list and resumes on your next message.
- **Delete from Helm…**: removes Helm's record after a confirm. Claude Code's own transcript is
  never touched, so the conversation is still in History and can be resumed.
- **Several at once**: Ctrl-click rows to pick them (the open one joins the first pick), Shift-click
  for a range, then **Archive** (or the bin) in the bar at the bottom. Esc clears the selection.
- Sessions idle for over a week get a quiet "N sessions idle for over a week · Archive them" link at
  the end of the list. Nothing is archived unless you click it.
- **Projects**: a group header's **...** menu pins the project to the top or renames it (only
  Helm's label; the folder is unchanged).
- **Copy link** gives `helm://session/<id>`: opening it (Win+R, a note, a shortcut) brings Helm up
  on that session. **Copy Helm session id** is the id for `helm --session=<id>`.

## Split two sessions

- **Ctrl+Shift+\\** opens the previous session beside the current one (press again to close the other pane).
- Or: a session's **⋯** menu → **Split with …**, a sidebar row's menu → **Open side by side**, or drag a session from the sidebar onto a pane.

The pane you click is the focused one: the inspector, palette and Ctrl+1–9 follow it. Desktop only.

## Four sessions at once (4 corners)

- The layout switch left of **Search** in the top bar picks **1** pane, **2** side by side or **4** corners;
  **Ctrl+Shift+4** turns 4 corners on (and back), or use the palette's **Layout:** commands.
- Picking 4 keeps the session you are on in the top-left corner and fills the others with your tabs in order.
- Each corner has its own header (title, state, context %) and message box, so you can reply in any of them.
- Drag a tab down onto a corner (or a sidebar row) to put it there; if it is already in another corner the two
  swap. An empty corner says **Drag a tab here** and lists open tabs and recent sessions to click in.
- A corner's **×** empties it (the tab stays open); closing a corner's tab empties that corner too. The layout
  stays either way and comes back after a restart or a trip to Home.
- The right panel hides while the corners show; **Ctrl+\\** brings it back. Below about 1100 px wide only the
  focused corner's row shows; widen the window and all four return.

## Tabs

The sessions you are using sit as tabs in the top bar, like a terminal's tabs. Desktop only; the phone keeps its list.

- Opening a session from anywhere (sidebar, Past, palette, a notification, a `helm://` link) adds it as a tab at the end and shows it. **+** starts a new session.
- Closing a tab (**×**, middle-click or **Ctrl+W**) takes it off the bar. The session stays in the sidebar, exactly where it was. The tab next to it takes over; with no tabs you get the home screen.
- Closing a tab also closes that session's Claude process if nothing is running in it, to free memory, even when **Close idle sessions after** is set to Never. Your next message picks the conversation up where it left off; just looking at the session again does not restart anything.
  - If it is still working (a reply, agents, background tasks, a `!` command, queued messages, or a question or permission waiting for you), nothing is interrupted: the process closes within a minute of the work finishing.
  - A `/loop` or scheduled session keeps its process, so its next tick still runs.
  - It is left alone while the session is still on screen: in the other half of a split, or open on the phone. Opening the tab again or sending it a message cancels the pending close.
- Drag a tab to reorder it. **Ctrl+Tab** / **Ctrl+Shift+Tab** step through tabs, **Ctrl+1–8** jump to that tab, **Ctrl+9** to the last one.
- Each tab shows its status dot (a waiting tab is tinted amber) and, while agents run, a small agent count. Hover for the full title and folder.
- Tabs and their order come back after a restart. Helm opens on [Home](#home) with none of them active. Search moved to the right of the bar (**Ctrl+K** as before).

## Find in a session

Press **Ctrl+F**. Matches include text inside collapsed tool and agent cards (they open as you
step to them). **Enter** = next, **Shift+Enter** = previous, **Esc** closes. If the match might be
further back, use the button that loads earlier messages and keeps searching.

## Fork, edit & resend, rewind to here

Hover one of your messages (long-press on the phone):

- **Fork from here**: a new session with the conversation up to, but not including, that message. The original is untouched.
- **Edit & resend**: edit the text; Helm forks at that message and sends your edited version in the new session. The original is untouched.
- **Rewind to here**: opens the rewind dialog at that message's checkpoint (see "Review changes"). If Claude Code recorded no checkpoint there, Helm says so; fork instead.

## Watch agents and the 32% / 40% context marks

Open the inspector (**Ctrl+\\**) → **Agents**. Each sub-agent shows its status, tool count, last
tool and a context bar. The bar spans 0–50% of the window with marks at **32%** (hand off to a
fresh agent) and **40%** (hard ceiling). Click an agent to jump to it in the conversation. The
toggle at the top lists every session's agents instead of just this one.

## Review changes and rewind files

Inspector → **Changes** lists the files this session changed with +/- counts. Click one for its
diff against git HEAD (switch to side by side if you like). Under **Checkpoints**, pick one and
**Rewind…**, then choose **Files only**, **Conversation only** or **Both**. The dialog spells out
exactly which files go back and what is lost. Stop the running turn first; rewinding during a
turn is refused.

## Preview a localhost app

Inspector → **Preview**. Localhost addresses Claude mentions in the session are offered as
one-click picks; or type `3000`, `:3000` or `localhost:3000` in the address bar. The page runs in
its own sandbox; links that open new windows go to your normal browser, and the arrow button
opens the current page there too. On the phone, `localhost` means the phone itself, so Helm
offers the PC's address instead.

## Usage history

The Usage panel's **History** shows the 5-hour window over the last 24 hours (thin marks where
it reset; a gap means Helm was not running), the week over the last 7 days, and cost per day for
the last 14 days. Hover or tap a bar for that day's cost by project. Helm records a reading every
5 minutes while it runs (and whenever usage changes), kept for 14 days in
`usage-history.jsonl` in its profile folder.

## Queue overnight work

Inspector → **Queue** (on the phone, the Queue tab) → **New job**.

1. Write the prompt; pick project, model, effort and permissions.
2. **Start**: "When budget allows" or "After a time".
3. **Don't start above**: the 5-hour usage % a job may start under. Without 5-hour limits (API key,
   Console login or cloud provider) this gate is skipped.

Helm checks every minute and runs one job at a time as a normal session. A waiting job says why
it hasn't started. Done jobs keep a summary; **Open session** shows the full run. Helm must be
running (the tray is enough); the PC must be awake.

## Resume a past session

**Ctrl+H** (or the History item). Search by title, prompt or project; **Resume** reopens it as a
Helm session with its full history. If it is already open in Helm, the button says **Open**.
Sessions run from a temp folder (scratch and test runs) are hidden; **Include temp folders** shows them.

## Watch terminal sessions (Elsewhere)

Claude Code sessions you run in a terminal appear in the sidebar's **Elsewhere** section: active
ones first, then recent idle ones. Click one to read its transcript live (read-only) with its ETA
and agent count. When the terminal session is idle, **Resume in Helm** takes it over. Helm will not
offer that while the terminal is still writing to it.

## Quick prompt from anywhere

Press **Ctrl+Alt+Space** (change or clear it in Settings → Startup & shortcuts). A small box
appears over whatever you are doing. Type, pick an open session or "New session in <project>"
from the drop-down, press **Enter**. The box hides itself a moment later; the confirmation has a
link to open that session. **Esc** hides it. Also from `helm --quick` or the tray menu.

## Change the background

Settings → Appearance. Click any photo (it applies immediately), filter by category, or
**Shuffle**. **Add photo** (or drop an image on the gallery) uses your own JPEG, PNG or WebP up
to 15 MB. Adjust **Blur** and **Dim**, and pick the theme: dark, light or system. [Home](#home) shows the
photo without blur. Dim still applies.

## Use it from the phone

One-time setup is in the README ("Phone setup"): Tailscale on both devices, run
`bin\firewall.ps1` from an elevated PowerShell, then Settings → Phone → **Allow phone access**
and scan the QR code. The phone gets a bottom bar (Home, Sessions, History, Queue, Settings); the
panels button in a session's header opens the inspector as a sheet. On the phone, Enter adds a new
line; use the send button.

## Positions (AI staff for a company)

Positions give a company a staff of Claude sessions, each with one job (General Counsel, Marketing Manager, Controller…), arranged as
an org tree under the CEO. It is off until you turn it on.

### Turn it on

- Open **Settings → Team** and switch on **Positions**. While it is off, no session gets the team tools and no duty
  runs.
- **Team folder** (default `~/helm-team`) is where every company's briefs, notebooks and logs live. It must be
  outside every git repo and every company folder; if Helm can't use the folder you type, it says why under the box.
- The same panel has **Pause all duties**, **Duties wait at usage** (default 80%), **Position replies at once**
  (default 2; each reply is its own Claude Code process) and, under **Advanced**, the two context marks where a
  position's chat moves to a fresh one (32% and 40%).
- To start a company, open a Helm chat in one of its folders and ask Claude to propose a company: its name and its
  folders. A **New company** card appears in that chat; approve it, and that chat becomes the company's CEO.

### Company, CEO and positions

- A **company** is a name and the folders that belong to it, for example a website repo and two app repos. Each
  company has its own team. A folder belongs to one company at most.
- The **CEO** is not a separate thing you create. Any normal Helm session whose folder is inside one of the
  company's folders (or a git worktree of one) is that company's CEO. It works exactly as before, with all of your
  own Claude Code setup. On top of that it knows its direct reports (name and one-line remit) and can ask them.
- A **position** is a Claude session with one fixed role. It works in its own folder in the team folder, outside
  every repo. Its brief is its job description and its notebook is its memory.
- A position gets none of your own setup: no global or project CLAUDE.md, no memory files, no mods, plugins,
  skills or hooks, none of your MCP servers and no claude.ai connectors. It knows only its brief, its notebook,
  Helm's house rules and the questions it is asked.
- A position can have its own reports (General Counsel → Tax Specialist → …), down to 5 levels under the CEO. A manager has
  at most 10 direct reports, and a company at most 30 positions.

### Ask a position through the CEO

- In a CEO chat, just bring the topic up. The CEO passes the question to the right direct report, with the context
  it needs and any files it hands over. Handed files are read-only, and only for that question.
- The position sees only that question, never the rest of the CEO's chat. The CEO gets back only the answer, never
  the position's chat or notebook.
- The chain of command is real: the CEO asks only its direct reports. If General Counsel needs Tax Specialist, General Counsel asks it,
  and each level passes its own answer up.
- The CEO's chat shows an **Ask card**: who is being asked, what is happening now ("queued", "General Counsel is working ·
  2m", "General Counsel asked Tax Specialist · 1m"), **Open General Counsel** and **Cancel question**. When the answer comes, the card
  folds to one line with the answer under it.
- The CEO waits up to 5 minutes. A slower answer comes back as "pending" first; the answer then arrives in the same
  chat as a Helm message, and the CEO passes it on to you.
- If you press **Stop** while the CEO waits, the question stays open. When the answer comes, an answer card says
  "General Counsel answered after you stopped", with **Show** and **Send to CEO**.
- A question still open 2 hours after it was asked expires. Questions survive a Helm restart; the answer then
  arrives as a late answer.
- Limits stop runaway loops: 20 questions an hour from one position, 200 a day per company, at most 8 questions in
  one chain. A loop (A waits on B, B asks A) is refused at once.

### Talk to a position yourself

- Open it with **Open chat** in the Team view, or from the sidebar's **Team** section (positions that are working,
  waiting or were used in the last hour). It is a normal tab named after the position.
- A position has one ongoing chat. The line under its title says who it reports to and who reports to it; each
  name opens that position.
- Your own messages always go first. A question from the CEO or a colleague is not delivered while you are using
  the tab (you sent or typed something there in the last 90 seconds while it was on screen). It waits until you
  leave the tab alone, and the asker's Ask card shows it as queued meanwhile. A question never cuts into a reply
  that is running.
- Questions show as "Asked by CEO" (or "Asked by General Counsel") bubbles on the left, never as yours. Duty runs show as
  "Duty · …".
- A position never opens a tab by itself when a question arrives.

### The Team view

- Open it with the **Team** rail button, **Ctrl+Shift+T** (press again to go back) or **Open Team** in the command
  palette. The rail button's badge counts everything waiting for you: access requests, open proposals and Inbox
  reports that need you.
- Home shows a **Team** card per company while something there needs you ("2 need you"), first in **Jump back in**;
  click it to open that company's Team view.
- The sidebar has a **Team** section after your projects: position chats that are working, waiting or were used in
  the last hour, each named after its position with the company on the line underneath. Its people icon opens the
  Team view, which lists every position. CEO chats stay in their project groups.
- On the phone, use the Team icon in the Sessions header (shown while Positions is on) or the Home card.
- The header has the company switcher (when there is more than one), what needs you and what is working, **Talk to
  the CEO** (opens the company's most recently used CEO chat, or starts one in its first folder) and, on the
  desktop, a folder button that opens the company's team folder.
- The tree starts with the CEO row. Each position row shows its name, status and last activity, its remit, and
  chips for what waits for you (**1 request**, **1 proposal**), open notebook items and the next duty. Rows with
  reports fold open and closed.
- Click a row for its detail. The top has **Open chat**, **Run duty** and **Pause** / **Resume**; the tabs are
  **Overview** (status, manager, reports, scope, model, open items, next duty), **Brief**, **Notebook**, **Powers**,
  **Duties**, **Chats** and **Cross-talk**. On a narrow window or the phone the detail opens as its own screen.
- **Pause** stops a position's duties and turns away questions to it ("paused"). You can still chat with it.
- Under the tree: **Proposals**, **Inbox** (duty reports, flags, created and retired notices; **Dismiss**) and
  **Cross-talk** (every question and answer at every level, with chains nested).

### Briefs and notebooks

- Everything lives in the team folder, `~/helm-team` by default. **Settings → Team** can move it; Helm refuses a
  folder inside a git repo or a company folder, and says why. Helm never makes it a git repo; back it up as you like.
- Each position has a folder `~/helm-team/<company>/positions/<id>/` with `position.json` (its definition),
  `brief.md`, `notebook.md`, `chats.json` and `work/drafts/`. The `README.md` at the top says what every file is.
  `house-rules.md` holds the rules every position gets; you may edit it.
- **brief.md** is the job description: what the role covers, what it must not do, the sources it trusts. Edit it
  in Team view → **Brief** or in any editor. The position gets the new brief with its next message.
- **notebook.md** is the position's only memory, under four headings: **Decisions**, **Facts** (each with its
  source and date), **Open items** (checkboxes; the Team view counts the open ones, and you can tick them in view
  mode) and **Log** (the newest 200 lines; older ones move to `notebook-log-archive.md`).
- The position writes its notebook itself. When you edit it, the position gets your change with its next message.
- A brief or notebook is never shown to the CEO or to another position.
- Team view saves keep the previous text as a `.bak`. Helm also keeps the last 10 versions of `position.json`. If
  a hand edit of `position.json` breaks it, the last good version stays in force and the Team view says why.

### Chats rolling over

- At **32%** of its context, a position moves to a fresh chat at its next quiet moment: no reply running, nothing
  waiting on you, and you not active in its tab for 2 minutes. At **40%** it moves as soon as the current reply
  ends. Never in the middle of a reply.
- First it writes into its notebook whatever is not there yet, then a short handoff. The new chat starts from the
  notebook and that handoff.
- Team view → **Chats** lists every chat with how full it got and its handoff, if it wrote one. **Open** goes to
  the current chat; **View** opens an old one to scroll back. An old chat takes no new messages: the position goes
  on in its newest chat.
- If the handoff fails twice, the new chat starts from the notebook alone and the Inbox says so. No chat is ever
  deleted.

### Duties

- A duty is a standing job: on a **schedule** (for example 9:00 on the 1st of each month) or on an **event**: a new
  commit on a branch (optionally only for some files), a new tag, or a file whose content changed.
- Duties run from Helm, so Helm must be running (the tray is enough). A schedule missed while Helm was closed runs
  once when it starts, if it is still within its window (a day for daily duties, a week for weekly or longer);
  otherwise the Inbox says it was missed.
- Event checks cost nothing while nothing changes: Helm watches only what enabled duties name (a repo's git refs,
  or one file), never anything else.
- A duty drafts; it never sends. It ends with a report in the Inbox, and a phone push when it needs you.
- Duties wait while your 5-hour usage is at **80%** or more, and at most 2 position replies run at once (both in
  **Settings → Team**). **Settings → Team** can also pause all duties.
- Team view → **Duties** lists each one with its next run and last result, an on/off switch and **Run now**. Adding
  or changing a duty is a proposal.

### Colleague questions

- Any position can ask any other position in the same company one narrow question: at most 2,000 characters and 3
  handed files, never a hand-over of its work.
- The answerer sees only the question, the asker only the answer. Every exchange is in **Cross-talk**.

### Powers and access requests

- Each position has **powers**: the folders it may read, the folders it may write (its own folder by default), its
  tools, Bash (off, read-only or on) and whether it may use agents. The Team view's **Powers** section shows them in
  plain words.
- A report never has more than its manager. Narrowing a manager narrows everyone under it at once; the Team view
  marks those powers "limited by General Counsel".
- Coding positions work in their own git worktree, so their edits never touch your live folder. Merging is yours,
  with the normal worktree merge.
- When a position needs more, it asks. An **access card** appears in its chat (and as a chip on its row, a toast
  and a phone push), saying who, what and why:
  - **Approve once**: for the current reply only (for a duty, the whole run; for a question, until it is
    answered).
  - **Approve always**: saved into the position's definition. If that goes beyond its manager, the button reads
    "Approve always (also widens General Counsel)" and widens those managers too.
  - **Deny**: with an optional note. The position carries on without it and may ask again later.
  - No answer in 30 minutes counts as no; the position carries on and notes it as an open item.
- Every request comes to you. A manager can never grant its reports anything.
- Powers have no edit form. To change them, use **Discuss a change with the CEO** under Powers, or edit
  `position.json` by hand.

### New positions: proposed, then approved

- When a topic (legal, money, marketing, support…) comes up a second or third time and no position covers it, the
  CEO suggests one in plain words. It proposes only once you want it. A manager can likewise propose a report under
  itself. A session that is in no company can propose a new company.
- A position's **name is a real job title**: what that person would be called at a real company (General Counsel,
  Controller, Marketing Manager, Business Development Representative, Tax Specialist), never a topic or department
  label ("Legal", "Money & Paperwork", "Leads & Outreach"). The remit says what it covers. The CEO and managers are
  told this, and a card whose name looks like a bare department label carries a note saying so.
- A proposal is a **proposal card**: the title ("New position: Tax Specialist under General Counsel"), remit, scope, powers
  (anything beyond the manager in red: it is cut when you approve), duties in words, the brief (folded) and the
  files it would read first. A change shows what is added and removed.
  - **Approve**: Helm writes the files.
  - **Change…**: your text goes to the proposing session as your message, and it can propose again.
  - **Decline**: with an optional note.
- Typing "yes" (or "approve", "go ahead") in that chat also approves, but only when it is your own message, exactly
  one proposal is open there, and the card was the last thing shown. The card then says "Approved … (your reply
  '…')". Anything unclear leaves the card open.
- A proposal from the CEO shows in that CEO chat and in Team view → **Proposals**. A proposal from a position shows
  in its own chat, in Team view → **Proposals** (counted in the Team button's badge) and as a phone push. Neither
  starts a CEO chat by itself.
- In Team view → **Proposals** each open card has **Approve**, **Decline** (with an optional note) and, when a chat
  proposed it, **Discuss**, which opens that chat. Decided cards stay listed under **Decided** for 7 days.
- Nothing is created, changed or retired until you approve. A retired position's folder moves to `retired/` with its
  chats still readable; its reports move up to its manager unless the card says otherwise. A position with open
  questions can't be retired until they settle.
- A new position with starting files reads them once and notes what matters to its job.

### Import proposals from a file

If you drafted a team elsewhere, load it as open proposal cards instead of asking for each one in chat:

```
node tools/team-import-proposals.js <file.json> [--dry-run] [--port N] [--user-data <dir>]
```

- Import into a company that already exists (start it from a chat first, as in "Turn it on"), or put a **New
  company** item first in the file. That card then waits in the Team view like the others; approve it first, and the
  company's other cards follow.
- The file is JSON: `"kind": "helm-team-proposals"`, the `company` id, and a `proposals` list. Each item has a
  `team_propose` object with an `action` (`create`, `edit` or `retire`), a `why` (one or two lines for the card)
  and the same fields a chat proposal takes (`name`, `parent`, `remit`, `scope`, `powers`, `duties`,
  `brief`…; `edit` and `retire` need the position's `id`). An item may also carry a `ref` (a label for the output),
  a `status` (only `pending` items load) and a `notebook_md` to start a new position's notebook with.
- `--dry-run` only reads the file; Helm need not be running. It prints `company: <id>`, one `ok` line per item that
  would load (`ok    legal: create legal "General Counsel" parent=(CEO)`), one `skip` line with the reason for each item that
  would not, and last `team-import: N valid, M skipped`.
- Without `--dry-run`, Helm must be running with Positions on. The tool reads Helm's token from its user data folder
  (`%APPDATA%\Helm` unless you pass `--user-data`) and talks to it on port 4871 (or `--port`). It prints one `open`
  line per card it opened, a `skip` line for anything refused (for example a card already open for the same
  position), and the same summary line.
- Nothing is approved by importing. The cards wait in Team view → **Proposals** of that company, counted in the
  Team badge and the Home card, until you approve or decline each one. They show as proposed by the file's
  `draftedBy`, or "import".

### Phone pushes and toasts

Team notices count as **Needs you** notifications (Settings → Notifications). Like any other, they show as a desktop
toast while Helm's window isn't focused, and go to the phone (after phone setup, with notifications turned on
there) only while the desktop window isn't focused and the Helm page isn't open on the phone. What they say:

| When | Title | Text |
| --- | --- | --- |
| A position asks for access | "General Counsel asks for read access" (or write access, "the WebFetch tool", "Bash …") | what it asks for and why |
| A position wants to do something outward | "General Counsel asks to run an outward action" | the command, then "Leaves the machine: …" |
| A position proposes a report or a change | "General Counsel proposes a new report: Tax Specialist" ("… retiring Tax Specialist", "… a change to Tax Specialist") | the proposal's why |
| A duty report needs you | "General Counsel needs you" | the start of the report |

Proposals from the CEO and imported ones don't push; they wait in the CEO chat and the Team view.

### What a position never does without your OK

- Anything outward: sending email or messages, posting, paying or buying, pushing, deploying, publishing a release
  or package, or anything else that leaves the machine in your name. Each one shows an outward card with the exact
  command and only **Approve once** / **Deny**; there is no "always". No answer in 30 minutes means no.
- Read or write outside its powers, or use a tool it doesn't have.
- Create, change or retire a position or company, or change its own powers.
- Reach your claude.ai connectors or MCP servers (switched off for positions, not just discouraged).
- Merge its worktree into your live branch.
- Message other sessions outside Helm's log, or schedule its own jobs inside Claude.

## If something goes wrong

**"Claude Code isn't signed in"**
- Open a terminal, run `claude`, and sign in there; then press **Check again** in Settings → Account.
  Until then new messages are refused and queued jobs wait. Helm has no sign-in button.
- If the panel says it couldn't check, nothing is blocked: a session that fails shows Claude Code's own error.

**The phone can't connect**
- "Not paired" banner: the key is wrong or old. Re-scan the QR code from Settings → Phone on the PC.
- Settings → Phone says "Waiting for Tailscale": the PC isn't on the tailnet. Helm rechecks every minute.
- Page won't load at all: check Tailscale is on for both devices and the firewall rule exists (re-run `bin\firewall.ps1` elevated).
- The phone link must use port 4871. If another program held 4871 when Helm started, Helm picked a random port and the firewall rule won't match; the log says "port 4871 in use". Free the port and restart Helm.

**A "stand-in engine" banner at the top**
- The real engine did not load, so sessions are not running Claude Code. The banner says why and
  where the log is (**Copy log path**). Fix the cause it names, then quit Helm from the tray and start it again.

**The window won't open**
- Helm is probably already running in the tray (closing the window only hides it). Click the tray icon or launch Helm again; a second launch focuses the first.
- To restart cleanly: tray icon → right-click → **Quit Helm**, then start it again.
- Look at `%APPDATA%\Helm\logs\main.log` for "boot failed", "load failed" or "renderer gone". If Helm can't start at all it shows a "Helm could not start" error box.
