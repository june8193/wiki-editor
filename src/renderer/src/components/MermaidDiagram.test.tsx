import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WikiApi } from '@shared/ipc'
import type { RendererLogPayload } from '@shared/logging'
import type { DiagramPngRasterAdapter, DiagramSvgRasterRequest } from '../editor/mermaidExport'
import { createMermaidRenderer, type MermaidDriver } from '../editor/mermaidRenderer'
import themeCss from '../styles/theme.css?raw'
import { MermaidDiagram } from './MermaidDiagram'

describe('MermaidDiagram', () => {
  const originalWikiApi = (window as { wikiApi?: WikiApi }).wikiApi

  afterEach(() => {
    vi.useRealTimers()
    if (originalWikiApi === undefined) {
      delete (window as { wikiApi?: WikiApi }).wikiApi
    } else {
      window.wikiApi = originalWikiApi
    }
  })

  it('renders diagram immediately on mount and uses cache without re-rendering when unchanged or restored', async () => {
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => ({
        svg: `<svg data-theme-text="${text}"><rect width="20" height="20"/></svg>`
      }))
    }
    const renderer = createMermaidRenderer(driver)

    const { rerender } = render(
      <MermaidDiagram code={'graph TD\n  A-->B'} theme="light" renderer={renderer} debounceMs={200} />
    )

    expect(await screen.findByTestId('mermaid-svg')).toBeInTheDocument()
    expect(driver.render).toHaveBeenCalledTimes(1)

    // Rerendering with identical code & theme hits cache without calling driver.render
    rerender(
      <MermaidDiagram code={'graph TD\n  A-->B'} theme="light" renderer={renderer} debounceMs={200} />
    )
    expect(driver.render).toHaveBeenCalledTimes(1)

    // Switching theme immediately renders dark theme, then switching back to light hits cache
    rerender(
      <MermaidDiagram code={'graph TD\n  A-->B'} theme="dark" renderer={renderer} debounceMs={200} />
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId('mermaid-diagram')).toHaveAttribute('data-mermaid-theme', 'dark')
    expect(driver.render).toHaveBeenCalledTimes(2)

    rerender(
      <MermaidDiagram code={'graph TD\n  A-->B'} theme="light" renderer={renderer} debounceMs={200} />
    )
    expect(screen.getByTestId('mermaid-diagram')).toHaveAttribute('data-mermaid-theme', 'default')
    expect(driver.render).toHaveBeenCalledTimes(2)
  })

  it('debounces rapid source edits so intermediate states do not trigger Mermaid renders', async () => {
    vi.useFakeTimers()
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => ({
        svg: `<svg><text>${text}</text></svg>`
      }))
    }
    const renderer = createMermaidRenderer(driver)

    const { rerender } = render(
      <MermaidDiagram code={'graph TD\n  A-->B'} theme="light" renderer={renderer} debounceMs={250} />
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(driver.render).toHaveBeenCalledTimes(1)

    // Rapid edits within debounce window
    rerender(
      <MermaidDiagram code={'graph TD\n  A-->B\n  B-->'} theme="light" renderer={renderer} debounceMs={250} />
    )
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(driver.render).toHaveBeenCalledTimes(1)

    rerender(
      <MermaidDiagram code={'graph TD\n  A-->B\n  B-->C'} theme="light" renderer={renderer} debounceMs={250} />
    )
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(driver.render).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(100)
      await Promise.resolve()
    })
    expect(driver.render).toHaveBeenCalledTimes(2)
    expect(driver.render).toHaveBeenLastCalledWith(expect.any(String), 'graph TD\n  A-->B\n  B-->C')
    expect(screen.getByTestId('mermaid-svg')).toHaveTextContent('B-->C')
  })

  it('displays an isolated error banner and raw Mermaid source on syntax failure and recovers on valid edit', async () => {
    vi.useFakeTimers()
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => {
        if (text.includes('invalid')) {
          throw new Error('Parse error on line 2')
        }
        return { svg: '<svg><g><text>Recovered</text></g></svg>' }
      })
    }
    const renderer = createMermaidRenderer(driver)

    const { rerender } = render(
      <MermaidDiagram code={'graph TD\n  invalid syntax'} theme="light" renderer={renderer} debounceMs={200} />
    )

    await act(async () => {
      await Promise.resolve()
    })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Mermaid 다이어그램 문법 오류')
    expect(alert).toHaveTextContent('Parse error on line 2')
    expect(alert).toHaveTextContent('invalid syntax')
    expect(screen.queryByTestId('mermaid-svg')).not.toBeInTheDocument()

    // Fix syntax -> recovers cleanly after debounce
    rerender(
      <MermaidDiagram code={'graph TD\n  A-->B'} theme="light" renderer={renderer} debounceMs={200} />
    )
    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('mermaid-svg')).toHaveTextContent('Recovered')
  })

  it('logs a warn entry with metadata when Mermaid diagram rendering fails without leaking diagram source', async () => {
    const entries: RendererLogPayload[] = []
    window.wikiApi = {
      log: {
        write: vi.fn(async (payload: RendererLogPayload) => {
          entries.push(payload)
        })
      }
    } as unknown as WikiApi

    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async () => {
        throw new Error('Parse error on line 2')
      })
    }
    const renderer = createMermaidRenderer(driver)
    const secretSource = 'graph TD\n  SECRET_DIAGRAM_NODE --> invalid'

    render(<MermaidDiagram code={secretSource} theme="dark" renderer={renderer} debounceMs={0} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Parse error on line 2')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      level: 'warn',
      category: 'ui',
      message: 'Mermaid diagram rendering failed',
      data: {
        theme: 'dark',
        codeLength: secretSource.length,
        errorMessage: 'Parse error on line 2'
      },
      error: {
        name: 'MermaidRenderError',
        message: 'Parse error on line 2'
      }
    })
    expect(JSON.stringify(entries)).not.toContain('SECRET_DIAGRAM_NODE')
  })

  it('retains the last valid SVG without unmounting and shows a compact inline error banner without <pre> on syntax error, then recovers on valid edit', async () => {
    vi.useFakeTimers()
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => {
        if (text.includes('invalid')) {
          throw new Error('Parse error on line 2')
        }
        return { svg: `<svg><g><text>${text.trim()}</text></g></svg>` }
      })
    }
    const renderer = createMermaidRenderer(driver)

    const { rerender } = render(
      <MermaidDiagram code={'graph TD\n  A-->B'} theme="light" renderer={renderer} debounceMs={200} />
    )

    await act(async () => {
      await Promise.resolve()
    })

    const initialSvgContainer = screen.getByTestId('mermaid-svg')
    expect(initialSvgContainer).toHaveTextContent('A-->B')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // Subsequent edit introduces a syntax error -> retain last valid SVG and show inline banner without <pre>
    rerender(
      <MermaidDiagram
        code={'graph TD\n  invalid syntax'}
        theme="light"
        renderer={renderer}
        debounceMs={200}
      />
    )

    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })

    const retainedSvgContainer = screen.getByTestId('mermaid-svg')
    expect(retainedSvgContainer).toBe(initialSvgContainer)
    expect(retainedSvgContainer).toHaveTextContent('A-->B')

    const inlineAlert = screen.getByRole('alert')
    expect(inlineAlert).toHaveTextContent('Parse error on line 2')
    expect(screen.getByTestId('mermaid-diagram').querySelector('pre')).toBeNull()

    // Fix syntax -> replaces SVG and removes inline error banner after debounce
    rerender(
      <MermaidDiagram code={'graph TD\n  A-->C'} theme="light" renderer={renderer} debounceMs={200} />
    )

    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('mermaid-svg')).toHaveTextContent('A-->C')
  })

  it('retains a cache-hit mount SVG across subsequent syntax errors, avoids banner flicker between broken edits, and clears error immediately on cached recovery', async () => {
    vi.useFakeTimers()
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => {
        if (text.includes('broken_1')) {
          throw new Error('Syntax error one')
        }
        if (text.includes('broken_2')) {
          throw new Error('Syntax error two')
        }
        return { svg: `<svg><text>${text.trim()}</text></svg>` }
      })
    }
    const renderer = createMermaidRenderer(driver)
    const validCode = 'graph TD\n  Cached-->Node'
    // Pre-populate renderer LRU cache before component mounts
    await renderer.render(validCode, 'light')
    expect(driver.render).toHaveBeenCalledTimes(1)

    const { rerender } = render(
      <MermaidDiagram code={validCode} theme="light" renderer={renderer} debounceMs={200} />
    )
    expect(screen.getByTestId('mermaid-svg')).toHaveTextContent('Cached-->Node')
    expect(driver.render).toHaveBeenCalledTimes(1)

    // Edit to broken syntax -> must retain the cache-hit SVG and show inline error banner
    rerender(
      <MermaidDiagram
        code={'graph TD\n  broken_1'}
        theme="light"
        renderer={renderer}
        debounceMs={200}
      />
    )
    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })
    expect(screen.getByTestId('mermaid-svg')).toHaveTextContent('Cached-->Node')
    expect(screen.getByRole('alert')).toHaveTextContent('Syntax error one')

    // Edit to another broken syntax -> during debounce, both SVG and alert stay steady without flashing
    rerender(
      <MermaidDiagram
        code={'graph TD\n  broken_2'}
        theme="light"
        renderer={renderer}
        debounceMs={200}
      />
    )
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(screen.getByTestId('mermaid-svg')).toHaveTextContent('Cached-->Node')
    expect(screen.getByRole('alert')).toHaveTextContent('Syntax error one')

    await act(async () => {
      vi.advanceTimersByTime(100)
      await Promise.resolve()
    })
    expect(screen.getByTestId('mermaid-svg')).toHaveTextContent('Cached-->Node')
    expect(screen.getByRole('alert')).toHaveTextContent('Syntax error two')

    // Revert back to cached valid code -> immediately clears error banner without re-invoking driver.render
    const renderCallsBeforeRevert = (driver.render as ReturnType<typeof vi.fn>).mock.calls.length
    rerender(
      <MermaidDiagram code={validCode} theme="light" renderer={renderer} debounceMs={200} />
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('mermaid-svg')).toHaveTextContent('Cached-->Node')
    expect(driver.render).toHaveBeenCalledTimes(renderCallsBeforeRevert)
  })

  it('re-renders and syncs the retained last-valid SVG to light/dark theme changes while in syntax error state', async () => {
    vi.useFakeTimers()
    let activeTheme = 'default'
    const driver: MermaidDriver = {
      initialize: vi.fn((config) => {
        activeTheme = config.theme ?? 'default'
      }),
      render: vi.fn(async (_id, text) => {
        if (text.includes('invalid')) {
          throw new Error('Parse error')
        }
        return {
          svg: `<svg data-theme="${activeTheme}"><text>${text.trim()}</text></svg>`
        }
      })
    }
    const renderer = createMermaidRenderer(driver)

    const { rerender } = render(
      <MermaidDiagram code={'graph TD\n  A-->B'} theme="light" renderer={renderer} debounceMs={200} />
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId('mermaid-svg').querySelector('svg')).toHaveAttribute(
      'data-theme',
      'default'
    )

    // Enter syntax error state -> retains light SVG + inline error banner
    rerender(
      <MermaidDiagram code={'graph TD\n  invalid'} theme="light" renderer={renderer} debounceMs={200} />
    )
    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })
    expect(screen.getByTestId('mermaid-svg').querySelector('svg')).toHaveAttribute(
      'data-theme',
      'default'
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Parse error')

    // Switch theme to dark while still in syntax error state -> retained SVG syncs to dark immediately
    rerender(
      <MermaidDiagram code={'graph TD\n  invalid'} theme="dark" renderer={renderer} debounceMs={200} />
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId('mermaid-diagram')).toHaveAttribute('data-mermaid-theme', 'dark')
    expect(screen.getByTestId('mermaid-svg')).toHaveTextContent('A-->B')
    expect(screen.getByTestId('mermaid-svg').querySelector('svg')).toHaveAttribute(
      'data-theme',
      'dark'
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Parse error')
    expect(screen.getByTestId('mermaid-diagram').querySelector('pre')).toBeNull()

    // Switch back to light -> retained valid diagram restores light SVG from cache without re-rendering A-->B
    const renderCallsBeforeLightReturn = (driver.render as ReturnType<typeof vi.fn>).mock.calls.length
    rerender(
      <MermaidDiagram code={'graph TD\n  invalid'} theme="light" renderer={renderer} debounceMs={200} />
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId('mermaid-diagram')).toHaveAttribute('data-mermaid-theme', 'default')
    expect(screen.getByTestId('mermaid-svg').querySelector('svg')).toHaveAttribute(
      'data-theme',
      'default'
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Parse error')
    const validCallsAfterLightReturn = (driver.render as ReturnType<typeof vi.fn>).mock.calls
      .slice(renderCallsBeforeLightReturn)
      .filter(([, text]) => !String(text).includes('invalid'))
    expect(validCallsAfterLightReturn).toHaveLength(0)

    // Fix syntax -> renders new valid code in current theme and removes banner
    rerender(
      <MermaidDiagram code={'graph TD\n  A-->C'} theme="light" renderer={renderer} debounceMs={200} />
    )
    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('mermaid-svg')).toHaveTextContent('A-->C')
    expect(screen.getByTestId('mermaid-svg').querySelector('svg')).toHaveAttribute(
      'data-theme',
      'default'
    )
  })

  it('renders immediately on initial mount inside React StrictMode without falling into debounce delay', async () => {
    vi.useFakeTimers()
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => ({
        svg: `<svg><text>${text.trim()}</text></svg>`
      }))
    }
    const renderer = createMermaidRenderer(driver)

    render(
      <StrictMode>
        <MermaidDiagram code={'graph TD\n  Strict-->Ok'} theme="light" renderer={renderer} debounceMs={250} />
      </StrictMode>
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId('mermaid-svg')).toHaveTextContent('Strict-->Ok')
  })

  it('copies raw Mermaid source on floating action bar click, shows 1500ms check feedback, resets timer on consecutive runs, prevents duplicate in-flight clicks, and isolates multiple blocks', async () => {
    vi.useFakeTimers()
    const copyResolvers: Array<() => void> = []
    const copyText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          copyResolvers.push(resolve)
        })
    )
    window.wikiApi = {
      diagram: { copyText }
    } as unknown as WikiApi

    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => ({
        svg: `<svg><text>${text.trim()}</text></svg>`
      }))
    }
    const renderer = createMermaidRenderer(driver)
    const firstCode = 'graph TD\n  A-->B'
    const secondCode = 'sequenceDiagram\n  Alice->>Bob: Hi'

    const { unmount } = render(
      <div>
        <MermaidDiagram code={firstCode} theme="light" renderer={renderer} debounceMs={0} />
        <MermaidDiagram code={secondCode} theme="light" renderer={renderer} debounceMs={0} />
      </div>
    )

    await act(async () => {
      await Promise.resolve()
    })

    const blocks = screen.getAllByTestId('mermaid-diagram')
    expect(blocks).toHaveLength(2)

    const firstToolbar = within(blocks[0]).getByRole('toolbar', { name: 'Mermaid 다이어그램 작업' })
    const secondToolbar = within(blocks[1]).getByRole('toolbar', { name: 'Mermaid 다이어그램 작업' })
    const firstCopyBtn = within(firstToolbar).getByRole('button', { name: '코드 복사' })
    const secondCopyBtn = within(secondToolbar).getByRole('button', { name: '코드 복사' })

    expect(firstCopyBtn).toHaveAttribute('title', '코드 복사')
    expect(firstCopyBtn).toBeEnabled()

    // Click while in-flight -> blocks duplicate click and keeps bar visible
    fireEvent.click(firstCopyBtn)
    fireEvent.click(firstCopyBtn)
    expect(copyText).toHaveBeenCalledTimes(1)
    expect(copyText).toHaveBeenCalledWith(firstCode)
    expect(firstToolbar).toHaveClass('is-visible')

    await act(async () => {
      copyResolvers.shift()?.()
      await Promise.resolve()
    })

    // Shows check state & 복사됨 feedback for 1500ms while second block stays idle
    expect(firstCopyBtn).toHaveTextContent('복사됨')
    expect(firstCopyBtn).toHaveAttribute('title', '복사됨')
    expect(firstCopyBtn).toHaveClass('is-copied')
    expect(firstToolbar).toHaveClass('is-visible')
    expect(secondCopyBtn).not.toHaveTextContent('복사됨')
    expect(secondCopyBtn).toHaveAttribute('title', '코드 복사')

    // Consecutive run at t=1000ms resets the 1500ms timer
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(firstCopyBtn).toHaveTextContent('복사됨')

    fireEvent.click(firstCopyBtn)
    await act(async () => {
      copyResolvers.shift()?.()
      await Promise.resolve()
    })
    expect(copyText).toHaveBeenCalledTimes(2)

    // 600ms after second completion (1600ms since first) -> still copied because timer reset!
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(firstCopyBtn).toHaveTextContent('복사됨')

    // Remaining 900ms -> automatically reverts to idle
    act(() => {
      vi.advanceTimersByTime(900)
    })
    expect(firstCopyBtn).not.toHaveTextContent('복사됨')
    expect(firstCopyBtn).toHaveAttribute('title', '코드 복사')
    expect(firstCopyBtn).not.toHaveClass('is-copied')
    expect(firstToolbar).not.toHaveClass('is-visible')

    // Trigger copy on second block then unmount before 1500ms -> no timer leak/warning
    fireEvent.click(secondCopyBtn)
    await act(async () => {
      copyResolvers.shift()?.()
      await Promise.resolve()
    })
    expect(secondCopyBtn).toHaveTextContent('복사됨')
    unmount()
    act(() => {
      vi.advanceTimersByTime(2000)
    })
  })

  it('reveals floating action bar via hover, keyboard focus (:focus-within), and active feedback while keeping button keyboard-tabbable', async () => {
    const user = userEvent.setup()
    const styleEl = document.createElement('style')
    styleEl.textContent = themeCss
    document.head.appendChild(styleEl)

    try {
      const driver: MermaidDriver = {
        initialize: vi.fn(),
        render: vi.fn(async () => ({ svg: '<svg><rect width="20" height="20"/></svg>' }))
      }
      const renderer = createMermaidRenderer(driver)

      render(
        <div>
          <button type="button">Before Diagram</button>
          <MermaidDiagram code={'graph TD\n  A-->B'} theme="light" renderer={renderer} debounceMs={0} />
        </div>
      )

      await screen.findByTestId('mermaid-svg')
      const block = screen.getByTestId('mermaid-diagram')
      const toolbar = within(block).getByRole('toolbar', { name: 'Mermaid 다이어그램 작업' })
      const copyImageBtn = within(toolbar).getByRole('button', { name: '이미지 복사' })
      const copyBtn = within(toolbar).getByRole('button', { name: '코드 복사' })
      const beforeBtn = screen.getByRole('button', { name: 'Before Diagram' })

      expect(toolbar).toHaveClass('is-floating')
      expect(getComputedStyle(toolbar).opacity).toBe('0')

      // Tab from preceding control reaches image-copy then code-copy while keeping toolbar visible
      beforeBtn.focus()
      await user.tab()
      expect(copyImageBtn).toHaveFocus()
      expect(getComputedStyle(toolbar).opacity).toBe('1')
      await user.tab()
      expect(copyBtn).toHaveFocus()
      expect(getComputedStyle(toolbar).opacity).toBe('1')

      // Moving focus away hides until hover
      beforeBtn.focus()
      expect(getComputedStyle(toolbar).opacity).toBe('0')

      await user.hover(block)
      expect(toolbar).toHaveClass('is-visible')
      expect(getComputedStyle(toolbar).opacity).toBe('1')

      await user.unhover(block)
      expect(toolbar).not.toHaveClass('is-visible')
      expect(getComputedStyle(toolbar).opacity).toBe('0')
    } finally {
      styleEl.remove()
    }
  })

  it('disables 코드 복사 only when source is whitespace-only and allows copy during loading, retained-SVG error, and fallback error states', async () => {
    const copyText = vi.fn(async () => {})
    window.wikiApi = {
      diagram: { copyText }
    } as unknown as WikiApi

    let resolvePendingRender!: (result: { svg: string }) => void
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => {
        if (text.includes('pending')) {
          return new Promise<{ svg: string }>((resolve) => {
            resolvePendingRender = resolve
          })
        }
        if (text.includes('broken')) {
          throw new Error('Parse error')
        }
        return { svg: `<svg><text>${text.trim()}</text></svg>` }
      })
    }
    const renderer = createMermaidRenderer(driver)

    // 1. Loading state (initial pending render before SVG or error exists) -> copy enabled
    const pendingCode = 'graph TD\n  pending_node'
    const { rerender, unmount } = render(
      <MermaidDiagram code={pendingCode} theme="light" renderer={renderer} debounceMs={0} />
    )
    const block = screen.getByTestId('mermaid-diagram')
    expect(within(block).getByText('Mermaid 다이어그램 렌더링 중...')).toBeInTheDocument()
    const loadingCopyBtn = within(block).getByRole('button', { name: '코드 복사' })
    expect(loadingCopyBtn).toBeEnabled()
    await act(async () => {
      fireEvent.click(loadingCopyBtn)
      await Promise.resolve()
    })
    expect(copyText).toHaveBeenLastCalledWith(pendingCode)

    await act(async () => {
      resolvePendingRender({ svg: '<svg><text>pending_node</text></svg>' })
      await Promise.resolve()
    })

    // 2. Retained-SVG syntax error state -> copies current broken source, not retained SVG code
    const retainedBrokenCode = 'graph TD\n  broken_after_valid'
    rerender(<MermaidDiagram code={retainedBrokenCode} theme="light" renderer={renderer} debounceMs={0} />)
    await screen.findByText('Mermaid 문법 오류')
    expect(within(block).getByTestId('mermaid-svg')).toHaveTextContent('pending_node')
    await act(async () => {
      fireEvent.click(within(block).getByRole('button', { name: '코드 복사' }))
      await Promise.resolve()
    })
    expect(copyText).toHaveBeenLastCalledWith(retainedBrokenCode)
    unmount()

    // 3. Fallback error box (initial broken diagram without lastValid) -> copy enabled with raw broken source
    const fallbackBrokenCode = 'graph TD\n  broken_initial'
    const fallbackView = render(
      <MermaidDiagram code={fallbackBrokenCode} theme="light" renderer={renderer} debounceMs={0} />
    )
    const fallbackBlock = screen.getByTestId('mermaid-diagram')
    await within(fallbackBlock).findByText('Mermaid 다이어그램 문법 오류')
    expect(within(fallbackBlock).getByRole('button', { name: '코드 복사' })).toBeEnabled()
    await act(async () => {
      fireEvent.click(within(fallbackBlock).getByRole('button', { name: '코드 복사' }))
      await Promise.resolve()
    })
    expect(copyText).toHaveBeenLastCalledWith(fallbackBrokenCode)

    // 4. Whitespace-only source -> button disabled and click does not call IPC
    const callsBeforeBlank = copyText.mock.calls.length
    fallbackView.rerender(
      <MermaidDiagram code={'   \n\t  '} theme="light" renderer={renderer} debounceMs={0} />
    )
    const blankCopyBtn = within(fallbackBlock).getByRole('button', { name: '코드 복사' })
    expect(blankCopyBtn).toBeDisabled()
    fireEvent.click(blankCopyBtn)
    expect(copyText).toHaveBeenCalledTimes(callsBeforeBlank)
  })

  it('logs sanitized metadata on copy failure, shows inline role="alert" scoped to that block, clears feedback on code change, and recovers on retry', async () => {
    const entries: RendererLogPayload[] = []
    let shouldFail = true
    const copyText = vi.fn(async () => {
      if (shouldFail) {
        throw new Error('클립보드에 접근할 수 없습니다.')
      }
    })
    window.wikiApi = {
      diagram: { copyText },
      log: {
        write: vi.fn(async (payload: RendererLogPayload) => {
          entries.push(payload)
        })
      }
    } as unknown as WikiApi

    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => ({ svg: `<svg><text>${text.trim()}</text></svg>` }))
    }
    const renderer = createMermaidRenderer(driver)
    const secretSource = 'graph TD\n  TOP_SECRET_BLOCK --> DEST'

    const { rerender } = render(
      <div>
        <MermaidDiagram code={secretSource} theme="light" renderer={renderer} debounceMs={0} />
        <MermaidDiagram code={'graph TD\n  B-->C'} theme="light" renderer={renderer} debounceMs={0} />
      </div>
    )
    await screen.findAllByTestId('mermaid-svg')

    const blocks = screen.getAllByTestId('mermaid-diagram')
    const firstBtn = within(blocks[0]).getByRole('button', { name: '코드 복사' })
    await act(async () => {
      fireEvent.click(firstBtn)
      await Promise.resolve()
    })

    expect(within(blocks[0]).getByRole('alert')).toHaveTextContent('클립보드에 접근할 수 없습니다.')
    expect(within(blocks[1]).queryByRole('alert')).not.toBeInTheDocument()
    expect(firstBtn).not.toHaveTextContent('복사됨')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      level: 'error',
      category: 'ui',
      message: 'Mermaid code copy failed',
      data: {
        codeLength: secretSource.length
      }
    })
    expect(JSON.stringify(entries)).not.toContain('TOP_SECRET_BLOCK')

    // Retry succeeds -> clears alert and displays copied feedback
    shouldFail = false
    await act(async () => {
      fireEvent.click(firstBtn)
      await Promise.resolve()
    })
    expect(within(blocks[0]).queryByRole('alert')).not.toBeInTheDocument()
    expect(firstBtn).toHaveTextContent('복사됨')

    // Source changes -> stale completed feedback is reset
    rerender(
      <div>
        <MermaidDiagram code={'graph TD\n  UPDATED-->NODE'} theme="light" renderer={renderer} debounceMs={0} />
        <MermaidDiagram code={'graph TD\n  B-->C'} theme="light" renderer={renderer} debounceMs={0} />
      </div>
    )
    await screen.findAllByTestId('mermaid-svg')
    expect(within(blocks[0]).getByRole('button', { name: '코드 복사' })).not.toHaveTextContent('복사됨')
    expect(within(blocks[0]).queryByRole('alert')).not.toBeInTheDocument()

    // Missing diagram bridge falls back cleanly to inline alert
    delete (window as { wikiApi?: WikiApi }).wikiApi
    await act(async () => {
      fireEvent.click(within(blocks[0]).getByRole('button', { name: '코드 복사' }))
      await Promise.resolve()
    })
    expect(within(blocks[0]).getByRole('alert')).toHaveTextContent('클립보드 복사 API를 사용할 수 없습니다.')
  })

  it('places 이미지 복사 before 코드 복사, copies 2x theme-backed PNG, manages 1500ms feedback, blocks duplicate in-flight clicks, and aborts on unmount', async () => {
    vi.useFakeTimers()

    const copiedImages: Uint8Array[] = []
    let resolveCopy!: () => void
    let deferCopy = false
    const copyImage = vi.fn(
      (bytes: Uint8Array) =>
        new Promise<void>((resolve) => {
          copiedImages.push(bytes)
          if (deferCopy) {
            resolveCopy = resolve
            return
          }
          resolve()
        })
    )
    const copyText = vi.fn(async () => {})
    window.wikiApi = {
      diagram: { copyText, copyImage }
    } as unknown as WikiApi

    const rasterRequests: DiagramSvgRasterRequest[] = []
    let deferRaster = false
    let resolveDeferredRaster!: (bytes: Uint8Array) => void
    const rasterAdapter: DiagramPngRasterAdapter = vi.fn((request) => {
      rasterRequests.push(request)
      if (deferRaster) {
        return new Promise<Uint8Array>((resolve) => {
          resolveDeferredRaster = resolve
        })
      }
      return Promise.resolve(new Uint8Array([137, 80, 78, 71, request.pixelWidth & 0xff]))
    })

    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => ({
        svg: `<svg viewBox="0 0 100 50" width="100%" style="max-width: 100px;"><g><text>${text.trim()}</text></g></svg>`
      }))
    }
    const renderer = createMermaidRenderer(driver)

    const { rerender, unmount } = render(
      <div>
        <MermaidDiagram
          code={'graph TD\n  FIRST-->SECOND'}
          theme="light"
          renderer={renderer}
          rasterAdapter={rasterAdapter}
          debounceMs={0}
        />
        <MermaidDiagram
          code={'graph TD\n  OTHER-->NODE'}
          theme="light"
          renderer={renderer}
          rasterAdapter={rasterAdapter}
          debounceMs={0}
        />
      </div>
    )

    await act(async () => {
      await Promise.resolve()
    })

    const blocks = screen.getAllByTestId('mermaid-diagram')
    const firstToolbar = within(blocks[0]).getByRole('toolbar', { name: 'Mermaid 다이어그램 작업' })
    const buttons = within(firstToolbar).getAllByRole('button')
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      '이미지 복사',
      '코드 복사'
    ])

    const firstImageBtn = buttons[0]
    const firstCodeBtn = buttons[1]
    const secondImageBtn = within(blocks[1]).getByRole('button', { name: '이미지 복사' })

    // 1. Light theme copy: #ffffff opaque background + 16px margin + 2x scale
    await act(async () => {
      fireEvent.click(firstImageBtn)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(rasterRequests).toHaveLength(1)
    expect(rasterRequests[0]).toMatchObject({
      pixelWidth: 264,
      pixelHeight: 164
    })
    const decodedLightSvg = decodeURIComponent(
      rasterRequests[0].svgDataUri.replace('data:image/svg+xml;charset=utf-8,', '')
    )
    expect(decodedLightSvg).toContain('width="132"')
    expect(decodedLightSvg).toContain('height="82"')
    expect(decodedLightSvg).toContain('fill="#ffffff"')
    expect(decodedLightSvg).not.toContain('max-width')
    expect(copiedImages).toHaveLength(1)
    expect(copiedImages[0]).toEqual(new Uint8Array([137, 80, 78, 71, 264 & 0xff]))
    expect(firstImageBtn).toHaveClass('is-copied')
    expect(firstImageBtn).toHaveTextContent('복사됨')
    expect(secondImageBtn).not.toHaveTextContent('복사됨')

    // Timer resets cleanly on consecutive click before 1500ms expires
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(firstImageBtn).toHaveTextContent('복사됨')
    await act(async () => {
      fireEvent.click(firstImageBtn)
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => {
      vi.advanceTimersByTime(1499)
    })
    expect(firstImageBtn).toHaveTextContent('복사됨')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(firstImageBtn).not.toHaveTextContent('복사됨')

    // 2. Dark theme copy: #161b22 opaque background
    rerender(
      <div>
        <MermaidDiagram
          code={'graph TD\n  FIRST-->SECOND'}
          theme="dark"
          renderer={renderer}
          rasterAdapter={rasterAdapter}
          debounceMs={0}
        />
        <MermaidDiagram
          code={'graph TD\n  OTHER-->NODE'}
          theme="light"
          renderer={renderer}
          rasterAdapter={rasterAdapter}
          debounceMs={0}
        />
      </div>
    )
    await act(async () => {
      await Promise.resolve()
    })

    // 3. In-flight click prevents duplicate image copy and adjacent code copy
    deferCopy = true
    await act(async () => {
      fireEvent.click(firstImageBtn)
      await Promise.resolve()
    })
    expect(firstImageBtn).toHaveAttribute('aria-busy', 'true')
    const decodedDarkSvg = decodeURIComponent(
      rasterRequests[2].svgDataUri.replace('data:image/svg+xml;charset=utf-8,', '')
    )
    expect(decodedDarkSvg).toContain('fill="#161b22"')

    await act(async () => {
      fireEvent.click(firstImageBtn)
      fireEvent.click(firstCodeBtn)
      await Promise.resolve()
    })
    expect(copyImage).toHaveBeenCalledTimes(3)
    expect(copyText).not.toHaveBeenCalled()

    await act(async () => {
      resolveCopy()
      await Promise.resolve()
    })
    expect(firstImageBtn).not.toHaveAttribute('aria-busy')
    expect(firstImageBtn).toHaveTextContent('복사됨')

    // 4. Unmounting mid-rasterization cancels before invoking copyImage IPC
    deferCopy = false
    deferRaster = true
    const callsBeforeUnmount = copyImage.mock.calls.length
    await act(async () => {
      fireEvent.click(firstImageBtn)
      await Promise.resolve()
    })
    unmount()
    await act(async () => {
      resolveDeferredRaster(new Uint8Array([1, 2, 3]))
      await Promise.resolve()
    })
    expect(copyImage).toHaveBeenCalledTimes(callsBeforeUnmount)
  })

  it('disables 이미지 복사 during loading, debounce pending, syntax errors, and whitespace-only while keeping 코드 복사 independent, and re-enables on valid recovery', async () => {
    vi.useFakeTimers()

    const copyText = vi.fn(async () => {})
    const copyImage = vi.fn(async () => {})
    window.wikiApi = {
      diagram: { copyText, copyImage }
    } as unknown as WikiApi

    const rasterAdapter: DiagramPngRasterAdapter = vi.fn(async (req) => {
      return new Uint8Array([1, 2, req.pixelWidth & 0xff])
    })

    let resolvePending!: (res: { svg: string }) => void
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => {
        if (text.includes('pending')) {
          return new Promise<{ svg: string }>((resolve) => {
            resolvePending = resolve
          })
        }
        if (text.includes('broken')) {
          throw new Error('Parse error')
        }
        return {
          svg: `<svg viewBox="0 0 80 40"><g><text>${text.trim()}</text></g></svg>`
        }
      })
    }
    const renderer = createMermaidRenderer(driver)

    // 1. Initial loading state -> 이미지 복사 disabled, 코드 복사 enabled & preserves copied feedback across SVG resolution
    const { rerender, unmount } = render(
      <MermaidDiagram
        code={'graph TD\n  pending_first'}
        theme="light"
        renderer={renderer}
        rasterAdapter={rasterAdapter}
        debounceMs={200}
      />
    )

    const block = screen.getByTestId('mermaid-diagram')
    const imageBtn = within(block).getByRole('button', { name: '이미지 복사' })
    const codeBtn = within(block).getByRole('button', { name: '코드 복사' })
    expect(imageBtn).toBeDisabled()
    expect(codeBtn).toBeEnabled()

    await act(async () => {
      fireEvent.click(codeBtn)
      await Promise.resolve()
    })
    expect(codeBtn).toHaveTextContent('복사됨')

    await act(async () => {
      resolvePending({
        svg: '<svg viewBox="0 0 80 40"><g><text>pending_first</text></g></svg>'
      })
      await Promise.resolve()
    })
    expect(imageBtn).toBeEnabled()
    expect(codeBtn).toHaveTextContent('복사됨')

    // 2. Debounced edit wait -> retained SVG visible, but 이미지 복사 immediately disabled until render settles
    rerender(
      <MermaidDiagram
        code={'graph TD\n  edited_valid'}
        theme="light"
        renderer={renderer}
        rasterAdapter={rasterAdapter}
        debounceMs={200}
      />
    )
    expect(within(block).getByTestId('mermaid-svg')).toHaveTextContent('pending_first')
    expect(imageBtn).toBeDisabled()
    expect(codeBtn).toBeEnabled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(within(block).getByTestId('mermaid-svg')).toHaveTextContent('edited_valid')
    expect(imageBtn).toBeEnabled()

    // 3. Theme switch with uncached render disables 이미지 복사 until dark SVG completes
    rerender(
      <MermaidDiagram
        code={'graph TD\n  pending_dark_switch'}
        theme="dark"
        renderer={renderer}
        rasterAdapter={rasterAdapter}
        debounceMs={200}
      />
    )
    expect(imageBtn).toBeDisabled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(imageBtn).toBeDisabled()
    await act(async () => {
      resolvePending({
        svg: '<svg viewBox="0 0 80 40"><g><text>pending_dark_switch</text></g></svg>'
      })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(imageBtn).toBeEnabled()

    // 4. Syntax error with retained SVG -> 이미지 복사 disabled, 코드 복사 enabled
    rerender(
      <MermaidDiagram
        code={'graph TD\n  broken_after_valid'}
        theme="dark"
        renderer={renderer}
        rasterAdapter={rasterAdapter}
        debounceMs={0}
      />
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(within(block).getByText('Mermaid 문법 오류')).toBeInTheDocument()
    expect(within(block).getByTestId('mermaid-svg')).toHaveTextContent('pending_dark_switch')
    expect(imageBtn).toBeDisabled()
    expect(codeBtn).toBeEnabled()

    // 5. Recovery to valid code -> re-enables 이미지 복사 and exports recovered SVG
    rerender(
      <MermaidDiagram
        code={'graph TD\n  recovered_ok'}
        theme="dark"
        renderer={renderer}
        rasterAdapter={rasterAdapter}
        debounceMs={0}
      />
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(imageBtn).toBeEnabled()
    await act(async () => {
      fireEvent.click(imageBtn)
      await Promise.resolve()
    })
    expect(rasterAdapter).toHaveBeenCalledTimes(1)
    expect(copyImage).toHaveBeenCalledTimes(1)

    // 6. Whitespace-only source -> both buttons disabled
    rerender(
      <MermaidDiagram
        code={'   \n  '}
        theme="dark"
        renderer={renderer}
        rasterAdapter={rasterAdapter}
        debounceMs={0}
      />
    )
    expect(imageBtn).toBeDisabled()
    expect(codeBtn).toBeDisabled()
    unmount()

    // 7. Initial fallback error box without lastValid -> 이미지 복사 disabled, 코드 복사 enabled
    render(
      <MermaidDiagram
        code={'graph TD\n  broken_initial'}
        theme="light"
        renderer={renderer}
        rasterAdapter={rasterAdapter}
        debounceMs={0}
      />
    )
    await act(async () => {
      await Promise.resolve()
    })
    const fallbackBlock = screen.getByTestId('mermaid-diagram')
    expect(within(fallbackBlock).getByRole('alert')).toHaveTextContent('Mermaid 다이어그램 문법 오류')
    expect(within(fallbackBlock).getByRole('button', { name: '이미지 복사' })).toBeDisabled()
    expect(within(fallbackBlock).getByRole('button', { name: '코드 복사' })).toBeEnabled()
  })

  it('logs sanitized metadata on image copy failure, scopes inline role="alert" to originating block, recovers on retry, and handles missing copyImage API', async () => {
    const entries: RendererLogPayload[] = []
    let failMode: 'none' | 'raster' | 'ipc' = 'raster'
    const secretSource = 'graph TD\n  TOP_SECRET_IMAGE_SOURCE --> TARGET'
    const validPng = new Uint8Array([137, 80, 78, 71, 42])

    const rasterAdapter: DiagramPngRasterAdapter = vi.fn(async () => {
      if (failMode === 'raster') {
        throw new Error('SVG 디코딩에 실패했습니다.')
      }
      return validPng
    })

    const copyImage = vi.fn(async () => {
      if (failMode === 'ipc') {
        throw new Error('네이티브 이미지 클립보드 쓰기에 실패했습니다.')
      }
    })
    window.wikiApi = {
      diagram: { copyText: vi.fn(async () => {}), copyImage },
      log: {
        write: vi.fn(async (payload: RendererLogPayload) => {
          entries.push(payload)
        })
      }
    } as unknown as WikiApi

    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => ({
        svg: `<svg viewBox="0 0 90 45"><g><text>${text.trim()}</text></g></svg>`
      }))
    }
    const renderer = createMermaidRenderer(driver)

    const { rerender } = render(
      <div>
        <MermaidDiagram
          code={secretSource}
          theme="dark"
          renderer={renderer}
          rasterAdapter={rasterAdapter}
          debounceMs={0}
        />
        <MermaidDiagram
          code={'graph TD\n  SECOND-->THIRD'}
          theme="dark"
          renderer={renderer}
          rasterAdapter={rasterAdapter}
          debounceMs={0}
        />
      </div>
    )
    await screen.findAllByTestId('mermaid-svg')

    const blocks = screen.getAllByTestId('mermaid-diagram')
    const firstImageBtn = within(blocks[0]).getByRole('button', { name: '이미지 복사' })

    // 1. Rasterizer failure
    await act(async () => {
      fireEvent.click(firstImageBtn)
      await Promise.resolve()
    })
    expect(within(blocks[0]).getByRole('alert')).toHaveTextContent('SVG 디코딩에 실패했습니다.')
    expect(within(blocks[1]).queryByRole('alert')).not.toBeInTheDocument()
    expect(firstImageBtn).not.toHaveTextContent('복사됨')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      level: 'error',
      category: 'ui',
      message: 'Mermaid image copy failed',
      data: {
        theme: 'dark',
        codeLength: secretSource.length
      }
    })
    expect(typeof (entries[0].data as { svgLength?: unknown }).svgLength).toBe('number')
    expect(JSON.stringify(entries[0])).not.toContain('TOP_SECRET_IMAGE_SOURCE')
    expect(JSON.stringify(entries[0])).not.toContain('<svg')

    // 2. IPC copyImage failure includes byteLength without logging PNG binary bytes
    failMode = 'ipc'
    await act(async () => {
      fireEvent.click(firstImageBtn)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(within(blocks[0]).getByRole('alert')).toHaveTextContent(
      '네이티브 이미지 클립보드 쓰기에 실패했습니다.'
    )
    expect(entries).toHaveLength(2)
    expect(entries[1]).toMatchObject({
      level: 'error',
      category: 'ui',
      message: 'Mermaid image copy failed',
      data: {
        theme: 'dark',
        codeLength: secretSource.length,
        byteLength: validPng.byteLength
      }
    })
    expect(JSON.stringify(entries[1])).not.toContain('137')

    // 3. Retry succeeds -> clears alert and displays copied feedback
    failMode = 'none'
    await act(async () => {
      fireEvent.click(firstImageBtn)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(within(blocks[0]).queryByRole('alert')).not.toBeInTheDocument()
    expect(firstImageBtn).toHaveTextContent('복사됨')

    // 4. Theme change clears stale feedback
    rerender(
      <div>
        <MermaidDiagram
          code={secretSource}
          theme="light"
          renderer={renderer}
          rasterAdapter={rasterAdapter}
          debounceMs={0}
        />
        <MermaidDiagram
          code={'graph TD\n  SECOND-->THIRD'}
          theme="dark"
          renderer={renderer}
          rasterAdapter={rasterAdapter}
          debounceMs={0}
        />
      </div>
    )
    await waitFor(() => {
      expect(within(blocks[0]).getByRole('button', { name: '이미지 복사' })).toBeEnabled()
    })
    expect(within(blocks[0]).getByRole('button', { name: '이미지 복사' })).not.toHaveTextContent(
      '복사됨'
    )

    // 5. Missing copyImage bridge triggers inline role="alert"
    delete (window as { wikiApi?: WikiApi }).wikiApi
    await act(async () => {
      fireEvent.click(within(blocks[0]).getByRole('button', { name: '이미지 복사' }))
      await Promise.resolve()
    })
    expect(within(blocks[0]).getByRole('alert')).toHaveTextContent(
      '이미지 클립보드 복사 API를 사용할 수 없습니다.'
    )
  })
})
