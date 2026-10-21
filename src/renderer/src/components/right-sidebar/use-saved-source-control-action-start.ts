import {
  buildAgentLaunchRouteInput,
  workspaceKindForWorktreeId
} from '@/lib/agent-launch-route-input'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { ensureDetectedAgentsForWorktree } from '@/lib/agent-detection-target-inventory'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { projectSourceControlActionLaunch } from '../../../../shared/source-control-action-launch-preferences'
import { sourceControlLaunchAppliesAgentArgs } from './source-control-launch-agent-args-applicability'
import { buildSourceControlAgentDeliveryPlan } from './buildSourceControlAgentDeliveryPlan'
import {
  runSourceControlAgentActionStart,
  type RunSourceControlAgentActionStartArgs
} from './runSourceControlAgentActionStart'

/** Primary events own saved starts; opening an editor never authorizes execution. */
type SavedStartArgs = Omit<
  RunSourceControlAgentActionStartArgs,
  'selectedAgent' | 'trimmedCommandInput' | 'saveTargetValue'
> & {
  basePrompt: string
  connectionId?: string | null
  onFallback: () => void
}

export function useSavedSourceControlActionStart() {
  const inFlight = useRef(false)
  const [isStarting, setIsStarting] = useState(false)
  const start = async (input: SavedStartArgs | (() => SavedStartArgs)): Promise<void> => {
    if (inFlight.current) {
      return
    }
    inFlight.current = true
    setIsStarting(true)
    let onFallback = (): void => {}
    try {
      const args = typeof input === 'function' ? input() : input
      onFallback = args.onFallback
      const store = useAppStore.getState()
      const { recipe, worktreeId } = args
      const agent = recipe.agentId
      const route = isTuiAgent(agent)
        ? buildAgentLaunchRouteInput(store, {
            agent,
            workspace: {
              worktreeId: worktreeId ?? undefined,
              kind: workspaceKindForWorktreeId(worktreeId ?? '')
            }
          })
        : null
      const appliesArgs =
        recipe.surface === 'terminal' ||
        sourceControlLaunchAppliesAgentArgs({
          agent: isTuiAgent(agent) ? agent : null,
          worktreeId,
          repoId: args.repoId
        })
      if (!isTuiAgent(agent) || !worktreeId) {
        args.onFallback()
        return
      }
      const projection = projectSourceControlActionLaunch(recipe, agent, {
        basePrompt: args.basePrompt
      })
      const detectedAgents = await ensureDetectedAgentsForWorktree(store, worktreeId)
      const plan = buildSourceControlAgentDeliveryPlan({
        settings: args.settings,
        selectedAgent: agent,
        commandInput: projection.commandInput,
        agentArgs: appliesArgs ? projection.agentArgs : undefined,
        detectedAgents,
        connectionUnavailable: args.connectionId === undefined,
        launchPlatform: args.launchPlatform,
        isRemote: typeof args.connectionId === 'string'
      })
      if (plan.status === 'error') {
        toast.error(plan.error)
        args.onFallback()
        return
      }
      const launched = await runSourceControlAgentActionStart({
        ...args,
        selectedAgent: agent,
        trimmedCommandInput: projection.commandInput,
        launchChoice: {
          agent,
          route: appliesArgs ? 'terminal-tui' : 'structured-native-chat',
          requestedSurface: projection.requestedSurface,
          executionHostId: route ? parseExecutionHostId(route.executionHostId)?.id : undefined
        },
        saveTargetValue: 'none'
      })
      if (!launched) {
        args.onFallback()
      }
    } catch (error) {
      console.error('Saved Source Control action failed', error)
      onFallback()
    } finally {
      inFlight.current = false
      setIsStarting(false)
    }
  }
  return { start, isStarting }
}
