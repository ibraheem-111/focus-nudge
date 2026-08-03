import { BUNDLED_QUOTES, pickQuote } from './quotes.js'
import { getState, getQuotes, grace, queueAdd, isDown } from './api.js'
import { clockLine, renderTasks, PHASE_LABEL } from './ui.js'

const params = new URLSearchParams(location.search)
const targetUrl = params.get('url') ?? ''
const targetHost = safeHost(targetUrl)

const el = {
  quote: document.getElementById('quote'),
  author: document.getElementById('author'),
  phase: document.getElementById('phase'),
  clock: document.getElementById('clock'),
  tasks: document.getElementById('tasks'),
  target: document.getElementById('target'),
  back: document.getElementById('back'),
  save: document.getElementById('save'),
  continue: document.getElementById('continue'),
  down: document.getElementById('down'),
}

let released = false
let matchedSite = targetHost

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

el.target.textContent = targetHost ? `you are heading to ${targetHost}` : ''
document.title = targetHost ? `focus — ${targetHost}` : 'focus'

// The quote is drawn once, so it cannot reshuffle under the reader.
;(async () => {
  const res = await getQuotes()
  const user = isDown(res) ? [] : res.quotes
  const q = pickQuote(BUNDLED_QUOTES, user)
  el.quote.textContent = `“${q.text}”`
  el.author.textContent = q.author ? `— ${q.author}` : ''
})()

function release() {
  if (released || !targetUrl) return
  released = true
  location.replace(targetUrl)
}

function render(view, down) {
  el.down.hidden = !down

  if (down || !view) {
    el.phase.textContent = 'no daemon'
    el.clock.textContent = 'take the pause anyway'
    renderTasks(el.tasks, [])
    return
  }

  // A sanctioned window opened while this screen was up: let the visit through
  // rather than making the user click again.
  if (view.nudgingPhase === false) return release()

  // Track the site the daemon is actually watching, so the grace call matches.
  const site = (view.sites ?? []).find(s => targetHost === s || targetHost.endsWith('.' + s))
  if (site) matchedSite = site

  el.phase.textContent = PHASE_LABEL[view.phase] ?? view.phase
  el.clock.textContent = clockLine(view)
  el.clock.classList.toggle('overrun', Boolean(view.overrun))
  renderTasks(el.tasks, view.tasks)
}

async function poll() {
  const v = await getState()
  render(isDown(v) ? null : v, isDown(v))
}

poll()
setInterval(poll, 1000)

// The countdown gates the escape hatch; it never removes it.
let secondsLeft = 10
function tickCountdown() {
  if (secondsLeft > 0) {
    el.continue.textContent = `continue anyway  (${secondsLeft})`
    el.continue.disabled = true
    secondsLeft--
    setTimeout(tickCountdown, 1000)
  } else {
    el.continue.textContent = 'continue anyway'
    el.continue.disabled = false
  }
}
getState().then(v => {
  if (!isDown(v) && Number.isFinite(v.countdownSeconds)) secondsLeft = v.countdownSeconds
  tickCountdown()
})

function goBack() {
  chrome.runtime.sendMessage({ type: 'goBack' }, () => {})
}

el.back.addEventListener('click', goBack)

el.save.addEventListener('click', async () => {
  el.save.disabled = true
  await queueAdd(targetUrl, targetHost)
  el.save.textContent = 'saved'
  goBack()
})

el.continue.addEventListener('click', async () => {
  el.continue.disabled = true
  if (matchedSite) await grace(matchedSite)
  release()
})

// Escape is the same as choosing to go back.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') goBack()
})
