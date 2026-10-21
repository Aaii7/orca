// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, cleanup, fireEvent } from '@testing-library/react'
import './settings-persistence-test-fixture'
import React from 'react'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { renderToStaticMarkup } from 'react-dom/server'
import { normalizeRepoSourceControlAiOverrides } from '../../../../shared/source-control-ai'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiSettings
} from '../../../../shared/source-control-ai-types'
import {
  SOURCE_CONTROL_ACTION_IDS,
  setSourceControlActionAgentDefault,
  type SourceControlActionId
} from '../../../../shared/source-control-ai-actions'
import {
  computeActionDirtyById,
  dropRepoLegacyInstructionForAction,
  withRepoAiActionMode
} from './repository-source-control-ai-draft'
import { withRepoAiActionAgent } from './repository-source-control-ai-action-agent-draft'
import { resolveSourceControlActionRecipe } from '../../../../shared/source-control-ai-operation-policy'
import {
  saveSourceControlActionRecipe,
  toSourceControlAiRepoUpdate
} from '../../../../shared/source-control-ai-recipe-save'
import { sourceControlActionRecipeMatchesTarget } from '../right-sidebar/source-control-action-recipe-match'
import { SourceControlActionAgentPicker } from './SourceControlActionAgentPicker'
import { RepositorySourceControlAiActionRows } from './RepositorySourceControlAiActionRows'
import { RepositorySourceControlAiEnablement } from './RepositorySourceControlAiEnablement'
import { SourceControlAiActionRecipeDefaults } from './SourceControlAiActionRecipeDefaults'
import { useAppStore } from '../../store'
import { TooltipProvider } from '../ui/tooltip'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { resetHostStructuredAgentsForTests } from '@/runtime/host-structured-agents'
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))
afterEach(() => {
  cleanup()
  resetHostStructuredAgentsForTests()
  setLocalRuntimeCapabilitiesForTests(null)
})
describe('saved chat-or-CLI pick', () => {
  it('stays bound to its agent through reads, inheritance, Customize, agent changes and saves', () => {
    const base = useAppStore.getState().settings!
    const actions = { fixChecks: { agentId: 'codex' as const, surface: 'terminal' as const } }
    const settings = { ...base, sourceControlAi: { ...base.sourceControlAi!, actions } }
    const resolve = (sourceControlAi: RepoSourceControlAiOverrides) =>
      resolveSourceControlActionRecipe({
        settings,
        repo: { sourceControlAi },
        actionId: 'fixChecks'
      }).surface
    expect(resolve({})).toBe('terminal')
    // A repo on its own agent never inherits the global agent's pick.
    expect(resolve({ actionOverrides: { fixChecks: { agentId: 'claude' } } })).toBeUndefined()

    const customized = withRepoAiActionMode({}, settings, 'fixChecks', 'override')
    expect(customized.actionOverrides?.fixChecks?.surface).toBe('terminal')
    const repoSurface = (agent: 'codex' | 'claude') =>
      withRepoAiActionAgent(customized, settings, 'fixChecks', agent).actionOverrides?.fixChecks
        ?.surface
    expect([repoSurface('codex'), repoSurface('claude')]).toEqual(['terminal', undefined])
    // Changing the agent (or choosing "Use default agent") drops it even with no saved model.
    const globalSurface = (agent: 'codex' | 'claude' | null) =>
      setSourceControlActionAgentDefault(actions, 'fixChecks', agent).fixChecks?.surface
    expect([globalSurface('codex'), globalSurface('claude'), globalSurface(null)]).toEqual([
      'terminal',
      undefined,
      undefined
    ])

    const recipe = { agentId: 'codex' as const, commandInputTemplate: '{basePrompt}' }
    const saved = saveSourceControlActionRecipe({
      target: { type: 'repo', repoId: 'repo-1' },
      settings,
      repo: { sourceControlAi: {} },
      actionId: 'fixChecks',
      recipe: { ...recipe, surface: 'terminal' }
    })
    const savedRepoAi = 'update' in saved ? saved.update.sourceControlAi : null
    expect(savedRepoAi?.actionOverrides?.fixChecks?.surface).toBe('terminal')
    const matches = (surface: 'chat' | 'terminal') =>
      sourceControlActionRecipeMatchesTarget({
        actionId: 'fixChecks',
        target: { type: 'repo', repoId: 'repo-1' },
        recipe: { ...recipe, surface },
        settings,
        repo: { sourceControlAi: savedRepoAi ?? undefined }
      })
    expect([matches('terminal'), matches('chat')]).toEqual([true, false])
  })
})

describe('RepositorySourceControlAiEnablement', () => {
  it('describes repo enablement as Source Control AI action visibility', () => {
    const markup = renderToStaticMarkup(
      React.createElement(RepositorySourceControlAiEnablement, {
        value: false,
        source: { enabled: true } as SourceControlAiSettings,
        onChange: () => {}
      })
    )

    expect(markup).toContain('Show Source Control AI actions')
    expect(markup).toContain('Controls whether Source Control AI buttons are shown')
    expect(markup).toContain('separate features follows those features&#x27; settings')
    expect(markup).toContain('Show')
    expect(markup).not.toContain('Source Control AI enabled')
  })
})

describe('RepositorySourceControlAiActionRows', () => {
  it.each(['codex', 'opencode'] as const)(
    'shows one launch section for chats and terminals once detection settles (%s)',
    async (agent) => {
      useAppStore.getState().clearLocalDetectedAgents()
      const settings = useAppStore.getState().settings!
      const recipe = {
        agentId: null,
        launchPreferences: {
          agentId: agent,
          permissionMode: 'ask' as const,
          model: 'saved',
          options: { fastMode: 'false' }
        },
        agentArgs: '--saved-cli',
        commandInputTemplate: 'kept-template'
      }
      const source = {
        ...settings.sourceControlAi!,
        enabled: true,
        actions: { fixCommitFailure: recipe }
      }
      const originalRecipe = JSON.stringify(recipe)
      let finish: (ids: string[]) => void = () => {}
      const detectAgents = vi.fn(
        () =>
          new Promise<string[]>((resolve) => {
            finish = resolve
          })
      )
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { preflight: { detectAgents } }
      })
      useAppStore.setState({
        settings: { ...settings, defaultTuiAgent: 'claude', sourceControlAi: source },
        settingsSearchQuery: '',
        localDetectedAgentIdsByContext: {}
      })
      const ensure = vi.spyOn(useAppStore.getState(), 'ensureNativeDetectedAgents')
      const writeConfig = vi.fn()
      const onEdit = vi.fn()
      const view = render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(SourceControlAiActionRecipeDefaults, {
            config: source,
            defaultTuiAgent: 'claude',
            searchQuery: '',
            writeConfig
          }),
          React.createElement(RepositorySourceControlAiActionRows, {
            repoId: 'repo-1',
            repoAi: { actionOverrides: { fixCommitFailure: recipe } },
            source,
            defaultTuiAgent: 'claude',
            savingActionIds: {},
            actionDirtyById: computeActionDirtyById({}, {}, {}),
            onActionModeChange: onEdit,
            onActionAgentChange: onEdit,
            onActionLaunchPreferencesChange: onEdit,
            onActionTemplateChange: onEdit,
            onActionAgentArgsChange: onEdit,
            onAppendVariable: onEdit,
            onActionDiscard: onEdit,
            onActionSave: onEdit
          })
        )
      )
      await act(async () => {})
      const cards = Array.from(view.container.querySelectorAll('textarea'))
        .filter((field) => field.value === 'kept-template')
        .map((field) => field.parentElement!.closest('.rounded-md')!)
      expect(cards).toHaveLength(2)
      expect(ensure).toHaveBeenCalledTimes(2)
      expect(detectAgents).toHaveBeenCalledTimes(1)
      for (const card of cards) {
        expect(card.textContent).not.toContain('Model')
        expect(card.querySelectorAll('[aria-hidden="true"] .h-8')).toHaveLength(1)
        expect(card.querySelector('input')?.value).toBe('--saved-cli')
      }
      await act(async () => {
        finish([agent])
      })
      for (const card of cards) {
        expect(card.textContent?.includes('Model')).toBe(agent === 'codex')
        expect(card.textContent).toContain('Permissions')
        // OpenCode's terminal has no permission flag, so its saved mode reaches chats only.
        expect(card.textContent?.includes('Applies to chats only')).toBe(agent === 'opencode')
        expect(card.textContent).toContain('Extra CLI arguments')
        expect(card.querySelector('input')?.value).toBe('--saved-cli')
        expect(card.querySelector('textarea')?.value).toBe('kept-template')
      }
      expect(JSON.stringify(source.actions.fixCommitFailure)).toBe(originalRecipe)
      expect(writeConfig).not.toHaveBeenCalled()
      expect(onEdit).not.toHaveBeenCalled()
    }
  )

  it.each([undefined, null, '', '--repo'])(
    'renders save controls and argument ownership for %s',
    (repoAgentArgs) => {
      const actionDirtyById = Object.fromEntries(
        SOURCE_CONTROL_ACTION_IDS.map((actionId) => [actionId, actionId === 'fixCommitFailure'])
      ) as Record<SourceControlActionId, boolean>
      const source: SourceControlAiSettings = {
        enabled: true,
        agentId: null,
        selectedModelByAgent: {},
        selectedThinkingByModel: {},
        customAgentCommand: '',
        instructionsByOperation: {},
        actions: { fixCommitFailure: { agentId: null, agentArgs: '--global' } }
      }

      const markup = renderToStaticMarkup(
        React.createElement(RepositorySourceControlAiActionRows, {
          repoId: 'repo-1',
          repoAi: {
            actionOverrides: {
              fixCommitFailure: {
                agentId: null,
                commandInputTemplate: '{basePrompt}\n\nrepo',
                ...(repoAgentArgs !== undefined ? { agentArgs: repoAgentArgs } : {})
              }
            }
          },
          source,
          defaultTuiAgent: 'codex',
          savingActionIds: {},
          actionDirtyById,
          onActionModeChange: () => {},
          onActionAgentChange: () => {},
          onActionLaunchPreferencesChange: () => {},
          onActionTemplateChange: () => {},
          onActionAgentArgsChange: () => {},
          onAppendVariable: () => {},
          onActionDiscard: () => {},
          onActionSave: () => {}
        })
      )

      expect(markup).toContain('Commit failure fixes')
      expect(markup).toContain('Push failure fixes')
      expect(markup).toContain('Unsaved changes')
      expect(markup).toContain('Discard')
      expect(markup).toContain('Save')
      expect(markup).toContain('repo-repo-1-source-control-ai-fixCommitFailure')
      const card = new DOMParser()
        .parseFromString(markup, 'text/html')
        .getElementById('repo-repo-1-source-control-ai-fixCommitFailure')
      expect(card?.textContent).toContain(
        repoAgentArgs === undefined
          ? 'Global custom args'
          : repoAgentArgs
            ? 'Repository custom args'
            : 'No args'
      )
    }
  )
})

describe('dropRepoLegacyInstructionForAction', () => {
  it('prevents legacy text instructions from remigrating after an action override is cleared', () => {
    const next = dropRepoLegacyInstructionForAction(
      {
        instructionsByOperation: {
          commitMessage: 'Use repo style.',
          pullRequest: 'Use PR style.'
        },
        actionOverrides: {}
      },
      'commitMessage'
    )

    expect(next.instructionsByOperation).toEqual({ pullRequest: 'Use PR style.' })
    const normalized = normalizeRepoSourceControlAiOverrides(next)
    expect(normalized?.actionOverrides?.commitMessage).toBeUndefined()
    expect(normalized?.actionOverrides?.pullRequest).toEqual({
      commandInputTemplate: '{basePrompt}\n\nUse PR style.'
    })
  })

  it('leaves launch action recipes alone because they have no legacy instruction key', () => {
    const value = {
      instructionsByOperation: { commitMessage: 'Use repo style.' },
      actionOverrides: {
        fixChecks: { commandInputTemplate: '{basePrompt}' }
      }
    }

    expect(dropRepoLegacyInstructionForAction(value, 'fixChecks')).toBe(value)
  })
})

it.each(['', '--model raw'])(
  'a repository surface edit saves the complete target and keeps its arguments (%s)',
  (agentArgs) => {
    const settings = useAppStore.getState().settings!
    const launchPreferences = {
      agentId: 'codex' as const,
      model: 'saved',
      permissionMode: 'ask' as const
    }
    const sourceSettings = {
      ...settings,
      sourceControlAi: {
        ...settings.sourceControlAi!,
        actions: { fixChecks: { agentId: 'codex' as const, agentArgs: '', launchPreferences } }
      }
    }
    const edited = withRepoAiActionAgent(
      { actionOverrides: { fixChecks: { commandInputTemplate: '{basePrompt}', agentArgs } } },
      sourceSettings,
      'fixChecks',
      'codex',
      { surface: 'terminal' }
    )
    expect(edited.actionOverrides?.fixChecks).toMatchObject({
      agentId: 'codex',
      agentArgs,
      launchPreferences,
      surface: 'terminal'
    })
    const payload = toSourceControlAiRepoUpdate(edited).sourceControlAi
    const replay = resolveSourceControlActionRecipe({
      settings: sourceSettings,
      repo: { sourceControlAi: payload ?? undefined },
      actionId: 'fixChecks'
    })
    expect(replay).toMatchObject({ agentArgs, surface: 'terminal', launchPreferences })
    expect(replay.launchPreferencesYieldToAgentArgs).toBeUndefined()
    const changedAgent = withRepoAiActionAgent(edited, sourceSettings, 'fixChecks', 'claude', {
      surface: 'chat'
    })
    expect(changedAgent.actionOverrides?.fixChecks?.launchPreferences).toBeUndefined()
  }
)

it('keeps default and missing-agent editors disabled only until the host inventory settles', async () => {
  const settings = useAppStore.getState().settings!
  useAppStore.setState({
    settings: { ...settings, experimentalNativeChat: false },
    detectedAgentIds: null,
    ensureDetectedAgents: vi.fn(() => new Promise<TuiAgent[]>(() => {}))
  })
  const onPick = vi.fn()
  const picker = (agent: 'codex' | null) =>
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(SourceControlActionAgentPicker, { agent, onPick })
    )
  const view = render(picker(null))
  expect(view.getByRole('combobox').hasAttribute('disabled')).toBe(true)
  view.rerender(picker('codex'))
  expect(view.getByRole('combobox').hasAttribute('disabled')).toBe(true)
  await act(async () => useAppStore.setState({ detectedAgentIds: ['claude'] }))
  expect(view.getByRole('combobox').hasAttribute('disabled')).toBe(false)
  expect(onPick).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('combobox'))
  const available = view.getAllByRole('option').find((row) => row.textContent?.includes('Claude'))
  expect(available).toBeDefined()
  fireEvent.click(available!)
  expect(onPick).toHaveBeenCalledWith('claude', {})
})
