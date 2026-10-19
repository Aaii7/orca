import { activeProviderContext } from '../../../shared/agent-session-provider-context'
// Attach: reserve the session record, then open its journal.
//
// `create` and `ensure` are the same transition with a different starting
// point — a null expected fence means "no session exists yet". Both go through
// the record store's compare-and-swap, which also owns the idempotency row, so
// a retried attach replays instead of reserving a second owner.

import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type {
  StructuredAgentId,
  AgentSessionProviderHandle,
  AgentSessionProviderHandleLink
} from '../../../shared/agent-session-provider-handle'
import {
  agentSessionProviderHandleBelongsTo,
  agentSessionProviderHandleFromWire,
  type AgentSessionWireProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'
import type {
  AgentSessionAccountHome,
  AgentSessionExecutionLocation,
  AgentSessionLaunchArgs,
  AgentSessionLaunchEnv,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import {
  AgentSessionRefusalError,
  agentSessionRefusalFromReference,
  agentSessionRefusalReference,
  isAgentSessionWireRefusalCode,
  refuse,
  type AgentSessionMutationEnvelope,
  type AgentSessionRefusalReference,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import {
  agentSessionFingerprintConflict,
  computeAgentSessionPayloadFingerprint
} from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { structuredAgentSessionRefusalMessage } from './structured-agent-session-refusal-message'

/**
 * Everything a client may declare about the session it wants. Deliberately no
 * spawn token, claim key, or owner probe: those are host observations, and a
 * client that could assert "the previous owner is dead" could steal a live
 * session. The host fills them in.
 */
export type AgentSessionAttachParams = {
  envelope: AgentSessionMutationEnvelope
  location: AgentSessionExecutionLocation
  provider: StructuredAgentId
  agent: StructuredAgentId
  accountHome: AgentSessionAccountHome
  /** Always `native`; kept on the params because the operation fingerprint covers it. */
  runtimeKind: 'native'
  /** Host-resolved defaults for a create-by-intent; remote attach schemas do not accept them. */
  options?: Readonly<Record<string, string>>
  /** The tab id a create reserves for this chat, taken when its tab is published. Never on the
   *  attach fingerprint: which tab shows the chat is not which conversation it attaches to. */
  surfaceTabId?: string
  launchArgs?: string[]
  /** Omitted only for create-by-intent; the adapter proves the durable handle. In the wire's
   *  form, because the attach fingerprint covers it as the client sent it. */
  providerHandle?: AgentSessionWireProviderHandle
  /**
   * Host-resolved only. Present when this create adopts an existing provider conversation rather
   * than starting one: it seeds the handle chain so the adapter resumes instead of creating, and
   * names the transcript to import so the journal shows the conversation so far.
   *
   * Deliberately separate from `providerHandle`, which `agentSession.ensure` already supplies
   * without adopting — presence of a handle must never be what triggers a resume.
   */
  adopt?: {
    providerHandle: AgentSessionProviderHandle
    /** Omitted only when the exact committed operation replays an already-imported journal. */
    transcriptPath?: string
    source?: { providerSessionId: string; workspaceCwd: string }
  }
}

/** Host-supplied half of the reservation. */
export type AgentSessionAttachAuthority = {
  launchDirectory?: string
  spawnToken: string | (() => string)
  claimKeyId: string
  handoffOperationId: string | null
  probe: AgentSessionOwnerProbe
  launchArgs?: AgentSessionLaunchArgs
  launchEnv?: AgentSessionLaunchEnv
}

/** The fields that define WHICH session this call would attach to. Deliberately
 *  excludes the spawn token and the probe: those differ between a first attempt
 *  and its retry, and a retry must replay rather than conflict. `options` is
 *  excluded for the same reason — it is the session's initial state, not its
 *  identity, and the host re-resolves it from settings the user may have changed
 *  between an unknown-outcome attempt and its retry. */
export function attachFingerprintFields(params: AgentSessionAttachParams): Record<string, unknown> {
  return {
    location: params.location,
    provider: params.provider,
    agent: params.agent,
    accountHome: params.accountHome,
    runtimeKind: params.runtimeKind,
    providerHandle: params.providerHandle,
    // Which conversation this attaches to, so an adopting create and a blank one never share an
    // identity. The transcript path is excluded: it is where the host found that conversation this
    // time, not part of what the caller asked for.
    adoptedProviderHandle: params.adopt?.providerHandle,
    expectedRuntimeFence: params.envelope.expectedRuntimeFence
  }
}

/** Recomputes the fingerprint the client declared and refuses a mismatch before
 *  anything reaches the store. */
export function admitAttachOrRefuse(
  params: AgentSessionAttachParams
): { ok: true; fingerprint: string } | { ok: false; refusal: AgentSessionWireRefusal } {
  // The start check judges the record's agent and the router starts `agent`'s adapter: one agent.
  if (params.agent !== params.provider) {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'requestMalformed' },
        `A ${params.provider} session cannot be started as ${params.agent}.`
      )
    }
  }
  if (
    params.providerHandle &&
    !agentSessionProviderHandleBelongsTo(
      agentSessionProviderHandleFromWire(params.providerHandle),
      params.provider
    )
  ) {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'requestMalformed' },
        `A ${params.provider} session requires a ${params.provider} provider handle.`
      )
    }
  }
  const fingerprint = computeAgentSessionPayloadFingerprint({
    method: 'agentSession.attach',
    sessionId: params.envelope.sessionId,
    fields: attachFingerprintFields(params)
  })
  const conflict = agentSessionFingerprintConflict(params.envelope, fingerprint)
  return conflict ? { ok: false, refusal: conflict } : { ok: true, fingerprint }
}

export function journalIdentityFor(
  record: AgentSessionRecord,
  params: AgentSessionAttachParams
): AgentSessionJournalIdentity {
  const active = activeProviderContext(record)
  const head = active.head
  const providerHandle =
    head?.handle ??
    (!active.pendingClear && params.providerHandle
      ? agentSessionProviderHandleFromWire(params.providerHandle)
      : null)
  return {
    sessionId: record.sessionId,
    workspaceId: params.location.workspaceId,
    hostId: params.location.executionHostId,
    agent: params.agent,
    providerHandle
  }
}

export type AttachedJournal = {
  journal: AgentSessionJournal
  /** Submissions the crash boundary left `unknown`; kept on the wire for older peers. */
  unconfirmedClientMessageIds: string[]
}

/**
 * The conversation's journal, opened — and its crash boundary settled — by the conversation's own
 * open. A send the boundary could only doubt stays `unknown`: whether the provider took it is never
 * inferred from provider history, since absence from a log Orca does not own proves nothing.
 */
export async function attachJournal(input: {
  record: AgentSessionRecord
  /** The host's open conversation, whose journal the attach adopts. */
  openConversation: (record: AgentSessionRecord) => Promise<AgentSessionJournal>
}): Promise<AttachedJournal> {
  const journal = await input.openConversation(input.record)
  return {
    journal,
    unconfirmedClientMessageIds: journal
      .submissions()
      .filter((entry) => entry.dispatchState === 'unknown' && entry.recovered === true)
      .map((entry) => entry.clientMessageId)
  }
}

/**
 * The first link of an adopting session's chain.
 *
 * `adopted` is the only origin besides `created` a chain will accept at its head, and it is the
 * honest one here: this session did not create the conversation. The adapter appends its own
 * `resumed` link once the provider proves the same identity root — or, when it proves the identical
 * handle at the same fence, the validator elides that as a retry and this link stays the head.
 */
const ADOPTED_HANDLE_FENCE = 1

function adoptedProviderHandleLink(
  handle: AgentSessionProviderHandle,
  observedAt: number
): AgentSessionProviderHandleLink {
  return {
    // A link id is a bounded slug; Pi's native id is a file path.
    linkId: `${handle.agent}-${ADOPTED_HANDLE_FENCE}-${handle.nativeId}`
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .slice(0, 128),
    handle,
    origin: 'adopted',
    mintedAtFence: ADOPTED_HANDLE_FENCE,
    observedAt
  }
}

export function reserveRequestFor(input: {
  sessionId: string
  params: AgentSessionAttachParams
  authority: AgentSessionAttachAuthority
  callerKey: string
  fingerprint: string
  now: number
}): Parameters<AgentSessionRecordStore['reserveOwner']>[0] {
  const { params, authority } = input
  return {
    sessionId: input.sessionId,
    location: params.location,
    provider: params.provider,
    accountHome: params.accountHome,
    ...(params.options ? { options: params.options } : {}),
    ...(params.envelope.expectedRuntimeFence === null && params.surfaceTabId
      ? { surfaceTabId: params.surfaceTabId }
      : {}),
    ...(authority.launchArgs ? { launchArgs: authority.launchArgs } : {}),
    ...(authority.launchEnv ? { launchEnv: authority.launchEnv } : {}),
    ...(authority.launchDirectory ? { launchDirectory: authority.launchDirectory } : {}),
    ...(params.adopt
      ? {
          // Fence 1 is a new record's first, and the owner probe requires the head link to carry
          // the record's current fence.
          adoptedHandleLink: adoptedProviderHandleLink(params.adopt.providerHandle, input.now)
        }
      : {}),
    expectedFence: params.envelope.expectedRuntimeFence,
    spawnToken: authority.spawnToken,
    claimKeyId: authority.claimKeyId,
    handoffOperationId: authority.handoffOperationId,
    probe: authority.probe,
    operation: {
      callerKey: input.callerKey,
      operationId: params.envelope.clientOperationId,
      fingerprint: input.fingerprint
    },
    now: input.now
  }
}

/** The store signals refusals by throwing the refusal code. Anything not in the
 *  known set is a defect, not a client error, and is rethrown. */
export function classifyStoreFailure(
  error: unknown,
  currentFence: number | null,
  record: AgentSessionRecord | null = null
): AgentSessionWireRefusal {
  const rawCode = error instanceof Error ? error.message : String(error)
  if (!isAgentSessionWireRefusalCode(rawCode)) {
    throw error
  }
  // A refusal error's message is its code, so its details are this code's.
  const emitted: AgentSessionRefusalReference =
    error instanceof AgentSessionRefusalError
      ? agentSessionRefusalReference(error.refusal)
      : { code: rawCode }
  // Why: a latched session is exactly where a bare store code strands the user.
  const told = structuredAgentSessionRefusalMessage(emitted, record)
  const reference = told?.reference ?? emitted
  return agentSessionRefusalFromReference(
    reference.code === 'agent_session_checkpoint_stale' && currentFence !== null
      ? { code: reference.code, details: { ...reference.details, currentFence } }
      : reference,
    told?.message ?? `The session store refused this call: ${rawCode}.`
  )
}
