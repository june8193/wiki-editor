import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import themeCss from '../styles/theme.css?raw'
import { ConfirmDialog } from './ConfirmDialog'

describe('ConfirmDialog', () => {
  it('renders primary tone by default and applies danger tone styling with --danger-color when confirmTone is danger', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const onSecondary = vi.fn()

    const styleEl = document.createElement('style')
    styleEl.textContent = themeCss
    document.head.appendChild(styleEl)

    try {
      const { rerender } = render(
        <ConfirmDialog
          title="항목 삭제"
          message="삭제할까요?"
          confirmLabel="삭제 확인"
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      )

      const defaultConfirm = screen.getByRole('button', { name: '삭제 확인' })
      expect(defaultConfirm).toHaveClass('btn', 'btn-primary')
      expect(defaultConfirm).not.toHaveClass('btn-danger')
      expect(getComputedStyle(defaultConfirm).backgroundColor).toBe('rgb(9, 105, 218)')

      rerender(
        <ConfirmDialog
          title="전체 변경 사항 롤백"
          message="전체 변경 사항을 롤백할까요?"
          confirmLabel="전체 롤백"
          confirmTone="danger"
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      )

      const dangerConfirm = screen.getByRole('button', { name: '전체 롤백' })
      expect(dangerConfirm).toHaveClass('btn', 'btn-danger')
      expect(dangerConfirm).not.toHaveClass('btn-primary')
      expect(getComputedStyle(dangerConfirm).backgroundColor).toBe('rgb(207, 34, 46)')
      expect(getComputedStyle(dangerConfirm).borderColor).toBe('rgb(207, 34, 46)')
      expect(getComputedStyle(dangerConfirm).color).toBe('rgb(255, 255, 255)')

      document.documentElement.setAttribute('data-theme', 'dark')
      expect(getComputedStyle(dangerConfirm).backgroundColor).toBe('rgb(248, 81, 73)')
      expect(getComputedStyle(dangerConfirm).color).toBe('rgb(13, 17, 23)')
      document.documentElement.removeAttribute('data-theme')
      expect(screen.getAllByRole('button')).toHaveLength(2)

      await user.click(dangerConfirm)
      expect(onConfirm).toHaveBeenCalledTimes(1)

      await user.click(screen.getByRole('button', { name: '취소' }))
      expect(onCancel).toHaveBeenCalledTimes(1)

      rerender(
        <ConfirmDialog
          title="저장하지 않은 변경 사항"
          message="저장할까요?"
          confirmLabel="저장 후 진행"
          confirmTone="primary"
          secondaryLabel="저장 없이 진행"
          onConfirm={onConfirm}
          onSecondary={onSecondary}
          onCancel={onCancel}
        />
      )

      const explicitPrimary = screen.getByRole('button', { name: '저장 후 진행' })
      expect(explicitPrimary).toHaveClass('btn', 'btn-primary')
      expect(explicitPrimary).not.toHaveClass('btn-danger')

      await user.click(screen.getByRole('button', { name: '저장 없이 진행' }))
      expect(onSecondary).toHaveBeenCalledTimes(1)
    } finally {
      styleEl.remove()
    }
  })
})
