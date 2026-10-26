// Pure nudge decision. Imported by the MV3 service worker and by node:test.
// No I/O, no clock: `now` is injected.

export const NUDGE_PHASES = new Set(['IDLE', 'WORK', 'SHORT_BREAK'])
// Must stay in step with DEFAULTS.sites in daemon/config.js: a cold service
// worker with an unreachable daemon decides from this list alone, so a domain
// the config watches but this omits is silently allowed. test/policy.test.js
// asserts the two lists are equal.
export const FALLBACK_SITES = ['reddit.com', 'youtube.com', 'x.com', 'instagram.com']

// Used only by the pause screen, and only when the daemon cannot be reached to
// tell us its own graceMinutes. Mirrors DEFAULTS.graceMinutes.
export const FALLBACK_GRACE_MINUTES = 5

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

export function decide({ url, phase, graces, sites, now, down = false, fallbackPasses = null, nudging }) {
  const site = matchSite(url, sites)
  if (!site) return { action: 'allow', site: null, reason: 'no-match' }

  // A pass the extension recorded for itself because the daemon was unreachable
  // when `continue anyway` was pressed. Without it the escape hatch is futile:
  // releasing the navigation just triggers another interception, forever.
  //
  // Honoured ONLY while the daemon is still down. The moment it answers it is
  // the authority again, so a stale session pass cannot outlive a real grace or
  // survive `focus start`. A missing or malformed pass falls through and nudges.
  if (down) {
    const until = fallbackPasses && typeof fallbackPasses === 'object' ? fallbackPasses[site] : undefined
    if (typeof until === 'number' && until > now) {
      return { action: 'allow', site, reason: 'grace-fallback' }
    }
  }

  // Fail closed: with no usable phase we nudge rather than guess.
  if (typeof phase !== 'string' || phase.length === 0) {
    return { action: 'nudge', site, reason: 'no-state' }
  }

  // A current daemon reports `nudging`: a switch the user flips, independent of
  // the timer. Only a real boolean from a reachable daemon is trusted; anything
  // else falls through to the old phase rule below, which an older daemon still
  // needs, and which still fails closed.
  if (!down && typeof nudging === 'boolean') {
    if (!nudging) return { action: 'allow', site, reason: 'nudging-off' }
    const until = graces && typeof graces === 'object' ? graces[site] : undefined
    if (typeof until === 'number' && until > now) return { action: 'allow', site, reason: 'grace' }
    return { action: 'nudge', site, reason: 'nudge' }
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
