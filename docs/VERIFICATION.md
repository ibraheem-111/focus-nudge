# Verification — focus-nudge

Run after any change to the daemon, the policy, or the extension.

    npm test
    systemctl --user restart focus-nudge

Then reload the extension at `chrome://extensions` (the reload icon on the
focus-nudge card) and walk the browser rows below.

## Automated

These run in `npm test` and need no browser. 307 tests.

| Area | File | Covers |
|---|---|---|
| Config | `test/config.test.js` | defaults, path layout, partial/malformed config, atomic write, scratch-dir round trip |
| State machine | `test/core.test.js` | every phase transition, no auto-advance, idempotent settling, per-site grace, tasks, queue, long break, `view` contract, id restart, clear-done, `block_completed` accounting and minutes, site canonicalisation incl. dot runs, nudging as a switch independent of the timer (timed / indefinite / silent expiry / legacy `SNOOZED` migration), Linear task actions (create, link, done both ways, cancel on remove, sync rules) |
| Linear client | `test/linear.test.js` | request shape, raw-key header, key redaction in errors, create / done / undone / cancel / active issues / projects, `.env` parsing — all against a fake `fetch` |
| Linear wiring | `test/server.linear.test.js`, `test/cli.linear.test.js` | the real client against a scripted fake endpoint: create-and-link, unreachable → pending → retried once, error printed once, done/cancel reach Linear, sync pulls issues in, `/linear` caches and never contains the key, `--project` prefix / ambiguity / unknown |
| Insights | `test/stats.test.js`, `test/insights-model.test.js` | NUL-prefixed lines, focus minutes, windows, streaks, hour/weekday, block outcomes, funnel, nudge-off hours, range narrowing; calendar grid, DST-safe day steps, weekly folding |
| Nudge policy | `test/policy.test.js` | the `nudging` switch, with the phase rule only as a fallback for an older daemon, registrable-domain matching, hostile lookalikes, fail-closed on unknown state, empty vs missing site list, bare-TLD and leading-dot entries, the daemon-down session pass, drift between `NUDGE_PHASES` and `core.NUDGING_PHASES`, drift between `FALLBACK_SITES` and `DEFAULTS.sites` |
| Daemon | `test/server.smoke.test.js` | all endpoints over a real socket, CORS, the `Origin` guard, corrupt- and shape-invalid-state quarantine, restart persistence, oversized body, missing notify binary, write-failure reporting, day bucketing, `block_completed` reaching the log |
| CLI | `test/cli.test.js` | drives the real `cli/focus` binary as a subprocess against a scratch daemon (`HOME` redirected), rejected `sites add`/`remove`, missing and malformed task ids, usage errors, exit codes |
| Quotes | `test/quotes.test.js` | bundled list size, uniqueness, selection edges |
| Shared UI | `test/ui.test.js` | the countdown always unlocks, `setSeconds` cannot re-lock it, `renderTasks` only rebuilds on real change |

No test touches `~/.config/focus-nudge/`: every one writes to an `fs.mkdtempSync`
scratch directory, and the CLI tests redirect `HOME` so even `loadConfig`'s
default path lands in scratch.

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

## Still unverified — needs a human at a browser

Nobody has checked these. Do not assume they work.

| # | Check | Expected |
|---|---|---|
| 9 | Pause-screen checkboxes toggle and persist | a tick survives the next poll instead of snapping back. The BUG was observed in a browser in the 2026-08-03 session; the FIX postdates that session and has only been verified against the DOM stub in `test/ui.test.js`, so the fixed behaviour has never been seen in Chrome |
| 10 | Popup opens from the toolbar icon | phase, clock, tasks, nudging line and Off/On buttons, sites, Open dashboard, Insights |
| 11 | Open dashboard button | opens `dashboard.html` in a tab, popup closes |
| 12 | Dashboard controls | Start / Skip / Pause / Stop / Long break drive the real daemon |
| 13 | Dashboard task add | typing + Enter adds, and `focus status` agrees |
| 14 | Clear done button | appears only when something is ticked, removes only those |
| 15 | Today's block count on the dashboard | matches `focus stats` |
| 16 | `Back to work` | returns to the previous page, or closes the tab if there was none |
| 17 | `Save for later` | url appears in `focus queue` |
| 18 | Switching nudging off drains the queue | saved links open exactly ONCE, not twice; a long break no longer opens them |
| 19 | Grace period | after `continue anyway`, that site opens freely for 5 min |
| 20 | Grace is per-site | a pass on one watched site does not unlock another |
| 21 | Grace lapses | after 5 min the pause screen returns |
| 22 | Nudging off from the popup | the nudging line reads `nudging off — h:mm:ss left`, watched sites open freely, and a running work block KEEPS running |
| 23 | Site editor add/remove | reflected in `~/.config/focus-nudge/config.json` |
| 24 | Invalid site (`com`) | shows the error, keeps what you typed |
| 25 | Short break still nudges | a watched site is paused during a 5-min break |
| 26 | Daemon stopped | pause screen still appears, with the no-daemon hint |
| 27 | Unwatched site with daemon stopped | loads normally |
| 28 | Overrun | a finished block notifies once, holds its phase, shows `ran over by` |
| 29 | Suspend across a phase boundary | one notification on wake, no drift |
| 30 | Flash of content | note how often a frame of the blocked page appears (known limitation) |
| 31 | SPA navigation is intercepted | on YouTube during a work block, clicking from one video to another (no full page load) brings up the pause screen. This is what `onHistoryStateUpdated` was added for; only a browser can confirm it fires as expected |
| 32 | A grace lapses inside an SPA | take a grace on YouTube, stay inside the app clicking between videos, and confirm the pause screen returns once the 5 minutes are up |
| 33 | `continue anyway` with the daemon stopped | it must reach the site and STAY there — no second pause screen. Stop the daemon, visit a watched site, continue, then navigate around |
| 34 | The daemon-down pass is bounded | after 33, wait past `graceMinutes` with the daemon still down and confirm the pause screen returns rather than the site staying open |
| 35 | The daemon-down pass yields to a live daemon | after 33, start the daemon again and confirm the site is nudged immediately rather than riding out the session pass |
| 36 | `Save for later` with the daemon stopped | the button must say it did NOT save, and must not navigate away |
| 37 | A web page cannot drive the daemon | in the console on `https://reddit.com`, `fetch('http://127.0.0.1:7373/snooze',{method:'POST',headers:{'content-type':'application/json'},body:'{"hours":8}'})` must be refused (403 / CORS failure) and `focus status` must still read `nudging on` |
| 38 | The extension itself still works after 37 | popup, dashboard and pause screen all still reach the daemon — the `Origin` guard must not have locked out the extension |
| 39 | Dashboard and popup agree when the daemon is down | stop the daemon and open both: same `no daemon` phase, both showing `Pause` (not `Resume`), both showing the queue line as `unknown` |
| 40 | `x.com` and `instagram.com` are nudged with the daemon down | the live `config.json` already listed all four, so the hole was only ever in `FALLBACK_SITES`, which the cold service worker uses when it has no view. Stop the daemon, reload the extension so the worker starts cold, and confirm both sites are paused rather than opening freely |
| 41 | Nudging stays off across a whole work block | switch nudging off for 1h, Start a block: YouTube plays without a pause screen, the clock counts down, and the block ends with its normal notification |
| 42 | Nudging on during a break | in a short or long break with nudging on, a watched site IS paused |
| 43 | "Until I turn it on" | the popup shows `nudging off until you turn it back on` and the Turn nudging on button; it stays off across a daemon restart |
| 44 | A timed off-switch ends silently | when the hour runs out, a "Nudging back on" notification with NO sound |
| 45 | An extension not reloaded yet still works | before reloading the extension after the daemon upgrade, nudging off still lets sites through (the `nudgingPhase` alias) |
| 46 | Adding a task with a project | the project picker lists the Linear projects; the new task gets an `IBR-n` link within a second or two, and the issue is in Linear under that project |
| 47 | The `IBR-n` link | opens the issue in a new tab and does NOT tick the task |
| 48 | Tick and untick a linked task | the issue moves to Done, then back to Todo |
| 49 | Remove an open linked task | the issue moves to Canceled and does not come back on the next sync |
| 50 | An issue started in Linear | an issue moved to Todo / In Progress appears in the task list within a minute; closing it in Linear ticks it |
| 51 | Picker hidden without Linear | with no `LINEAR_API_KEY`, the popup and dashboard show no project picker |
| 52 | Insights page opens | from the popup button and the dashboard link; KPI tiles, calendar, and every chart render; hovering a mark shows its tooltip |
| 53 | Insights range | switching 7 / 30 / 90 / all re-draws every chart and is remembered on reopen |
| 54 | Insights "shown" and "turned back" | after a nudge and a Back to work, the funnel counts both |
| 55 | Insights in a narrow window | no chart overflows its card. Only 980px and 1280px were checked, in a preview browser against a stub of real data |
