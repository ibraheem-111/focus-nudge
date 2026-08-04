import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createServer } from '../daemon/server.js'
import { DEFAULTS } from '../daemon/config.js'

// The CLI is a separate process that finds its port through loadConfig, which
// builds its path from os.homedir(). os.homedir() honours $HOME on Linux, so
// pointing HOME at a scratch directory gives the CLI a scratch config and a
// scratch daemon. Nothing here can reach ~/.config/focus-nudge, and no second
// daemon is ever started on the real port 7373.
const CLI = path.join(import.meta.dirname, '..', 'cli', 'focus')

let home
let tmp
let handle

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-cli-'))
  home = path.join(tmp, 'home')
  fs.mkdirSync(path.join(home, '.config', 'focus-nudge'), { recursive: true })

  handle = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath: path.join(tmp, 'state.json'),
    logPath: path.join(tmp, 'log.jsonl'),
    quotesPath: path.join(tmp, 'quotes.txt'),
    configPath: path.join(tmp, 'config.json'),
    notify: () => {},
    openUrls: () => {},
  })
  const port = await handle.listen(0)
  fs.writeFileSync(
    path.join(home, '.config', 'focus-nudge', 'config.json'),
    JSON.stringify({ ...DEFAULTS, port }),
  )
})

after(() => {
  handle.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

// Resolves rather than rejecting on a non-zero exit: the exit code is the thing
// under test in most of these.
function focus(...args) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home } },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }))
  })
}

test('the scratch CLI really is talking to the scratch daemon', async () => {
  const { code, stdout } = await focus('status')
  assert.equal(code, 0)
  assert.match(stdout, /idle|work/, `got ${JSON.stringify(stdout)}`)
})

test('focus sites lists the watched domains', async () => {
  const { code, stdout } = await focus('sites')
  assert.equal(code, 0)
  for (const s of DEFAULTS.sites) assert.ok(stdout.includes(s), `${s} missing from the listing`)
})

// `focus sites add com` printed the unchanged list and exited 0, looking exactly
// like success. The popup has compared the before/after count since its own
// review; the CLI never got it.
test('a rejected sites add fails loudly and keeps what was typed visible', async () => {
  const { code, stderr } = await focus('sites', 'add', 'com')
  assert.notEqual(code, 0, 'a rejected add must not exit 0')
  assert.match(stderr, /not added/)
  assert.match(stderr, /"com"/, 'what the user typed stays visible so it can be corrected')
})

test('a genuine sites add still succeeds quietly', async () => {
  const { code, stdout, stderr } = await focus('sites', 'add', 'news.ycombinator.com')
  assert.equal(code, 0, `stderr: ${stderr}`)
  assert.ok(stdout.includes('news.ycombinator.com'))

  // And adding it a second time is a rejection, because nothing changed.
  const again = await focus('sites', 'add', 'news.ycombinator.com')
  assert.notEqual(again.code, 0, 'a duplicate add is not a silent success either')
  assert.match(again.stderr, /already be listed/)
})

test('a sites remove that matches nothing fails loudly', async () => {
  const { code, stderr } = await focus('sites', 'remove', 'nosuchdomain.test')
  assert.notEqual(code, 0)
  assert.match(stderr, /not removed/)
})

test('sites add or remove with no domain is a usage error', async () => {
  for (const sub of ['add', 'remove']) {
    const { code, stderr } = await focus('sites', sub)
    assert.notEqual(code, 0, `sites ${sub} with no domain must not exit 0`)
    assert.match(stderr, /which domain/)
  }
})

// `focus task done` with no id sent id: NaN, which JSON.stringify writes as null.
// The daemon matched no task, returned the unchanged state with a 200, and the CLI
// printed the list as though it had ticked something off.
test('task done with no id is a usage error, not a silent no-op', async () => {
  for (const sub of ['done', 'toggle', 'rm', 'remove']) {
    const { code, stderr } = await focus('task', sub)
    assert.notEqual(code, 0, `task ${sub} with no id must not exit 0`)
    assert.match(stderr, /needs a task id/)
  }
})

test('task done with a non-numeric id is a usage error too', async () => {
  for (const bad of ['abc', '1.5', '-2', '0', 'NaN', '']) {
    const { code, stderr } = await focus('task', 'done', bad)
    assert.notEqual(code, 0, `task done ${JSON.stringify(bad)} must not exit 0`)
    assert.match(stderr, /needs a task id/)
  }
})

test('task add then task done by id still works end to end', async () => {
  const added = await focus('task', 'write the regression test')
  assert.equal(added.code, 0, `stderr: ${added.stderr}`)
  assert.match(added.stdout, /\[ \] \d+  write the regression test/)

  const id = added.stdout.match(/\[ \] (\d+)  write the regression test/)[1]
  const done = await focus('task', 'done', id)
  assert.equal(done.code, 0, `stderr: ${done.stderr}`)
  assert.match(done.stdout, new RegExp(`\\[x\\] ${id}  write the regression test`))
})

test('an unknown task id is reported rather than passing silently', async () => {
  // A well-formed id that matches nothing is still a no-op in the daemon, but the
  // user asked about a specific task, so the CLI must not imply it ticked it off.
  const { stdout } = await focus('task', 'done', '99999')
  assert.equal(stdout.includes('[x] 99999'), false, 'nothing was ticked off')
})

test('an unknown command exits non-zero with a pointer to --help', async () => {
  const { code, stderr } = await focus('wat')
  assert.notEqual(code, 0)
  assert.match(stderr, /unknown command/)
  assert.match(stderr, /--help/)
})

test('focus --help mentions every command it documents', async () => {
  const { code, stdout } = await focus('--help')
  assert.equal(code, 0)
  for (const cmd of ['status', 'start', 'pause', 'skip', 'stop', 'break', 'off', 'task', 'sites', 'queue', 'stats']) {
    assert.ok(stdout.includes(cmd), `${cmd} missing from the help text`)
  }
})

test('focus --help documents that phase-end notifications play a sound, and where to configure it', async () => {
  const { code, stdout } = await focus('--help')
  assert.equal(code, 0)
  assert.match(stdout, /sound/i, 'help text should mention sound notifications')
  assert.match(stdout, /config\.json/, 'help text should point at where sounds are configured')
})

test('the CLI sends no Origin, so the daemon serves it', async () => {
  // The Origin guard added for the cross-origin hole must not lock out the CLI.
  const { code, stdout } = await focus('status')
  assert.equal(code, 0, 'the CLI is not treated as a hostile caller')
  assert.ok(stdout.trim().length > 0)
})

test('focus off rejects a duration it cannot read', async () => {
  const { code, stderr } = await focus('off', 'sometime')
  assert.notEqual(code, 0)
  assert.match(stderr, /could not read that duration/)
})

test('focus stats prints the block totals it derives from the log', async () => {
  const { code, stdout } = await focus('stats')
  assert.equal(code, 0)
  assert.match(stdout, /today/)
  assert.match(stdout, /last 7 days/)
  assert.match(stdout, /all time/)
})
