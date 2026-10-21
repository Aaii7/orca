// @vitest-environment happy-dom
// Real store, Split action, launch registry and list apply; only host transport is faked.
import { expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { getDefaultSettings } from '../../../shared/constants'

const host = vi.hoisted(() => {
  const replies: ((value: unknown) => void)[] = []
  return { replies, list: {} }
})
vi.mock('@/runtime/structured-agent-session-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callStructuredAgentSession: (_target: unknown, method: string) =>
    method === 'agentSession.create'
      ? new Promise((resolve) => host.replies.push(resolve))
      : Promise.resolve({ supported: true })
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: async () => host.list }))
vi.mock('@/lib/structured-agent-session-create-hydration', () => ({
  publishStructuredAgentSessionCreateHydration: vi.fn()
}))

import { useAppStore } from '@/store'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHATS } from '../../../shared/agent-session-runtime-capabilities'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY as CREATE } from '../../../shared/agent-session-create-capabilities'
import { runNativeChatSplitTarget } from '@/components/native-chat/native-chat-layout-actions'
import { applyStructuredSessionTabSnapshots } from '@/runtime/local-structured-session-tabs-sync/snapshot-apply'
import { getStructuredAgentSessionLaunchLifecycle } from '@/lib/structured-agent-session-launch'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { isUnlistedCreatedChat } from './structured-agent-session-unlisted-created-chats'

const WT = 'repo1::/tmp/wt1'
const tabId = (sid: string) => `structured-agent-session-${sid}`
let version = 100
const CHAT_ROW = { type: 'agent-session', agent: 'claude', title: 'Chat', isActive: false } as const

function hostList(groupId: string, extra?: string): RuntimeMobileSessionTabsResult {
  const sids = extra ? ['b', extra] : ['b']
  const ids = sids.map((sid) => `agent-session:${sid}`)
  return {
    worktree: WT,
    publicationEpoch: 'renderer:split-flow',
    snapshotVersion: ++version,
    activeGroupId: groupId,
    activeTabId: null,
    activeTabType: null,
    tabGroups: [{ id: groupId, activeTabId: ids[0]!, tabOrder: ids }],
    tabs: sids.map((sid, i) => ({ ...CHAT_ROW, id: ids[i]!, sessionId: sid }))
  }
}

const state = () => useAppStore.getState()
const groupOf = (id: string) => state().groupsByWorktree[WT]?.find((g) => g.tabOrder.includes(id))

/** Split Right from chat `b`; resolves once the new chat's create call is in flight. */
async function split(): Promise<{ groupB: string; sid: string; groupN: string }> {
  host.replies.length = 0
  setLocalRuntimeCapabilitiesForTests([CHATS, CREATE])
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), experimentalNativeChat: true },
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/tmp/wt1' })] },
    activeWorktreeId: WT
  })
  const source = { id: tabId('b'), entityId: 'b', agentSessionAgent: 'claude' } as const
  const { groupId: groupB } = state().createUnifiedTab(WT, 'agent-session', source)
  applyStructuredSessionTabSnapshots([hostList(groupB)], undefined, { authoritative: true })
  const target = { kind: 'workspace-tab', unifiedTabId: tabId('b'), groupId: groupB } as const
  expect(runNativeChatSplitTarget(target, 'right')).toBe(true)
  await vi.waitFor(() => expect(host.replies).toHaveLength(1))
  const tab = state().unifiedTabsByWorktree[WT]!.find((t) => t.entityId !== 'b')!
  return { groupB, sid: tab.entityId, groupN: tab.groupId }
}

async function reply(sid: string): Promise<void> {
  host.replies[0]!({ ok: true, value: { sessionId: sid, fence: 1 } })
  await vi.waitFor(() => expect(getStructuredAgentSessionLaunchLifecycle(WT, sid)).toBeNull())
}

it.each(['after', 'before'] as const)(
  'a new chat a host first lists %s its create reply stays active in its own pane',
  async (listed) => {
    const { groupB, sid, groupN } = await split()
    if (listed === 'before') {
      applyStructuredSessionTabSnapshots([hostList(groupB, sid)])
    }
    await reply(sid)
    if (listed === 'after') {
      // Built before the create landed, applied after its reply.
      applyStructuredSessionTabSnapshots([hostList(groupB)])
      applyStructuredSessionTabSnapshots([hostList(groupB, sid)])
    }
    expect(groupOf(tabId(sid))).toMatchObject({ id: groupN, activeTabId: tabId(sid) })
    expect(state().activeGroupIdByWorktree[WT]).toBe(groupN)
    expect(isUnlistedCreatedChat(WT, sid)).toBe(false)
  }
)

it('a chat its host closed before ever listing it goes once the protection lapses', async () => {
  const { groupB, sid, groupN } = await split()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await reply(sid)
  // The re-read returns the version already applied: nothing republishes an unchanged list.
  applyStructuredSessionTabSnapshots([(host.list = hostList(groupB))])
  expect(groupOf(tabId(sid))?.id).toBe(groupN)
  await vi.advanceTimersByTimeAsync(30_000)
  vi.useRealTimers()
  await vi.waitFor(() => expect(groupOf(tabId(sid))).toBeUndefined())
})
