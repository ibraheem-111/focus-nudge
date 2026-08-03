# focus-nudge

A pause, a quote, and your unfinished tasks — before you open a distraction.

Reddit and YouTube are not blocked. They are interrupted by a screen that shows
how long is left in your current pomodoro block and which micro-tasks are still
open, then lets you through if you still want to go.

See `docs/superpowers/specs/2026-08-02-focus-nudge-design.md` for the design.

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
    focus break              begin a long break, opening any saved links
    focus off 2h             stop nudging for a while: 2h, 90m, or a bare number of hours

    focus task               list the micro-tasks
    focus task "fix the auth redirect"
    focus task done 3        tick one off (also: task toggle <id>)
    focus task rm 3          remove one
    focus task clear         empty the list (ids restart at 1 once it is empty)
    focus task clear done    remove only the ticked-off tasks

    focus sites              list the watched domains
    focus sites add news.ycombinator.com
    focus sites remove news.ycombinator.com

    focus queue              list links saved for your next long break
    focus queue drain        open them now and empty the queue

    focus stats              blocks today, last 7 days, all time, and a daily history
    focus stats 30           show the last 30 days of history (default 14)
    focus --help             full usage text

Phases never advance on their own: an expired block waits for you. Reddit and
YouTube are nudged during work AND short breaks — a long break or an explicit
`focus off` are the only windows where they open freely.

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
  127.0.0.1:7373, atomic persistence, `notify-send`, and the append-only log.
- `extension/policy.js` — the pure allow-or-nudge decision.
- `extension/sw.js` — polls the daemon and intercepts navigation.
- `extension/interstitial.*` — the pause screen: quote, live countdown, tasks,
  and the three buttons (`continue anyway`, `back to work`, `save for later`).
- `cli/focus`, `extension/popup.*`, `extension/dashboard.*` — thin clients. They
  hold no state, so they cannot disagree about the current phase.
- `extension/newtab.html` is not a live page. It is a tombstone stub left
  behind after the dashboard stopped overriding Chrome's new tab: if a stale
  installed manifest still points at it, it explains itself and links to the
  real dashboard instead of showing Chrome's "file could not be accessed"
  error. See the comment in the file for the full story.

If the daemon is unreachable the extension keeps nudging with its bundled quotes.
Failing closed means a crashed daemon can never quietly hand over Reddit.

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
  is a few kilobytes a day, but nothing rotates it. `focus stats` reads it whole.
- **Blocks are counted per day, not per task.** Attributing a block to a task
  would mean either naming a task when you start one, or crediting every open
  task and inflating the numbers.

## Verifying a change

See `docs/VERIFICATION.md`. Run `npm test` first — the state machine and the
nudge policy are both covered there, so most regressions surface without a
browser.

## Tests

    npm test
