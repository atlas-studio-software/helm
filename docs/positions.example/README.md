# Example team root

A fictional company, **Northwind Goods**, laid out exactly as Helm keeps a real team root (default `~/helm-team`,
see `docs/POSITIONS.md` section 2). The tests in `test/engine/team-store.test.js` and `team-tree.test.js` copy this
folder to a temp dir and load it. The folders `C:/Users/you/...` are placeholders.

```
northwind-goods/
  company.json                 the company: id, name, folders
  proposals.jsonl              every proposal and its decision (append-only)
  crosstalk.jsonl              every ask and answer (append-only; one line per state change)
  grants.jsonl                 access requests and decisions
  inbox.jsonl                  duty reports and flags for the owner
  duty-runs.jsonl              every duty run
  positions/
    legal/                     Legal (reports to the CEO)
      position.json            name, remit, parent, scope, powers, duties, version
      brief.md                 the job description (goes in the position's system prompt)
      notebook.md              the position's memory: Decisions / Facts / Open items / Log
      chats.json               its chats, oldest first (chat 1 ended "full", chat 2 is current)
      work/drafts/             its drafts and outputs
    tax/                       Tax Specialist (reports to Legal)
    payroll-tax/               Payroll Tax (reports to Tax Specialist): the third level
    marketing/                 Marketing (reports to the CEO; a release duty that drafts, never posts)
    app-qa/                    App QA (a paused coding position scoped to the app, in its own worktree)
  retired/                     retired positions are moved here unchanged
```

The tree:

```
CEO (any Helm session in a company folder)
├── Legal
│   └── Tax Specialist
│       └── Payroll Tax
├── Marketing
└── App QA (paused)
```

A real team root also has `README.md` and `house-rules.md` at the top, which Helm writes once.
