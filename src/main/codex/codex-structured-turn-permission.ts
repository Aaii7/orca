import type { AgentChatPermissionMode } from '../../shared/agent-chat-permission-mode'
import type { CodexSession } from './codex-structured-session-state'
import { readCodexAutoSandbox } from './codex-structured-auto-sandbox'
import { codexStructuredPermissionPolicy } from './codex-structured-permission-policy'
import type { CodexSandboxPolicy } from './codex-structured-sandbox-policy'

type PermissionHost = {
  connection: Pick<CodexSession['connection'], 'request'>
  permissions?: CodexSession['permissions']
}

/** Prepared outside the host serialize so a configuration request never holds up accepting sends. */
export async function prepareCodexTurnPermission(
  session: PermissionHost,
  mode: AgentChatPermissionMode
): Promise<void> {
  const state = session.permissions
  if (!state) return
  const auto =
    mode !== 'auto'
      ? undefined
      : state.acquiredMode === 'auto' && state.launchSandboxIntact
        ? state.acquiredSandbox
        : await readCodexAutoSandbox(session.connection, state)
  state.preparedAuto = auto
  state.preparedMode = mode
}

export function codexPermissionRequiresAcquisition(
  session: PermissionHost,
  mode: AgentChatPermissionMode
): boolean {
  const state = session.permissions
  return (
    mode === 'auto' &&
    !!state &&
    !state.preparedAuto &&
    !(state.acquiredMode === 'auto' && state.launchSandboxIntact)
  )
}

export function codexTurnPermission(
  session: PermissionHost,
  mode: AgentChatPermissionMode
): { approvalPolicy?: string; approvalsReviewer?: string; sandboxPolicy?: CodexSandboxPolicy } {
  const state = session.permissions
  const { approvalPolicy, approvalsReviewer, sandbox } = codexStructuredPermissionPolicy(mode)
  const sandboxPolicy: CodexSandboxPolicy | undefined =
    sandbox === 'read-only'
      ? { type: 'readOnly' }
      : sandbox === 'danger-full-access'
        ? { type: 'dangerFullAccess' }
        : state?.preparedAuto
  // Unknown Auto retains the running child's grant until safe reacquisition; never invent access.
  if (mode === 'auto' && codexPermissionRequiresAcquisition(session, mode)) return {}
  if (state && sandboxPolicy && mode !== state.acquiredMode) state.launchSandboxIntact = false
  return { approvalPolicy, approvalsReviewer, ...(sandboxPolicy ? { sandboxPolicy } : {}) }
}
