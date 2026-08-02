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

// Placeholder until Task 5 gives the long break its queue-and-archive behaviour.
function openLongBreak(state, _effects) {
  return state
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
