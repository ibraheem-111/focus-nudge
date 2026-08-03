import { getState, timer, snooze, task, site, queueDrain, isDown } from './api.js'
import { clockLine, renderTasks, PHASE_LABEL } from './ui.js'

const el = id => document.getElementById(id)
let latest = null

function renderSites(sites) {
  const box = el('sites')
  box.replaceChildren()
  for (const s of sites ?? []) {
    const row = document.createElement('div')
    row.className = 'site-row'
    const name = document.createElement('span')
    name.textContent = s
    const remove = document.createElement('button')
    remove.className = 'small'
    remove.type = 'button'
    remove.textContent = 'remove'
    remove.addEventListener('click', async () => render(await act(site('remove', s))))
    row.append(name, remove)
    box.append(row)
  }
}

function render(view) {
  const down = view === null
  el('down').hidden = !down

  if (down) {
    el('phase').textContent = 'no daemon'
    el('clock').textContent = ''
    el('pause').textContent = 'Pause'   // a stale "Resume" means nothing when down
    renderTasks(el('tasks'), [])
    el('queue-line').textContent = 'unknown'
    el('drain').hidden = true
    renderSites([])
    return
  }
  latest = view

  el('phase').textContent = PHASE_LABEL[view.phase] ?? view.phase
  el('clock').textContent = clockLine(view)
  el('clock').classList.toggle('overrun', Boolean(view.overrun))
  el('pause').textContent = view.paused ? 'Resume' : 'Pause'

  renderTasks(el('tasks'), view.tasks, {
    onToggle: async id => render(await act(task('toggle', { id }))),
    onRemove: async id => render(await act(task('remove', { id }))),
  })

  el('queue-line').textContent = view.queueDepth
    ? `${view.queueDepth} link${view.queueDepth === 1 ? '' : 's'} waiting`
    : 'nothing saved'
  el('drain').hidden = view.queueDepth === 0

  renderSites(view.sites)
}

async function act(promise) {
  const v = await promise
  return isDown(v) ? null : v
}

el('start').addEventListener('click', async () => render(await act(timer('start'))))
el('skip').addEventListener('click', async () => render(await act(timer('skip'))))
el('pause').addEventListener('click', async () =>
  render(await act(timer(latest?.paused ? 'start' : 'pause'))))
// The daemon opens the saved links itself: server.js spawns xdg-open when
// core.js emits the openUrls effect, and that path is also what makes
// `focus break` work from the terminal. Sending them to the service worker here
// as well would open every link twice.
el('break').addEventListener('click', async () => {
  render(await act(timer('breakLong')))
})
el('drain').addEventListener('click', async () => {
  render(await act(queueDrain()))
})

for (const button of document.querySelectorAll('[data-hours]')) {
  button.addEventListener('click', async () =>
    render(await act(snooze(Number(button.dataset.hours)))))
}

el('new-task').addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return
  const text = e.target.value.trim()
  if (!text) return
  e.target.value = ''
  render(await act(task('add', { text })))
})

el('new-site').addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return
  const domain = e.target.value.trim()
  if (!domain) return

  // The daemon canonicalises entries and rejects anything without a dot — a bare
  // TLD like "com" would otherwise match every domain in it. A rejection returns
  // the state unchanged, which is indistinguishable from success unless we look.
  // Without this the input would just clear and nothing would happen.
  const countBefore = (latest?.sites ?? []).length
  const v = await act(site('add', domain))
  render(v)

  const added = v && (v.sites ?? []).length > countBefore
  if (added) {
    e.target.value = ''
    el('site-error').hidden = true
  } else {
    // Keep what they typed so it can be corrected rather than retyped.
    el('site-error').textContent = v
      ? `"${domain}" was not added — check it is a full domain, or it may already be listed`
      : 'the daemon is not running, so the site list cannot be changed'
    el('site-error').hidden = false
  }
})

async function poll() {
  const v = await getState()
  render(isDown(v) ? null : v)
}

poll()
setInterval(poll, 1000)
