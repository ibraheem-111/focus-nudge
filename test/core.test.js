import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PHASE, initialState, reduce, settle, view, nudgingOn } from '../daemon/core.js'
import { DEFAULTS } from '../daemon/config.js'

const CFG = DEFAULTS
const T0 = 1_000_000_000_000
const MIN = 60_000

// The shipped default, spelled out so the assertions below stay exact-contents
// checks rather than trivially agreeing with whatever DEFAULTS happens to say.
const DEFAULT_SITES = ['reddit.com', 'youtube.com', 'x.com', 'instagram.com']

test('the config default this file asserts against is the one that ships', () => {
  assert.deepEqual(DEFAULTS.sites, DEFAULT_SITES)
})

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

// block_completed is the sole input to every number `focus stats` prints — today,
// last 7 days, all time, and the daily bar chart all come from counting these log
// lines. Nothing asserted it was ever emitted, so the whole stats feature rested
// on one unpinned effects.push.
test('ADVANCE out of work logs block_completed, and nothing else does', () => {
  const working = reduce(initialState(), { type: 'START' }, T0, CFG).state
  const { effects } = reduce(working, { type: 'ADVANCE' }, T0 + 25 * MIN, CFG)
  const logged = effects.filter(e => e.type === 'log' && e.event === 'block_completed')
  assert.equal(logged.length, 1, 'exactly one block_completed per finished work block')

  // Leaving any other phase is not a completed block and must not inflate the count.
  const notBlocks = [
    { ...initialState(), phase: PHASE.SHORT_BREAK, endsAt: T0 + 5 * MIN },
    { ...initialState(), phase: PHASE.LONG_BREAK, endsAt: T0 + 20 * MIN },
    initialState(),
  ]
  for (const s of notBlocks) {
    const out = reduce(s, { type: 'ADVANCE' }, T0, CFG)
    assert.equal(
      out.effects.some(e => e.event === 'block_completed'), false,
      `leaving ${s.phase} must not count as a completed block`,
    )
  }

  // Nor may any other action mint one.
  for (const action of [
    { type: 'START' }, { type: 'PAUSE' }, { type: 'STOP' }, { type: 'BREAK_LONG' },
    { type: 'SNOOZE', hours: 1 }, { type: 'GRACE', site: 'reddit.com' },
  ]) {
    const out = reduce(working, action, T0 + MIN, CFG)
    assert.equal(
      out.effects.some(e => e.event === 'block_completed'), false,
      `${action.type} must not log block_completed`,
    )
  }
})

test('the fourth block still logs block_completed on the way into a long break', () => {
  // The long-break branch banks and resets in one step; the log line must survive
  // that, or every fourth block would go uncounted.
  const s = { ...initialState(), phase: PHASE.WORK, endsAt: T0 + MIN, blocksCompleted: 3 }
  const { state, effects } = reduce(s, { type: 'ADVANCE' }, T0, CFG)
  assert.equal(state.phase, PHASE.LONG_BREAK)
  assert.equal(effects.filter(e => e.event === 'block_completed').length, 1)
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

test('PAUSE pauses a short break too', () => {
  const s = { ...initialState(), phase: PHASE.SHORT_BREAK, endsAt: T0 + 5 * MIN }
  const { state } = reduce(s, { type: 'PAUSE' }, T0 + MIN, CFG)
  assert.equal(state.paused, true)
  assert.equal(state.pausedRemainingMs, 4 * MIN)
})

test('PAUSE during a long break is a no-op, so the break can still expire', () => {
  const onBreak = reduce(initialState(), { type: 'BREAK_LONG' }, T0, CFG).state
  const { state, effects } = reduce(onBreak, { type: 'PAUSE' }, T0 + MIN, CFG)
  assert.deepEqual(state, onBreak, 'the long break is untouched')
  assert.deepEqual(effects, [])
  assert.equal(state.endsAt, T0 + 20 * MIN, 'endsAt is NOT cleared')

  const later = settle(state, T0 + 20 * MIN, CFG)
  assert.equal(later.state.expiredNotified, true, 'the break still reaches its expiry notice')
  assert.ok(later.effects.some(e => e.type === 'notify'))
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

test('settle frees a long break that was already trapped with no endsAt', () => {
  const trapped = { ...initialState(), phase: PHASE.LONG_BREAK, endsAt: null, paused: true, pausedRemainingMs: 60_000 }
  const { state } = settle(trapped, T0, CFG)
  assert.equal(state.phase, PHASE.IDLE)
  assert.equal(view(state, T0, CFG).nudgingPhase, true)
})

test('a legitimately paused WORK block is never mistaken for the trap', () => {
  // WORK with endsAt null and paused true is the normal, correct pause shape.
  let s = reduce(initialState(), { type: 'START' }, T0, CFG).state
  s = reduce(s, { type: 'PAUSE' }, T0 + 10 * MIN, CFG).state
  assert.equal(s.endsAt, null)
  assert.equal(s.paused, true)
  const { state, effects } = settle(s, T0 + 99 * MIN, CFG)
  assert.deepEqual(state, s, 'a paused work block is untouched no matter how long it sits')
  assert.deepEqual(effects, [])
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

// Sound is only for a boundary the user is not watching: a phase expiring on its
// own, on a timer, while they are very likely looking away. It is data, same as
// title/body — core.js stays pure, it just picks which name from config.
test('a WORK expiry carries sounds.workEnd', () => {
  const s = reduce(initialState(), { type: 'START' }, T0, CFG).state
  const { effects } = settle(s, T0 + 25 * MIN, CFG)
  const notify = effects.find(e => e.type === 'notify')
  assert.equal(notify.sound, CFG.sounds.workEnd)
})

test('a SHORT_BREAK expiry carries sounds.breakEnd', () => {
  const s = { ...initialState(), phase: PHASE.SHORT_BREAK, endsAt: T0 + 5 * MIN }
  const { effects } = settle(s, T0 + 5 * MIN, CFG)
  const notify = effects.find(e => e.type === 'notify')
  assert.equal(notify.sound, CFG.sounds.breakEnd)
})

test('a LONG_BREAK expiry carries sounds.breakEnd', () => {
  const s = { ...initialState(), phase: PHASE.LONG_BREAK, endsAt: T0 + 20 * MIN }
  const { effects } = settle(s, T0 + 20 * MIN, CFG)
  const notify = effects.find(e => e.type === 'notify')
  assert.equal(notify.sound, CFG.sounds.breakEnd)
})

test('sounds.enabled false emits the expiry notify with no sound field at all', () => {
  const cfg = { ...CFG, sounds: { ...CFG.sounds, enabled: false } }
  const s = reduce(initialState(), { type: 'START' }, T0, cfg).state
  const { effects } = settle(s, T0 + 25 * MIN, cfg)
  const notify = effects.find(e => e.type === 'notify')
  assert.equal('sound' in notify, false, 'the key must be absent, not merely undefined-valued')
})

// The one most likely to be broken by a later change: a click at the keyboard
// must never beep, in either direction of a bad edit.
test('user-initiated transitions (START, ADVANCE, SNOOZE, BREAK_LONG) never carry a sound', () => {
  const start = reduce(initialState(), { type: 'START' }, T0, CFG)
  for (const e of start.effects) {
    if (e.type === 'notify') assert.equal('sound' in e, false, 'START must stay silent')
  }

  const advance = reduce(start.state, { type: 'ADVANCE' }, T0 + 25 * MIN, CFG)
  for (const e of advance.effects) {
    if (e.type === 'notify') assert.equal('sound' in e, false, 'ADVANCE must stay silent')
  }

  const snooze = reduce(initialState(), { type: 'SNOOZE', hours: 1 }, T0, CFG)
  for (const e of snooze.effects) {
    if (e.type === 'notify') assert.equal('sound' in e, false, 'SNOOZE must stay silent')
  }

  const breakLong = reduce(initialState(), { type: 'BREAK_LONG' }, T0, CFG)
  for (const e of breakLong.effects) {
    if (e.type === 'notify') assert.equal('sound' in e, false, 'BREAK_LONG must stay silent')
  }
})

test('settle stays idempotent for the expiry sound too: it fires exactly once', () => {
  const s = reduce(initialState(), { type: 'START' }, T0, CFG).state
  const first = settle(s, T0 + 25 * MIN, CFG)
  assert.equal(first.effects.find(e => e.type === 'notify').sound, CFG.sounds.workEnd)

  const second = settle(first.state, T0 + 26 * MIN, CFG)
  assert.deepEqual(second.effects, [], 'no repeat notification, sound or not')
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

test('ids climb while tasks remain, and restart once the list empties', () => {
  // Deliberate change of intent. Ids used to climb forever, so after a long day
  // you were typing "task done 47". They only need to be unique among LIVE
  // tasks, so an empty list is a safe place to restart.
  let s = reduce(initialState(), { type: 'TASK_ADD', text: 'a' }, T0, CFG).state
  s = reduce(s, { type: 'TASK_ADD', text: 'b' }, T0, CFG).state
  s = reduce(s, { type: 'TASK_REMOVE', id: 1 }, T0, CFG).state
  s = reduce(s, { type: 'TASK_ADD', text: 'c' }, T0, CFG).state
  assert.deepEqual(s.tasks.map(t => t.id), [2, 3], 'no reuse while another task is live')

  s = reduce(s, { type: 'TASK_REMOVE', id: 2 }, T0, CFG).state
  s = reduce(s, { type: 'TASK_REMOVE', id: 3 }, T0, CFG).state
  assert.equal(s.nextTaskId, 1, 'emptying the list restarts the numbering')
  s = reduce(s, { type: 'TASK_ADD', text: 'fresh' }, T0, CFG).state
  assert.equal(s.tasks[0].id, 1)
})

test('TASK_CLEAR_DONE removes only the ticked-off tasks', () => {
  let s = reduce(initialState(), { type: 'TASK_ADD', text: 'keep me' }, T0, CFG).state
  s = reduce(s, { type: 'TASK_ADD', text: 'done one' }, T0, CFG).state
  s = reduce(s, { type: 'TASK_ADD', text: 'done two' }, T0, CFG).state
  s = reduce(s, { type: 'TASK_TOGGLE', id: 2 }, T0, CFG).state
  s = reduce(s, { type: 'TASK_TOGGLE', id: 3 }, T0, CFG).state

  const { state, effects } = reduce(s, { type: 'TASK_CLEAR_DONE' }, T0, CFG)
  assert.deepEqual(state.tasks.map(t => t.text), ['keep me'])
  assert.equal(state.nextTaskId, 4, 'ids do not restart while a task survives')
  assert.equal(effects.find(e => e.event === 'tasks_cleared_done').data.count, 2)
})

test('TASK_CLEAR_DONE is a no-op when nothing is done', () => {
  const s = reduce(initialState(), { type: 'TASK_ADD', text: 'open' }, T0, CFG).state
  const { state, effects } = reduce(s, { type: 'TASK_CLEAR_DONE' }, T0, CFG)
  assert.deepEqual(state, s, 'same state, not a rebuilt copy')
  assert.deepEqual(effects, [])
})

test('clearing every done task also restarts the numbering', () => {
  let s = reduce(initialState(), { type: 'TASK_ADD', text: 'a' }, T0, CFG).state
  s = reduce(s, { type: 'TASK_TOGGLE', id: 1 }, T0, CFG).state
  s = reduce(s, { type: 'TASK_CLEAR_DONE' }, T0, CFG).state
  assert.deepEqual(s.tasks, [])
  assert.equal(s.nextTaskId, 1)
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
  assert.equal(state.nextTaskId, 1, 'an emptied list restarts the numbering')
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

test('the automatic long break after four blocks also spares the tasks', () => {
  let s = reduce(initialState(), { type: 'TASK_ADD', text: 'carry me across the cycle' }, T0, CFG).state
  s = { ...s, phase: PHASE.WORK, endsAt: T0 + MIN, blocksCompleted: 3 }
  const { state } = reduce(s, { type: 'ADVANCE' }, T0, CFG)
  assert.equal(state.phase, PHASE.LONG_BREAK)
  assert.deepEqual(state.tasks.map(t => t.text), ['carry me across the cycle'])
})

test('snoozing also drains the queue', () => {
  let s = reduce(initialState(), { type: 'QUEUE_ADD', url: 'https://reddit.com/r/y', title: 'y' }, T0, CFG).state
  const { state, effects } = reduce(s, { type: 'SNOOZE', hours: 2 }, T0, CFG)
  assert.deepEqual(state.queue, [], 'draining is non-destructive — the links are opened, not discarded')
  assert.deepEqual(effects.find(e => e.type === 'openUrls').urls, ['https://reddit.com/r/y'])
})

test('an empty queue produces no openUrls effect', () => {
  const { effects } = reduce(initialState(), { type: 'BREAK_LONG' }, T0, CFG)
  assert.equal(effects.some(e => e.type === 'openUrls'), false)
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
    [...DEFAULT_SITES, 'news.ycombinator.com'], 'lowercased and appended')

  const dupe = reduce(initialState(), { type: 'SITE_ADD', site: 'reddit.com' }, T0, CFG)
  assert.deepEqual(dupe.effects.find(e => e.type === 'setSites').sites, DEFAULT_SITES)

  const removed = reduce(initialState(), { type: 'SITE_REMOVE', site: 'reddit.com' }, T0, CFG)
  assert.deepEqual(removed.effects.find(e => e.type === 'setSites').sites,
    ['youtube.com', 'x.com', 'instagram.com'])
})

test('SITE_ADD strips a scheme and path if one is pasted in', () => {
  const { effects } = reduce(initialState(), { type: 'SITE_ADD', site: 'https://news.ycombinator.com/best' }, T0, CFG)
  assert.deepEqual(effects.find(e => e.type === 'setSites').sites,
    [...DEFAULT_SITES, 'news.ycombinator.com'])
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

test('SITE_ADD collapses dot runs before stripping www., not after', () => {
  // The strips used to run www.-first, so ".www.reddit.com" only had its leading
  // dot removed and stored as "www.reddit.com" — which matchSite then fails to
  // match against a plain reddit.com visit. Same fail-open class as the
  // leading-dot bug above, one layer deeper.
  const cfg = { ...CFG, sites: [] }
  const added = site => reduce(initialState(), { type: 'SITE_ADD', site }, T0, cfg)
    .effects.find(e => e.type === 'setSites')?.sites.at(-1)

  assert.equal(added('.www.reddit.com'), 'reddit.com', 'dot then www. is still just reddit.com')
  assert.equal(added('www..reddit.com'), 'reddit.com', 'a doubled inner dot collapses')
  assert.equal(added('..www..reddit..com..'), 'reddit.com', 'and any pile-up of them')
  assert.equal(added('www.reddit.com'), 'reddit.com', 'the plain case is unchanged')
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
  assert.deepEqual(v.sites, DEFAULT_SITES)
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

// ---------------------------------------------------------------------------
// Nudging is a switch, independent of the pomodoro timer.
//
// These replace the tests that pinned SNOOZED as a phase. That design made
// "nudging off" and "a work block is running" mutually exclusive: snoozing
// ended the block and zeroed the cycle. Real use showed 196 snoozes against 27
// completed blocks, 11 of them cut short by a snooze — much of the author's work
// is on YouTube and Reddit. The user asked for two independent switches.
// ---------------------------------------------------------------------------

test('NUDGE_OFF keeps a running work block running', () => {
  let s = reduce(initialState(), { type: 'START' }, T0, CFG).state
  s = { ...s, blocksCompleted: 2 }
  const { state } = reduce(s, { type: 'NUDGE_OFF', hours: 1 }, T0 + 5 * MIN, CFG)
  assert.equal(state.phase, PHASE.WORK, 'the block is still running')
  assert.equal(state.endsAt, T0 + 25 * MIN, 'with its original end')
  assert.equal(state.blocksCompleted, 2, 'and the cycle count is kept')
  assert.equal(state.nudgeOffUntil, T0 + 65 * MIN)
  assert.equal(view(state, T0 + 6 * MIN, CFG).nudging, false)
})

test('SNOOZE is an alias of NUDGE_OFF and no longer touches the timer', () => {
  const working = reduce(initialState(), { type: 'START' }, T0, CFG).state
  const { state } = reduce(working, { type: 'SNOOZE', hours: 2 }, T0, CFG)
  assert.equal(state.phase, PHASE.WORK)
  assert.equal(state.nudgeOffUntil, T0 + 120 * MIN)
})

test('NUDGE_OFF accepts fractional hours and rejects nonsense', () => {
  assert.equal(reduce(initialState(), { type: 'NUDGE_OFF', hours: 0.5 }, T0, CFG).state.nudgeOffUntil, T0 + 30 * MIN)
  for (const hours of [0, -1, 'soon', undefined, Infinity]) {
    const out = reduce(initialState(), { type: 'NUDGE_OFF', hours }, T0, CFG)
    assert.deepEqual(out.state, initialState(), `hours=${String(hours)} is ignored`)
    assert.deepEqual(out.effects, [])
  }
})

test('NUDGE_OFF indefinite stays off until NUDGE_ON', () => {
  let s = reduce(initialState(), { type: 'NUDGE_OFF', indefinite: true }, T0, CFG).state
  assert.equal(s.nudgeOffIndefinite, true)
  assert.equal(s.nudgeOffUntil, null)
  const later = settle(s, T0 + 1000 * 60 * MIN, CFG)
  assert.equal(nudgingOn(later.state, T0 + 1000 * 60 * MIN), false, 'never expires on its own')
  assert.deepEqual(later.effects, [])

  const { state, effects } = reduce(s, { type: 'NUDGE_ON' }, T0 + MIN, CFG)
  assert.equal(nudgingOn(state, T0 + MIN), true)
  assert.equal(state.nudgeOffIndefinite, false)
  assert.ok(effects.some(e => e.type === 'log' && e.event === 'nudge_on' && e.data.reason === 'user'))
})

test('a timed NUDGE_OFF expires in settle, silently', () => {
  const s = reduce(initialState(), { type: 'NUDGE_OFF', hours: 1 }, T0, CFG).state
  const early = settle(s, T0 + 59 * MIN, CFG)
  assert.equal(nudgingOn(early.state, T0 + 59 * MIN), false, 'still off a minute early')
  assert.deepEqual(early.effects, [])

  const { state, effects } = settle(s, T0 + 60 * MIN, CFG)
  assert.equal(state.nudgeOffUntil, null, 'cleared exactly on the boundary')
  assert.equal(view(state, T0 + 60 * MIN, CFG).nudging, true)
  const note = effects.find(e => e.type === 'notify')
  assert.equal(note.title, 'Nudging back on')
  assert.equal('sound' in note, false, 'only phase expiry makes a sound')
  assert.ok(effects.some(e => e.type === 'log' && e.event === 'nudge_on' && e.data.reason === 'expired'))
})

test('NUDGE_OFF logs its duration so the insights page can chart it', () => {
  const timed = reduce(initialState(), { type: 'NUDGE_OFF', hours: 2 }, T0, CFG).effects
  assert.ok(timed.some(e => e.event === 'nudge_off' && e.data.hours === 2 && e.data.indefinite === false))
  const open = reduce(initialState(), { type: 'NUDGE_OFF', indefinite: true }, T0, CFG).effects
  assert.ok(open.some(e => e.event === 'nudge_off' && e.data.hours === null && e.data.indefinite === true))
})

test('NUDGE_ON while already on changes nothing and logs nothing', () => {
  const { state, effects } = reduce(initialState(), { type: 'NUDGE_ON' }, T0, CFG)
  assert.deepEqual(state, initialState())
  assert.deepEqual(effects, [])
})

test('the timer never changes whether sites nudge', () => {
  const phases = [
    initialState(),
    { ...initialState(), phase: PHASE.WORK, endsAt: T0 + MIN },
    { ...initialState(), phase: PHASE.SHORT_BREAK, endsAt: T0 + MIN },
    { ...initialState(), phase: PHASE.LONG_BREAK, endsAt: T0 + MIN },
  ]
  for (const s of phases) {
    assert.equal(view(s, T0, CFG).nudging, true, `${s.phase} nudges when nudging is on`)
    const off = reduce(s, { type: 'NUDGE_OFF', hours: 1 }, T0, CFG).state
    assert.equal(view(off, T0, CFG).nudging, false, `${s.phase} does not nudge when nudging is off`)
    assert.equal(off.phase, s.phase, 'and the phase is untouched')
  }
})

test('NUDGE_OFF drains the saved-links queue and spares the tasks', () => {
  let s = reduce(initialState(), { type: 'TASK_ADD', text: 'fix the auth redirect' }, T0, CFG).state
  s = reduce(s, { type: 'TASK_TOGGLE', id: 1 }, T0, CFG).state
  s = reduce(s, { type: 'QUEUE_ADD', url: 'https://reddit.com/r/y', title: 'y' }, T0, CFG).state
  const { state, effects } = reduce(s, { type: 'NUDGE_OFF', hours: 2 }, T0, CFG)
  assert.deepEqual(state.queue, [])
  assert.deepEqual(effects.find(e => e.type === 'openUrls').urls, ['https://reddit.com/r/y'])
  assert.deepEqual(state.tasks.map(t => [t.text, t.done]), [['fix the auth redirect', true]])
  assert.equal(state.nextTaskId, 2)
})

// Replaces 'BREAK_LONG opens the queue...' and 'the automatic long break after
// four blocks also drains the queue'. A long break no longer opens watched sites,
// so draining links that are almost all watched sites into it would open them
// straight into pause screens. The queue now drains when nudging is switched off.
test('a long break no longer drains the queue, and still leaves the tasks alone', () => {
  let s = reduce(initialState(), { type: 'TASK_ADD', text: 'still to do' }, T0, CFG).state
  s = reduce(s, { type: 'QUEUE_ADD', url: 'https://reddit.com/r/x', title: 'x' }, T0, CFG).state
  const manual = reduce(s, { type: 'BREAK_LONG' }, T0, CFG)
  assert.equal(manual.state.phase, PHASE.LONG_BREAK)
  assert.equal(manual.state.queue.length, 1)
  assert.equal(manual.effects.some(e => e.type === 'openUrls'), false)
  assert.deepEqual(manual.state.tasks.map(t => t.text), ['still to do'])

  const auto = reduce({ ...s, phase: PHASE.WORK, endsAt: T0 + MIN, blocksCompleted: 3 }, { type: 'ADVANCE' }, T0, CFG)
  assert.equal(auto.state.phase, PHASE.LONG_BREAK)
  assert.equal(auto.state.queue.length, 1)
  assert.equal(auto.effects.some(e => e.type === 'openUrls'), false)
})

test('settle migrates a stored SNOOZED phase into a nudge-off, keeping everything', () => {
  // The live state.json holds exactly this shape when the new daemon first starts.
  const legacy = {
    ...initialState(),
    phase: 'SNOOZED',
    endsAt: T0 + 30 * MIN,
    tasks: [{ id: 1, text: 'survive me', done: false }],
    nextTaskId: 2,
    queue: [{ url: 'https://reddit.com/r/q', title: 'q', savedAt: T0 }],
  }
  const { state, effects } = settle(legacy, T0, CFG)
  assert.equal(state.phase, PHASE.IDLE)
  assert.equal(state.endsAt, null)
  assert.equal(state.nudgeOffUntil, T0 + 30 * MIN, 'the snooze the user was in is honoured')
  assert.equal(nudgingOn(state, T0), false)
  assert.deepEqual(state.tasks, legacy.tasks)
  assert.equal(state.nextTaskId, 2)
  assert.deepEqual(state.queue, legacy.queue, 'the queue is not drained a second time')
  assert.equal(effects.some(e => e.type === 'notify'), false, 'a silent migration')
})

test('a stored SNOOZED phase with no end migrates to nudging on', () => {
  const trapped = { ...initialState(), phase: 'SNOOZED', endsAt: null, paused: true, pausedRemainingMs: 60_000 }
  const { state } = settle(trapped, T0, CFG)
  assert.equal(state.phase, PHASE.IDLE)
  assert.equal(state.paused, false)
  assert.equal(nudgingOn(state, T0), true)
})

test('an expired stored SNOOZED phase migrates to nudging on', () => {
  const old = { ...initialState(), phase: 'SNOOZED', endsAt: T0 - MIN }
  const { state } = settle(old, T0, CFG)
  assert.equal(state.phase, PHASE.IDLE)
  assert.equal(nudgingOn(state, T0), true)
})

test('PAUSE does not touch nudging, and nudging changes do not touch a pause', () => {
  let s = reduce(initialState(), { type: 'START' }, T0, CFG).state
  s = reduce(s, { type: 'NUDGE_OFF', hours: 1 }, T0, CFG).state
  s = reduce(s, { type: 'PAUSE' }, T0 + 10 * MIN, CFG).state
  assert.equal(s.paused, true)
  assert.equal(s.nudgeOffUntil, T0 + 60 * MIN)
  s = reduce(s, { type: 'NUDGE_ON' }, T0 + 11 * MIN, CFG).state
  assert.equal(s.paused, true, 'still paused')
  assert.equal(s.pausedRemainingMs, 15 * MIN)
})

// --- Linear two-way sync ---------------------------------------------------
// core.js never talks to Linear. It asks with `linearCreate` / `linearSetDone`
// effects, and server.js reports back with TASK_LINKED and LINEAR_SYNC.

const LIN = { ...CFG, linearEnabled: true }
const PROJ = { id: 'proj-9', name: 'PCB Startup' }
const ISSUE = (id, stateType, title = `title ${id}`) =>
  ({ id, identifier: `IBR-${id}`, url: `https://linear.app/x/IBR-${id}`, title, stateType })
const LINK = id => ({ id, identifier: `IBR-${id}`, url: `https://linear.app/x/IBR-${id}` })

test('with Linear off, adding a task asks for nothing', () => {
  const { state, effects } = reduce(initialState(), { type: 'TASK_ADD', text: 'a' }, T0, CFG)
  assert.equal(effects.some(e => e.type === 'linearCreate'), false)
  assert.equal(state.tasks[0].linearPending, false)
  assert.equal(state.tasks[0].linear, null)
})

test('with Linear on, adding a task asks for an issue in the chosen project', () => {
  const { state, effects } = reduce(initialState(), { type: 'TASK_ADD', text: 'route the PCB', project: PROJ, linearId: 'uuid-1' }, T0, LIN)
  assert.deepEqual(state.tasks[0], {
    id: 1, text: 'route the PCB', done: false, project: PROJ, linear: null, linearPending: true, linearId: 'uuid-1',
  })
  assert.deepEqual(effects.find(e => e.type === 'linearCreate'),
    { type: 'linearCreate', taskId: 1, text: 'route the PCB', projectId: 'proj-9', issueId: 'uuid-1' })
})

test('a task with no project asks for an issue with no project', () => {
  const { state, effects } = reduce(initialState(), { type: 'TASK_ADD', text: 'a' }, T0, LIN)
  assert.equal(state.tasks[0].project, null)
  assert.equal(effects.find(e => e.type === 'linearCreate').projectId, null)
})

test('a malformed project is dropped rather than stored', () => {
  const { state } = reduce(initialState(), { type: 'TASK_ADD', text: 'a', project: { name: 'no id' } }, T0, LIN)
  assert.equal(state.tasks[0].project, null)
})

test('TASK_LINKED attaches the issue and clears the pending flag', () => {
  let s = reduce(initialState(), { type: 'TASK_ADD', text: 'a' }, T0, LIN).state
  s = reduce(s, { type: 'TASK_LINKED', taskId: 1, text: 'a', linear: LINK('40') }, T0, LIN).state
  assert.deepEqual(s.tasks[0].linear, LINK('40'))
  assert.equal(s.tasks[0].linearPending, false)
})

test('TASK_LINKED for a task that is gone dismisses the orphan issue so sync will not re-add it', () => {
  // Task ids restart at 1 once the list empties, so the text is checked too:
  // a late answer must never link a different task that reused the id.
  let s = reduce(initialState(), { type: 'TASK_ADD', text: 'old' }, T0, LIN).state
  s = reduce(s, { type: 'TASK_REMOVE', id: 1 }, T0, LIN).state
  s = reduce(s, { type: 'TASK_ADD', text: 'new' }, T0, LIN).state
  s = reduce(s, { type: 'TASK_LINKED', taskId: 1, text: 'old', linear: LINK('40') }, T0, LIN).state
  assert.equal(s.tasks[0].linear, null, 'the new task is not linked to the old issue')
  assert.equal(s.tasks[0].linearPending, true)
  assert.deepEqual(s.linearDismissed, ['40'])
})

test('ticking a linked task done and back asks Linear to follow both ways', () => {
  let s = reduce(initialState(), { type: 'TASK_ADD', text: 'a' }, T0, LIN).state
  s = reduce(s, { type: 'TASK_LINKED', taskId: 1, text: 'a', linear: LINK('40') }, T0, LIN).state
  let out = reduce(s, { type: 'TASK_TOGGLE', id: 1 }, T0, LIN)
  assert.deepEqual(out.effects.find(e => e.type === 'linearSetDone'), { type: 'linearSetDone', issueId: '40', done: true })
  assert.ok(out.effects.some(e => e.event === 'task_done'))
  out = reduce(out.state, { type: 'TASK_TOGGLE', id: 1 }, T0, LIN)
  assert.deepEqual(out.effects.find(e => e.type === 'linearSetDone'), { type: 'linearSetDone', issueId: '40', done: false })
})

test('ticking an unlinked task asks Linear for nothing but still logs task_done', () => {
  const s = reduce(initialState(), { type: 'TASK_ADD', text: 'a' }, T0, CFG).state
  const { effects } = reduce(s, { type: 'TASK_TOGGLE', id: 1 }, T0, CFG)
  assert.equal(effects.some(e => e.type === 'linearSetDone'), false)
  assert.ok(effects.some(e => e.event === 'task_done'))
})

test('removing or clearing linked tasks remembers their issues as dismissed', () => {
  let s = initialState()
  for (const [i, t] of ['a', 'b', 'c'].entries()) {
    s = reduce(s, { type: 'TASK_ADD', text: t }, T0, LIN).state
    s = reduce(s, { type: 'TASK_LINKED', taskId: i + 1, text: t, linear: LINK(String(40 + i)) }, T0, LIN).state
  }
  s = reduce(s, { type: 'TASK_REMOVE', id: 1 }, T0, LIN).state
  s = reduce(s, { type: 'TASK_TOGGLE', id: 2 }, T0, LIN).state
  s = reduce(s, { type: 'TASK_CLEAR_DONE' }, T0, LIN).state
  assert.deepEqual(s.linearDismissed, ['40', '41'])
  s = reduce(s, { type: 'TASK_CLEAR' }, T0, LIN).state
  assert.deepEqual(s.linearDismissed, ['40', '41', '42'])
})

test('LINEAR_SYNC adds active issues the list does not have yet', () => {
  const { state, effects } = reduce(initialState(),
    { type: 'LINEAR_SYNC', issues: [ISSUE('17', 'started'), ISSUE('43', 'unstarted')] }, T0, LIN)
  assert.deepEqual(state.tasks.map(t => [t.id, t.text, t.done, t.linear.identifier, t.linearPending, t.project]),
    [[1, 'title 17', false, 'IBR-17', false, null], [2, 'title 43', false, 'IBR-43', false, null]])
  assert.deepEqual(effects.find(e => e.event === 'linear_sync').data, { added: 2, completed: 0 })
})

test('LINEAR_SYNC ignores completed issues it has never seen', () => {
  const { state, effects } = reduce(initialState(),
    { type: 'LINEAR_SYNC', issues: [ISSUE('1', 'completed'), ISSUE('2', 'canceled'), ISSUE('3', 'duplicate')] }, T0, LIN)
  assert.deepEqual(state.tasks, [])
  assert.deepEqual(effects, [], 'nothing changed, nothing logged')
})

test('LINEAR_SYNC ticks a linked task when its issue is closed in Linear, and follows a rename', () => {
  let s = reduce(initialState(), { type: 'LINEAR_SYNC', issues: [ISSUE('1', 'started'), ISSUE('2', 'started'), ISSUE('3', 'started')] }, T0, LIN).state
  const { state, effects } = reduce(s, { type: 'LINEAR_SYNC', issues: [
    ISSUE('1', 'completed'), ISSUE('2', 'canceled'), ISSUE('3', 'started', 'renamed in Linear'),
  ] }, T0, LIN)
  assert.deepEqual(state.tasks.map(t => [t.text, t.done]),
    [['title 1', true], ['title 2', true], ['renamed in Linear', false]])
  assert.deepEqual(effects.find(e => e.event === 'linear_sync').data, { added: 0, completed: 2 })
  assert.equal(effects.some(e => e.type === 'linearSetDone'), false, 'no echo back to Linear')
})

test('LINEAR_SYNC never un-ticks a task the user ticked here', () => {
  let s = reduce(initialState(), { type: 'LINEAR_SYNC', issues: [ISSUE('1', 'started')] }, T0, LIN).state
  s = reduce(s, { type: 'TASK_TOGGLE', id: 1 }, T0, LIN).state
  const { state } = reduce(s, { type: 'LINEAR_SYNC', issues: [ISSUE('1', 'started')] }, T0, LIN)
  assert.equal(state.tasks[0].done, true)
})

test('LINEAR_SYNC never re-adds an issue the user removed here', () => {
  let s = reduce(initialState(), { type: 'LINEAR_SYNC', issues: [ISSUE('1', 'started')] }, T0, LIN).state
  s = reduce(s, { type: 'TASK_REMOVE', id: 1 }, T0, LIN).state
  const { state } = reduce(s, { type: 'LINEAR_SYNC', issues: [ISSUE('1', 'started')] }, T0, LIN)
  assert.deepEqual(state.tasks, [])
})

test('LINEAR_SYNC with Linear off or nonsense input changes nothing', () => {
  const s = initialState()
  assert.deepEqual(reduce(s, { type: 'LINEAR_SYNC', issues: [ISSUE('1', 'started')] }, T0, CFG).state, s)
  assert.deepEqual(reduce(s, { type: 'LINEAR_SYNC', issues: 'nope' }, T0, LIN).state, s)
  assert.deepEqual(reduce(s, { type: 'LINEAR_SYNC', issues: [null, { id: 5 }] }, T0, LIN).state, s)
})

test('view carries linearEnabled', () => {
  assert.equal(view(initialState(), T0, CFG).linearEnabled, false)
  assert.equal(view(initialState(), T0, LIN).linearEnabled, true)
})

// Asked for by the user mid-build: dropping a task drops it in Linear too, so the
// two boards do not drift apart. A task already ticked is Done in Linear, and
// clearing it from the list must not turn that Done into Canceled.
const cancels = effects => effects.filter(e => e.type === 'linearCancel').map(e => e.issueId)

function linkedList(texts) {
  let s = initialState()
  for (const [i, t] of texts.entries()) {
    s = reduce(s, { type: 'TASK_ADD', text: t }, T0, LIN).state
    s = reduce(s, { type: 'TASK_LINKED', taskId: i + 1, text: t, linear: LINK(String(40 + i)) }, T0, LIN).state
  }
  return s
}

test('removing an open linked task cancels its Linear issue', () => {
  const { effects } = reduce(linkedList(['a']), { type: 'TASK_REMOVE', id: 1 }, T0, LIN)
  assert.deepEqual(cancels(effects), ['40'])
})

test('removing a task already ticked done leaves its Linear issue Done', () => {
  let s = reduce(linkedList(['a']), { type: 'TASK_TOGGLE', id: 1 }, T0, LIN).state
  const { effects } = reduce(s, { type: 'TASK_REMOVE', id: 1 }, T0, LIN)
  assert.deepEqual(cancels(effects), [])
})

// Replaces "TASK_CLEAR cancels the open linked tasks only". The user ruled that
// one clear must never be able to cancel a whole Linear board: clearing empties
// the local list only. Removing ONE task still cancels its issue.
test('TASK_CLEAR and clear done cancel nothing in Linear, and the cleared issues stay out of the list', () => {
  let s = reduce(linkedList(['a', 'b', 'c']), { type: 'TASK_TOGGLE', id: 2 }, T0, LIN).state
  assert.deepEqual(cancels(reduce(s, { type: 'TASK_CLEAR_DONE' }, T0, LIN).effects), [])
  const cleared = reduce(s, { type: 'TASK_CLEAR' }, T0, LIN)
  assert.deepEqual(cancels(cleared.effects), [])
  assert.deepEqual(cleared.state.linearDismissed, ['40', '41', '42'])
  const synced = reduce(cleared.state, { type: 'LINEAR_SYNC', issues: [ISSUE('40', 'started')] }, T0, LIN).state
  assert.deepEqual(synced.tasks, [], 'not pulled back in')
})

test('removing an unlinked task asks Linear for nothing', () => {
  const s = reduce(initialState(), { type: 'TASK_ADD', text: 'a' }, T0, CFG).state
  assert.deepEqual(cancels(reduce(s, { type: 'TASK_REMOVE', id: 1 }, T0, CFG).effects), [])
})

test('an issue created for a task removed before Linear answered is cancelled', () => {
  let s = reduce(initialState(), { type: 'TASK_ADD', text: 'old' }, T0, LIN).state
  s = reduce(s, { type: 'TASK_REMOVE', id: 1 }, T0, LIN).state
  const { effects } = reduce(s, { type: 'TASK_LINKED', taskId: 1, text: 'old', linear: LINK('40') }, T0, LIN)
  assert.deepEqual(cancels(effects), ['40'])
})

// --- insights inputs ---------------------------------------------------------

test('block_completed records the minutes actually worked', () => {
  let s = reduce(initialState(), { type: 'START' }, T0, CFG).state
  let { effects } = reduce(s, { type: 'ADVANCE' }, T0 + 10 * MIN, CFG)
  assert.equal(effects.find(e => e.event === 'block_completed').data.minutes, 10, 'skipped early')
  // The block is over at expiry; overrunning it is not extra focus.
  ;({ effects } = reduce(s, { type: 'ADVANCE' }, T0 + 30 * MIN, CFG))
  assert.equal(effects.find(e => e.event === 'block_completed').data.minutes, 25)
})

test('block_completed minutes while paused are what was worked before the pause', () => {
  let s = reduce(initialState(), { type: 'START' }, T0, CFG).state
  s = reduce(s, { type: 'PAUSE' }, T0 + 5 * MIN, CFG).state
  const { effects } = reduce(s, { type: 'ADVANCE' }, T0 + 50 * MIN, CFG)
  assert.equal(effects.find(e => e.event === 'block_completed').data.minutes, 5)
})

test('NUDGE_EVENT logs a shown or back outcome and changes no state', () => {
  const s = initialState()
  for (const outcome of ['shown', 'back']) {
    const { state, effects } = reduce(s, { type: 'NUDGE_EVENT', site: 'reddit.com', outcome }, T0, CFG)
    assert.equal(state, s)
    assert.deepEqual(effects, [{ type: 'log', event: `nudge_${outcome}`, data: { site: 'reddit.com' } }])
  }
  assert.deepEqual(reduce(s, { type: 'NUDGE_EVENT', site: 'reddit.com', outcome: 'evil' }, T0, CFG).effects, [])
  assert.deepEqual(reduce(s, { type: 'NUDGE_EVENT', site: '', outcome: 'shown' }, T0, CFG).effects, [])
})

// --- final-review fixes --------------------------------------------------------

// Replaces "nudgingPhase mirrors nudging for older clients". An extension not
// yet reloaded runs the OLD service worker, which nudges on phase alone; if the
// pause screen were told nudging is off it released, the worker intercepted
// again, and every watched site looped. The alias keeps its old meaning so an
// old extension stays consistent with itself until it is reloaded.
test('nudgingPhase keeps the old phase rule, whatever the nudging switch says', () => {
  for (const [phase, old] of [[PHASE.IDLE, true], [PHASE.WORK, true], [PHASE.SHORT_BREAK, true], [PHASE.LONG_BREAK, false]]) {
    const s = { ...initialState(), phase, endsAt: phase === PHASE.IDLE ? null : T0 + MIN }
    const off = reduce(s, { type: 'NUDGE_OFF', hours: 1 }, T0, CFG).state
    assert.equal(view(s, T0, CFG).nudgingPhase, old, phase)
    assert.equal(view(off, T0, CFG).nudgingPhase, old, `${phase} with nudging off`)
  }
})

test('TASK_ADD keeps the issue id chosen for Linear so a retry can never create a second issue', () => {
  const { state, effects } = reduce(initialState(), { type: 'TASK_ADD', text: 'a', linearId: 'uuid-1' }, T0, LIN)
  assert.equal(state.tasks[0].linearId, 'uuid-1')
  assert.equal(effects.find(e => e.type === 'linearCreate').issueId, 'uuid-1')
  const off = reduce(initialState(), { type: 'TASK_ADD', text: 'a', linearId: 'uuid-1' }, T0, CFG).state
  assert.equal(off.tasks[0].linearId, null, 'no Linear, no id')
})

test('LINEAR_SYNC links a pending task to the issue it already created instead of adding a duplicate', () => {
  let s = reduce(initialState(), { type: 'TASK_ADD', text: 'write report', linearId: 'uuid-1' }, T0, LIN).state
  const { state } = reduce(s, { type: 'LINEAR_SYNC', issues: [{ ...ISSUE('x', 'unstarted', 'write report'), id: 'uuid-1' }] }, T0, LIN)
  assert.equal(state.tasks.length, 1)
  assert.equal(state.tasks[0].linear.id, 'uuid-1')
  assert.equal(state.tasks[0].linearPending, false)
})
