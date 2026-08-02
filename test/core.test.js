import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PHASE, initialState, reduce, settle, view } from '../daemon/core.js'
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

test('SITE_ADD canonicalises entries that would otherwise never match', () => {
  // sites: [] so the leading-dot case (which canonicalises to the same
  // domain DEFAULTS already ships, "reddit.com") isn't silently deduped away
  // before the assertion below ever gets to look at it.
  const cfg = { ...CFG, sites: [] }
  const added = site => reduce(initialState(), { type: 'SITE_ADD', site }, T0, cfg)
    .effects.find(e => e.type === 'setSites').sites.at(-1)

  assert.equal(added('.reddit.com'), 'reddit.com', 'a leading dot is stripped, not stored')
  assert.equal(added('news.ycombinator.com.'), 'news.ycombinator.com', 'a trailing dot too')
  assert.equal(added('news.ycombinator.com:8080'), 'news.ycombinator.com', 'and a port')
  assert.equal(added('user@news.ycombinator.com'), 'news.ycombinator.com', 'and userinfo')

  // A bare TLD must never be storable — in the matcher it would otherwise
  // match every domain in that TLD.
  const bare = reduce(initialState(), { type: 'SITE_ADD', site: 'com' }, T0, cfg)
  assert.deepEqual(bare.effects, [], 'rejected outright, no setSites effect')
})

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
