import { BUNDLED_QUOTES, pickQuote } from './quotes.js'
import { getState, getQuotes, grace, queueAdd, task, isDown, reportNudge } from './api.js'
import { clockLine, renderTasks, PHASE_LABEL, countdown } from './ui.js'
import { matchSite, FALLBACK_GRACE_MINUTES } from './policy.js'

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

// The key the grace is filed under has to be the site the DAEMON is watching,
// not this page's hostname — policy.decide only ever looks up graces[site], so a
// pass recorded under "old.reddit.com" is a pass nobody will ever find, and
// `continue anyway` silently loops. matchSite is the one implementation of that
// rule; this page used to carry a second, weaker copy that missed trailing dots,
// non-string entries and dotless entries. Clients do not re-derive daemon
// decisions. Until the first poll answers, the built-in fallback list is used —
// the same list sw.js decides from when it has no view either.
let matchedSite = matchSite(targetUrl, null)
let graceMinutes = FALLBACK_GRACE_MINUTES

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

// A missing or unparsable ?url= must never leave the escape hatch dead. If we
// cannot send the user onward, send them back instead — the one outcome this
// design forbids is a screen with no way off it.
const targetUsable = (() => {
  try {
    const u = new URL(targetUrl)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch { return false }
})()

function release() {
  if (released) return
  released = true
  if (!targetUsable) return goBack()
  try {
    location.replace(targetUrl)
  } catch {
    goBack()
  }
}

function render(view, down) {
  el.down.hidden = !down

  if (down || !view) {
    el.phase.textContent = 'no daemon'
    el.clock.textContent = 'take the pause anyway'
    renderTasks(el.tasks, [])
    return
  }

  // Nudging was switched off while this screen was up: let the visit through
  // rather than making the user click again. `nudgingPhase` covers a daemon
  // older than the `nudging` field.
  if (view.nudging === false || (view.nudging === undefined && view.nudgingPhase === false)) return release()

  // Track the site the daemon is actually watching, so the grace call matches.
  // A null result means its list does not cover this visit; keep the fallback
  // match rather than clearing a working key.
  const site = matchSite(targetUrl, view.sites)
  if (site) matchedSite = site
  if (typeof view.graceMinutes === 'number' && view.graceMinutes > 0) {
    graceMinutes = view.graceMinutes
  }

  el.phase.textContent = PHASE_LABEL[view.phase] ?? view.phase
  el.clock.textContent = clockLine(view)
  el.clock.classList.toggle('overrun', Boolean(view.overrun))
  // Interactive, not decorative. A checkbox that visibly reverts on the next
  // poll reads as broken, and ticking off something you just finished is a
  // reasonable thing to want here.
  renderTasks(el.tasks, view.tasks, {
    onToggle: async id => {
      const v = await task('toggle', { id })
      if (!isDown(v)) render(v, false)
    },
  })
}

async function poll() {
  const v = await getState()
  render(isDown(v) ? null : v, isDown(v))
}

poll()
setInterval(poll, 1000)

// The countdown gates the escape hatch; it never removes it. It starts NOW, not
// after a daemon round trip — gating it on the network would leave the button
// blank and silently extend the real wait by up to api.js's 1500 ms timeout.
const clock = countdown({
  seconds: 10,
  onTick: n => {
    el.continue.textContent = `continue anyway  (${n})`
    el.continue.disabled = true
  },
  onDone: () => {
    el.continue.textContent = 'continue anyway'
    el.continue.disabled = false
  },
})

// If the daemon specifies a different countdown, apply it to the running clock.
getState().then(v => {
  if (!isDown(v)) clock.setSeconds(v.countdownSeconds)
})

function goBack() {
  chrome.runtime.sendMessage({ type: 'goBack' }, () => {})
}

// The user chose not to go in. Recorded for the insights page; saving a link
// for later is counted separately, so it does not come through here.
function turnBack() {
  if (matchedSite) reportNudge(matchedSite, 'back')
  goBack()
}

el.back.addEventListener('click', () => { el.back.disabled = true; turnBack() })

el.save.addEventListener('click', async () => {
  el.save.disabled = true
  const res = await queueAdd(targetUrl, targetHost)
  // The daemon holds the queue, so with it down the link is simply gone. Saying
  // "saved" then navigating away loses the link AND the fact that it was lost.
  if (isDown(res)) {
    el.save.textContent = 'not saved — no daemon'
    el.save.disabled = false
    return
  }
  el.save.textContent = 'saved'
  goBack()
})

// Records a pass the service worker will honour while the daemon stays down.
// Without it, releasing the navigation just walks into the next interception and
// the escape hatch is futile — the one thing this design forbids. Session-scoped
// on purpose: it dies with the browser, so a dead daemon never grants standing
// access, and sw.js drops it the moment the daemon answers again.
async function recordFallbackPass(site) {
  try {
    await chrome.storage.session.set({
      [`graceFallback:${site}`]: Date.now() + graceMinutes * 60_000,
    })
  } catch {}
}

el.continue.addEventListener('click', async () => {
  el.continue.disabled = true
  if (matchedSite) {
    const res = await grace(matchedSite)
    if (isDown(res)) await recordFallbackPass(matchedSite)
  }
  release()
})

// Escape is the same as choosing to go back.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') turnBack()
})
