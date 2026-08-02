// Pure nudge decision. Imported by the MV3 service worker and by node:test.
// No I/O, no clock: `now` is injected.

export const NUDGE_PHASES = new Set(['IDLE', 'WORK', 'SHORT_BREAK'])
export const FALLBACK_SITES = ['reddit.com', 'youtube.com']

export function matchSite(url, sites) {
  let host
  try {
    const parsed = new URL(String(url))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    // A trailing dot is a legal FQDN form: reddit.com. is reddit.com.
    host = parsed.hostname.toLowerCase().replace(/\.+$/, '')
  } catch {
    return null
  }

  // A missing or malformed list means we have no data, so fall back and keep
  // nudging — a dead daemon must not open Reddit. An explicitly *empty* list is
  // different: it is the user saying "watch nothing", and it is honoured.
  const list = Array.isArray(sites) ? sites : FALLBACK_SITES

  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const site = raw.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '')
    // Requiring a dot stops a stray bare TLD like "com" — reachable by hand
    // editing config.json — from matching every domain in it.
    if (!site.includes('.')) continue
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
