import type { AgentSessionDispatchOutcome } from './structured-agent-session-adapter'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'

export type StructuredAgentSessionInputAdmission =
  | { kind: 'prepare' }
  | { kind: 'acquire' }
  | { kind: 'sent'; response: Promise<unknown> }

/** The synchronous writer runs under host ordering; its response is awaited outside it. */
export type StructuredAgentSessionAdmitFreshInput = (
  enqueue: (
    mode: AgentChatPermissionMode,
    inheritRunning: boolean,
    body?: AgentJournalMessageItem
  ) => StructuredAgentSessionInputAdmission,
  signal?: AbortSignal
) => Promise<StructuredAgentSessionInputAdmission>

/** Host-local control, never a provider failure or a replay of a possibly written request. */
export class StructuredAgentSessionInputNotAdmitted extends Error {
  constructor(readonly outcome?: Extract<AgentSessionDispatchOutcome, { state: 'rejected' }>) {
    super('input was not admitted')
  }
}
