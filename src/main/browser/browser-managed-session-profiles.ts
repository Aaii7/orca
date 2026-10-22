import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'
import {
  getManagedBrowserProfileId,
  type ManagedBrowserProfileOwner
} from '../../shared/browser-profile-scope'
import { browserSessionRegistry } from './browser-session-registry'

const pendingCreations = new Map<string, Promise<BrowserSessionProfile | null>>()

/** A repo's or workspace's own profile, created on first use; concurrent callers share one creation. */
export function ensureManagedBrowserProfile(
  owner: ManagedBrowserProfileOwner,
  label: string
): Promise<BrowserSessionProfile | null> {
  // Why: this is an IPC boundary, so the renderer's values are checked before they name a partition.
  if (
    (owner?.kind !== 'repo' && owner?.kind !== 'worktree') ||
    typeof owner.id !== 'string' ||
    typeof label !== 'string'
  ) {
    return Promise.reject(new Error('Invalid managed browser profile owner'))
  }
  const id = getManagedBrowserProfileId(owner)
  const existing = browserSessionRegistry.getProfile(id)
  if (existing) {
    return Promise.resolve(existing)
  }
  const pending =
    pendingCreations.get(id) ??
    browserSessionRegistry
      .createProfile('isolated', label, id)
      .finally(() => pendingCreations.delete(id))
  pendingCreations.set(id, pending)
  return pending
}

export function deleteManagedBrowserProfile(owner: ManagedBrowserProfileOwner): Promise<boolean> {
  return browserSessionRegistry.deleteProfile(getManagedBrowserProfileId(owner))
}
