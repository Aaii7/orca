import { useCallback } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import { useAppStore } from '@/store'
import type { BrowserAddressBarSuggestion } from '../assemble-chrome/browser-address-bar-suggestions'

type RemovableRow = Pick<BrowserAddressBarSuggestion, 'normalizedUrl' | 'docLocation'>

export function isRemovableHistoryRow(row: RemovableRow): boolean {
  return row.docLocation !== undefined || row.normalizedUrl !== undefined
}

/** Removes a visited page or document from history, so it stops being suggested anywhere. */
export function useRemoveHistoryRow(): (row: RemovableRow) => void {
  const removeBrowserHistoryEntry = useAppStore((s) => s.removeBrowserHistoryEntry)
  const removeWorkspaceDocHistoryEntry = useAppStore((s) => s.removeWorkspaceDocHistoryEntry)
  return useCallback(
    (row: RemovableRow) => {
      if (row.docLocation) {
        removeWorkspaceDocHistoryEntry(row.docLocation)
      } else if (row.normalizedUrl !== undefined) {
        removeBrowserHistoryEntry(row.normalizedUrl)
      }
    },
    [removeBrowserHistoryEntry, removeWorkspaceDocHistoryEntry]
  )
}

/** Chrome's Shift+Delete (Shift+Fn+Delete on Mac laptops) on the highlighted row. */
export function isRemoveRowShortcut(event: React.KeyboardEvent): boolean {
  return (
    event.key === 'Delete' &&
    event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !isImeOwnedKeyboardEvent(event)
  )
}

/** The X on a history row: shown when cmdk marks the row selected (hover or arrows), like Chrome's. */
export function BrowserHistoryRowRemoveButton({
  onRemove
}: {
  onRemove: () => void
}): React.JSX.Element {
  const label = translate('browser.history.remove', 'Remove from history')
  return (
    <span className="shrink-0 text-muted-foreground opacity-0 [[data-selected=true]_&]:opacity-100">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            tabIndex={-1}
            aria-label={label}
            // Why: keep focus in the text field, so its list keeps the keyboard after the row goes.
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation()
              onRemove()
            }}
          >
            <X />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}
