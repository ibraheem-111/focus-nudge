import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countdown, formatDuration, clockLine, renderTasks } from '../extension/ui.js'

// renderTasks touches `document`, which does not exist under `node --test`. This
// is a minimal stand-in: just enough of createElement/append/addEventListener
// for renderTasks's DOM calls to work, with no rendering behind it.
function stubDocument() {
  global.document = {
    createElement(tag) {
      const listeners = {}
      return {
        tagName: tag,
        className: '',
        textContent: '',
        title: undefined,
        type: undefined,
        checked: undefined,
        children: [],
        addEventListener(type, fn) {
          (listeners[type] ??= []).push(fn)
        },
        hasListener(type) {
          return Boolean(listeners[type]?.length)
        },
        dispatch(type, ev) {
          for (const fn of listeners[type] ?? []) fn(ev)
        },
        append(...nodes) { this.children.push(...nodes) },
      }
    },
  }
}
stubDocument()

// A fake `tasks` container: tracks how many times replaceChildren actually
// ran, which is the thing the signature guard is supposed to suppress.
function makeTasksEl() {
  return {
    dataset: {},
    children: [],
    replaceChildrenCalls: 0,
    replaceChildren(...nodes) {
      this.replaceChildrenCalls++
      this.children = nodes
    },
    append(...nodes) { this.children.push(...nodes) },
  }
}

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

// Every page polls once a second. Without a signature guard, an unchanged poll
// result rebuilds the list and snaps a just-clicked checkbox back to the
// daemon's stale value — this is the bug the operator hit.
test('renderTasks does not rebuild on an unchanged task list', () => {
  const el = makeTasksEl()
  const tasks = [{ id: 1, text: 'a', done: false }, { id: 2, text: 'b', done: true }]
  renderTasks(el, tasks)
  assert.equal(el.replaceChildrenCalls, 1)

  // A fresh array of fresh objects with identical values — exactly what a
  // second poll of unchanged daemon state looks like.
  renderTasks(el, tasks.map(t => ({ ...t })))
  assert.equal(el.replaceChildrenCalls, 1, 'unchanged data must not trigger a rebuild')
})

test('renderTasks rebuilds when a done flag flips', () => {
  const el = makeTasksEl()
  renderTasks(el, [{ id: 1, text: 'a', done: false }])
  assert.equal(el.replaceChildrenCalls, 1)
  renderTasks(el, [{ id: 1, text: 'a', done: true }])
  assert.equal(el.replaceChildrenCalls, 2, 'a flipped done flag must trigger a rebuild')
})

test('renderTasks rebuilds when task text is edited', () => {
  const el = makeTasksEl()
  renderTasks(el, [{ id: 1, text: 'a', done: false }])
  assert.equal(el.replaceChildrenCalls, 1)
  renderTasks(el, [{ id: 1, text: 'a (edited)', done: false }])
  assert.equal(el.replaceChildrenCalls, 2, 'edited text must trigger a rebuild')
})

test('renderTasks rebuilds when a task is added or removed', () => {
  const el = makeTasksEl()
  renderTasks(el, [{ id: 1, text: 'a', done: false }])
  assert.equal(el.replaceChildrenCalls, 1)
  renderTasks(el, [{ id: 1, text: 'a', done: false }, { id: 2, text: 'b', done: false }])
  assert.equal(el.replaceChildrenCalls, 2, 'an added task must trigger a rebuild')
  renderTasks(el, [{ id: 1, text: 'a', done: false }])
  assert.equal(el.replaceChildrenCalls, 3, 'a removed task must trigger a rebuild')
})

test('renderTasks renders the empty state, and switching to it rebuilds', () => {
  const el = makeTasksEl()
  renderTasks(el, [{ id: 1, text: 'a', done: false }])
  assert.equal(el.replaceChildrenCalls, 1)

  renderTasks(el, [])
  assert.equal(el.replaceChildrenCalls, 2, 'going from non-empty to empty must trigger a rebuild')
  assert.equal(el.children.length, 1)
  const [empty] = el.children
  assert.equal(empty.tagName, 'p')
  assert.equal(empty.className, 'empty')
  assert.equal(empty.textContent, 'no micro-tasks yet')

  // And the empty state itself is stable across repeated identical polls.
  renderTasks(el, [])
  assert.equal(el.replaceChildrenCalls, 2, 'an unchanged empty list must not rebuild')
})

test('renderTasks wires onToggle to fire with the clicked task id', () => {
  const el = makeTasksEl()
  const calls = []
  renderTasks(el, [{ id: 7, text: 'x', done: false }], { onToggle: id => calls.push(id) })
  const [row] = el.children
  const [box] = row.children
  assert.equal(box.tagName, 'input')
  box.dispatch('change')
  assert.deepEqual(calls, [7])
})

test('renderTasks attaches no change listener when onToggle is omitted', () => {
  const el = makeTasksEl()
  renderTasks(el, [{ id: 7, text: 'x', done: false }])
  const [row] = el.children
  const [box] = row.children
  assert.equal(box.hasListener('change'), false, 'no onToggle means no change listener')
})

test('nudgingLine describes the nudging switch', async () => {
  const { nudgingLine } = await import('../extension/ui.js')
  assert.equal(nudgingLine({ nudging: true }), 'nudging on')
  assert.equal(nudgingLine({ nudging: false, nudgeOffIndefinite: true, nudgeOffUntil: null }),
    'nudging off until you turn it back on')
  assert.equal(nudgingLine({ nudging: false, nudgeOffIndefinite: false, nudgeOffUntil: 1_000 + 42 * 60_000 + 10_000, serverTime: 1_000 }),
    'nudging off — 42:10 left')
  assert.equal(nudgingLine({ nudging: false, nudgeOffIndefinite: false, nudgeOffUntil: 1_000 + 90 * 60_000, serverTime: 1_000 }),
    'nudging off — 1:30:00 left')
  assert.equal(nudgingLine(null), 'nudging unknown — no daemon')
})
