import { test } from 'node:test'
import assert from 'node:assert/strict'

// insights.js is a page script. It is imported here under minimal stand-ins for
// the DOM so its wiring can be checked. fetch is stubbed to fail, so the page
// sees a down daemon and nothing ever reaches the live one on 127.0.0.1:7373.
test('the page listens for resize once, at load, however often the range changes', async () => {
  const listeners = { window: [], change: [] }
  const fakeEl = id => ({
    id, hidden: false, value: id === 'range' ? '30' : '', textContent: '', style: {}, children: [],
    replaceChildren() {}, append() {}, setAttribute() {},
    addEventListener(type, fn) { if (id === 'range' && type === 'change') listeners.change.push(fn) },
  })
  const els = {}
  globalThis.document = {
    getElementById: id => (els[id] ??= fakeEl(id)),
    addEventListener() {},
    createElement: fakeEl,
    createElementNS: (_, t) => fakeEl(t),
  }
  globalThis.window = { addEventListener: (type, fn) => listeners.window.push(type), innerWidth: 1000, innerHeight: 800 }
  globalThis.localStorage = { getItem: () => null, setItem() {} }
  globalThis.fetch = async () => { throw new Error('no network in tests') }

  await import('../extension/insights.js')
  assert.equal(listeners.window.filter(t => t === 'resize').length, 1, 'registered at load')
  listeners.change.forEach(fn => fn())
  listeners.change.forEach(fn => fn())
  assert.equal(listeners.window.filter(t => t === 'resize').length, 1, 'not again on each range change')
})
