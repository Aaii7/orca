import { translate } from '@/i18n/i18n'
import type { AppState } from '../../types'
import { findWorktreeById } from '../worktree-helpers'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../../shared/execution-host'
import {
  getManagedBrowserProfileOwner,
  type ManagedBrowserProfileOwner
} from '../../../../../shared/browser-profile-scope'

/** Profile a new tab gets when its caller names none: the workspace's own under a repo or workspace scope, else the host default. */
export function resolveNewBrowserTabProfileId(
  state: AppState,
  worktreeId: string,
  hostId: ExecutionHostId
): string | null {
  const hostKind = parseExecutionHostId(hostId)?.kind
  // Why local and SSH only: those pages render on this desktop's profiles; a paired host's pages use its own.
  const owner =
    hostKind === 'local' || hostKind === 'ssh'
      ? getManagedBrowserProfileOwner(state.settings?.browserProfileScope, worktreeId)
      : null
  if (owner) {
    return state.ensureManagedBrowserSessionProfile(owner, managedProfileLabel(state, owner))
  }
  return (
    state.defaultBrowserSessionProfileIdByHostId[hostId] ?? state.defaultBrowserSessionProfileId
  )
}

function managedProfileLabel(state: AppState, owner: ManagedBrowserProfileOwner): string {
  if (owner.kind === 'repo') {
    const name = state.repos.find((repo) => repo.id === owner.id)?.displayName ?? owner.id
    return translate('settings.browser.profileScope.repoProfileLabel', 'Repo: {{name}}', { name })
  }
  const name = findWorktreeById(state.worktreesByRepo, owner.id)?.displayName ?? owner.id
  return translate('settings.browser.profileScope.worktreeProfileLabel', 'Workspace: {{name}}', {
    name
  })
}
