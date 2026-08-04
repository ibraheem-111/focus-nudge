import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {
  parseNodeMajor, satisfiesMinNode, interpretIsEnabledOutput,
  classifyUnitEnabled, classifyUnitActive, resolveOnPath, formatLine, runDoctor,
} from '../cli/doctor.js'

// --- parseNodeMajor / satisfiesMinNode --------------------------------
// An old Node passing the version check is exactly the failure mode that
// would waste someone an hour: it installs cleanly and then breaks at
// runtime on `node:test`, global fetch, or AbortSignal.timeout in ways that
// look like bugs in the tool rather than an unmet prerequisite.

test('parseNodeMajor reads the major version out of common formats', () => {
  assert.equal(parseNodeMajor('v22.1.0'), 22)
  assert.equal(parseNodeMajor('22.1.0'), 22)
  assert.equal(parseNodeMajor('v8.0.0'), 8)
  assert.equal(parseNodeMajor('v22.22.3'), 22)
})

test('parseNodeMajor returns null for garbage', () => {
  assert.equal(parseNodeMajor('nope'), null)
  assert.equal(parseNodeMajor(''), null)
  assert.equal(parseNodeMajor(undefined), null)
  assert.equal(parseNodeMajor(null), null)
})

test('satisfiesMinNode accepts >= 22 and rejects below it', () => {
  assert.equal(satisfiesMinNode('v22.0.0').ok, true)
  assert.equal(satisfiesMinNode('v22.22.3').ok, true)
  assert.equal(satisfiesMinNode('v23.0.0').ok, true)
  assert.equal(satisfiesMinNode('v21.9.0').ok, false)
  assert.equal(satisfiesMinNode('v16.20.0').ok, false)
  assert.equal(satisfiesMinNode('garbage').ok, false)
})

test('satisfiesMinNode reports the parsed major alongside the verdict', () => {
  assert.equal(satisfiesMinNode('v22.1.0').major, 22)
  assert.equal(satisfiesMinNode('not-a-version').major, null)
})

test('satisfiesMinNode honours a custom minimum', () => {
  assert.equal(satisfiesMinNode('v18.0.0', 18).ok, true)
  assert.equal(satisfiesMinNode('v18.0.0', 20).ok, false)
})

// --- interpretIsEnabledOutput / classify* ------------------------------
// `systemctl --user is-enabled` prints the literal "not-found" when the unit
// file was never installed at all — that has to read differently from
// "disabled" (installed, just not enabled) or doctor cannot tell "never ran
// install.sh" apart from "installed but stopped it".

test('interpretIsEnabledOutput treats "not-found" as not installed', () => {
  const r = interpretIsEnabledOutput('not-found\n')
  assert.equal(r.installed, false)
  assert.equal(r.state, 'not-found')
})

test('interpretIsEnabledOutput treats empty output as not installed', () => {
  assert.equal(interpretIsEnabledOutput('').installed, false)
  assert.equal(interpretIsEnabledOutput(undefined).installed, false)
})

test('interpretIsEnabledOutput treats any other state as installed', () => {
  for (const state of ['enabled', 'disabled', 'static', 'masked']) {
    const r = interpretIsEnabledOutput(`${state}\n`)
    assert.equal(r.installed, true, `${state} should count as installed`)
    assert.equal(r.state, state)
  }
})

test('classifyUnitEnabled is ok only for "enabled"', () => {
  assert.equal(classifyUnitEnabled('enabled'), 'ok')
  assert.equal(classifyUnitEnabled('disabled'), 'warn')
  assert.equal(classifyUnitEnabled('static'), 'warn')
})

test('classifyUnitActive is ok only for "active"', () => {
  assert.equal(classifyUnitActive('active'), 'ok')
  assert.equal(classifyUnitActive('inactive'), 'fail')
  assert.equal(classifyUnitActive('failed'), 'fail')
})

// --- resolveOnPath ------------------------------------------------------

test('resolveOnPath finds an executable in a PATH-like string', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-path-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const bin = path.join(dir, 'focus')
  fs.writeFileSync(bin, '#!/bin/sh\necho hi\n')
  fs.chmodSync(bin, 0o755)

  const found = resolveOnPath('focus', `/no/such/dir${path.delimiter}${dir}`)
  assert.equal(found, bin)
})

test('resolveOnPath returns null when nothing on PATH matches', () => {
  assert.equal(resolveOnPath('definitely-not-a-real-binary-xyz', '/no/such/dir'), null)
})

test('resolveOnPath skips a same-named file that is not executable', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-path-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const notExec = path.join(dir, 'focus')
  fs.writeFileSync(notExec, 'not executable')
  fs.chmodSync(notExec, 0o644)

  assert.equal(resolveOnPath('focus', dir), null)
})

// --- formatLine ----------------------------------------------------------

test('formatLine tags ok/warn/FAIL distinctly and includes the label', () => {
  assert.match(formatLine('ok', 'thing', 'detail'), /ok.*thing.*detail/)
  assert.match(formatLine('warn', 'thing', 'detail'), /warn.*thing.*detail/)
  assert.match(formatLine('fail', 'thing', 'detail'), /FAIL.*thing.*detail/)
})

test('formatLine omits the trailing detail when none is given', () => {
  assert.equal(formatLine('ok', 'thing', ''), '[ ok ] thing')
})

// --- runDoctor end to end, against scratch fixtures only ------------------
// These never touch ~/.config/focus-nudge and never run install.sh or touch
// systemd. They only prove the orchestration (a) doesn't crash on a missing
// config dir and (b) correctly reports a wrong port as unreachable.

test('runDoctor reports a FAIL and exits 1 when nothing is listening on the configured port', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-doctor-'))
  const lines = []
  const code = await runDoctor({
    config: { port: 1 }, // port 1 is a privileged port nothing here is bound to
    repoRoot: dir,
    paths: {
      dir: path.join(dir, 'config'),
      files: {
        'config.json': path.join(dir, 'config', 'config.json'),
        'quotes.txt': path.join(dir, 'config', 'quotes.txt'),
        'state.json': path.join(dir, 'config', 'state.json'),
        'log.jsonl': path.join(dir, 'config', 'log.jsonl'),
      },
    },
    log: line => lines.push(line),
  })
  t_cleanup(dir)
  assert.equal(code, 1, lines.join('\n'))
  assert.ok(lines.some(l => l.includes('FAIL') && l.includes('port listening')), lines.join('\n'))
  assert.ok(lines.some(l => l.includes('FAIL') && l.includes('GET /state')), lines.join('\n'))
  // must not have crashed reporting a missing config dir — a warn, not a throw
  assert.ok(lines.some(l => l.includes('config dir')), lines.join('\n'))
})

test('runDoctor reports ok for port listening and GET /state against a real scratch server', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-doctor-'))
  const server = http.createServer((req, res) => {
    if (req.url === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') }
    else { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const lines = []
  const code = await runDoctor({
    config: { port },
    repoRoot: dir,
    paths: {
      dir: path.join(dir, 'config'),
      files: {
        'config.json': path.join(dir, 'config', 'config.json'),
        'quotes.txt': path.join(dir, 'config', 'quotes.txt'),
        'state.json': path.join(dir, 'config', 'state.json'),
        'log.jsonl': path.join(dir, 'config', 'log.jsonl'),
      },
    },
    log: line => lines.push(line),
  })
  server.close()
  t_cleanup(dir)

  assert.ok(lines.some(l => l.includes('[ ok ] port listening')), lines.join('\n'))
  assert.ok(lines.some(l => l.includes('[ ok ] GET /state')), lines.join('\n'))
  // whatever the local machine's systemd/PATH state is, it must not be the
  // reason this test fails — only the port/state checks are asserted above.
  assert.equal(typeof code, 'number')
})

function scratchPaths(dir) {
  return {
    dir: path.join(dir, 'config'),
    files: {
      'config.json': path.join(dir, 'config', 'config.json'),
      'quotes.txt': path.join(dir, 'config', 'quotes.txt'),
      'state.json': path.join(dir, 'config', 'state.json'),
      'log.jsonl': path.join(dir, 'config', 'log.jsonl'),
    },
  }
}

// --- sound reporting ----------------------------------------------------
// `focus doctor` must say whether sounds are enabled, which names are
// configured, and whether those names actually exist in the theme — but a
// missing theme file is a warn (themes vary machine to machine), never a FAIL.

test('runDoctor reports sounds enabled and the configured names', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-doctor-'))
  const lines = []
  await runDoctor({
    config: { port: 1, sounds: { enabled: true, workEnd: 'alarm-clock-elapsed', breakEnd: 'complete' } },
    repoRoot: dir,
    paths: scratchPaths(dir),
    log: line => lines.push(line),
  })
  t_cleanup(dir)
  assert.ok(lines.some(l => l.includes('sounds enabled') && l.includes('ok')), lines.join('\n'))
  assert.ok(lines.some(l => l.includes('workEnd') && l.includes('alarm-clock-elapsed')), lines.join('\n'))
  assert.ok(lines.some(l => l.includes('breakEnd') && l.includes('complete')), lines.join('\n'))
})

test('runDoctor warns, but does not FAIL, when a configured sound file is missing from the theme', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-doctor-'))
  const lines = []
  const code = await runDoctor({
    config: { port: 1, sounds: { enabled: true, workEnd: 'not-a-real-sound-xyz', breakEnd: 'complete' } },
    repoRoot: dir,
    paths: scratchPaths(dir),
    log: line => lines.push(line),
  })
  t_cleanup(dir)
  assert.ok(
    lines.some(l => l.includes('warn') && l.includes('workEnd') && l.includes('not-a-real-sound-xyz')),
    lines.join('\n'),
  )
  assert.ok(
    !lines.some(l => l.includes('FAIL') && l.includes('workEnd')),
    'a missing theme file must warn, not fail — themes vary across machines',
  )
})

test('runDoctor reports ok for a sound name that exists in the theme', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-doctor-'))
  const lines = []
  await runDoctor({
    config: { port: 1, sounds: { enabled: true, workEnd: 'alarm-clock-elapsed', breakEnd: 'complete' } },
    repoRoot: dir,
    paths: scratchPaths(dir),
    log: line => lines.push(line),
  })
  t_cleanup(dir)
  const workLine = lines.find(l => l.includes('workEnd'))
  assert.ok(workLine, lines.join('\n'))
  assert.match(workLine, /\[ ok \]/)
})

test('runDoctor reports sounds disabled without failing the run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-doctor-'))
  const lines = []
  await runDoctor({
    config: { port: 1, sounds: { enabled: false, workEnd: 'alarm-clock-elapsed', breakEnd: 'complete' } },
    repoRoot: dir,
    paths: scratchPaths(dir),
    log: line => lines.push(line),
  })
  t_cleanup(dir)
  assert.ok(
    lines.some(l => l.includes('sounds enabled') && (l.includes('warn') || l.includes('off'))),
    lines.join('\n'),
  )
})

function t_cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}
