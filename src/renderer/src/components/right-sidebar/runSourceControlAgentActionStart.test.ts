import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  focusTerminalTabSurface: vi.fn(),
  launchAgentInNewTab: vi.fn(),
  onClose: vi.fn(),
  onLaunched: vi.fn(),
  onSaveAgentDefault: vi.fn(),
  onStart: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError }
}))

import { runSourceControlAgentActionStart } from './runSourceControlAgentActionStart'
import { getDefaultSettings } from '../../../../shared/constants'
import { saveSourceControlActionRecipe } from '../../../../shared/source-control-ai-recipe-save'
import { resolveSourceControlActionRecipe } from '../../../../shared/source-control-ai-operation-policy'

function buildArgs(
  overrides: Partial<Parameters<typeof runSourceControlAgentActionStart>[0]> = {}
): Parameters<typeof runSourceControlAgentActionStart>[0] {
  return {
    selectedAgent: 'codex',
    trimmedCommandInput: 'Fix the bug',
    recipe: { agentId: 'codex', commandInputTemplate: '{basePrompt}', agentArgs: '--model gpt-5' },
    saveTargetValue: 'none',
    actionId: 'resolveComments',
    repoId: null,
    settings: null,
    repo: null,
    worktreeId: 'wt-1',
    groupId: 'group-1',
    promptDelivery: 'submit-after-ready',
    launchPlatform: 'linux',
    launchSource: 'source_control_recovery',
    onStart: undefined,
    onSaveAgentDefault: mocks.onSaveAgentDefault,
    onLaunched: mocks.onLaunched,
    onClose: mocks.onClose,
    ...overrides
  }
}

describe('runSourceControlAgentActionStart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('waits for deferred prompt delivery before confirming a source-control launch', async () => {
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
      startupPlan: {} as never,
      pasteDraftAfterLaunch: true,
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
    })

    await expect(runSourceControlAgentActionStart(buildArgs())).resolves.toBe(true)

    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('tab-1')
    expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
    expect(mocks.onClose).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('notifies onLaunchAccepted as soon as the agent tab is created, before prompt delivery', async () => {
    let resolveDelivery: (value: {
      delivered: boolean
      failureNotified: boolean
    }) => void = () => {}
    const promptDeliveryResult = new Promise<{ delivered: boolean; failureNotified: boolean }>(
      (resolve) => {
        resolveDelivery = resolve
      }
    )
    const onLaunchAccepted = vi.fn()
    const onLaunchAborted = vi.fn()
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
      startupPlan: {} as never,
      pasteDraftAfterLaunch: true,
      promptDeliveryResult
    })

    const launchPromise = runSourceControlAgentActionStart(
      buildArgs({ onLaunchAccepted, onLaunchAborted })
    )

    await vi.waitFor(() => {
      expect(onLaunchAccepted).toHaveBeenCalledTimes(1)
    })
    expect(mocks.onLaunched).not.toHaveBeenCalled()

    resolveDelivery({ delivered: true, failureNotified: false })
    await expect(launchPromise).resolves.toBe(true)
    expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
    expect(onLaunchAborted).not.toHaveBeenCalled()
  })

  // Why: onLaunchAccepted only parks launch-scoped state; firing it twice or on a dead
  // launch would leave a caller believing an agent is running.
  it('fires onLaunchAccepted exactly once and only when a tab was created', async () => {
    const onLaunchAccepted = vi.fn()
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
      startupPlan: {} as never,
      pasteDraftAfterLaunch: true,
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
    })

    await expect(runSourceControlAgentActionStart(buildArgs({ onLaunchAccepted }))).resolves.toBe(
      true
    )
    expect(onLaunchAccepted).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    mocks.launchAgentInNewTab.mockReturnValue(null)

    await expect(runSourceControlAgentActionStart(buildArgs({ onLaunchAccepted }))).resolves.toBe(
      false
    )
    expect(onLaunchAccepted).not.toHaveBeenCalled()
  })

  // Why: irreversible host writes (fixing replies, thread resolves) hang off onLaunched, so a
  // launch whose prompt never landed must report the abort and never reach onLaunched.
  it('saves before deferred delivery and retains the recipe when delivery fails', async () => {
    let resolveDelivery = (_value: { delivered: boolean; failureNotified: boolean }): void => {}
    const promptDeliveryResult = new Promise<{ delivered: boolean; failureNotified: boolean }>(
      (resolve) => {
        resolveDelivery = resolve
      }
    )
    const onLaunchAccepted = vi.fn()
    const onLaunchAborted = vi.fn()
    const onSaveAgentDefault = vi.fn()
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
      promptDeliveryResult
    })
    const args = buildArgs({
      settings: getDefaultSettings('/tmp'),
      saveTargetValue: 'global',
      onSaveAgentDefault,
      onLaunchAccepted,
      onLaunchAborted
    })
    const launchPromise = runSourceControlAgentActionStart(args)

    expect(onSaveAgentDefault).toHaveBeenCalledWith(
      { type: 'global' },
      'resolveComments',
      args.recipe
    )
    expect(onSaveAgentDefault.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.launchAgentInNewTab.mock.invocationCallOrder[0]
    )
    expect(onLaunchAccepted).toHaveBeenCalledTimes(1)
    expect(mocks.onLaunched).not.toHaveBeenCalled()
    expect(mocks.onClose).not.toHaveBeenCalled()

    resolveDelivery({ delivered: false, failureNotified: true })
    await expect(launchPromise).resolves.toBe(false)

    expect(onSaveAgentDefault).toHaveBeenCalledOnce()
    expect(onLaunchAborted).toHaveBeenCalledTimes(1)
    expect(mocks.onLaunched).not.toHaveBeenCalled()
    expect(mocks.onClose).not.toHaveBeenCalled()
  })

  it('aborts an accepted launch when promptDeliveryResult rejects', async () => {
    const onLaunchAccepted = vi.fn()
    const onLaunchAborted = vi.fn()
    const originalConsole = console
    vi.stubGlobal('console', { ...originalConsole, error: vi.fn() })
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
      startupPlan: {} as never,
      pasteDraftAfterLaunch: true,
      promptDeliveryResult: Promise.reject(new Error('boom'))
    })

    try {
      await expect(
        runSourceControlAgentActionStart(buildArgs({ onLaunchAccepted, onLaunchAborted }))
      ).resolves.toBe(false)

      expect(onLaunchAccepted).toHaveBeenCalledTimes(1)
      expect(onLaunchAborted).toHaveBeenCalledTimes(1)
      expect(mocks.onLaunched).not.toHaveBeenCalled()
    } finally {
      vi.stubGlobal('console', originalConsole)
    }
  })

  it('does not report an abort when no tab was ever created', async () => {
    const onLaunchAborted = vi.fn()
    mocks.launchAgentInNewTab.mockReturnValue(null)

    await expect(runSourceControlAgentActionStart(buildArgs({ onLaunchAborted }))).resolves.toBe(
      false
    )

    expect(onLaunchAborted).not.toHaveBeenCalled()
  })

  it('keeps the source-control dialog open when deferred prompt delivery fails', async () => {
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
      startupPlan: {} as never,
      pasteDraftAfterLaunch: true,
      promptDeliveryResult: Promise.resolve({ delivered: false, failureNotified: false })
    })

    await expect(runSourceControlAgentActionStart(buildArgs())).resolves.toBe(false)

    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('tab-1')
    expect(mocks.onLaunched).not.toHaveBeenCalled()
    expect(mocks.onClose).not.toHaveBeenCalled()
    expect(mocks.onSaveAgentDefault).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('Could not start the selected agent.')
  })

  it('does not show a generic start failure when deferred delivery already notified the user', async () => {
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
      startupPlan: {} as never,
      pasteDraftAfterLaunch: true,
      promptDeliveryResult: Promise.resolve({ delivered: false, failureNotified: true })
    })

    await expect(runSourceControlAgentActionStart(buildArgs())).resolves.toBe(false)

    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('tab-1')
    expect(mocks.onLaunched).not.toHaveBeenCalled()
    expect(mocks.onClose).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('logs and treats a rejected promptDeliveryResult as a launch failure', async () => {
    const error = new Error('boom')
    const originalConsole = console
    const consoleError = vi.fn()
    vi.stubGlobal('console', { ...originalConsole, error: consoleError })
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
      startupPlan: {} as never,
      pasteDraftAfterLaunch: true,
      promptDeliveryResult: Promise.reject(error)
    })

    try {
      await expect(runSourceControlAgentActionStart(buildArgs())).resolves.toBe(false)

      expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('tab-1')
      expect(consoleError).toHaveBeenCalledWith('promptDeliveryResult rejected', error)
      expect(mocks.onLaunched).not.toHaveBeenCalled()
      expect(mocks.onClose).not.toHaveBeenCalled()
      expect(mocks.toastError).toHaveBeenCalledWith('Could not start the selected agent.')
    } finally {
      vi.stubGlobal('console', originalConsole)
    }
  })

  it('keeps non-deferred tab launches immediate', async () => {
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
      startupPlan: {} as never,
      pasteDraftAfterLaunch: true
    })

    await expect(
      runSourceControlAgentActionStart(buildArgs({ promptDelivery: 'draft' }))
    ).resolves.toBe(true)

    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('tab-1')
    expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
    expect(mocks.onClose).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('keeps injected onStart successes immediate', async () => {
    const onStart = vi.fn().mockResolvedValue(true)

    await expect(
      runSourceControlAgentActionStart(
        buildArgs({
          onStart,
          worktreeId: undefined,
          groupId: undefined
        })
      )
    ).resolves.toBe(true)

    expect(onStart).toHaveBeenCalledWith({
      agent: 'codex',
      commandInput: 'Fix the bug',
      agentArgs: '--model gpt-5'
    })
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
    expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
    expect(mocks.onClose).toHaveBeenCalledTimes(1)
  })

  // Why: the onStart branch never awaits a delivery result, so acceptance is terminal there.
  it('accepts an onStart launch and never aborts it', async () => {
    const onLaunchAccepted = vi.fn()
    const onLaunchAborted = vi.fn()
    const onStart = vi.fn().mockResolvedValue(true)

    await expect(
      runSourceControlAgentActionStart(
        buildArgs({
          onStart,
          worktreeId: undefined,
          groupId: undefined,
          onLaunchAccepted,
          onLaunchAborted
        })
      )
    ).resolves.toBe(true)

    expect(onLaunchAccepted).toHaveBeenCalledTimes(1)
    expect(onLaunchAborted).not.toHaveBeenCalled()
    expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
  })

  it('reports neither callback when onStart declines the launch', async () => {
    const onLaunchAccepted = vi.fn()
    const onLaunchAborted = vi.fn()
    const onStart = vi.fn().mockResolvedValue(false)

    await expect(
      runSourceControlAgentActionStart(
        buildArgs({
          onStart,
          worktreeId: undefined,
          groupId: undefined,
          onLaunchAccepted,
          onLaunchAborted
        })
      )
    ).resolves.toBe(false)

    expect(onLaunchAccepted).not.toHaveBeenCalled()
    expect(onLaunchAborted).not.toHaveBeenCalled()
  })

  // Why: a rejected recipe save after acceptance would otherwise strand the caller with
  // neither onLaunched nor onLaunchAborted, permanently disabling the action.
  it('completes the launch when saving the agent default rejects', async () => {
    const onLaunchAborted = vi.fn()
    const originalConsole = console
    const consoleError = vi.fn()
    vi.stubGlobal('console', { ...originalConsole, error: consoleError })
    const saveError = new Error('settings not loaded')
    mocks.onSaveAgentDefault.mockRejectedValueOnce(saveError)
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
      startupPlan: {} as never,
      pasteDraftAfterLaunch: true,
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
    })

    try {
      await expect(
        runSourceControlAgentActionStart(buildArgs({ saveTargetValue: 'global', onLaunchAborted }))
      ).resolves.toBe(true)

      expect(mocks.onSaveAgentDefault).toHaveBeenCalledTimes(1)
      expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
      expect(mocks.onClose).toHaveBeenCalledTimes(1)
      expect(onLaunchAborted).not.toHaveBeenCalled()
      await vi.waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith('onSaveAgentDefault failed', saveError)
        expect(mocks.toastError).toHaveBeenCalledWith(
          'Could not save this action. Try saving it again in Settings.'
        )
      })
    } finally {
      vi.stubGlobal('console', originalConsole)
    }
  })
})

describe('runSourceControlAgentActionStart CLI arguments applicability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Why: `undefined` is what reaches the global Agents arguments; an empty string would beat
  // that fallback and launch the agent with no arguments at all.
  it('keeps terminal candidates even when a dialog field is hidden', async () => {
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' }
    })

    await expect(runSourceControlAgentActionStart(buildArgs())).resolves.toBe(true)

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledTimes(1)
    const launchCall = mocks.launchAgentInNewTab.mock.calls[0]?.[0]
    expect(launchCall).toHaveProperty('agentArgs', '--model gpt-5')
  })

  it('keeps candidates through the prospective workspace adapter too', async () => {
    const onStart = vi.fn().mockResolvedValue(true)

    await expect(
      runSourceControlAgentActionStart(
        buildArgs({ onStart, worktreeId: undefined, groupId: undefined })
      )
    ).resolves.toBe(true)

    expect(onStart).toHaveBeenCalledWith({
      agent: 'codex',
      commandInput: 'Fix the bug',
      agentArgs: '--model gpt-5'
    })
  })

  // Why: the field being absent must not rewrite a value the user saved for terminal launches.
  it('still saves the recipe with the arguments the user had stored', async () => {
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' }
    })

    await runSourceControlAgentActionStart(buildArgs({ saveTargetValue: 'global' }))

    expect(mocks.onSaveAgentDefault).toHaveBeenCalledWith(
      expect.anything(),
      'resolveComments',
      expect.objectContaining({ agentArgs: '--model gpt-5' })
    )
  })
})

it('executes the actual bound namespace while saving the literal default recipe', async () => {
  const recipe = {
    agentId: null,
    commandInputTemplate: '{basePrompt}',
    agentArgs: '',
    launchPreferences: { agentId: 'codex' as const, model: 'chosen' }
  }
  const onStart = vi.fn().mockResolvedValue(true)
  await runSourceControlAgentActionStart(
    buildArgs({ recipe, onStart, selectedAgent: 'codex', saveTargetValue: 'global' })
  )
  expect(onStart).toHaveBeenCalledWith(
    expect.objectContaining({ sessionOptions: { model: 'chosen' } })
  )
  expect(mocks.onSaveAgentDefault).toHaveBeenLastCalledWith(
    { type: 'global' },
    'resolveComments',
    recipe
  )
})

it('confirms delivery and closes even while saving remains pending', async () => {
  mocks.launchAgentInNewTab.mockReturnValue({
    surface: { kind: 'local-terminal', tabId: 'tab-1' },
    promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
  })
  const onSaveAgentDefault = vi.fn(() => new Promise<void>(() => {}))
  const onLaunched = vi.fn()
  await expect(
    runSourceControlAgentActionStart(
      buildArgs({ saveTargetValue: 'global', onSaveAgentDefault, onLaunched })
    )
  ).resolves.toBe(true)
  expect(onLaunched).toHaveBeenCalledOnce()
  expect(mocks.onClose).toHaveBeenCalled()
})

it.each([undefined, '', '--add-dir /extra'])(
  'retains argument presence and inherited option precedence at adapter inputs (%s)',
  async (agentArgs) => {
    const recipe = {
      agentId: 'codex' as const,
      agentArgs,
      surface: 'terminal' as const,
      launchPreferences: { agentId: 'codex' as const, model: 'saved' },
      launchPreferencesYieldToAgentArgs: true as const
    }
    const onStart = vi.fn().mockResolvedValue(true)
    await runSourceControlAgentActionStart(buildArgs({ recipe, onStart }))
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        agentArgs,
        sessionOptions: { model: 'saved' },
        sessionOptionsYieldToAgentArgs: true
      })
    )
  }
)
// Saved to the repository, the copied choice owns the action there, as on every later launch.
it('launches a recipe being saved to the repository as its next launch will', async () => {
  vi.clearAllMocks()
  const base = getDefaultSettings('/tmp')
  const terra = { agentId: 'codex' as const, model: 'gpt-5.6-terra' }
  const fixCommitFailure = { agentId: null, commandInputTemplate: '', launchPreferences: terra }
  const settings = {
    ...base,
    sourceControlAi: { ...base.sourceControlAi!, actions: { fixCommitFailure } }
  }
  const legacy = { agentArgs: '--model gpt-5.6-sol' }
  const repo = {
    id: 'repo-1',
    sourceControlAi: { actionOverrides: { fixCommitFailure: legacy } }
  }
  const shown = resolveSourceControlActionRecipe({ settings, repo, actionId: 'fixCommitFailure' })
  mocks.launchAgentInNewTab.mockReturnValue({ surface: { kind: 'local-terminal', tabId: 't' } })
  const agentArgs = '--model gpt-5.6-luna'
  const recipe = { ...shown, agentArgs }
  const args = { recipe, settings, repo, saveTargetValue: 'repo', repoId: 'repo-1' }

  await runSourceControlAgentActionStart(buildArgs({ ...args, actionId: 'fixCommitFailure' }))

  expect(shown.launchPreferencesYieldToAgentArgs).toBe(true)
  expect(mocks.launchAgentInNewTab.mock.lastCall?.[0]).toMatchObject({
    agentArgs,
    sessionOptions: { model: 'gpt-5.6-terra' }
  })
  expect(mocks.launchAgentInNewTab.mock.lastCall?.[0]).not.toHaveProperty(
    'sessionOptionsYieldToAgentArgs'
  )
  expect(mocks.onSaveAgentDefault).toHaveBeenCalledWith(
    { type: 'repo', repoId: 'repo-1' },
    'fixCommitFailure',
    recipe
  )
  const firstLaunch = mocks.launchAgentInNewTab.mock.lastCall?.[0]
  const saved = saveSourceControlActionRecipe({
    target: { type: 'repo', repoId: 'repo-1' },
    settings,
    repo,
    actionId: 'fixCommitFailure',
    recipe: mocks.onSaveAgentDefault.mock.lastCall?.[2]
  })
  if (!('update' in saved)) {
    throw new Error('Expected repository save')
  }
  const savedRepo = { ...repo, sourceControlAi: saved.update.sourceControlAi ?? undefined }
  const replay = resolveSourceControlActionRecipe({
    settings,
    repo: savedRepo,
    actionId: 'fixCommitFailure'
  })
  await runSourceControlAgentActionStart(
    buildArgs({
      ...args,
      recipe: replay,
      repo: savedRepo,
      saveTargetValue: 'none',
      actionId: 'fixCommitFailure'
    })
  )
  expect(mocks.launchAgentInNewTab.mock.lastCall?.[0]).toMatchObject({
    agentArgs: firstLaunch.agentArgs,
    sessionOptions: firstLaunch.sessionOptions
  })
  expect(mocks.launchAgentInNewTab.mock.lastCall?.[0]).not.toHaveProperty(
    'sessionOptionsYieldToAgentArgs'
  )
})
