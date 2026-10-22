import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { formatOrcaSessionAddress } from '../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { createTrackedJournalOpener } from '../../native-chat/agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import type { JournalLifecycleMutationInput } from '../../native-chat/agent-session-journal/journal-row-builders'
import { StructuredAgentSessionConversations } from '../../native-chat/agent-session-wire/structured-agent-session-conversations'
import { StructuredAgentSessionRequestFailures } from '../../native-chat/agent-session-wire/structured-agent-session-request-failures'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionEndedChild
} from '../../native-chat/agent-session-wire/structured-agent-session-host-types'
import {
  hostTestAttachParams,
  hostTestMessage
} from '../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { recordingStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { escalateChatWorkerError } from './chat-worker-error-escalation'

const SESSION = testOrcaSessionId('7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64')
const journals = createTrackedJournalOpener()
const roots: string[] = []
const databases: OrchestrationDb[] = []
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
afterEach(async () => {
  vi.restoreAllMocks()
  await tick()
  await journals.closeAll()
  for (const database of databases.splice(0)) {
    database.close()
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function rig() {
  const root = await mkdtemp(join(tmpdir(), 'orca-pr31941-requests-'))
  roots.push(root)
  const journal = await journals.open({
    stateDirectory: root,
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'host-1',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    }
  })
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const run = db.createRun({
    objective: 'ship',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_coordinator:11111111-1111-4111-8111-111111111111'
  })
  const assign = () =>
    createRootDispatch(
      db,
      db.createTask({ spec: 'work', runId: run.id }).id,
      formatOrcaSessionAddress(SESSION)
    )
  let dispatch = assign()
  let enabled = true
  const notify = vi.fn()
  const deliver = vi.fn()
  const sessions = new StructuredAgentSessionConversations({
    deliver,
    now: () => 0,
    logger: recordingStructuredAgentSessionLogger().logger,
    observe: (...args) => observer.observe(...args),
    forget: (id) => observer.forget(id)
  })
  const observer = new StructuredAgentSessionRequestFailures({
    sessions,
    onFailure: (failure) => {
      void escalateChatWorkerError(failure, { db: () => db, enabled: () => enabled, notify })
    }
  })
  const session: StructuredAgentSessionHostSession = {
    journal,
    params: hostTestAttachParams(null),
    child: null
  }
  sessions.set(SESSION, session)
  return {
    journal,
    observer,
    sessions,
    session,
    db,
    notify,
    deliver,
    mail: () => db.getUnreadRunMailbox(run.id, 100, ['escalation']),
    enabled: (value: boolean) => {
      enabled = value
    },
    dispatch: () => dispatch,
    unassign: () => db.completeDispatch(dispatch.id),
    reassign: () => {
      db.completeDispatch(dispatch.id)
      dispatch = assign()
    }
  }
}

function mutation(
  id: string,
  body: AgentJournalItemBody,
  turnId?: string
): JournalLifecycleMutationInput {
  return {
    kind: 'item',
    itemId: id,
    body,
    turnScope: turnId ? { kind: 'turn', turnItemId: turnId } : AGENT_JOURNAL_THREAD_SCOPE
  }
}
const turn = (id: string, outcome: 'failure' | 'success'): JournalLifecycleMutationInput =>
  mutation(id, { kind: 'turn', turnId: id, state: 'completed', outcome })
const words = (id: string, text: string): JournalLifecycleMutationInput =>
  mutation(`error:${id}`, { kind: 'status', tone: 'error', text }, id)
async function batch(
  journal: AgentSessionJournal,
  id: string,
  mutations: JournalLifecycleMutationInput[]
) {
  await journal.appendLifecycleBatch({ settlementId: id, fence: 0, mutations })
}

it('captures every failed request before latest-only publication, despite owed work and pending prompts', async () => {
  const r = await rig()
  await r.journal.appendSubmission({
    clientMessageId: 'owed',
    payloadFingerprint: 'owed',
    body: hostTestMessage('next'),
    fence: 0
  })
  const held: (() => void)[] = []
  const queued = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
    held.push(callback)
  })
  try {
    await batch(r.journal, 'A', [
      turn('A', 'failure'),
      words('A', 'capacity A'),
      {
        ...mutation('child-prompt', {
          kind: 'approval',
          title: 'Run?',
          detail: null,
          options: [{ id: 'yes', label: 'Allow' }],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        }),
        linkage: { agentId: 'child-1' }
      }
    ])
    await batch(r.journal, 'B', [turn('B', 'success')])
    await batch(r.journal, 'C+D', [
      turn('C', 'failure'),
      mutation(
        'quota:C',
        {
          kind: 'status',
          tone: 'warning',
          text: 'quota C',
          failure: { kind: 'usageLimitReached' }
        },
        'C'
      ),
      turn('D', 'failure'),
      words('D', 'quota D')
    ])
  } finally {
    queued.mockRestore()
  }
  expect(held).toHaveLength(1)
  held.forEach((callback) => callback())
  await tick()
  expect(r.mail().map((m) => JSON.parse(m.payload ?? '{}').error)).toEqual([
    'capacity A',
    'quota C',
    'quota D'
  ])
  expect(r.db.getDispatchContextById(r.dispatch().id)?.status).toBe('dispatched')
  // Refusing bookkeeping never changes the durable next-send path.
  r.notify.mockImplementation(() => {
    throw new Error('notification unavailable')
  })
  const longError = 'Provider returned a detailed failure sentence. '.repeat(50)
  await batch(r.journal, 'E', [turn('E', 'failure'), words('E', longError)])
  await tick()
  expect(r.mail().at(-1)?.body).toContain(longError)
  await r.journal.appendSubmission({
    clientMessageId: 'after',
    payloadFingerprint: 'after',
    body: hostTestMessage('recover'),
    fence: 0
  })
  expect(r.journal.submission('after')?.dispatchState).toBe('pending')
})

it('consumes disabled/unassigned failures and baselines adoption, epoch replacement and changed assignments', async () => {
  const r = await rig()
  r.sessions.delete(SESSION)
  await batch(r.journal, 'saved-history', [
    ...Array.from({ length: 2_000 }, (_, index) =>
      mutation(`history:${index}`, { kind: 'status', text: `saved output ${index}` })
    ),
    turn('saved-failure', 'failure'),
    words('saved-failure', 'historic error')
  ])
  r.sessions.set(SESSION, r.session)
  const deltaQuery = vi.spyOn(r.journal, 'readSince')
  r.enabled(false)
  await batch(r.journal, 'old', [turn('old', 'failure'), words('old', 'old error')])
  r.unassign()
  r.enabled(true)
  await batch(r.journal, 'unassigned', [
    turn('unassigned', 'failure'),
    words('unassigned', 'no assignment')
  ])
  r.reassign()
  r.observer.observe(SESSION, r.journal)
  r.sessions.delete(SESSION)
  r.sessions.set(SESSION, r.session)
  await r.journal.replaceEpochItems('handle_forked', 0, [])
  await tick()
  expect(r.mail()).toHaveLength(0)
  await batch(r.journal, 'new', [turn('new', 'failure'), words('new', 'new error')])
  r.reassign() // The captured assignment ended before the deferred read.
  await tick()
  expect(r.mail()).toHaveLength(0)
  await batch(r.journal, 'fresh', [turn('fresh', 'failure'), words('fresh', 'fresh error')])
  await tick()
  expect(r.mail()).toHaveLength(1)
  expect(r.mail()[0]?.body).toContain('fresh error')
  await batch(r.journal, 'clear-context', [
    mutation('clear', {
      kind: 'status',
      text: 'Cleared',
      contextClear: { operationId: 'clear-1', afterFence: 0, clearedAt: 1 }
    })
  ])
  await batch(r.journal, 'new-context', [
    turn('post-clear', 'failure'),
    words('post-clear', 'new context error')
  ])
  await tick()
  expect(r.mail()).toHaveLength(2)
  expect(r.mail()[1]?.body).toContain('new context error')
  expect(deltaQuery).not.toHaveBeenCalled()
})

it('normalizes linked refused starts, reads explicitly scoped late words past a newer turn and retains hostStopped', async () => {
  const r = await rig()
  await r.journal.appendSubmission({
    clientMessageId: 'start',
    payloadFingerprint: 'start',
    body: hostTestMessage('start'),
    fence: 0
  })
  const identity = {
    provider: 'codex' as const,
    threadId: 'thread-1',
    turnId: 'start-turn',
    ordinal: 0
  }
  const started = await r.journal.appendItem(
    identity,
    { kind: 'turn', turnId: 'start-turn', state: 'running' },
    { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await r.journal.appendLifecycleBatch({
    settlementId: 'failed-start',
    fence: 0,
    dispatches: [
      {
        clientMessageId: 'start',
        fence: 0,
        state: 'rejected',
        reason: 'specific refusal',
        rejection: { kind: 'providerRejected' },
        answeredInTurn: { turn: identity, via: 'start' }
      }
    ],
    mutations: [turn(started.itemId, 'failure'), turn('newer', 'success')]
  })
  await batch(r.journal, 'late', [words(started.itemId, 'precise saved sentence')])
  await tick()
  expect(r.mail()).toHaveLength(1)
  expect(r.mail()[0]?.body).toContain('Error: precise saved sentence')
  expect(r.mail()[0]?.body).toContain('Details from the agent: specific refusal')
  await r.journal.appendSubmission({
    clientMessageId: 'hung',
    payloadFingerprint: 'hung',
    body: hostTestMessage('hung'),
    fence: 0
  })
  await r.journal.resolveDispatch({
    clientMessageId: 'hung',
    fence: 0,
    state: 'rejected',
    reason: 'startup watchdog stopped Codex',
    rejection: { kind: 'hostStopped' },
    recovered: true
  })
  await tick()
  expect(r.mail()).toHaveLength(2)
  await batch(r.journal, 'off-at-read', [
    turn('off-at-read', 'failure'),
    words('off-at-read', 'muted before read')
  ])
  r.enabled(false)
  await tick()
  expect(r.mail()).toHaveLength(2)
})

it('announces proven live death before cleanup, deduplicates settlement, and excludes requested or unproven ends', async () => {
  const r = await rig()
  const ended = (
    cause: StructuredAgentSessionEndedChild['cause'],
    rootGone = true,
    fence = 0
  ): StructuredAgentSessionEndedChild => ({
    generation: 'generation-1',
    fence,
    cause,
    rootGone,
    reason: null,
    duringStartup: false,
    endedAt: r.journal.cursor()
  })
  for (const cause of ['user-close', 'evict', 'context-clear', 'user-stop'] as const) {
    for (const withRow of [false, true]) {
      const requestId = `${cause}:${withRow}`
      await batch(r.journal, `running-${cause}-${withRow}`, [
        mutation(requestId, { kind: 'turn', turnId: requestId, state: 'running' }),
        ...(withRow ? [words(requestId, 'old error row')] : [])
      ])
      r.session.lastEndedChild = ended(cause)
      r.observer.generationEnded(SESSION)
      await batch(r.journal, `closed-${cause}-${withRow}`, [
        mutation(requestId, { kind: 'turn', turnId: requestId, state: 'interrupted' })
      ])
    }
  }
  await batch(r.journal, 'running-stopped', [
    mutation('stopped', { kind: 'turn', turnId: 'stopped', state: 'running' })
  ])
  await r.journal.appendStopEvent({ reason: 'user-stop', turnId: 'stopped' }, 0)
  r.session.lastEndedChild = ended('exit')
  r.observer.generationEnded(SESSION)
  await batch(r.journal, 'settled-stopped', [
    mutation('stopped', { kind: 'turn', turnId: 'stopped', state: 'interrupted' })
  ])
  await batch(r.journal, 'running-dead', [
    mutation('dead', { kind: 'turn', turnId: 'dead', state: 'running' })
  ])
  r.session.lastEndedChild = ended('exit', false)
  r.observer.generationEnded(SESSION)
  r.session.lastEndedChild = ended('exit', true, 9)
  r.observer.generationEnded(SESSION)
  await tick()
  expect(r.mail()).toHaveLength(0)
  r.session.lastEndedChild = ended('exit')
  r.observer.generationEnded(SESSION)
  // Cleanup has not written anything: the original running row is still durable.
  await tick()
  expect(r.mail()).toHaveLength(1)
  expect(r.mail()[0]?.body).toContain('Codex')
  await batch(r.journal, 'cleanup', [
    mutation('dead', { kind: 'turn', turnId: 'dead', state: 'interrupted' }),
    words('dead', 'exit detail')
  ])
  await tick()
  expect(r.mail()).toHaveLength(1) // Late-diagnostic policy is deliberately pending.
})
