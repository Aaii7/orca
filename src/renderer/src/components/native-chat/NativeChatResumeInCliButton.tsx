import { SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { AI_VAULT_AGENTS } from '../../../../shared/ai-vault-types'
import {
  runNativeChatCliFork,
  useNativeChatCliForkPending
} from '../tab-bar/native-chat-cli-fork-run'
import {
  resolveTabSessionHistorySubject,
  type NativeChatTabSession
} from '../tab-bar/tab-session-history-switch'

export function NativeChatResumeInCliButton({
  tabId,
  worktreeId,
  nativeChat
}: {
  tabId: string
  worktreeId: string
  nativeChat: NativeChatTabSession
}): React.JSX.Element | null {
  const tab = { id: tabId, worktreeId }
  const subject = resolveTabSessionHistorySubject(useAppStore.getState(), { tab, nativeChat })
  const chat = subject?.kind === 'chat' ? subject : null
  const pending = useNativeChatCliForkPending(chat)
  const commandOverrides = useAppStore((state) => state.settings?.agentCmdOverrides)
  const agent = AI_VAULT_AGENTS.find((candidate) => candidate === nativeChat.agent)
  const label = translate(
    'components.tab.bar.SortableTabContextMenu.switchToTerminalView',
    'Continue with Terminal Agent'
  )
  if (!chat || !agent) {
    return null
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="pane-title"
          size="icon-xs"
          aria-label={label}
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={(event) => {
            event.stopPropagation()
            void runNativeChatCliFork({ subject: chat, tab, agent, commandOverrides })
          }}
        >
          <SquareTerminal className="size-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
