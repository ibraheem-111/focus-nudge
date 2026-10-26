import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLinear, loadLinearKey } from '../daemon/linear.js'

// Never the real API: every test hands createLinear a fake fetch that records
// the request and answers from a script. The key below is a dummy.
const KEY = 'dummy-key-for-tests'
const TEAM = 'team-1'

function fakeFetch(answer) {
  const calls = []
  const fn = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, headers: init.headers, body })
    const out = await answer(body, calls.length)
    return {
      ok: out.status === undefined || out.status < 400,
      status: out.status ?? 200,
      json: async () => out.json ?? out,
    }
  }
  fn.calls = calls
  return fn
}

test('requests go to the GraphQL endpoint with the raw key, no Bearer prefix', async () => {
  const fetch = fakeFetch(() => ({ data: { team: { projects: { nodes: [] } } } }))
  await createLinear({ apiKey: KEY, teamId: TEAM, fetch }).projects()
  assert.equal(fetch.calls[0].url, 'https://api.linear.app/graphql')
  assert.equal(fetch.calls[0].headers.Authorization, KEY)
  assert.equal(fetch.calls[0].headers['content-type'], 'application/json')
})

test('createIssue sends the title, team and project and returns the link', async () => {
  const fetch = fakeFetch(() => ({
    data: { issueCreate: { success: true, issue: { id: 'iss-1', identifier: 'IBR-40', url: 'https://linear.app/x/IBR-40' } } },
  }))
  const out = await createLinear({ apiKey: KEY, teamId: TEAM, fetch })
    .createIssue({ title: 'read the PX4 paper', projectId: 'proj-9' })
  assert.deepEqual(out, { id: 'iss-1', identifier: 'IBR-40', url: 'https://linear.app/x/IBR-40' })
  assert.deepEqual(fetch.calls[0].body.variables.input, { teamId: TEAM, title: 'read the PX4 paper', projectId: 'proj-9' })
})

test('createIssue without a project sends no projectId', async () => {
  const fetch = fakeFetch(() => ({
    data: { issueCreate: { success: true, issue: { id: 'i', identifier: 'IBR-1', url: 'u' } } },
  }))
  await createLinear({ apiKey: KEY, teamId: TEAM, fetch }).createIssue({ title: 't', projectId: null })
  assert.equal('projectId' in fetch.calls[0].body.variables.input, false)
})

test('GraphQL errors throw, and the message never contains the key', async () => {
  const fetch = fakeFetch(() => ({ errors: [{ message: `bad thing for ${KEY}` }] }))
  await assert.rejects(
    createLinear({ apiKey: KEY, teamId: TEAM, fetch }).projects(),
    err => {
      assert.equal(err.message.includes(KEY), false, 'the key is redacted')
      assert.match(err.message, /bad thing/)
      return true
    },
  )
})

test('an HTTP failure throws', async () => {
  const fetch = fakeFetch(() => ({ status: 401, json: { errors: [{ message: 'auth' }] } }))
  await assert.rejects(createLinear({ apiKey: KEY, teamId: TEAM, fetch }).projects(), /401/)
})

test('a failed issueCreate throws rather than returning nothing', async () => {
  const fetch = fakeFetch(() => ({ data: { issueCreate: { success: false, issue: null } } }))
  await assert.rejects(createLinear({ apiKey: KEY, teamId: TEAM, fetch }).createIssue({ title: 't' }))
})

const STATES = { data: { team: { states: { nodes: [
  { id: 's-backlog', name: 'Backlog', type: 'backlog' },
  { id: 's-todo', name: 'Todo', type: 'unstarted' },
  { id: 's-prog', name: 'In Progress', type: 'started' },
  { id: 's-done', name: 'Done', type: 'completed' },
  { id: 's-cancel', name: 'Canceled', type: 'canceled' },
] } } } }

test('setDone moves the issue to the completed state, and back to Todo', async () => {
  const fetch = fakeFetch(body =>
    body.query.includes('states') ? STATES : { data: { issueUpdate: { success: true } } })
  const linear = createLinear({ apiKey: KEY, teamId: TEAM, fetch })
  await linear.setDone('iss-1', true)
  await linear.setDone('iss-1', false)
  const updates = fetch.calls.filter(c => c.body.query.includes('issueUpdate'))
  assert.deepEqual(updates.map(c => [c.body.variables.id, c.body.variables.stateId]),
    [['iss-1', 's-done'], ['iss-1', 's-todo']])
  assert.equal(fetch.calls.filter(c => c.body.query.includes('states')).length, 1, 'state ids are cached')
})

test('activeIssues returns active and linked issues, deduplicated', async () => {
  const issue = (id, type) => ({ id, identifier: `IBR-${id}`, url: `u/${id}`, title: `t${id}`, state: { type, name: type } })
  const fetch = fakeFetch(() => ({ data: {
    active: { nodes: [issue('1', 'started'), issue('2', 'unstarted')] },
    linked: { nodes: [issue('2', 'unstarted'), issue('3', 'completed')] },
  } }))
  const out = await createLinear({ apiKey: KEY, teamId: TEAM, fetch }).activeIssues(['2', '3'])
  assert.deepEqual(out.map(i => [i.id, i.stateType]), [['1', 'started'], ['2', 'unstarted'], ['3', 'completed']])
  assert.deepEqual(out[0], { id: '1', identifier: 'IBR-1', url: 'u/1', title: 't1', stateType: 'started' })
  const vars = fetch.calls[0].body.variables
  assert.equal(vars.team, TEAM)
  assert.deepEqual(vars.ids, ['2', '3'])
  assert.deepEqual(vars.states, ['Todo', 'In Progress', 'In Review'])
})

test('projects lists only projects that are still open', async () => {
  const fetch = fakeFetch(() => ({ data: { team: { projects: { nodes: [
    { id: 'p1', name: 'EEE 598', state: 'backlog' },
    { id: 'p2', name: 'Old', state: 'completed' },
    { id: 'p3', name: 'Dead', state: 'canceled' },
    { id: 'p4', name: 'PCB Startup', state: 'started' },
  ] } } } }))
  assert.deepEqual(await createLinear({ apiKey: KEY, teamId: TEAM, fetch }).projects(),
    [{ id: 'p1', name: 'EEE 598' }, { id: 'p4', name: 'PCB Startup' }])
})

test('loadLinearKey prefers the environment', () => {
  assert.equal(loadLinearKey({ env: { LINEAR_API_KEY: 'from-env' }, envFile: '/nonexistent' }), 'from-env')
})

test('loadLinearKey parses a .env file, ignoring comments and quotes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-env-'))
  try {
    const file = path.join(dir, '.env')
    fs.writeFileSync(file, '# a comment\nOTHER=1\nLINEAR_API_KEY="quoted-key"\n')
    assert.equal(loadLinearKey({ env: {}, envFile: file }), 'quoted-key')
    fs.writeFileSync(file, "LINEAR_API_KEY='single'\n")
    assert.equal(loadLinearKey({ env: {}, envFile: file }), 'single')
    fs.writeFileSync(file, 'LINEAR_API_KEY=\n')
    assert.equal(loadLinearKey({ env: {}, envFile: file }), null, 'an empty value is no key')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('loadLinearKey returns null when there is no key anywhere', () => {
  assert.equal(loadLinearKey({ env: {}, envFile: '/nonexistent/.env' }), null)
})
