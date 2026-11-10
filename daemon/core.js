// Pure state machine. No I/O, no clock: `now` is always injected.

export const PHASE = {
  IDLE: 'IDLE',
  WORK: 'WORK',
  SHORT_BREAK: 'SHORT_BREAK',
  LONG_BREAK: 'LONG_BREAK',
}

// SNOOZED used to be a phase, which made "nudging off" and "a work block is
// running" mutually exclusive. Nudging is now its own switch (nudgeOffUntil /
// nudgeOffIndefinite). The string survives only so settle can migrate a
// state.json written by the old daemon.
export const LEGACY_SNOOZED = 'SNOOZED'

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
    nudgeOffUntil: null,
    nudgeOffIndefinite: false,
    // Linear issue ids the user removed here. Sync never brings these back.
    linearDismissed: [],
  }
}

// Nudging is ON unless the user switched it off. The timer plays no part.
export function nudgingOn(state, now) {
  if (state.nudgeOffIndefinite) return false
  return !(typeof state.nudgeOffUntil === 'number' && now < state.nudgeOffUntil)
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

// The phases PAUSE may touch. Deliberately narrower than "has an endsAt".
const PAUSABLE_PHASES = new Set([PHASE.WORK, PHASE.SHORT_BREAK])

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
        effects.push({ type: 'log', event: 'block_completed', data: { minutes: workedMinutes(state, now, config) } })
      } else {
        toPhase = PHASE.WORK
      }

      const next = { ...enter(state, toPhase, now, config), blocksCompleted: banked }

      effects.push({
        type: 'notify',
        title: LABEL[toPhase],
        body: `${minutes(phaseDurationMs(toPhase, config))} minutes.`,
      })
      effects.push({ type: 'log', event: 'phase', data: { phase: toPhase, from } })
      return { state: next, effects }
    }

    case 'PAUSE': {
      // Only work counts as pausable. Pausing a sanctioned window used to be
      // accepted — it has an endsAt, so the old `endsAt === null` guard let it
      // through — and it cleared endsAt, which every expiry branch in settle
      // requires. The window then never ended: nudging stayed off permanently,
      // across restarts, from one click of the popup's Pause button. A long
      // break or a snooze is a stretch of wall clock rather than work, so there
      // is nothing in it to pause anyway.
      if (!PAUSABLE_PHASES.has(state.phase)) return { state, effects }
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

    case 'SNOOZE':
    case 'NUDGE_OFF': {
      // Switches nudging off and nothing else. A running block keeps running and
      // the cycle count is kept: the timer and the nudge are independent.
      const indefinite = action.indefinite === true
      const hours = Number(action.hours)
      if (!indefinite && !(Number.isFinite(hours) && hours > 0)) return { state, effects }
      const next = {
        ...state,
        nudgeOffUntil: indefinite ? null : now + hours * 60 * MIN,
        nudgeOffIndefinite: indefinite,
      }
      effects.push({
        type: 'notify',
        title: 'Nudging off',
        body: indefinite
          ? 'Until you turn it back on. Your timer is unaffected.'
          : `Back on in ${hours} hour${hours === 1 ? '' : 's'}. Your timer is unaffected.`,
      })
      effects.push({
        type: 'log',
        event: 'nudge_off',
        data: { hours: indefinite ? null : hours, indefinite },
      })
      return { state: drainSavedLinks(next, effects), effects }
    }

    case 'NUDGE_ON': {
      if (nudgingOn(state, now)) return { state, effects }
      effects.push({ type: 'log', event: 'nudge_on', data: { reason: 'user' } })
      return { state: { ...state, nudgeOffUntil: null, nudgeOffIndefinite: false }, effects }
    }

    // The extension reports a nudge it showed and a nudge the user turned back
    // from. Only logged, for the insights page; nothing here decides anything.
    case 'NUDGE_EVENT': {
      const site = String(action.site || '').trim()
      if (!site || !NUDGE_OUTCOMES.has(action.outcome)) return { state, effects }
      effects.push({ type: 'log', event: `nudge_${action.outcome}`, data: { site } })
      return { state, effects }
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
      // A long break no longer opens watched sites or drains the saved links —
      // only switching nudging off does. See NUDGE_OFF.
      const next = enter(state, PHASE.LONG_BREAK, now, config)
      effects.push({
        type: 'notify',
        title: 'Long break',
        body: `${minutes(phaseDurationMs(PHASE.LONG_BREAK, config))} minutes.`,
      })
      effects.push({ type: 'log', event: 'phase', data: { phase: PHASE.LONG_BREAK, from: state.phase } })
      return { state: { ...next, blocksCompleted: 0 }, effects }
    }

    case 'TASK_ADD': {
      const text = String(action.text || '').trim()
      if (!text) return { state, effects }
      const p = action.project
      const project = p && typeof p.id === 'string' && p.id && typeof p.name === 'string'
        ? { id: p.id, name: p.name } : null
      const linearPending = Boolean(config.linearEnabled)
      // The issue id is chosen up front (server.js supplies a UUID) and kept, so
      // a retry after a lost reply reuses it and Linear cannot make a second issue.
      const linearId = linearPending && typeof action.linearId === 'string' && action.linearId ? action.linearId : null
      const id = state.nextTaskId
      effects.push({ type: 'log', event: 'task_added', data: { linear: linearPending } })
      if (linearPending) effects.push({ type: 'linearCreate', taskId: id, text, projectId: project?.id ?? null, issueId: linearId })
      return {
        state: {
          ...state,
          tasks: [...state.tasks, { id, text, done: false, project, linear: null, linearPending, linearId }],
          nextTaskId: id + 1,
        },
        effects,
      }
    }

    // server.js reports the issue linearCreate made. Ids restart once the list
    // empties, so the text must match too: a late answer never links a stranger.
    // An answer for a task that is gone leaves an orphan issue in Linear: it is
    // cancelled, as the removal would have done, and dismissed so sync skips it.
    case 'TASK_LINKED': {
      const link = cleanLink(action.linear)
      if (!link) return { state, effects }
      const match = t => t.id === action.taskId && t.linearPending && t.text === action.text
      if (!state.tasks.some(match)) {
        effects.push({ type: 'linearCancel', issueId: link.id })
        return { state: dismiss(state, [link.id]), effects }
      }
      return {
        state: { ...state, tasks: state.tasks.map(t => (match(t) ? { ...t, linear: link, linearPending: false } : t)) },
        effects,
      }
    }

    case 'TASK_TOGGLE': {
      const task = state.tasks.find(t => t.id === action.id)
      if (!task) return { state, effects }
      const done = !task.done
      if (done) effects.push({ type: 'log', event: 'task_done', data: { linear: Boolean(task.linear) } })
      if (task.linear) effects.push({ type: 'linearSetDone', issueId: task.linear.id, done })
      return {
        state: {
          ...state,
          tasks: state.tasks.map(t => (t.id === action.id ? { ...t, done } : t)),
        },
        effects,
      }
    }

    case 'TASK_REMOVE': {
      const gone = state.tasks.filter(t => t.id === action.id)
      if (gone.length === 0) return { state, effects }
      cancelOpenLinked(gone, effects)
      return { state: withTasks(dismissTasks(state, gone), state.tasks.filter(t => t.id !== action.id)), effects }
    }

    // Clearing never touches Linear: one command must not be able to cancel a
    // whole board (sync imports every active issue). The issues are dismissed,
    // so they stay out of this list; in Linear they are exactly as they were.
    case 'TASK_CLEAR':
      return { state: withTasks(dismissTasks(state, state.tasks), []), effects }

    case 'TASK_CLEAR_DONE': {
      const open = state.tasks.filter(t => !t.done)
      if (open.length === state.tasks.length) return { state, effects }
      effects.push({
        type: 'log',
        event: 'tasks_cleared_done',
        data: { count: state.tasks.length - open.length },
      })
      return { state: withTasks(dismissTasks(state, state.tasks.filter(t => t.done)), open), effects }
    }

    // The issues server.js fetched: every active issue in the team, plus the ones
    // already linked whatever their state. Linear is the source of truth for
    // where a ticket sits: it may close a task here, and a ticket parked in
    // Backlog leaves this list (and comes back when it is moved out again). It
    // may never reopen a task the user ticked, or bring back one the user removed.
    case 'LINEAR_SYNC': {
      if (!config.linearEnabled || !Array.isArray(action.issues)) return { state, effects }
      const issues = action.issues.map(cleanIssue).filter(Boolean)
      const dismissed = new Set(state.linearDismissed ?? [])
      const byId = new Map(issues.map(i => [i.id, i]))
      let completed = 0
      let changed = false
      const tasks = state.tasks.map(t => {
        const issue = t.linear && byId.get(t.linear.id)
        if (!issue) return t
        let next = t
        if (CLOSED_TYPES.has(issue.stateType) && !t.done) { next = { ...next, done: true }; completed++ }
        if (issue.title && issue.title !== t.text) next = { ...next, text: issue.title }
        if (next !== t) changed = true
        return next
      })
      const linked = new Set(tasks.filter(t => t.linear).map(t => t.linear.id))
      let nextTaskId = state.nextTaskId
      let added = 0
      for (const issue of issues) {
        if (linked.has(issue.id) || dismissed.has(issue.id)) continue
        // An issue this list already asked for, whose reply never arrived.
        const mine = tasks.findIndex(t => t.linearPending && t.linearId === issue.id)
        if (mine !== -1) {
          tasks[mine] = { ...tasks[mine], linear: { id: issue.id, identifier: issue.identifier, url: issue.url }, linearPending: false }
          linked.add(issue.id)
          changed = true
          continue
        }
        if (!ACTIVE_TYPES.has(issue.stateType)) continue
        linked.add(issue.id)
        tasks.push({
          id: nextTaskId++, text: issue.title || issue.identifier, done: false, project: null,
          linear: { id: issue.id, identifier: issue.identifier, url: issue.url }, linearPending: false,
        })
        added++
      }
      // Parked in Linear: off this list. Not dismissed, so un-parking brings it back.
      const kept = tasks.filter(t => !(t.linear && PARKED_TYPES.has(byId.get(t.linear.id)?.stateType)))
      const parked = tasks.length - kept.length
      if (!changed && added === 0 && parked === 0) return { state, effects }
      if (added || completed || parked) effects.push({ type: 'log', event: 'linear_sync', data: { added, completed, parked } })
      return { state: withTasks({ ...state, nextTaskId }, kept), effects }
    }

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

// The phases the OLD daemon nudged in. Kept because extension/policy.js still
// falls back to this rule against a daemon too old to report `nudging`, and a
// drift test keeps the two copies equal.
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
    linearEnabled: Boolean(config.linearEnabled),
    nudging: nudgingOn(state, now),
    // The OLD meaning, kept for an extension not reloaded yet: its service
    // worker still nudges on phase alone, and a pause screen told "off" released
    // straight back into it — a redirect loop. Consistent with itself, an old
    // extension simply nudges until it is reloaded.
    nudgingPhase: NUDGING_PHASES.has(state.phase),
    nudgeOffUntil: state.nudgeOffIndefinite ? null : state.nudgeOffUntil ?? null,
    nudgeOffIndefinite: Boolean(state.nudgeOffIndefinite),
    serverTime: now,
  }
}

// Switching nudging off drains the saved-links queue. That is all this does.
//
// It used to archive and clear the task list as well, on the reasoning that
// LONG_BREAK and SNOOZED are both "sanctioned windows" and should behave
// identically. That conflated two unrelated things: which sites open freely, and
// whether the user's work is finished. A break does not complete your tasks, and
// snoozing for a meeting certainly does not. Over two weeks of real use this
// silently destroyed 29 open tasks across 11 snoozes.
//
// Only the user decides when a task is done — `task done`, `task rm`,
// `task clear`, `task clear done`. Nothing here may delete their list.
function drainSavedLinks(state, effects) {
  if (state.queue.length === 0) return state
  effects.push({ type: 'openUrls', urls: state.queue.map(q => q.url) })
  effects.push({ type: 'log', event: 'queue_drained', data: { count: state.queue.length } })
  return { ...state, queue: [] }
}

// Ids only need to be unique among LIVE tasks. Once the list empties there is
// nothing left to confuse, and short ids are far friendlier to type than "done 47"
// after a long day. Every path that can empty the list goes through here.
function withTasks(state, tasks) {
  return { ...state, tasks, nextTaskId: tasks.length === 0 ? 1 : state.nextTaskId }
}

export const NUDGE_OUTCOMES = new Set(['shown', 'back'])

// How much of the block was actually worked: its length minus what was left,
// never more than its length (an overrun is not extra focus). One decimal.
function workedMinutes(state, now, config) {
  const length = phaseDurationMs(PHASE.WORK, config)
  const left = state.paused ? state.pausedRemainingMs ?? 0 : state.endsAt === null ? 0 : state.endsAt - now
  const worked = Math.min(length, Math.max(0, length - Math.max(0, left)))
  return Math.round(worked / MIN * 10) / 10
}

// Linear's closed state types. Duplicate is a team state of its own type here.
const CLOSED_TYPES = new Set(['completed', 'canceled', 'duplicate'])
// Not being worked on yet: the ticket belongs in the backlog, not this list.
const PARKED_TYPES = new Set(['backlog', 'triage'])
// The only states a ticket is pulled INTO this list from.
const ACTIVE_TYPES = new Set(['unstarted', 'started'])

function cleanLink(l) {
  if (!l || typeof l.id !== 'string' || !l.id) return null
  return { id: l.id, identifier: String(l.identifier ?? ''), url: String(l.url ?? '') }
}

function cleanIssue(i) {
  const link = cleanLink(i)
  if (!link) return null
  return { ...link, title: String(i.title ?? '').trim(), stateType: String(i.stateType ?? '') }
}

function dismiss(state, ids) {
  if (ids.length === 0) return state
  const prior = state.linearDismissed ?? []
  return { ...state, linearDismissed: [...prior, ...ids.filter(id => !prior.includes(id))] }
}

// Removing ONE task drops it in Linear too, so the two boards do not drift apart.
// Only OPEN tasks: a ticked task is already Done there, and clearing it from this
// list must not rewrite Done as Canceled. Dismissal still happens as well, so a
// cancel that never reaches Linear cannot bring the task back on the next sync.
function cancelOpenLinked(tasks, effects) {
  for (const t of tasks) {
    if (t.linear && !t.done) effects.push({ type: 'linearCancel', issueId: t.linear.id })
  }
}

function dismissTasks(state, tasks) {
  return dismiss(state, tasks.filter(t => t.linear).map(t => t.linear.id))
}

function normaliseSite(raw) {
  let s = String(raw || '').trim().toLowerCase()
  if (!s) return ''
  s = s.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0]
  s = s.split('@').pop().split(':')[0]          // drop any userinfo and port
  // Order matters. Collapsing and trimming the dots FIRST is what makes the
  // www. strip see a real leading label: doing www. first left ".www.reddit.com"
  // as "www.reddit.com", which matchSite never matches against a plain
  // reddit.com visit — fail-open, exactly like the leading-dot bug below.
  s = s.replace(/\.{2,}/g, '.').replace(/^\.+/, '').replace(/\.+$/, '').replace(/^www\./, '')
  // Canonicalising here is what keeps a stored entry matchable. The old
  // pattern accepted ".reddit.com", which matchSite could then never match —
  // silently unwatching the very site the user had just added.
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(s) ? s : ''
}

const EXPIRING_PHASES = new Set([PHASE.WORK, PHASE.SHORT_BREAK, PHASE.LONG_BREAK])

export function settle(state, now, config) {
  const effects = []
  let next = state

  // A state.json written by the old daemon can hold phase SNOOZED. Carry the
  // snooze over as a nudge-off until the same moment, silently: the user is
  // mid-snooze, nothing they did changed. A SNOOZED with no end can only be the
  // old PAUSE bug's trap, and the only safe reading of that is "over".
  if (next.phase === LEGACY_SNOOZED) {
    const until = typeof next.endsAt === 'number' && next.endsAt > now ? next.endsAt : null
    next = {
      ...next,
      phase: PHASE.IDLE,
      endsAt: null,
      paused: false,
      pausedRemainingMs: null,
      expiredNotified: false,
      nudgeOffUntil: until,
      nudgeOffIndefinite: false,
    }
    effects.push({ type: 'log', event: 'snooze_migrated', data: { until } })
  }

  // A long break with no end cannot be reached legitimately (BREAK_LONG always
  // sets a finite endsAt). It only exists in a state.json written by the old
  // PAUSE bug, which made every expiry branch below unreachable. Treat it as over.
  if (next.phase === PHASE.LONG_BREAK && next.endsAt === null) {
    next = { ...enter(next, PHASE.IDLE, now, config), blocksCompleted: 0 }
    effects.push({ type: 'notify', title: 'Long break cleared', body: 'Recovered an interrupted break.' })
    effects.push({ type: 'log', event: 'sanctioned_window_recovered', data: { from: state.phase } })
  }

  if (!next.nudgeOffIndefinite && typeof next.nudgeOffUntil === 'number' && now >= next.nudgeOffUntil) {
    next = { ...next, nudgeOffUntil: null }
    effects.push({ type: 'notify', title: 'Nudging back on', body: 'Your nudge-off time is up.' })
    effects.push({ type: 'log', event: 'nudge_on', data: { reason: 'expired' } })
  }

  if (
    EXPIRING_PHASES.has(next.phase) &&
    next.endsAt !== null &&
    now >= next.endsAt &&
    !next.expiredNotified
  ) {
    next = { ...next, expiredNotified: true }
    // Sound means "your attention is needed", not "something happened": this is
    // the one notify effect that fires from a timer, unprompted, when the user is
    // very likely looking away — every other notify in this file is the direct
    // result of a button they just clicked, and stays silent. `...(cond ? {sound} : {})`
    // is deliberate: the key must be ABSENT when sounds are disabled, not merely
    // undefined-valued, so a caller checking `'sound' in effect` sees the real answer.
    const sounds = config.sounds
    effects.push({
      type: 'notify',
      title: `${LABEL[next.phase]} finished`,
      body: next.phase === PHASE.WORK ? 'Take your break.' : 'Ready when you are.',
      ...(sounds && sounds.enabled
        ? { sound: next.phase === PHASE.WORK ? sounds.workEnd : sounds.breakEnd }
        : {}),
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
