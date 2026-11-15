import { StrictMode } from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WikiApi } from '@shared/ipc'
import type { RendererLogPayload } from '@shared/logging'
import { createMermaidRenderer, type MermaidDriver } from '../editor/mermaidRenderer'
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
})
