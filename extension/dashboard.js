import { getState, getStats, timer, task, queueDrain, nudgingOff, nudgingOn, isDown, getLinear } from './api.js'
import { clockLine, renderTasks, PHASE_LABEL, nudgingLine, fillProjects, chosenProject } from './ui.js'

const el = id => document.getElementById(id)
const input = el('new-task')

let latest = null

function render(view, down) {
  el('down').hidden = !down
  if (down || !view) {
    el('phase').textContent = 'no daemon'
    el('clock').textContent = ''
    el('cycle').textContent = ''
    el('today').textContent = ''
    // Matched to the popup's daemon-down branch, which was reviewed more
    // recently. The two surfaces show the same daemon and used to disagree about
    // it: this one left the Pause/Resume label at whatever the last live poll
    // said, so the dashboard could read "Resume" while the popup read "Pause",
    // and it hid the queue line while the popup showed "unknown".
    el('pause').textContent = 'Pause'   // a stale "Resume" means nothing when down
    renderTasks(el('tasks'), [])
    el('clear-done').hidden = true
    el('queue-line').hidden = false
    el('queue-line').textContent = 'unknown'
    el('drain').hidden = true
    el('nudging-line').textContent = nudgingLine(null)
    el('nudging-off-controls').hidden = false
    el('nudging-on-controls').hidden = true
    return
  }
  latest = view

  el('nudging-line').textContent = nudgingLine(view)
  el('nudging-line').classList.toggle('off', view.nudging === false)
  el('nudging-off-controls').hidden = view.nudging === false
  el('nudging-on-controls').hidden = view.nudging !== false

  el('phase').textContent = PHASE_LABEL[view.phase] ?? view.phase
  el('clock').textContent = clockLine(view)
  el('clock').classList.toggle('overrun', Boolean(view.overrun))

  el('cycle').textContent =
    view.phase === 'WORK' || view.phase === 'SHORT_BREAK'
      ? `block ${view.blocksCompleted + (view.phase === 'WORK' ? 1 : 0)} of ${view.blocksPerCycle} before a long break`
      : ''

  renderTasks(el('tasks'), view.tasks, {
    onToggle: async id => render(await refreshWith(task('toggle', { id })), false),
    onRemove: async id => render(await refreshWith(task('remove', { id })), false),
  })

  el('pause').textContent = view.paused ? 'Resume' : 'Pause'
  el('clear-done').hidden = !view.tasks.some(t => t.done)

  // Always shown, as in the popup: "nothing saved" is information, and a line
  // that appears and vanishes is how the two surfaces came to disagree.
  const depth = view.queueDepth
  el('queue-line').hidden = false
  el('queue-line').textContent = depth
    ? `${depth} link${depth === 1 ? '' : 's'} saved — they open when you switch nudging off`
    : 'nothing saved'
  el('drain').hidden = depth === 0
}

async function refreshWith(promise) {
  const v = await promise
  return isDown(v) ? null : v
}

async function poll() {
  const v = await getState()
  render(isDown(v) ? null : v, isDown(v))
}

input.addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  render(await refreshWith(task('add', { text, project: chosenProject(el('new-task-project'), linearProjects) })), false)
})

// The Linear project picker, refreshed every ten minutes like the daemon's cache.
let linearProjects = []
async function loadProjects() {
  const linear = await getLinear()
  linearProjects = linear?.projects ?? []
  fillProjects(el('new-task-project'), linear)
}
loadProjects()
setInterval(loadProjects, 10 * 60_000)

el('clear-done').addEventListener('click', async () => {
  render(await refreshWith(task('clearDone')), false)
})
el('start').addEventListener('click', async () => {
  render(await refreshWith(timer('start')), false)
})
el('skip').addEventListener('click', async () => {
  render(await refreshWith(timer('skip')), false)
})
el('pause').addEventListener('click', async () => {
  render(await refreshWith(timer(latest?.paused ? 'start' : 'pause')), false)
})
el('stop').addEventListener('click', async () => {
  render(await refreshWith(timer('stop')), false)
})
// The daemon opens the saved links itself: server.js spawns xdg-open when
// core.js emits the openUrls effect, and that path is also what makes
// `focus break` work from the terminal. This click only asks for the phase
// change; nothing here opens tabs.
el('break').addEventListener('click', async () => {
  render(await refreshWith(timer('breakLong')), false)
})
el('drain').addEventListener('click', async () => {
  render(await refreshWith(queueDrain()), false)
})
// An empty data-hours is "until I turn it back on".
for (const button of document.querySelectorAll('[data-hours]')) {
  button.addEventListener('click', async () => {
    const hours = button.dataset.hours === '' ? null : Number(button.dataset.hours)
    render(await refreshWith(nudgingOff(hours)), false)
  })
}
el('nudging-on').addEventListener('click', async () => {
  render(await refreshWith(nudgingOn()), false)
})

// Today's block count comes from /stats, which reads the log. Polled every 30s
// rather than every second so a growing log is never read on the hot path.
async function pollStats() {
  const s = await getStats()
  if (isDown(s)) return
  const n = s.totals.today
  el('today').textContent = `${n} block${n === 1 ? '' : 's'} completed today`
}

poll()
setInterval(poll, 1000)
pollStats()
setInterval(pollStats, 30_000)
input.focus()
