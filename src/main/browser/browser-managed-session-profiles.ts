import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'
import {
  isManagedBrowserProfileOf,
  type ManagedBrowserProfileOwner
} from '../../shared/browser-profile-scope'
import { browserSessionRegistry } from './browser-session-registry'

const pendingCreations = new Map<string, Promise<BrowserSessionProfile | null>>()

function findManagedProfile(owner: ManagedBrowserProfileOwner): BrowserSessionProfile | undefined {
  return browserSessionRegistry
    .listProfiles()
    .find((profile) => isManagedBrowserProfileOf(profile, owner))
}

/** A repo's or workspace's own profile, created on first use; concurrent callers share one creation. */
export function ensureManagedBrowserProfile(
  owner: ManagedBrowserProfileOwner,
  label: string
): Promise<BrowserSessionProfile | null> {
  // Why: this is an IPC boundary, so the renderer's values are checked before they are persisted.
  if (
    (owner?.kind !== 'repo' && owner?.kind !== 'worktree') ||
    typeof owner.id !== 'string' ||
    typeof label !== 'string'
  ) {
    return Promise.reject(new Error('Invalid managed browser profile owner'))
  }
  const existing = findManagedProfile(owner)
  if (existing) {
    return Promise.resolve(existing)
  }
  const key = `${owner.kind}:${owner.id}`
  const pending =
    pendingCreations.get(key) ??
    browserSessionRegistry
      .createProfile('isolated', label, { kind: owner.kind, id: owner.id })
      .finally(() => pendingCreations.delete(key))
  pendingCreations.set(key, pending)
  return pending
}

export async function deleteManagedBrowserProfile(
  owner: ManagedBrowserProfileOwner
): Promise<boolean> {
  const profile = findManagedProfile(owner)
  return profile ? browserSessionRegistry.deleteProfile(profile.id) : false
}
