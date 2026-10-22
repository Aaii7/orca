import type { StructuredAgentSessionLatestRequest } from '../../../shared/structured-agent-session-latest-request'

/** Host-only request identity; it never enters a status or wire frame. */
export type StructuredAgentSessionStatusObserverOptions = {
  replay: boolean
  firstInputSubmissionKey?: string | null
  /** The request the summary's verdict is about, so an observer can read what it left behind. */
  latestRequest?: StructuredAgentSessionLatestRequest | null
}
