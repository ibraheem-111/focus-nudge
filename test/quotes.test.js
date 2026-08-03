import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUNDLED_QUOTES, pickQuote } from '../extension/quotes.js'

test('the bundled list is substantial and well formed', () => {
  assert.ok(BUNDLED_QUOTES.length >= 40, `only ${BUNDLED_QUOTES.length} quotes`)
  for (const q of BUNDLED_QUOTES) {
    assert.equal(typeof q.text, 'string')
    assert.ok(q.text.length > 0)
    assert.equal(typeof q.author, 'string')
  }
})

test('no quote is duplicated', () => {
  const seen = new Set(BUNDLED_QUOTES.map(q => q.text))
  assert.equal(seen.size, BUNDLED_QUOTES.length)
})

test('pickQuote draws from the bundled and user lists together', () => {
  const user = [{ text: 'mine', author: 'me' }]
  const last = pickQuote(BUNDLED_QUOTES, user, () => 0.999999)
  assert.equal(last.text, 'mine', 'user quotes sit at the end of the pool')
  const first = pickQuote(BUNDLED_QUOTES, user, () => 0)
  assert.equal(first.text, BUNDLED_QUOTES[0].text)
})

test('pickQuote copes with an empty user list and a missing one', () => {
  assert.ok(pickQuote(BUNDLED_QUOTES, [], () => 0.5).text)
  assert.ok(pickQuote(BUNDLED_QUOTES, null, () => 0.5).text)
})

test('pickQuote never returns undefined at the top of the range', () => {
  assert.ok(pickQuote(BUNDLED_QUOTES, [], () => 0.9999999999).text)
})
