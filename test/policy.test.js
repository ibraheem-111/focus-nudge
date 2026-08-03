import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  matchSite, decide, NUDGE_PHASES, FALLBACK_SITES, FALLBACK_GRACE_MINUTES,
} from '../extension/policy.js'

const SITES = ['reddit.com', 'youtube.com']
const T0 = 1_000_000_000_000

test('matchSite matches the domain itself and any subdomain', () => {
  assert.equal(matchSite('https://reddit.com/', SITES), 'reddit.com')
  assert.equal(matchSite('https://www.reddit.com/r/x', SITES), 'reddit.com')
  assert.equal(matchSite('https://old.reddit.com/r/x', SITES), 'reddit.com')
  assert.equal(matchSite('https://music.youtube.com/watch?v=1', SITES), 'youtube.com')
  assert.equal(matchSite('https://m.youtube.com/', SITES), 'youtube.com')
})

test('matchSite is case insensitive and ignores port and path', () => {
  assert.equal(matchSite('https://OLD.REDDIT.COM:443/r/x', SITES), 'reddit.com')
})

test('matchSite rejects lookalike domains', () => {
  assert.equal(matchSite('https://notreddit.com/', SITES), null)
  assert.equal(matchSite('https://reddit.com.evil.test/', SITES), null)
  assert.equal(matchSite('https://myreddit.com/', SITES), null)
  assert.equal(matchSite('https://example.com/?q=reddit.com', SITES), null)
})

test('matchSite returns null for unparseable or non-web urls', () => {
  assert.equal(matchSite('not a url', SITES), null)
  assert.equal(matchSite('', SITES), null)
  assert.equal(matchSite(undefined, SITES), null)
  assert.equal(matchSite('chrome-extension://abc/dashboard.html', SITES), null)
})

test('the nudging phases are exactly idle, work, and short break', () => {
  assert.deepEqual([...NUDGE_PHASES].sort(), ['IDLE', 'SHORT_BREAK', 'WORK'])
})

// The duplication between core.NUDGING_PHASES and policy.NUDGE_PHASES is
// deliberate — the extension has to decide with the daemon unreachable, so it
// cannot import from daemon/. But nothing stopped the two drifting, and a drift
// is silent in exactly the wrong direction: a phase the daemon treats as nudging
// but the policy does not would leave every watched site open during it.
test('policy.NUDGE_PHASES and core.NUDGING_PHASES have not drifted apart', async () => {
  const { NUDGING_PHASES } = await import('../daemon/core.js')
  assert.deepEqual([...NUDGE_PHASES].sort(), [...NUDGING_PHASES].sort())
})

test('a watched site is nudged during work', () => {
  const d = decide({ url: 'https://reddit.com/', phase: 'WORK', graces: {}, sites: SITES, now: T0 })
  assert.equal(d.action, 'nudge')
  assert.equal(d.site, 'reddit.com')
  assert.equal(d.reason, 'nudge')
})

test('a watched site is nudged during a short break, because breaks are zen time', () => {
  assert.equal(decide({ url: 'https://youtube.com/', phase: 'SHORT_BREAK', graces: {}, sites: SITES, now: T0 }).action, 'nudge')
})

test('a watched site is nudged while idle', () => {
  assert.equal(decide({ url: 'https://reddit.com/', phase: 'IDLE', graces: {}, sites: SITES, now: T0 }).action, 'nudge')
})

test('long break and snooze are sanctioned windows', () => {
  for (const phase of ['LONG_BREAK', 'SNOOZED']) {
    const d = decide({ url: 'https://reddit.com/', phase, graces: {}, sites: SITES, now: T0 })
    assert.equal(d.action, 'allow', `${phase} should allow`)
    assert.equal(d.reason, 'sanctioned')
  }
})

test('an unwatched site is always allowed', () => {
  const d = decide({ url: 'https://example.com/', phase: 'WORK', graces: {}, sites: SITES, now: T0 })
  assert.equal(d.action, 'allow')
  assert.equal(d.reason, 'no-match')
})

test('a live grace lets the matched site through and nothing else', () => {
  const graces = { 'reddit.com': T0 + 60_000 }
  assert.equal(decide({ url: 'https://reddit.com/', phase: 'WORK', graces, sites: SITES, now: T0 }).reason, 'grace')
  assert.equal(decide({ url: 'https://youtube.com/', phase: 'WORK', graces, sites: SITES, now: T0 }).action, 'nudge')
})

test('a lapsed grace nudges again, expiring on the boundary', () => {
  const graces = { 'reddit.com': T0 }
  assert.equal(decide({ url: 'https://reddit.com/', phase: 'WORK', graces, sites: SITES, now: T0 }).action, 'nudge')
  assert.equal(decide({ url: 'https://reddit.com/', phase: 'WORK', graces, sites: SITES, now: T0 - 1 }).action, 'allow')
})

test('non-http schemes are left alone', () => {
  for (const url of ['chrome://settings', 'about:blank', 'file:///home/x', 'chrome-extension://a/b.html']) {
    assert.equal(decide({ url, phase: 'WORK', graces: {}, sites: SITES, now: T0 }).action, 'allow')
  }
})

test('an unknown phase fails closed and nudges', () => {
  const d = decide({ url: 'https://reddit.com/', phase: 'GARBAGE', graces: {}, sites: SITES, now: T0 })
  assert.equal(d.action, 'nudge')
})

test('a missing phase fails closed and nudges a watched site', () => {
  const d = decide({ url: 'https://reddit.com/', phase: null, graces: null, sites: SITES, now: T0 })
  assert.equal(d.action, 'nudge')
  assert.equal(d.reason, 'no-state')
})

test('a missing site list falls back to the built-in defaults', () => {
  assert.equal(decide({ url: 'https://reddit.com/', phase: 'WORK', graces: {}, sites: null, now: T0 }).action, 'nudge')
  assert.equal(decide({ url: 'https://example.com/', phase: 'WORK', graces: {}, sites: null, now: T0 }).action, 'allow')
})

// The site list is user-editable through the popup, the CLI, and by hand in
// config.json, so a malformed entry must not silently disable protection.

test('a leading-dot entry still protects its domain', () => {
  // normaliseSite's regex accepts ".reddit.com", so this reaches the matcher
  // from the real popup. Without stripping, host.endsWith("..reddit.com") is
  // never true and the site the user just asked to nudge goes unwatched.
  assert.equal(matchSite('https://reddit.com/', ['.reddit.com']), 'reddit.com')
  assert.equal(matchSite('https://old.reddit.com/', ['.reddit.com']), 'reddit.com')
  assert.equal(decide({ url: 'https://reddit.com/', phase: 'WORK', graces: {}, sites: ['.reddit.com'], now: T0 }).action, 'nudge')
})

test('a bare TLD entry matches nothing rather than everything', () => {
  assert.equal(matchSite('https://google.com/', ['com']), null)
  assert.equal(matchSite('https://reddit.com/', ['com']), null)
  assert.equal(matchSite('https://anything.co.uk/', ['uk']), null)
})

test('blank and non-string entries are skipped, not coerced', () => {
  assert.equal(matchSite('https://reddit.com/', ['', '   ']), null)
  assert.equal(matchSite('https://null.com/', [null, undefined, 42, {}]), null)
  assert.equal(matchSite('https://reddit.com/', [null, 'reddit.com']), 'reddit.com', 'a bad entry does not stop later good ones')
})

test('an explicitly empty site list watches nothing', () => {
  // Distinct from a missing list: [] is the user clearing their sites, and the
  // popup would otherwise show an empty list while Reddit still got nudged.
  assert.equal(matchSite('https://reddit.com/', []), null)
  assert.equal(decide({ url: 'https://reddit.com/', phase: 'WORK', graces: {}, sites: [], now: T0 }).action, 'allow')
})

test('a non-array site list falls back rather than watching nothing', () => {
  // Malformed config is missing data, so stay closed.
  for (const junk of ['reddit.com', 42, {}, true]) {
    assert.equal(decide({ url: 'https://reddit.com/', phase: 'WORK', graces: {}, sites: junk, now: T0 }).action, 'nudge', `sites=${JSON.stringify(junk)}`)
  }
})

test('a trailing-dot FQDN host still matches', () => {
  assert.equal(matchSite('https://reddit.com./', ['reddit.com']), 'reddit.com')
})

// With the daemon down, POST /grace cannot be recorded, so `continue anyway`
// used to send the user straight back into another interception — forever, with
// the pause screen claiming it was "a plain reminder". The pass is instead
// recorded in the extension's own session storage and honoured here, but ONLY
// while the daemon is unreachable: whenever it answers, it is the authority.

test('a session fallback pass lets the site through while the daemon is down', () => {
  const passes = { 'reddit.com': T0 + 60_000 }
  const d = decide({ url: 'https://reddit.com/', phase: null, graces: null, sites: SITES, now: T0, down: true, fallbackPasses: passes })
  assert.equal(d.action, 'allow')
  assert.equal(d.site, 'reddit.com')
  assert.equal(d.reason, 'grace-fallback')
})

test('a fallback pass is per-site and expires on the boundary', () => {
  const passes = { 'reddit.com': T0 }
  const args = { phase: null, graces: null, sites: SITES, down: true, fallbackPasses: passes }
  assert.equal(decide({ ...args, url: 'https://reddit.com/', now: T0 }).action, 'nudge', 'lapses exactly on the boundary')
  assert.equal(decide({ ...args, url: 'https://reddit.com/', now: T0 - 1 }).action, 'allow')
  assert.equal(decide({ ...args, url: 'https://youtube.com/', now: T0 - 1 }).action, 'nudge', 'a reddit pass does not unlock youtube')
})

test('a subdomain visit is covered by the pass held under the matched site', () => {
  // The key is the site policy matched, not the hostname — otherwise the pass is
  // filed where nothing will ever look it up.
  const passes = { 'reddit.com': T0 + 60_000 }
  assert.equal(decide({ url: 'https://old.reddit.com/r/x', phase: null, graces: null, sites: SITES, now: T0, down: true, fallbackPasses: passes }).action, 'allow')
})

test('a fallback pass is ignored whenever the daemon is reachable', () => {
  // The daemon is the authority when it is up; a stale session pass must not
  // outlive a real grace or survive `focus start`.
  const passes = { 'reddit.com': T0 + 60_000 }
  const d = decide({ url: 'https://reddit.com/', phase: 'WORK', graces: {}, sites: SITES, now: T0, down: false, fallbackPasses: passes })
  assert.equal(d.action, 'nudge', 'a live daemon overrules the session pass')
})

test('a missing or malformed fallback pass still nudges', () => {
  for (const passes of [null, undefined, {}, 'nope', 42, { 'reddit.com': 'soon' }, { 'reddit.com': null }]) {
    const d = decide({ url: 'https://reddit.com/', phase: null, graces: null, sites: SITES, now: T0, down: true, fallbackPasses: passes })
    assert.equal(d.action, 'nudge', `fallbackPasses=${JSON.stringify(passes)} must fail closed`)
  }
})

test('down with no fallback pass at all still nudges, and still reports no-state', () => {
  const d = decide({ url: 'https://reddit.com/', phase: null, graces: null, sites: SITES, now: T0, down: true })
  assert.equal(d.action, 'nudge')
  assert.equal(d.reason, 'no-state')
})

test('a fallback pass never opens an unwatched site', () => {
  const passes = { 'example.com': T0 + 60_000 }
  const d = decide({ url: 'https://example.com/', phase: null, graces: null, sites: SITES, now: T0, down: true, fallbackPasses: passes })
  assert.equal(d.reason, 'no-match', 'no match means the pass is irrelevant, not a grant')
})

test('the fallback grace length is a positive number of minutes', () => {
  // The interstitial has no daemon to ask for graceMinutes when it is down, so
  // this shared constant is what it uses. It must not be zero, or the pass would
  // already have lapsed by the time the navigation is re-evaluated.
  assert.equal(typeof FALLBACK_GRACE_MINUTES, 'number')
  assert.ok(FALLBACK_GRACE_MINUTES > 0)
})

test('FALLBACK_SITES covers every domain the default config watches', async () => {
  // A cold service worker with an unreachable daemon decides from FALLBACK_SITES
  // alone. Anything the shipped config watches but this list omits is allowed
  // outright — the precise scenario fail-closed exists to prevent.
  const { DEFAULTS } = await import('../daemon/config.js')
  assert.deepEqual([...FALLBACK_SITES].sort(), [...DEFAULTS.sites].sort())
  for (const s of DEFAULTS.sites) {
    assert.equal(
      decide({ url: `https://${s}/`, phase: 'WORK', graces: {}, sites: null, now: T0 }).action,
      'nudge',
      `${s} is allowed with sites:null`,
    )
  }
})

test('the four domains in daily use are all watched by default', () => {
  for (const s of ['reddit.com', 'youtube.com', 'x.com', 'instagram.com']) {
    assert.ok(FALLBACK_SITES.includes(s), `${s} missing from FALLBACK_SITES`)
  }
})
