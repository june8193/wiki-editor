import { useRef, useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DocumentOutlinePanel } from './DocumentOutlinePanel'
import { HorizontalSectionResizer } from './HorizontalSectionResizer'
import { SidebarAccordionSection } from './SidebarAccordionSection'

describe('SidebarAccordionSection & HorizontalSectionResizer', () => {
  it('renders toggle and headerActions independently so auxiliary header buttons never toggle the accordion', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    const onAuxClick = vi.fn()

    const { rerender } = render(
      <SidebarAccordionSection
        title="문서 속성"
        ariaLabel="문서 속성"
        badge={<span>2/5</span>}
        headerActions={
          <button type="button" onClick={onAuxClick}>
            보조 액션
          </button>
        }
        isExpanded
        flexRatio={0.65}
        onToggle={onToggle}
      >
        <div>속성 본문</div>
      </SidebarAccordionSection>
    )

    const section = screen.getByRole('region', { name: '문서 속성' })
    expect(section).toHaveStyle({ flex: '0.65 1 0%' })
    expect(section).not.toHaveClass('is-collapsed')
    expect(screen.getByText('속성 본문')).toBeInTheDocument()

    const toggleBtn = screen.getByRole('button', { name: /문서 속성/ })
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'true')
    expect(toggleBtn).toHaveTextContent('2/5')

    await user.click(screen.getByRole('button', { name: '보조 액션' }))
    expect(onAuxClick).toHaveBeenCalledTimes(1)
    expect(onToggle).not.toHaveBeenCalled()

    await user.click(toggleBtn)
    expect(onToggle).toHaveBeenCalledTimes(1)

    rerender(
      <SidebarAccordionSection
        title="문서 속성"
        ariaLabel="문서 속성"
        isExpanded={false}
        flexRatio={null}
        onToggle={onToggle}
      >
        <div>속성 본문</div>
      </SidebarAccordionSection>
    )

    expect(section).toHaveClass('is-collapsed')
    expect(section.style.flex).toBe('')
    expect(screen.queryByText('속성 본문')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /문서 속성/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })

  it('supports pointer drag, mouse fallback, keyboard ArrowUp/ArrowDown, and double-click 50% restore on HorizontalSectionResizer', () => {
    function Harness() {
      const containerRef = useRef<HTMLDivElement | null>(null)
      const [ratio, setRatio] = useState(0.35)
      return (
        <div ref={containerRef} data-testid="split-container">
          <HorizontalSectionResizer
            ratio={ratio}
            fallbackRatio={0.35}
            resetRatio={0.5}
            containerRef={containerRef}
            ariaLabel="우측 사이드바 섹션 높이 조절"
            bodyClassName="is-resizing-right-sections"
            onResizeRatio={setRatio}
          />
        </div>
      )
    }

    render(<Harness />)
    const container = screen.getByTestId('split-container')
    const resizer = screen.getByRole('separator', { name: '우측 사이드바 섹션 높이 조절' })

    expect(resizer).toHaveAttribute('aria-orientation', 'horizontal')
    expect(resizer).toHaveAttribute('aria-valuemin', '20')
    expect(resizer).toHaveAttribute('aria-valuemax', '80')
    expect(resizer).toHaveAttribute('aria-valuenow', '35')
    expect(resizer).toHaveAttribute('tabindex', '0')

    fireEvent.keyDown(resizer, { key: 'ArrowDown' })
    expect(resizer).toHaveAttribute('aria-valuenow', '40')

    fireEvent.keyDown(resizer, { key: 'ArrowUp' })
    expect(resizer).toHaveAttribute('aria-valuenow', '35')

    for (let i = 0; i < 10; i += 1) {
      fireEvent.keyDown(resizer, { key: 'ArrowUp' })
    }
    expect(resizer).toHaveAttribute('aria-valuenow', '20')

    for (let i = 0; i < 15; i += 1) {
      fireEvent.keyDown(resizer, { key: 'ArrowDown' })
    }
    expect(resizer).toHaveAttribute('aria-valuenow', '80')

    // Double-click restores 50%
    fireEvent.doubleClick(resizer)
    expect(resizer).toHaveAttribute('aria-valuenow', '50')

    // Pointer drag (20%~80%)
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      left: 0,
      right: 240,
      bottom: 600,
      width: 240,
      height: 500,
      x: 0,
      y: 100,
      toJSON: () => ({})
    })

    fireEvent.pointerDown(resizer, { button: 0, clientY: 350 })
    expect(document.body).toHaveClass('is-resizing-right-sections')
    expect(document.body.style.cursor).toBe('row-resize')

    fireEvent.pointerMove(window, { clientY: 225 }) // (225 - 100) / 500 = 0.25 -> 25%
    expect(resizer).toHaveAttribute('aria-valuenow', '25')

    fireEvent.pointerMove(window, { clientY: 50 }) // clamped to 20%
    expect(resizer).toHaveAttribute('aria-valuenow', '20')

    fireEvent.pointerUp(window)
    expect(document.body).not.toHaveClass('is-resizing-right-sections')
    expect(document.body.style.cursor).toBe('')

    // Mouse drag fallback
    fireEvent.mouseDown(resizer, { button: 0, clientY: 200 })
    fireEvent.mouseMove(window, { clientY: 475 }) // (475 - 100) / 500 = 0.75 -> 75%
    expect(resizer).toHaveAttribute('aria-valuenow', '75')
    fireEvent.mouseUp(window)
  })

  it('supports collapsible accordion mode in DocumentOutlinePanel without triggering toggle from header buttons', async () => {
    const user = userEvent.setup()
    const onToggleExpanded = vi.fn()
    const onToggleHeadingNumbers = vi.fn()
    const onCollapse = vi.fn()

    const { rerender } = render(
      <DocumentOutlinePanel
        documentName="note.md"
        content={'# Title'}
        isMarkdownDocument
        showHeadingNumbers
        isExpanded
        flexRatio={0.35}
        onToggleExpanded={onToggleExpanded}
        onToggleHeadingNumbers={onToggleHeadingNumbers}
        onSelectHeading={vi.fn()}
        onCollapse={onCollapse}
      />
    )

    const outline = screen.getByRole('region', { name: '문서 목차 (Outline)' })
    expect(outline).toHaveStyle({ flex: '0.35 1 0%' })

    await user.click(screen.getByRole('button', { name: '목차 번호 표시' }))
    await user.click(screen.getByRole('button', { name: '문서 목차 접기' }))
    expect(onToggleHeadingNumbers).toHaveBeenCalledTimes(1)
    expect(onCollapse).toHaveBeenCalledTimes(1)
    expect(onToggleExpanded).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /Outline/ }))
    expect(onToggleExpanded).toHaveBeenCalledTimes(1)

    rerender(
      <DocumentOutlinePanel
        documentName="note.md"
        content={'# Title'}
        isMarkdownDocument
        showHeadingNumbers
        isExpanded={false}
        flexRatio={null}
        onToggleExpanded={onToggleExpanded}
        onToggleHeadingNumbers={onToggleHeadingNumbers}
        onSelectHeading={vi.fn()}
        onCollapse={onCollapse}
      />
    )
    expect(outline).toHaveClass('is-collapsed')
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })
})
