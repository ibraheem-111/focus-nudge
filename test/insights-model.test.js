import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dayKey, dayKeysBack, sumDays, calendarWeeks, heatLevel, pct, weekly } from '../extension/insights-model.js'

// Local-calendar helpers: built from local dates, so they agree with the
// daemon's localDay on whatever machine runs them.
const at = (y, m, d) => new Date(y, m - 1, d, 12)

test('dayKey formats a local date', () => {
  assert.equal(dayKey(at(2026, 3, 7)), '2026-03-07')
})

test('dayKeysBack lists n days ending today, oldest first, across a month end', () => {
  assert.deepEqual(dayKeysBack(at(2026, 11, 2), 4), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
})

test('sumDays totals the chosen days and treats missing days as zero', () => {
  const byDay = {
    '2026-10-01': { blocks: 2, focusMinutes: 50, continued: 1, nudgeOffs: 0, nudgeShown: 3, tasksDone: 1 },
    '2026-10-03': { blocks: 1, focusMinutes: 25, continued: 4, nudgeOffs: 2, nudgeShown: 5, tasksDone: 0 },
  }
  assert.deepEqual(sumDays(byDay, ['2026-10-01', '2026-10-02', '2026-10-03']),
    { blocks: 3, focusMinutes: 75, continued: 5, nudgeOffs: 2, nudgeShown: 8, tasksDone: 1 })
})

test('calendarWeeks gives whole Sunday-first weeks, today in the last, future days null', () => {
  const weeks = calendarWeeks(at(2026, 10, 28), 3)          // a Wednesday
  assert.equal(weeks.length, 3)
  assert.ok(weeks.every(w => w.length === 7))
  assert.deepEqual(weeks[2], ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', null, null, null])
  assert.equal(weeks[0][0], '2026-10-11')
})

test('heatLevel buckets into 0..4 with 0 only for none', () => {
  assert.equal(heatLevel(0, 8), 0)
  assert.equal(heatLevel(1, 8), 1)
  assert.equal(heatLevel(8, 8), 4)
  assert.equal(heatLevel(5, 0), 0)
  assert.equal(heatLevel(3, 3), 4)
})

test('pct rounds and never divides by zero', () => {
  assert.equal(pct(1, 3), 33)
  assert.equal(pct(0, 0), null)
})

test('weekly folds days into Sunday-first weeks for the long ranges', () => {
  const keys = dayKeysBack(at(2026, 10, 28), 10)            // Mon 10-19 .. Wed 10-28
  const byDay = { '2026-10-19': { blocks: 2, continued: 1 }, '2026-10-27': { blocks: 1, continued: 0 } }
  assert.deepEqual(weekly(byDay, keys).map(x => [x.start, x.days, x.blocks, x.continued]),
    [['2026-10-19', 6, 2, 1], ['2026-10-25', 4, 1, 0]], 'a partial first week starts at the first day shown')
})
