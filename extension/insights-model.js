// Pure helpers for insights.js: calendar arithmetic and range totals. No DOM,
// so node --test covers them. Day keys are LOCAL calendar dates, matching the
// daemon's localDay, which is what /insights buckets byDay with.

const pad = n => String(n).padStart(2, '0')

export function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// Calendar steps via setDate, never by adding 24h: a DST change makes a day 23
// or 25 hours long and millisecond arithmetic would skip or repeat a date.
function shift(date, days) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12)
  d.setDate(d.getDate() + days)
  return d
}

export function dayKeysBack(today, n) {
  return Array.from({ length: n }, (_, i) => dayKey(shift(today, i - n + 1)))
}

const FIELDS = ['blocks', 'focusMinutes', 'continued', 'nudgeOffs', 'nudgeShown', 'tasksDone']

export function sumDays(byDay, keys) {
  const out = Object.fromEntries(FIELDS.map(f => [f, 0]))
  for (const k of keys) for (const f of FIELDS) out[f] += byDay?.[k]?.[f] ?? 0
  return out
}

// `weeks` whole Sunday-first weeks ending with the one containing today. Days
// after today are null so the grid keeps its shape without inventing data.
export function calendarWeeks(today, weeks) {
  const lastSunday = shift(today, -today.getDay())
  const todayKey = dayKey(today)
  const out = []
  for (let w = weeks - 1; w >= 0; w--) {
    const week = []
    for (let d = 0; d < 7; d++) {
      const date = shift(lastSunday, d - 7 * w)
      week.push(date > today && dayKey(date) !== todayKey ? null : dayKey(date))
    }
    out.push(week)
  }
  return out
}

// 0 means none at all; 1..4 split the rest evenly up to the busiest day.
export function heatLevel(value, max) {
  if (!(value > 0) || !(max > 0)) return 0
  return Math.max(1, Math.min(4, Math.ceil((value / max) * 4)))
}

export function pct(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 100) : null
}

// Folds consecutive day keys into Sunday-first weeks. A week cut off by the
// start of the range begins at its first day shown.
export function weekly(byDay, keys) {
  const out = []
  for (const k of keys) {
    const sunday = new Date(`${k}T12:00:00`).getDay() === 0
    if (!out.length || sunday) out.push({ start: k, days: 0, blocks: 0, continued: 0, focusMinutes: 0, nudgeOffs: 0 })
    const w = out.at(-1)
    w.days++
    for (const f of ['blocks', 'continued', 'focusMinutes', 'nudgeOffs']) w[f] += byDay?.[k]?.[f] ?? 0
  }
  return out
}
