import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULTS, PATHS, CONFIG_DIR, mergeConfig, loadConfig, saveConfig, writeAtomic,
} from '../daemon/config.js'

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

test('writeAtomic writes the file and leaves no temp file behind', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-cfg-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'thing.json')
  writeAtomic(file, '{"a":1}')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}')
  assert.deepEqual(fs.readdirSync(dir), ['thing.json'], 'the .tmp file was renamed, not left')
})

test('writeAtomic overwrites an existing file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-cfg-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'thing.json')
  writeAtomic(file, 'first')
  writeAtomic(file, 'second')
  assert.equal(fs.readFileSync(file, 'utf8'), 'second')
})

test('saveConfig then loadConfig round-trips through a scratch path', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-cfg-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'nested', 'config.json')
  saveConfig({ ...DEFAULTS, workMinutes: 50 }, file)
  assert.equal(loadConfig(file).workMinutes, 50, 'saveConfig creates parent dirs and loadConfig reads back')
})

test('loadConfig falls back to DEFAULTS for a missing file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-cfg-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  assert.deepEqual(loadConfig(path.join(dir, 'nope.json')), DEFAULTS)
})

test('loadConfig falls back to DEFAULTS for malformed json', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-cfg-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, '{ not json')
  assert.deepEqual(loadConfig(file), DEFAULTS)
})

test('loadConfig fills partial config from DEFAULTS', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-cfg-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, JSON.stringify({ port: 9999 }))
  const cfg = loadConfig(file)
  assert.equal(cfg.port, 9999)
  assert.equal(cfg.workMinutes, 25, 'gaps come from DEFAULTS')
})
