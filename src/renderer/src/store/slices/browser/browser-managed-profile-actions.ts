import { createBrowserUuid } from '@/lib/browser-uuid'
import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from './browser-slice-contract'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import {
  isManagedBrowserProfileOf,
  type ManagedBrowserProfileOwner
} from '../../../../../shared/browser-profile-scope'
import { getBrowserProfilesForHost, profileListByHostUpdate } from './browser-host-state'

export function createBrowserManagedProfileActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<BrowserSlice, 'ensureManagedBrowserSessionProfile' | 'deleteManagedBrowserSessionProfile'> {
  // Placeholder ids handed out while main creates an owner's profile, so a second tab joins the first.
  const placeholderIdByOwner = new Map<string, string>()
  const ownerKey = (owner: ManagedBrowserProfileOwner): string => `${owner.kind}:${owner.id}`
  const findLocalProfile = (owner: ManagedBrowserProfileOwner) =>
    getBrowserProfilesForHost(get(), LOCAL_EXECUTION_HOST_ID).find((profile) =>
      isManagedBrowserProfileOf(profile, owner)
    )
  const setStatus = (profileId: string, status: 'pending' | 'failed' | null): void =>
    set((s) => {
      const { [profileId]: _previous, ...rest } = s.managedBrowserProfileStatusById
      return { managedBrowserProfileStatusById: status ? { ...rest, [profileId]: status } : rest }
    })
  const moveTabsToProfile = (fromId: string, toId: string): void => {
    for (const tab of Object.values(get().browserTabsByWorktree).flat()) {
      if (tab.sessionProfileId === fromId) {
        get().switchBrowserTabProfile(tab.id, toId)
      }
    }
    // Why: a tab closed while it waited would otherwise reopen on an id main never made.
    set((s) => ({
      recentlyClosedBrowserTabsByWorktree: Object.fromEntries(
        Object.entries(s.recentlyClosedBrowserTabsByWorktree).map(([worktreeId, closed]) => [
          worktreeId,
          closed.map((entry) =>
            entry.workspace.sessionProfileId === fromId
              ? { ...entry, workspace: { ...entry.workspace, sessionProfileId: toId } }
              : entry
          )
        ])
      )
    }))
  }

  return {
    ensureManagedBrowserSessionProfile: (owner, label) => {
      const key = ownerKey(owner)
      const pendingId = placeholderIdByOwner.get(key)
      if (pendingId) {
        return pendingId
      }
      const listedId = findLocalProfile(owner)?.id
      // Why a placeholder: main mints the id, and until it answers this tab's pages must not mount.
      const requestedId = listedId ?? createBrowserUuid()
      const settle = (status: 'failed' | null): void => {
        if (!listedId) {
          placeholderIdByOwner.delete(key)
          setStatus(requestedId, status)
        }
      }
      if (!listedId) {
        placeholderIdByOwner.set(key, requestedId)
        setStatus(requestedId, 'pending')
      }
      // Why ask even when listed: a removal elsewhere may have deleted it; main then makes a new one.
      window.api.browser.sessionEnsureManagedProfile({ owner, label }).then(
        (profile) => {
          if (!profile) {
            settle('failed')
            return
          }
          set((s) =>
            profileListByHostUpdate(
              s,
              [
                ...getBrowserProfilesForHost(s, LOCAL_EXECUTION_HOST_ID).filter(
                  (existing) => existing.id !== profile.id && existing.id !== requestedId
                ),
                profile
              ],
              LOCAL_EXECUTION_HOST_ID
            )
          )
          if (profile.id !== requestedId) {
            moveTabsToProfile(requestedId, profile.id)
          }
          settle(null)
        },
        () => settle('failed')
      )
      return requestedId
    },

    deleteManagedBrowserSessionProfile: async (owner) => {
      const profile = findLocalProfile(owner)
      if (!profile) {
        return
      }
      try {
        await window.api.browser.sessionDeleteProfile({ profileId: profile.id })
      } catch {
        // Why: best-effort; a profile that outlives its workspace only costs disk until deleted in Settings.
      }
      set((s) =>
        profileListByHostUpdate(
          s,
          getBrowserProfilesForHost(s, LOCAL_EXECUTION_HOST_ID).filter((p) => p.id !== profile.id),
          LOCAL_EXECUTION_HOST_ID
        )
      )
    }
  }
}
