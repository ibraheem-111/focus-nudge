# AGENTS.md — working on focus-nudge

Guidance for any coding agent (Claude Code, or another) working in this repo.
`CLAUDE.md` is a symlink to this file, so both names lead here.

## What this is

A soft-block nudge system for Chrome on Ubuntu. Reddit, YouTube, x.com and
Instagram are not blocked — visiting one is interrupted by a screen showing a
quote, the time left in the current pomodoro block, and the user's unfinished
micro-tasks, which then lets them through if they still want to go.

It is **in real daily use by its author**, so treat the running system as
production. See `README.md` for install and usage, `docs/VERIFICATION.md` for
what is and is not verified.

## The repository is PUBLIC

`https://github.com/ibraheem-111/focus-nudge`

Nothing secret may ever be committed. `.gitignore` covers `.env`, `.env.*`,
`*.pem` and `*.key`. Before any commit that stages broadly (`git add -A`),
check `git status` for untracked secrets. If a secret is ever committed,
rotating the credential is the fix — removing the file in a later commit does
not remove it from history.

## Secrets: `.env`

`.env` in the repo root holds `LINEAR_API_KEY`. It is git-ignored and must
stay that way. Never print the key, never paste it into a commit message,
an issue, a report, or a published artifact.

Read it at runtime from the environment or by parsing `.env`; do not copy the
value into any tracked file. There is no `.env.example` yet — add one with
empty values if the set of variables grows.

## Linear

The key authenticates as **Ibraheem Saleem** against the personal workspace
`ibraheem-saleem`, team **IBR**.

- Team overview: https://linear.app/ibraheem-saleem/team/IBR/overview
- Team key: `IBR` · team id: `7c4547c3-9bfd-4235-9141-cb069ccb3762`
- API: `POST https://api.linear.app/graphql`, header `Authorization: <key>`
  (the raw key, **no** `Bearer` prefix)
- Workflow states: `Backlog`, `Todo`, `In Progress`, `In Review`, `Done`,
  `Canceled`, `Duplicate`

**The key has WRITE scope.** It can create, edit and move issues. This is a
personal workspace, so a mistaken write is not a team-visible incident — but it
is still the user's real planning data. Do not create, close, or re-state
issues unless asked. Prefer reads.

**The running daemon writes to Linear on the user's behalf** (since the
two-way task sync): adding a task creates an issue, ticking moves it to
Done/Todo, removing ONE open task cancels it. Clearing the list never touches
Linear — one command must never be able to cancel the whole board. That is the feature the user asked
for, and it goes through `daemon/linear.js` only. `createServer()` builds no
Linear client unless one is passed in — only the real entry point builds one
from the key — so a test can never reach the real API. Keep it that way: tests
inject a fake `linear` or a fake `fetch`.

Zero-dependency access is fine: the daemon and any script can use Node's
global `fetch` against the GraphQL endpoint. Do not add an SDK — see the
dependency rule below.

## Architecture, and the rules that hold it up

    focus CLI  ──POST──►  ┌───────────────────────┐
                          │  daemon 127.0.0.1:7373 │
    popup      ──POST──►  │  owns ~/.config/       │
                          │    focus-nudge/        │
    extension  ◄──poll──  └───────────────────────┘

- **`daemon/core.js` is PURE.** No I/O, no `Date.now()`, no imports, no
  randomness — time is always an injected `now`. Every phase, grace, task and
  queue rule lives here. This is why it can carry ~50 exhaustive tests with no
  fixtures and no fake-clock library. Keep it pure.
- **`daemon/server.js` is the only component that performs I/O.** It executes
  the declarative effects `core.js` returns (`notify`, `log`, `openUrls`,
  `setSites`), persists state atomically, and serves HTTP on loopback only.
- **`extension/policy.js` is PURE** — the allow-or-nudge decision.
- **The CLI, popup, dashboard and pause screen are thin clients.** They hold no
  state and must not reimplement a daemon decision. When two surfaces need the
  same derived value, expose it from the daemon rather than computing it twice.

### Invariants that must not regress

1. **Fail closed toward discipline.** Any uncertainty — unreachable daemon,
   unknown phase — must nudge, never allow. A crashed daemon must never quietly
   hand over Reddit.
2. **The escape hatch must always work.** `continue anyway` is gated by a
   countdown but must never become permanently unavailable. A screen that traps
   the user is a bug.
3. **Never auto-delete the user's data.** Snooze and long break used to archive
   the micro-task list; that silently destroyed 29 open tasks over two weeks
   before it was reported. Only the user decides when a task is done. Linear
   sync follows the same rule: it may tick a task closed in Linear, but never
   unticks one, never deletes one, and never re-adds one the user removed.
4. **The daemon is the sole opener of saved links** (`xdg-open` via the
   `openUrls` effect). Extension pages must not open them too, or every link
   opens twice.
5. **Only phase EXPIRY makes a sound.** User-clicked transitions stay silent —
   a tool that beeps on every click becomes one you mute, and then the
   notification that mattered is silenced too.
6. **Nudging and the timer are independent switches.** Switching nudging off
   must never end, pause or reset a work block, and no timer transition may
   change whether sites nudge. Coupling them made the pomodoro unusable for
   work that lives on YouTube and Reddit (11 work blocks were ended by a snooze).

## House rules

- **Zero runtime dependencies.** Node built-ins only, no npm packages, no CDN
  links, no external fonts. `package.json` has no `dependencies` field, and
  that is deliberate.
- ESM everywhere, no build step. Chrome and Node both load these files directly.
- **Never `innerHTML`** in the extension — task text and site names are user
  input. Build DOM with `createElement`/`textContent`.
- **No new `chrome.*` permission** without asking. Each one is a prompt the
  user must accept; the manifest currently needs only `storage`, `tabs`,
  `webNavigation`, `alarms`.
- Conventional commit prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

## Testing

    npm test        # 317 tests, no browser needed

- **Tests must never touch `~/.config/focus-nudge/`.** It holds the user's real
  settings and block history. Use `fs.mkdtempSync` scratch dirs. This has bitten
  before: a test once rewrote the real config and changed the user's work-block
  length to 50 minutes.
- Test behaviour, not implementation. Several tests exist purely to pin
  deliberate choices so they cannot change silently — if one of those fails,
  the question is whether the intent changed, not how to make it pass.
- **Never edit a test to make failing code pass.** If a pinning test blocks a
  change the user asked for, replace it with one asserting the new intent, so
  the reversal is visible in the diff.

## Working against the live system

A daemon runs on port 7373 under systemd with the user's real data.

- Do not stop, restart, or reconfigure it without saying so; never start a
  second one competing for the port.
- Do not write under `~/.config/focus-nudge/`.
- Read-only is always fine: `focus status`, `focus stats`, `focus doctor`, and
  `curl` against the daemon.
- After changing daemon code the user must `systemctl --user restart
  focus-nudge`; after changing extension code they must hit reload on
  `chrome://extensions`. Say which is needed rather than doing it silently.
- `focus doctor` diagnoses a broken setup and is designed to work when the
  daemon is down.

## Browser behaviour cannot be verified from a shell

There is no way to load the extension and click through it from here. Static
checks, Node stub harnesses and `npm test` cover the logic; they do not cover
the browser. **Do not claim a browser behaviour works without evidence.**
`docs/VERIFICATION.md` records what a human has confirmed and what nobody has.

One check that has repeatedly caught real bugs: cross-reference every element
id in an extension `.html` against every `getElementById` in its `.js`. A typo
there breaks a button with no error at all.
