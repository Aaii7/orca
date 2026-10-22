import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
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

// Why derived, not random: the renderer must name the profile synchronously when it creates a tab,
// and removal paths must find a workspace's profile without a stored owner map.
export function getManagedBrowserProfileId(owner: ManagedBrowserProfileOwner): string {
  const hex = bytesToHex(
    sha256(utf8ToBytes(`orca-managed-browser-profile:${owner.kind}:${owner.id}`))
  )
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
