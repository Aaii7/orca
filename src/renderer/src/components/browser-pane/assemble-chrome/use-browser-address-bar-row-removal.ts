import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import type { BrowserAddressBarSuggestion } from './browser-address-bar-suggestions'

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

/** Removes a dropdown row, then puts back what was typed if that row filled the bar. */
export function useRemoveSuggestionRow(
  restoreTypedQuery: () => void
): (row: BrowserAddressBarSuggestion) => void {
  const removeHistoryRow = useRemoveHistoryRow()
  return useCallback(
    (row: BrowserAddressBarSuggestion) => {
      removeHistoryRow(row)
      // Why: a previewed or inline-completed row would otherwise stay in the bar for Enter to submit.
      restoreTypedQuery()
    },
    [removeHistoryRow, restoreTypedQuery]
  )
}
