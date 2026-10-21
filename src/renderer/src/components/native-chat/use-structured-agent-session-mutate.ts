// One structured-session mutation, fenced and idempotent.
//
// Every call is its own action with its own client operation id, so a press is never answered
// from an earlier one. The host answers a second Stop of a named turn or task quietly; against an
// older host that does not, this client joins one still on its way instead of stopping twice.
// Command replies settle independently of provider generations; only late pane presentation expires.

import { useCallback, useLayoutEffect, useRef } from 'react'
import { toast } from 'sonner'
import type { AgentSessionMutationResult } from '../../../../shared/agent-session-wire'
import {
  agentSessionRefusalFailure,
  agentSessionThrownFailure,
  agentSessionWriteKindForMethod as writeKind,
  type AgentSessionWriteFailure
} from '../../../../shared/agent-session-write-failure'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/structured-agent-session-mutation'
import { structuredSessionOperationId } from './structured-agent-session-operation-id'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import {
  callStructuredAgentSession,
  supportsStructuredAgentSessionQuietRepeatedStop
} from '@/runtime/structured-agent-session-client'
import { structuredAgentSessionHostKey } from '@/runtime/structured-agent-session-host-capability'
import { agentSessionWriteFailureText } from './agent-session-write-notice-text'

export type StructuredAgentSessionWriteOutcome<T> =
  | { kind: 'done'; value: T }
  /** Refused or failed, with what to tell the person and the fact it was worded from. */
  | { kind: 'not-done'; notice: string; failure: AgentSessionWriteFailure }
  /** Not dispatched, or a joined duplicate Stop whose failure was already reported. */
  | { kind: 'dropped' }

type WriteArgs = [method: string, fingerprintMethod: string, fields: Record<string, unknown>]

export type StructuredAgentSessionWrite = <T>(
  ...args: WriteArgs
) => Promise<StructuredAgentSessionWriteOutcome<T>>

/** A write whose failure is shown as a toast; the control that sent it is the way to try again. */
export type StructuredAgentSessionMutate = <T>(...args: WriteArgs) => Promise<T | null>

/** Captures the issuing pane visit for late presentation, never command or draft settlement. */
export type CaptureStructuredAgentSessionPresentation = () => () => boolean

/** A Stop naming its turn or task; one naming neither acts on whatever runs when the host reaches
 *  it, so a second press is a Stop of its own. */
function namesWhatItStops(fingerprintMethod: string, fields: Record<string, unknown>): boolean {
  if (fingerprintMethod !== 'agentSession.cancel') {
    return false
  }
  return fields.scope === 'background-tasks'
    ? fields.taskId !== undefined
    : fields.turnId !== undefined
}

function notDone(
  failure: AgentSessionWriteFailure,
  fingerprintMethod: string,
  fields: Record<string, unknown>,
  agentName: string | undefined
): { kind: 'not-done'; notice: string; failure: AgentSessionWriteFailure } {
  return {
    kind: 'not-done',
    notice: agentSessionWriteFailureText(
      failure,
      writeKind(fingerprintMethod, fields),
      agentName ? { agentName } : {}
    ),
    failure
  }
}

export function useStructuredAgentSessionMutate(args: {
  sessionId: string
  target: RuntimeClientTarget
  enabled?: boolean
  /** Capture the original press fence for host admission, including older hosts. */
  stateRef: { current: { fence: number | null } }
  /** The chat's agent, which a refusal about it names. */
  agentName?: string
}): {
  write: StructuredAgentSessionWrite
  mutate: StructuredAgentSessionMutate
  capturePresentation: CaptureStructuredAgentSessionPresentation
} {
  const { agentName, enabled = true, sessionId, stateRef, target } = args
  const inFlightStops = useRef(
    new Map<string, Promise<StructuredAgentSessionWriteOutcome<unknown>>>()
  )
  const enabledRef = useRef(enabled)
  const presentation = useRef<object | null>(null)
  const hostKey = structuredAgentSessionHostKey(target)
  useLayoutEffect(() => {
    enabledRef.current = enabled
    presentation.current = enabled ? {} : null
    return () => {
      enabledRef.current = false
      presentation.current = null
    }
  }, [enabled, hostKey, sessionId])
  const capturePresentation = useCallback(() => {
    const visit = presentation.current
    return () => visit !== null && presentation.current === visit
  }, [])

  const send = useCallback(
    async <T>(
      method: string,
      fingerprintMethod: string,
      fields: Record<string, unknown>,
      /** The fence when the press happened, read before any await, so a write never retargets. */
      pressedFence: number | null = stateRef.current.fence
    ): Promise<StructuredAgentSessionWriteOutcome<T>> => {
      if (!enabled || !enabledRef.current || pressedFence === null) {
        return { kind: 'dropped' }
      }
      const targetFence = pressedFence
      let result: AgentSessionMutationResult<T>
      try {
        result = await callStructuredAgentSession<AgentSessionMutationResult<T>>(target, method, {
          envelope: {
            sessionId,
            clientOperationId: structuredSessionOperationId(),
            expectedRuntimeFence: targetFence,
            payloadFingerprint: structuredAgentSessionPayloadFingerprint({
              method: fingerprintMethod,
              sessionId,
              fields
            })
          },
          ...fields
        })
      } catch (error) {
        return notDone(
          agentSessionThrownFailure(
            error,
            error instanceof RuntimeRpcCallError ? error.code : undefined
          ),
          fingerprintMethod,
          fields,
          agentName
        )
      }
      if (!result.ok) {
        return notDone(
          agentSessionRefusalFailure(result.refusal),
          fingerprintMethod,
          fields,
          agentName
        )
      }
      return { kind: 'done', value: result.value }
    },
    [agentName, enabled, sessionId, stateRef, target]
  )

  const write = useCallback(
    async <T>(
      method: string,
      fingerprintMethod: string,
      fields: Record<string, unknown>
    ): Promise<StructuredAgentSessionWriteOutcome<T>> => {
      const pressedFence = stateRef.current.fence
      if (
        !namesWhatItStops(fingerprintMethod, fields) ||
        (await supportsStructuredAgentSessionQuietRepeatedStop(target))
      ) {
        return send<T>(method, fingerprintMethod, fields, pressedFence)
      }
      // Temporary, for a host that predates the quiet repeated Stop: remove once none is supported.
      const key = `${sessionId}:${method}:${JSON.stringify(fields)}`
      const joined = inFlightStops.current.get(key)
      if (joined) {
        // The first press reports a failure; the one that joined it stays quiet.
        return joined.then((outcome) =>
          outcome.kind === 'not-done'
            ? { kind: 'dropped' }
            : // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the key names the method and fields, so the joined promise is this very call and settles to its T.
              (outcome as StructuredAgentSessionWriteOutcome<T>)
        )
      }
      const stopping = send<T>(method, fingerprintMethod, fields, pressedFence)
      inFlightStops.current.set(key, stopping)
      // Gone once it settles, so the next press is a new Stop.
      void stopping.finally(() => {
        if (inFlightStops.current.get(key) === stopping) {
          inFlightStops.current.delete(key)
        }
      })
      return stopping
    },
    [send, sessionId, stateRef, target]
  )

  const mutate = useCallback(
    async <T>(...writeArgs: WriteArgs): Promise<T | null> => {
      const isCurrent = capturePresentation()
      const outcome = await write<T>(...writeArgs)
      if (outcome.kind === 'not-done' && isCurrent()) {
        toast.error(outcome.notice)
      }
      return outcome.kind === 'done' ? outcome.value : null
    },
    [capturePresentation, write]
  )

  return { write, mutate, capturePresentation }
}
