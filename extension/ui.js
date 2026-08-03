export const PHASE_LABEL = {
  IDLE: 'idle',
  WORK: 'work block',
  SHORT_BREAK: 'short break',
  LONG_BREAK: 'long break',
  SNOOZED: 'snoozed',
}

export function formatDuration(ms) {
  const total = Math.floor(Math.abs(ms) / 1000)
  const m = Math.floor(total / 60)
  const s = String(total % 60).padStart(2, '0')
  return `${ms < 0 ? '-' : ''}${m}:${s}`
}

export function clockLine(v) {
  if (!v || v.remainingMs === null || v.remainingMs === undefined) return 'no block running'
  if (v.paused) return `${formatDuration(v.remainingMs)} left — paused`
  if (v.overrun) return `ran over by ${formatDuration(-v.remainingMs)}`
  const noun = v.phase === 'WORK' ? 'in this block' : 'of your break'
  return `${formatDuration(v.remainingMs)} left ${noun}`
}

// The pause screen's countdown lives here so it can be tested without a DOM.
// `schedule` is injectable, which makes the whole thing deterministic in tests.
//
// Two properties matter and both are load-bearing:
//   - it starts immediately, never gated on a network call, so the visible
//     countdown begins at page load rather than after a daemon round trip
//   - onDone always fires. A countdown that never completes would leave the
//     escape hatch disabled forever, which is the one outcome the design forbids.
export function countdown({ seconds = 10, onTick, onDone, schedule = setTimeout }) {
  let left = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  let finished = false

  const step = () => {
    if (finished) return
    if (left > 0) {
      onTick?.(left)
      left -= 1
      schedule(step, 1000)
    } else {
      finished = true
      onDone?.()
    }
  }
  step()

  return {
    // Lets a late-arriving countdownSeconds from the daemon adjust a countdown
    // that is already running, without restarting or delaying it.
    setSeconds(s) {
      if (finished) return
      if (Number.isFinite(s) && s >= 0) left = Math.floor(s)
    },
    get finished() { return finished },
  }
}

export function renderTasks(el, tasks, { onToggle, onRemove } = {}) {
  el.replaceChildren()
  if (!tasks || tasks.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = 'no micro-tasks yet'
    el.append(empty)
    return
  }
  for (const t of tasks) {
    const row = document.createElement('label')
    row.className = 'task' + (t.done ? ' done' : '')

    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = t.done
    if (onToggle) box.addEventListener('change', () => onToggle(t.id))

    const text = document.createElement('span')
    text.textContent = t.text

    row.append(box, text)

    if (onRemove) {
      const x = document.createElement('button')
      x.className = 'task-remove'
      x.type = 'button'
      x.textContent = '×'
      x.title = 'remove'
      x.addEventListener('click', e => { e.preventDefault(); onRemove(t.id) })
      row.append(x)
    }
    el.append(row)
  }
}
