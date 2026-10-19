/** Record fields kept for each kind of removed orchestration work; 'list' is an array of ids. */
export const REMOVED_WORK_FIELDS = {
  task: {
    parentTaskId: 'text',
    title: 'text',
    createdByHandle: 'text',
    createdByPaneKey: 'text',
    deps: 'list',
    status: 'text',
    createdAt: 'text'
  },
  dispatch: {
    taskId: 'text',
    retryOfDispatchId: 'text',
    creatorDispatchId: 'text',
    creatorHandle: 'text',
    creatorPaneKey: 'text',
    creatorOrcaSessionId: 'text',
    assigneeHandle: 'text',
    assigneePaneKey: 'text',
    assigneeOrcaSessionId: 'text',
    hostScope: 'text',
    depth: 'int',
    status: 'text',
    // Null when unknown: the Dispatch ended with no certified cause, or before this key existed.
    terminationReason: 'text',
    createdAt: 'text'
  },
  worker: {
    state: 'text',
    stage: 'text',
    worktreeId: 'text',
    terminalHandle: 'text',
    createdAt: 'text'
  },
  terminal: {
    originDispatchId: 'text',
    ownerDispatchId: 'text',
    priorOwnerDispatchIds: 'list',
    terminalHandle: 'text',
    paneKey: 'text',
    worktreeId: 'text',
    hostScope: 'text',
    ownershipState: 'text',
    releaseState: 'text',
    createdAt: 'text'
  },
  remote_worker: {
    taskId: 'text',
    homePeerFingerprint: 'text',
    state: 'text',
    stage: 'text',
    worktreeId: 'text',
    terminalHandle: 'text',
    paneKey: 'text',
    depth: 'int',
    createdAt: 'text'
  },
  federated_worker: {
    environmentId: 'text',
    environmentName: 'text',
    remoteWorktreeId: 'text',
    remoteTerminalHandle: 'text',
    dispatchStatus: 'text',
    createdAt: 'text'
  }
} as const

export type RemovedWorkKind = keyof typeof REMOVED_WORK_FIELDS
export function isRemovedWorkKind(kind: string): kind is RemovedWorkKind {
  return Object.hasOwn(REMOVED_WORK_FIELDS, kind)
}
export type RemovedWorkFieldType = 'text' | 'int' | 'list'
type FieldValue<T> = T extends 'int'
  ? number | null
  : T extends 'list'
    ? string[] | null
    : string | null
type WorkerKind = 'worker' | 'remote_worker' | 'federated_worker'

type RemovedWorkEntryBase = { seq: number; id: string; removedAt: string }
export type RemovedWorkEntry =
  | {
      [K in RemovedWorkKind]: RemovedWorkEntryBase & {
        kind: K
      } & (K extends WorkerKind ? { activeAtRemoval: boolean } : unknown) & {
          -readonly [F in keyof (typeof REMOVED_WORK_FIELDS)[K]]: FieldValue<
            (typeof REMOVED_WORK_FIELDS)[K][F]
          >
        }
    }[RemovedWorkKind]
  | (RemovedWorkEntryBase & { kind: string; unreadable: true })

/** `orchestration.runShow` result `removedWork`: constant size unless entries were requested. */
export type RunRemovedWork = {
  // 'partial': the Run predates recordedSince, so earlier removals were not recorded.
  coverage: 'complete' | 'partial'
  recordedSince: string
  tasks: number
  dispatches: number
  workers: number
  terminals: number
  activeWorkersAtRemoval: number
  lastRemovedAt: string | null
  entries?: RemovedWorkEntry[]
  page?: { hasMore: boolean; nextCursor: string | null }
}

/** `orchestration.reset --tasks` result `removed`: what this reset removed, across every Run. */
export type ResetRemovedWork = {
  runs: number
  // Absent from hosts that predate it.
  runIds?: string[]
  tasks: number
  dispatches: number
  workers: number
  possiblyRunning: number
}

export const REMOVED_WORK_PAGE_SIZE = 200
