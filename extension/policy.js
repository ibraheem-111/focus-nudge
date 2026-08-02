// Pure nudge decision. Imported by the MV3 service worker and by node:test.
// No I/O, no clock: `now` is injected.

export const NUDGE_PHASES = new Set(['IDLE', 'WORK', 'SHORT_BREAK'])
export const FALLBACK_SITES = ['reddit.com', 'youtube.com']

export function matchSite(url, sites) {
  let host
  try {
    const parsed = new URL(String(url))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    host = parsed.hostname.toLowerCase()
  } catch {
    return null
  }
  const list = Array.isArray(sites) && sites.length ? sites : FALLBACK_SITES
  for (const raw of list) {
    const site = String(raw).toLowerCase()
    if (host === site || host.endsWith('.' + site)) return site
  }
  return null
}

export function decide({ url, phase, graces, sites, now }) {
  const site = matchSite(url, sites)
  if (!site) return { action: 'allow', site: null, reason: 'no-match' }

  // Fail closed: with no usable phase we nudge rather than guess.
  if (typeof phase !== 'string' || phase.length === 0) {
    return { action: 'nudge', site, reason: 'no-state' }
  }

  if (!NUDGE_PHASES.has(phase)) {
    // A known sanctioned phase opens the site; an unrecognised one fails closed.
    if (phase === 'LONG_BREAK' || phase === 'SNOOZED') {
      return { action: 'allow', site, reason: 'sanctioned' }
    }
    return { action: 'nudge', site, reason: 'nudge' }
  }

  const until = graces && typeof graces === 'object' ? graces[site] : undefined
  if (typeof until === 'number' && until > now) {
    return { action: 'allow', site, reason: 'grace' }
  }

  return { action: 'nudge', site, reason: 'nudge' }
}
