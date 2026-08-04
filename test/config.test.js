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
  // Deliberately widened from ['reddit.com', 'youtube.com']: those two were the
  // shipped default while the author actually watches four domains, so a lost or
  // unreadable config.json silently stopped nudging half of them. Kept as an
  // exact-contents assertion so the list cannot drift unnoticed again.
  assert.deepEqual(DEFAULTS.sites, ['reddit.com', 'youtube.com', 'x.com', 'instagram.com'])
  assert.deepEqual(DEFAULTS.sounds, {
    enabled: true,
    workEnd: 'alarm-clock-elapsed',
    breakEnd: 'complete',
  })
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

// `sounds` is nested config, not a flat scalar like `port` or `workMinutes`. The
// generic per-key loop above copies a present key WHOLESALE — fine for a number,
// but for `sounds` it means a user who wrote only `{ sounds: { enabled: false } }`
// to silence notifications would lose workEnd/breakEnd entirely, since nothing
// else fills them back in. core.js would then read `config.sounds.workEnd` as
// undefined and hand notify-send a sound-less hint it never asked to omit.
// Decision: shallow-merge `sounds` against DEFAULTS.sounds, one key at a time,
// exactly like mergeConfig already does for the top level — a partial override
// should only touch what it names.
test('mergeConfig fills gaps in a partial sounds object from DEFAULTS.sounds', () => {
  const cfg = mergeConfig({ sounds: { enabled: false } })
  assert.equal(cfg.sounds.enabled, false)
  assert.equal(cfg.sounds.workEnd, DEFAULTS.sounds.workEnd, 'workEnd still comes from defaults')
  assert.equal(cfg.sounds.breakEnd, DEFAULTS.sounds.breakEnd, 'breakEnd still comes from defaults')
})

test('mergeConfig keeps a fully-specified sounds override intact', () => {
  const cfg = mergeConfig({ sounds: { enabled: true, workEnd: 'bell', breakEnd: 'message' } })
  assert.deepEqual(cfg.sounds, { enabled: true, workEnd: 'bell', breakEnd: 'message' })
})

test('mergeConfig ignores an unknown key inside a partial sounds object', () => {
  const cfg = mergeConfig({ sounds: { enabled: false, volume: 11 } })
  assert.equal(cfg.sounds.volume, undefined, 'unknown sub-keys are dropped, same as the top level')
})

test('mergeConfig falls back to DEFAULTS.sounds for a malformed sounds value', () => {
  assert.deepEqual(mergeConfig({ sounds: 'nope' }).sounds, DEFAULTS.sounds)
  assert.deepEqual(mergeConfig({ sounds: null }).sounds, DEFAULTS.sounds)
  assert.deepEqual(mergeConfig({ sounds: [] }).sounds, DEFAULTS.sounds)
  assert.deepEqual(mergeConfig({ sounds: 42 }).sounds, DEFAULTS.sounds)
})

test('mergeConfig with no sounds key at all uses DEFAULTS.sounds', () => {
  assert.deepEqual(mergeConfig({}).sounds, DEFAULTS.sounds)
  assert.deepEqual(mergeConfig({ port: 1 }).sounds, DEFAULTS.sounds)
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
