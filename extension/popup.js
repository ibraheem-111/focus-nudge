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
    el('clear-done').hidden = true
    el('site-error').hidden = true      // a stale error contradicts "no daemon"
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
  el('clear-done').hidden = !view.tasks.some(t => t.done)

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

// The dashboard is no longer the new tab page, so this is how you reach it.
// Opening our own extension page needs no permission beyond what we already have.
el('open-dashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') })
  window.close()
})
el('clear-done').addEventListener('click', async () => render(await act(task('clearDone'))))
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

function showSiteError(message) {
  el('site-error').textContent = message
  el('site-error').hidden = false
}

el('new-site').addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return
  // Clear stale feedback on every attempt, including an empty one — otherwise a
  // previous error stays on screen contradicting whatever happens next.
  el('site-error').hidden = true
  const domain = e.target.value.trim()
  if (!domain) return

  // Read the authoritative list BEFORE mutating. `latest` can still be null if
  // the first poll has not resolved yet, and a zero baseline would make a
  // rejected add look like a success.
  const baseline = await act(getState())
  if (!baseline) {
    showSiteError('the daemon is not running, so the site list cannot be changed')
    return
  }
  const countBefore = (baseline.sites ?? []).length

  // The daemon canonicalises entries and rejects anything without a dot — a bare
  // TLD like "com" would otherwise match every domain in it. A rejection returns
  // the state unchanged with a 200, indistinguishable from success unless we
  // compare. Without this the input would just clear and nothing would happen.
  const v = await act(site('add', domain))
  render(v)

  if (!v) {
    showSiteError('the daemon is not running, so the site list cannot be changed')
  } else if ((v.sites ?? []).length > countBefore) {
    e.target.value = ''
  } else {
    // Keep what they typed so it can be corrected rather than retyped.
    showSiteError(`"${domain}" was not added — check it is a full domain, or it may already be listed`)
  }
})

async function poll() {
  const v = await getState()
  render(isDown(v) ? null : v)
}

poll()
setInterval(poll, 1000)
