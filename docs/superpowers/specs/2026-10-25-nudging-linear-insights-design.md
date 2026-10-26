# Independent nudging, Linear sync, and an insights dashboard — design

Date: 2026-10-25. Status: approved in chat (the user answered the product
questions and asked for the build to go ahead without further questions).

## Why

Two months of real use (Aug 3 – Oct 8) show the tool working against its
owner:

- 196 snoozes against 27 completed work blocks. A lot of the user's actual
  work happens on YouTube and Reddit (lectures, research threads, music in the
  background), so the nudge fires on legitimate work and gets switched off.
- Snoozing is a *phase*. Entering it ends the running work block and zeroes the
  cycle, so the user cannot run a pomodoro and have nudging off at the same
  time. 11 work blocks ended that way.
- Micro-tasks live only in focus-nudge, separate from the user's Linear
  workspace (team IBR), where the real planning happens. Several micro-tasks
  duplicate Linear issues.
- `focus stats` is a single text summary. There is no way to see patterns.

## Goals

1. **Nudging and the pomodoro timer are two independent switches.**
   - Nudging is ON or OFF. OFF is either timed (1h / 2h / 4h / any duration
     from the CLI) or indefinite ("until I turn it back on").
   - Turning nudging off or on never touches the timer: a running work block
     keeps running, the cycle count is kept.
   - The timer never changes whether sites nudge. Work, short break, long
     break and idle all nudge when nudging is ON; none of them nudge when it
     is OFF. (The user chose this exact wording.)
2. **Linear two-way sync, kept simple.**
   - Adding a micro-task (CLI, popup, dashboard) creates an issue in team IBR,
     optionally in a Linear project chosen from a dropdown (default: none).
   - Ticking a linked task done moves its issue to Done; unticking moves it to
     Todo.
   - The user's Todo and In Progress IBR issues show up in the task list.
   - An issue completed or cancelled in Linear is ticked off locally.
3. **A rich usage dashboard**: an extension page with charts drawn from
   `log.jsonl`.

## Non-goals

- Deleting Linear issues. Removing a task locally never deletes the issue.
- Syncing Backlog issues, comments, assignees, priorities, labels.
- Pushing the seven pre-existing micro-tasks to Linear. Only tasks created after
  this ships are pushed.
- A settings UI for Linear. The key comes from `.env`.

## Anti-goals (would make this a failure even if it works)

- A crashed daemon or a Linear outage hands over Reddit. Fail-closed stays.
- A Linear outage blocks adding a task, or loses one.
- Any path auto-deletes a user's task (invariant 3).
- The API key appears in a log, a response body, a test fixture, or a commit.
- Removing a Linear-sourced task locally and having the next sync put it back.

## Decisions

### Nudging

- New state fields: `nudgeOffUntil: number | null` and
  `nudgeOffIndefinite: boolean`. Nudging is off when
  `nudgeOffIndefinite || (nudgeOffUntil !== null && now < nudgeOffUntil)`.
- `PHASE.SNOOZED` is retired as a phase. `settle` migrates a stored
  `phase: 'SNOOZED'` state to `IDLE` with `nudgeOffUntil = endsAt`, so the
  snooze the user is in when the daemon restarts is honoured, not lost.
  `server.js` still accepts `SNOOZED` when loading state, for that migration.
- Actions: `NUDGE_OFF { hours }` (finite positive hours, or
  `indefinite: true`), `NUDGE_ON`. `SNOOZE` stays as an alias of
  `NUDGE_OFF` so the existing `/snooze` route and CLI keep working.
- Timed-off expiry: `settle` clears it and notifies "Nudging back on",
  without a sound (only phase expiry makes a sound).
- Turning nudging off drains the saved-links queue (unchanged from snooze).
  **My call:** a long break no longer drains the queue. The links are almost
  all watched sites, and with nudging on during a long break they would open
  straight into pause screens. `focus queue drain` still works any time.
- View gains `nudging: boolean`, `nudgeOffUntil`, `nudgeOffIndefinite`.
  `nudgingPhase` is kept as an alias of `nudging` for one release so a
  not-yet-reloaded extension keeps working.
- `policy.decide` takes `nudging`. If it is a boolean it is the whole
  answer (plus graces). If it is absent (an older daemon), the old
  phase-based rule applies. Unknown or missing state still nudges.
- Clients: popup gets 1h / 2h / 4h / "until I turn it on" and a "Turn
  nudging on" button; the dashboard shows the nudging state with the same
  controls; CLI gains `focus on`, and `focus off` with no duration means
  indefinite.

### Linear

- `daemon/linear.js`: a zero-dependency GraphQL client over global `fetch`,
  constructed with `{ apiKey, teamId, fetch }` so tests inject a fake. The key
  is read from `LINEAR_API_KEY` in the environment, else from the repo's
  `.env`. No key → Linear is disabled and everything else works as today.
- `core.js` stays pure. It emits declarative effects
  (`linearCreate`, `linearSetDone`) and accepts result actions
  (`TASK_LINKED`, `TASK_LINK_FAILED`, `LINEAR_SYNC`). `server.js` executes
  the effects asynchronously and dispatches the results.
- Task shape gains optional `linear: { id, identifier, url }`,
  `project: { id, name } | null` and `linearPending: boolean`.
- Creation failure leaves the task local with `linearPending: true`; the sync
  loop retries pending tasks. The task is never lost.
- Sync loop: every 60s (and once at start), fetch IBR issues in Todo / In
  Progress / In Review plus any issue already linked. `LINEAR_SYNC`:
  - an active issue not linked to any task and not dismissed → new task;
  - a linked issue whose state is completed or cancelled → task ticked done;
  - a linked issue's title changed in Linear → task text updated;
  - local done/undone is never overridden by Linear's active states (avoids a
    stale fetch undoing a click). Linear → local only propagates completion,
    titles and new issues.
- Removing a linked task (`rm`, `clear`, `clear done`) adds its issue id to
  `linearDismissed`, so sync never re-adds it. The issue is untouched in
  Linear.
- Projects for the dropdown: `GET /linear` returns
  `{ enabled, projects: [{id, name}] }`, cached by the daemon for 10 minutes.
- CLI: `focus task "text" --project <name prefix>`.
- Task rows show the issue identifier (e.g. `IBR-34`) as a link to Linear.

### Insights dashboard

- `daemon/stats.js` (pure): `summariseLog` moves here and grows into
  `insights(text, { now, dayKey, hourOf, dayOfWeek, workMinutes })`. It must
  tolerate NUL-prefixed lines left by unclean shutdowns (two exist today and
  were silently dropped).
- New log events, so future charts have data: `task_added`, `task_done`,
  `nudge_off`, `nudge_on`, `nudge_shown`, `nudge_back` (pause-screen
  outcomes; reported by the extension via `POST /nudge`), and
  `block_completed` gains `minutes`.
- `GET /insights` returns the aggregate. `extension/insights.html` renders it
  with hand-built SVG via `createElementNS` (no `innerHTML`, no libraries).
- Contents: KPI tiles (focus hours today / 7d / all time, blocks, current and
  best streak, tasks done, continues, nudge-off hours), a calendar heatmap of
  blocks, a 30-day daily trend, an hour-of-day profile (blocks vs continues vs
  nudge-offs), a day-of-week profile, continues by site, work-block outcomes
  (completed / paused / ended by snooze / stopped), nudge-off durations, the
  pause-screen funnel (shown → back / continued / saved), and task flow.
  Range filter: 7 / 30 / 90 days / all.
- Reachable from the popup and the dashboard.

## Constraints (from AGENTS.md)

Zero runtime dependencies, ESM, no build step, no `innerHTML`, no new
`chrome.*` permission, tests never touch `~/.config/focus-nudge/` or the real
Linear workspace, pinning tests are replaced visibly rather than edited.

## Left to the builder

Chart layout and styling within the existing palette, exact copy, poll
intervals within reason.
