// A zero-dependency client for the few Linear GraphQL calls the daemon makes.
// Only server.js uses it — core.js stays pure and asks for Linear work through
// declarative effects. `fetch` is injectable so no test ever reaches the real API.
//
// The API key is a secret in a PUBLIC repo's working tree. It goes into the
// Authorization header and nowhere else: error messages are scrubbed of it, and
// nothing here logs or returns it.
import fs from 'node:fs'
import path from 'node:path'

const ENDPOINT = 'https://api.linear.app/graphql'
const TIMEOUT_MS = 10_000

// The repo's .env, next to package.json. The systemd unit sets no environment,
// so this is where the daemon finds the key in practice.
export const REPO_ENV_FILE = path.join(import.meta.dirname, '..', '.env')

// The states the user actively works from. Backlog is deliberately left out:
// it is a parking lot, and pulling it in would bury the micro-task list.
export const ACTIVE_STATE_NAMES = ['Todo', 'In Progress', 'In Review']

export function loadLinearKey({ env = process.env, envFile = REPO_ENV_FILE } = {}) {
  if (typeof env.LINEAR_API_KEY === 'string' && env.LINEAR_API_KEY.trim()) return env.LINEAR_API_KEY.trim()
  let text
  try { text = fs.readFileSync(envFile, 'utf8') } catch { return null }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(?:export\s+)?LINEAR_API_KEY\s*=\s*(.*)$/)
    if (!m) continue
    const value = m[1].trim().replace(/^(['"])(.*)\1$/, '$2').trim()
    return value || null
  }
  return null
}

const ISSUE_FIELDS = 'id identifier url title state { type name }'

export function createLinear({ apiKey, teamId, fetch = globalThis.fetch }) {
  const scrub = msg => String(msg).split(apiKey).join('[redacted]')

  async function gql(query, variables = {}) {
    let res
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: apiKey },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      throw new Error(`linear unreachable: ${scrub(err.message)}`)
    }
    let body = null
    try { body = await res.json() } catch {}
    if (!res.ok) throw new Error(`linear http ${res.status}`)
    if (body?.errors?.length) {
      throw new Error(`linear: ${scrub(body.errors.map(e => e.message).join('; '))}`)
    }
    if (!body?.data) throw new Error('linear: empty response')
    return body.data
  }

  let stateIds = null
  async function resolveStates() {
    if (stateIds) return stateIds
    const data = await gql(
      'query($team: String!) { team(id: $team) { states { nodes { id name type } } } }',
      { team: teamId },
    )
    const nodes = data.team?.states?.nodes ?? []
    const done = nodes.find(s => s.type === 'completed')
    const todo = nodes.find(s => s.type === 'unstarted' && s.name === 'Todo') ?? nodes.find(s => s.type === 'unstarted')
    const canceled = nodes.find(s => s.type === 'canceled')
    if (!done || !todo || !canceled) throw new Error('linear: team has no completed, unstarted or canceled state')
    stateIds = { done: done.id, todo: todo.id, canceled: canceled.id }
    return stateIds
  }

  async function moveTo(issueId, stateId) {
    const data = await gql(
      'mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }',
      { id: issueId, stateId },
    )
    if (!data.issueUpdate?.success) throw new Error('linear: issueUpdate did not succeed')
  }

  return {
    async createIssue({ title, projectId = null }) {
      const input = { teamId, title }
      if (projectId) input.projectId = projectId
      const data = await gql(
        'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }',
        { input },
      )
      const issue = data.issueCreate?.issue
      if (!data.issueCreate?.success || !issue) throw new Error('linear: issueCreate did not succeed')
      return { id: issue.id, identifier: issue.identifier, url: issue.url }
    },

    async setDone(issueId, done) {
      const ids = await resolveStates()
      await moveTo(issueId, done ? ids.done : ids.todo)
    },

    // The task was removed in focus-nudge. Canceled, not deleted: it stays
    // findable in Linear and can be reopened there.
    async cancel(issueId) {
      await moveTo(issueId, (await resolveStates()).canceled)
    },

    // Every active issue in the team, plus the issues already linked to a task
    // whatever their state — that is how a completion in Linear is noticed.
    async activeIssues(extraIds = []) {
      const data = await gql(
        `query($team: ID!, $states: [String!], $ids: [ID!]) {
          active: issues(first: 100, filter: { team: { id: { eq: $team } }, state: { name: { in: $states } } }) { nodes { ${ISSUE_FIELDS} } }
          linked: issues(first: 100, filter: { id: { in: $ids } }) { nodes { ${ISSUE_FIELDS} } }
        }`,
        { team: teamId, states: ACTIVE_STATE_NAMES, ids: extraIds },
      )
      const seen = new Map()
      for (const n of [...(data.active?.nodes ?? []), ...(data.linked?.nodes ?? [])]) {
        if (seen.has(n.id)) continue
        seen.set(n.id, { id: n.id, identifier: n.identifier, url: n.url, title: n.title, stateType: n.state?.type ?? null })
      }
      return [...seen.values()]
    },

    async projects() {
      const data = await gql(
        'query($team: String!) { team(id: $team) { projects(first: 100) { nodes { id name state } } } }',
        { team: teamId },
      )
      return (data.team?.projects?.nodes ?? [])
        .filter(p => p.state !== 'completed' && p.state !== 'canceled')
        .map(p => ({ id: p.id, name: p.name }))
    },
  }
}
