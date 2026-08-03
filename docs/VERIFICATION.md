# Verification — focus-nudge

Run after any change to the daemon, the policy, or the extension.

    npm test
    systemctl --user restart focus-nudge

Then reload the extension at `chrome://extensions` (the reload icon on the
focus-nudge card) and walk the browser rows below.

## Automated

These run in `npm test` and need no browser. 125 tests.

| Area | File | Covers |
|---|---|---|
| Config | `test/config.test.js` | defaults, path layout, partial/malformed config, atomic write, scratch-dir round trip |
| State machine | `test/core.test.js` | every phase transition, no auto-advance, idempotent settling, per-site grace, tasks, queue, long break, `view` contract, id restart, clear-done |
| Nudge policy | `test/policy.test.js` | registrable-domain matching, hostile lookalikes, fail-closed on unknown state, empty vs missing site list, bare-TLD and leading-dot entries |
| Daemon | `test/server.smoke.test.js` | all endpoints over a real socket, CORS, corrupt-state recovery, restart persistence, oversized body, missing notify binary, write-failure reporting, day bucketing |
| Quotes | `test/quotes.test.js` | bundled list size, uniqueness, selection edges |
| Shared UI | `test/ui.test.js` | the countdown always unlocks, `setSeconds` cannot re-lock it, `renderTasks` only rebuilds on real change |

## Confirmed in a real browser

Verified by the operator on 2026-08-03, Chrome 150, GNOME/Wayland, extension
loaded unpacked.

| # | Check | Result |
|---|---|---|
| 1 | Navigation to a watched site is intercepted | PASS |
| 2 | The redirect URL is well formed and encoded | PASS |
| 3 | A quote renders | PASS |
| 4 | The countdown renders live from the daemon | PASS |
| 5 | The phase chip renders | PASS |
| 6 | Micro-tasks added over the CLI appear on the pause screen | PASS |
| 7 | `continue anyway` unlocks after the countdown | PASS |
| 8 | The dark theme loads | PASS |
| 9 | Pause-screen checkboxes toggle and persist | PASS (was broken; fixed) |

## Still unverified — needs a human at a browser

Nobody has checked these. Do not assume they work.

| # | Check | Expected |
|---|---|---|
| 10 | Popup opens from the toolbar icon | phase, clock, tasks, snooze, sites, Open dashboard |
| 11 | Open dashboard button | opens `dashboard.html` in a tab, popup closes |
| 12 | Dashboard controls | Start / Skip / Pause / Stop / Long break drive the real daemon |
| 13 | Dashboard task add | typing + Enter adds, and `focus status` agrees |
| 14 | Clear done button | appears only when something is ticked, removes only those |
| 15 | Today's block count on the dashboard | matches `focus stats` |
| 16 | `Back to work` | returns to the previous page, or closes the tab if there was none |
| 17 | `Save for later` | url appears in `focus queue` |
| 18 | Long break drains the queue | saved links open exactly ONCE, not twice |
| 19 | Grace period | after `continue anyway`, that site opens freely for 5 min |
| 20 | Grace is per-site | a pass on one watched site does not unlock another |
| 21 | Grace lapses | after 5 min the pause screen returns |
| 22 | Snooze from the popup | chip reads `snoozed`, watched sites open freely |
| 23 | Site editor add/remove | reflected in `~/.config/focus-nudge/config.json` |
| 24 | Invalid site (`com`) | shows the error, keeps what you typed |
| 25 | Short break still nudges | a watched site is paused during a 5-min break |
| 26 | Daemon stopped | pause screen still appears, with the no-daemon hint |
| 27 | Unwatched site with daemon stopped | loads normally |
| 28 | Overrun | a finished block notifies once, holds its phase, shows `ran over by` |
| 29 | Suspend across a phase boundary | one notification on wake, no drift |
| 30 | Flash of content | note how often a frame of the blocked page appears (known limitation) |
