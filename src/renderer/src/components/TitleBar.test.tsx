import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TitleBar, type TitleBarMenuGroup } from './TitleBar'

afterEach(() => {
  cleanup()
})

function createMenus(overrides?: {
  onOpenFolder?: () => void
  onQuit?: () => void
  onToggleTheme?: () => void
  onShowVersion?: () => void
}): TitleBarMenuGroup[] {
  return [
    {
      id: 'file',
      label: 'File',
      items: [
        {
          kind: 'item',
          id: 'open-folder',
          label: '폴더 열기...',
          shortcut: 'Ctrl+O',
          onSelect: overrides?.onOpenFolder ?? vi.fn()
        },
        { kind: 'separator', id: 'file-sep' },
        {
          kind: 'item',
          id: 'quit',
          label: 'Quit',
          onSelect: overrides?.onQuit ?? vi.fn()
        }
      ]
    },
    {
      id: 'settings',
      label: 'Settings',
      items: [
        {
          kind: 'item',
          id: 'toggle-theme',
          label: '테마 전환',
          onSelect: overrides?.onToggleTheme ?? vi.fn()
        }
      ]
    },
    {
      id: 'help',
      label: 'Help',
      items: [
        {
          kind: 'item',
          id: 'version',
          label: 'Version',
          onSelect: overrides?.onShowVersion ?? vi.fn()
        }
      ]
    }
  ]
}

describe('TitleBar', () => {
  it('renders centered title without menubar when menus are omitted (auxiliary window)', () => {
    const { container } = render(<TitleBar title="notes.md - my-wiki - Wiki Editor v1.9.0" />)

    const titleText = screen.getByText('notes.md - my-wiki - Wiki Editor v1.9.0')
    expect(titleText).toBeInTheDocument()
    expect(titleText).toHaveClass('app-titlebar-title-text')
    expect(container.querySelector('.app-titlebar-title')).toContainElement(titleText)
    expect(screen.queryByRole('menubar')).not.toBeInTheDocument()
  })

  it('opens menu dropdown on click, invokes item callback, and closes dropdown', () => {
    const onOpenFolder = vi.fn()
    render(<TitleBar title="Wiki Editor v1.9.0" menus={createMenus({ onOpenFolder })} />)

    const fileTrigger = screen.getByRole('menuitem', { name: 'File' })
    expect(fileTrigger).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(fileTrigger)
    expect(fileTrigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+O')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: /폴더 열기/ }))
    expect(onOpenFolder).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(fileTrigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('switches open menu on hover only while a menu is already open', () => {
    render(<TitleBar title="Wiki Editor v1.9.0" menus={createMenus()} />)

    const fileTrigger = screen.getByRole('menuitem', { name: 'File' })
    const settingsTrigger = screen.getByRole('menuitem', { name: 'Settings' })

    // Hovering while closed should not open
    fireEvent.mouseEnter(settingsTrigger)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    // Open File, then hover Settings -> switches to Settings
    fireEvent.click(fileTrigger)
    expect(screen.getByRole('menuitem', { name: /폴더 열기/ })).toBeInTheDocument()

    fireEvent.mouseEnter(settingsTrigger)
    expect(screen.queryByRole('menuitem', { name: /폴더 열기/ })).not.toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '테마 전환' })).toBeInTheDocument()
  })

  it('supports keyboard navigation (ArrowDown, ArrowRight, Enter, Escape)', () => {
    const onToggleTheme = vi.fn()
    render(<TitleBar title="Wiki Editor v1.9.0" menus={createMenus({ onToggleTheme })} />)

    const fileTrigger = screen.getByRole('menuitem', { name: 'File' })
    fileTrigger.focus()
    fireEvent.click(fileTrigger)

    const menuBar = screen.getByRole('menubar')
    fireEvent.keyDown(menuBar, { key: 'ArrowRight' })
    expect(screen.getByRole('menuitem', { name: '테마 전환' })).toBeInTheDocument()

    fireEvent.keyDown(menuBar, { key: 'ArrowDown' })
    const themeItem = screen.getByRole('menuitem', { name: '테마 전환' })
    expect(document.activeElement).toBe(themeItem)

    fireEvent.keyDown(menuBar, { key: 'Enter' })
    expect(onToggleTheme).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    // Escape closes and restores focus to trigger
    const helpTrigger = screen.getByRole('menuitem', { name: 'Help' })
    fireEvent.click(helpTrigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(menuBar, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(helpTrigger)
  })

  it('closes open dropdown on outside pointerdown or window blur', () => {
    render(
      <div>
        <TitleBar title="Wiki Editor v1.9.0" menus={createMenus()} />
        <button type="button">outside</button>
      </div>
    )

    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent(window, new Event('blur'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('disables menu triggers and closes open dropdown when isMenuDisabled becomes true', () => {
    const { rerender } = render(
      <TitleBar title="Wiki Editor v1.9.0" menus={createMenus()} isMenuDisabled={false} />
    )

    const fileTrigger = screen.getByRole('menuitem', { name: 'File' })
    fireEvent.click(fileTrigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()

    rerender(<TitleBar title="Wiki Editor v1.9.0" menus={createMenus()} isMenuDisabled={true} />)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(fileTrigger).toBeDisabled()
  })

  it('renders title overlay before menubar in DOM order so no-drag menu triggers stay clickable', () => {
    const { container } = render(<TitleBar title="Wiki Editor v1.9.0" menus={createMenus()} />)

    const titleEl = container.querySelector('.app-titlebar-title')
    const menuBarEl = screen.getByRole('menubar')
    expect(titleEl).not.toBeNull()
    expect(
      Boolean(titleEl!.compareDocumentPosition(menuBarEl) & Node.DOCUMENT_POSITION_FOLLOWING)
    ).toBe(true)
  })

  it('applies is-macos class on .app-titlebar only when isMacOS is true', () => {
    const { container, rerender } = render(
      <TitleBar title="Wiki Editor v1.9.0" menus={createMenus()} isMacOS={true} />
    )
    expect(container.querySelector('.app-titlebar')).toHaveClass('is-macos')

    rerender(<TitleBar title="Wiki Editor v1.9.0" menus={createMenus()} isMacOS={false} />)
    expect(container.querySelector('.app-titlebar')).not.toHaveClass('is-macos')
  })
})
