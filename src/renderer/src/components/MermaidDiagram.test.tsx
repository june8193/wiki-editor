import { StrictMode } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WikiApi } from '@shared/ipc'
import type { RendererLogPayload } from '@shared/logging'
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

      const block = screen.getByTestId('mermaid-diagram')
      const toolbar = within(block).getByRole('toolbar', { name: 'Mermaid 다이어그램 작업' })
      const copyBtn = within(toolbar).getByRole('button', { name: '코드 복사' })
      const beforeBtn = screen.getByRole('button', { name: 'Before Diagram' })

      expect(toolbar).toHaveClass('is-floating')
      expect(getComputedStyle(toolbar).opacity).toBe('0')

      // Tab from preceding control reaches copy button directly
      beforeBtn.focus()
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
})
