import { useAppStore } from '@/store'
import { ORCA_BROWSER_PARTITION } from '../../../../../shared/constants'
import { getOrcaProfileBrowserDefaultPartition } from '../../../../../shared/orca-profiles'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { getBrowserSettingsHostId } from '@/store/slices/browser/browser-host-state'
import type { BrowserSessionProfile } from '../../../../../shared/browser-workspace-types'

const NO_PROFILES: BrowserSessionProfile[] = []

export function useBrowserPageWebviewPartition({
  sessionProfileId,
  sessionPartition
}: {
  sessionProfileId: string | null
  sessionPartition: string | null
}): string {
  // Why the local list: this webview renders here, while Settings may be showing a paired host's profiles.
  const browserSessionProfiles = useAppStore((s) =>
    getBrowserSettingsHostId(s) === LOCAL_EXECUTION_HOST_ID
      ? s.browserSessionProfiles
      : (s.browserSessionProfilesByHostId[LOCAL_EXECUTION_HOST_ID] ?? NO_PROFILES)
  )
  const activeOrcaProfileId = useAppStore((s) => s.activeOrcaProfileId)
  const fallbackBrowserPartition = activeOrcaProfileId
    ? getOrcaProfileBrowserDefaultPartition(activeOrcaProfileId)
    : null
  const defaultSessionProfile = browserSessionProfiles.find((p) => p.id === 'default') ?? null
  const sessionProfile = sessionProfileId
    ? (browserSessionProfiles.find((p) => p.id === sessionProfileId) ?? null)
    : defaultSessionProfile
  return (
    sessionPartition ??
    sessionProfile?.partition ??
    defaultSessionProfile?.partition ??
    fallbackBrowserPartition ??
    ORCA_BROWSER_PARTITION
  )
}
