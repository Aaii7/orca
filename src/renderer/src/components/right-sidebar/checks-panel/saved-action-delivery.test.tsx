// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { PendingPRCommentAiAck } from '../pr-comments-ai-launch-ack'
import { clearPendingPRCommentAiAck, takePendingPRCommentAiAck } from '../pr-comments-ai-launch-ack'
import type { ChecksAgentComposerState } from './panel-state-types'
import { useChecksPanelAiQueue } from './use-checks-panel-ai-queue'
import { useChecksPanelAiAcknowledgement } from './use-checks-panel-ai-acknowledgement'

const launch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: launch }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }))
const original = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(original, true)
  clearPendingPRCommentAiAck()
  vi.clearAllMocks()
})
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(saved = true) {
  const settings = getDefaultSettings('/tmp/pr-31310')
  settings.sourceControlAi!.actions = saved
    ? {
        resolveComments: { agentId: 'codex', agentArgs: '', surface: 'terminal' },
        resolveConflicts: { agentId: 'codex' }
      }
    : {}
  const repo = { id: 'repo-1', path: '/repo', displayName: 'Repo', badgeColor: 'blue', addedAt: 1 }
  const worktree = makeWorktree({ id: 'repo-1::wt-1', repoId: repo.id })
  const inventory = deferred<('codex' | 'claude')[]>()
  useAppStore.setState({
    settings,
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] },
    detectedAgentIds: null,
    ensureDetectedAgents: () => inventory.promise
  })
  const pending = { current: null as PendingPRCommentAiAck | null }
  const claimed = { current: null as PendingPRCommentAiAck | null }
  const busy = { current: false }
  const accepted = { current: false }
  const context = { current: 'review::head' }
  const resolveThread = vi.fn().mockResolvedValue(true)
  const composer = vi.fn<(value: ChecksAgentComposerState | null) => void>()
  const view = renderHook(() => {
    const ack = useChecksPanelAiAcknowledgement({
      addPRConversationComment: vi.fn(),
      addPRReviewCommentReply: vi.fn(),
      asyncResultKeyRef: context,
      claimedCommentResolutionRef: claimed,
      commentsRef: { current: [] },
      commentsSelectionClearTokenRef: { current: 0 },
      pendingCommentResolutionRef: pending,
      resolveReviewThread: resolveThread,
      setCommentResolutionAckBusyNow: (value) => {
        busy.current = value
      },
      setComments: vi.fn(),
      setCommentsSelectionClearRequest: vi.fn(),
      commentResolutionLaunchAcceptedRef: accepted,
      fetchComments: vi.fn(),
      fetchGitLabDetails: vi.fn()
    })
    return useChecksPanelAiQueue({
      ...ack,
      activeConflictReview: null,
      activeReview: {
        provider: 'github',
        number: 42,
        title: 'Review',
        state: 'open',
        url: 'https://github.com/acme/repo/pull/42',
        status: 'pending',
        updatedAt: '',
        mergeable: 'MERGEABLE'
      },
      activeWorktree: worktree,
      activeWorktreeId: worktree.id,
      activeWorktreePath: worktree.path,
      activeConnectionId: null,
      activeSourceControlLaunchPlatform: 'linux',
      settings,
      asyncResultKeyRef: context,
      claimedCommentResolutionRef: claimed,
      commentResolutionAckBusyRef: busy,
      commentResolutionLaunchAcceptedRef: accepted,
      pendingCommentResolutionRef: pending,
      pr: null,
      prNumber: 42,
      repo,
      resolveCommentsWithAIDisabledReason: undefined,
      setAgentComposerState: composer,
      sourceControlAiActionsVisible: true,
      stateRequestKey: 'review::head'
    })
  })
  const groups = [
    {
      kind: 'thread' as const,
      threadId: 'thread-42',
      root: {
        id: 1,
        author: 'user',
        authorAvatarUrl: '',
        body: 'fix',
        createdAt: '',
        url: '',
        threadId: 'thread-42',
        isResolved: false
      },
      replies: []
    }
  ]
  return { ...view, inventory, groups, pending, claimed, busy, context, composer, resolveThread }
}

it('owns detection single-flight, returns failed delivery to the editor, then consumes its exact review once', async () => {
  const delivery = deferred<{ delivered: boolean; failureNotified: boolean }>()
  launch.mockReturnValue({
    surface: { kind: 'local-terminal', tabId: 'tab-1' },
    promptDeliveryResult: delivery.promise
  })
  const f = fixture()
  act(() => {
    f.result.current.handleResolveCommentsWithAI(f.groups)
    f.result.current.handleResolveCommentsWithAI(f.groups)
  })
  expect(launch).not.toHaveBeenCalled()
  const payload = f.pending.current
  await act(async () => f.inventory.resolve(['codex']))
  expect(launch).toHaveBeenCalledOnce()
  expect(launch.mock.calls[0]?.[0]).toMatchObject({
    agent: 'codex',
    worktreeId: 'repo-1::wt-1',
    agentArgs: '',
    requestedSurface: 'terminal'
  })
  expect(f.claimed.current).toBe(payload)
  await act(async () => f.result.current.handleResolveConflictsWithAI())
  expect(f.claimed.current).toBe(payload)
  expect(f.resolveThread).not.toHaveBeenCalled()
  await act(async () => delivery.resolve({ delivered: false, failureNotified: true }))
  expect(f.pending.current).toBe(payload)
  const editor = f.composer.mock.calls.at(-1)?.[0]
  expect(editor?.commentResolution).toBe(payload)
  // Retry uses the editor's captured callbacks even after the panel moves to another review.
  f.context.current = 'other-review::head'
  editor?.launchContext?.onLaunchAccepted?.()
  editor?.launchContext?.onLaunched?.()
  editor?.launchContext?.onLaunched?.()
  await waitFor(() => expect(f.resolveThread).toHaveBeenCalledOnce())
  expect(f.resolveThread).toHaveBeenCalledWith(
    '/repo',
    42,
    'thread-42',
    true,
    expect.objectContaining({ repoId: 'repo-1' })
  )
  expect(takePendingPRCommentAiAck()).toBeNull()
})

it.each([false, true])(
  'opens correction without substitution for no saved agent or unavailable saved agent (%s)',
  async (saved) => {
    const f = fixture(saved)
    act(() => f.result.current.handleResolveCommentsWithAI(f.groups))
    await act(async () => f.inventory.resolve(['claude']))
    await waitFor(() => expect(f.composer).toHaveBeenCalledOnce())
    expect(launch).not.toHaveBeenCalled()
    expect(f.composer.mock.calls[0]?.[0]?.launchContext?.initialRecipe?.agentId).toBe(
      saved ? 'codex' : undefined
    )
  }
)
