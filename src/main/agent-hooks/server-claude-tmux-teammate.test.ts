import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import type { probeAgentProcessPresence } from '../../shared/agent-process-presence-probe'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const probe = vi.hoisted(() => vi.fn<typeof probeAgentProcessPresence>(async () => 'live'))
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))

const servers: AgentHookServer[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  probe.mockReset().mockResolvedValue('live')
})

const LEAD = { pid: 4001, session: 'lead-session' }
const TEAMMATE = { pid: 4002, session: 'teammate-session' }

async function post(
  server: AgentHookServer,
  sender: typeof LEAD,
  payload: Record<string, unknown>
): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody(
      { session_id: sender.session, ...payload },
      {
        agentProcess: JSON.stringify({
          pid: sender.pid,
          platform: 'linux',
          startTime: `birth-${sender.pid}`
        })
      }
    )
  )
  expect(response.status).toBe(204)
}

function paneState(server: AgentHookServer): string | undefined {
  return server.getStatusSnapshot().find((row) => row.paneKey === PANE)?.state
}

async function leadAsksQuestion(server: AgentHookServer): Promise<void> {
  await post(server, LEAD, { hook_event_name: 'SessionStart', source: 'startup' })
  await post(server, LEAD, { hook_event_name: 'UserPromptSubmit', prompt: 'Spawn a teammate' })
  const ask = { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_ask' }
  await post(server, LEAD, { hook_event_name: 'PreToolUse', ...ask })
  await post(server, LEAD, { hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion' })
}

// #30833: a tmux teammate runs in Claude's own tmux server, inheriting the lead pane's ORCA_PANE_KEY.
describe('Claude tmux teammate hooks on the lead pane', () => {
  it('keeps the lead waiting on its question while the teammate process runs tools', async () => {
    const server = new AgentHookServer()
    servers.push(server)
    await server.start({ env: 'production' })
    await leadAsksQuestion(server)
    expect(paneState(server)).toBe('waiting')

    const teammate = { agent_type: 'general-purpose' }
    await post(server, TEAMMATE, {
      hook_event_name: 'SessionStart',
      source: 'startup',
      ...teammate
    })
    for (const id of ['toolu_1', 'toolu_2']) {
      const bash = { ...teammate, tool_name: 'Bash', tool_use_id: id }
      await post(server, TEAMMATE, { hook_event_name: 'PreToolUse', ...bash })
      expect(paneState(server)).toBe('waiting')
      await post(server, TEAMMATE, { hook_event_name: 'PostToolUse', ...bash })
      expect(paneState(server)).toBe('waiting')
    }
    await post(server, TEAMMATE, { hook_event_name: 'Stop', ...teammate })
    await post(server, TEAMMATE, { hook_event_name: 'TeammateIdle', teammate_name: 'worker' })
    expect(paneState(server)).toBe('waiting')

    await post(server, LEAD, {
      hook_event_name: 'PostToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_ask'
    })
    expect(paneState(server)).toBe('working')
  })

  it('keeps the dead lead exit when only its teammate ends afterwards', async () => {
    const server = new AgentHookServer()
    servers.push(server)
    await server.start({ env: 'production' })
    const attachedAt = Date.now() - 1
    await leadAsksQuestion(server)
    probe.mockResolvedValue('exited')

    await post(server, TEAMMATE, { hook_event_name: 'SessionEnd', reason: 'other' })
    expect(await server.checkAgentPresenceSince(PANE, attachedAt)).toBe('exited')
  })
})
