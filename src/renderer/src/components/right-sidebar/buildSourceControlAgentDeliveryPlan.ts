import { checkSourceControlAgentActionLaunch } from '@/lib/source-control-agent-action-launch-check'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { SourceControlAgentActionDeliveryPlanState } from './SourceControlAgentActionDialogForm'
import { buildSourceControlAgentConnectionErrorPlan } from './source-control-agent-action-dialog-support'

type BuildSourceControlAgentDeliveryPlanArgs = {
  settings?: GlobalSettings | null
  selectedAgent: TuiAgent | null
  commandInput: string
  agentArgs?: string | undefined
  detectedAgents: TuiAgent[]
  connectionUnavailable: boolean
  launchPlatform?: NodeJS.Platform
  /** Why: SSH remotes run the plain `orca` shim, so the check builds the command they would. */
  isRemote?: boolean
}

/** The dialog's check before it starts an agent: an error the user can fix, else nothing to show. */
export function buildSourceControlAgentDeliveryPlan({
  settings = useAppStore.getState().settings,
  selectedAgent,
  commandInput,
  agentArgs,
  detectedAgents,
  connectionUnavailable,
  launchPlatform,
  isRemote
}: BuildSourceControlAgentDeliveryPlanArgs): SourceControlAgentActionDeliveryPlanState {
  if (connectionUnavailable) {
    return buildSourceControlAgentConnectionErrorPlan()
  }
  const result = checkSourceControlAgentActionLaunch({
    agent: selectedAgent,
    commandInput,
    agentArgs,
    detectedAgents,
    disabledAgents: settings?.disabledTuiAgents,
    cmdOverrides: settings?.agentCmdOverrides,
    terminalWindowsShell: settings?.terminalWindowsShell,
    platform: launchPlatform,
    isRemote
  })
  return result.ok ? { status: 'idle' } : { status: 'error', error: result.error }
}
