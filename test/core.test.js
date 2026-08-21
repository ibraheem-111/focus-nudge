import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PHASE, initialState, reduce, settle, view } from '../daemon/core.js'
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
    { ...initialState(), phase: PHASE.SNOOZED, endsAt: T0 + 60 * MIN },
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

// PAUSE used to apply to any phase with an endsAt, which included the two
// sanctioned windows. Pausing one set endsAt to null, and settle's expiry
// branches all require endsAt !== null — so the window never ended and nudging
// was off permanently, across restarts. A sanctioned window is a stretch of wall
// clock, not work: there is nothing there to pause.
test('PAUSE while snoozed is a no-op, so the snooze can still expire', () => {
  const snoozed = reduce(initialState(), { type: 'SNOOZE', hours: 1 }, T0, CFG).state
  const { state, effects } = reduce(snoozed, { type: 'PAUSE' }, T0 + MIN, CFG)
  assert.deepEqual(state, snoozed, 'the snooze is untouched')
  assert.deepEqual(effects, [], 'and nothing is logged')
  assert.equal(state.endsAt, T0 + 60 * MIN, 'endsAt is NOT cleared')

  // The escape from the trap: expiry still fires afterwards.
  const later = settle(state, T0 + 60 * MIN, CFG)
  assert.equal(later.state.phase, PHASE.IDLE, 'the snooze still expires')
  assert.equal(view(later.state, T0 + 60 * MIN, CFG).nudgingPhase, true, 'and nudging is back on')
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

test('a paused snooze cannot be resurrected as a paused WORK block by START', () => {
  // Belt and braces on the shape: with PAUSE refusing sanctioned phases, no
  // path can leave phase SNOOZED with paused:true and endsAt:null.
  const snoozed = reduce(initialState(), { type: 'SNOOZE', hours: 1 }, T0, CFG).state
  const attempted = reduce(snoozed, { type: 'PAUSE' }, T0 + MIN, CFG).state
  assert.equal(attempted.paused, false)
  assert.equal(attempted.pausedRemainingMs, null)
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

// Refusing to pause a sanctioned window stops the trap being SET, but it does
// nothing for a state.json that already holds one — that file outlives the fix,
// and settle could never expire it because every expiry branch needs an endsAt.
// A sanctioned phase with no end is unreachable by any legitimate path (SNOOZE
// and BREAK_LONG both always set a finite endsAt), so encountering one can only
// mean the old bug wrote it, and the only safe reading is "over".
test('settle frees a snooze that was already trapped with no endsAt', () => {
  const trapped = {
    ...initialState(),
    phase: PHASE.SNOOZED,
    endsAt: null,
    paused: true,
    pausedRemainingMs: 3_540_000,
    tasks: [{ id: 1, text: 'survive me', done: false }],
    nextTaskId: 2,
  }
  const { state, effects } = settle(trapped, T0, CFG)
  assert.equal(state.phase, PHASE.IDLE, 'the dead snooze is released')
  assert.equal(state.paused, false)
  assert.equal(state.pausedRemainingMs, null)
  assert.equal(view(state, T0, CFG).nudgingPhase, true, 'and nudging is back on')
  assert.deepEqual(state.tasks, [{ id: 1, text: 'survive me', done: false }], 'tasks survive the rescue')
  assert.equal(state.nextTaskId, 2)
  assert.ok(effects.some(e => e.type === 'notify'), 'the user is told, not silently changed under them')
})

test('settle frees a long break that was already trapped with no endsAt', () => {
  const trapped = { ...initialState(), phase: PHASE.LONG_BREAK, endsAt: null, paused: true, pausedRemainingMs: 60_000 }
  const { state } = settle(trapped, T0, CFG)
  assert.equal(state.phase, PHASE.IDLE)
  assert.equal(view(state, T0, CFG).nudgingPhase, true)
})

test('the rescue does not touch a sanctioned window that still has an end', () => {
  // It must only fire on the impossible shape, never shorten a real snooze.
  const live = reduce(initialState(), { type: 'SNOOZE', hours: 2 }, T0, CFG).state
  const { state, effects } = settle(live, T0 + 60 * MIN, CFG)
  assert.equal(state.phase, PHASE.SNOOZED, 'a running snooze is left alone')
  assert.deepEqual(effects, [])

  const onBreak = reduce(initialState(), { type: 'BREAK_LONG' }, T0, CFG).state
  assert.equal(settle(onBreak, T0 + MIN, CFG).state.phase, PHASE.LONG_BREAK)
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

test('BREAK_LONG opens the queue and leaves the task list alone', () => {
  // This test previously asserted the opposite — that a long break cleared the
  // list. That was a real bug reported after two weeks of use: a break does not
  // complete your work, so nothing here may delete it. Changed deliberately.
  let s = reduce(initialState(), { type: 'TASK_ADD', text: 'still to do' }, T0, CFG).state
  s = reduce(s, { type: 'QUEUE_ADD', url: 'https://reddit.com/r/x', title: 'x' }, T0, CFG).state

  const { state, effects } = reduce(s, { type: 'BREAK_LONG' }, T0, CFG)
  assert.equal(state.phase, PHASE.LONG_BREAK)
  assert.equal(state.endsAt, T0 + 20 * MIN)
  assert.deepEqual(state.tasks.map(t => t.text), ['still to do'], 'the task survives the break')
  assert.deepEqual(state.queue, [], 'the queue still drains')

  const open = effects.find(e => e.type === 'openUrls')
  assert.deepEqual(open.urls, ['https://reddit.com/r/x'])
  assert.equal(effects.some(e => e.event === 'tasks_archived'), false, 'nothing is archived any more')
})

test('snoozing does not delete micro-tasks', () => {
  // The bug the author hit: `focus off 2h` for a meeting wiped the whole list.
  // Ten of eleven archive events in two weeks of real logs were snooze-triggered.
  let s = reduce(initialState(), { type: 'TASK_ADD', text: 'fix the auth redirect' }, T0, CFG).state
  s = reduce(s, { type: 'TASK_ADD', text: 'reply to Nick' }, T0, CFG).state
  s = reduce(s, { type: 'TASK_TOGGLE', id: 1 }, T0, CFG).state

  const { state } = reduce(s, { type: 'SNOOZE', hours: 2 }, T0, CFG)
  assert.equal(state.phase, PHASE.SNOOZED)
  assert.deepEqual(state.tasks.map(t => t.text), ['fix the auth redirect', 'reply to Nick'])
  assert.equal(state.tasks[0].done, true, 'done flags survive too')
  assert.equal(state.nextTaskId, 3, 'and the numbering is not reset')
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
