// Thin client for the daemon. Never throws: an unreachable daemon yields
// DAEMON_DOWN, and callers fail closed toward nudging.

const PORT = 7373
const BASE = `http://127.0.0.1:${PORT}`
const TIMEOUT_MS = 1500

export const DAEMON_DOWN = Object.freeze({ down: true })

async function request(method, route, body, timeoutMs = TIMEOUT_MS) {
  try {
    const res = await fetch(BASE + route, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return DAEMON_DOWN
    return await res.json()
  } catch {
    return DAEMON_DOWN
  }
}

export const isDown = v => !v || v === DAEMON_DOWN || v.down === true

export const getState = () => request('GET', '/state')
export const getQuotes = () => request('GET', '/quotes')
export const getStats = () => request('GET', '/stats')
// Slower than the rest: the daemon may have to ask Linear for the project list.
export const getLinear = () => request('GET', '/linear', undefined, 12000)
export const timer = action => request('POST', '/timer', { action })
// hours: a positive number, or null for "until I turn it back on".
export const nudgingOff = hours =>
  request('POST', '/nudging', hours == null ? { action: 'off', indefinite: true } : { action: 'off', hours })
export const nudgingOn = () => request('POST', '/nudging', { action: 'on' })
export const task = (action, payload = {}) => request('POST', '/tasks', { action, ...payload })
export const site = (action, s) => request('POST', '/sites', { action, site: s })
export const queueAdd = (url, title) => request('POST', '/queue', { url, title })
export const queueDrain = () => request('POST', '/queue', { drain: true })
export const grace = s => request('POST', '/grace', { site: s })
// For the insights page only: a nudge was shown, or the user turned back from one.
export const reportNudge = (s, outcome) => request('POST', '/nudge', { site: s, outcome })
// days: a positive number, or null for all time.
export const getInsights = days => request('GET', days ? `/insights?days=${days}` : '/insights', undefined, 5000)
