import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CustomCommandConfig } from '@shared/config'
import { computeSlashMenuPosition, useSlashMenu } from './useSlashMenu'

describe('useSlashMenu & computeSlashMenuPosition', () => {
  it('clamps slash menu within shell bounds and flips above caret when near the bottom edge', () => {
    const shell = document.createElement('div')
    shell.getBoundingClientRect = () =>
      ({ left: 100, top: 50, right: 600, bottom: 450, width: 500, height: 400 }) as DOMRect

    // Right edge clamp (caret near right border)
    expect(
      computeSlashMenuPosition(shell, { left: 560, top: 120, bottom: 140 })
    ).toEqual({
      left: 192,
      top: 94
    })

    // Bottom edge flip above caret
    expect(
      computeSlashMenuPosition(shell, { left: 140, top: 380, bottom: 400 })
    ).toEqual({
      left: 40,
      top: 86
    })

    // Zero-dimension jsdom fallback keeps safe positive offsets
    const zeroShell = document.createElement('div')
    zeroShell.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect
    expect(
      computeSlashMenuPosition(zeroShell, { left: 0, top: 0, bottom: 0 })
    ).toEqual({
      left: 16,
      top: 24
    })
  })

  it('preserves selected trigger index across live query narrowing and dismisses outside range', () => {
    const commands: CustomCommandConfig[] = [
      { trigger: 'function', label: 'Function', template: 'fn' },
      { trigger: 'func-async', label: 'Async', template: 'afn' }
    ]
    const onApply = vi.fn(() => true)
    const { result, rerender } = renderHook(
      ({ cmds }) => useSlashMenu(cmds, onApply),
      { initialProps: { cmds: commands } }
    )

    act(() => {
      result.current.updateFromMatch({ query: 'f', rangeFrom: 2, rangeTo: 4 }, null, null)
    })
    act(() => {
      result.current.moveSelection(1)
    })
    expect(result.current.menuState.selectedIndex).toBe(1)

    // Narrowing query keeps /func-async selected
    act(() => {
      result.current.updateFromMatch({ query: 'func-', rangeFrom: 2, rangeTo: 8 }, null, null)
    })
    expect(result.current.menuState.items.map((c) => c.trigger)).toEqual(['func-async'])
    expect(result.current.menuState.selectedIndex).toBe(0)

    // Moving cursor outside [rangeFrom, rangeTo] dismisses
    act(() => {
      result.current.dismissIfSelectionOutside(0, 0, true)
    })
    expect(result.current.menuState.isOpen).toBe(false)

    // Live command update closes menu when no items match anymore
    act(() => {
      result.current.updateFromMatch({ query: 'func-', rangeFrom: 2, rangeTo: 8 }, null, null)
    })
    expect(result.current.menuState.isOpen).toBe(true)
    rerender({ cmds: [{ trigger: 'struct', label: 'Struct', template: 's' }] })
    expect(result.current.menuState.isOpen).toBe(false)
  })
})
