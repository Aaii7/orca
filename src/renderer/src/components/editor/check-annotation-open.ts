import { detectLanguage } from '@/lib/language-detect'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { scheduleEditorLineReveal } from '@/store/slices/editor/focus/editor-focus-reveal'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import {
  getOpenableAnnotationLine,
  resolveAnnotationPathInsideWorktree
} from './check-annotation-path'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

export { getOpenableAnnotationLine }

export function openAnnotationLocation(params: {
  worktreeId: string
  path: string
  line: number
}): void {
  const { worktreeId, path, line } = params
  const store = useAppStore.getState()
  const worktree = findWorktreeById(selectWorktreesByRepo(store), worktreeId)
  if (!worktree) {
    return
  }
  const resolvedPath = resolveAnnotationPathInsideWorktree(worktree.path, path)
  if (!resolvedPath) {
    return
  }
  const { absolutePath, relativePath } = resolvedPath
  const language = detectLanguage(relativePath)

  // Why: reuse the shared activation path so an annotation jump lands in the
  // same history stack as sidebar, palette, and terminal-link navigation.
  activateAndRevealWorktree(worktreeId, { providesInitialSurface: true })

  const fileId = store.openFile(
    { filePath: absolutePath, relativePath, worktreeId, language, mode: 'edit' },
    { forceContentReload: true }
  )
  if (language === 'markdown') {
    store.setMarkdownViewMode(fileId, 'source')
  }
  scheduleEditorLineReveal(useAppStore.getState, absolutePath, line, 1, fileId)
}
