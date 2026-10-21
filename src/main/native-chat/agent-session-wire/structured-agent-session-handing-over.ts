// The sends the host is handing to its child right now: their `dispatch{pending}` row is written
// before the adapter is called, so the child holds them before it can report so (`heldSends`).

import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

/** The chat's journal, which identifies the conversation for as long as it is held. */
type HandoverJournal = object

type Handover = {
  owner: () => void
  unadmitted: boolean
  signal?: AbortSignal
  pending?: () => boolean
}
const handingOver = new WeakMap<HandoverJournal, Map<string, Handover>>()
const NONE: ReadonlySet<string> = new Set()

/** The sends this journal's chat is handing over now. */
export function structuredAgentSessionHandingOver(journal: HandoverJournal): ReadonlySet<string> {
  const sends = handingOver.get(journal)
  return sends ? new Set(sends.keys()) : NONE
}

/** Volatile proof owned by the live handover; a crash or cancellation restores ordinary doubt. */
export function continuingStructuredAgentSessionInput(
  journal: HandoverJournal,
  clientMessageId: string
): boolean {
  const input = handingOver.get(journal)?.get(clientMessageId)
  return input?.unadmitted === true && input.signal?.aborted !== true && input.pending?.() === true
}

export function markStructuredAgentSessionInputUnadmitted(
  journal: Pick<AgentSessionJournal, 'submissions'>,
  clientMessageId: string,
  owner: () => void,
  unadmitted: boolean,
  signal?: AbortSignal
): void {
  const input = handingOver.get(journal)?.get(clientMessageId)
  if (input?.owner === owner) {
    Object.assign(input, {
      unadmitted,
      signal,
      pending: () =>
        journal
          .submissions()
          .some((s) => s.clientMessageId === clientMessageId && s.dispatchState === 'pending')
    })
  }
}

/** Runs one handover with its send counted as held, from before its pending row until the adapter
 *  answered; `released` then republishes what is current, which no row may follow. */
export async function whileStructuredAgentSessionHandingOver<T>(
  journal: HandoverJournal,
  clientMessageId: string,
  handOver: (released: () => void) => Promise<T>,
  workChanged?: () => void
): Promise<T> {
  const released = beginStructuredAgentSessionHandover(journal, clientMessageId, workChanged)
  try {
    return await handOver(released)
  } finally {
    released()
  }
}

/** The same held window across the host's separate pending-row and provider-call steps. */
export function beginStructuredAgentSessionHandover(
  journal: HandoverJournal,
  clientMessageId: string,
  workChanged?: () => void
): () => void {
  let sends = handingOver.get(journal)
  if (!sends) {
    sends = new Map()
    handingOver.set(journal, sends)
  }
  let held = true
  const release = (): void => {
    if (held) {
      held = false
      if (sends.get(clientMessageId)?.owner === release) {
        sends.delete(clientMessageId)
      }
      workChanged?.()
    }
  }
  sends.set(clientMessageId, { owner: release, unadmitted: false })
  return release
}
