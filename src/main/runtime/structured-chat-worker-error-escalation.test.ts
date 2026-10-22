import './rpc/unused-default-rpc-methods.test-fixture'
// A chat working a Dispatch whose turn fails tells the coordinator's Run, once, in the chat's own
// words, and keeps the task.

import { describe, expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../shared/orca-session-address'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  call,
  coordinatorRunAndTask,
  db,
  host,
  openChat,
  runtime
} from './structured-chat-coordinator-mail-rig.test-fixture'

const WORKER = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))
const CAPACITY = 'Selected model is at capacity.'

/** Dispatch the coordinator's task to the worker chat, whose first turn then fails as Codex fails. */
async function dispatchAndFailWorkerTurn(): Promise<{ runId: string; dispatchId: string }> {
  await openChat(COORDINATOR)
  const worker = await openChat(PEER_CHAT)
  const { runId, taskId } = await coordinatorRunAndTask()
  const dispatched = call(
    'orchestration.dispatch',
    { task: taskId, to: WORKER, inject: true },
    { sessionId: COORDINATOR }
  )
  await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
  const turn = worker.turns[0]!
  const notify = (method: string, params: unknown) =>
    worker.handlers.onNotification?.(method, params)
  notify('turn/started', { turn: { id: 'turn-1' } })
  notify('item/completed', {
    item: {
      type: 'userMessage',
      id: `echo-${turn.clientUserMessageId}`,
      clientId: turn.clientUserMessageId,
      content: [{ type: 'text', text: 'task' }]
    }
  })
  notify('error', {
    threadId: worker.threadId,
    turnId: 'turn-1',
    willRetry: false,
    error: { message: CAPACITY }
  })
  notify('turn/completed', { turn: { id: 'turn-1', status: 'failed' } })
  await host.flushStreamedEvents(PEER_CHAT)
  return { runId, dispatchId: idOf((await dispatched).dispatch) }
}

function escalationsTo(runId: string) {
  return db.db
    .prepare(`SELECT * FROM messages WHERE to_handle = ? AND type = 'escalation'`)
    .all(`run:${runId}`) as { body: string; payload: string }[]
}

describe('a chat worker whose turn fails', () => {
  it('tells the Run that dispatched it, once, with the error the chat shows, and keeps the task', async () => {
    vi.spyOn(runtime, 'isChatWorkerErrorEscalationEnabled').mockReturnValue(true)
    const { runId, dispatchId } = await dispatchAndFailWorkerTurn()

    await vi.waitFor(() => expect(escalationsTo(runId)).toHaveLength(1), WAIT)
    const [escalation] = escalationsTo(runId)
    expect(escalation!.body).toContain(`Error: ${CAPACITY}`)
    expect(JSON.parse(escalation!.payload)).toMatchObject({ dispatchId, error: CAPACITY })
    expect(db.getDispatchContextById(dispatchId)).toMatchObject({ status: 'dispatched' })

    // The same failure seen again (a republished status, a restart) is not news.
    runtime.onStructuredSessionStatusForErrorMail(
      { sessionId: PEER_CHAT, agent: 'codex', status: 'idle', turnOutcome: 'failure' } as never,
      {
        replay: false,
        latestRequest: {
          kind: 'turn',
          id: JSON.parse(escalation!.payload).requestId,
          turnState: 'completed',
          outcome: 'failure',
          settledAt: 1
        }
      }
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(escalationsTo(runId)).toHaveLength(1)
  })

  it('sends nothing while the Orchestration switch is off', async () => {
    vi.spyOn(runtime, 'isChatWorkerErrorEscalationEnabled').mockReturnValue(false)
    const { runId } = await dispatchAndFailWorkerTurn()

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(escalationsTo(runId)).toHaveLength(0)
  })
})
