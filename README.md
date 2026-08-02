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

    focus start          begin a 25-minute work block
    focus skip           advance to the next phase
    focus pause          pause the timer
    focus stop           back to idle
    focus break          begin a long break (drains the saved-links queue)
    focus off 2h         snooze all nudging for two hours
    focus status         current phase, countdown, open tasks
    focus task "fix the auth redirect"
    focus task done 3
    focus sites add news.ycombinator.com
    focus stats          blocks completed, nudges shown, times continued

## Tests

    npm test
