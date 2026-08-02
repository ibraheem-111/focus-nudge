// Pure state machine. No I/O, no clock: `now` is always injected.

export const PHASE = {
  IDLE: 'IDLE',
  WORK: 'WORK',
  SHORT_BREAK: 'SHORT_BREAK',
  LONG_BREAK: 'LONG_BREAK',
  SNOOZED: 'SNOOZED',
}

const MIN = 60_000

export function initialState() {
  return {
    phase: PHASE.IDLE,
    endsAt: null,
    paused: false,
    pausedRemainingMs: null,
    expiredNotified: false,
    blocksCompleted: 0,
    tasks: [],
    nextTaskId: 1,
    queue: [],
    graces: {},
  }
}

export function phaseDurationMs(phase, config) {
  switch (phase) {
    case PHASE.WORK: return config.workMinutes * MIN
    case PHASE.SHORT_BREAK: return config.shortBreakMinutes * MIN
    case PHASE.LONG_BREAK: return config.longBreakMinutes * MIN
    default: return null
  }
}

const LABEL = {
  [PHASE.WORK]: 'Work block',
  [PHASE.SHORT_BREAK]: 'Short break',
  [PHASE.LONG_BREAK]: 'Long break',
  [PHASE.SNOOZED]: 'Snoozed',
  [PHASE.IDLE]: 'Idle',
}

function enter(state, phase, now, config) {
  const duration = phaseDurationMs(phase, config)
  return {
    ...state,
    phase,
    endsAt: duration === null ? null : now + duration,
    paused: false,
    pausedRemainingMs: null,
    expiredNotified: false,
  }
}

function minutes(ms) {
  return Math.round(ms / MIN)
}

export function reduce(state, action, now, config) {
  const effects = []

  switch (action.type) {
    case 'START': {
      if (state.paused && state.pausedRemainingMs !== null) {
        effects.push({ type: 'log', event: 'resume', data: { phase: state.phase } })
        return {
          state: {
            ...state,
            paused: false,
            pausedRemainingMs: null,
            endsAt: now + state.pausedRemainingMs,
            expiredNotified: false,
          },
          effects,
        }
      }
      const next = enter(state, PHASE.WORK, now, config)
      effects.push({
        type: 'notify',
        title: 'Work block started',
        body: `${minutes(phaseDurationMs(PHASE.WORK, config))} minutes. ${openCount(next)} open tasks.`,
      })
      effects.push({ type: 'log', event: 'phase', data: { phase: PHASE.WORK } })
      return { state: next, effects }
    }

    case 'ADVANCE': {
      const from = state.phase
      let toPhase
      let banked = state.blocksCompleted

      if (from === PHASE.WORK) {
        banked = state.blocksCompleted + 1
        if (banked >= config.blocksPerCycle) {
          toPhase = PHASE.LONG_BREAK
          banked = 0
        } else {
          toPhase = PHASE.SHORT_BREAK
        }
        effects.push({ type: 'log', event: 'block_completed', data: {} })
      } else {
        toPhase = PHASE.WORK
      }

      let next = { ...enter(state, toPhase, now, config), blocksCompleted: banked }
      if (toPhase === PHASE.LONG_BREAK) next = openLongBreak(next, effects)

      effects.push({
        type: 'notify',
        title: LABEL[toPhase],
        body: `${minutes(phaseDurationMs(toPhase, config))} minutes.`,
      })
      effects.push({ type: 'log', event: 'phase', data: { phase: toPhase, from } })
      return { state: next, effects }
    }

    case 'PAUSE': {
      if (state.endsAt === null || state.paused) return { state, effects }
      effects.push({ type: 'log', event: 'pause', data: { phase: state.phase } })
      return {
        state: {
          ...state,
          paused: true,
          pausedRemainingMs: Math.max(0, state.endsAt - now),
          endsAt: null,
        },
        effects,
      }
    }

    case 'SNOOZE': {
      const hours = Number(action.hours)
      if (!Number.isFinite(hours) || hours <= 0) return { state, effects }
      const next = {
        ...state,
        phase: PHASE.SNOOZED,
        endsAt: now + hours * 60 * MIN,
        paused: false,
        pausedRemainingMs: null,
        expiredNotified: false,
        // A snooze is a sanctioned window, exactly like a long break, so it
        // ends the cycle the same way BREAK_LONG does. Resetting on entry
        // rather than on expiry matters: otherwise the dashboard shows
        // "block 2 of 4" for the whole snooze and then silently zeroes it.
        blocksCompleted: 0,
      }
      effects.push({
        type: 'notify',
        title: 'Nudging off',
        body: `Back on in ${hours} hour${hours === 1 ? '' : 's'}.`,
      })
      effects.push({ type: 'log', event: 'snooze', data: { hours } })
      return { state: openLongBreak(next, effects), effects }
    }

    case 'GRACE': {
      const site = String(action.site || '').trim()
      if (!site) return { state, effects }
      effects.push({ type: 'log', event: 'continued', data: { site } })
      return {
        state: { ...state, graces: { ...state.graces, [site]: now + config.graceMinutes * MIN } },
        effects,
      }
    }

    case 'BREAK_LONG': {
      const next = openLongBreak(enter(state, PHASE.LONG_BREAK, now, config), effects)
      effects.push({
        type: 'notify',
        title: 'Long break',
        body: `${minutes(phaseDurationMs(PHASE.LONG_BREAK, config))} minutes. Sites are open.`,
      })
      effects.push({ type: 'log', event: 'phase', data: { phase: PHASE.LONG_BREAK, from: state.phase } })
      return { state: { ...next, blocksCompleted: 0 }, effects }
    }

    case 'TASK_ADD': {
      const text = String(action.text || '').trim()
      if (!text) return { state, effects }
      return {
        state: {
          ...state,
          tasks: [...state.tasks, { id: state.nextTaskId, text, done: false }],
          nextTaskId: state.nextTaskId + 1,
        },
        effects,
      }
    }

    case 'TASK_TOGGLE': {
      if (!state.tasks.some(t => t.id === action.id)) return { state, effects }
      return {
        state: {
          ...state,
          tasks: state.tasks.map(t => (t.id === action.id ? { ...t, done: !t.done } : t)),
        },
        effects,
      }
    }

    case 'TASK_REMOVE': {
      if (!state.tasks.some(t => t.id === action.id)) return { state, effects }
      return { state: { ...state, tasks: state.tasks.filter(t => t.id !== action.id) }, effects }
    }

    case 'TASK_CLEAR':
      return { state: { ...state, tasks: [] }, effects }

    case 'QUEUE_ADD': {
      const url = String(action.url || '').trim()
      if (!url || state.queue.some(q => q.url === url)) return { state, effects }
      effects.push({ type: 'log', event: 'saved_for_later', data: { url } })
      return {
        state: {
          ...state,
          queue: [...state.queue, { url, title: String(action.title || '').trim(), savedAt: now }],
        },
        effects,
      }
    }

    case 'QUEUE_DRAIN': {
      if (state.queue.length === 0) return { state, effects }
      effects.push({ type: 'openUrls', urls: state.queue.map(q => q.url) })
      effects.push({ type: 'log', event: 'queue_drained', data: { count: state.queue.length } })
      return { state: { ...state, queue: [] }, effects }
    }

    case 'SITE_ADD': {
      const site = normaliseSite(action.site)
      if (!site) return { state, effects }
      const sites = config.sites.includes(site) ? [...config.sites] : [...config.sites, site]
      effects.push({ type: 'setSites', sites })
      return { state, effects }
    }

    case 'SITE_REMOVE': {
      const site = normaliseSite(action.site)
      if (!site) return { state, effects }
      effects.push({ type: 'setSites', sites: config.sites.filter(s => s !== site) })
      return { state, effects }
    }

    case 'STOP': {
      effects.push({ type: 'log', event: 'phase', data: { phase: PHASE.IDLE, from: state.phase } })
      return {
        state: { ...enter(state, PHASE.IDLE, now, config), blocksCompleted: 0 },
        effects,
      }
    }

    default:
      return { state, effects }
  }
}

export function openCount(state) {
  return state.tasks.filter(t => !t.done).length
}

export const NUDGING_PHASES = new Set([PHASE.IDLE, PHASE.WORK, PHASE.SHORT_BREAK])

export function view(state, now, config) {
  let remainingMs = null
  if (state.paused && state.pausedRemainingMs !== null) remainingMs = state.pausedRemainingMs
  else if (state.endsAt !== null) remainingMs = state.endsAt - now

  return {
    phase: state.phase,
    endsAt: state.endsAt,
    remainingMs,
    overrun: remainingMs !== null && !state.paused && remainingMs < 0,
    paused: state.paused,
    blocksCompleted: state.blocksCompleted,
    blocksPerCycle: config.blocksPerCycle,
    tasks: state.tasks,
    openTaskCount: openCount(state),
    queue: state.queue,
    queueDepth: state.queue.length,
    sites: config.sites,
    graces: state.graces,
    countdownSeconds: config.countdownSeconds,
    graceMinutes: config.graceMinutes,
    nudgingPhase: NUDGING_PHASES.has(state.phase),
    serverTime: now,
  }
}

// Entering a sanctioned window (long break or snooze) archives the task list
// and drains the saved-links queue.
function openLongBreak(state, effects) {
  let next = state

  if (next.tasks.length > 0) {
    effects.push({
      type: 'log',
      event: 'tasks_archived',
      data: {
        tasks: next.tasks,
        open: next.tasks.filter(t => !t.done).length,
        done: next.tasks.filter(t => t.done).length,
      },
    })
    next = { ...next, tasks: [] }
  }

  if (next.queue.length > 0) {
    effects.push({ type: 'openUrls', urls: next.queue.map(q => q.url) })
    effects.push({ type: 'log', event: 'queue_drained', data: { count: next.queue.length } })
    next = { ...next, queue: [] }
  }

  return next
}

function normaliseSite(raw) {
  let s = String(raw || '').trim().toLowerCase()
  if (!s) return ''
  s = s.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0]
  s = s.split('@').pop().split(':')[0]          // drop any userinfo and port
  s = s.replace(/^www\./, '').replace(/^\.+/, '').replace(/\.+$/, '')
  // Canonicalising here is what keeps a stored entry matchable. The old
  // pattern accepted ".reddit.com", which matchSite could then never match —
  // silently unwatching the very site the user had just added.
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(s) ? s : ''
}

const EXPIRING_PHASES = new Set([PHASE.WORK, PHASE.SHORT_BREAK, PHASE.LONG_BREAK])

export function settle(state, now, config) {
  const effects = []
  let next = state

  if (next.phase === PHASE.SNOOZED && next.endsAt !== null && now >= next.endsAt) {
    next = { ...initialState(), tasks: next.tasks, nextTaskId: next.nextTaskId, queue: next.queue, graces: next.graces }
    effects.push({ type: 'notify', title: 'Nudging back on', body: 'Snooze finished.' })
    effects.push({ type: 'log', event: 'snooze_end', data: {} })
  }

  if (
    EXPIRING_PHASES.has(next.phase) &&
    next.endsAt !== null &&
    now >= next.endsAt &&
    !next.expiredNotified
  ) {
    next = { ...next, expiredNotified: true }
    effects.push({
      type: 'notify',
      title: `${LABEL[next.phase]} finished`,
      body: next.phase === PHASE.WORK ? 'Take your break.' : 'Ready when you are.',
    })
  }

  const live = {}
  for (const [site, until] of Object.entries(next.graces)) {
    if (until > now) live[site] = until
  }
  if (Object.keys(live).length !== Object.keys(next.graces).length) {
    next = { ...next, graces: live }
  }

  return { state: next, effects }
}
