import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../daemon/server.js'
import { createLinear } from '../daemon/linear.js'
import { DEFAULTS } from '../daemon/config.js'

// The real Linear client, talking to a scripted fake GraphQL endpoint. Nothing
// here reaches api.linear.app, and the key is a dummy.
const KEY = 'dummy-key-for-tests'

const fake = {
  loseNextReply: false,
  created: [], updates: [], failCreates: 0, failWith: 'getaddrinfo ENOTFOUND api.linear.app', active: [], projectsCalls: 0,
  byId: {},
  reset() { this.byId = {}; this.loseNextReply = false; this.created = []; this.updates = []; this.failCreates = 0; this.failWith = 'getaddrinfo ENOTFOUND api.linear.app'; this.active = []; this.projectsCalls = 0 },
}

async function fakeFetch(url, init) {
  const { query, variables } = JSON.parse(init.body)
  const ok = data => ({ ok: true, status: 200, json: async () => ({ data }) })
  if (query.includes('issueCreate')) {
    if (fake.failCreates > 0) { fake.failCreates--; throw new Error(fake.failWith) }
    const n = 100 + fake.created.length
    // Like Linear: an issue id may only be used once.
    if (variables.input.id && fake.created.some(c => c.id === variables.input.id)) {
      return { ok: true, status: 200, json: async () => ({ errors: [{ message: 'duplicate id' }] }) }
    }
    fake.created.push(variables.input)
    fake.byId[variables.input.id ?? `iss-${n}`] = { id: variables.input.id ?? `iss-${n}`, identifier: `IBR-${n}`, url: `https://linear.app/x/IBR-${n}`, title: variables.input.title, state: { type: 'unstarted', name: 'Todo' } }
    if (fake.loseNextReply) { fake.loseNextReply = false; throw new Error('The operation was aborted due to timeout') }
    return ok({ issueCreate: { success: true, issue: { id: variables.input.id ?? `iss-${n}`, identifier: `IBR-${n}`, url: `https://linear.app/x/IBR-${n}` } } })
  }
  if (query.includes('issueUpdate')) {
    fake.updates.push([variables.id, variables.stateId])
    return ok({ issueUpdate: { success: true } })
  }
  if (query.includes('active:')) {
    const created = Object.values(fake.byId)
    return ok({ active: { nodes: [...fake.active, ...created] }, linked: { nodes: [] } })
  }
  if (query.includes('issue(id')) {
    const i = fake.byId[variables.id]
    return i ? ok({ issue: i }) : { ok: true, status: 200, json: async () => ({ errors: [{ message: 'Entity not found: Issue' }] }) }
  }
  if (query.includes('states {')) {
    return ok({ team: { states: { nodes: [
      { id: 's-todo', name: 'Todo', type: 'unstarted' }, { id: 's-done', name: 'Done', type: 'completed' },
      { id: 's-cancel', name: 'Canceled', type: 'canceled' },
    ] } } })
  }
  if (query.includes('projects')) {
    fake.projectsCalls++
    return ok({ team: { projects: { nodes: [{ id: 'p1', name: 'PCB Startup', state: 'started' }] } } })
  }
  throw new Error('unexpected query')
}

let tmp, handle, base
const errors = []
const realError = console.error

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-linear-'))
  console.error = (...a) => errors.push(a.join(' '))
  handle = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath: path.join(tmp, 'state.json'),
    logPath: path.join(tmp, 'log.jsonl'),
    quotesPath: path.join(tmp, 'quotes.txt'),
    configPath: path.join(tmp, 'config.json'),
    notify: () => {},
    openUrls: () => {},
    linear: createLinear({ apiKey: KEY, teamId: 'team-1', fetch: fakeFetch }),
  })
  base = `http://127.0.0.1:${await handle.listen(0)}`
  await handle.linearIdle()
})

after(() => {
  console.error = realError
  handle.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(async () => {
  await post('/tasks', { action: 'clear' })
  await handle.linearIdle()
  fake.reset()
  errors.length = 0
})

const get = async p => (await fetch(base + p)).text()
const post = async (p, body) =>
  (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
const state = async () => JSON.parse(await get('/state'))

test('adding a task creates the Linear issue in the chosen project and links it', async () => {
  const v = await post('/tasks', { action: 'add', text: 'route the board', project: { id: 'p1', name: 'PCB Startup' } })
  assert.equal(v.linearEnabled, true)
  assert.equal(v.tasks[0].linearPending, true, 'the answer comes back before Linear does')
  await handle.linearIdle()
  // The issue id is chosen here (a UUID) so a retry can never create a second issue.
  assert.equal(fake.created.length, 1)
  const { id, ...rest } = fake.created[0]
  // ...and it is filed in Todo, not the team's default Backlog.
  assert.deepEqual(rest, { teamId: 'team-1', title: 'route the board', projectId: 'p1', stateId: 's-todo' })
  assert.match(id, /^[0-9a-f-]{36}$/)
  const t = (await state()).tasks[0]
  assert.equal(t.linear.identifier, 'IBR-100')
  assert.equal(t.linearPending, false)
  assert.deepEqual(t.project, { id: 'p1', name: 'PCB Startup' })
})

test('with Linear unreachable the task is kept pending, and the next sync links it', async () => {
  fake.failCreates = 1
  await post('/tasks', { action: 'add', text: 'offline task' })
  await handle.linearIdle()
  let t = (await state()).tasks[0]
  assert.equal(t.text, 'offline task', 'the task is never lost')
  assert.equal(t.linearPending, true)
  assert.ok(errors.some(e => e.startsWith('focus-nudge: linear: ')), errors.join('\n'))

  await handle.linearSync()
  t = (await state()).tasks[0]
  assert.equal(t.linear.identifier, 'IBR-100')
  assert.equal(fake.created.length, 1, 'created once, not twice')
})

test('the same Linear error is reported once, not every minute', async () => {
  fake.failCreates = 3
  fake.failWith = 'connect ECONNREFUSED'
  await post('/tasks', { action: 'add', text: 'x' })
  await handle.linearIdle()
  await handle.linearSync()
  await handle.linearSync()
  assert.equal(errors.filter(e => e.includes('ECONNREFUSED')).length, 1)
})

test('ticking a linked task moves the issue to Done and back', async () => {
  const v = await post('/tasks', { action: 'add', text: 'tick me' })
  await handle.linearIdle()
  await post('/tasks', { action: 'toggle', id: v.tasks[0].id })
  await handle.linearIdle()
  await post('/tasks', { action: 'toggle', id: v.tasks[0].id })
  await handle.linearIdle()
  const issue = fake.created[0].id
  assert.deepEqual(fake.updates, [[issue, 's-done'], [issue, 's-todo']])
})

test('removing a linked task cancels its issue in Linear', async () => {
  const v = await post('/tasks', { action: 'add', text: 'drop me' })
  await handle.linearIdle()
  await post('/tasks', { action: 'remove', id: v.tasks[0].id })
  await handle.linearIdle()
  assert.deepEqual(fake.updates, [[fake.created[0].id, 's-cancel']])
})

test('a create whose reply was lost is not created twice, and the task is linked once', async () => {
  fake.loseNextReply = true
  await post('/tasks', { action: 'add', text: 'write report' })
  await handle.linearIdle()
  // Recovered either in the same attempt (getIssue by the chosen id) or by the
  // next sync; both must end with one issue and one linked task.
  await handle.linearSync()
  const tasks = (await state()).tasks
  assert.equal(fake.created.length, 1, 'one issue in Linear')
  assert.equal(tasks.length, 1, 'one task here')
  assert.equal(tasks[0].linearPending, false)
  assert.equal(tasks[0].linear.identifier, 'IBR-100')
})

test('a sync pulls in active Linear issues as tasks', async () => {
  fake.active = [{ id: 'iss-17', identifier: 'IBR-17', url: 'u', title: 'from Linear', state: { type: 'started', name: 'In Progress' } }]
  await handle.linearSync()
  assert.deepEqual((await state()).tasks.map(t => [t.text, t.linear.identifier]), [['from Linear', 'IBR-17']])
})

test('GET /linear lists projects, is cached, and never contains the key', async () => {
  const raw = await get('/linear')
  assert.equal(raw.includes(KEY), false)
  assert.deepEqual(JSON.parse(raw), { enabled: true, projects: [{ id: 'p1', name: 'PCB Startup' }] })
  await get('/linear')
  assert.equal(fake.projectsCalls, 1, 'the second call is served from the cache')
})

test('a daemon with no Linear reports it disabled and never asks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-nolinear-'))
  const h = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath: path.join(dir, 'state.json'),
    logPath: path.join(dir, 'log.jsonl'),
    quotesPath: path.join(dir, 'quotes.txt'),
    configPath: path.join(dir, 'config.json'),
    notify: () => {},
    openUrls: () => {},
  })
  try {
    const b = `http://127.0.0.1:${await h.listen(0)}`
    assert.deepEqual(await (await fetch(b + '/linear')).json(), { enabled: false, projects: [] })
    const v = await (await fetch(b + '/tasks', { method: 'POST', body: JSON.stringify({ action: 'add', text: 'local' }) })).json()
    assert.equal(v.linearEnabled, false)
    assert.equal(v.tasks[0].linearPending, false)
  } finally {
    h.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
