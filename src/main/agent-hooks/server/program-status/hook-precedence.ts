import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import type { EnrichedAgentHookEventPayload } from '../server-types'

/** Hook silence, while OSC 7501 disagrees, before OSC 7501 takes the pane. Why minutes: a long
 *  tool call sends no hooks but leaves the program's state unchanged, so only old disagreement counts. */
export const HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS = 2 * 60 * 1000

/** Whether an OSC 7501 projection must leave the pane's hook row alone: hooks carry richer identity,
 *  so they win until silent on a state they no longer describe. A later hook event hands it back.
 *  `programWorkingSince`: when the program last entered `working` (ProgramStatusFacetStore). */
export function programStatusYieldsToHookRow(
  previous: EnrichedAgentHookEventPayload | undefined,
  payload: ParsedAgentStatusPayload,
  now: number,
  programWorkingSince?: number
): boolean {
  if (previous?.observation?.origin !== 'hook' || previous.providerSessionOnly === true) {
    return false
  }
  const sameAgent =
    payload.agentType === undefined || payload.agentType === previous.payload.agentType
  // A different app after the hook agent finished is a new program in the pane. Mid-turn, the hook
  // row still wins over another app id: forks report upstream's app (OpenClaude says claude-code).
  if (!sameAgent && previous.payload.state === 'done') {
    return false
  }
  // Hooks fall silent after a settled turn by design, so only the program's new work since outranks
  // them; a block it reports without any rides its facet (resolveProgramStatusPresentation).
  if (
    previous.payload.state === 'done' &&
    payload.state !== 'working' &&
    !(programWorkingSince !== undefined && programWorkingSince > previous.receivedAt)
  ) {
    return true
  }
  const hookSilentForMs = now - previous.receivedAt
  return (
    payload.state === previous.payload.state ||
    hookSilentForMs < HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS
  )
}
