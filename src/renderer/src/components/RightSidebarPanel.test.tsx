import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createDefaultFrontmatterSchema } from '@shared/frontmatter'
import {
  createDefaultRightSidebarSplitState,
  toggleRightSidebarOutlineCollapsed,
  toggleRightSidebarPropertiesCollapsed,
  updateRightSidebarOutlineRatio
} from '../utils/rightSidebarSplit'
import { RightSidebarPanel } from './RightSidebarPanel'

describe('RightSidebarPanel', () => {
  function renderStatefulPanel() {
    const onCollapseSidebar = vi.fn()
    const onToggleHeadingNumbers = vi.fn()
    const onChangeContent = vi.fn()

    function StatefulHarness() {
      const [splitState, setSplitState] = useState(createDefaultRightSidebarSplitState)
      return (
        <RightSidebarPanel
          splitState={splitState}
          onToggleOutlineCollapsed={() => setSplitState(toggleRightSidebarOutlineCollapsed)}
          onTogglePropertiesCollapsed={() => setSplitState(toggleRightSidebarPropertiesCollapsed)}
          onResizeOutlineRatio={(nextRatio) =>
            setSplitState((prev) => updateRightSidebarOutlineRatio(prev, nextRatio))
          }
          document={{
            documentName: 'guide.md',
            documentKey: 'c:/wiki/guide.md',
            content: '---\nstatus: todo\n---\n# Intro\n\n## Details',
            isMarkdownDocument: true
          }}
          outlineProps={{
            activeHeadingIndex: 0,
            showHeadingNumbers: true,
            onToggleHeadingNumbers,
            onSelectHeading: vi.fn(),
            onCollapse: onCollapseSidebar
          }}
          propertiesProps={{
            schemaResult: {
              exists: true,
              path: 'C:/wiki/.wiki-editor/frontmatter.json',
              schema: createDefaultFrontmatterSchema()
            },
            onChangeContent,
            onCreateDefaultSchema: vi.fn()
          }}
        />
      )
    }

    render(<StatefulHarness />)
    return { onCollapseSidebar, onToggleHeadingNumbers, onChangeContent }
  }

  it('renders 35%/65% default 2-tier accordion with horizontal resizer and handles collapse/expand & resizing', async () => {
    const user = userEvent.setup()
    const { onCollapseSidebar, onToggleHeadingNumbers } = renderStatefulPanel()

    const outlineSection = screen.getByRole('region', { name: '문서 목차 (Outline)' })
    const propertiesSection = screen.getByRole('region', { name: '문서 속성' })
    const resizer = screen.getByRole('separator', { name: '우측 사이드바 섹션 높이 조절' })

    expect(
      outlineSection.compareDocumentPosition(resizer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      resizer.compareDocumentPosition(propertiesSection) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    expect(outlineSection).toHaveStyle({ flex: '0.35 1 0%' })
    expect(propertiesSection).toHaveStyle({ flex: '0.65 1 0%' })
    expect(resizer).toHaveAttribute('aria-valuenow', '35')

    // Auxiliary header buttons on Outline do NOT toggle Outline accordion
    await user.click(within(outlineSection).getByRole('button', { name: '목차 번호 표시' }))
    expect(onToggleHeadingNumbers).toHaveBeenCalledTimes(1)
    expect(outlineSection).not.toHaveClass('is-collapsed')

    await user.click(within(outlineSection).getByRole('button', { name: '문서 목차 접기' }))
    expect(onCollapseSidebar).toHaveBeenCalledTimes(1)
    expect(outlineSection).not.toHaveClass('is-collapsed')

    // Resize via keyboard & double-click 50% restore
    fireEvent.keyDown(resizer, { key: 'ArrowDown' })
    expect(resizer).toHaveAttribute('aria-valuenow', '40')
    expect(outlineSection).toHaveStyle({ flex: '0.4 1 0%' })
    expect(propertiesSection).toHaveStyle({ flex: '0.6 1 0%' })

    fireEvent.doubleClick(resizer)
    expect(resizer).toHaveAttribute('aria-valuenow', '50')

    // Pointer drag updates ratio within [20, 80]
    const splitContainer = outlineSection.parentElement!
    vi.spyOn(splitContainer, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      right: 240,
      bottom: 400,
      width: 240,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
    fireEvent.pointerDown(resizer, { button: 0, clientY: 200 })
    fireEvent.pointerMove(window, { clientY: 280 }) // 0.7 -> 70%
    fireEvent.pointerUp(window)
    expect(resizer).toHaveAttribute('aria-valuenow', '70')

    // Collapse Properties -> resizer disappears, Outline fills 100%
    await user.click(within(propertiesSection).getByRole('button', { name: /문서 속성/ }))
    expect(
      screen.queryByRole('separator', { name: '우측 사이드바 섹션 높이 조절' })
    ).not.toBeInTheDocument()
    expect(outlineSection).toHaveStyle({ flex: '1 1 0%' })
    expect(propertiesSection).toHaveClass('is-collapsed')

    // Collapse Outline as well -> both collapsed at top, neither fills 100%
    await user.click(within(outlineSection).getByRole('button', { name: /Outline/ }))
    expect(outlineSection).toHaveClass('is-collapsed')
    expect(outlineSection.style.flex).toBe('')
    expect(propertiesSection.style.flex).toBe('')

    // Re-expand Properties only -> Properties fills 100%, resizer still hidden
    await user.click(within(propertiesSection).getByRole('button', { name: /문서 속성/ }))
    expect(propertiesSection).toHaveStyle({ flex: '1 1 0%' })
    expect(
      screen.queryByRole('separator', { name: '우측 사이드바 섹션 높이 조절' })
    ).not.toBeInTheDocument()

    // Re-expand Outline -> resizer returns with preserved 70% ratio
    await user.click(within(outlineSection).getByRole('button', { name: /Outline/ }))
    const restoredResizer = screen.getByRole('separator', {
      name: '우측 사이드바 섹션 높이 조절'
    })
    expect(restoredResizer).toHaveAttribute('aria-valuenow', '70')
    expect(outlineSection).toHaveStyle({ flex: '0.7 1 0%' })
    expect(propertiesSection).toHaveStyle({ flex: '0.3 1 0%' })
  })
})
