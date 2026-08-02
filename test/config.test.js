import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, PATHS, CONFIG_DIR, mergeConfig } from '../daemon/config.js'

test('DEFAULTS carry the spec values', () => {
  assert.equal(DEFAULTS.port, 7373)
  assert.equal(DEFAULTS.workMinutes, 25)
  assert.equal(DEFAULTS.shortBreakMinutes, 5)
  assert.equal(DEFAULTS.longBreakMinutes, 20)
  assert.equal(DEFAULTS.blocksPerCycle, 4)
  assert.equal(DEFAULTS.graceMinutes, 5)
  assert.equal(DEFAULTS.countdownSeconds, 10)
  assert.deepEqual(DEFAULTS.sites, ['reddit.com', 'youtube.com'])
})

test('PATHS all sit under CONFIG_DIR', () => {
  for (const p of Object.values(PATHS)) {
    assert.ok(p.startsWith(CONFIG_DIR + '/'), `${p} not under ${CONFIG_DIR}`)
  }
  assert.ok(CONFIG_DIR.endsWith('/.config/focus-nudge'))
})

test('mergeConfig fills gaps from DEFAULTS and keeps overrides', () => {
  const cfg = mergeConfig({ workMinutes: 50, sites: ['x.com'] })
  assert.equal(cfg.workMinutes, 50)
  assert.deepEqual(cfg.sites, ['x.com'])
  assert.equal(cfg.shortBreakMinutes, 5)
  assert.equal(cfg.port, 7373)
})

test('mergeConfig ignores unknown keys and non-objects', () => {
  assert.equal(mergeConfig({ nonsense: 1 }).nonsense, undefined)
  assert.equal(mergeConfig(null).port, 7373)
  assert.equal(mergeConfig('nope').port, 7373)
})
