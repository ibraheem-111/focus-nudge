import { getState, timer, task, queueDrain, isDown } from './api.js'
import { clockLine, renderTasks, PHASE_LABEL } from './ui.js'

const el = id => document.getElementById(id)
const input = el('new-task')

let latest = null

function render(view, down) {
  el('down').hidden = !down
  if (down || !view) {
    el('phase').textContent = 'no daemon'
    el('clock').textContent = ''
    el('cycle').textContent = ''
    renderTasks(el('tasks'), [])
    el('queue-line').hidden = true
    el('drain').hidden = true
    return
  }
  latest = view

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

  const depth = view.queueDepth
  el('queue-line').hidden = depth === 0
  el('drain').hidden = depth === 0
  if (depth > 0) {
    el('queue-line').textContent =
      `${depth} link${depth === 1 ? '' : 's'} saved for your next long break`
  }
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
  render(await refreshWith(task('add', { text })), false)
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
el('break').addEventListener('click', async () => {
  const urls = (latest?.queue ?? []).map(q => q.url)
  render(await refreshWith(timer('breakLong')), false)
  if (urls.length) chrome.runtime.sendMessage({ type: 'openUrls', urls }, () => {})
})
el('drain').addEventListener('click', async () => {
  const urls = (latest?.queue ?? []).map(q => q.url)
  render(await refreshWith(queueDrain()), false)
  if (urls.length) chrome.runtime.sendMessage({ type: 'openUrls', urls }, () => {})
})

poll()
setInterval(poll, 1000)
input.focus()
