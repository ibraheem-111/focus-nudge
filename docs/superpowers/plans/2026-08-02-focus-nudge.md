# focus-nudge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a soft-block nudge system for Chrome on Ubuntu that pauses visits to distracting sites with a quote, a pomodoro countdown, and the user's unfinished micro-tasks.

**Architecture:** A zero-dependency Node daemon on `127.0.0.1:7373` is the single source of truth: a pure state machine (`core.js`) wrapped by a thin HTTP/persistence layer (`server.js`). An MV3 Chrome extension polls it, intercepts navigation via `webNavigation`, and renders three pages (interstitial, new tab, popup). A `focus` CLI and the popup are both thin clients of the same daemon, so they cannot disagree. All decision logic lives in two pure modules — `core.js` and `policy.js` — which are unit-tested under Node without a browser.

**Tech Stack:** Node v22 (ESM, `node:test`, global `fetch`, zero npm dependencies), MV3 Chrome extension (vanilla JS, no build step), `systemd --user`, `notify-send`.

**Spec:** `docs/superpowers/specs/2026-08-02-focus-nudge-design.md`

## Global Constraints

- **Zero runtime dependencies.** No npm packages in the daemon, CLI, or extension. Node built-ins only. `package.json` has no `dependencies` field.
- **ESM everywhere.** Root `package.json` sets `"type": "module"`. Extension modules use `import`/`export` so `node:test` and the MV3 service worker share the same files.
- **No build step.** Files are loaded directly by Node and by Chrome. No bundler, no transpiler.
- **`core.js` and `policy.js` are pure.** No I/O, no `Date.now()`, no `require`/`import` of anything but each other. Time is always an injected `now` parameter. This is what makes them testable.
- **Daemon binds loopback only:** `127.0.0.1`, port `7373` (configurable). No authentication — any process running as this user could edit the config files directly.
- **Fail closed toward discipline.** Any error, timeout, or unreachable daemon results in a nudge, never in an allow.
- **Phases never auto-advance.** An expired phase holds and reports negative remaining time until the user acts.
- **Site matching is on registrable domain, not path.** `reddit.com` covers `old.reddit.com`; it must not match `notreddit.com` or `reddit.com.evil.test`.
- **Default sites:** `reddit.com`, `youtube.com`. **Default timings:** work 25 min, short break 5 min, long break 20 min, 4 blocks per cycle, 5 min grace, 10 s countdown.
- **Nudging phases:** `IDLE`, `WORK`, `SHORT_BREAK`. **Open phases:** `LONG_BREAK`, `SNOOZED`.
- **Commit after every task.** Conventional commit prefixes (`feat:`, `test:`, `chore:`).

## File Structure

```
focus-nudge/
├── package.json                 type:module, test script, no deps
├── README.md                    install + usage
├── daemon/
│   ├── config.js                paths, DEFAULTS, loadConfig/saveConfig
│   ├── core.js                  PURE state machine: reduce, settle, view
│   └── server.js                HTTP, atomic persistence, notify-send, log
├── extension/
│   ├── manifest.json            MV3
│   ├── policy.js                PURE: matchSite, decide
│   ├── quotes.js                bundled quote list
│   ├── api.js                   daemon client (fetch + timeout + down-detect)
│   ├── ui.js                    shared formatters/renderers
│   ├── sw.js                    service worker: poll + intercept
│   ├── interstitial.html/.js    the pause screen
│   ├── newtab.html/.js          dashboard
│   ├── popup.html/.js           toolbar popup
│   └── style.css                shared styles for all three pages
├── cli/focus                    executable node script
├── systemd/focus-nudge.service
├── install.sh
└── test/
    ├── core.test.js
    ├── policy.test.js
    └── server.smoke.test.js
```

`core.js` holds all state rules; `server.js` holds all I/O. That split is the reason the hard logic is testable. `policy.js` lives under `extension/` because the extension is its only consumer, but it is plain ESM so Node tests import it directly.

---

### Task 1: Repo scaffold and config module

**Files:**
- Create: `package.json`
- Create: `daemon/config.js`
- Create: `README.md`
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `CONFIG_DIR: string`, `PATHS: {config, state, quotes, log}` (all absolute strings), `DEFAULTS: object`, `mergeConfig(raw) -> object`, `loadConfig(configPath = PATHS.config) -> object`, `saveConfig(cfg, configPath = PATHS.config) -> void`, `writeAtomic(file, text) -> void`.
- The path parameters on `loadConfig`/`saveConfig` exist so tests can exercise them against a scratch directory instead of the real `~/.config/focus-nudge`. Callers in later tasks invoke them with no arguments and get the real paths. This matches `createServer`'s path-injection idiom in Task 8.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "focus-nudge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "A pause, a quote, and your unfinished tasks before you open a distraction.",
  "scripts": {
    "test": "node --test",
    "daemon": "node daemon/server.js"
  },
  "engines": { "node": ">=22" }
}
```

- [ ] **Step 2: Write the failing test**

Create `test/config.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, PATHS, CONFIG_DIR, mergeConfig } from '../daemon/config.js'

test('DEFAULTS carry the spec values', () => {
  assert.equal(DEFAULTS.port, 7373)
  assert.equal(DEFAULTS.workMinutes, 25)
  assert.equal(DEFAULTS.shortBreakMinutes, 5)
  assert.equal(DEFAULTS.longBreakMinutes, 20)
  assert.equal(DEFAULTS.blocksPerCycle, 4)
  assert.equal(DEFAULTS.graceMinutes, 5)
  assert.equal(DEFAULTS.countdownSeconds, 10)
  assert.deepEqual(DEFAULTS.sites, ['reddit.com', 'youtube.com'])
})

test('PATHS all sit under CONFIG_DIR', () => {
  for (const p of Object.values(PATHS)) {
    assert.ok(p.startsWith(CONFIG_DIR + '/'), `${p} not under ${CONFIG_DIR}`)
  }
  assert.ok(CONFIG_DIR.endsWith('/.config/focus-nudge'))
})

test('mergeConfig fills gaps from DEFAULTS and keeps overrides', () => {
  const cfg = mergeConfig({ workMinutes: 50, sites: ['x.com'] })
  assert.equal(cfg.workMinutes, 50)
  assert.deepEqual(cfg.sites, ['x.com'])
  assert.equal(cfg.shortBreakMinutes, 5)
  assert.equal(cfg.port, 7373)
})

test('mergeConfig ignores unknown keys and non-objects', () => {
  assert.equal(mergeConfig({ nonsense: 1 }).nonsense, undefined)
  assert.equal(mergeConfig(null).port, 7373)
  assert.equal(mergeConfig('nope').port, 7373)
})

// The disk-facing half of the module. These use a scratch directory — never
// the real CONFIG_DIR, which holds the user's actual settings.
test('writeAtomic writes the file and leaves no temp file behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-cfg-'))
  const file = path.join(dir, 'thing.json')
  writeAtomic(file, '{"a":1}')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}')
  assert.deepEqual(fs.readdirSync(dir), ['thing.json'], 'the .tmp file was renamed, not left')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('writeAtomic overwrites an existing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-cfg-'))
  const file = path.join(dir, 'thing.json')
  writeAtomic(file, 'first')
  writeAtomic(file, 'second')
  assert.equal(fs.readFileSync(file, 'utf8'), 'second')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('saveConfig then loadConfig round-trips through a scratch path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-cfg-'))
  const file = path.join(dir, 'nested', 'config.json')
  saveConfig({ ...DEFAULTS, workMinutes: 50 }, file)
  assert.equal(loadConfig(file).workMinutes, 50, 'saveConfig creates parent dirs and loadConfig reads back')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('loadConfig falls back to DEFAULTS for a missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-cfg-'))
  assert.deepEqual(loadConfig(path.join(dir, 'nope.json')), DEFAULTS)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('loadConfig falls back to DEFAULTS for malformed json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-cfg-'))
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, '{ not json')
  assert.deepEqual(loadConfig(file), DEFAULTS)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('loadConfig fills partial config from DEFAULTS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-cfg-'))
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, JSON.stringify({ port: 9999 }))
  const cfg = loadConfig(file)
  assert.equal(cfg.port, 9999)
  assert.equal(cfg.workMinutes, 25, 'gaps come from DEFAULTS')
  fs.rmSync(dir, { recursive: true, force: true })
})
```

The imports at the top of the test file must therefore be:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULTS, PATHS, CONFIG_DIR, mergeConfig, loadConfig, saveConfig, writeAtomic,
} from '../daemon/config.js'
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL — cannot find module `../daemon/config.js`

- [ ] **Step 4: Write `daemon/config.js`**

```js
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'focus-nudge')

export const PATHS = {
  config: path.join(CONFIG_DIR, 'config.json'),
  state: path.join(CONFIG_DIR, 'state.json'),
  quotes: path.join(CONFIG_DIR, 'quotes.txt'),
  log: path.join(CONFIG_DIR, 'log.jsonl'),
}

export const DEFAULTS = {
  port: 7373,
  workMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 20,
  blocksPerCycle: 4,
  graceMinutes: 5,
  countdownSeconds: 10,
  sites: ['reddit.com', 'youtube.com'],
}

export function mergeConfig(raw) {
  const out = { ...DEFAULTS }
  if (!raw || typeof raw !== 'object') return out
  for (const key of Object.keys(DEFAULTS)) {
    if (raw[key] !== undefined) out[key] = raw[key]
  }
  return out
}

// The path is a parameter so tests can point at a scratch directory. Real
// callers pass nothing and get ~/.config/focus-nudge/config.json.
export function loadConfig(configPath = PATHS.config) {
  try {
    return mergeConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')))
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveConfig(cfg, configPath = PATHS.config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  writeAtomic(configPath, JSON.stringify(cfg, null, 2))
}

export function writeAtomic(file, text) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS, 10 tests

- [ ] **Step 6: Write `README.md`**

```markdown
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
```

- [ ] **Step 7: Commit**

```bash
git add package.json daemon/config.js README.md test/config.test.js
git commit -m "feat: add config module with spec defaults"
```

---

### Task 2: Core state machine — phases and the timer

**Files:**
- Create: `daemon/core.js`
- Test: `test/core.test.js`

**Interfaces:**
- Consumes: `DEFAULTS` from `daemon/config.js` (tests use it as the `config` argument).
- Produces:
  - `PHASE = {IDLE, WORK, SHORT_BREAK, LONG_BREAK, SNOOZED}` — string constants.
  - `initialState() -> State`
  - `reduce(state, action, now, config) -> {state, effects}` — pure, never mutates its input.
  - `State` shape: `{phase, endsAt, paused, pausedRemainingMs, expiredNotified, blocksCompleted, tasks, nextTaskId, queue, graces}`
  - `Effect` shape: `{type: 'notify', title, body}` | `{type: 'log', event, data}` | `{type: 'openUrls', urls}`
  - Actions in this task: `{type:'START'}`, `{type:'ADVANCE'}`, `{type:'PAUSE'}`, `{type:'STOP'}`

- [ ] **Step 1: Write the failing test**

Create `test/core.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PHASE, initialState, reduce } from '../daemon/core.js'
import { DEFAULTS } from '../daemon/config.js'

const CFG = DEFAULTS
const T0 = 1_000_000_000_000
const MIN = 60_000

test('initial state is idle with nothing running', () => {
  const s = initialState()
  assert.equal(s.phase, PHASE.IDLE)
  assert.equal(s.endsAt, null)
  assert.equal(s.blocksCompleted, 0)
  assert.deepEqual(s.tasks, [])
  assert.deepEqual(s.queue, [])
  assert.deepEqual(s.graces, {})
})

test('START from idle begins a 25 minute work block', () => {
  const { state, effects } = reduce(initialState(), { type: 'START' }, T0, CFG)
  assert.equal(state.phase, PHASE.WORK)
  assert.equal(state.endsAt, T0 + 25 * MIN)
  assert.equal(state.paused, false)
  assert.equal(state.expiredNotified, false)
  assert.ok(effects.some(e => e.type === 'notify'))
})

test('reduce does not mutate the state it is given', () => {
  const before = initialState()
  const snapshot = JSON.stringify(before)
  reduce(before, { type: 'START' }, T0, CFG)
  assert.equal(JSON.stringify(before), snapshot)
})

test('ADVANCE out of work goes to a short break and banks the block', () => {
  let s = reduce(initialState(), { type: 'START' }, T0, CFG).state
  const { state } = reduce(s, { type: 'ADVANCE' }, T0 + 25 * MIN, CFG)
  assert.equal(state.phase, PHASE.SHORT_BREAK)
  assert.equal(state.blocksCompleted, 1)
  assert.equal(state.endsAt, T0 + 25 * MIN + 5 * MIN)
})

test('ADVANCE out of a short break returns to work', () => {
  let s = reduce(initialState(), { type: 'START' }, T0, CFG).state
  s = reduce(s, { type: 'ADVANCE' }, T0, CFG).state
  const { state } = reduce(s, { type: 'ADVANCE' }, T0, CFG)
  assert.equal(state.phase, PHASE.WORK)
  assert.equal(state.blocksCompleted, 1, 'breaks do not bank blocks')
})

test('the fourth block advances into a long break and resets the cycle', () => {
  let s = initialState()
  for (let i = 0; i < 3; i++) {
    s = reduce(s, { type: 'START' }, T0, CFG).state
    s = reduce(s, { type: 'ADVANCE' }, T0, CFG).state   // -> SHORT_BREAK
    s = reduce(s, { type: 'ADVANCE' }, T0, CFG).state   // -> WORK
  }
  assert.equal(s.blocksCompleted, 3)
  const { state } = reduce(s, { type: 'ADVANCE' }, T0, CFG)
  assert.equal(state.phase, PHASE.LONG_BREAK)
  assert.equal(state.blocksCompleted, 0)
  assert.equal(state.endsAt, T0 + 20 * MIN)
})

test('ADVANCE out of a long break returns to work', () => {
  const s = { ...initialState(), phase: PHASE.LONG_BREAK, endsAt: T0 }
  assert.equal(reduce(s, { type: 'ADVANCE' }, T0, CFG).state.phase, PHASE.WORK)
})

test('ADVANCE while idle starts work rather than doing nothing', () => {
  assert.equal(reduce(initialState(), { type: 'ADVANCE' }, T0, CFG).state.phase, PHASE.WORK)
})

test('PAUSE banks the remaining time and START resumes it', () => {
  let s = reduce(initialState(), { type: 'START' }, T0, CFG).state
  s = reduce(s, { type: 'PAUSE' }, T0 + 10 * MIN, CFG).state
  assert.equal(s.paused, true)
  assert.equal(s.pausedRemainingMs, 15 * MIN)
  assert.equal(s.endsAt, null)

  s = reduce(s, { type: 'START' }, T0 + 60 * MIN, CFG).state
  assert.equal(s.paused, false)
  assert.equal(s.pausedRemainingMs, null)
  assert.equal(s.endsAt, T0 + 60 * MIN + 15 * MIN, 'resumes with 15 minutes left')
  assert.equal(s.phase, PHASE.WORK, 'resume keeps the phase it was paused in')
})

test('PAUSE while idle is a no-op', () => {
  const { state } = reduce(initialState(), { type: 'PAUSE' }, T0, CFG)
  assert.equal(state.paused, false)
  assert.equal(state.phase, PHASE.IDLE)
})

test('STOP returns to idle and clears the cycle', () => {
  let s = reduce(initialState(), { type: 'START' }, T0, CFG).state
  s = reduce(s, { type: 'ADVANCE' }, T0, CFG).state
  const { state } = reduce(s, { type: 'STOP' }, T0, CFG)
  assert.equal(state.phase, PHASE.IDLE)
  assert.equal(state.endsAt, null)
  assert.equal(state.blocksCompleted, 0)
})

test('an unknown action leaves the state untouched', () => {
  const s = initialState()
  const { state, effects } = reduce(s, { type: 'WAT' }, T0, CFG)
  assert.deepEqual(state, s)
  assert.deepEqual(effects, [])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/core.test.js`
Expected: FAIL — cannot find module `../daemon/core.js`

- [ ] **Step 3: Write `daemon/core.js`**

```js
// Pure state machine. No I/O, no clock: `now` is always injected.

export const PHASE = {
  IDLE: 'IDLE',
  WORK: 'WORK',
  SHORT_BREAK: 'SHORT_BREAK',
  LONG_BREAK: 'LONG_BREAK',
  SNOOZED: 'SNOOZED',
}

const MIN = 60_000

export function initialState() {
  return {
    phase: PHASE.IDLE,
    endsAt: null,
    paused: false,
    pausedRemainingMs: null,
    expiredNotified: false,
    blocksCompleted: 0,
    tasks: [],
    nextTaskId: 1,
    queue: [],
    graces: {},
  }
}

export function phaseDurationMs(phase, config) {
  switch (phase) {
    case PHASE.WORK: return config.workMinutes * MIN
    case PHASE.SHORT_BREAK: return config.shortBreakMinutes * MIN
    case PHASE.LONG_BREAK: return config.longBreakMinutes * MIN
    default: return null
  }
}

const LABEL = {
  [PHASE.WORK]: 'Work block',
  [PHASE.SHORT_BREAK]: 'Short break',
  [PHASE.LONG_BREAK]: 'Long break',
  [PHASE.SNOOZED]: 'Snoozed',
  [PHASE.IDLE]: 'Idle',
}

function enter(state, phase, now, config) {
  const duration = phaseDurationMs(phase, config)
  return {
    ...state,
    phase,
    endsAt: duration === null ? null : now + duration,
    paused: false,
    pausedRemainingMs: null,
    expiredNotified: false,
  }
}

function minutes(ms) {
  return Math.round(ms / MIN)
}

export function reduce(state, action, now, config) {
  const effects = []

  switch (action.type) {
    case 'START': {
      if (state.paused && state.pausedRemainingMs !== null) {
        effects.push({ type: 'log', event: 'resume', data: { phase: state.phase } })
        return {
          state: {
            ...state,
            paused: false,
            pausedRemainingMs: null,
            endsAt: now + state.pausedRemainingMs,
            expiredNotified: false,
          },
          effects,
        }
      }
      const next = enter(state, PHASE.WORK, now, config)
      effects.push({
        type: 'notify',
        title: 'Work block started',
        body: `${minutes(phaseDurationMs(PHASE.WORK, config))} minutes. ${openCount(next)} open tasks.`,
      })
      effects.push({ type: 'log', event: 'phase', data: { phase: PHASE.WORK } })
      return { state: next, effects }
    }

    case 'ADVANCE': {
      const from = state.phase
      let toPhase
      let banked = state.blocksCompleted

      if (from === PHASE.WORK) {
        banked = state.blocksCompleted + 1
        if (banked >= config.blocksPerCycle) {
          toPhase = PHASE.LONG_BREAK
          banked = 0
        } else {
          toPhase = PHASE.SHORT_BREAK
        }
        effects.push({ type: 'log', event: 'block_completed', data: {} })
      } else {
        toPhase = PHASE.WORK
      }

      let next = { ...enter(state, toPhase, now, config), blocksCompleted: banked }
      if (toPhase === PHASE.LONG_BREAK) next = openLongBreak(next, effects)

      effects.push({
        type: 'notify',
        title: LABEL[toPhase],
        body: `${minutes(phaseDurationMs(toPhase, config))} minutes.`,
      })
      effects.push({ type: 'log', event: 'phase', data: { phase: toPhase, from } })
      return { state: next, effects }
    }

    case 'PAUSE': {
      if (state.endsAt === null || state.paused) return { state, effects }
      effects.push({ type: 'log', event: 'pause', data: { phase: state.phase } })
      return {
        state: {
          ...state,
          paused: true,
          pausedRemainingMs: Math.max(0, state.endsAt - now),
          endsAt: null,
        },
        effects,
      }
    }

    case 'STOP': {
      effects.push({ type: 'log', event: 'phase', data: { phase: PHASE.IDLE, from: state.phase } })
      return {
        state: { ...enter(state, PHASE.IDLE, now, config), blocksCompleted: 0 },
        effects,
      }
    }

    default:
      return { state, effects }
  }
}

export function openCount(state) {
  return state.tasks.filter(t => !t.done).length
}

// Placeholder until Task 5 gives the long break its queue-and-archive behaviour.
function openLongBreak(state, _effects) {
  return state
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/core.test.js`
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add daemon/core.js test/core.test.js
git commit -m "feat: add core state machine for phases and timer"
```

---

### Task 3: Snooze and time settling

**Files:**
- Modify: `daemon/core.js`
- Modify: `test/core.test.js`

**Interfaces:**
- Consumes: `PHASE`, `initialState`, `reduce`, `enter` from Task 2.
- Produces: action `{type:'SNOOZE', hours}`; `settle(state, now, config) -> {state, effects}` — applies only time-driven changes (snooze expiry, one-shot expiry notification, grace pruning). It must be idempotent and must **never** advance a work or break phase.

- [ ] **Step 1: Write the failing test**

Append to `test/core.test.js`:

```js
import { settle } from '../daemon/core.js'

test('SNOOZE enters the snoozed phase for the requested hours', () => {
  const { state, effects } = reduce(initialState(), { type: 'SNOOZE', hours: 2 }, T0, CFG)
  assert.equal(state.phase, PHASE.SNOOZED)
  assert.equal(state.endsAt, T0 + 2 * 60 * MIN)
  assert.ok(effects.some(e => e.type === 'notify'))
})

test('SNOOZE accepts fractional hours and rejects nonsense', () => {
  assert.equal(reduce(initialState(), { type: 'SNOOZE', hours: 0.5 }, T0, CFG).state.endsAt, T0 + 30 * MIN)
  const bad = reduce(initialState(), { type: 'SNOOZE', hours: -1 }, T0, CFG)
  assert.equal(bad.state.phase, PHASE.IDLE, 'a negative snooze is ignored')
  const nan = reduce(initialState(), { type: 'SNOOZE', hours: 'soon' }, T0, CFG)
  assert.equal(nan.state.phase, PHASE.IDLE)
})

test('SNOOZE ends the cycle on entry, like a long break', () => {
  // Both sanctioned windows (LONG_BREAK, SNOOZED) end the cycle. Doing it on
  // entry rather than on expiry is what keeps the dashboard honest.
  const midCycle = { ...initialState(), phase: PHASE.WORK, endsAt: T0 + MIN, blocksCompleted: 2 }
  const { state } = reduce(midCycle, { type: 'SNOOZE', hours: 2 }, T0, CFG)
  assert.equal(state.phase, PHASE.SNOOZED)
  assert.equal(state.blocksCompleted, 0, 'the cycle ends when the snooze begins')
})

test('snooze expiry changes nothing the user can see except the phase', () => {
  let s = reduce(initialState(), { type: 'SNOOZE', hours: 1 }, T0, CFG).state
  s = { ...s, tasks: [{ id: 1, text: 'survive me', done: false }], nextTaskId: 2, graces: { 'reddit.com': T0 + 90 * MIN } }
  const { state } = settle(s, T0 + 60 * MIN, CFG)
  assert.equal(state.phase, PHASE.IDLE)
  assert.deepEqual(state.tasks, [{ id: 1, text: 'survive me', done: false }], 'tasks survive')
  assert.equal(state.nextTaskId, 2, 'task ids do not rewind')
  assert.equal(state.graces['reddit.com'], T0 + 90 * MIN, 'an unexpired grace survives')
  assert.equal(state.blocksCompleted, 0, 'already 0 from entry — nothing silently lost here')
})

test('settle returns snooze to idle once it expires', () => {
  const s = reduce(initialState(), { type: 'SNOOZE', hours: 1 }, T0, CFG).state
  const before = settle(s, T0 + 59 * MIN, CFG)
  assert.equal(before.state.phase, PHASE.SNOOZED, 'still snoozed a minute early')

  const after = settle(s, T0 + 60 * MIN, CFG)
  assert.equal(after.state.phase, PHASE.IDLE, 'expires exactly on the boundary')
  assert.ok(after.effects.some(e => e.type === 'notify'))
})

test('settle never auto-advances a work block', () => {
  const s = reduce(initialState(), { type: 'START' }, T0, CFG).state
  const { state } = settle(s, T0 + 99 * MIN, CFG)
  assert.equal(state.phase, PHASE.WORK, 'overrun holds its phase')
})

test('settle notifies exactly once when a phase expires', () => {
  const s = reduce(initialState(), { type: 'START' }, T0, CFG).state
  const first = settle(s, T0 + 25 * MIN, CFG)
  assert.equal(first.state.expiredNotified, true)
  assert.ok(first.effects.some(e => e.type === 'notify'))

  const second = settle(first.state, T0 + 26 * MIN, CFG)
  assert.deepEqual(second.effects, [], 'no repeat notification')
  assert.deepEqual(second.state, first.state, 'settle is idempotent')
})

test('settle is a no-op while idle', () => {
  const s = initialState()
  const { state, effects } = settle(s, T0 + 999 * MIN, CFG)
  assert.deepEqual(state, s)
  assert.deepEqual(effects, [])
})

// Pins a semantic the Task 2 review surfaced as undocumented: START means
// "resume if paused, otherwise begin a work block". Mid-break that is the
// useful "done resting" action; mid-work it restarts the block, discarding
// progress. That is a deliberate choice, not an accident — this test exists so
// it cannot change silently.
test('START restarts an active work block and ends a break early', () => {
  const running = reduce(initialState(), { type: 'START' }, T0, CFG).state
  const restarted = reduce(running, { type: 'START' }, T0 + 10 * MIN, CFG).state
  assert.equal(restarted.phase, PHASE.WORK)
  assert.equal(restarted.endsAt, T0 + 10 * MIN + 25 * MIN, 'a fresh 25 minutes, not the old endsAt')

  const onBreak = { ...initialState(), phase: PHASE.SHORT_BREAK, endsAt: T0 + 5 * MIN }
  const fromBreak = reduce(onBreak, { type: 'START' }, T0, CFG).state
  assert.equal(fromBreak.phase, PHASE.WORK, 'START ends a break early rather than being ignored')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/core.test.js`
Expected: FAIL — `settle` is not a function; `SNOOZE` falls through to the default case

- [ ] **Step 3: Add `SNOOZE` to the `reduce` switch in `daemon/core.js`**

Insert this case immediately before `case 'STOP':`

```js
    case 'SNOOZE': {
      const hours = Number(action.hours)
      if (!Number.isFinite(hours) || hours <= 0) return { state, effects }
      const next = {
        ...state,
        phase: PHASE.SNOOZED,
        endsAt: now + hours * 60 * MIN,
        paused: false,
        pausedRemainingMs: null,
        expiredNotified: false,
        // A snooze is a sanctioned window, exactly like a long break, so it
        // ends the cycle the same way BREAK_LONG does. Resetting on entry
        // rather than on expiry matters: otherwise the dashboard shows
        // "block 2 of 4" for the whole snooze and then silently zeroes it.
        blocksCompleted: 0,
      }
      effects.push({
        type: 'notify',
        title: 'Nudging off',
        body: `Back on in ${hours} hour${hours === 1 ? '' : 's'}.`,
      })
      effects.push({ type: 'log', event: 'snooze', data: { hours } })
      return { state: openLongBreak(next, effects), effects }
    }
```

- [ ] **Step 4: Add `settle` at the end of `daemon/core.js`**

```js
const EXPIRING_PHASES = new Set([PHASE.WORK, PHASE.SHORT_BREAK, PHASE.LONG_BREAK])

export function settle(state, now, config) {
  const effects = []
  let next = state

  if (next.phase === PHASE.SNOOZED && next.endsAt !== null && now >= next.endsAt) {
    next = { ...initialState(), tasks: next.tasks, nextTaskId: next.nextTaskId, queue: next.queue, graces: next.graces }
    effects.push({ type: 'notify', title: 'Nudging back on', body: 'Snooze finished.' })
    effects.push({ type: 'log', event: 'snooze_end', data: {} })
  }

  if (
    EXPIRING_PHASES.has(next.phase) &&
    next.endsAt !== null &&
    now >= next.endsAt &&
    !next.expiredNotified
  ) {
    next = { ...next, expiredNotified: true }
    effects.push({
      type: 'notify',
      title: `${LABEL[next.phase]} finished`,
      body: next.phase === PHASE.WORK ? 'Take your break.' : 'Ready when you are.',
    })
  }

  const live = {}
  for (const [site, until] of Object.entries(next.graces)) {
    if (until > now) live[site] = until
  }
  if (Object.keys(live).length !== Object.keys(next.graces).length) {
    next = { ...next, graces: live }
  }

  return { state: next, effects }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/core.test.js`
Expected: PASS, 21 tests

- [ ] **Step 6: Commit**

```bash
git add daemon/core.js test/core.test.js
git commit -m "feat: add snooze and idempotent time settling"
```

---

### Task 4: Per-site grace periods

**Files:**
- Modify: `daemon/core.js`
- Modify: `test/core.test.js`

**Interfaces:**
- Consumes: Task 3's `reduce` and `settle`.
- Produces: action `{type:'GRACE', site}` writing `state.graces[site] = now + graceMinutes*60000`.

- [ ] **Step 1: Write the failing test**

Append to `test/core.test.js`:

```js
test('GRACE grants a five minute pass for one site only', () => {
  const { state } = reduce(initialState(), { type: 'GRACE', site: 'reddit.com' }, T0, CFG)
  assert.equal(state.graces['reddit.com'], T0 + 5 * MIN)
  assert.equal(state.graces['youtube.com'], undefined, 'a reddit pass does not unlock youtube')
})

test('GRACE does not disturb the running phase', () => {
  const work = reduce(initialState(), { type: 'START' }, T0, CFG).state
  const { state } = reduce(work, { type: 'GRACE', site: 'reddit.com' }, T0 + MIN, CFG)
  assert.equal(state.phase, PHASE.WORK)
  assert.equal(state.endsAt, work.endsAt)
})

test('GRACE ignores a missing site', () => {
  const { state } = reduce(initialState(), { type: 'GRACE', site: '' }, T0, CFG)
  assert.deepEqual(state.graces, {})
})

test('a later GRACE for the same site extends the pass', () => {
  let s = reduce(initialState(), { type: 'GRACE', site: 'reddit.com' }, T0, CFG).state
  s = reduce(s, { type: 'GRACE', site: 'reddit.com' }, T0 + 4 * MIN, CFG).state
  assert.equal(s.graces['reddit.com'], T0 + 9 * MIN)
})

test('settle prunes graces once they lapse', () => {
  const s = reduce(initialState(), { type: 'GRACE', site: 'reddit.com' }, T0, CFG).state
  assert.equal(settle(s, T0 + 4 * MIN, CFG).state.graces['reddit.com'], T0 + 5 * MIN)
  assert.deepEqual(settle(s, T0 + 5 * MIN, CFG).state.graces, {}, 'lapses on the boundary')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/core.test.js`
Expected: FAIL — `GRACE` hits the default case, `state.graces` stays `{}`

- [ ] **Step 3: Add the `GRACE` case before `case 'STOP':` in `daemon/core.js`**

```js
    case 'GRACE': {
      const site = String(action.site || '').trim()
      if (!site) return { state, effects }
      effects.push({ type: 'log', event: 'continued', data: { site } })
      return {
        state: { ...state, graces: { ...state.graces, [site]: now + config.graceMinutes * MIN } },
        effects,
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/core.test.js`
Expected: PASS, 26 tests

- [ ] **Step 5: Commit**

```bash
git add daemon/core.js test/core.test.js
git commit -m "feat: add per-site grace periods"
```

---

### Task 5: Micro-tasks, the saved-links queue, and the long break

**Files:**
- Modify: `daemon/core.js`
- Modify: `test/core.test.js`

**Interfaces:**
- Consumes: Task 4's `reduce`; replaces the `openLongBreak` placeholder from Task 2.
- Produces: actions `{type:'TASK_ADD', text}`, `{type:'TASK_TOGGLE', id}`, `{type:'TASK_REMOVE', id}`, `{type:'TASK_CLEAR'}`, `{type:'QUEUE_ADD', url, title}`, `{type:'QUEUE_DRAIN'}`, `{type:'BREAK_LONG'}`, `{type:'SITE_ADD', site}`, `{type:'SITE_REMOVE', site}`.
  - Task record: `{id: number, text: string, done: boolean}`.
  - Queue record: `{url: string, title: string, savedAt: number}`.
  - `SITE_ADD`/`SITE_REMOVE` emit `{type:'setSites', sites}` effects; `server.js` persists them to `config.json`.
  - Entering `LONG_BREAK` or `SNOOZED` archives and clears tasks and emits `{type:'openUrls', urls}` when the queue is non-empty.

- [ ] **Step 1: Write the failing test**

Append to `test/core.test.js`:

```js
test('tasks can be added, toggled, and removed', () => {
  let s = reduce(initialState(), { type: 'TASK_ADD', text: 'fix the auth redirect' }, T0, CFG).state
  s = reduce(s, { type: 'TASK_ADD', text: 'write the regression test' }, T0, CFG).state
  assert.deepEqual(s.tasks.map(t => t.text), ['fix the auth redirect', 'write the regression test'])
  assert.deepEqual(s.tasks.map(t => t.id), [1, 2])
  assert.equal(s.tasks.every(t => t.done === false), true)

  s = reduce(s, { type: 'TASK_TOGGLE', id: 1 }, T0, CFG).state
  assert.equal(s.tasks[0].done, true)
  s = reduce(s, { type: 'TASK_TOGGLE', id: 1 }, T0, CFG).state
  assert.equal(s.tasks[0].done, false, 'toggle is reversible')

  s = reduce(s, { type: 'TASK_REMOVE', id: 1 }, T0, CFG).state
  assert.deepEqual(s.tasks.map(t => t.id), [2])
})

test('task ids keep climbing after a removal', () => {
  let s = reduce(initialState(), { type: 'TASK_ADD', text: 'a' }, T0, CFG).state
  s = reduce(s, { type: 'TASK_REMOVE', id: 1 }, T0, CFG).state
  s = reduce(s, { type: 'TASK_ADD', text: 'b' }, T0, CFG).state
  assert.equal(s.tasks[0].id, 2, 'ids are never reused')
})

test('blank tasks and unknown ids are ignored', () => {
  let s = reduce(initialState(), { type: 'TASK_ADD', text: '   ' }, T0, CFG).state
  assert.deepEqual(s.tasks, [])
  s = reduce(s, { type: 'TASK_TOGGLE', id: 99 }, T0, CFG).state
  assert.deepEqual(s.tasks, [])
})

test('task text is trimmed', () => {
  const s = reduce(initialState(), { type: 'TASK_ADD', text: '  ship it  ' }, T0, CFG).state
  assert.equal(s.tasks[0].text, 'ship it')
})

test('TASK_CLEAR empties the list silently and touches nothing else', () => {
  // The silent discard is deliberate and asymmetric with openLongBreak, which
  // logs tasks_archived. Clearing is an explicit user action; a phase
  // transition is involuntary, so only the latter needs a record. This test
  // pins that choice so it cannot drift.
  let s = reduce(initialState(), { type: 'TASK_ADD', text: 'a' }, T0, CFG).state
  s = reduce(s, { type: 'TASK_ADD', text: 'b' }, T0, CFG).state
  s = reduce(s, { type: 'QUEUE_ADD', url: 'https://reddit.com/r/x', title: 'x' }, T0, CFG).state
  s = reduce(s, { type: 'START' }, T0, CFG).state

  const { state, effects } = reduce(s, { type: 'TASK_CLEAR' }, T0, CFG)
  assert.deepEqual(state.tasks, [])
  assert.deepEqual(effects, [], 'an explicit clear is silent — no archive, no log')
  assert.equal(state.nextTaskId, 3, 'ids do not rewind, so a cleared id is never reused')
  assert.equal(state.queue.length, 1, 'the saved-links queue is untouched')
  assert.equal(state.phase, PHASE.WORK, 'the running block is untouched')

  const again = reduce(state, { type: 'TASK_CLEAR' }, T0, CFG)
  assert.deepEqual(again.state.tasks, [], 'idempotent on an already-empty list')
})

test('QUEUE_ADD saves a link and skips duplicates', () => {
  let s = reduce(initialState(), { type: 'QUEUE_ADD', url: 'https://reddit.com/r/x', title: 'x' }, T0, CFG).state
  assert.deepEqual(s.queue, [{ url: 'https://reddit.com/r/x', title: 'x', savedAt: T0 }])
  s = reduce(s, { type: 'QUEUE_ADD', url: 'https://reddit.com/r/x', title: 'x again' }, T0 + MIN, CFG).state
  assert.equal(s.queue.length, 1, 'the same url is not saved twice')
})

test('QUEUE_ADD requires a url', () => {
  const s = reduce(initialState(), { type: 'QUEUE_ADD', url: '', title: 't' }, T0, CFG).state
  assert.deepEqual(s.queue, [])
})

test('BREAK_LONG opens the queue and clears the task list', () => {
  let s = reduce(initialState(), { type: 'TASK_ADD', text: 'done thing' }, T0, CFG).state
  s = reduce(s, { type: 'QUEUE_ADD', url: 'https://reddit.com/r/x', title: 'x' }, T0, CFG).state

  const { state, effects } = reduce(s, { type: 'BREAK_LONG' }, T0, CFG)
  assert.equal(state.phase, PHASE.LONG_BREAK)
  assert.equal(state.endsAt, T0 + 20 * MIN)
  assert.deepEqual(state.tasks, [], 'the task list is cleared for the break')
  assert.deepEqual(state.queue, [], 'the queue is drained')

  const open = effects.find(e => e.type === 'openUrls')
  assert.deepEqual(open.urls, ['https://reddit.com/r/x'])
  assert.ok(effects.some(e => e.type === 'log' && e.event === 'tasks_archived'))
})

test('snoozing also drains the queue', () => {
  let s = reduce(initialState(), { type: 'QUEUE_ADD', url: 'https://reddit.com/r/y', title: 'y' }, T0, CFG).state
  const { state, effects } = reduce(s, { type: 'SNOOZE', hours: 2 }, T0, CFG)
  assert.deepEqual(state.queue, [])
  assert.deepEqual(effects.find(e => e.type === 'openUrls').urls, ['https://reddit.com/r/y'])
})

test('an empty queue produces no openUrls effect', () => {
  const { effects } = reduce(initialState(), { type: 'BREAK_LONG' }, T0, CFG)
  assert.equal(effects.some(e => e.type === 'openUrls'), false)
})

test('the automatic long break after four blocks also drains the queue', () => {
  let s = reduce(initialState(), { type: 'QUEUE_ADD', url: 'https://reddit.com/r/z', title: 'z' }, T0, CFG).state
  s = { ...s, blocksCompleted: 3, phase: PHASE.WORK, endsAt: T0 + MIN }
  const { state, effects } = reduce(s, { type: 'ADVANCE' }, T0, CFG)
  assert.equal(state.phase, PHASE.LONG_BREAK)
  assert.deepEqual(state.queue, [])
  assert.deepEqual(effects.find(e => e.type === 'openUrls').urls, ['https://reddit.com/r/z'])
})

test('QUEUE_DRAIN empties the queue without changing phase', () => {
  let s = reduce(initialState(), { type: 'QUEUE_ADD', url: 'https://reddit.com/r/x', title: 'x' }, T0, CFG).state
  const { state, effects } = reduce(s, { type: 'QUEUE_DRAIN' }, T0, CFG)
  assert.deepEqual(state.queue, [])
  assert.equal(state.phase, PHASE.IDLE)
  assert.deepEqual(effects.find(e => e.type === 'openUrls').urls, ['https://reddit.com/r/x'])
})

test('sites can be added and removed, and emit a setSites effect', () => {
  const added = reduce(initialState(), { type: 'SITE_ADD', site: 'News.YCombinator.com' }, T0, CFG)
  assert.deepEqual(added.effects.find(e => e.type === 'setSites').sites,
    ['reddit.com', 'youtube.com', 'news.ycombinator.com'], 'lowercased and appended')

  const dupe = reduce(initialState(), { type: 'SITE_ADD', site: 'reddit.com' }, T0, CFG)
  assert.deepEqual(dupe.effects.find(e => e.type === 'setSites').sites, ['reddit.com', 'youtube.com'])

  const removed = reduce(initialState(), { type: 'SITE_REMOVE', site: 'reddit.com' }, T0, CFG)
  assert.deepEqual(removed.effects.find(e => e.type === 'setSites').sites, ['youtube.com'])
})

test('SITE_ADD strips a scheme and path if one is pasted in', () => {
  const { effects } = reduce(initialState(), { type: 'SITE_ADD', site: 'https://news.ycombinator.com/best' }, T0, CFG)
  assert.deepEqual(effects.find(e => e.type === 'setSites').sites,
    ['reddit.com', 'youtube.com', 'news.ycombinator.com'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/core.test.js`
Expected: FAIL — all task, queue, site, and `BREAK_LONG` actions hit the default case

- [ ] **Step 3: Replace the `openLongBreak` placeholder in `daemon/core.js`**

Delete the placeholder from Task 2 and put this in its place:

```js
// Entering a sanctioned window (long break or snooze) archives the task list
// and drains the saved-links queue.
function openLongBreak(state, effects) {
  let next = state

  if (next.tasks.length > 0) {
    effects.push({
      type: 'log',
      event: 'tasks_archived',
      data: {
        tasks: next.tasks,
        open: next.tasks.filter(t => !t.done).length,
        done: next.tasks.filter(t => t.done).length,
      },
    })
    next = { ...next, tasks: [] }
  }

  if (next.queue.length > 0) {
    effects.push({ type: 'openUrls', urls: next.queue.map(q => q.url) })
    effects.push({ type: 'log', event: 'queue_drained', data: { count: next.queue.length } })
    next = { ...next, queue: [] }
  }

  return next
}

function normaliseSite(raw) {
  let s = String(raw || '').trim().toLowerCase()
  if (!s) return ''
  s = s.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].replace(/^www\./, '')
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : ''
}
```

- [ ] **Step 4: Add the remaining cases before `case 'STOP':` in `daemon/core.js`**

```js
    case 'BREAK_LONG': {
      const next = openLongBreak(enter(state, PHASE.LONG_BREAK, now, config), effects)
      effects.push({
        type: 'notify',
        title: 'Long break',
        body: `${minutes(phaseDurationMs(PHASE.LONG_BREAK, config))} minutes. Sites are open.`,
      })
      effects.push({ type: 'log', event: 'phase', data: { phase: PHASE.LONG_BREAK, from: state.phase } })
      return { state: { ...next, blocksCompleted: 0 }, effects }
    }

    case 'TASK_ADD': {
      const text = String(action.text || '').trim()
      if (!text) return { state, effects }
      return {
        state: {
          ...state,
          tasks: [...state.tasks, { id: state.nextTaskId, text, done: false }],
          nextTaskId: state.nextTaskId + 1,
        },
        effects,
      }
    }

    case 'TASK_TOGGLE': {
      if (!state.tasks.some(t => t.id === action.id)) return { state, effects }
      return {
        state: {
          ...state,
          tasks: state.tasks.map(t => (t.id === action.id ? { ...t, done: !t.done } : t)),
        },
        effects,
      }
    }

    case 'TASK_REMOVE': {
      if (!state.tasks.some(t => t.id === action.id)) return { state, effects }
      return { state: { ...state, tasks: state.tasks.filter(t => t.id !== action.id) }, effects }
    }

    case 'TASK_CLEAR':
      return { state: { ...state, tasks: [] }, effects }

    case 'QUEUE_ADD': {
      const url = String(action.url || '').trim()
      if (!url || state.queue.some(q => q.url === url)) return { state, effects }
      effects.push({ type: 'log', event: 'saved_for_later', data: { url } })
      return {
        state: {
          ...state,
          queue: [...state.queue, { url, title: String(action.title || '').trim(), savedAt: now }],
        },
        effects,
      }
    }

    case 'QUEUE_DRAIN': {
      if (state.queue.length === 0) return { state, effects }
      effects.push({ type: 'openUrls', urls: state.queue.map(q => q.url) })
      effects.push({ type: 'log', event: 'queue_drained', data: { count: state.queue.length } })
      return { state: { ...state, queue: [] }, effects }
    }

    case 'SITE_ADD': {
      const site = normaliseSite(action.site)
      if (!site) return { state, effects }
      const sites = config.sites.includes(site) ? [...config.sites] : [...config.sites, site]
      effects.push({ type: 'setSites', sites })
      return { state, effects }
    }

    case 'SITE_REMOVE': {
      const site = normaliseSite(action.site)
      if (!site) return { state, effects }
      effects.push({ type: 'setSites', sites: config.sites.filter(s => s !== site) })
      return { state, effects }
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/core.test.js`
Expected: PASS, 40 tests

- [ ] **Step 6: Commit**

```bash
git add daemon/core.js test/core.test.js
git commit -m "feat: add micro-tasks, saved-links queue, and long break"
```

---

### Task 6: The `view` projection

**Files:**
- Modify: `daemon/core.js`
- Modify: `test/core.test.js`

**Interfaces:**
- Consumes: Task 5's `core.js`.
- Produces: `view(state, now, config) -> ViewState`, the exact JSON body of `GET /state`. Every extension page and the CLI read only these keys:

```
{ phase, endsAt, remainingMs, overrun, paused, blocksCompleted, blocksPerCycle,
  tasks: [{id,text,done}], openTaskCount, queue: [{url,title,savedAt}], queueDepth,
  sites: [...], graces: {site: expiryMs}, countdownSeconds, graceMinutes,
  nudgingPhase, serverTime }
```

- [ ] **Step 1: Write the failing test**

Append to `test/core.test.js`:

```js
import { view } from '../daemon/core.js'

test('view reports a running block with positive remaining time', () => {
  const s = reduce(initialState(), { type: 'START' }, T0, CFG).state
  const v = view(s, T0 + 10 * MIN, CFG)
  assert.equal(v.phase, PHASE.WORK)
  assert.equal(v.remainingMs, 15 * MIN)
  assert.equal(v.overrun, false)
  assert.equal(v.nudgingPhase, true)
  assert.equal(v.blocksPerCycle, 4)
  assert.equal(v.countdownSeconds, 10)
  assert.equal(v.graceMinutes, 5)
  assert.deepEqual(v.sites, ['reddit.com', 'youtube.com'])
  assert.equal(v.serverTime, T0 + 10 * MIN)
})

test('view reports an overrun as negative remaining time', () => {
  const s = reduce(initialState(), { type: 'START' }, T0, CFG).state
  const v = view(s, T0 + 30 * MIN, CFG)
  assert.equal(v.remainingMs, -5 * MIN)
  assert.equal(v.overrun, true)
  assert.equal(v.phase, PHASE.WORK, 'still work, per the no-auto-advance rule')
})

test('view reports remaining time for a paused phase', () => {
  let s = reduce(initialState(), { type: 'START' }, T0, CFG).state
  s = reduce(s, { type: 'PAUSE' }, T0 + 10 * MIN, CFG).state
  const v = view(s, T0 + 90 * MIN, CFG)
  assert.equal(v.paused, true)
  assert.equal(v.remainingMs, 15 * MIN, 'a paused clock does not run down')
  assert.equal(v.overrun, false)
})

test('view reports null remaining while idle', () => {
  const v = view(initialState(), T0, CFG)
  assert.equal(v.remainingMs, null)
  assert.equal(v.overrun, false)
  assert.equal(v.nudgingPhase, true, 'idle still nudges')
})

test('view marks the sanctioned phases as not nudging', () => {
  assert.equal(view({ ...initialState(), phase: PHASE.LONG_BREAK }, T0, CFG).nudgingPhase, false)
  assert.equal(view({ ...initialState(), phase: PHASE.SNOOZED }, T0, CFG).nudgingPhase, false)
  assert.equal(view({ ...initialState(), phase: PHASE.SHORT_BREAK }, T0, CFG).nudgingPhase, true)
})

test('view counts open tasks and queue depth', () => {
  let s = reduce(initialState(), { type: 'TASK_ADD', text: 'a' }, T0, CFG).state
  s = reduce(s, { type: 'TASK_ADD', text: 'b' }, T0, CFG).state
  s = reduce(s, { type: 'TASK_TOGGLE', id: 1 }, T0, CFG).state
  s = reduce(s, { type: 'QUEUE_ADD', url: 'https://reddit.com/x', title: 'x' }, T0, CFG).state
  const v = view(s, T0, CFG)
  assert.equal(v.openTaskCount, 1)
  assert.equal(v.tasks.length, 2)
  assert.equal(v.queueDepth, 1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/core.test.js`
Expected: FAIL — `view` is not a function

- [ ] **Step 3: Add `view` to `daemon/core.js`**

```js
export const NUDGING_PHASES = new Set([PHASE.IDLE, PHASE.WORK, PHASE.SHORT_BREAK])

export function view(state, now, config) {
  let remainingMs = null
  if (state.paused && state.pausedRemainingMs !== null) remainingMs = state.pausedRemainingMs
  else if (state.endsAt !== null) remainingMs = state.endsAt - now

  return {
    phase: state.phase,
    endsAt: state.endsAt,
    remainingMs,
    overrun: remainingMs !== null && !state.paused && remainingMs < 0,
    paused: state.paused,
    blocksCompleted: state.blocksCompleted,
    blocksPerCycle: config.blocksPerCycle,
    tasks: state.tasks,
    openTaskCount: openCount(state),
    queue: state.queue,
    queueDepth: state.queue.length,
    sites: config.sites,
    graces: state.graces,
    countdownSeconds: config.countdownSeconds,
    graceMinutes: config.graceMinutes,
    nudgingPhase: NUDGING_PHASES.has(state.phase),
    serverTime: now,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/core.test.js`
Expected: PASS, 46 tests

- [ ] **Step 5: Commit**

```bash
git add daemon/core.js test/core.test.js
git commit -m "feat: add view projection for the state endpoint"
```

---

### Task 7: The nudge policy

**Files:**
- Create: `extension/policy.js`
- Test: `test/policy.test.js`

**Interfaces:**
- Consumes: nothing — `policy.js` is standalone and duplicates the nudging-phase set as string literals so the extension never has to import from `daemon/`.
- Produces:
  - `NUDGE_PHASES: Set<string>`
  - `matchSite(url: string, sites: string[]) -> string | null` — the matched site, or null.
  - `decide({url, phase, graces, sites, now}) -> {action: 'allow'|'nudge', site: string|null, reason: string}`
  - Reasons: `'not-web'`, `'bad-url'`, `'no-match'`, `'sanctioned'`, `'grace'`, `'nudge'`, `'no-state'`.

- [ ] **Step 1: Write the failing test**

Create `test/policy.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchSite, decide, NUDGE_PHASES } from '../extension/policy.js'

const SITES = ['reddit.com', 'youtube.com']
const T0 = 1_000_000_000_000

test('matchSite matches the domain itself and any subdomain', () => {
  assert.equal(matchSite('https://reddit.com/', SITES), 'reddit.com')
  assert.equal(matchSite('https://www.reddit.com/r/x', SITES), 'reddit.com')
  assert.equal(matchSite('https://old.reddit.com/r/x', SITES), 'reddit.com')
  assert.equal(matchSite('https://music.youtube.com/watch?v=1', SITES), 'youtube.com')
  assert.equal(matchSite('https://m.youtube.com/', SITES), 'youtube.com')
})

test('matchSite is case insensitive and ignores port and path', () => {
  assert.equal(matchSite('https://OLD.REDDIT.COM:443/r/x', SITES), 'reddit.com')
})

test('matchSite rejects lookalike domains', () => {
  assert.equal(matchSite('https://notreddit.com/', SITES), null)
  assert.equal(matchSite('https://reddit.com.evil.test/', SITES), null)
  assert.equal(matchSite('https://myreddit.com/', SITES), null)
  assert.equal(matchSite('https://example.com/?q=reddit.com', SITES), null)
})

test('matchSite returns null for unparseable or non-web urls', () => {
  assert.equal(matchSite('not a url', SITES), null)
  assert.equal(matchSite('', SITES), null)
  assert.equal(matchSite(undefined, SITES), null)
  assert.equal(matchSite('chrome-extension://abc/newtab.html', SITES), null)
})

test('the nudging phases are exactly idle, work, and short break', () => {
  assert.deepEqual([...NUDGE_PHASES].sort(), ['IDLE', 'SHORT_BREAK', 'WORK'])
})

test('a watched site is nudged during work', () => {
  const d = decide({ url: 'https://reddit.com/', phase: 'WORK', graces: {}, sites: SITES, now: T0 })
  assert.equal(d.action, 'nudge')
  assert.equal(d.site, 'reddit.com')
  assert.equal(d.reason, 'nudge')
})

test('a watched site is nudged during a short break, because breaks are zen time', () => {
  assert.equal(decide({ url: 'https://youtube.com/', phase: 'SHORT_BREAK', graces: {}, sites: SITES, now: T0 }).action, 'nudge')
})

test('a watched site is nudged while idle', () => {
  assert.equal(decide({ url: 'https://reddit.com/', phase: 'IDLE', graces: {}, sites: SITES, now: T0 }).action, 'nudge')
})

test('long break and snooze are sanctioned windows', () => {
  for (const phase of ['LONG_BREAK', 'SNOOZED']) {
    const d = decide({ url: 'https://reddit.com/', phase, graces: {}, sites: SITES, now: T0 })
    assert.equal(d.action, 'allow', `${phase} should allow`)
    assert.equal(d.reason, 'sanctioned')
  }
})

test('an unwatched site is always allowed', () => {
  const d = decide({ url: 'https://example.com/', phase: 'WORK', graces: {}, sites: SITES, now: T0 })
  assert.equal(d.action, 'allow')
  assert.equal(d.reason, 'no-match')
})

test('a live grace lets the matched site through and nothing else', () => {
  const graces = { 'reddit.com': T0 + 60_000 }
  assert.equal(decide({ url: 'https://reddit.com/', phase: 'WORK', graces, sites: SITES, now: T0 }).reason, 'grace')
  assert.equal(decide({ url: 'https://youtube.com/', phase: 'WORK', graces, sites: SITES, now: T0 }).action, 'nudge')
})

test('a lapsed grace nudges again, expiring on the boundary', () => {
  const graces = { 'reddit.com': T0 }
  assert.equal(decide({ url: 'https://reddit.com/', phase: 'WORK', graces, sites: SITES, now: T0 }).action, 'nudge')
  assert.equal(decide({ url: 'https://reddit.com/', phase: 'WORK', graces, sites: SITES, now: T0 - 1 }).action, 'allow')
})

test('non-http schemes are left alone', () => {
  for (const url of ['chrome://settings', 'about:blank', 'file:///home/x', 'chrome-extension://a/b.html']) {
    assert.equal(decide({ url, phase: 'WORK', graces: {}, sites: SITES, now: T0 }).action, 'allow')
  }
})

test('an unknown phase fails closed and nudges', () => {
  const d = decide({ url: 'https://reddit.com/', phase: 'GARBAGE', graces: {}, sites: SITES, now: T0 })
  assert.equal(d.action, 'nudge')
})

test('a missing phase fails closed and nudges a watched site', () => {
  const d = decide({ url: 'https://reddit.com/', phase: null, graces: null, sites: SITES, now: T0 })
  assert.equal(d.action, 'nudge')
  assert.equal(d.reason, 'no-state')
})

test('a missing site list falls back to the built-in defaults', () => {
  assert.equal(decide({ url: 'https://reddit.com/', phase: 'WORK', graces: {}, sites: null, now: T0 }).action, 'nudge')
  assert.equal(decide({ url: 'https://example.com/', phase: 'WORK', graces: {}, sites: null, now: T0 }).action, 'allow')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/policy.test.js`
Expected: FAIL — cannot find module `../extension/policy.js`

- [ ] **Step 3: Write `extension/policy.js`**

```js
// Pure nudge decision. Imported by the MV3 service worker and by node:test.
// No I/O, no clock: `now` is injected.

export const NUDGE_PHASES = new Set(['IDLE', 'WORK', 'SHORT_BREAK'])
export const FALLBACK_SITES = ['reddit.com', 'youtube.com']

export function matchSite(url, sites) {
  let host
  try {
    const parsed = new URL(String(url))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    host = parsed.hostname.toLowerCase()
  } catch {
    return null
  }
  const list = Array.isArray(sites) && sites.length ? sites : FALLBACK_SITES
  for (const raw of list) {
    const site = String(raw).toLowerCase()
    if (host === site || host.endsWith('.' + site)) return site
  }
  return null
}

export function decide({ url, phase, graces, sites, now }) {
  const site = matchSite(url, sites)
  if (!site) return { action: 'allow', site: null, reason: 'no-match' }

  // Fail closed: with no usable phase we nudge rather than guess.
  if (typeof phase !== 'string' || phase.length === 0) {
    return { action: 'nudge', site, reason: 'no-state' }
  }

  if (!NUDGE_PHASES.has(phase)) {
    // A known sanctioned phase opens the site; an unrecognised one fails closed.
    if (phase === 'LONG_BREAK' || phase === 'SNOOZED') {
      return { action: 'allow', site, reason: 'sanctioned' }
    }
    return { action: 'nudge', site, reason: 'nudge' }
  }

  const until = graces && typeof graces === 'object' ? graces[site] : undefined
  if (typeof until === 'number' && until > now) {
    return { action: 'allow', site, reason: 'grace' }
  }

  return { action: 'nudge', site, reason: 'nudge' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/policy.test.js`
Expected: PASS, 16 tests

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS, 72 tests across three files (config 10, core 46, policy 16)

- [ ] **Step 6: Commit**

```bash
git add extension/policy.js test/policy.test.js
git commit -m "feat: add pure nudge policy with domain matching"
```

---

### Task 8: The HTTP daemon

**Files:**
- Create: `daemon/server.js`
- Test: `test/server.smoke.test.js`

**Interfaces:**
- Consumes: `loadConfig`, `saveConfig`, `writeAtomic`, `PATHS`, `CONFIG_DIR` (Task 1); `initialState`, `reduce`, `settle`, `view` (Tasks 2–6).
- Produces: `createServer({config, statePath, logPath, quotesPath, notify, openUrls}) -> {server, dispatch, listen}` — the injectable factory the smoke test drives on an ephemeral port. `daemon/server.js` run directly starts it on `config.port`.
- Endpoints: `GET /state`, `GET /quotes`, `GET /stats`, `POST /timer`, `POST /snooze`, `POST /tasks`, `POST /sites`, `POST /queue`, `POST /grace`. Every response is JSON; every mutating response returns the fresh `view` so clients need no second round trip.

- [ ] **Step 1: Write the failing smoke test**

Create `test/server.smoke.test.js`:

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../daemon/server.js'
import { DEFAULTS } from '../daemon/config.js'

let base
let tmp
let handle
const notified = []
const opened = []

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-test-'))
  handle = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath: path.join(tmp, 'state.json'),
    logPath: path.join(tmp, 'log.jsonl'),
    quotesPath: path.join(tmp, 'quotes.txt'),
    configPath: path.join(tmp, 'config.json'),
    notify: (title, body) => notified.push({ title, body }),
    openUrls: urls => opened.push(...urls),
  })
  const port = await handle.listen(0)
  base = `http://127.0.0.1:${port}`
})

after(() => {
  handle.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const get = async p => (await fetch(base + p)).json()
const post = async (p, body) =>
  (await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })).json()

test('GET /state returns an idle view', async () => {
  const v = await get('/state')
  assert.equal(v.phase, 'IDLE')
  assert.equal(v.remainingMs, null)
  assert.deepEqual(v.sites, ['reddit.com', 'youtube.com'])
})

test('every response carries permissive CORS headers for the extension', async () => {
  const res = await fetch(base + '/state')
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
})

test('OPTIONS preflight is answered', async () => {
  const res = await fetch(base + '/timer', { method: 'OPTIONS' })
  assert.equal(res.status, 204)
  assert.ok(res.headers.get('access-control-allow-headers').includes('content-type'))
})

test('POST /timer start begins a work block and notifies', async () => {
  const v = await post('/timer', { action: 'start' })
  assert.equal(v.phase, 'WORK')
  assert.ok(v.remainingMs > 24 * 60_000)
  assert.ok(notified.length > 0)
})

test('POST /tasks round-trips add, toggle, and remove', async () => {
  let v = await post('/tasks', { action: 'add', text: 'fix the auth redirect' })
  assert.equal(v.tasks.length, 1)
  const id = v.tasks[0].id

  v = await post('/tasks', { action: 'toggle', id })
  assert.equal(v.tasks[0].done, true)
  assert.equal(v.openTaskCount, 0)

  v = await post('/tasks', { action: 'remove', id })
  assert.deepEqual(v.tasks, [])
})

test('POST /grace then GET /state shows the pass', async () => {
  const v = await post('/grace', { site: 'reddit.com' })
  assert.ok(v.graces['reddit.com'] > Date.now())
})

test('POST /queue add stores a link', async () => {
  const v = await post('/queue', { url: 'https://reddit.com/r/x', title: 'x' })
  assert.equal(v.queueDepth, 1)
})

test('a long break drains the queue through the openUrls hook', async () => {
  opened.length = 0
  const v = await post('/timer', { action: 'breakLong' })
  assert.equal(v.phase, 'LONG_BREAK')
  assert.equal(v.queueDepth, 0)
  assert.deepEqual(opened, ['https://reddit.com/r/x'])
})

test('POST /sites persists to the config file and shows in the view', async () => {
  const v = await post('/sites', { action: 'add', site: 'news.ycombinator.com' })
  assert.ok(v.sites.includes('news.ycombinator.com'))
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'))
  assert.ok(onDisk.sites.includes('news.ycombinator.com'))
})

test('POST /snooze opens the sanctioned window', async () => {
  const v = await post('/snooze', { hours: 2 })
  assert.equal(v.phase, 'SNOOZED')
  assert.equal(v.nudgingPhase, false)
})

test('state survives a restart', async () => {
  await post('/tasks', { action: 'add', text: 'persist me' })
  handle.close()

  const second = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath: path.join(tmp, 'state.json'),
    logPath: path.join(tmp, 'log.jsonl'),
    quotesPath: path.join(tmp, 'quotes.txt'),
    configPath: path.join(tmp, 'config.json'),
    notify: () => {},
    openUrls: () => {},
  })
  const port = await second.listen(0)
  const v = await (await fetch(`http://127.0.0.1:${port}/state`)).json()
  assert.ok(v.tasks.some(t => t.text === 'persist me'))
  second.close()

  handle = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath: path.join(tmp, 'state.json'),
    logPath: path.join(tmp, 'log.jsonl'),
    quotesPath: path.join(tmp, 'quotes.txt'),
    configPath: path.join(tmp, 'config.json'),
    notify: () => {},
    openUrls: () => {},
  })
  base = `http://127.0.0.1:${await handle.listen(0)}`
})

test('GET /quotes reads the user quotes file', async () => {
  fs.writeFileSync(path.join(tmp, 'quotes.txt'),
    '# a comment\n\nHold the line. — Someone\nNo attribution here\n')
  const { quotes } = await get('/quotes')
  assert.deepEqual(quotes, [
    { text: 'Hold the line.', author: 'Someone' },
    { text: 'No attribution here', author: '' },
  ])
})

test('GET /quotes returns an empty list when the file is missing', async () => {
  fs.rmSync(path.join(tmp, 'quotes.txt'), { force: true })
  assert.deepEqual((await get('/quotes')).quotes, [])
})

test('GET /stats summarises the log', async () => {
  const s = await get('/stats')
  assert.equal(typeof s.blocksCompleted, 'number')
  assert.equal(typeof s.nudgesContinued, 'number')
  assert.equal(typeof s.savedForLater, 'number')
})

test('a corrupt state file is replaced with defaults rather than crashing', async () => {
  handle.close()
  const statePath = path.join(tmp, 'state.json')
  fs.writeFileSync(statePath, '{ not json')
  const rescued = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath,
    logPath: path.join(tmp, 'log.jsonl'),
    quotesPath: path.join(tmp, 'quotes.txt'),
    configPath: path.join(tmp, 'config.json'),
    notify: () => {},
    openUrls: () => {},
  })
  const port = await rescued.listen(0)
  const v = await (await fetch(`http://127.0.0.1:${port}/state`)).json()
  assert.equal(v.phase, 'IDLE')
  assert.ok(fs.existsSync(statePath + '.corrupt'), 'the bad file is kept for inspection')
  rescued.close()

  handle = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath,
    logPath: path.join(tmp, 'log.jsonl'),
    quotesPath: path.join(tmp, 'quotes.txt'),
    configPath: path.join(tmp, 'config.json'),
    notify: () => {},
    openUrls: () => {},
  })
  base = `http://127.0.0.1:${await handle.listen(0)}`
})

test('an unknown route returns 404 as json', async () => {
  const res = await fetch(base + '/nope')
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error, 'not found')
})

test('a malformed json body returns 400 rather than crashing', async () => {
  const res = await fetch(base + '/timer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ nope',
  })
  assert.equal(res.status, 400)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server.smoke.test.js`
Expected: FAIL — cannot find module `../daemon/server.js`

- [ ] **Step 3: Write `daemon/server.js`**

```js
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { loadConfig, saveConfig, writeAtomic, PATHS, CONFIG_DIR, mergeConfig } from './config.js'
import { initialState, reduce, settle, view } from './core.js'

const TIMER_ACTIONS = {
  start: 'START',
  skip: 'ADVANCE',
  next: 'ADVANCE',
  pause: 'PAUSE',
  stop: 'STOP',
  breakLong: 'BREAK_LONG',
}

export function parseQuotes(text) {
  return String(text)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      // Accept an em dash or a double hyphen as the author separator.
      const m = line.match(/^(.*?)\s+(?:—|--)\s+(.+)$/)
      return m ? { text: m[1].trim(), author: m[2].trim() } : { text: line, author: '' }
    })
}

export function summariseLog(text) {
  const stats = { blocksCompleted: 0, nudgesContinued: 0, savedForLater: 0, queueDrained: 0 }
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (entry.event === 'block_completed') stats.blocksCompleted++
    else if (entry.event === 'continued') stats.nudgesContinued++
    else if (entry.event === 'saved_for_later') stats.savedForLater++
    else if (entry.event === 'queue_drained') stats.queueDrained++
  }
  return stats
}

export function createServer(opts = {}) {
  const paths = {
    state: opts.statePath ?? PATHS.state,
    log: opts.logPath ?? PATHS.log,
    quotes: opts.quotesPath ?? PATHS.quotes,
    config: opts.configPath ?? PATHS.config,
  }
  let config = opts.config ?? loadConfig()
  const notify = opts.notify ?? desktopNotify
  const openUrls = opts.openUrls ?? (urls => urls.forEach(u => spawnDetached('xdg-open', [u])))

  fs.mkdirSync(path.dirname(paths.state), { recursive: true })
  let state = readState(paths.state)

  function readState(file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      return { ...initialState(), ...parsed }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        try { fs.renameSync(file, file + '.corrupt') } catch {}
        console.error(`focus-nudge: unreadable state file, starting fresh (kept at ${file}.corrupt)`)
      }
      return initialState()
    }
  }

  function persist() {
    try {
      writeAtomic(paths.state, JSON.stringify(state, null, 2))
    } catch (err) {
      console.error('focus-nudge: could not write state:', err.message)
    }
  }

  function runEffects(effects) {
    for (const e of effects) {
      if (e.type === 'notify') notify(e.title, e.body)
      else if (e.type === 'log') appendLog(e.event, e.data)
      else if (e.type === 'openUrls') openUrls(e.urls)
      else if (e.type === 'setSites') {
        config = mergeConfig({ ...config, sites: e.sites })
        try {
          fs.mkdirSync(path.dirname(paths.config), { recursive: true })
          writeAtomic(paths.config, JSON.stringify(config, null, 2))
        } catch (err) {
          console.error('focus-nudge: could not write config:', err.message)
        }
      }
    }
  }

  function appendLog(event, data) {
    try {
      fs.appendFileSync(paths.log, JSON.stringify({ at: Date.now(), event, ...data }) + '\n')
    } catch {}
  }

  // Applies time-driven changes. Called before every request and once a second.
  function tick(now = Date.now()) {
    const result = settle(state, now, config)
    if (result.effects.length || result.state !== state) {
      state = result.state
      runEffects(result.effects)
      persist()
    }
  }

  function dispatch(action, now = Date.now()) {
    tick(now)
    const result = reduce(state, action, now, config)
    state = result.state
    runEffects(result.effects)
    persist()
    return view(state, now, config)
  }

  function currentView(now = Date.now()) {
    tick(now)
    return view(state, now, config)
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(body))
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      })
      return res.end()
    }

    const url = new URL(req.url, 'http://127.0.0.1')
    const route = url.pathname

    try {
      if (req.method === 'GET') {
        if (route === '/state') return send(200, currentView())
        if (route === '/quotes') {
          let quotes = []
          try { quotes = parseQuotes(fs.readFileSync(paths.quotes, 'utf8')) } catch {}
          return send(200, { quotes })
        }
        if (route === '/stats') {
          let text = ''
          try { text = fs.readFileSync(paths.log, 'utf8') } catch {}
          return send(200, { ...summariseLog(text), ...currentView() })
        }
        return send(404, { error: 'not found' })
      }

      if (req.method === 'POST') {
        let body = {}
        const raw = await readBody(req)
        if (raw.trim()) {
          try { body = JSON.parse(raw) } catch { return send(400, { error: 'malformed json' }) }
        }

        switch (route) {
          case '/timer': {
            const type = TIMER_ACTIONS[body.action]
            if (!type) return send(400, { error: 'unknown timer action' })
            return send(200, dispatch({ type }))
          }
          case '/snooze':
            return send(200, dispatch({ type: 'SNOOZE', hours: body.hours }))
          case '/tasks': {
            const map = { add: 'TASK_ADD', toggle: 'TASK_TOGGLE', remove: 'TASK_REMOVE', clear: 'TASK_CLEAR' }
            const type = map[body.action]
            if (!type) return send(400, { error: 'unknown task action' })
            return send(200, dispatch({ type, text: body.text, id: body.id }))
          }
          case '/sites': {
            const map = { add: 'SITE_ADD', remove: 'SITE_REMOVE' }
            const type = map[body.action]
            if (!type) return send(400, { error: 'unknown site action' })
            return send(200, dispatch({ type, site: body.site }))
          }
          case '/queue': {
            if (body.drain) return send(200, dispatch({ type: 'QUEUE_DRAIN' }))
            return send(200, dispatch({ type: 'QUEUE_ADD', url: body.url, title: body.title }))
          }
          case '/grace':
            return send(200, dispatch({ type: 'GRACE', site: body.site }))
          default:
            return send(404, { error: 'not found' })
        }
      }

      return send(405, { error: 'method not allowed' })
    } catch (err) {
      console.error('focus-nudge: request failed:', err)
      return send(500, { error: 'internal error' })
    }
  })

  let interval = null

  return {
    server,
    dispatch,
    currentView,
    listen(port = config.port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          interval = setInterval(() => tick(), 1000)
          resolve(server.address().port)
        })
      })
    },
    close() {
      if (interval) clearInterval(interval)
      server.close()
    },
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => {
      data += chunk
      if (data.length > 1e6) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

let notifyWarned = false
function spawnDetached(cmd, args) {
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
  } catch (err) {
    if (!notifyWarned) {
      console.error(`focus-nudge: could not run ${cmd}: ${err.message}`)
      notifyWarned = true
    }
  }
}

function desktopNotify(title, body) {
  spawnDetached('notify-send', ['--app-name=focus-nudge', '--icon=appointment-soon', title, body])
}

// Started directly rather than imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const handle = createServer()
  const cfg = loadConfig()
  handle.listen(cfg.port).then(
    port => console.log(`focus-nudge listening on http://127.0.0.1:${port}`),
    err => {
      if (err.code === 'EADDRINUSE') {
        console.error(`focus-nudge: port ${cfg.port} is already in use. Another daemon is probably running:`)
        console.error('  systemctl --user status focus-nudge')
      } else {
        console.error('focus-nudge: could not start:', err.message)
      }
      process.exit(1)
    }
  )
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { handle.close(); process.exit(0) })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server.smoke.test.js`
Expected: PASS, 17 tests

- [ ] **Step 5: Run the whole suite and start the daemon by hand**

Run: `npm test`
Expected: PASS, 89 tests

Run: `node daemon/server.js &` then `curl -s localhost:7373/state | head -c 200` then `kill %1`
Expected: JSON with `"phase":"IDLE"`

- [ ] **Step 6: Commit**

```bash
git add daemon/server.js test/server.smoke.test.js
git commit -m "feat: add http daemon with persistence and notifications"
```

---

### Task 9: The `focus` CLI

**Files:**
- Create: `cli/focus`
- Test: manual, per the steps below

**Interfaces:**
- Consumes: the HTTP endpoints from Task 8 and `loadConfig` from Task 1.
- Produces: an executable script. Commands: `start`, `skip`, `pause`, `stop`, `break`, `off <duration>`, `status`, `task [<text> | done <id> | rm <id> | clear]`, `sites [add|remove <domain>]`, `queue [drain]`, `stats`.

- [ ] **Step 1: Write `cli/focus`**

```js
#!/usr/bin/env node
import { loadConfig } from '../daemon/config.js'

const config = loadConfig()
const BASE = `http://127.0.0.1:${config.port}`

const PHASE_LABEL = {
  IDLE: 'idle',
  WORK: 'work',
  SHORT_BREAK: 'short break',
  LONG_BREAK: 'long break',
  SNOOZED: 'snoozed',
}

async function call(method, route, body) {
  let res
  try {
    res = await fetch(BASE + route, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    console.error('focus: the daemon is not running. Start it with:')
    console.error('  systemctl --user start focus-nudge')
    process.exit(1)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    console.error(`focus: ${data.error || res.statusText}`)
    process.exit(1)
  }
  return data
}

function formatDuration(ms) {
  const sign = ms < 0 ? '-' : ''
  const total = Math.floor(Math.abs(ms) / 1000)
  const m = Math.floor(total / 60)
  const s = String(total % 60).padStart(2, '0')
  return `${sign}${m}:${s}`
}

// "2h", "90m", "1.5h", or a bare number of hours.
function parseDuration(input) {
  const m = String(input ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*([hm]?)$/i)
  if (!m) return null
  const value = Number(m[1])
  if (!Number.isFinite(value) || value <= 0) return null
  return m[2].toLowerCase() === 'm' ? value / 60 : value
}

function printStatus(v) {
  const label = PHASE_LABEL[v.phase] ?? v.phase
  let line = label
  if (v.remainingMs !== null) {
    line += v.paused
      ? ` — paused, ${formatDuration(v.remainingMs)} left`
      : v.overrun
        ? ` — ran over by ${formatDuration(-v.remainingMs)}`
        : ` — ${formatDuration(v.remainingMs)} left`
  }
  if (v.phase === 'WORK' || v.phase === 'SHORT_BREAK') {
    line += `  [block ${v.blocksCompleted + (v.phase === 'WORK' ? 1 : 0)}/${v.blocksPerCycle}]`
  }
  console.log(line)

  if (v.tasks.length) {
    console.log()
    for (const t of v.tasks) console.log(`  ${t.done ? '[x]' : '[ ]'} ${t.id}  ${t.text}`)
  }
  if (v.queueDepth) {
    console.log()
    console.log(`  ${v.queueDepth} link${v.queueDepth === 1 ? '' : 's'} saved for your next long break`)
  }
}

const [cmd, ...rest] = process.argv.slice(2)

switch (cmd) {
  case 'start':
    printStatus(await call('POST', '/timer', { action: 'start' }))
    break
  case 'skip':
  case 'next':
    printStatus(await call('POST', '/timer', { action: 'skip' }))
    break
  case 'pause':
    printStatus(await call('POST', '/timer', { action: 'pause' }))
    break
  case 'stop':
    printStatus(await call('POST', '/timer', { action: 'stop' }))
    break
  case 'break':
    printStatus(await call('POST', '/timer', { action: 'breakLong' }))
    break
  case 'off': {
    const hours = parseDuration(rest[0] ?? '1')
    if (hours === null) {
      console.error('focus: could not read that duration. Try "focus off 2h" or "focus off 90m".')
      process.exit(1)
    }
    printStatus(await call('POST', '/snooze', { hours }))
    break
  }
  case undefined:
  case 'status':
    printStatus(await call('GET', '/state'))
    break
  case 'task': {
    const [sub, ...words] = rest
    if (!sub) { printStatus(await call('GET', '/state')); break }
    if (sub === 'done' || sub === 'toggle') {
      printStatus(await call('POST', '/tasks', { action: 'toggle', id: Number(words[0]) }))
    } else if (sub === 'rm' || sub === 'remove') {
      printStatus(await call('POST', '/tasks', { action: 'remove', id: Number(words[0]) }))
    } else if (sub === 'clear') {
      printStatus(await call('POST', '/tasks', { action: 'clear' }))
    } else {
      printStatus(await call('POST', '/tasks', { action: 'add', text: [sub, ...words].join(' ') }))
    }
    break
  }
  case 'sites': {
    const [sub, domain] = rest
    if (!sub) {
      const v = await call('GET', '/state')
      for (const s of v.sites) console.log(`  ${s}`)
      break
    }
    if (sub !== 'add' && sub !== 'remove') {
      console.error('focus: use "focus sites add <domain>" or "focus sites remove <domain>".')
      process.exit(1)
    }
    const v = await call('POST', '/sites', { action: sub, site: domain })
    for (const s of v.sites) console.log(`  ${s}`)
    break
  }
  case 'queue': {
    if (rest[0] === 'drain') {
      printStatus(await call('POST', '/queue', { drain: true }))
      break
    }
    const v = await call('GET', '/state')
    if (!v.queue.length) console.log('  nothing saved')
    for (const q of v.queue) console.log(`  ${q.title || q.url}\n    ${q.url}`)
    break
  }
  case 'stats': {
    const s = await call('GET', '/stats')
    console.log(`  blocks completed   ${s.blocksCompleted}`)
    console.log(`  continued anyway   ${s.nudgesContinued}`)
    console.log(`  saved for later    ${s.savedForLater}`)
    console.log(`  queues drained     ${s.queueDrained}`)
    break
  }
  default:
    console.error(`focus: unknown command "${cmd}"`)
    console.error('  focus [status|start|skip|pause|stop|break|off <dur>|task|sites|queue|stats]')
    process.exit(1)
}
```

- [ ] **Step 2: Make it executable and start the daemon**

```bash
chmod +x cli/focus
node daemon/server.js &
```

- [ ] **Step 3: Exercise every command**

```bash
./cli/focus status
./cli/focus start
./cli/focus task "fix the auth redirect"
./cli/focus task "write the regression test"
./cli/focus task done 1
./cli/focus status
./cli/focus skip
./cli/focus off 90m
./cli/focus status
./cli/focus stop
./cli/focus sites
./cli/focus sites add news.ycombinator.com
./cli/focus sites remove news.ycombinator.com
./cli/focus stats
```

Expected: `status` shows `idle`; `start` shows `work — 25:00 left  [block 1/4]`; the tasks list with `[x] 1` after `task done 1`; `off 90m` shows `snoozed — 90:00 left`; `sites` lists two domains, then three, then two again.

- [ ] **Step 4: Check the daemon-down message**

```bash
kill %1
./cli/focus status; echo "exit=$?"
```

Expected: `focus: the daemon is not running.` and `exit=1`

- [ ] **Step 5: Commit**

```bash
git add cli/focus
git commit -m "feat: add focus cli"
```

---

### Task 10: systemd unit and installer

**Files:**
- Create: `systemd/focus-nudge.service`
- Create: `install.sh`

**Interfaces:**
- Consumes: `daemon/server.js` (Task 8), `cli/focus` (Task 9).
- Produces: an enabled `systemctl --user` unit named `focus-nudge`, and `focus` on `PATH` via a symlink in `~/.local/bin`.

- [ ] **Step 1: Write `systemd/focus-nudge.service`**

```ini
[Unit]
Description=focus-nudge daemon
Documentation=https://github.com/ibraheem/focus-nudge
After=graphical-session.target

[Service]
Type=simple
ExecStart=__NODE__ __REPO__/daemon/server.js
Restart=on-failure
RestartSec=2
# notify-send and xdg-open need the session bus.
Environment=DISPLAY=:0

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Write `install.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="$(command -v node)"
UNIT_DIR="$HOME/.config/systemd/user"
BIN_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/focus-nudge"

if [ -z "$NODE" ]; then
  echo "install: node is not on PATH" >&2
  exit 1
fi

echo "==> creating $CONFIG_DIR"
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/quotes.txt" ]; then
  cat > "$CONFIG_DIR/quotes.txt" <<'EOF'
# One quote per line, as: text — author
# The author is optional. Lines starting with # are ignored.
# These are added to the list bundled with the extension.
EOF
  echo "    wrote a starter quotes.txt"
fi

echo "==> installing the systemd user unit"
mkdir -p "$UNIT_DIR"
sed -e "s|__NODE__|$NODE|g" -e "s|__REPO__|$REPO|g" \
  "$REPO/systemd/focus-nudge.service" > "$UNIT_DIR/focus-nudge.service"
systemctl --user daemon-reload
systemctl --user enable --now focus-nudge.service

echo "==> linking the focus command into $BIN_DIR"
mkdir -p "$BIN_DIR"
chmod +x "$REPO/cli/focus"
ln -sf "$REPO/cli/focus" "$BIN_DIR/focus"

sleep 1
if focus status >/dev/null 2>&1; then
  echo "==> daemon is up"
  focus status
else
  echo "!! the daemon did not answer. Check: systemctl --user status focus-nudge" >&2
  exit 1
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: $BIN_DIR is not on your PATH. Add it to ~/.bashrc." ;;
esac

cat <<EOF

One step left — load the extension:
  1. open chrome://extensions
  2. turn on Developer mode
  3. click "Load unpacked" and choose:
       $REPO/extension
EOF
```

- [ ] **Step 3: Run the installer**

```bash
chmod +x install.sh
./install.sh
```

Expected: `==> daemon is up` followed by `idle`

- [ ] **Step 4: Verify the unit restarts and survives**

```bash
systemctl --user is-enabled focus-nudge
systemctl --user restart focus-nudge && sleep 1 && focus status
```

Expected: `enabled`, then `idle`

- [ ] **Step 5: Commit**

```bash
git add systemd/focus-nudge.service install.sh
git commit -m "feat: add systemd user unit and installer"
```

---

### Task 11: Extension scaffold — manifest, quotes, client, shared UI

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/quotes.js`
- Create: `extension/api.js`
- Create: `extension/ui.js`
- Create: `extension/style.css`
- Test: `test/quotes.test.js`

**Interfaces:**
- Consumes: `policy.js` (Task 7) is referenced by the manifest's module graph in Task 12.
- Produces:
  - `BUNDLED_QUOTES: Array<{text, author}>` and `pickQuote(bundled, user, randomFn) -> {text, author}`
  - `api.getState()`, `api.getQuotes()`, `api.timer(action)`, `api.snooze(hours)`, `api.task(action, payload)`, `api.site(action, site)`, `api.queueAdd(url, title)`, `api.queueDrain()`, `api.grace(site)`, `api.DAEMON_DOWN` — a sentinel object `{down: true}` returned instead of throwing.
  - `formatDuration(ms) -> string`, `phaseLabel(view) -> string`, `renderTasks(el, tasks, onToggle)`

- [ ] **Step 1: Write the failing test**

Create `test/quotes.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUNDLED_QUOTES, pickQuote } from '../extension/quotes.js'

test('the bundled list is substantial and well formed', () => {
  assert.ok(BUNDLED_QUOTES.length >= 40, `only ${BUNDLED_QUOTES.length} quotes`)
  for (const q of BUNDLED_QUOTES) {
    assert.equal(typeof q.text, 'string')
    assert.ok(q.text.length > 0)
    assert.equal(typeof q.author, 'string')
  }
})

test('no quote is duplicated', () => {
  const seen = new Set(BUNDLED_QUOTES.map(q => q.text))
  assert.equal(seen.size, BUNDLED_QUOTES.length)
})

test('pickQuote draws from the bundled and user lists together', () => {
  const user = [{ text: 'mine', author: 'me' }]
  const last = pickQuote(BUNDLED_QUOTES, user, () => 0.999999)
  assert.equal(last.text, 'mine', 'user quotes sit at the end of the pool')
  const first = pickQuote(BUNDLED_QUOTES, user, () => 0)
  assert.equal(first.text, BUNDLED_QUOTES[0].text)
})

test('pickQuote copes with an empty user list and a missing one', () => {
  assert.ok(pickQuote(BUNDLED_QUOTES, [], () => 0.5).text)
  assert.ok(pickQuote(BUNDLED_QUOTES, null, () => 0.5).text)
})

test('pickQuote never returns undefined at the top of the range', () => {
  assert.ok(pickQuote(BUNDLED_QUOTES, [], () => 0.9999999999).text)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/quotes.test.js`
Expected: FAIL — cannot find module `../extension/quotes.js`

- [ ] **Step 3: Write `extension/quotes.js`**

```js
// Ships with the extension so the pause screen works before the daemon is up
// and before any personal quotes are written. Additions go in
// ~/.config/focus-nudge/quotes.txt, which the daemon serves at GET /quotes.

export const BUNDLED_QUOTES = [
  { text: 'You have power over your mind — not outside events. Realize this, and you will find strength.', author: 'Marcus Aurelius' },
  { text: 'The impediment to action advances action. What stands in the way becomes the way.', author: 'Marcus Aurelius' },
  { text: 'You could leave life right now. Let that determine what you do and say and think.', author: 'Marcus Aurelius' },
  { text: 'Confine yourself to the present.', author: 'Marcus Aurelius' },
  { text: 'It is not that we have a short time to live, but that we waste a lot of it.', author: 'Seneca' },
  { text: 'While we are postponing, life speeds by.', author: 'Seneca' },
  { text: 'Begin at once to live, and count each separate day as a separate life.', author: 'Seneca' },
  { text: 'No person has the power to have everything they want, but it is in their power not to want what they don’t have.', author: 'Seneca' },
  { text: 'First say to yourself what you would be; then do what you have to do.', author: 'Epictetus' },
  { text: 'No man is free who is not master of himself.', author: 'Epictetus' },
  { text: 'If you want to improve, be content to be thought foolish and stupid.', author: 'Epictetus' },
  { text: 'How long are you going to wait before you demand the best for yourself?', author: 'Epictetus' },
  { text: 'Discipline equals freedom.', author: 'Jocko Willink' },
  { text: 'Motivation is unreliable. Discipline is a decision you already made.', author: 'Jocko Willink' },
  { text: 'Discipline is choosing between what you want now and what you want most.', author: 'Abraham Lincoln' },
  { text: 'We are what we repeatedly do. Excellence, then, is not an act but a habit.', author: 'Aristotle' },
  { text: 'The successful warrior is the average man, with laser-like focus.', author: 'Bruce Lee' },
  { text: 'I fear not the man who has practiced ten thousand kicks once, but the man who has practiced one kick ten thousand times.', author: 'Bruce Lee' },
  { text: 'It is not enough to be busy. The question is: what are we busy about?', author: 'Henry David Thoreau' },
  { text: 'The cost of a thing is the amount of life which must be exchanged for it.', author: 'Henry David Thoreau' },
  { text: 'You do not rise to the level of your goals. You fall to the level of your systems.', author: 'James Clear' },
  { text: 'Every action you take is a vote for the person you wish to become.', author: 'James Clear' },
  { text: 'Amateurs sit and wait for inspiration. The rest of us just get up and go to work.', author: 'Stephen King' },
  { text: 'Inspiration is for amateurs. The rest of us show up and get to work.', author: 'Chuck Close' },
  { text: 'The work is the only thing that matters. The rest is noise.', author: 'Unknown' },
  { text: 'Deep work is the ability to focus without distraction on a cognitively demanding task.', author: 'Cal Newport' },
  { text: 'Clarity about what matters provides clarity about what does not.', author: 'Cal Newport' },
  { text: 'A wandering mind is an unhappy mind.', author: 'Killingsworth and Gilbert' },
  { text: 'Concentration is the root of all the higher abilities in man.', author: 'Bruce Lee' },
  { text: 'You will never always be motivated. You must learn to be disciplined.', author: 'Unknown' },
  { text: 'The successful person has the habit of doing the things failures do not like to do.', author: 'E. M. Gray' },
  { text: 'Do the hard jobs first. The easy jobs will take care of themselves.', author: 'Dale Carnegie' },
  { text: 'There is nothing so useless as doing efficiently that which should not be done at all.', author: 'Peter Drucker' },
  { text: 'Absorb what is useful, discard what is useless, add what is specifically your own.', author: 'Bruce Lee' },
  { text: 'Simplicity is the ultimate sophistication.', author: 'Leonardo da Vinci' },
  { text: 'What gets measured gets managed.', author: 'Peter Drucker' },
  { text: 'The man who moves a mountain begins by carrying away small stones.', author: 'Confucius' },
  { text: 'It does not matter how slowly you go so long as you do not stop.', author: 'Confucius' },
  { text: 'Persistence is the twin sister of excellence.', author: 'Marabel Morgan' },
  { text: 'Hard choices, easy life. Easy choices, hard life.', author: 'Jerzy Gregorek' },
  { text: 'Suffer the pain of discipline or suffer the pain of regret.', author: 'Unknown' },
  { text: 'You are always one decision away from a totally different life.', author: 'Unknown' },
  { text: 'The tragedy is not that we die, but that we are so easily distracted from living.', author: 'Unknown' },
  { text: 'Attention is the rarest and purest form of generosity.', author: 'Simone Weil' },
  { text: 'Where your attention goes, your life goes.', author: 'Unknown' },
]

export function pickQuote(bundled, user, randomFn = Math.random) {
  const pool = [...(bundled ?? []), ...(Array.isArray(user) ? user : [])]
  if (pool.length === 0) return { text: 'Back to work.', author: '' }
  const index = Math.min(pool.length - 1, Math.floor(randomFn() * pool.length))
  return pool[index]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/quotes.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Write `extension/manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "focus-nudge",
  "version": "0.1.0",
  "description": "A pause, a quote, and your unfinished tasks before you open a distraction.",
  "permissions": ["storage", "tabs", "webNavigation", "alarms"],
  "host_permissions": ["http://127.0.0.1/*"],
  "background": { "service_worker": "sw.js", "type": "module" },
  "action": { "default_popup": "popup.html", "default_title": "focus-nudge" },
  "chrome_url_overrides": { "newtab": "newtab.html" }
}
```

- [ ] **Step 6: Write `extension/api.js`**

```js
// Thin client for the daemon. Never throws: an unreachable daemon yields
// DAEMON_DOWN, and callers fail closed toward nudging.

const PORT = 7373
const BASE = `http://127.0.0.1:${PORT}`
const TIMEOUT_MS = 1500

export const DAEMON_DOWN = Object.freeze({ down: true })

async function request(method, route, body) {
  try {
    const res = await fetch(BASE + route, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return DAEMON_DOWN
    return await res.json()
  } catch {
    return DAEMON_DOWN
  }
}

export const isDown = v => !v || v === DAEMON_DOWN || v.down === true

export const getState = () => request('GET', '/state')
export const getQuotes = () => request('GET', '/quotes')
export const getStats = () => request('GET', '/stats')
export const timer = action => request('POST', '/timer', { action })
export const snooze = hours => request('POST', '/snooze', { hours })
export const task = (action, payload = {}) => request('POST', '/tasks', { action, ...payload })
export const site = (action, s) => request('POST', '/sites', { action, site: s })
export const queueAdd = (url, title) => request('POST', '/queue', { url, title })
export const queueDrain = () => request('POST', '/queue', { drain: true })
export const grace = s => request('POST', '/grace', { site: s })
```

- [ ] **Step 7: Write `extension/ui.js`**

```js
export const PHASE_LABEL = {
  IDLE: 'idle',
  WORK: 'work block',
  SHORT_BREAK: 'short break',
  LONG_BREAK: 'long break',
  SNOOZED: 'snoozed',
}

export function formatDuration(ms) {
  const total = Math.floor(Math.abs(ms) / 1000)
  const m = Math.floor(total / 60)
  const s = String(total % 60).padStart(2, '0')
  return `${ms < 0 ? '-' : ''}${m}:${s}`
}

export function clockLine(v) {
  if (!v || v.remainingMs === null || v.remainingMs === undefined) return 'no block running'
  if (v.paused) return `${formatDuration(v.remainingMs)} left — paused`
  if (v.overrun) return `ran over by ${formatDuration(-v.remainingMs)}`
  const noun = v.phase === 'WORK' ? 'in this block' : 'of your break'
  return `${formatDuration(v.remainingMs)} left ${noun}`
}

export function renderTasks(el, tasks, { onToggle, onRemove } = {}) {
  el.replaceChildren()
  if (!tasks || tasks.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = 'no micro-tasks yet'
    el.append(empty)
    return
  }
  for (const t of tasks) {
    const row = document.createElement('label')
    row.className = 'task' + (t.done ? ' done' : '')

    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = t.done
    if (onToggle) box.addEventListener('change', () => onToggle(t.id))

    const text = document.createElement('span')
    text.textContent = t.text

    row.append(box, text)

    if (onRemove) {
      const x = document.createElement('button')
      x.className = 'task-remove'
      x.type = 'button'
      x.textContent = '×'
      x.title = 'remove'
      x.addEventListener('click', e => { e.preventDefault(); onRemove(t.id) })
      row.append(x)
    }
    el.append(row)
  }
}
```

- [ ] **Step 8: Write `extension/style.css`**

```css
:root {
  --bg: #12100e;
  --panel: #1b1815;
  --ink: #ece6dd;
  --muted: #948b7f;
  --line: #2e2823;
  --accent: #d98f4a;
  --ok: #7fa86b;
  font-family: ui-sans-serif, system-ui, -apple-system, "Inter", sans-serif;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
}

.wrap { max-width: 34rem; margin: 0 auto; padding: 2rem 1.5rem; }

.quote { font-size: 1.4rem; line-height: 1.5; font-weight: 400; margin: 0 0 0.75rem; }
.quote-author { color: var(--muted); font-size: 0.95rem; margin: 0 0 2rem; }

hr { border: 0; border-top: 1px solid var(--line); margin: 1.5rem 0; }

.clock { font-variant-numeric: tabular-nums; font-size: 1.1rem; }
.clock.overrun { color: var(--accent); }
.phase-chip {
  float: right; font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0.15rem 0.6rem;
}

.tasks { display: flex; flex-direction: column; gap: 0.4rem; margin: 1rem 0; }
.task { display: flex; align-items: center; gap: 0.6rem; cursor: pointer; }
.task.done span { color: var(--muted); text-decoration: line-through; }
.task-remove {
  margin-left: auto; background: none; border: 0; color: var(--muted);
  cursor: pointer; font-size: 1rem; line-height: 1;
}
.empty { color: var(--muted); font-style: italic; margin: 0.5rem 0; }

input[type="text"] {
  width: 100%; background: var(--panel); border: 1px solid var(--line);
  color: var(--ink); border-radius: 6px; padding: 0.55rem 0.7rem; font: inherit;
}
input[type="text"]::placeholder { color: var(--muted); }

.actions { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 1.5rem; }

button {
  font: inherit; cursor: pointer; border-radius: 6px; padding: 0.6rem 1.1rem;
  border: 1px solid var(--line); background: var(--panel); color: var(--ink);
}
button:hover { border-color: var(--muted); }
button.primary { background: var(--accent); border-color: var(--accent); color: #17120d; font-weight: 600; }
button.ghost { background: none; border: 0; color: var(--muted); padding: 0.4rem 0; font-size: 0.9rem; }
button.ghost:disabled { color: #5b544c; cursor: not-allowed; }
button.small { padding: 0.35rem 0.7rem; font-size: 0.85rem; }

.center { text-align: center; }
.down { color: var(--accent); font-size: 0.85rem; margin-top: 1rem; }
.down code { background: var(--panel); padding: 0.1rem 0.35rem; border-radius: 4px; }
```

- [ ] **Step 9: Commit**

```bash
git add extension/manifest.json extension/quotes.js extension/api.js extension/ui.js extension/style.css test/quotes.test.js
git commit -m "feat: add extension scaffold, bundled quotes, and daemon client"
```

---

### Task 12: Service worker — polling and navigation interception

**Files:**
- Create: `extension/sw.js`

**Interfaces:**
- Consumes: `decide` from `policy.js` (Task 7); `getState`, `isDown` from `api.js` (Task 11).
- Produces: navigation interception, plus a message API used by the pause screen:
  - `{type:'goBack', tabId}` → returns the tab to the URL it came from, or closes it.
  - `{type:'cachedState'}` → `{view, down}` for pages that need state before their first fetch returns.
  - Session storage key `priorUrl:<tabId>` records where a tab was before it was intercepted.

- [ ] **Step 1: Write `extension/sw.js`**

```js
import { decide } from './policy.js'
import { getState, isDown } from './api.js'

const POLL_ALARM = 'focus-nudge-poll'
const CACHE_KEY = 'cachedView'
const FRESH_MS = 2000

let cache = { view: null, at: 0, down: true }

async function refresh() {
  const v = await getState()
  if (isDown(v)) {
    cache = { ...cache, down: true, at: Date.now() }
  } else {
    cache = { view: v, at: Date.now(), down: false }
    try {
      await chrome.storage.session.set({ [CACHE_KEY]: v })
    } catch {}
  }
  return cache
}

async function currentCache() {
  if (cache.view && Date.now() - cache.at < FRESH_MS) return cache
  // A woken service worker starts with an empty module scope; fall back to
  // session storage so a decision is never made on nothing.
  if (!cache.view) {
    try {
      const stored = await chrome.storage.session.get(CACHE_KEY)
      if (stored[CACHE_KEY]) cache = { view: stored[CACHE_KEY], at: 0, down: false }
    } catch {}
  }
  return refresh()
}

function interstitialUrl(target) {
  return chrome.runtime.getURL(`interstitial.html?url=${encodeURIComponent(target)}`)
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 })
  refresh()
})

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 })
  refresh()
})

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === POLL_ALARM) refresh()
})

chrome.webNavigation.onBeforeNavigate.addListener(async details => {
  if (details.frameId !== 0) return
  const target = details.url
  if (!target.startsWith('http://') && !target.startsWith('https://')) return

  const { view, down } = await currentCache()

  const verdict = decide({
    url: target,
    phase: down ? null : view?.phase,
    graces: down ? null : view?.graces,
    sites: view?.sites ?? null,
    now: Date.now(),
  })

  if (verdict.action === 'allow') return

  // Remember where the tab was so "Back to work" has somewhere to return to.
  let priorUrl = null
  try {
    const tab = await chrome.tabs.get(details.tabId)
    if (tab.url && !tab.url.startsWith(chrome.runtime.getURL(''))) priorUrl = tab.url
  } catch {}
  try {
    await chrome.storage.session.set({ [`priorUrl:${details.tabId}`]: priorUrl })
  } catch {}

  try {
    await chrome.tabs.update(details.tabId, { url: interstitialUrl(target) })
  } catch {}
})

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove(`priorUrl:${tabId}`).catch(() => {})
})

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === 'cachedState') {
    currentCache().then(c => respond({ view: c.view, down: c.down }))
    return true
  }

  if (msg?.type === 'refresh') {
    refresh().then(c => respond({ view: c.view, down: c.down }))
    return true
  }

  if (msg?.type === 'goBack') {
    const tabId = msg.tabId ?? sender.tab?.id
    if (tabId === undefined) { respond({ ok: false }); return true }
    chrome.storage.session.get(`priorUrl:${tabId}`).then(stored => {
      const prior = stored[`priorUrl:${tabId}`]
      if (prior) chrome.tabs.update(tabId, { url: prior }).catch(() => {})
      else chrome.tabs.remove(tabId).catch(() => {})
      respond({ ok: true })
    }).catch(() => respond({ ok: false }))
    return true
  }

  if (msg?.type === 'openUrls') {
    for (const url of msg.urls ?? []) chrome.tabs.create({ url, active: false }).catch(() => {})
    respond({ ok: true })
    return true
  }

  return false
})
```

- [ ] **Step 2: Load the extension in Chrome**

Open `chrome://extensions`, enable Developer mode, click "Load unpacked", select `~/focus-nudge/extension`.

Expected: the extension loads with no errors. `interstitial.html` does not exist yet, so interception will land on an error page — that is expected until Task 13.

- [ ] **Step 3: Confirm interception fires**

With the daemon running (`focus status` works), run `focus start`, then visit `https://reddit.com` in a new tab.

Expected: the tab navigates to a `chrome-extension://…/interstitial.html?url=…` URL. Check `chrome://extensions` → focus-nudge → "service worker" for the console; there should be no thrown errors.

- [ ] **Step 4: Confirm a sanctioned window allows**

Run `focus off 1h`, then visit `https://reddit.com`.

Expected: Reddit loads normally, with no redirect.

- [ ] **Step 5: Confirm failing closed**

Run `systemctl --user stop focus-nudge` (or `kill` the daemon), then visit `https://reddit.com`.

Expected: still redirected to the interstitial URL — an unreachable daemon must never hand over Reddit. Restart with `systemctl --user start focus-nudge`.

- [ ] **Step 6: Commit**

```bash
git add extension/sw.js
git commit -m "feat: add service worker with navigation interception"
```

---

### Task 13: The pause screen

**Files:**
- Create: `extension/interstitial.html`
- Create: `extension/interstitial.js`

**Interfaces:**
- Consumes: `pickQuote`, `BUNDLED_QUOTES` (Task 11); `getState`, `getQuotes`, `grace`, `queueAdd`, `isDown` (Task 11); `formatDuration`, `clockLine`, `renderTasks`, `PHASE_LABEL` (Task 11); the `goBack` message (Task 12).
- Produces: the user-facing pause screen. Behaviour required by the spec:
  - the quote is chosen once and does not reshuffle while the screen is open;
  - the clock and task list update every second;
  - `continue anyway` is disabled for `countdownSeconds`, then enabled — never permanently blocked;
  - if the phase becomes `LONG_BREAK` or `SNOOZED` while open, the screen releases itself to the target URL.

- [ ] **Step 1: Write `extension/interstitial.html`**

```html
<meta charset="utf-8">
<title>focus</title>
<link rel="stylesheet" href="style.css">
<div class="wrap">
  <p class="quote" id="quote"></p>
  <p class="quote-author" id="author"></p>

  <hr>

  <div>
    <span class="phase-chip" id="phase"></span>
    <span class="clock" id="clock"></span>
  </div>

  <div class="tasks" id="tasks"></div>

  <p class="empty" id="target"></p>

  <hr>

  <div class="actions">
    <button class="primary" id="back">Back to work</button>
    <button id="save">Save for later</button>
  </div>

  <p class="center" style="margin-top:1.5rem">
    <button class="ghost" id="continue" disabled></button>
  </p>

  <p class="down" id="down" hidden>
    The daemon is not running, so this is a plain reminder.
    Start it with <code>systemctl --user start focus-nudge</code>.
  </p>
</div>
<script type="module" src="interstitial.js"></script>
```

- [ ] **Step 2: Write `extension/interstitial.js`**

```js
import { BUNDLED_QUOTES, pickQuote } from './quotes.js'
import { getState, getQuotes, grace, queueAdd, isDown } from './api.js'
import { clockLine, renderTasks, PHASE_LABEL } from './ui.js'

const params = new URLSearchParams(location.search)
const targetUrl = params.get('url') ?? ''
const targetHost = safeHost(targetUrl)

const el = {
  quote: document.getElementById('quote'),
  author: document.getElementById('author'),
  phase: document.getElementById('phase'),
  clock: document.getElementById('clock'),
  tasks: document.getElementById('tasks'),
  target: document.getElementById('target'),
  back: document.getElementById('back'),
  save: document.getElementById('save'),
  continue: document.getElementById('continue'),
  down: document.getElementById('down'),
}

let released = false
let matchedSite = targetHost

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

el.target.textContent = targetHost ? `you are heading to ${targetHost}` : ''
document.title = targetHost ? `focus — ${targetHost}` : 'focus'

// The quote is drawn once, so it cannot reshuffle under the reader.
;(async () => {
  const res = await getQuotes()
  const user = isDown(res) ? [] : res.quotes
  const q = pickQuote(BUNDLED_QUOTES, user)
  el.quote.textContent = `“${q.text}”`
  el.author.textContent = q.author ? `— ${q.author}` : ''
})()

function release() {
  if (released || !targetUrl) return
  released = true
  location.replace(targetUrl)
}

function render(view, down) {
  el.down.hidden = !down

  if (down || !view) {
    el.phase.textContent = 'no daemon'
    el.clock.textContent = 'take the pause anyway'
    renderTasks(el.tasks, [])
    return
  }

  // A sanctioned window opened while this screen was up: let the visit through
  // rather than making the user click again.
  if (view.nudgingPhase === false) return release()

  // Track the site the daemon is actually watching, so the grace call matches.
  const site = (view.sites ?? []).find(s => targetHost === s || targetHost.endsWith('.' + s))
  if (site) matchedSite = site

  el.phase.textContent = PHASE_LABEL[view.phase] ?? view.phase
  el.clock.textContent = clockLine(view)
  el.clock.classList.toggle('overrun', Boolean(view.overrun))
  renderTasks(el.tasks, view.tasks)
}

async function poll() {
  const v = await getState()
  render(isDown(v) ? null : v, isDown(v))
}

poll()
setInterval(poll, 1000)

// The countdown gates the escape hatch; it never removes it.
let secondsLeft = 10
function tickCountdown() {
  if (secondsLeft > 0) {
    el.continue.textContent = `continue anyway  (${secondsLeft})`
    el.continue.disabled = true
    secondsLeft--
    setTimeout(tickCountdown, 1000)
  } else {
    el.continue.textContent = 'continue anyway'
    el.continue.disabled = false
  }
}
getState().then(v => {
  if (!isDown(v) && Number.isFinite(v.countdownSeconds)) secondsLeft = v.countdownSeconds
  tickCountdown()
})

function goBack() {
  chrome.runtime.sendMessage({ type: 'goBack' }, () => {})
}

el.back.addEventListener('click', goBack)

el.save.addEventListener('click', async () => {
  el.save.disabled = true
  await queueAdd(targetUrl, targetHost)
  el.save.textContent = 'saved'
  goBack()
})

el.continue.addEventListener('click', async () => {
  el.continue.disabled = true
  if (matchedSite) await grace(matchedSite)
  release()
})

// Escape is the same as choosing to go back.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') goBack()
})
```

- [ ] **Step 3: Reload the extension and check the screen**

Reload focus-nudge at `chrome://extensions`. Run `focus start`, then `focus task "fix the auth redirect"` and `focus task "write the regression test"`. Visit `https://reddit.com`.

Expected: the pause screen shows a quote, `work block` chip, a live countdown near `25:00`, both micro-tasks with checkboxes, `you are heading to reddit.com`, and `continue anyway  (10)` counting down and then becoming clickable.

- [ ] **Step 4: Check each button**

- Click `Back to work` from a new tab → the tab closes.
- Open `https://example.com`, then navigate to `https://reddit.com`, then click `Back to work` → the tab returns to example.com.
- Click `Save for later`, then run `focus queue` → the Reddit URL is listed.
- Wait out the countdown, click `continue anyway` → Reddit loads. Run `focus status` and confirm a grace exists; navigate to Reddit again within 5 minutes → no pause screen. Navigate to YouTube → pause screen appears, proving grace is per-site.

- [ ] **Step 5: Check the live release**

Visit `https://reddit.com` to raise the pause screen, leave it open, and in a terminal run `focus off 1h`.

Expected: within a second the screen releases itself and Reddit loads.

- [ ] **Step 6: Check the daemon-down path**

Stop the daemon, then visit `https://reddit.com`.

Expected: the pause screen still appears, shows a bundled quote, shows the `no daemon` chip and the red hint line, and `continue anyway` still unlocks after the countdown.

- [ ] **Step 7: Commit**

```bash
git add extension/interstitial.html extension/interstitial.js
git commit -m "feat: add the pause screen"
```

---

### Task 14: New tab dashboard

**Files:**
- Create: `extension/newtab.html`
- Create: `extension/newtab.js`

**Interfaces:**
- Consumes: `getState`, `timer`, `task`, `snooze`, `queueDrain`, `isDown` (Task 11); `clockLine`, `renderTasks`, `PHASE_LABEL` (Task 11); the `openUrls` message (Task 12).
- Produces: the dashboard shown on every new tab — phase, countdown, block position in the cycle, micro-task list with inline add/toggle/remove, queue depth with a drain button, and phase controls.

- [ ] **Step 1: Write `extension/newtab.html`**

```html
<meta charset="utf-8">
<title>focus</title>
<link rel="stylesheet" href="style.css">
<div class="wrap">
  <div>
    <span class="phase-chip" id="phase"></span>
    <span class="clock" id="clock"></span>
  </div>
  <p class="empty" id="cycle"></p>

  <hr>

  <div class="tasks" id="tasks"></div>
  <input type="text" id="new-task" placeholder="add a micro-task, then press Enter" autocomplete="off">

  <div class="actions">
    <button class="primary small" id="start">Start</button>
    <button class="small" id="skip">Skip</button>
    <button class="small" id="pause">Pause</button>
    <button class="small" id="stop">Stop</button>
    <button class="small" id="break">Long break</button>
  </div>

  <p id="queue-line" class="empty" hidden></p>
  <p><button class="small" id="drain" hidden>Open saved links</button></p>

  <p class="down" id="down" hidden>
    The daemon is not running. Start it with
    <code>systemctl --user start focus-nudge</code>.
  </p>
</div>
<script type="module" src="newtab.js"></script>
```

- [ ] **Step 2: Write `extension/newtab.js`**

```js
import { getState, timer, task, queueDrain, isDown } from './api.js'
import { clockLine, renderTasks, PHASE_LABEL } from './ui.js'

const el = id => document.getElementById(id)
const input = el('new-task')

let latest = null

function render(view, down) {
  el('down').hidden = !down
  if (down || !view) {
    el('phase').textContent = 'no daemon'
    el('clock').textContent = ''
    el('cycle').textContent = ''
    renderTasks(el('tasks'), [])
    el('queue-line').hidden = true
    el('drain').hidden = true
    return
  }
  latest = view

  el('phase').textContent = PHASE_LABEL[view.phase] ?? view.phase
  el('clock').textContent = clockLine(view)
  el('clock').classList.toggle('overrun', Boolean(view.overrun))

  el('cycle').textContent =
    view.phase === 'WORK' || view.phase === 'SHORT_BREAK'
      ? `block ${view.blocksCompleted + (view.phase === 'WORK' ? 1 : 0)} of ${view.blocksPerCycle} before a long break`
      : ''

  renderTasks(el('tasks'), view.tasks, {
    onToggle: async id => render(await refreshWith(task('toggle', { id })), false),
    onRemove: async id => render(await refreshWith(task('remove', { id })), false),
  })

  el('pause').textContent = view.paused ? 'Resume' : 'Pause'

  const depth = view.queueDepth
  el('queue-line').hidden = depth === 0
  el('drain').hidden = depth === 0
  if (depth > 0) {
    el('queue-line').textContent =
      `${depth} link${depth === 1 ? '' : 's'} saved for your next long break`
  }
}

async function refreshWith(promise) {
  const v = await promise
  return isDown(v) ? null : v
}

async function poll() {
  const v = await getState()
  render(isDown(v) ? null : v, isDown(v))
}

input.addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  render(await refreshWith(task('add', { text })), false)
})

el('start').addEventListener('click', async () => {
  render(await refreshWith(timer('start')), false)
})
el('skip').addEventListener('click', async () => {
  render(await refreshWith(timer('skip')), false)
})
el('pause').addEventListener('click', async () => {
  render(await refreshWith(timer(latest?.paused ? 'start' : 'pause')), false)
})
el('stop').addEventListener('click', async () => {
  render(await refreshWith(timer('stop')), false)
})
el('break').addEventListener('click', async () => {
  const urls = (latest?.queue ?? []).map(q => q.url)
  render(await refreshWith(timer('breakLong')), false)
  if (urls.length) chrome.runtime.sendMessage({ type: 'openUrls', urls }, () => {})
})
el('drain').addEventListener('click', async () => {
  const urls = (latest?.queue ?? []).map(q => q.url)
  render(await refreshWith(queueDrain()), false)
  if (urls.length) chrome.runtime.sendMessage({ type: 'openUrls', urls }, () => {})
})

poll()
setInterval(poll, 1000)
input.focus()
```

- [ ] **Step 3: Reload and check the dashboard**

Reload the extension and open a new tab.

Expected: the dashboard renders with the current phase and countdown. Type `ship the plan` and press Enter → it appears in the list and `focus status` in a terminal shows it too. Click its checkbox → it strikes through. Click `Start` → the phase becomes `work block` with a running clock and `block 1 of 4 before a long break`. Click `Pause` → the button reads `Resume` and the clock holds.

- [ ] **Step 4: Check the queue drain**

Save a Reddit link via the pause screen, open a new tab, and confirm `1 link saved for your next long break` with an `Open saved links` button. Click `Long break`.

Expected: the saved link opens in a background tab, the queue line disappears, and the task list is cleared (per the spec's archive-on-long-break rule).

- [ ] **Step 5: Commit**

```bash
git add extension/newtab.html extension/newtab.js
git commit -m "feat: add new tab dashboard"
```

---

### Task 15: Toolbar popup

**Files:**
- Create: `extension/popup.html`
- Create: `extension/popup.js`

**Interfaces:**
- Consumes: `getState`, `timer`, `snooze`, `task`, `site`, `queueDrain`, `isDown` (Task 11); `clockLine`, `renderTasks`, `PHASE_LABEL` (Task 11).
- Produces: the compact popup — same phase and task view, plus the snooze buttons and the site list editor, which live only here and in the CLI.

- [ ] **Step 1: Write `extension/popup.html`**

```html
<meta charset="utf-8">
<title>focus-nudge</title>
<link rel="stylesheet" href="style.css">
<style>
  body { width: 20rem; }
  .wrap { padding: 1rem; max-width: none; }
  h2 { font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase;
       color: var(--muted); margin: 1.25rem 0 0.5rem; font-weight: 500; }
  .site-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; padding: 0.15rem 0; }
  .site-row button { margin-left: auto; }
</style>
<div class="wrap">
  <div>
    <span class="phase-chip" id="phase"></span>
    <span class="clock" id="clock"></span>
  </div>

  <div class="actions">
    <button class="primary small" id="start">Start</button>
    <button class="small" id="skip">Skip</button>
    <button class="small" id="pause">Pause</button>
    <button class="small" id="break">Long break</button>
  </div>

  <h2>Micro-tasks</h2>
  <div class="tasks" id="tasks"></div>
  <input type="text" id="new-task" placeholder="add a micro-task" autocomplete="off">

  <h2>Saved for later</h2>
  <p class="empty" id="queue-line"></p>
  <button class="small" id="drain" hidden>Open them now</button>

  <h2>Turn nudging off for</h2>
  <div class="actions">
    <button class="small" data-hours="1">1 hour</button>
    <button class="small" data-hours="2">2 hours</button>
    <button class="small" data-hours="4">4 hours</button>
  </div>

  <h2>Watched sites</h2>
  <div id="sites"></div>
  <input type="text" id="new-site" placeholder="add a domain" autocomplete="off">

  <p class="down" id="down" hidden>
    The daemon is not running. Nudging still applies.
    Start it with <code>systemctl --user start focus-nudge</code>.
  </p>
</div>
<script type="module" src="popup.js"></script>
```

- [ ] **Step 2: Write `extension/popup.js`**

```js
import { getState, timer, snooze, task, site, queueDrain, isDown } from './api.js'
import { clockLine, renderTasks, PHASE_LABEL } from './ui.js'

const el = id => document.getElementById(id)
let latest = null

function renderSites(sites) {
  const box = el('sites')
  box.replaceChildren()
  for (const s of sites ?? []) {
    const row = document.createElement('div')
    row.className = 'site-row'
    const name = document.createElement('span')
    name.textContent = s
    const remove = document.createElement('button')
    remove.className = 'small'
    remove.type = 'button'
    remove.textContent = 'remove'
    remove.addEventListener('click', async () => render(await act(site('remove', s))))
    row.append(name, remove)
    box.append(row)
  }
}

function render(view) {
  const down = view === null
  el('down').hidden = !down

  if (down) {
    el('phase').textContent = 'no daemon'
    el('clock').textContent = ''
    renderTasks(el('tasks'), [])
    el('queue-line').textContent = 'unknown'
    el('drain').hidden = true
    renderSites([])
    return
  }
  latest = view

  el('phase').textContent = PHASE_LABEL[view.phase] ?? view.phase
  el('clock').textContent = clockLine(view)
  el('clock').classList.toggle('overrun', Boolean(view.overrun))
  el('pause').textContent = view.paused ? 'Resume' : 'Pause'

  renderTasks(el('tasks'), view.tasks, {
    onToggle: async id => render(await act(task('toggle', { id }))),
    onRemove: async id => render(await act(task('remove', { id }))),
  })

  el('queue-line').textContent = view.queueDepth
    ? `${view.queueDepth} link${view.queueDepth === 1 ? '' : 's'} waiting`
    : 'nothing saved'
  el('drain').hidden = view.queueDepth === 0

  renderSites(view.sites)
}

async function act(promise) {
  const v = await promise
  return isDown(v) ? null : v
}

el('start').addEventListener('click', async () => render(await act(timer('start'))))
el('skip').addEventListener('click', async () => render(await act(timer('skip'))))
el('pause').addEventListener('click', async () =>
  render(await act(timer(latest?.paused ? 'start' : 'pause'))))
el('break').addEventListener('click', async () => {
  const urls = (latest?.queue ?? []).map(q => q.url)
  render(await act(timer('breakLong')))
  if (urls.length) chrome.runtime.sendMessage({ type: 'openUrls', urls }, () => {})
})
el('drain').addEventListener('click', async () => {
  const urls = (latest?.queue ?? []).map(q => q.url)
  render(await act(queueDrain()))
  if (urls.length) chrome.runtime.sendMessage({ type: 'openUrls', urls }, () => {})
})

for (const button of document.querySelectorAll('[data-hours]')) {
  button.addEventListener('click', async () =>
    render(await act(snooze(Number(button.dataset.hours)))))
}

el('new-task').addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return
  const text = e.target.value.trim()
  if (!text) return
  e.target.value = ''
  render(await act(task('add', { text })))
})

el('new-site').addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return
  const domain = e.target.value.trim()
  if (!domain) return
  e.target.value = ''
  render(await act(site('add', domain)))
})

async function poll() {
  const v = await getState()
  render(isDown(v) ? null : v)
}

poll()
setInterval(poll, 1000)
```

- [ ] **Step 3: Reload and check the popup**

Reload the extension and click its toolbar icon.

Expected: phase, clock, controls, micro-tasks, saved-links line, three snooze buttons, and both watched sites. Add a task → it appears in the popup, the dashboard, and `focus status`. Add `news.ycombinator.com` → it appears in the list and in `cat ~/.config/focus-nudge/config.json`. Remove it → it disappears from both.

- [ ] **Step 4: Check snooze from the popup**

Click `2 hours`.

Expected: the chip reads `snoozed`, the clock counts down from `120:00`, `focus status` agrees, and Reddit opens without a pause screen.

- [ ] **Step 5: Commit**

```bash
git add extension/popup.html extension/popup.js
git commit -m "feat: add toolbar popup with snooze and site editing"
```

---

### Task 16: End-to-end verification and documentation

**Files:**
- Modify: `README.md`
- Create: `docs/VERIFICATION.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a recorded pass over the whole system, and the record kept in the repo.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS, 94 tests across five files, zero failures
(config 10, core 46, policy 16, server smoke 17, quotes 5)

- [ ] **Step 2: Walk the whole loop and record the result**

Create `docs/VERIFICATION.md` and fill in the result of each line as you go. Every line must read PASS before this task is complete.

```markdown
# Verification — focus-nudge

Run after any change to the daemon, the policy, or the extension.

    npm test        # unit + smoke tests
    systemctl --user restart focus-nudge

Then reload the extension at chrome://extensions and walk this list.

| # | Check | Expected | Result |
|---|---|---|---|
| 1 | `focus status` with the daemon up | `idle` | |
| 2 | `focus start`, then visit reddit.com | pause screen, `work block`, live clock | |
| 3 | Add two tasks, revisit reddit.com | both tasks listed on the pause screen | |
| 4 | Watch the `continue anyway` button | disabled for 10s, then clickable | |
| 5 | Click `continue anyway` | reddit loads | |
| 6 | Revisit reddit.com within 5 min | no pause screen (grace) | |
| 7 | Visit youtube.com in the same window | pause screen appears (grace is per-site) | |
| 8 | Wait out the 5 min, revisit reddit.com | pause screen returns | |
| 9 | `Save for later`, then `focus queue` | the url is listed | |
| 10 | `focus break` | saved link opens, task list cleared, sites open | |
| 11 | During the long break, visit reddit.com | loads, no pause screen | |
| 12 | `focus off 2h`, visit reddit.com | loads, no pause screen | |
| 13 | Raise the pause screen, then `focus off 1h` | the screen releases itself within a second | |
| 14 | `focus stop`, visit reddit.com while idle | pause screen appears (idle still nudges) | |
| 15 | Stop the daemon, visit reddit.com | pause screen appears with the no-daemon hint | |
| 16 | Visit example.com with the daemon stopped | loads normally | |
| 17 | Restart the daemon, `focus status` | tasks and queue survived the restart | |
| 18 | Let a work block run past its end | notification fires once, phase stays `work`, clock shows `ran over by` | |
| 19 | Complete four blocks with `focus skip` | the fourth advance lands in `long break` | |
| 20 | New tab | dashboard with phase, clock, tasks, cycle position | |
| 21 | Popup: add and remove a site | reflected in `~/.config/focus-nudge/config.json` | |
| 22 | Visit old.reddit.com and m.youtube.com | both nudged (subdomain matching) | |
| 23 | `focus stats` | non-zero counts after the walk above | |
| 24 | Suspend the machine across a phase end, then wake | one notification, phase held, no drift | |
```

- [ ] **Step 3: Append the verification pointer to `README.md`**

```markdown
## Verifying a change

See `docs/VERIFICATION.md` for the manual walk-through. Run `npm test` first —
the state machine and the nudge policy are both covered by unit tests, so most
regressions surface there.

## How it fits together

- `daemon/core.js` — the pure state machine. All phase, grace, task, and queue
  rules live here, with no I/O and an injected clock.
- `daemon/server.js` — HTTP on 127.0.0.1:7373, atomic persistence,
  `notify-send`, and the append-only log.
- `extension/policy.js` — the pure allow-or-nudge decision.
- `extension/sw.js` — polls the daemon and intercepts navigation.
- `cli/focus` and the popup are both thin clients of the daemon, so they cannot
  disagree about the current state.

If the daemon is unreachable, the extension keeps nudging with its bundled
quotes. Failing closed means a crashed daemon can never quietly hand over
Reddit.
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/VERIFICATION.md
git commit -m "docs: add end-to-end verification checklist"
```

---

## Self-Review

**1. Spec coverage.** Every spec section maps to a task:

| Spec requirement | Task |
|---|---|
| Five phases, one nudge rule each | 2, 3, 7 |
| Short breaks nudge (zen time) | 7 (test asserts it explicitly) |
| Long break and snooze are the only open windows | 7 |
| Default sites, registrable-domain matching, no path matching | 7 |
| Phases never auto-advance; overrun holds with negative remaining | 3 (`settle`), 6 (`view.overrun`) |
| Wall-clock timers survive suspend | 3 (`settle` notifies once on wake), 16 (check 24) |
| Long break after 4 blocks, or on demand | 2, 5 |
| Snooze with a duration, reverts to idle | 3 |
| 5-minute per-site grace | 4, 7 |
| Pause screen: quote, timer, tasks, three buttons, 10s countdown | 13 |
| Pause screen is live and releases on a sanctioned phase | 13 |
| `Back to work` returns or closes the tab | 12 (`goBack`), 13 |
| Save for later; drains at long break or snooze with notification | 5, 13, 14 |
| Micro-tasks: flat list, archived and cleared at long break | 5, 14 |
| New-tab dashboard | 14 |
| Popup with snooze and site list | 15 |
| Desktop notifications at boundaries and on drain | 2, 3, 5, 8 |
| Daemon is single source of truth; popup and CLI are thin clients | 8, 9, 15 |
| All nine HTTP endpoints | 8 |
| Loopback only, no auth | 8 |
| Fail closed when the daemon is unreachable | 7, 11 (`api.js`), 12, 13 |
| Port in use exits with a clear message | 8 |
| Corrupt state backed up and replaced | 8 |
| Missing quotes file falls back to bundled | 8, 11, 13 |
| Missing `notify-send` logged once and ignored | 8 (`spawnDetached`) |
| Four config files on disk | 1, 8 |
| `focus stats` from the log | 8, 9 |
| systemd user unit | 10 |
| Unpacked install | 10, 12 |
| TDD for `core.js` and `policy.js` | 2–7 |

**2. Placeholder scan.** No `TBD`, `TODO`, or "add error handling" steps. Task 2 does contain a deliberately named placeholder function, `openLongBreak`, which Task 5 replaces — Task 2's tests pass with the stub, and Task 5's tests fail until it is replaced, so the sequence is enforced by the tests rather than by a comment.

**3. Type consistency.** Checked across tasks:

- `reduce`/`settle` both return `{state, effects}` everywhere.
- Effect types are exactly `notify`, `log`, `openUrls`, `setSites` — emitted in Tasks 2–5, all four handled in `runEffects` in Task 8.
- `view()` keys defined in Task 6 are the same keys read in Tasks 9, 13, 14, 15: `phase`, `remainingMs`, `overrun`, `paused`, `blocksCompleted`, `blocksPerCycle`, `tasks`, `openTaskCount`, `queue`, `queueDepth`, `sites`, `graces`, `countdownSeconds`, `nudgingPhase`.
- `ADVANCE` is the action name; `skip` and `next` are the CLI/HTTP verbs that map to it in `TIMER_ACTIONS` (Task 8).
- `matchSite`/`decide` signatures in Task 7 match the call in Task 12.
- `api.js` export names in Task 11 match every import in Tasks 13–15.
- `normaliseSite` (core, Task 5) and `matchSite` (policy, Task 7) both lowercase and both strip a leading `www.`, so a site added through the popup matches on the extension side.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-02-focus-nudge.md`.
