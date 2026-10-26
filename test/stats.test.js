import { test } from 'node:test'
import assert from 'node:assert/strict'
import { insights, summariseLog, localDay } from '../daemon/stats.js'
import * as server from '../daemon/server.js'

// Time is synthetic and the calendar is UTC via the injected helpers, so these
// results do not depend on the machine's timezone.
const H = 3_600_000
const DAY = 24 * H
const D0 = Date.UTC(2026, 9, 1)           // 2026-10-01 00:00 UTC, a Thursday
const utc = {
  dayKey: at => new Date(at).toISOString().slice(0, 10),
  hourOf: at => new Date(at).getUTCHours(),
  dayOfWeek: at => new Date(at).getUTCDay(),
}
const log = entries => entries.map(e => JSON.stringify(e)).join('\n') + '\n'
const run = (entries, now = D0 + 30 * DAY, extra = {}) => insights(log(entries), { now, ...utc, ...extra })

test('summariseLog and localDay still come from server.js', () => {
  assert.equal(server.summariseLog, summariseLog)
  assert.equal(server.localDay, localDay)
})

test('a NUL-prefixed line from an unclean shutdown is still counted', () => {
  const text = '\0\0\0' + JSON.stringify({ at: D0, event: 'block_completed' }) + '\n'
  assert.equal(insights(text, { now: D0, ...utc }).kpis.blocks.all, 1)
  assert.equal(summariseLog(text, { now: D0, dayKey: utc.dayKey }).blocksCompleted, 1)
})

test('focus minutes come from block_completed.minutes, else the work length', () => {
  const r = run([
    { at: D0, event: 'block_completed', minutes: 12.5 },
    { at: D0 + H, event: 'block_completed' },
  ], D0 + 2 * H, { workMinutes: 50 })
  assert.equal(r.kpis.focusMinutes.all, 62.5)
  assert.equal(r.kpis.focusMinutes.today, 62.5)
  assert.equal(r.byDay['2026-10-01'].focusMinutes, 62.5)
})

test('today, last 7 days and all time are separate windows', () => {
  const now = D0 + 20 * DAY + 12 * H
  const r = run([
    { at: D0, event: 'block_completed' },                    // long ago
    { at: now - 3 * DAY, event: 'block_completed' },         // this week
    { at: now - H, event: 'block_completed' },               // today
  ], now)
  assert.deepEqual(r.kpis.blocks, { today: 1, last7: 2, all: 3 })
})

test('streaks: current counts back from today (or yesterday), best is the longest run', () => {
  const day = n => D0 + n * DAY + 10 * H
  const r = run([
    ...[0, 1, 2, 3].map(n => ({ at: day(n), event: 'block_completed' })),   // best: 4
    ...[10, 11].map(n => ({ at: day(n), event: 'block_completed' })),        // current: 2
  ], day(12))
  assert.deepEqual(r.kpis.streak, { current: 2, best: 4 }, 'a day with no block YET does not break the streak')
  assert.equal(run([{ at: day(0), event: 'block_completed' }], day(5)).kpis.streak.current, 0)
})

test('byHour and byWeekday use the injected clock helpers', () => {
  const r = run([
    { at: D0 + 9 * H, event: 'block_completed' },
    { at: D0 + 9 * H + 60_000, event: 'continued', site: 'reddit.com' },
    { at: D0 + 23 * H, event: 'nudge_off', hours: 1 },
  ])
  assert.equal(r.byHour.length, 24)
  assert.deepEqual(r.byHour[9], { blocks: 1, continued: 1, nudgeOffs: 0 })
  assert.deepEqual(r.byHour[23], { blocks: 0, continued: 0, nudgeOffs: 1 })
  assert.equal(r.byWeekday.length, 7)
  assert.deepEqual(r.byWeekday[4], { blocks: 1, continued: 1 }, 'Thursday')
})

test('block outcomes: completed, stopped, ended by a legacy snooze; nudge_off does not end a block', () => {
  const r = run([
    { at: D0, event: 'phase', phase: 'WORK' },
    { at: D0 + 1, event: 'nudge_off', hours: 1 },            // new: block keeps running
    { at: D0 + 2, event: 'block_completed' },
    { at: D0 + 3, event: 'phase', phase: 'WORK' },
    { at: D0 + 4, event: 'pause', phase: 'WORK' },
    { at: D0 + 5, event: 'phase', phase: 'IDLE', from: 'WORK' },
    { at: D0 + 6, event: 'phase', phase: 'WORK' },
    { at: D0 + 7, event: 'snooze', hours: 1 },               // old daemon: ended the block
    { at: D0 + 8, event: 'phase', phase: 'WORK' },           // still running: not counted
  ])
  assert.deepEqual(r.blockOutcomes, { completed: 1, stopped: 1, nudgeOff: 1 })
})

test('the nudge funnel and the per-site table', () => {
  const r = run([
    { at: D0, event: 'nudge_shown', site: 'reddit.com' },
    { at: D0 + 1, event: 'nudge_shown', site: 'reddit.com' },
    { at: D0 + 2, event: 'nudge_shown', site: 'youtube.com' },
    { at: D0 + 3, event: 'nudge_back', site: 'reddit.com' },
    { at: D0 + 4, event: 'continued', site: 'youtube.com' },
    { at: D0 + 5, event: 'saved_for_later', url: 'https://www.reddit.com/r/robotics/x' },
  ])
  assert.deepEqual(r.funnel, { shown: 3, back: 1, continued: 1, saved: 1 })
  assert.deepEqual(r.bySite['reddit.com'], { shown: 2, back: 1, continued: 0, saved: 1 })
  assert.deepEqual(r.bySite['youtube.com'], { shown: 1, back: 0, continued: 1, saved: 0 })
  assert.equal(r.shownTrackedSince, D0)
})

test('nudge-off hours: timed, cut short by turning it on, indefinite, and legacy snoozes', () => {
  const r = run([
    { at: D0, event: 'snooze', hours: 1 },
    { at: D0 + 10 * H, event: 'nudge_off', hours: 4, indefinite: false },
    { at: D0 + 11 * H, event: 'nudge_on', reason: 'user' },        // cut to 1h
    { at: D0 + 20 * H, event: 'nudge_off', hours: null, indefinite: true },
    { at: D0 + 23 * H, event: 'nudge_on', reason: 'user' },        // 3h
  ])
  assert.equal(r.kpis.nudgeOffs, 3)
  assert.equal(r.kpis.nudgeOffHours, 5)
  assert.deepEqual(r.nudgeOffDurations, { '1h': 1, '4h': 1, 'until on': 1 })
})

test('tasks added and done, and the first and last timestamps', () => {
  const r = run([
    { at: D0, event: 'task_added' },
    { at: D0 + 1, event: 'task_added' },
    { at: D0 + 2, event: 'task_done' },
    { at: 'garbage', event: 'task_done' },
  ])
  assert.equal(r.kpis.tasksAdded, 2)
  assert.equal(r.kpis.tasksDone, 1, 'an entry with no usable timestamp is left out')
  assert.equal(r.byDay['2026-10-01'].tasksDone, 1)
  assert.equal(r.firstAt, D0)
  assert.equal(r.lastAt, D0 + 2)
})

test('an empty or junk log gives zeros, not a crash', () => {
  for (const text of ['', 'not json\n{"event":', '\0\0\0']) {
    const r = insights(text, { now: D0, ...utc })
    assert.equal(r.kpis.blocks.all, 0)
    assert.equal(r.firstAt, null)
  }
})

test('since narrows every breakdown, but the calendar and streak keep full history', () => {
  const r = run([
    { at: D0 + 9 * H, event: 'block_completed' },
    { at: D0 + 9 * H, event: 'continued', site: 'reddit.com' },
    { at: D0 + 5 * DAY + 9 * H, event: 'block_completed' },
  ], D0 + 5 * DAY + 10 * H, { since: D0 + 2 * DAY })
  assert.equal(r.byHour[9].blocks, 1)
  assert.equal(r.byHour[9].continued, 0)
  assert.deepEqual(r.funnel.continued, 0)
  assert.equal(r.bySite['reddit.com'], undefined)
  assert.equal(r.byDay['2026-10-01'].blocks, 1, 'the heatmap still has the old day')
  assert.equal(r.kpis.blocks.all, 2, 'all-time stays all-time')
  assert.equal(r.since, D0 + 2 * DAY)
})

test('an old snooze ended when a phase began; a new nudge_off does not', () => {
  // The old daemon's snooze WAS a phase, so `focus start` ended it. Counting its
  // full hours overstated the time nudging was really off.
  const r = run([
    { at: D0, event: 'snooze', hours: 4 },
    { at: D0 + H, event: 'phase', phase: 'WORK' },              // ended the snooze after 1h
    { at: D0 + 10 * H, event: 'nudge_off', hours: 2, indefinite: false },
    { at: D0 + 10.5 * H, event: 'phase', phase: 'WORK' },       // does not end it: 2h
  ])
  assert.equal(r.kpis.nudgeOffHours, 3)
})

test('bySite and byDay are safe from a site called __proto__', () => {
  const r = run([{ at: D0, event: 'nudge_shown', site: '__proto__' }])
  assert.equal(({}).shown, undefined, 'Object.prototype untouched')
  assert.equal(r.bySite['__proto__'].shown, 1)
})
