import type { Repo } from '../../../shared/repo-types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import { isFolderRepo } from '../../../shared/repo-kind'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import type {
  AgentMenuRowsTarget,
  NewTabAgentMenuModel
} from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import type { AgentLaunchSurface } from '@/lib/agent-session-launch-plan'

/** The workspace a Source Control agent picker lists rows for, and the host whose agents it reads. */
export type SourceControlAgentRows = {
  target: string | AgentMenuRowsTarget
  detectionTarget: AgentDetectionTarget | undefined
}

/** A launch into a workspace the repo does not have yet, named the way the create dialog names it. */
export function sourceControlRepoAgentRows(
  repo: Pick<Repo, 'id' | 'kind' | 'connectionId' | 'executionHostId'> | null
): SourceControlAgentRows {
  if (!repo) {
    // Why: no project row means no owning host to ask, so its rows stay unavailable.
    return { target: { workspace: { kind: 'git-worktree' } }, detectionTarget: undefined }
  }
  const executionHostId = getRepoExecutionHostId(repo)
  const host = parseExecutionHostId(executionHostId)
  return {
    target: {
      workspace: {
        kind: isFolderRepo(repo) ? 'folder' : 'git-worktree',
        repoId: repo.id,
        executionHostId
      }
    },
    // A paired server answers for its own projects; this client never stands in for it.
    detectionTarget:
      host?.kind === 'runtime'
        ? { kind: 'runtime', environmentId: host.environmentId }
        : host?.kind === 'ssh'
          ? { kind: 'ssh', connectionId: host.targetId }
          : { kind: 'local' }
  }
}

/**
 * What a pick saves: a surface only where the agent had a chat row, i.e. the user really chose
 * between its chat and its CLI. A plain-mode or CLI-only row saves nothing, so the action keeps
 * following the agent's settings route if chats become available later.
 */
export function savedSurfaceForPick(
  model: NewTabAgentMenuModel,
  agent: TuiAgent,
  surface: AgentLaunchSurface | undefined
): AgentLaunchSurface | undefined {
  const hadChoice =
    model.state === 'settled' &&
    model.rows.some((row) => row.agent === agent && row.kind === 'chat')
  return hadChoice ? surface : undefined
}
