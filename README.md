# focus-nudge

A pause, a quote, and your unfinished tasks — before you open a distraction.

Reddit, YouTube, X and Instagram are not blocked. They are interrupted by a
screen that shows how long is left in your current pomodoro block and which
micro-tasks are still open, then lets you through if you still want to go.

See `docs/superpowers/specs/2026-08-02-focus-nudge-design.md` for the design.

## Prerequisites

This is **Linux-only, by construction** — the daemon ships as a `systemctl --user`
unit, and there is no equivalent packaging for macOS or Windows. If you are on
either, this repo will not work for you as-is.

- **Linux with systemd user services.** The daemon runs under `systemctl --user`.
  macOS and Windows are not supported.
- **Node >= 22.** The daemon and CLI use `node:test`, global `fetch`, and
  `AbortSignal.timeout`, none of which exist on older Node.
- **Google Chrome.** The extension is Manifest V3 and Chrome-specific. Firefox
  is not supported.
- **`notify-send` (libnotify), optional.** Used for desktop notifications when
  a block ends. If it is missing, the daemon just skips notifying — nothing
  breaks.
- **Zero npm dependencies.** Nothing to `npm install`; the whole tool is Node
  built-ins.

Run `focus doctor` after installing to check all of the above on your machine.

## Install

    ./install.sh

Then load the extension: open `chrome://extensions`, enable Developer mode,
click "Load unpacked", and select the `extension/` directory.

## Usage

    focus                    current phase, countdown, open tasks (same as `status`)
    focus start              begin a work block, or resume a paused one
    focus pause              pause the running phase
    focus skip               advance to the next phase
    focus stop               back to idle, clears the cycle
    focus break              begin a long break
    focus off 2h             switch nudging off for a while: 2h, 90m, or a bare number of hours
    focus off                switch nudging off until you turn it back on
    focus on                 switch nudging back on

    focus task               list the micro-tasks
    focus task "fix the auth redirect"
    focus task route the board --project pcb   file its Linear issue under a project
    focus task done 3        tick one off (also: task toggle <id>)
    focus task rm 3          remove one (cancels its Linear issue if it is still open)
    focus task clear         empty the list (ids restart at 1 once it is empty; open
                             Linear issues on the list are cancelled)
    focus task clear done    remove only the ticked-off tasks

    focus sites              list the watched domains
    focus sites add news.ycombinator.com
    focus sites remove news.ycombinator.com

    focus queue              list links saved for the next time you switch nudging off
    focus queue drain        open them now and empty the queue

    focus stats              blocks today, last 7 days, all time, and a daily history
    focus stats 30           show the last 30 days of history (default 14)
    focus doctor             diagnose a machine where the daemon or unit isn't working
    focus --help             full usage text

Phases never advance on their own: an expired block waits for you.

**Nudging and the timer are two independent switches.** Nudging is on unless
you switch it off (`focus off`, or the popup's Off 1h / 2h / 4h / Until I turn
it on), in every phase — work, breaks, idle. Switching it off never touches the
timer: a running work block keeps running, so the pomodoro still works while
YouTube plays music in the background. And the timer never changes whether a
site nudges. Switching nudging off opens any links you saved for later; a timed
off-switch ends silently.

### Linear

With `LINEAR_API_KEY` in the repo's `.env` (or the daemon's environment), the
micro-task list and the IBR team in Linear are kept in step:

- adding a task creates a Linear issue, optionally under a project — pick one
  in the popup or dashboard, or `--project <prefix>` on the CLI;
- ticking a task done moves its issue to Done, and unticking moves it back to Todo;
- removing an open task (`task rm`, `task clear`, the × button) cancels its
  issue; clearing tasks already ticked done leaves their issues Done;
- every minute, Todo / In Progress / In Review issues show up in the task list,
  and an issue closed in Linear gets ticked here. A task you ticked here is never
  unticked by Linear, and one you removed is never brought back.

If Linear is unreachable the task is kept and marked pending, and the daemon
retries every minute. Without a key, everything works as before, locally.

### Insights

The popup and dashboard link to an insights page: focus time, completed blocks
and streaks, a 26-week calendar, blocks against continue-anyway over time, your
hour-of-day and weekday patterns, a per-site table, what you do when a nudge
appears, how work blocks end, and how long nudging gets switched off. Every
chart follows a 7 / 30 / 90-day / all-time range. It is read from `log.jsonl`;
nothing leaves the machine.

## How it fits together

    focus CLI  ──POST──►  ┌───────────────────────┐
                          │  daemon 127.0.0.1:7373 │
    popup      ──POST──►  │  owns ~/.config/       │
                          │    focus-nudge/        │
    extension  ◄──poll──  └───────────────────────┘

- `daemon/core.js` — the pure state machine. Every phase, grace, task and queue
  rule lives here, with no I/O and an injected clock, which is why it can be
  tested exhaustively.
- `daemon/server.js` — the only component that performs I/O: HTTP on
  127.0.0.1:7373, atomic persistence, `notify-send`, the append-only log, and
  the Linear calls core.js asks for (`linearCreate`, `linearSetDone`,
  `linearCancel`), run one at a time.
- `daemon/linear.js` — a zero-dependency GraphQL client for those calls. The API
  key goes into the request header and nowhere else.
- `daemon/stats.js` — pure summaries of `log.jsonl` for `focus stats` and the
  insights page.
- `extension/policy.js` — the pure allow-or-nudge decision.
- `extension/sw.js` — polls the daemon and intercepts navigation, both full page
  loads (`onBeforeNavigate`) and in-app navigation (`onHistoryStateUpdated`).
  Every watched site is a single-page app, so without the second one a grace
  could lapse without the pause screen ever returning.
- `extension/interstitial.*` — the pause screen: quote, live countdown, tasks,
  and the three buttons (`continue anyway`, `back to work`, `save for later`).
- `extension/insights.*` — the insights page; `insights-model.js` holds its
  pure calendar and range arithmetic.
- `cli/focus`, `extension/popup.*`, `extension/dashboard.*` — thin clients. They
  hold no state, so they cannot disagree about the current phase.
- `extension/newtab.html` is not a live page. It is a tombstone stub left
  behind after the dashboard stopped overriding Chrome's new tab: if a stale
  installed manifest still points at it, it explains itself and links to the
  real dashboard instead of showing Chrome's "file could not be accessed"
  error. See the comment in the file for the full story.

If the daemon is unreachable the extension keeps nudging with its bundled quotes.
Failing closed means a crashed daemon can never quietly hand over Reddit. It also
must not trap you: with no daemon to record a grace, `continue anyway` writes a
pass into the extension's own session storage instead, so the escape hatch still
works. That pass is honoured only while the daemon stays unreachable, and it dies
with the browser — a dead daemon can neither block you permanently nor grant
standing access.

Only the extension may drive the daemon from a browser: any request carrying an
`Origin` that is not a `chrome-extension:` URL is refused with a 403. Requests
with no `Origin` at all — `curl`, the CLI, your own scripts — are served, since a
web page cannot suppress its own `Origin`. Without this, any page you visited
(reddit.com included) could `POST /snooze` and switch the nudging off.

## Known limitations

- **A frame of the blocked page can appear** before the redirect lands — worst
  case around 1.5s on a cold daemon fetch. MV3 removed blocking `webRequest`, so
  avoiding this entirely would need the `declarativeNetRequest` permission and a
  different design.
- **No public-suffix awareness.** Adding `co.uk` would match every `*.co.uk`
  domain. A public-suffix list would break the zero-dependency rule.
- **Firefox is not covered.** Chrome only, by choice.
- **The extension is loaded unpacked**, so it is a couple of clicks from being
  disabled. A managed-policy install would make it harder to defeat on impulse.
- **`log.jsonl` grows without bound.** At roughly one block per 25 minutes this
  is a few kilobytes a day, but nothing rotates it. `focus stats` and the
  insights page read it whole.
- **Insights before this version are partial.** "Nudge shown" and "turned back"
  are logged from now on, and older blocks have no recorded length (they count
  as a full block).
- **Linear sync is one team, IBR.** The team id is fixed in `daemon/server.js`.
- **Blocks are counted per day, not per task.** Attributing a block to a task
  would mean either naming a task when you start one, or crediting every open
  task and inflating the numbers.

## Verifying a change

See `docs/VERIFICATION.md`. Run `npm test` first — the state machine and the
nudge policy are both covered there, so most regressions surface without a
browser.

## Tests

    npm test
