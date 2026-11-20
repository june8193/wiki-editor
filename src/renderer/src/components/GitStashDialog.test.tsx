import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createEmptyGitStatus, type GitStatus } from '@shared/git'
import { GitStashDialog } from './GitStashDialog'

function makeStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    ...createEmptyGitStatus(true, 'C:\\wiki'),
    branch: 'main',
    ...overrides
  }
}

describe('GitStashDialog', () => {
  it('submits empty or custom message, toggles includeUntracked and scope, and supports Enter/Esc', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const onClose = vi.fn()

    const { unmount } = render(
      <GitStashDialog
        status={makeStatus({
          staged: [{ path: 'staged.md', status: 'M' }],
          unstaged: [{ path: 'dirty.md', status: 'M' }],
          untracked: [{ path: 'draft.md', status: '?' }]
        })}
        initialScope="unstaged"
        onSubmit={onSubmit}
        onClose={onClose}
      />
    )

    const dialog = screen.getByRole('dialog', { name: 'Stash 생성' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')

    const messageInput = screen.getByLabelText('메시지 (선택)')
    const unstagedRadio = screen.getByRole('radio', { name: 'Changes만 보관 (Staged 유지)' })
    const allRadio = screen.getByRole('radio', { name: '전체 보관 (Staged 포함)' })
    const untrackedCheckbox = screen.getByRole('checkbox', { name: '미추적 파일(?) 포함' })

    expect(messageInput).toHaveFocus()
    expect(unstagedRadio).toBeChecked()
    expect(untrackedCheckbox).toBeChecked()

    // Enter with empty message submits default options immediately
    await user.keyboard('{Enter}')
    expect(onSubmit).toHaveBeenCalledWith({
      scope: 'unstaged',
      includeUntracked: true
    })

    // Typing custom message, switching to all, unchecking untracked, and clicking submit sends trimmed values
    await user.type(messageInput, '  release backup  ')
    await user.click(allRadio)
    await user.click(untrackedCheckbox)
    expect(allRadio).toBeChecked()
    expect(untrackedCheckbox).not.toBeChecked()

    await user.click(screen.getByRole('button', { name: 'Stash 생성' }))
    expect(onSubmit).toHaveBeenLastCalledWith({
      scope: 'all',
      message: 'release backup',
      includeUntracked: false
    })

    // Esc closes the dialog
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)

    // Backdrop click also closes the dialog
    const backdrop = dialog.parentElement as HTMLElement
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(2)
    unmount()
  })

  it('defaults to all when only staged changes exist and disables empty scopes dynamically', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const onClose = vi.fn()

    // 1. Staged-only repo opened from '+' ('unstaged') defaults to enabled 'all' and disables 'unstaged'
    const { rerender } = render(
      <GitStashDialog
        status={makeStatus({
          staged: [{ path: 'staged.md', status: 'A' }],
          unstaged: [],
          untracked: []
        })}
        initialScope="unstaged"
        onSubmit={onSubmit}
        onClose={onClose}
      />
    )

    const unstagedRadio = screen.getByRole('radio', { name: 'Changes만 보관 (Staged 유지)' })
    const allRadio = screen.getByRole('radio', { name: '전체 보관 (Staged 포함)' })
    expect(unstagedRadio).toBeDisabled()
    expect(allRadio).toBeEnabled()
    expect(allRadio).toBeChecked()

    // 2. Untracked-only repo becomes non-submittable with hint when 미추적 파일(?) 포함 is unchecked
    rerender(
      <GitStashDialog
        status={makeStatus({
          staged: [],
          unstaged: [],
          untracked: [{ path: 'draft.md', status: '?' }]
        })}
        initialScope="unstaged"
        onSubmit={onSubmit}
        onClose={onClose}
      />
    )

    const untrackedCheckbox = screen.getByRole('checkbox', { name: '미추적 파일(?) 포함' })
    const submitBtn = screen.getByRole('button', { name: 'Stash 생성' })
    expect(submitBtn).toBeEnabled()

    await user.click(untrackedCheckbox)
    expect(screen.getByRole('radio', { name: 'Changes만 보관 (Staged 유지)' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: '전체 보관 (Staged 포함)' })).toBeDisabled()
    expect(submitBtn).toBeDisabled()
    expect(screen.getByText('선택한 범위에 Stash할 변경 사항이 없습니다.')).toBeInTheDocument()

    // Pressing Enter while disabled does not submit
    await user.type(screen.getByLabelText('메시지 (선택)'), 'ignored{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
