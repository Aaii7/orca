import { describe, expect, it } from 'vitest'
import { codexStructuredPermissionPolicy } from './codex-structured-permission-policy'

const FULL_ACCESS = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
  approvalsReviewer: 'user'
}
const ASK = { approvalPolicy: 'untrusted', sandbox: 'read-only', approvalsReviewer: 'user' }

describe('codexStructuredPermissionPolicy', () => {
  it('maps Full access to no prompts and no sandbox', () => {
    expect(codexStructuredPermissionPolicy('full-access')).toEqual(FULL_ACCESS)
  })

  // The thread open spreads this, so an omitted field is absent, not reset: a thread resumed from
  // Full access would keep `never`. Ask states every field, the human reviewer too.
  it('states every Ask field, the human reviewer too', () => {
    expect(codexStructuredPermissionPolicy('ask')).toEqual(ASK)
  })

  it('keeps Approve for me in the configured workspace sandbox', () => {
    expect(codexStructuredPermissionPolicy('auto')).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      approvalsReviewer: 'auto_review'
    })
  })

  // A sandbox mode, never a `sandboxPolicy` object: Codex folds the user's own writable roots and
  // network access into a mode, and a policy object would replace them.
  it('names a sandbox mode for every mode', () => {
    for (const mode of ['ask', 'auto', 'full-access'] as const) {
      expect(codexStructuredPermissionPolicy(mode)).not.toHaveProperty('sandboxPolicy')
      expect(typeof codexStructuredPermissionPolicy(mode).sandbox).toBe('string')
    }
  })

  it('asks for a mode Codex does not have', () => {
    expect(codexStructuredPermissionPolicy('accept-edits')).toEqual(ASK)
  })
})
