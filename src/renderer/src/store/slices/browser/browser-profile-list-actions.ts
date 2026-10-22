import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from './browser-slice-contract'
import type { BrowserSessionProfile } from '../../../../../shared/browser-workspace-types'
import type {
  BrowserProfileCreateResult,
  BrowserProfileDeleteResult,
  BrowserProfileListResult
} from '../../../../../shared/runtime-types'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../../../shared/execution-host'
import { getManagedBrowserProfileId } from '../../../../../shared/browser-profile-scope'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  getBrowserProfilesForHost,
  getBrowserSettingsHostId,
  getBrowserSettingsRuntimeEnvironmentId,
  profileListByHostUpdate,
  getDefaultBrowserProfileForHost
} from './browser-host-state'

export function createBrowserProfileListActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<
  BrowserSlice,
  | 'fetchBrowserSessionProfiles'
  | 'createBrowserSessionProfile'
  | 'deleteBrowserSessionProfile'
  | 'ensureManagedBrowserSessionProfile'
  | 'deleteManagedBrowserSessionProfile'
> {
  const setManagedProfileStatus = (profileId: string, status: 'pending' | 'failed' | null): void =>
    set((s) => {
      const { [profileId]: _previous, ...rest } = s.managedBrowserProfileStatusById
      return { managedBrowserProfileStatusById: status ? { ...rest, [profileId]: status } : rest }
    })

  return {
    ensureManagedBrowserSessionProfile: (owner, label) => {
      const profileId = getManagedBrowserProfileId(owner)
      if (
        get().managedBrowserProfileStatusById[profileId] === 'pending' ||
        getBrowserProfilesForHost(get(), LOCAL_EXECUTION_HOST_ID).some((p) => p.id === profileId)
      ) {
        return profileId
      }
      setManagedProfileStatus(profileId, 'pending')
      window.api.browser.sessionEnsureManagedProfile({ owner, label }).then(
        (profile) => {
          if (!profile) {
            setManagedProfileStatus(profileId, 'failed')
            return
          }
          set((s) =>
            profileListByHostUpdate(
              s,
              [
                ...getBrowserProfilesForHost(s, LOCAL_EXECUTION_HOST_ID).filter(
                  (existing) => existing.id !== profile.id
                ),
                profile
              ],
              LOCAL_EXECUTION_HOST_ID
            )
          )
          setManagedProfileStatus(profileId, null)
        },
        () => setManagedProfileStatus(profileId, 'failed')
      )
      return profileId
    },

    deleteManagedBrowserSessionProfile: async (owner) => {
      const profileId = getManagedBrowserProfileId(owner)
      try {
        await window.api.browser.sessionDeleteProfile({ profileId })
      } catch {
        // Why: best-effort; a profile that outlives its workspace only costs disk until deleted in Settings.
      }
      set((s) =>
        profileListByHostUpdate(
          s,
          getBrowserProfilesForHost(s, LOCAL_EXECUTION_HOST_ID).filter((p) => p.id !== profileId),
          LOCAL_EXECUTION_HOST_ID
        )
      )
    },

    fetchBrowserSessionProfiles: async (requestedHostId) => {
      const hostId = requestedHostId ?? getBrowserSettingsHostId(get())
      const parsedHostId = parseExecutionHostId(hostId)
      const runtimeEnvironmentId =
        parsedHostId?.kind === 'runtime' ? parsedHostId.environmentId : null
      if (runtimeEnvironmentId) {
        try {
          const result = await callRuntimeRpc<BrowserProfileListResult>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'browser.profileList',
            undefined,
            { timeoutMs: 15_000 }
          )
          // Why: client-hosted imports never touch the server, so the server's
          // records can't carry the "imported from Chrome" badge — this desktop
          // remembers what it imported into each environment's jar and overlays it.
          const clientImportSources = await window.api.browser
            .sessionClientRouteImportSources?.({ environmentId: runtimeEnvironmentId })
            .catch(() => ({}))
          const profiles = result.profiles.map((profile) =>
            !profile.source && clientImportSources?.[profile.id]
              ? { ...profile, source: clientImportSources[profile.id] }
              : profile
          )
          set((s) => profileListByHostUpdate(s, profiles, hostId))
        } catch {
          set((s) => profileListByHostUpdate(s, [], hostId))
        }
        return
      }
      try {
        const profiles = (await window.api.browser.sessionListProfiles()) as BrowserSessionProfile[]
        set((s) => profileListByHostUpdate(s, profiles, hostId))
      } catch {
        /* best-effort — stale profile list is preferable to a crash */
      }
    },

    createBrowserSessionProfile: async (scope, label) => {
      const hostId = getBrowserSettingsHostId(get())
      const runtimeEnvironmentId = getBrowserSettingsRuntimeEnvironmentId(get())
      if (runtimeEnvironmentId) {
        try {
          const result = await callRuntimeRpc<BrowserProfileCreateResult>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'browser.profileCreate',
            { scope, label },
            { timeoutMs: 15_000 }
          )
          const profile = result.profile
          if (profile) {
            set((s) => ({
              ...profileListByHostUpdate(
                s,
                [...getBrowserProfilesForHost(s, hostId), profile],
                hostId
              )
            }))
          }
          return profile
        } catch {
          return null
        }
      }
      try {
        const profile = await window.api.browser.sessionCreateProfile({
          scope,
          label
        })
        if (profile) {
          set((s) => ({
            ...profileListByHostUpdate(
              s,
              [...getBrowserProfilesForHost(s, hostId), profile],
              hostId
            )
          }))
        }
        return profile
      } catch {
        return null
      }
    },

    deleteBrowserSessionProfile: async (profileId) => {
      const hostId = getBrowserSettingsHostId(get())
      const runtimeEnvironmentId = getBrowserSettingsRuntimeEnvironmentId(get())
      if (runtimeEnvironmentId) {
        try {
          const result = await callRuntimeRpc<BrowserProfileDeleteResult>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'browser.profileDelete',
            { profileId },
            { timeoutMs: 15_000 }
          )
          if (result.deleted) {
            set((s) => ({
              ...profileListByHostUpdate(
                s,
                getBrowserProfilesForHost(s, hostId).filter((profile) => profile.id !== profileId),
                hostId
              ),
              ...(getDefaultBrowserProfileForHost(s, hostId) === profileId
                ? {
                    ...(getBrowserSettingsHostId(s) === hostId
                      ? { defaultBrowserSessionProfileId: null }
                      : {}),
                    defaultBrowserSessionProfileIdByHostId: {
                      ...s.defaultBrowserSessionProfileIdByHostId,
                      [hostId]: null
                    }
                  }
                : {})
            }))
          }
          return result.deleted
        } catch {
          return false
        }
      }
      try {
        const ok = await window.api.browser.sessionDeleteProfile({ profileId })
        if (ok) {
          set((s) => ({
            ...profileListByHostUpdate(
              s,
              getBrowserProfilesForHost(s, hostId).filter((profile) => profile.id !== profileId),
              hostId
            ),
            ...(getDefaultBrowserProfileForHost(s, hostId) === profileId
              ? {
                  ...(getBrowserSettingsHostId(s) === hostId
                    ? { defaultBrowserSessionProfileId: null }
                    : {}),
                  defaultBrowserSessionProfileIdByHostId: {
                    ...s.defaultBrowserSessionProfileIdByHostId,
                    [hostId]: null
                  }
                }
              : {})
          }))
        }
        return ok
      } catch {
        return false
      }
    }
  }
}
