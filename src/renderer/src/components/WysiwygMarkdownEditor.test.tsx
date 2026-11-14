import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { WysiwygMarkdownEditor } from './WysiwygMarkdownEditor'

describe('WysiwygMarkdownEditor', () => {
  it('mounts without firing onChangeContent on unchanged markdown and syncs external updates cleanly', () => {
    const onChangeContent = vi.fn()
    const initial = '# Keep Exact\n\n*   preserved spacing'

    const { rerender } = render(
      <WysiwygMarkdownEditor
        content={initial}
        scrollTop={0}
        onChangeContent={onChangeContent}
      />
    )

    expect(screen.getByTestId('document-editor')).toBeInTheDocument()
    expect(onChangeContent).not.toHaveBeenCalled()

    // External update from another Split View pane updates view without echoing onChangeContent
    rerender(
      <WysiwygMarkdownEditor
        content={'# Updated From Raw'}
        scrollTop={0}
        onChangeContent={onChangeContent}
      />
    )

    expect(screen.getByTestId('document-editor')).toHaveTextContent('Updated From Raw')
    expect(onChangeContent).not.toHaveBeenCalled()
  })

  it('provides formatting toolbar actions and contextual table toolbar for row/column operations', async () => {
    const user = userEvent.setup()
    const onChangeContent = vi.fn()

    render(
      <WysiwygMarkdownEditor
        content={'# Heading\n\nParagraph text'}
        scrollTop={0}
        onChangeContent={onChangeContent}
      />
    )

    // Contextual table toolbar is hidden when cursor is outside a table
    expect(screen.queryByRole('toolbar', { name: '표 편집 툴바' })).not.toBeInTheDocument()

    // Main formatting toolbar actions exist
    const mainToolbar = screen.getByRole('toolbar', { name: '위지윅 서식 툴바' })
    expect(within(mainToolbar).getByRole('button', { name: 'H1' })).toBeInTheDocument()
    expect(within(mainToolbar).getByRole('button', { name: 'H2' })).toBeInTheDocument()
    expect(within(mainToolbar).getByRole('button', { name: 'H3' })).toBeInTheDocument()
    expect(within(mainToolbar).getByRole('button', { name: '굵게' })).toBeInTheDocument()
    expect(within(mainToolbar).getByRole('button', { name: '기울임' })).toBeInTheDocument()
    expect(within(mainToolbar).getByRole('button', { name: '인라인 코드' })).toBeInTheDocument()
    expect(within(mainToolbar).getByRole('button', { name: '코드 블록' })).toBeInTheDocument()
    expect(within(mainToolbar).getByRole('button', { name: '글머리 목록' })).toBeInTheDocument()
    expect(within(mainToolbar).getByRole('button', { name: '번호 목록' })).toBeInTheDocument()
    expect(within(mainToolbar).getByRole('button', { name: '체크리스트' })).toBeInTheDocument()
    expect(within(mainToolbar).getByRole('button', { name: '인용' })).toBeInTheDocument()

    // Insert a table -> emits markdown table and reveals contextual table toolbar
    await user.click(within(mainToolbar).getByRole('button', { name: '표 삽입' }))
    expect(onChangeContent).toHaveBeenCalled()
    const afterInsert = onChangeContent.mock.calls[onChangeContent.mock.calls.length - 1][0] as string
    expect(afterInsert).toContain('|')
    expect(afterInsert).toContain('---')

    const tableToolbar = await screen.findByRole('toolbar', { name: '표 편집 툴바' })
    const rowCountBefore = screen.getByTestId('document-editor').querySelectorAll('tr').length
    const colCountBefore = screen
      .getByTestId('document-editor')
      .querySelectorAll('tr')[0]
      .querySelectorAll('th, td').length

    // Add row below and column right
    await user.click(within(tableToolbar).getByRole('button', { name: '행 아래 추가' }))
    await user.click(within(tableToolbar).getByRole('button', { name: '열 우 추가' }))

    expect(screen.getByTestId('document-editor').querySelectorAll('tr').length).toBe(
      rowCountBefore + 1
    )
    expect(
      screen
        .getByTestId('document-editor')
        .querySelectorAll('tr')[0]
        .querySelectorAll('th, td').length
    ).toBe(colCountBefore + 1)

    // Also verify 행 위 추가, 열 좌 추가, 현재 행 삭제, 현재 열 삭제, 표 삭제 buttons exist and work
    await user.click(within(tableToolbar).getByRole('button', { name: '행 위 추가' }))
    expect(screen.getByTestId('document-editor').querySelectorAll('tr').length).toBe(
      rowCountBefore + 2
    )

    await user.click(within(tableToolbar).getByRole('button', { name: '현재 행 삭제' }))
    expect(screen.getByTestId('document-editor').querySelectorAll('tr').length).toBe(
      rowCountBefore + 1
    )

    await user.click(within(tableToolbar).getByRole('button', { name: '열 좌 추가' }))
    await user.click(within(tableToolbar).getByRole('button', { name: '현재 열 삭제' }))
    expect(
      screen
        .getByTestId('document-editor')
        .querySelectorAll('tr')[0]
        .querySelectorAll('th, td').length
    ).toBe(colCountBefore + 1)

    await user.click(within(tableToolbar).getByRole('button', { name: '표 삭제' }))
    expect(screen.getByTestId('document-editor').querySelector('table')).toBeNull()
    expect(screen.queryByRole('toolbar', { name: '표 편집 툴바' })).not.toBeInTheDocument()
  })

  it('prevents Electron window navigation when clicking links inside WYSIWYG content', () => {
    render(
      <WysiwygMarkdownEditor
        content={'[Click me](https://example.com)'}
        scrollTop={0}
        onChangeContent={vi.fn()}
      />
    )
    const link = screen.getByTestId('document-editor').querySelector('a')
    expect(link).not.toBeNull()
    const notPrevented = fireEvent.click(link!)
    expect(notPrevented).toBe(false)
  })

  it('sanitizes XSS payloads via rehype-sanitize, supports cell context menu, and emits once on header row delete', async () => {
    const user = userEvent.setup()
    const onChangeContent = vi.fn()

    render(
      <WysiwygMarkdownEditor
        content={[
          '# Safe',
          '',
          '<script>alert(1)</script>',
          '',
          '<img src="x" onerror="alert(2)" />',
          '',
          '[Bad](javascript:alert(3))',
          '',
          '| H1 | H2 |',
          '| --- | --- |',
          '| R1 | R2 |',
          '| R3 | R4 |'
        ].join('\n')}
        scrollTop={0}
        onChangeContent={onChangeContent}
      />
    )

    const editorEl = screen.getByTestId('document-editor')
    expect(editorEl.querySelector('script')).toBeNull()
    expect(editorEl.innerHTML).not.toContain('onerror')
    expect(editorEl.innerHTML).not.toContain('javascript:')
    expect(onChangeContent).not.toHaveBeenCalled()

    // Right-click inside header cell opens contextual table menu and deletes header row in a single emit
    const headerCell = editorEl.querySelector('th')!
    fireEvent.contextMenu(headerCell, { clientX: 40, clientY: 60 })
    const cellMenu = await screen.findByRole('menu', { name: '표 셀 작업 메뉴' })
    await user.click(within(cellMenu).getByRole('menuitem', { name: '현재 행 삭제' }))

    expect(onChangeContent).toHaveBeenCalledTimes(1)
    const updatedMd = onChangeContent.mock.calls[0][0] as string
    expect(updatedMd).toMatch(/\|\s*R1\s*\|\s*R2\s*\|/)
    expect(updatedMd).toMatch(/\|\s*-+\s*\|\s*-+\s*\|/)
    expect(updatedMd).not.toContain('H1')
  })
})
