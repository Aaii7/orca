import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { resolveSourceControlLaunchAgentScope } from '../../../../shared/source-control-launch-agent-selection'
import { useAppStore } from '@/store'
import { useRepoById } from '@/store/selectors'
import { resolveSourceControlActionRecipe } from '../../../../shared/source-control-ai'
import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import { renderSourceControlActionCommandTemplate } from '../../../../shared/source-control-ai-actions'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentLaunchSurface } from '@/lib/agent-session-launch-plan'
import { savedSurfaceForPick } from '@/lib/source-control-agent-picker'
import type { SourceControlAgentActionDialogProps } from './SourceControlAgentActionDialog'
import type { UseSourceControlAgentActionDialogResult } from './source-control-agent-action-dialog-result'
import { useSavedSourceControlAgentActionAutoStart } from './useSavedSourceControlAgentActionAutoStart'
import {
  buildSourceControlAgentSaveTargets,
  buildSourceControlAgentScopeNote,
  buildSourceControlAgentStatusCopy
} from './source-control-agent-action-dialog-support'
import { useSourceControlAgentActionStart } from './useSourceControlAgentActionStart'
import { useSourceControlActionAgentChoice } from './use-source-control-action-agent-choice'
import { sourceControlLaunchAppliesAgentArgs } from './source-control-launch-agent-args-applicability'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'

const DEFAULT_SAVE_TARGET_VALUE = 'global'

export function useSourceControlAgentActionDialog({
  open,
  onOpenChange,
  actionId,
  baseCommandInput,
  savedCommandInputTemplate,
  savedAgentArgs,
  worktreeId,
  groupId,
  connectionId,
  repoId,
  promptDelivery = 'submit-after-ready',
  launchPlatform,
  launchSource,
  savedAgentId,
  onSaveAgentDefault,
  onLaunchAccepted,
  onLaunchAborted,
  onLaunched,
  onStart
}: SourceControlAgentActionDialogProps): UseSourceControlAgentActionDialogResult {
  const settings = useAppStore((state) => state.settings)
  const repo = useRepoById(repoId ?? null)
  const launchAgentScope = useMemo(
    () => resolveSourceControlLaunchAgentScope({ settings, repo, actionId }),
    [actionId, repo, settings]
  )
  // Why: when this repo already overrides the global default, default the save
  // scope to the repo so saving the corrected agent updates that override in
  // place instead of writing a global default the override would still shadow.
  const defaultSaveTargetValue =
    launchAgentScope.overridesGlobalAgent && repoId ? 'repo' : DEFAULT_SAVE_TARGET_VALUE
  const initialRecipe = useCallback((): SourceControlActionRecipe => {
    const { surface, ...resolved } = resolveSourceControlActionRecipe({ settings, repo, actionId })
    const agentId = savedAgentId ?? null
    return {
      ...resolved,
      // A saved chat-or-CLI pick belongs to the saved agent, like its model.
      ...(surface && resolved.agentId === agentId ? { surface } : {}),
      agentId,
      commandInputTemplate: savedCommandInputTemplate ?? '{basePrompt}',
      agentArgs: savedAgentArgs ?? ''
    }
  }, [settings, repo, actionId, savedAgentId, savedCommandInputTemplate, savedAgentArgs])
  const [recipe, setRecipe] = useState(initialRecipe)
  const [livePick, setLivePick] = useState<AgentLaunchSurface | undefined>(undefined)
  const commandTemplate = recipe.commandInputTemplate ?? '{basePrompt}'
  const agentArgs = recipe.agentArgs ?? ''
  const wasOpenRef = useRef(false)
  const [openCycle, setOpenCycle] = useState(0)
  const saveTargets = useMemo(() => buildSourceControlAgentSaveTargets(repoId), [repoId])
  const [saveLaunchRecipe, setSaveLaunchRecipe] = useState(true)
  const [saveTargetValue, setSaveTargetValue] = useState(defaultSaveTargetValue)
  const connectionUnavailable = Boolean(worktreeId && connectionId === undefined)

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      return
    }
    if (wasOpenRef.current) {
      return
    }
    wasOpenRef.current = true
    setOpenCycle((cycle) => cycle + 1)
    setRecipe(initialRecipe())
    setLivePick(undefined)
    setSaveLaunchRecipe(true)
    setSaveTargetValue(defaultSaveTargetValue)
  }, [defaultSaveTargetValue, initialRecipe, open])

  const closeDialog = useCallback(() => onOpenChange(false), [onOpenChange])

  const choice = useSourceControlActionAgentChoice({
    open,
    worktreeId,
    repoId,
    repo,
    recipe,
    livePick,
    settings
  })
  const { selectedAgent, detectedAgents, detecting, selection } = choice
  const commandInput = renderSourceControlActionCommandTemplate(commandTemplate, {
    basePrompt: baseCommandInput
  })
  const trimmedCommandInput = commandInput.trim()
  // Why: a structured native chat session reads no CLI arguments, so the field is absent on
  // launches that would take that route and present on the terminal launches that apply them.
  // Resolved on every render rather than memoised: it reads the live store and the local
  // runtime's capabilities, neither of which is in a dependency list.
  const agentArgsApply = sourceControlLaunchAppliesAgentArgs({
    agent: selectedAgent,
    worktreeId,
    repoId,
    ...(repo ? { executionHostId: getRepoExecutionHostId(repo) } : {})
  })
  // A picked terminal the field does not show still gets saved arguments; none keeps the global ones.
  const launchArgsApply =
    choice.launchAppliesAgentArgs && (agentArgsApply || agentArgs.trim() !== '')

  const { deliveryPlan, resetDeliveryPlan, isStarting, handleStart, startWithDetectedAgents } =
    useSourceControlAgentActionStart({
      selectedAgent,
      commandInput,
      trimmedCommandInput,
      agentArgs,
      agentArgsApply: launchArgsApply,
      recipe,
      saveLaunchRecipe,
      saveTargetValue,
      actionId,
      repoId,
      settings,
      repo,
      worktreeId,
      groupId,
      promptDelivery,
      launchPlatform,
      // Why: an SSH host runs the plain `orca` shim; keep the previewed command
      // label aligned with the real remote launch (no `orca-ide` rename).
      isRemote: typeof connectionId === 'string',
      launchSource,
      connectionUnavailable,
      detectedAgents,
      launchChoice: selection.choice,
      onStart,
      onSaveAgentDefault,
      onLaunchAccepted,
      onLaunchAborted,
      onLaunched,
      onClose: closeDialog
    })

  const canStart =
    Boolean(trimmedCommandInput) &&
    Boolean(selectedAgent) &&
    !choice.selectedAgentUnavailable &&
    !connectionUnavailable &&
    !detecting &&
    selection.ready &&
    !isStarting

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        resetDeliveryPlan()
        setSaveLaunchRecipe(true)
        setSaveTargetValue(defaultSaveTargetValue)
      }
      onOpenChange(nextOpen)
    },
    [defaultSaveTargetValue, onOpenChange, resetDeliveryPlan]
  )

  const { autoLaunchPending } = useSavedSourceControlAgentActionAutoStart({
    open,
    openCycle,
    detectionReady: choice.replayReady,
    actionId,
    baseCommandInput,
    savedAgentId,
    savedCommandInputTemplate,
    savedAgentArgs,
    settings,
    repo,
    repoId,
    worktreeId,
    connectionId,
    selectedAgent,
    trimmedCommandInput,
    connectionUnavailable,
    detecting,
    isStarting,
    detectedAgents,
    disabledAgents: settings?.disabledTuiAgents,
    onAutoStart: ({ detectedAgents: agentsForLaunch, saveTargetValue: matchedTargetValue }) =>
      startWithDetectedAgents({
        detectedAgents: agentsForLaunch,
        saveTargetValueOverride: matchedTargetValue
      })
  })

  const statusCopy = buildSourceControlAgentStatusCopy({
    selectedAgent,
    selectedAgentUnavailable: choice.selectedAgentUnavailable,
    connectionUnavailable,
    hasEnabledAgents: choice.hasEnabledAgents,
    detecting
  })

  // Why: editing any launch field invalidates the previewed delivery plan.
  const resetPlanAfter = useCallback(
    <T>(apply: (value: T) => void) =>
      (value: T): void => {
        apply(value)
        resetDeliveryPlan()
      },
    [resetDeliveryPlan]
  )
  // A pick changes route even for the same agent, so it always invalidates the previewed plan.
  const onAgentPick = (agent: TuiAgent, surface?: AgentLaunchSurface): void => {
    const saved = savedSurfaceForPick(choice.observation.model, agent, surface)
    setLivePick(surface)
    setRecipe(({ launchPreferences, surface: _previous, ...current }) => ({
      ...current,
      agentId: agent,
      ...(launchPreferences?.agentId === agent ? { launchPreferences } : {}),
      ...(saved ? { surface: saved } : {})
    }))
    resetDeliveryPlan()
  }
  const onAgentArgsChange = resetPlanAfter((agentArgs: string) =>
    setRecipe((current) => ({ ...current, agentArgs }))
  )
  const onCommandTemplateChange = resetPlanAfter((commandInputTemplate: string) =>
    setRecipe((current) => ({ ...current, commandInputTemplate }))
  )
  const onSaveLaunchRecipeChange = useMemo(
    () => resetPlanAfter(setSaveLaunchRecipe),
    [resetPlanAfter]
  )

  const agentScopeNote = useMemo(
    () => buildSourceControlAgentScopeNote(launchAgentScope),
    [launchAgentScope]
  )

  return {
    handleOpenChange,
    shouldRenderDialog: !autoLaunchPending,
    agentScopeNote,
    agentOptions: choice.agentOptions,
    selectedAgent,
    hasEnabledAgents: choice.hasEnabledAgents,
    detecting,
    surfaceRows: {
      model: choice.observation.model,
      selection: choice.pickerSelection,
      contextKey: choice.observation.contextKey,
      surface: choice.liveSurface,
      onPick: onAgentPick
    },
    statusCopy,
    agentArgs,
    agentArgsApply,
    commandTemplate,
    recipe,
    saveLaunchRecipe,
    saveTargetValue,
    saveTargets,
    settings,
    repo,
    deliveryPlan,
    canStart,
    isStarting,
    onAgentPick,
    onAgentArgsChange,
    onCommandTemplateChange,
    onSaveLaunchRecipeChange,
    onSaveAgentDefaultChange: setSaveTargetValue,
    handleStart
  }
}
