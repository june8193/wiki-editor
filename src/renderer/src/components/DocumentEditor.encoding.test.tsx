import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DocumentBuffer } from '@shared/documentBuffer'
import type { DocumentTabItem } from '../stores/PaneTabStore'
import { DocumentEditor } from './DocumentEditor'

function createDoc(overrides: Partial<DocumentBuffer> = {}): DocumentBuffer {
  return {
    key: 'c:/wiki/note.md',
    kind: 'workspace',
    contentKind: 'text',
    path: 'C:/wiki/note.md',
    name: 'note.md',
    content: '# 안녕하세요',
    savedContent: '# 안녕하세요',
    encoding: 'utf-8',
    savedEncoding: 'utf-8',
    isDirty: false,
    version: 1,
    isSaving: false,
    ...overrides
  }
}

function createTab(id = 'tab-1'): DocumentTabItem {
  return {
    kind: 'document',
    id,
    bufferKey: 'c:/wiki/note.md',
    mode: 'raw',
    scrollTop: 0,
    cursor: { selectionStart: 0, selectionEnd: 0 },
    splitPreviewRatio: 0.5
  }
}

describe('DocumentEditor header encoding button & menu', () => {
  it('shows current encoding (UTF-8 / EUC-KR) button, hides it on image tabs, and locks config.json & frontmatter.json to UTF-8', () => {
    const { rerender } = render(
      <DocumentEditor
        document={createDoc({ encoding: 'euc-kr', savedEncoding: 'euc-kr' })}
        tab={createTab()}
        theme="light"
        autoSave={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )

    const encodingBtn = screen.getByRole('button', { name: /문서 인코딩/ })
    expect(encodingBtn).toHaveTextContent('EUC-KR')
    expect(encodingBtn).toBeEnabled()

    // Image tab hides encoding button
    rerender(
      <DocumentEditor
        document={createDoc({
          key: 'c:/wiki/pic.png',
          path: 'C:/wiki/pic.png',
          name: 'pic.png',
          contentKind: 'image',
          encoding: 'utf-8',
          savedEncoding: 'utf-8'
        })}
        tab={createTab()}
        theme="light"
        autoSave={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: /문서 인코딩/ })).toBeNull()

    // config.json locks encoding button to UTF-8 (disabled)
    rerender(
      <DocumentEditor
        document={createDoc({
          key: '__config__',
          kind: 'config',
          path: 'C:/Users/test/config.json',
          name: 'config.json',
          encoding: 'utf-8',
          savedEncoding: 'utf-8'
        })}
        tab={createTab()}
        theme="light"
        autoSave={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )
    const configBtn = screen.getByRole('button', { name: /문서 인코딩/ })
    expect(configBtn).toHaveTextContent('UTF-8')
    expect(configBtn).toBeDisabled()

    // .wiki-editor/frontmatter.json locks encoding button to UTF-8 (disabled)
    rerender(
      <DocumentEditor
        document={createDoc({
          key: 'c:/wiki/.wiki-editor/frontmatter.json',
          kind: 'workspace',
          path: 'C:/wiki/.wiki-editor/frontmatter.json',
          name: 'frontmatter.json',
          encoding: 'utf-8',
          savedEncoding: 'utf-8'
        })}
        tab={createTab()}
        theme="light"
        autoSave={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )
    const schemaBtn = screen.getByRole('button', { name: /문서 인코딩/ })
    expect(schemaBtn).toHaveTextContent('UTF-8')
    expect(schemaBtn).toBeDisabled()
  })

  it('opens menu with distinct Reopen and Convert groups, triggers callbacks, and dismisses on Escape or outside click', async () => {
    const user = userEvent.setup()
    const onChangeEncoding = vi.fn()
    const onReopenWithEncoding = vi.fn()

    render(
      <div>
        <div data-testid="outside-area">outside</div>
        <DocumentEditor
          document={createDoc({ encoding: 'utf-8', savedEncoding: 'utf-8' })}
          tab={createTab()}
          theme="light"
          autoSave={false}
          onChangeContent={vi.fn()}
          onSave={vi.fn()}
          onUpdateViewState={vi.fn()}
          onChangeEncoding={onChangeEncoding}
          onReopenWithEncoding={onReopenWithEncoding}
        />
      </div>
    )

    const encodingBtn = screen.getByRole('button', { name: /문서 인코딩/ })
    expect(encodingBtn).toHaveTextContent('UTF-8')

    // Open menu
    await user.click(encodingBtn)
    const menu = screen.getByRole('menu', { name: '인코딩 메뉴' })

    const reopenGroup = within(menu).getByRole('group', { name: '인코딩으로 다시 열기' })
    const convertGroup = within(menu).getByRole('group', { name: '인코딩 변경' })

    expect(within(reopenGroup).getByRole('menuitem', { name: /UTF-8/ })).toBeEnabled()
    expect(within(reopenGroup).getByRole('menuitem', { name: /EUC-KR/ })).toBeEnabled()
    expect(within(convertGroup).getByRole('menuitem', { name: /UTF-8/ })).toBeDisabled()
    expect(within(convertGroup).getByRole('menuitem', { name: /EUC-KR/ })).toBeEnabled()

    // Select Reopen with EUC-KR
    await user.click(within(reopenGroup).getByRole('menuitem', { name: /EUC-KR/ }))
    expect(onReopenWithEncoding).toHaveBeenCalledWith('euc-kr')
    expect(screen.queryByRole('menu', { name: '인코딩 메뉴' })).toBeNull()

    // Reopen menu and select Convert to EUC-KR
    await user.click(encodingBtn)
    const convertGroup2 = within(screen.getByRole('menu', { name: '인코딩 메뉴' })).getByRole('group', {
      name: '인코딩 변경'
    })
    await user.click(within(convertGroup2).getByRole('menuitem', { name: /EUC-KR/ }))
    expect(onChangeEncoding).toHaveBeenCalledWith('euc-kr')
    expect(screen.queryByRole('menu', { name: '인코딩 메뉴' })).toBeNull()

    // Dismiss on Escape
    await user.click(encodingBtn)
    expect(screen.getByRole('menu', { name: '인코딩 메뉴' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu', { name: '인코딩 메뉴' })).toBeNull()

    // Dismiss on outside click
    await user.click(encodingBtn)
    expect(screen.getByRole('menu', { name: '인코딩 메뉴' })).toBeInTheDocument()
    await user.click(screen.getByTestId('outside-area'))
    expect(screen.queryByRole('menu', { name: '인코딩 메뉴' })).toBeNull()
  })
})
