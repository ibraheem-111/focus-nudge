import { decide } from './policy.js'
import { getState, isDown, reportNudge } from './api.js'

const POLL_ALARM = 'focus-nudge-poll'
const CACHE_KEY = 'cachedView'
const FRESH_MS = 2000
// Passes the pause screen recorded for itself because the daemon was unreachable
// when `continue anyway` was pressed. See readFallbackPasses below.
const FALLBACK_PREFIX = 'graceFallback:'

let cache = { view: null, at: 0, down: true }

// Concurrent refreshes are normal: an alarm can fire while a navigation is also
// refreshing. Without a generation guard a slow OLDER response can land after a
// newer one and overwrite it — including overwriting a fresh "daemon is down"
// with a stale "daemon is up", which would allow a watched site for up to
// FRESH_MS. That is precisely the fail-closed guarantee this file exists to keep.
let generation = 0

async function refresh() {
  const gen = ++generation
  const v = await getState()
  if (gen !== generation) return cache   // a newer refresh already won

  if (isDown(v)) {
    cache = { ...cache, down: true, at: Date.now() }
  } else {
    cache = { view: v, at: Date.now(), down: false }
    try {
      await chrome.storage.session.set({ [CACHE_KEY]: v })
    } catch {}
  }
  return cache
}

async function currentCache() {
  if (cache.view && Date.now() - cache.at < FRESH_MS) return cache
  // A woken service worker starts with an empty module scope; fall back to
  // session storage so a decision is never made on nothing.
  if (!cache.view) {
    try {
      const stored = await chrome.storage.session.get(CACHE_KEY)
      if (stored[CACHE_KEY]) cache = { view: stored[CACHE_KEY], at: 0, down: false }
    } catch {}
  }
  return refresh()
}

function interstitialUrl(target) {
  return chrome.runtime.getURL(`interstitial.html?url=${encodeURIComponent(target)}`)
}

// With the daemon down, POST /grace cannot record anything, so `continue anyway`
// would release the navigation only for this listener to intercept it again —
// forever, with no way onward. The pause screen writes a session-scoped pass
// instead and we honour it HERE, but only while the daemon is still unreachable:
// policy.decide is handed `down` so a reachable daemon always overrules it.
// Session storage is deliberate — the pass dies with the browser, so a dead
// daemon can never grant standing access. A missing pass still nudges.
//
// Only read when down, so the normal path costs nothing.
async function readFallbackPasses() {
  try {
    const all = await chrome.storage.session.get(null)
    const passes = {}
    for (const [key, until] of Object.entries(all)) {
      if (key.startsWith(FALLBACK_PREFIX)) passes[key.slice(FALLBACK_PREFIX.length)] = until
    }
    return passes
  } catch {
    return null   // unreadable storage is missing data: fail closed and nudge
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 })
  refresh()
})

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 })
  refresh()
})

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === POLL_ALARM) refresh()
})

async function onNavigation(details) {
  if (details.frameId !== 0) return
  const target = details.url
  if (!target.startsWith('http://') && !target.startsWith('https://')) return

  // Capture where the tab currently is BEFORE the state lookup. The navigation
  // events do not block the browser, and a cold cache makes currentCache() wait
  // on a real fetch (up to api.js's 1500 ms timeout). By then the navigation may
  // have committed and tab.url would be the blocked URL itself — so "Back to
  // work" would navigate right back into the interstitial. The `tab.url !==
  // target` guard below makes that harmless even if it does happen.
  let priorUrl = null
  try {
    const tab = await chrome.tabs.get(details.tabId)
    if (tab.url && tab.url !== target && !tab.url.startsWith(chrome.runtime.getURL(''))) {
      priorUrl = tab.url
    }
  } catch {}

  const { view, down } = await currentCache()
  const fallbackPasses = down ? await readFallbackPasses() : null

  const verdict = decide({
    url: target,
    phase: down ? null : view?.phase,
    nudging: down ? null : view?.nudging,
    graces: down ? null : view?.graces,
    sites: view?.sites ?? null,
    now: Date.now(),
    down,
    fallbackPasses,
  })

  if (verdict.action === 'allow') return

  // priorUrl was captured at the top of this listener, before any await.
  // Only ever written when we actually found somewhere to go back TO. Since
  // onHistoryStateUpdated is also wired up, a single visit can be evaluated many
  // times, and an unconditional write would let a later evaluation — whose
  // tab.url is by then our own interstitial, so priorUrl is null — overwrite the
  // good value the first one stored, silently downgrading "Back to work" into
  // "close the tab".
  if (priorUrl !== null) {
    try {
      await chrome.storage.session.set({ [`priorUrl:${details.tabId}`]: priorUrl })
    } catch {}
  }

  try {
    await chrome.tabs.update(details.tabId, { url: interstitialUrl(target) })
    // Not awaited: a slow or absent daemon must never delay the pause screen.
    if (verdict.site) reportNudge(verdict.site, 'shown')
  } catch {}
}

// Both events, on purpose. All four watched sites are single-page apps: clicking
// through YouTube or Reddit fires onHistoryStateUpdated and NOT
// onBeforeNavigate, so listening only to the latter meant a grace could lapse
// without another pause screen ever appearing as long as the user stayed inside
// the app — the timer the whole design rests on never bound. Both are covered by
// the `webNavigation` permission the manifest already declares.
//
// This makes the handler run far more often, which is safe because it is a read
// plus a cached decision: currentCache() only reaches the network when its
// 2-second cache is stale, and the one write on the nudge path is now guarded
// above. chrome.storage.session is memory-backed, so nothing here touches disk.
chrome.webNavigation.onBeforeNavigate.addListener(onNavigation)
chrome.webNavigation.onHistoryStateUpdated.addListener(onNavigation)

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove(`priorUrl:${tabId}`).catch(() => {})
})

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  // Both of these must respond even on rejection. A requester (the pause screen)
  // that never gets a reply waits forever, silently, with nothing in the console
  // — so failing to answer fails OPEN in the UI. Answer "down" instead.
  if (msg?.type === 'cachedState') {
    currentCache()
      .then(c => respond({ view: c.view, down: c.down }))
      .catch(() => respond({ view: null, down: true }))
    return true
  }

  if (msg?.type === 'refresh') {
    refresh()
      .then(c => respond({ view: c.view, down: c.down }))
      .catch(() => respond({ view: null, down: true }))
    return true
  }

  if (msg?.type === 'goBack') {
    const tabId = msg.tabId ?? sender.tab?.id
    if (tabId === undefined) { respond({ ok: false }); return true }
    chrome.storage.session.get(`priorUrl:${tabId}`).then(stored => {
      const prior = stored[`priorUrl:${tabId}`]
      if (prior) chrome.tabs.update(tabId, { url: prior }).catch(() => {})
      else chrome.tabs.remove(tabId).catch(() => {})
      respond({ ok: true })
    }).catch(() => respond({ ok: false }))
    return true
  }

  return false
})
