// A chat that works a Dispatch and whose request settles failed tells the Run that dispatched it,
// with the error the chat recorded. The task stays with the chat: unlike a terminal that exited,
// the chat is still there and can carry on once whatever stopped it is fixed.
//
// WHY AT THE STATUS EDGE: every agent's turn, refused send and mid-turn death settles into one
// projected verdict, so one observer covers all of them, and no provider's failure writer has to
// remember to report.

import { createHash } from 'node:crypto'
import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { formatOrcaSessionAddress, isOrcaSessionId } from '../../../shared/orca-session-address'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionLatestRequest } from '../../../shared/structured-agent-session-latest-request'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../shared/tui-agent-display-names'
import { resolveStructuredWorkerIdentityForSession } from '../structured-worker-authority'
import { canonicalOrcaSessionId } from './canonical-orca-session-id'
import { chatRequestError, isSenderOwnRejection } from './chat-worker-error-words'
import type { OrchestrationDb } from './db'
import type { DispatchContextRow } from './types'
import { escalateWorkerFailure } from './worker-failure-escalation'

export type ChatWorkerErrorEscalationDeps = {
  /** Chat UI is on and the user left the Orchestration switch on. */
  enabled: () => boolean
  db: () => OrchestrationDb | null
  readJournal: (
    sessionId: string
  ) => Promise<Pick<AgentJournalSnapshot, 'items' | 'submissions'> | null>
  notify: (handle: string, messageType: string) => void
}

/** On while Chat UI is on, unless the user turned the Orchestration switch off. */
export function chatWorkerErrorEscalationEnabled(
  settings:
    | Pick<GlobalSettings, 'experimentalNativeChat' | 'orchestrationChatErrorEscalationEnabled'>
    | undefined
): boolean {
  return (
    settings?.experimentalNativeChat === true &&
    settings.orchestrationChatErrorEscalationEnabled !== false
  )
}

type ChatWorkerDispatch = { dispatch: DispatchContextRow; from: string }

/** The open Dispatch this session works, as a chat assignee or as a structured worker. */
function chatWorkerDispatches(sessionId: string, db: OrchestrationDb): ChatWorkerDispatch[] {
  const found: ChatWorkerDispatch[] = []
  if (isOrcaSessionId(sessionId)) {
    // A `/clear` successor keeps its root's address, so the Dispatch names the root.
    const address = formatOrcaSessionAddress(canonicalOrcaSessionId(sessionId))
    const dispatch = db.getActiveDispatchForTerminal(address)
    if (dispatch) {
      found.push({ dispatch, from: address })
    }
  }
  const worker = resolveStructuredWorkerIdentityForSession(sessionId, db)
  const dispatch = worker && db.getActiveDispatchForTerminal(worker.handle, worker.paneKey)
  if (worker && dispatch && !found.some((entry) => entry.dispatch.id === dispatch.id)) {
    found.push({ dispatch, from: worker.handle })
  }
  return found
}

/** Words for a failure that left no sentence: only a death mid-turn is said to be one, in the words
 *  its settlement row will use once it lands. */
function unrecordedError(summary: Pick<AgentSessionStatusSummary, 'agent' | 'turnOutcome'>): {
  text: string
  kind?: string
  detail?: undefined
} {
  const agentName = isTuiAgent(summary.agent) ? TUI_AGENT_DISPLAY_NAMES[summary.agent] : undefined
  if (summary.turnOutcome === 'interruption') {
    const fact = agentSessionFailureFact('providerExited')
    return {
      text: agentSessionFailureWords(fact, { surface: 'row', ...(agentName ? { agentName } : {}) })
        .text,
      kind: fact.kind
    }
  }
  return {
    text: `${agentName ?? 'The agent'} ended its turn with an error and recorded no message.`
  }
}

/** Stable per failed request, so a republished or restored status sends nothing new. */
function escalationId(
  dispatchId: string,
  request: Pick<StructuredAgentSessionLatestRequest, 'kind' | 'id'>
): string {
  const digest = createHash('sha256')
    .update(`${dispatchId}\0${request.kind}\0${request.id}`)
    .digest('hex')
  return `msg_chaterr_${digest.slice(0, 24)}`
}

async function escalateChatWorkerErrorOnce(
  summary: Pick<AgentSessionStatusSummary, 'sessionId' | 'agent' | 'status' | 'turnOutcome'>,
  options: { replay: boolean; latestRequest?: StructuredAgentSessionLatestRequest | null },
  deps: ChatWorkerErrorEscalationDeps
): Promise<void> {
  const request = options.latestRequest
  // `interruption` is a death nobody asked for; a person's Stop is `cancellation` and stays quiet.
  if (
    options.replay ||
    !request ||
    summary.status !== 'idle' ||
    (summary.turnOutcome !== 'failure' && summary.turnOutcome !== 'interruption') ||
    !deps.enabled()
  ) {
    return
  }
  const db = deps.db()
  const targets = db ? chatWorkerDispatches(summary.sessionId, db) : []
  if (!db || targets.length === 0) {
    return
  }
  // Why a macrotask: Claude settles a failed turn and appends its error row in one call stack, and
  // the status feed does not republish for a row alone, so a read now would miss the sentence.
  await new Promise((resolve) => setImmediate(resolve))
  const snapshot = await deps.readJournal(summary.sessionId)
  const error = snapshot ? chatRequestError(snapshot, request) : null
  if (isSenderOwnRejection(error)) {
    return
  }
  const { text, detail, kind } = error ?? unrecordedError(summary)
  for (const { dispatch, from } of targets) {
    // The journal read awaited: the Dispatch may have settled, or the user turned this off.
    const current = db.getDispatchContextById(dispatch.id)
    if (
      !deps.enabled() ||
      (current?.status !== 'pending' && current?.status !== 'dispatched') ||
      current.assignee_handle !== dispatch.assignee_handle
    ) {
      continue
    }
    escalateWorkerFailure(
      db,
      dispatch,
      {
        id: escalationId(dispatch.id, request),
        from,
        describe: (task) => ({
          subject: `Agent hit an error: ${text.length > 120 ? `${text.slice(0, 119)}…` : text}`,
          body: [
            `Worker ${from} hit an error while running task ${task}.`,
            `Error: ${text}`,
            ...(detail ? [`Details from the agent: ${detail}`] : []),
            'The task is still assigned to this chat, which keeps its history.'
          ].join('\n')
        }),
        payload: {
          taskId: dispatch.task_id,
          dispatchId: dispatch.id,
          handle: from,
          sessionId: summary.sessionId,
          agent: summary.agent,
          turnOutcome: summary.turnOutcome,
          requestId: request.id,
          ...(kind ? { failureKind: kind } : {}),
          error: text,
          ...(detail ? { detail } : {})
        }
      },
      deps.notify
    )
  }
}

/** Never throws: the status observer it rides must not lose its other work to this mail. */
export async function escalateChatWorkerError(
  ...args: Parameters<typeof escalateChatWorkerErrorOnce>
): Promise<void> {
  try {
    await escalateChatWorkerErrorOnce(...args)
  } catch (error) {
    console.warn('[orchestration] chat worker error escalation failed', {
      sessionId: args[0].sessionId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
