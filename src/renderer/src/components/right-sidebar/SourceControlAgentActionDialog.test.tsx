// @vitest-environment happy-dom

import path from 'node:path'
import React, { type ReactNode, useState, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TuiAgent } from '../../../../shared/tui-agent'

const mocks = vi.hoisted(() => ({
  ensureDetectedAgents: vi.fn(),
  ensureRemoteDetectedAgents: vi.fn(),
  ensureRuntimeDetectedAgents: vi.fn(),
  onOpenChange: vi.fn(),
  onSaveAgentDefault: vi.fn(),
  onLaunched: vi.fn(),
  onStart: vi.fn(),
  checkSourceControlAgentActionLaunch: vi.fn(),
  toastError: vi.fn()
}))
vi.mock('@/components/agent/AgentCombobox', () => ({
  default: ({ value }: { value: string | null }) =>
    React.createElement('div', { 'data-agent-value': value ?? '' })
}))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? React.createElement('div', { 'data-dialog-open': 'true' }, children) : null,
  DialogContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DialogDescription: ({ children }: { children?: ReactNode }) =>
    React.createElement('p', null, children),
  DialogFooter: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DialogHeader: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => React.createElement('h2', null, children)
}))
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children?: ReactNode }) => React.createElement('div', null, children),
  SelectContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  SelectItem: ({ children, value }: { children?: ReactNode; value: string }) =>
    React.createElement('div', { 'data-select-item': value }, children),
  SelectTrigger: ({ children }: { children?: ReactNode }) =>
    React.createElement('button', null, children),
  SelectValue: () => React.createElement('span')
}))
vi.mock('../source-control/SourceControlActionVariableChips', () => ({
  SourceControlActionVariableChips: () => React.createElement('div')
}))
vi.mock('@/lib/source-control-agent-action-launch-check', () => ({
  checkSourceControlAgentActionLaunch: mocks.checkSourceControlAgentActionLaunch
}))
vi.mock('sonner', () => ({
  toast: { error: mocks.toastError }
}))
import { useAppStore, type AppState } from '@/store'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { SourceControlAgentActionDialog } from './SourceControlAgentActionDialog'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { getRuntimeAgentInventoryKey } from '@/store/slices/runtime-agent-inventory-key'
let container: HTMLDivElement
let root: Root
let initialState: AppState
function settingsWithGlobalRecipe(
  recipe: SourceControlActionRecipe | null = {
    agentId: 'codex',
    commandInputTemplate: '{basePrompt}',
    agentArgs: ''
  },
  disabledTuiAgents: GlobalSettings['disabledTuiAgents'] = []
): GlobalSettings {
  const base = getDefaultSettings(path.resolve('tmp'))
  return {
    ...base,
    defaultTuiAgent: 'codex',
    disabledTuiAgents,
    sourceControlAi: {
      ...base.sourceControlAi!,
      enabled: true,
      agentId: 'codex',
      customAgentCommand: '',
      actions: recipe ? { resolveConflicts: recipe } : {}
    }
  }
}
function repoWithSavedRecipe(
  agentArgs = '',
  connectionId: string | null = null,
  executionHostId: Repo['executionHostId'] = undefined
): Repo {
  return {
    id: 'repo-1',
    path: '/repo-1',
    displayName: 'Repo 1',
    badgeColor: 'blue',
    addedAt: 0,
    connectionId,
    executionHostId,
    sourceControlAi: {
      enabled: true,
      actionOverrides: {
        resolveConflicts: {
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}',
          agentArgs
        }
      }
    }
  }
}
function resetStore(settings: GlobalSettings, repos: Repo[] = []): void {
  useAppStore.setState(
    {
      ...initialState,
      settings,
      repos,
      ensureDetectedAgents: mocks.ensureDetectedAgents,
      ensureRemoteDetectedAgents: mocks.ensureRemoteDetectedAgents,
      ensureRuntimeDetectedAgents: mocks.ensureRuntimeDetectedAgents
    },
    true
  )
}
// The dialog reads the store's inventory, so the probes write it the way the real actions do.
function detects(ids: TuiAgent[]): void {
  mocks.ensureDetectedAgents.mockImplementation(async () => {
    useAppStore.setState({ detectedAgentIds: ids })
    return ids
  })
  mocks.ensureRemoteDetectedAgents.mockImplementation(async (connectionId: string) => {
    useAppStore.setState((state) => ({
      remoteDetectedAgentIds: { ...state.remoteDetectedAgentIds, [connectionId]: ids }
    }))
    return ids
  })
  mocks.ensureRuntimeDetectedAgents.mockImplementation(
    async (environmentId: string, worktreeId?: string) => {
      const key = getRuntimeAgentInventoryKey(environmentId, worktreeId)
      useAppStore.setState((state) => ({
        runtimeDetectedAgentIds: { ...state.runtimeDetectedAgentIds, [key]: ids }
      }))
      return ids
    }
  )
}
function renderControlledDialog(
  overrides: Partial<React.ComponentProps<typeof SourceControlAgentActionDialog>> = {},
  options: { strictMode?: boolean } = {}
): void {
  function Harness(): React.JSX.Element {
    const [open, setOpen] = useState(true)
    return (
      <SourceControlAgentActionDialog
        open={open}
        onOpenChange={(nextOpen) => {
          mocks.onOpenChange(nextOpen)
          setOpen(nextOpen)
        }}
        actionId="resolveConflicts"
        title="Launch agent"
        description="Review the launch recipe before starting."
        baseCommandInput="Resolve conflicts."
        savedCommandInputTemplate="{basePrompt}"
        savedAgentArgs=""
        launchSource="source_control_recovery"
        savedAgentId="codex"
        onSaveAgentDefault={mocks.onSaveAgentDefault}
        onLaunched={mocks.onLaunched}
        onStart={mocks.onStart}
        {...overrides}
      />
    )
  }

  act(() => {
    root.render(
      options.strictMode ? (
        <React.StrictMode>
          <Harness />
        </React.StrictMode>
      ) : (
        <Harness />
      )
    )
  })
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
describe('SourceControlAgentActionDialog', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests(null)
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    initialState = useAppStore.getState()
    vi.clearAllMocks()
    detects(['codex'])
    mocks.onStart.mockResolvedValue(true)
    mocks.checkSourceControlAgentActionLaunch.mockReturnValue({ ok: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    resetStore(settingsWithGlobalRecipe())
  })
  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    useAppStore.setState(initialState, true)
    setLocalRuntimeCapabilitiesForTests(null)
  })
  it.each(['global', 'repo'])(
    'opens saved %s recipes for editing and Cancel starts nothing',
    async (scope) => {
      if (scope === 'repo') {
        resetStore(settingsWithGlobalRecipe(), [repoWithSavedRecipe()])
      }
      renderControlledDialog(scope === 'repo' ? { repoId: 'repo-1' } : {})
      await flushEffects()
      expect(container.textContent).toContain('Launch agent')
      expect(container.querySelector('textarea')?.value).toBe('{basePrompt}')
      const cancel = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Cancel'
      )!
      act(() => cancel.click())
      expect(mocks.onStart).not.toHaveBeenCalled()
      expect(mocks.onLaunched).not.toHaveBeenCalled()
    }
  )
  // Why (#21429): a paired server's workspace has no SSH connection on this client; its agents
  // are on the server, and this client's own list says nothing about them.
  it('detects agents on the paired server that owns the workspace', async () => {
    detects([])
    mocks.ensureRuntimeDetectedAgents.mockImplementation(async (environmentId, worktreeId) => {
      const key = getRuntimeAgentInventoryKey(environmentId, worktreeId)
      useAppStore.setState({ runtimeDetectedAgentIds: { [key]: ['codex'] } })
      return ['codex']
    })
    resetStore(settingsWithGlobalRecipe(), [repoWithSavedRecipe('', null, 'runtime:env-1')])
    useAppStore.setState({
      worktreesByRepo: { 'repo-1': [makeWorktree({ id: 'repo-1::wt-1', repoId: 'repo-1' })] }
    })

    renderControlledDialog({ repoId: 'repo-1', worktreeId: 'repo-1::wt-1', connectionId: null })

    await vi.waitFor(() =>
      expect(mocks.ensureRuntimeDetectedAgents).toHaveBeenCalledWith('env-1', 'repo-1::wt-1')
    )
    expect(mocks.onStart).not.toHaveBeenCalled()
    const start = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.toLowerCase().includes('start agent')
    )!
    await act(async () => start.click())
    expect(mocks.onStart).toHaveBeenCalledTimes(1)
    expect(mocks.ensureRuntimeDetectedAgents).toHaveBeenCalledWith('env-1', 'repo-1::wt-1')
    expect(mocks.ensureDetectedAgents).not.toHaveBeenCalled()
  })
})
