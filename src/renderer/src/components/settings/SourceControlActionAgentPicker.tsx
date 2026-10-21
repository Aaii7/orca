import AgentCombobox from '@/components/agent/AgentCombobox'
import { useAgentMenuObservation } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import { useAppStore } from '@/store'
import { getAgentCatalog } from '@/lib/agent-catalog'
import {
  sourceControlRepoAgentRows,
  savedSurfaceForPick,
  sourceControlAgentPickerSelection
} from '@/lib/source-control-agent-picker'
import { buildAgentLaunchRouteInput } from '@/lib/agent-launch-route-input'
import { AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { translate } from '@/i18n/i18n'

/** The shared surface rows configure a recipe here; they never start an agent. */
export function SourceControlActionAgentPicker(props: {
  agent: TuiAgent | null
  surface?: SourceControlActionRecipe['surface']
  repoId?: string
  disabled?: boolean
  onPick: (agent: TuiAgent | null, choice: Pick<SourceControlActionRecipe, 'surface'>) => void
}) {
  const repo = useAppStore((state) => state.repos.find((repo) => repo.id === props.repoId) ?? null)
  const rows = props.repoId
    ? sourceControlRepoAgentRows(repo)
    : {
        target: { workspace: { kind: 'git-worktree' as const } },
        detectionTarget: { kind: 'local' as const }
      }
  const observation = useAgentMenuObservation(rows.target, !props.disabled, rows.detectionTarget)
  const route = buildAgentLaunchRouteInput(useAppStore.getState(), {
    agent: props.agent ?? 'claude',
    workspace:
      typeof rows.target === 'string'
        ? { kind: 'git-worktree', worktreeId: rows.target }
        : rows.target.workspace
  })
  const canSaveSurface =
    route.hostCapabilities?.includes(AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY) === true
  const pickerSelection = sourceControlAgentPickerSelection(
    observation.model,
    observation.selectionFor(props.agent, props.surface === 'terminal' ? 'terminal' : undefined)
  )
  return (
    <AgentCombobox
      allowBlankTerminal
      blankLabel={translate(
        'auto.components.settings.SourceControlAiActionRecipeDefaults.ee0e5c2a48',
        'Use default agent'
      )}
      disabled={props.disabled || !pickerSelection.ready}
      allowNarrowTrigger
      triggerClassName="w-full"
      agents={getAgentCatalog()}
      value={props.agent}
      onValueChange={(agent) => props.onPick(agent, {})}
      surfaceRows={{
        model: observation.model,
        selection: pickerSelection,
        contextKey: observation.contextKey,
        surface: props.surface,
        onPick: (agent, surface) =>
          props.onPick(agent, {
            surface: canSaveSurface
              ? savedSurfaceForPick(observation.model, agent, surface)
              : undefined
          })
      }}
    />
  )
}
