import type { ExecutionHostId } from '../../../shared/execution-host'

// Why: a host list built before a create landed can arrive after its reply; until a list shows
// the chat, omission is no evidence it closed. Bounded so a chat the host never lists still goes.
const UNLISTED_CREATED_CHAT_TTL_MS = 30_000

type UnlistedCreatedChat = {
  executionHostId: ExecutionHostId
  timer: ReturnType<typeof setTimeout>
}

const unlistedCreatedChats = new Map<string, UnlistedCreatedChat>()

function chatKey(worktreeId: string, sessionId: string): string {
  return `${worktreeId}\u0000${sessionId}`
}

/** This client's create reply landed for a chat no host list has shown yet. */
export function recordUnlistedCreatedChat(
  worktreeId: string,
  sessionId: string,
  executionHostId: ExecutionHostId
): void {
  forgetUnlistedCreatedChat(worktreeId, sessionId)
  const key = chatKey(worktreeId, sessionId)
  const record: UnlistedCreatedChat = {
    executionHostId,
    timer: setTimeout(() => {
      if (unlistedCreatedChats.get(key) !== record) {
        return
      }
      unlistedCreatedChats.delete(key)
      // Unchanged lists are never republished, so re-read the one an omission was held against.
      // Lazy: tab retirement reaches this module through launch publication.
      void import('@/runtime/structured-agent-session-tab-retirement')
        .then(({ reacceptStructuredSessionHostTabs }) =>
          reacceptStructuredSessionHostTabs(executionHostId, worktreeId)
        )
        .catch((error: unknown) =>
          console.warn('[native-chat] re-reading an unlisted chat failed', error)
        )
    }, UNLISTED_CREATED_CHAT_TTL_MS)
  }
  unlistedCreatedChats.set(key, record)
}

export function isUnlistedCreatedChat(worktreeId: string, sessionId: string): boolean {
  return unlistedCreatedChats.has(chatKey(worktreeId, sessionId))
}

/** `listedBy` limits the release to a list from the host the chat was created on. */
export function forgetUnlistedCreatedChat(
  worktreeId: string,
  sessionId: string,
  listedBy?: ExecutionHostId
): void {
  const key = chatKey(worktreeId, sessionId)
  const record = unlistedCreatedChats.get(key)
  if (!record || (listedBy !== undefined && record.executionHostId !== listedBy)) {
    return
  }
  clearTimeout(record.timer)
  unlistedCreatedChats.delete(key)
}
