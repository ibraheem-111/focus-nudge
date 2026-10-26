// Read-only summaries of log.jsonl. Pure: the log text and the clock come in as
// arguments, so every number here is testable without touching the real log.

const DAY_MS = 24 * 60 * 60 * 1000

// One entry per parseable line. NULs are stripped first: an unclean shutdown on
// ext4 can leave a run of \0 bytes in front of the next appended line, and that
// line is real history.
export function parseLog(text) {
  const out = []
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\0/g, '').trim()
    if (!line) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) out.push(entry)
  }
  return out
}

// Local calendar day, not UTC: "blocks today" has to mean the user's today.
// Built from the local getters rather than a locale format so it cannot drift
// with locale settings.
export function localDay(at) {
  const d = new Date(at)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// `dayKey` and `now` are injectable so the day-bucketing can be tested without
// depending on the machine's timezone.
export function summariseLog(text, { dayKey = localDay, now = Date.now() } = {}) {
  const stats = {
    blocksCompleted: 0, nudgesContinued: 0, savedForLater: 0, queueDrained: 0,
    byDay: {}, today: 0, last7: 0,
  }
  const todayKey = dayKey(now)
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000

  for (const entry of parseLog(text)) {

    if (entry.event === 'block_completed') {
      stats.blocksCompleted++
      const key = Number.isFinite(entry.at) ? dayKey(entry.at) : 'unknown'
      stats.byDay[key] = (stats.byDay[key] ?? 0) + 1
      if (key === todayKey) stats.today++
      if (Number.isFinite(entry.at) && entry.at >= sevenDaysAgo) stats.last7++
    }
    else if (entry.event === 'continued') stats.nudgesContinued++
    else if (entry.event === 'saved_for_later') stats.savedForLater++
    else if (entry.event === 'queue_drained') stats.queueDrained++
  }
  return stats
}

// 'YYYY-MM-DD' -> the next calendar day's key. Pure string arithmetic in UTC,
// so it is the same calendar step whatever timezone produced the keys.
function nextDayKey(key) {
  const d = new Date(`${key}T00:00:00Z`)
  return new Date(d.getTime() + DAY_MS).toISOString().slice(0, 10)
}

function siteOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return null }
}

const emptyDay = () => ({ blocks: 0, focusMinutes: 0, continued: 0, nudgeOffs: 0, nudgeShown: 0, tasksDone: 0 })
const emptySite = () => ({ shown: 0, back: 0, continued: 0, saved: 0 })

function offLabel(e) {
  if (e.indefinite === true || e.hours === null) return 'until on'
  return Number.isFinite(e.hours) ? `${+e.hours.toFixed(2)}h` : 'other'
}

// Everything the insights page draws, from one pass over the log.
export function insights(text, {
  now = Date.now(),
  dayKey = localDay,
  hourOf = at => new Date(at).getHours(),
  dayOfWeek = at => new Date(at).getDay(),
  workMinutes = 25,
  // Start of the range the page is showing. byDay, the fixed-window block and
  // focus counts, and the streak always cover the whole log: they feed the
  // calendar and the headline numbers. Everything else follows the range.
  since = null,
} = {}) {
  // An entry with no usable timestamp cannot be placed on any chart, so it is
  // left out everywhere rather than counted in totals that would then disagree.
  const entries = parseLog(text).filter(e => Number.isFinite(e.at)).sort((a, b) => a.at - b.at)
  const todayKey = dayKey(now)
  const weekAgo = now - 7 * DAY_MS

  const kpis = {
    focusMinutes: { today: 0, last7: 0, all: 0 },
    blocks: { today: 0, last7: 0, all: 0 },
    streak: { current: 0, best: 0 },
    tasksDone: 0, tasksAdded: 0, continued: 0, nudgeOffHours: 0, nudgeOffs: 0,
  }
  const byDay = {}
  const byHour = Array.from({ length: 24 }, () => ({ blocks: 0, continued: 0, nudgeOffs: 0 }))
  const byWeekday = Array.from({ length: 7 }, () => ({ blocks: 0, continued: 0 }))
  const bySite = {}
  const blockOutcomes = { completed: 0, stopped: 0, nudgeOff: 0 }
  const nudgeOffDurations = {}
  const funnel = { shown: 0, back: 0, continued: 0, saved: 0 }
  let shownTrackedSince = null

  const day = at => (byDay[dayKey(at)] ??= emptyDay())
  const site = name => (bySite[name] ??= emptySite())

  // A nudge-off lasts until its hours run out or the next on/off event, whichever
  // comes first. An indefinite one with nothing after it is still running.
  const OFF_EVENTS = new Set(['snooze', 'nudge_off'])
  const END_EVENTS = new Set(['snooze', 'snooze_end', 'nudge_off', 'nudge_on'])
  let openWork = false

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const { at } = e
    const k = dayKey(at)
    const inRange = since === null || at >= since

    switch (e.event) {
      case 'block_completed': {
        const minutes = Number.isFinite(e.minutes) && e.minutes >= 0 ? e.minutes : workMinutes
        kpis.blocks.all++
        kpis.focusMinutes.all += minutes
        if (k === todayKey) { kpis.blocks.today++; kpis.focusMinutes.today += minutes }
        if (at >= weekAgo) { kpis.blocks.last7++; kpis.focusMinutes.last7 += minutes }
        day(at).blocks++
        day(at).focusMinutes += minutes
        if (inRange) {
          byHour[hourOf(at)].blocks++
          byWeekday[dayOfWeek(at)].blocks++
          if (openWork) blockOutcomes.completed++
        }
        openWork = false
        break
      }
      case 'phase':
        // A WORK block is classified by what ends it. One still running at the
        // end of the log is not counted at all.
        if (e.phase === 'WORK') openWork = true
        else if (e.phase === 'IDLE' && openWork) { if (inRange) blockOutcomes.stopped++; openWork = false }
        break
      case 'continued':
        day(at).continued++
        if (!inRange) break
        kpis.continued++
        funnel.continued++
        byHour[hourOf(at)].continued++
        byWeekday[dayOfWeek(at)].continued++
        if (e.site) site(e.site).continued++
        break
      case 'nudge_shown':
        shownTrackedSince ??= at
        day(at).nudgeShown++
        if (!inRange) break
        funnel.shown++
        if (e.site) site(e.site).shown++
        break
      case 'nudge_back':
        if (!inRange) break
        funnel.back++
        if (e.site) site(e.site).back++
        break
      case 'saved_for_later': {
        if (!inRange) break
        funnel.saved++
        const s = siteOf(e.url)
        if (s) site(s).saved++
        break
      }
      case 'task_added':
        if (inRange) kpis.tasksAdded++
        break
      case 'task_done':
        day(at).tasksDone++
        if (inRange) kpis.tasksDone++
        break
    }

    if (OFF_EVENTS.has(e.event)) {
      // The old daemon's snooze ended the running block; the new nudge_off does not.
      if (e.event === 'snooze' && openWork) { if (inRange) blockOutcomes.nudgeOff++; openWork = false }
      day(at).nudgeOffs++
      if (!inRange) continue
      kpis.nudgeOffs++
      byHour[hourOf(at)].nudgeOffs++
      const label = offLabel(e)
      nudgeOffDurations[label] = (nudgeOffDurations[label] ?? 0) + 1
      const timedEnd = label === 'until on' || !Number.isFinite(e.hours) ? Infinity : at + e.hours * 3_600_000
      const next = entries.slice(i + 1).find(n => END_EVENTS.has(n.event))
      const end = Math.min(timedEnd, next ? next.at : now)
      kpis.nudgeOffHours += Math.max(0, end - at) / 3_600_000
    }
  }

  // Streaks over days with at least one completed block. Today without a block
  // yet does not break the current streak: the day is not over.
  const blockDays = Object.keys(byDay).filter(key => byDay[key].blocks > 0).sort()
  let run = 0
  for (let i = 0; i < blockDays.length; i++) {
    run = i > 0 && nextDayKey(blockDays[i - 1]) === blockDays[i] ? run + 1 : 1
    kpis.streak.best = Math.max(kpis.streak.best, run)
  }
  const has = new Set(blockDays)
  let cursor = has.has(todayKey) ? todayKey : dayKey(now - DAY_MS)
  while (has.has(cursor)) {
    kpis.streak.current++
    cursor = prevDayKey(cursor)
  }

  kpis.nudgeOffHours = Math.round(kpis.nudgeOffHours * 10) / 10
  return {
    kpis, byDay, byHour, byWeekday, bySite, blockOutcomes, nudgeOffDurations, funnel,
    shownTrackedSince,
    since,
    firstAt: entries.length ? entries[0].at : null,
    lastAt: entries.length ? entries.at(-1).at : null,
  }
}

function prevDayKey(key) {
  const d = new Date(`${key}T00:00:00Z`)
  return new Date(d.getTime() - DAY_MS).toISOString().slice(0, 10)
}
