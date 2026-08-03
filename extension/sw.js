import { decide } from './policy.js'
import { getState, isDown } from './api.js'

const POLL_ALARM = 'focus-nudge-poll'
const CACHE_KEY = 'cachedView'
const FRESH_MS = 2000

let cache = { view: null, at: 0, down: true }

async function refresh() {
  const v = await getState()
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

chrome.webNavigation.onBeforeNavigate.addListener(async details => {
  if (details.frameId !== 0) return
  const target = details.url
  if (!target.startsWith('http://') && !target.startsWith('https://')) return

  const { view, down } = await currentCache()

  const verdict = decide({
    url: target,
    phase: down ? null : view?.phase,
    graces: down ? null : view?.graces,
    sites: view?.sites ?? null,
    now: Date.now(),
  })

  if (verdict.action === 'allow') return

  // Remember where the tab was so "Back to work" has somewhere to return to.
  let priorUrl = null
  try {
    const tab = await chrome.tabs.get(details.tabId)
    if (tab.url && !tab.url.startsWith(chrome.runtime.getURL(''))) priorUrl = tab.url
  } catch {}
  try {
    await chrome.storage.session.set({ [`priorUrl:${details.tabId}`]: priorUrl })
  } catch {}

  try {
    await chrome.tabs.update(details.tabId, { url: interstitialUrl(target) })
  } catch {}
})

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove(`priorUrl:${tabId}`).catch(() => {})
})

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === 'cachedState') {
    currentCache().then(c => respond({ view: c.view, down: c.down }))
    return true
  }

  if (msg?.type === 'refresh') {
    refresh().then(c => respond({ view: c.view, down: c.down }))
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

  if (msg?.type === 'openUrls') {
    for (const url of msg.urls ?? []) chrome.tabs.create({ url, active: false }).catch(() => {})
    respond({ ok: true })
    return true
  }

  return false
})
