import type {
  RemovedWorkEntry,
  ResetRemovedWork,
  RunRemovedWork
} from '../../../shared/orchestration-removed-work'

const count = (n: number, noun: string, plural = `${noun}s`): string =>
  `${n} ${n === 1 ? noun : plural}`
const listCommand = (runId: string): string => `orca orchestration run-show --id ${runId} --removed`

function partialNote(removed: RunRemovedWork): string {
  return removed.coverage === 'partial'
    ? `; removals before ${removed.recordedSince} were not recorded`
    : ''
}

/** The run-show line, or nothing when the Run has no removed work or the host keeps no record. */
export function formatRunRemovedWorkLine(runId: string, removed?: RunRemovedWork): string {
  if (!removed || removed.tasks + removed.dispatches + removed.workers + removed.terminals === 0) {
    return ''
  }
  const active = removed.activeWorkersAtRemoval
  return (
    `\nremoved work: ${count(removed.tasks, 'task')}, ${count(removed.dispatches, 'dispatch', 'dispatches')}, ` +
    `${count(removed.workers, 'worker')}${active > 0 ? ` (${active} may still be running)` : ''}` +
    `${partialNote(removed)}. List it: ${listCommand(runId)}`
  )
}

function formatEntry(entry: RemovedWorkEntry): string {
  const part = (label: string, value: string | null | undefined): string =>
    value ? `${label}${value}` : ''
  if ('unreadable' in entry) {
    return `${entry.kind} ${entry.id}: record unreadable`
  }
  switch (entry.kind) {
    case 'task':
      return `task ${entry.id}${entry.title ? ` "${entry.title}"` : ''}${part(', parent ', entry.parentTaskId)}${part(', created by ', entry.createdByHandle)}`
    case 'dispatch': {
      const creator = [entry.creatorDispatchId, entry.creatorHandle].filter(Boolean).join(' / ')
      return `dispatch ${entry.id}${part(' for ', entry.taskId)}${part(', created by ', creator)}${part(', assigned to ', entry.assigneeHandle)}${part(', status ', entry.status)}`
    }
    case 'terminal':
      return `terminal ${entry.id} ${entry.terminalHandle ?? ''} owned by ${entry.ownerDispatchId ?? 'unknown'}: ${entry.releaseState === 'released' ? 'released' : 'not released'}`
    case 'federated_worker':
      return `federated worker ${entry.id}${part(' on ', entry.environmentName)}${part(' in ', entry.remoteTerminalHandle)}: ${entry.dispatchStatus ?? 'unknown'} when removed${entry.activeAtRemoval ? ', may still be running' : ''}`
    default: {
      const label = entry.kind === 'remote_worker' ? 'remote worker' : 'worker'
      return `${label} ${entry.id}${part(' in ', entry.terminalHandle)}${entry.worktreeId ? ` (worktree ${entry.worktreeId})` : ''}: ${entry.state ?? 'unknown'} when removed${entry.activeAtRemoval ? ', may still be running' : ''}`
    }
  }
}

/** run-show --removed: one line per removed entity, then the next-page hint. */
export function formatRemovedWorkListing(runId: string, removed?: RunRemovedWork): string {
  if (!removed) {
    return 'This Orca host does not keep a record of removed work.'
  }
  const entries = removed.entries ?? []
  if (entries.length === 0) {
    return `No removed work recorded for this Run${partialNote(removed)}.`
  }
  const lines = [`Removed work in ${runId}${partialNote(removed)}`, ...entries.map(formatEntry)]
  if (removed.page?.nextCursor) {
    lines.push(`More: ${listCommand(runId)} --cursor ${removed.page.nextCursor}`)
  }
  return lines.join('\n')
}

export function formatResetResult(result: { reset: string; removed?: ResetRemovedWork }): string {
  const removed = result.removed
  if (!removed || removed.tasks + removed.dispatches + removed.workers === 0) {
    return `Reset: ${result.reset}`
  }
  const running = removed.possiblyRunning
  const runningNote =
    running > 0
      ? ` ${count(running, 'worker')} may still be running: reset stops tracking workers but does not stop them.`
      : ''
  return (
    `Reset: ${result.reset}. Removed ${count(removed.tasks, 'task')}, ` +
    `${count(removed.dispatches, 'dispatch', 'dispatches')} and ${count(removed.workers, 'worker')} ` +
    `from ${count(removed.runs, 'Run')}.${runningNote} List what was removed: ${listCommand('<run_id>')}`
  )
}
