# focus-nudge — Design

**Date:** 2026-08-02
**Status:** Approved, ready for implementation planning
**Platform:** Ubuntu 24.04, GNOME on Wayland, Google Chrome (default browser)

## Problem

Opening a browser leads to Reddit and YouTube on autopilot. YouTube is
occasionally necessary; Reddit is not. A hard block is the wrong tool — it
provokes circumvention and punishes the legitimate case. What is needed is a
moment of friction that makes the visit a decision rather than a reflex, plus a
concrete reason to turn back.

## Core insight

A reminder that says *"don't"* is weak. A reminder that says *"not now — in
twelve minutes"* is strong. Resisting indefinitely is hard; waiting twelve
minutes is easy. A pomodoro timer supplies the deadline that a bare quote
screen lacks.

A second reframe compounds this. A quote is a *generic* argument for going
back. An unfinished micro-task list is a *specific* one, and it answers the
question the impulse is actually asking: **go back to what?** The pause screen
therefore ends with a concrete next action, not just resolve.

## Scope

In scope: a Chrome extension that intercepts configured sites and shows a
state-aware pause screen; a local daemon owning the pomodoro timer, micro-task
list, and configuration; a CLI; desktop notifications; a save-for-later queue.

Out of scope: Firefox support, publishing to the Chrome Web Store, policy-based
force-install, mobile, cross-machine sync, and time-tracking analytics beyond a
simple counter log.

## Behaviour

### Phases

Five phases, one nudge rule each.

| Phase | Reddit / YouTube | Pause screen says |
|---|---|---|
| `WORK` | nudge | `12:04 left in this block` + open micro-tasks |
| `SHORT_BREAK` | nudge | `This is your rest. 3:12 left.` |
| `LONG_BREAK` | open | — |
| `SNOOZED` | open | — |
| `IDLE` | nudge | quote and countdown only, no timer prompt |

Short breaks are deliberately *not* a distraction window. Five minutes of
scrolling does not deliver recovery; it costs it. The break is zen time.

`LONG_BREAK` and `SNOOZED` are the only sanctioned windows. This is what gives
`WORK`'s "not now" its credibility, and what gives saved links real weight.

### Sites

The default list is `reddit.com` and `youtube.com`. Matching is on the
registrable domain, so subdomains are included: `old.reddit.com`,
`music.youtube.com`, and `m.youtube.com` are all covered by their parent entry.
Paths are not matched — a domain is either watched or it is not. Sites are added
and removed through the popup or `focus sites add|remove`.

### Timing

Defaults, all configurable: work 25 min, short break 5 min, long break 20 min,
long break offered after 4 completed work blocks.

Phases do **not** auto-advance. When a work block's time runs out the daemon
notifies and the phase stays `WORK` with a negative remaining time until you
start the break, and likewise at a break's end. Auto-advance would start blocks
you are not present for and silently inflate the completed-block count. Since
`WORK` and `SHORT_BREAK` nudge identically, an overrun never opens a gap in
coverage.

Timers are wall-clock, computed from a stored `endsAt`. If the machine suspends
across a boundary, the phase is simply found expired on wake and notified once.

A long break also begins on demand, via `focus break` or the popup. `SNOOZED`
is entered explicitly with a duration (`focus off 2h`) and reverts to `IDLE`
when it expires.

### Grace period

Clicking *Continue anyway* grants a 5-minute pass, tracked **per site**. A
YouTube pass does not unlock Reddit. When the pass lapses, the next navigation
to that site is nudged again.

### The pause screen

```
   "You have power over your mind — not outside events."
                                       — Marcus Aurelius

   ─────────────────────────────────────────────────────
   12:04 left in this block                    ● WORK

   [ ] fix the auth redirect
   [ ] write the regression test
   [x] bump the client version

   ─────────────────────────────────────────────────────
        ┌──────────────┐  ┌─────────────────┐
        │ Back to work │  │ Save for later  │
        └──────────────┘  └─────────────────┘

              continue anyway  ( 7 )
```

Quote for the reframe, timer for the deadline, checklist for the answer to
"back to what?". `Back to work` is visually dominant. `continue anyway` is
small and disabled for a 10-second countdown, then becomes clickable. It never
becomes unavailable — this is a nudge, not a block.

`Back to work` closes the tab if it was opened for this navigation, otherwise
navigates back.

The screen is live. Its countdown and micro-task list update as the daemon's
state changes, and if the phase becomes `LONG_BREAK` or `SNOOZED` while the
screen is open, it releases immediately and navigates to the URL you originally
asked for. A sanctioned window should not have to be re-triggered by a second
click.

### Save for later

*Save for later* stores the URL in a queue and returns you to work. When a
`LONG_BREAK` or `SNOOZED` phase begins, a desktop notification reports the
queue depth and the popup offers to open every saved link at once. Draining
clears the queue.

This is the mechanism that makes turning back feel free rather than like a
loss: the impulse is deferred, not suppressed.

### Micro-tasks

A single flat list of short task strings with done flags — not per-block
assignments. Open tasks appear on the pause screen, the new-tab dashboard, and
the popup. Completed tasks are dimmed. The list is archived to the log and
cleared when a long break begins.

### Where the timer is visible

Chrome's new-tab page is overridden with a dashboard: phase, countdown,
micro-task list with inline add and toggle, and the current queue depth. A new
tab is exactly where a browsing impulse begins, so the checklist is met at the
moment of temptation. This needs no GNOME Shell extension, which matters on
Wayland.

The toolbar popup shows the same information compactly plus phase controls,
snooze buttons, and the site list. Desktop notifications via `notify-send` fire
at phase boundaries and on queue drain.

## Architecture

```
  focus CLI  ──POST──►  ┌──────────────────────┐
                        │  daemon 127.0.0.1:7373│
  popup      ──POST──►  │  owns ~/.config/      │
                        │    focus-nudge/       │
  extension  ◄──poll──  └──────────────────────┘
```

The daemon is the single source of truth. The popup and CLI are both thin
clients, so they cannot disagree. The extension polls, caches, and degrades
independently.

### Components

1. **`daemon/core.js`** — pure state machine. No I/O and no clock of its own;
   the current time is injected. Owns phase transitions, snooze expiry,
   per-site grace, cycle counting, task list, and queue. Fully unit-tested.
2. **`daemon/server.js`** — HTTP server on `127.0.0.1:7373`. Persists state
   atomically (write temp, rename), schedules phase-boundary timers, shells out
   to `notify-send`. A thin wrapper over `core.js`.
3. **`extension/policy.js`** — pure function
   `(phase, url, graces, now) → "allow" | "nudge"`. Unit-tested under Node and
   imported by the service worker, so the decision logic is testable without a
   browser.
4. **`extension/`** — MV3 service worker polling `/state` every 15 s and on
   navigation, plus `interstitial.html`, `newtab.html`, `popup.html`.
5. **`cli/focus`** — thin HTTP client:
   `start pause skip stop break off status task sites stats`.
6. **`systemd/focus-nudge.service`** — a `systemctl --user` unit, restart on
   failure, enabled at login.

### HTTP interface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/state` | phase, `endsAt`, remaining, tasks, sites, queue, graces |
| `GET` | `/quote` | one random quote |
| `POST` | `/timer` | `{action: start\|pause\|skip\|stop\|breakLong}` |
| `POST` | `/snooze` | `{hours}` |
| `POST` | `/tasks` | `{add\|toggle\|remove\|clear}` |
| `POST` | `/sites` | `{add\|remove}` |
| `POST` | `/queue` | `{add: url}` or `{drain: true}` |
| `POST` | `/grace` | `{host}` — record a Continue anyway |

Bound to loopback only. No authentication: any process already running as this
user could edit the config files directly, so a token would add ceremony
without adding protection.

### Failure behaviour

If the daemon is unreachable, the extension falls back to its cached state and
its bundled quotes, **and keeps nudging**. Failing closed toward discipline
means a crashed daemon can never silently hand over Reddit. The popup and the
pause screen both show a clear "daemon not running" line with the command to
fix it.

Other cases: a port already in use exits with an explicit message rather than
retrying; a corrupt `state.json` is backed up and replaced with defaults; a
missing or empty `quotes.txt` falls through to the bundled list; a missing
`notify-send` is logged once and otherwise ignored.

## Files on disk

```
~/.config/focus-nudge/config.json    durations, site list, port
~/.config/focus-nudge/quotes.txt     one per line, "text — author"; yours append here
~/.config/focus-nudge/state.json     phase, tasks, queue, graces — survives restarts
~/.config/focus-nudge/log.jsonl      nudges, continues, blocks completed → focus stats
```

Roughly 60 curated quotes ship inside the extension, so it is useful before a
single personal quote is written. `quotes.txt` is additive, not a replacement.

## Testing

- `node:test` unit tests for `core.js`: every phase transition, expiry without
  auto-advance (overrun reports negative remaining and holds its phase), snooze
  expiry at and across the boundary, per-site grace isolation and lapse, cycle
  counting to the long break, queue add and drain, task add/toggle/clear.
- `node:test` unit tests for `policy.js`: each phase's nudge rule, registrable-
  domain matching including subdomains, non-matching lookalikes
  (`notreddit.com`, `reddit.com.evil.test`), grace interaction, and
  unknown-phase fallback to nudge.
- A smoke script that boots the daemon on an ephemeral port and exercises every
  endpoint over HTTP.
- Manual verification in Chrome: the three pages render, navigation is
  intercepted, the countdown enables the button, save-for-later round-trips
  through a long break.

Test-driven: `core.js` and `policy.js` are written test-first.

## Installation

Load unpacked from `~/focus-nudge/extension` via `chrome://extensions` in
developer mode, and enable the systemd user unit. Iteration is a file edit and
a reload.

## Accepted limitations

- **Firefox is uncovered.** It remains a fully open escape hatch. Accepted
  deliberately; Chrome is the default browser and where the habit lives.
- **The extension is two clicks from disabled.** Developer-mode install has no
  lock. A managed-policy force-install is the documented upgrade if the easy
  off-switch proves too tempting.
- **Save-for-later depends on long breaks actually happening.** If none are
  ever declared, the queue becomes a graveyard. Mitigated by prompting for a
  long break after four blocks, but this is a behaviour bet, not a certainty —
  worth revisiting after a week of real use.
