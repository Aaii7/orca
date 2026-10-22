// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PRComment } from '../../../../../shared/github/comment-types'
import { getPRCommentPresentationClasses } from '../pr-comment-presentation'
import { CommentRow } from './comment-row'

afterEach(cleanup)

const reviewComment: PRComment = {
  id: 1,
  author: 'reviewer',
  authorAvatarUrl: '',
  body: 'findProjectRoot treats any folder as an app',
  createdAt: '2026-10-21T00:00:00Z',
  url: 'https://github.com/o/r/pull/1#discussion_r1',
  path: 'src/cli/doctor.ts',
  threadId: 'thread-1',
  startLine: 370,
  line: 380
}

function renderRow(comment: PRComment, onOpenLocation = vi.fn()): typeof onOpenLocation {
  render(
    <CommentRow
      comment={comment}
      botAuthorOverrides={new Set()}
      isReply={false}
      showResolve={false}
      actionState="open"
      isQueued={false}
      presentation={getPRCommentPresentationClasses()}
      now={Date.parse('2026-10-22T00:00:00Z')}
      onOpenLocation={onOpenLocation}
    />
  )
  return onOpenLocation
}

describe('CommentRow location', () => {
  it('opens the full repo path at the first line of the commented range', () => {
    const onOpenLocation = renderRow(reviewComment)

    screen.getByRole('button', { name: 'doctor.ts:L370-L380' }).click()

    expect(onOpenLocation).toHaveBeenCalledWith('src/cli/doctor.ts', 370)
  })

  it('keeps a file-level comment without a line as plain text', () => {
    renderRow({ ...reviewComment, startLine: undefined, line: undefined })

    expect(screen.getByText('doctor.ts')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'doctor.ts' })).toBeNull()
  })
})
