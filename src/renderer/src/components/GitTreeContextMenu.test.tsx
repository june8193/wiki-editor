// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitTreeContextMenu, type GitTreeContextMenuTarget } from './GitTreeContextMenu'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('GitTreeContextMenu', () => {
  it('renders file menu items, triggers pinned diff open and path copy callbacks, and closes', async () => {
    const user = userEvent.setup()
    const onOpenPinnedDiff = vi.fn()
    const onCopyPath = vi.fn()
    const onClose = vi.fn()
    const target: GitTreeContextMenuTarget = {
      kind: 'file',
      repoRelativePath: 'docs/guide.md',
      x: 40,
      y: 60,
      onOpenPinnedDiff
    }

    render(
      <GitTreeContextMenu
        target={target}
        onClose={onClose}
        onCopyPath={onCopyPath}
        onClampPosition={vi.fn()}
      />
    )

    const menu = screen.getByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      '새 탭에서 Diff 열기',
      '상대 경로 복사',
      '절대 경로 복사'
    ])
    expect(within(menu).getByRole('separator')).toBeInTheDocument()

    await user.click(within(menu).getByRole('menuitem', { name: '새 탭에서 Diff 열기' }))
    expect(onOpenPinnedDiff).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)

    await user.click(within(menu).getByRole('menuitem', { name: '상대 경로 복사' }))
    expect(onCopyPath).toHaveBeenCalledWith('docs/guide.md', 'relative')

    await user.click(within(menu).getByRole('menuitem', { name: '절대 경로 복사' }))
    expect(onCopyPath).toHaveBeenCalledWith('docs/guide.md', 'absolute')
  })

  it('renders only path copy items for directory targets (including compressed a/b/c paths)', () => {
    const target: GitTreeContextMenuTarget = {
      kind: 'dir',
      repoRelativePath: 'a/b/c',
      x: 30,
      y: 50
    }

    render(
      <GitTreeContextMenu
        target={target}
        onClose={vi.fn()}
        onCopyPath={vi.fn()}
        onClampPosition={vi.fn()}
      />
    )

    const menu = screen.getByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      '상대 경로 복사',
      '절대 경로 복사'
    ])
    expect(within(menu).queryByRole('separator')).not.toBeInTheDocument()
  })

  it('closes on Escape key and outside pointerdown', () => {
    const onClose = vi.fn()
    render(
      <div>
        <div data-testid="outside">outside</div>
        <GitTreeContextMenu
          target={{ kind: 'dir', repoRelativePath: 'docs', x: 20, y: 20 }}
          onClose={onClose}
          onCopyPath={vi.fn()}
          onClampPosition={vi.fn()}
        />
      </div>
    )

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('clamps menu coordinates within the viewport bounds with 8px margin', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 300 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 200 })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 160,
      height: 100,
      top: 0,
      left: 0,
      right: 160,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })

    const onClampPosition = vi.fn()
    render(
      <GitTreeContextMenu
        target={{ kind: 'dir', repoRelativePath: 'docs', x: 280, y: 180 }}
        onClose={vi.fn()}
        onCopyPath={vi.fn()}
        onClampPosition={onClampPosition}
      />
    )

    expect(onClampPosition).toHaveBeenCalledWith(132, 92)
  })
})
