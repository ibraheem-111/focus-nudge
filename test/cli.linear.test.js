import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createServer } from '../daemon/server.js'
import { DEFAULTS } from '../daemon/config.js'

// Same scratch-HOME arrangement as cli.test.js, with a daemon that has a fake
// Linear client. Nothing reaches api.linear.app or ~/.config/focus-nudge.
const CLI = path.join(import.meta.dirname, '..', 'cli', 'focus')

const created = []
const fakeLinear = {
  projects: async () => [
    { id: 'p-pcb', name: 'PCB Startup' },
    { id: 'p-eee', name: 'EEE 598 Reinforcement Learning for Robots' },
    { id: 'p-everything', name: 'Everything' },
    { id: 'p-ras', name: 'RAS 556 System Control and Optimization' },
  ],
  createIssue: async ({ title, projectId }) => {
    created.push({ title, projectId })
    return { id: `iss-${created.length}`, identifier: `IBR-${99 + created.length}`, url: 'u' }
  },
  activeIssues: async () => [],
  setDone: async () => {},
  cancel: async () => {},
}

let home, tmp, handle

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-cli-linear-'))
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
    linear: fakeLinear,
  })
  const port = await handle.listen(0)
  fs.writeFileSync(path.join(home, '.config', 'focus-nudge', 'config.json'), JSON.stringify({ ...DEFAULTS, port }))
})

after(() => {
  handle.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function focus(...args) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home } },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }))
  })
}

test('task --project files the issue under the project named by a prefix, any case', async () => {
  const { code } = await focus('task', 'route', 'the', 'board', '--project', 'pcb')
  assert.equal(code, 0)
  await handle.linearIdle()
  assert.deepEqual(created.at(-1), { title: 'route the board', projectId: 'p-pcb' })
})

test('the task list shows the Linear identifier after a linked task', async () => {
  await handle.linearIdle()
  const { stdout } = await focus('task')
  assert.match(stdout, /route the board\s+IBR-100/)
})

test('an unknown project prefix exits 1 and lists the projects', async () => {
  const before = created.length
  const { code, stderr } = await focus('task', 'x', '--project', 'nope')
  assert.equal(code, 1)
  assert.match(stderr, /PCB Startup/)
  assert.match(stderr, /Everything/)
  await handle.linearIdle()
  assert.equal(created.length, before, 'no task, no issue')
})

test('an ambiguous project prefix exits 1 naming the matches', async () => {
  const { code, stderr } = await focus('task', 'x', '--project', 'e')
  assert.equal(code, 1)
  assert.match(stderr, /EEE 598/)
  assert.match(stderr, /Everything/)
  assert.doesNotMatch(stderr, /PCB/)
})

test('--project with no name is a usage error', async () => {
  const { code, stderr } = await focus('task', 'x', '--project')
  assert.equal(code, 1)
  assert.match(stderr, /--project/)
})
