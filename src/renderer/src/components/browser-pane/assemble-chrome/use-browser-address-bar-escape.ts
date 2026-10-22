import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import { requestBrowserFocus } from '../host-guest/browser-focus'

export type BrowserAddressBarEscapeStep = 'restore-typed' | 'close' | 'revert' | 'leave'

/** Chromium's OmniboxEditModel::OnEscapeKeyPressed order: each press takes the first step that applies. */
export function resolveBrowserAddressBarEscape({
  previewing,
  open,
  inputInProgress
}: {
  previewing: boolean
  open: boolean
  inputInProgress: boolean
}): BrowserAddressBarEscapeStep {
  if (previewing) {
    return 'restore-typed'
  }
  if (open) {
    return 'close'
  }
  return inputInProgress ? 'revert' : 'leave'
}

export function useBrowserAddressBarEscape({
  pageId,
  inputRef,
  value,
  committedValue,
  open,
  previewing,
  restoreTypedQuery,
  closeSuggestions,
  onChange,
  onLeave
}: {
  pageId: string
  inputRef: RefObject<HTMLInputElement | null>
  value: string
  /** What the bar shows when nobody is editing it: the page's address. */
  committedValue: string
  open: boolean
  /** An arrowed-to row fills the bar (Chrome's temporary text); an inline completion is not one. */
  previewing: boolean
  restoreTypedQuery: () => void
  closeSuggestions: () => void
  onChange: (value: string) => void
  onLeave?: () => void
}): {
  handleEscapeKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => boolean
  /** What the user's own keystroke put in the bar; null once it is submitted or picked. */
  noteTyped: (value: string | null) => void
} {
  const typedValueRef = useRef<string | null>(null)
  const selectAllOnCommitRef = useRef(false)

  // Why after commit: React moves the caret to the end when it writes a new value into a focused
  // input, so selecting in the handler would be undone by the reverted text landing.
  useLayoutEffect(() => {
    if (!selectAllOnCommitRef.current) {
      return
    }
    selectAllOnCommitRef.current = false
    inputRef.current?.select()
  }, [inputRef, value])

  const noteTyped = useCallback((typed: string | null) => {
    typedValueRef.current = typed
  }, [])

  const handleEscapeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): boolean => {
      if (event.key !== 'Escape' || isImeOwnedKeyboardEvent(event)) {
        return false
      }
      event.preventDefault()
      event.stopPropagation()
      // Why both: the typed text tells a retyped page address from an untouched one, and the
      // comparison covers drafts handed over from a pane that remounted mid-edit.
      const inputInProgress = value === typedValueRef.current || value !== committedValue
      const step = resolveBrowserAddressBarEscape({ previewing, open, inputInProgress })
      if (step === 'restore-typed') {
        restoreTypedQuery()
      } else if (step === 'close') {
        closeSuggestions()
      } else if (step === 'revert') {
        typedValueRef.current = null
        if (value === committedValue) {
          inputRef.current?.select()
        } else {
          selectAllOnCommitRef.current = true
          onChange(committedValue)
        }
      } else if (onLeave) {
        onLeave()
      } else {
        requestBrowserFocus({ pageId, target: 'webview' })
      }
      return true
    },
    [
      closeSuggestions,
      committedValue,
      inputRef,
      onChange,
      onLeave,
      open,
      pageId,
      previewing,
      restoreTypedQuery,
      value
    ]
  )

  return { handleEscapeKeyDown, noteTyped }
}
