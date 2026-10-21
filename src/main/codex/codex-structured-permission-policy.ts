import type { AgentChatPermissionMode } from '../../shared/agent-chat-permission-mode'
import type { CodexApprovalsReviewer } from '../../shared/codex-subagent-reviewer'

export type CodexStructuredPermissionPolicy =
  | {
      approvalPolicy: 'never'
      sandbox: 'danger-full-access'
      approvalsReviewer: CodexApprovalsReviewer
    }
  | {
      approvalPolicy: 'on-request'
      sandbox: 'workspace-write'
      approvalsReviewer: CodexApprovalsReviewer
    }
  | {
      approvalPolicy: 'untrusted'
      sandbox: 'read-only'
      approvalsReviewer: CodexApprovalsReviewer
    }

/** Full access: no approval prompts, no sandbox. */
const FULL_ACCESS_POLICY = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
  approvalsReviewer: 'user'
} as const

/** Workspace writes need approval even when the user's configured sandbox permits them. */
const ASK_POLICY = {
  approvalPolicy: 'untrusted',
  sandbox: 'read-only',
  approvalsReviewer: 'user'
} as const

/** A mode lets Codex retain the user's workspace roots, network and temporary-directory rules. */
const AUTO_POLICY = {
  approvalPolicy: 'on-request',
  sandbox: 'workspace-write',
  approvalsReviewer: 'auto_review'
} as const

/**
 * A chat's permission mode as app-server thread policy, sent on `thread/start` and `thread/resume`.
 * Every field is stated for every mode: one left unsaid is what a resume inherits from the last.
 */
export function codexStructuredPermissionPolicy(
  mode: AgentChatPermissionMode
): CodexStructuredPermissionPolicy {
  return mode === 'full-access' ? FULL_ACCESS_POLICY : mode === 'auto' ? AUTO_POLICY : ASK_POLICY
}
