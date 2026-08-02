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
