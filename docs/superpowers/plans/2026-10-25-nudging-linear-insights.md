# Independent nudging, Linear sync, insights dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make nudging an on/off switch independent of the pomodoro timer, sync micro-tasks two-way with Linear team IBR, and add a rich insights page.

**Architecture:** All rules stay in pure `daemon/core.js` (new state fields, actions, declarative effects). `daemon/server.js` executes the new `linearCreate`/`linearSetDone` effects through a new injectable `daemon/linear.js` client and runs a 60s sync loop. Log aggregation moves to a pure `daemon/stats.js`; a new extension page renders it as hand-built SVG.

**Tech Stack:** Node ≥ 22 built-ins (`node:test`, global `fetch`), Chrome MV3, plain ESM. No dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-nudging-linear-insights-design.md`

## Global Constraints

- Zero runtime dependencies; no build step; ESM.
- `core.js`, `policy.js`, `stats.js` pure: no I/O, no `Date.now()`, injected `now`.
- Never `innerHTML` in the extension; SVG via `document.createElementNS`.
- No new `chrome.*` permission. `host_permissions` unchanged (Linear is called by the daemon, not the extension).
- Tests use `fs.mkdtempSync` dirs and an injected fake Linear `fetch`; never the real `~/.config/focus-nudge/` or the real Linear API.
- The Linear API key never appears in logs, HTTP responses, tests or commits.
- Pinning tests for the old snooze-as-phase behaviour are replaced with tests of the new intent, visibly, not edited to pass.
- Only phase expiry carries a sound.

## Review Focus

1. Daemon restarted while the stored state is `phase: 'SNOOZED'` (the user's live state today) → nudging stays off until the old `endsAt`, phase becomes IDLE, tasks intact. Test in Task 1.
2. Linear unreachable or returning GraphQL `errors` while adding a task → task exists locally with `linearPending: true`, retried by the next sync. Test in Task 4.
3. A linked task removed locally → the next `LINEAR_SYNC` containing that issue does not re-add it. Test in Task 4.
4. New extension against an old daemon (view has no `nudging`) → old phase rule still applies; unknown phase still nudges. Test in Task 2.
5. NUL-prefixed log lines → counted, not dropped. Test in Task 5.

---

### Task 1: Nudging as an independent switch in core

**Files:** Modify `daemon/core.js`, `test/core.test.js`.

**Interfaces — Produces:**
- state: `nudgeOffUntil: number|null`, `nudgeOffIndefinite: boolean` (in `initialState`).
- actions: `{type:'NUDGE_OFF', hours?:number, indefinite?:boolean}`, `{type:'NUDGE_ON'}`; `SNOOZE` = alias of `NUDGE_OFF`.
- `export function nudgingOn(state, now): boolean`.
- view adds `nudging`, `nudgeOffUntil`, `nudgeOffIndefinite`; `nudgingPhase` = same value as `nudging`.
- log events `nudge_off {hours|null, indefinite}`, `nudge_on {reason:'user'|'expired'}`.

- [ ] Replace the snooze-as-phase tests (core.test.js lines ~162-310, 573-609, 713-716) with:
  - `NUDGE_OFF keeps a running work block running` — START at T0, NUDGE_OFF 1h at T0+5min → phase WORK, endsAt T0+25min, blocksCompleted unchanged, `view(...).nudging === false`.
  - `NUDGE_OFF indefinite never expires` — settle at T0+1000h still off.
  - `timed NUDGE_OFF expires silently in settle` — at endsAt: `nudging` true, notify 'Nudging back on' without `sound` key, log `nudge_on {reason:'expired'}`.
  - `NUDGE_ON turns nudging back on`, and `NUDGE_OFF rejects 0, -1, 'soon'` (state unchanged).
  - `the timer never changes nudging` — view.nudging true for IDLE, WORK, SHORT_BREAK, LONG_BREAK when on; false for all four when off.
  - `NUDGE_OFF drains the saved-links queue; BREAK_LONG no longer does`.
  - `settle migrates a stored SNOOZED phase` — `{phase:'SNOOZED', endsAt:T0+30min, tasks:[…]}` → phase IDLE, nudgeOffUntil T0+30min, tasks kept; SNOOZED with endsAt null → nudging on.
  - `NUDGE_OFF / NUDGE_ON never carry a sound`.
- [ ] Run `node --test test/core.test.js` → new tests fail.
- [ ] Implement in core.js. Remove SNOOZED from `PHASE`'s live use but keep the `'SNOOZED'` string recognised by the migration; `NUDGING_PHASES` export stays for policy drift tests.
- [ ] Run `npm test` → core passes (server/policy failures expected until Task 2).
- [ ] Commit `feat(core): make nudging a switch independent of the timer`.

### Task 2: Wire the switch through server, policy, extension, CLI

**Files:** Modify `daemon/server.js`, `extension/policy.js`, `extension/sw.js`, `extension/interstitial.js`, `extension/api.js`, `extension/ui.js`, `extension/popup.{html,js}`, `extension/dashboard.{html,js}`, `cli/focus`; tests `test/policy.test.js`, `test/server.smoke.test.js`, `test/cli.test.js`.

**Interfaces — Produces:** `POST /nudging {action:'off', hours?|indefinite?} | {action:'on'}`; `/snooze` kept. `decide({..., nudging})`. api.js `nudgingOff(hoursOrNull)`, `nudgingOn()`. CLI `focus on`, `focus off [duration]` (no duration → indefinite).

- [ ] Tests: policy `nudging:false allows a watched site`, `nudging:true nudges in LONG_BREAK`, `nudging absent falls back to phase rule` (old SNOOZED/LONG_BREAK allow, unknown phase nudges); smoke `POST /nudging off keeps a work block`, `/snooze still works and keeps phase`, Origin guard still 403s `/nudging`; CLI `focus off` with no argument → indefinite, `focus on`.
- [ ] Implement. Interstitial releases when `view.nudging === false`. Popup: buttons 1h/2h/4h/"until I turn it on", plus "Turn nudging on" when off; line reads "nudging off — 42:10 left" / "nudging off until you turn it on". Dashboard shows the same line and controls. `server.js` `shapeProblem` keeps accepting `'SNOOZED'`.
- [ ] `npm test` green; id cross-check of popup/dashboard html vs js.
- [ ] Commit `feat: nudging on/off decoupled from the pomodoro across all clients`.

### Task 3: Linear client

**Files:** Create `daemon/linear.js`, `test/linear.test.js`.

**Interfaces — Produces:**
- `loadLinearKey({ env = process.env, envFile }) : string|null` — env first, then parse `KEY=value` lines of `envFile` (quotes stripped, `#` comments ignored).
- `createLinear({ apiKey, teamId, fetch = globalThis.fetch }) → { createIssue({title, projectId}) → {id, identifier, url}, setDone(issueId, done:boolean) → void, activeIssues(extraIds:string[]) → [{id, identifier, url, title, stateType}], projects() → [{id, name}] }`.
- Throws `Error` on non-2xx or GraphQL `errors`; error messages never include the key.
- Team id `7c4547c3-9bfd-4235-9141-cb069ccb3762`; `Authorization: <key>` (no Bearer); endpoint `https://api.linear.app/graphql`.
- `setDone` resolves the team's state ids by type (`completed` → first, `unstarted` named 'Todo' preferred) once and caches them.
- `activeIssues` = team issues with state name in Todo / In Progress / In Review, plus `extraIds` regardless of state.

- [ ] Tests with a fake fetch recording requests: header is the raw key; createIssue sends title/teamId/projectId; GraphQL `errors` → throws without the key in the message; `loadLinearKey` parses a scratch `.env`; env var wins.
- [ ] Implement, run, commit `feat(linear): zero-dependency Linear GraphQL client`.

### Task 4: Two-way task sync

**Files:** Modify `daemon/core.js`, `daemon/server.js`, `cli/focus`, `extension/ui.js`, `extension/api.js`, popup/dashboard html+js, `extension/style.css`; tests in core, smoke, cli.

**Interfaces:**
- Consumes Task 3's `createLinear`.
- core: `TASK_ADD {text, project?:{id,name}}` → task `{id,text,done,project,linear:null,linearPending:true}` and effect `{type:'linearCreate', taskId, text, projectId}` — only when `config.linearEnabled` is true (server sets it; default false keeps every existing test meaning).
- `TASK_LINKED {taskId, linear:{id,identifier,url}}` → sets linear, clears pending.
- `TASK_TOGGLE` on a linked task → effect `{type:'linearSetDone', issueId, done}`; log `task_done` when it becomes done.
- `TASK_REMOVE`/`TASK_CLEAR`/`TASK_CLEAR_DONE` add removed linked issue ids to `state.linearDismissed: string[]`.
- `LINEAR_SYNC {issues}` per spec rules; new tasks get `linear` set, `project:null`, `linearPending:false`; logs `linear_sync {added, completed}` only when nonzero.
- view: tasks carry `linear`, `project`; adds `linearEnabled`.
- server: `opts.linear` (inject) else built from `loadLinearKey`; `GET /linear` → `{enabled, projects}` (10 min cache); sync loop every 60s + at listen; retries `linearPending` tasks; `close()` clears it. Errors logged as `focus-nudge: linear: <message>` once per distinct message.
- CLI: `focus task <text> --project <prefix>` (case-insensitive prefix of a project name from `GET /linear`; unknown prefix → exit 1 listing names); status lines show `IBR-34` after linked tasks.
- UI: `renderTasks` shows the identifier as `<a target=_blank>` after the text; popup/dashboard add a `<select id="new-task-project">` filled from `/linear`, hidden when disabled.

- [ ] Core tests: create effect emitted only when enabled; TASK_LINKED; toggle emits setDone both ways; sync adds new, ticks completed/canceled, updates title, never un-ticks a locally done task, never re-adds dismissed, ignores completed issues never seen.
- [ ] Smoke tests with a fake linear object: add → issue created and task linked within one tick; fake throwing → task kept with `linearPending`, second sync links it; `/linear` never contains the key.
- [ ] Implement, `npm test`, id cross-check, commit `feat: two-way Linear sync for micro-tasks with project picker`.

### Task 5: Insights

**Files:** Create `daemon/stats.js`, `test/stats.test.js`, `extension/insights.html`, `extension/insights.js`; modify `daemon/server.js` (re-export `summariseLog`, `localDay` from stats.js), `daemon/core.js` (`task_added` log, `block_completed {minutes}`), `extension/sw.js` (report `nudge_shown`), `extension/interstitial.js` (report `nudge_back`), popup/dashboard (link to insights), `extension/api.js`.

**Interfaces — Produces:**
- `insights(text, { now, dayKey = localDay, hourOf, dayOfWeek, workMinutes = 25 })` returning `{ kpis:{focusMinutes:{today,last7,all}, blocks:{today,last7,all}, streak:{current,best}, tasksDone, tasksAdded, continued, nudgeOffHours, nudgeOffs}, byDay:{[day]:{blocks,focusMinutes,continued,nudgeOffs,nudgeShown,tasksDone}}, byHour:[24]{blocks,continued,nudgeOffs}, byWeekday:[7]{blocks,continued}, bySite:{[site]:{continued,shown,back,saved}}, blockOutcomes:{completed,paused,nudgeOff,stopped}, nudgeOffDurations:{[label]:count}, funnel:{shown,back,continued,saved}, firstAt, lastAt }`.
- Lines are parsed after stripping `\0`. `snooze` and `nudge_off` both count as nudge-offs; `phase{phase:'WORK'}` followed by the next of block_completed/pause/snooze|nudge_off/phase{IDLE} classifies a block outcome.
- `POST /nudge {site, outcome:'shown'|'back'}` → core `NUDGE_EVENT` → log only; unknown outcome → 400.
- `GET /insights` → `insights(log, {now, workMinutes: config.workMinutes})`.

- [ ] Tests: NUL-prefixed line counted; streak current/best across a gap; byHour uses injected hourOf; block outcomes from a scripted log; funnel counts; minutes from `block_completed.minutes` else workMinutes; existing summariseLog tests still pass via re-export.
- [ ] Implement page: KPI tiles, calendar heatmap (blocks/day, 26 weeks), 30-day trend bars (blocks vs continues), hour-of-day grouped bars, weekday bars, per-site table with bars, outcome bar, funnel, nudge-off durations; range select 7/30/90/all re-renders from the same payload. Load the dataviz skill before writing chart code.
- [ ] `npm test`, id cross-check, render the page against a stub in the built-in browser (served via `file://` with a mocked `/insights`) to eyeball it.
- [ ] Commit `feat(insights): rich usage dashboard`.

### Task 6: Docs

- [ ] README usage + "How it fits together", AGENTS.md (manifest unchanged; invariant wording for nudging; Linear section notes daemon now writes issues), VERIFICATION.md (new unverified browser rows; test count). Commit `docs: nudging switch, Linear sync, insights`.
