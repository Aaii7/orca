import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'
import { getRepoIdFromWorktreeId } from './worktree/id'

/** Which browser profile new tabs in a workspace use: the shared Default, or one Orca manages per repo or per workspace. */
export type BrowserProfileScope = 'shared' | 'repo' | 'worktree'

export type ManagedBrowserProfileOwner = { kind: 'repo' | 'worktree'; id: string }

export function getManagedBrowserProfileOwner(
  scope: BrowserProfileScope | undefined,
  worktreeId: string
): ManagedBrowserProfileOwner | null {
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return null
  }
  if (scope === 'repo') {
    return { kind: 'repo', id: getRepoIdFromWorktreeId(worktreeId) }
  }
  if (scope === 'worktree') {
    return { kind: 'worktree', id: worktreeId }
  }
  return null
}

export function isManagedBrowserProfileOf(
  profile: { owner?: ManagedBrowserProfileOwner },
  owner: ManagedBrowserProfileOwner
): boolean {
  return profile.owner?.kind === owner.kind && profile.owner.id === owner.id
}
