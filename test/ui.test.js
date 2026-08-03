import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countdown, formatDuration, clockLine } from '../extension/ui.js'

// Runs every scheduled step immediately, so a 10-second countdown resolves
// synchronously instead of taking 10 seconds.
const immediate = fn => fn()

test('the countdown always reaches onDone — the escape hatch cannot stay locked', () => {
  for (const seconds of [0, 1, 10, 3600, -5, undefined, null, NaN, 'abc', Infinity]) {
    let done = false
    countdown({ seconds, onDone: () => { done = true }, schedule: immediate })
    assert.equal(done, true, `onDone did not fire for seconds=${String(seconds)}`)
  }
})

test('the countdown ticks down once per second and then unlocks', () => {
  const ticks = []
  let done = false
  countdown({ seconds: 3, onTick: n => ticks.push(n), onDone: () => { done = true }, schedule: immediate })
  assert.deepEqual(ticks, [3, 2, 1])
  assert.equal(done, true)
})

test('a zero countdown unlocks immediately with no tick', () => {
  const ticks = []
  let done = false
  countdown({ seconds: 0, onTick: n => ticks.push(n), onDone: () => { done = true }, schedule: immediate })
  assert.deepEqual(ticks, [])
  assert.equal(done, true)
})

test('setSeconds adjusts a running countdown instead of restarting it', () => {
  const ticks = []
  const steps = []
  // Defer the steps so the countdown is still mid-flight when we adjust it.
  const c = countdown({ seconds: 10, onTick: n => ticks.push(n), schedule: fn => steps.push(fn) })
  assert.deepEqual(ticks, [10], 'the first tick happens at once, not after a round trip')
  c.setSeconds(2)
  while (steps.length) steps.shift()()
  assert.deepEqual(ticks, [10, 2, 1], 'it continued from the new value')
  assert.equal(c.finished, true)
})

test('setSeconds is ignored once the countdown has finished', () => {
  const c = countdown({ seconds: 0, schedule: immediate })
  assert.equal(c.finished, true)
  c.setSeconds(30)
  assert.equal(c.finished, true, 'a late value cannot re-lock the escape hatch')
})

test('clockLine copes with a missing view and an unknown phase', () => {
  assert.equal(clockLine(null), 'no block running')
  assert.equal(clockLine(undefined), 'no block running')
  assert.equal(clockLine({ remainingMs: null }), 'no block running')
  assert.ok(clockLine({ phase: 'GARBAGE', remainingMs: 60_000 }).includes(formatDuration(60_000)))
})
