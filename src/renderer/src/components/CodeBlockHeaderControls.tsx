import { type KeyboardEvent, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Copy } from 'lucide-react'
import {
  filterCodeBlockLanguageOptions,
  formatCodeBlockLanguageLabel,
  resolveCanonicalLanguageInput
} from '../editor/codeBlockHighlight'
import { useDismissable } from '../hooks/useDismissable'
import { useTimedFeedback } from '../hooks/useTimedFeedback'
import { useOptionalWikiApi } from '../hooks/useWikiApi'

export interface CodeBlockCopyButtonProps {
  code: string
}

/**
 * Clipboard copy button rendered in code block headers across Preview and WYSIWYG modes.
 */
export function CodeBlockCopyButton({ code }: CodeBlockCopyButtonProps) {
  const contextWikiApi = useOptionalWikiApi()
  const { completedKey, triggerFeedback, beginExecution, isExecutionActive } =
    useTimedFeedback<'copy'>([code])
  const latestCodeRef = useRef(code)
  latestCodeRef.current = code

  const isCopied = completedKey === 'copy'
  const canCopy = code.trim().length > 0

  const handleCopy = async (): Promise<void> => {
    if (!canCopy) return
    const api = contextWikiApi ?? window.wikiApi
    const copyFn =
      typeof api?.diagram?.copyText === 'function'
        ? (text: string) => api.diagram!.copyText(text)
        : typeof api?.clipboard?.writeText === 'function'
          ? (text: string) => api.clipboard!.writeText(text)
          : typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function'
            ? (text: string) => navigator.clipboard.writeText(text)
            : undefined

    const token = beginExecution()
    if (typeof copyFn !== 'function') {
      return
    }

    const targetCode = code
    try {
      await copyFn(targetCode)
      if (isExecutionActive(token) && latestCodeRef.current === targetCode) {
        triggerFeedback('copy')
      }
    } catch {
      // Ignore clipboard failure without leaving stale feedback active
    }
  }

  return (
    <button
      type="button"
      className={`code-block-copy-btn${isCopied ? ' is-copied' : ''}`}
      aria-label="코드 복사"
      title={isCopied ? '복사됨' : '코드 복사'}
      disabled={!canCopy}
      onClick={() => {
        void handleCopy()
      }}
    >
      {isCopied ? (
        <>
          <Check size={13} strokeWidth={2} aria-hidden="true" />
          <span>복사됨</span>
        </>
      ) : (
        <>
          <Copy size={13} strokeWidth={1.75} aria-hidden="true" />
          <span>코드 복사</span>
        </>
      )}
    </button>
  )
}

export interface CodeBlockLanguageComboboxProps {
  language: string
  autoFocusTriggerOnMount?: boolean
  onSelectLanguage: (nextLanguage: string) => void
}

interface ComboboxOptionItem {
  key: string
  value: string
  label: string
  isCustom?: boolean
}

/**
 * Interactive language selector with preset options and freeform input for WYSIWYG code blocks.
 */
export function CodeBlockLanguageCombobox({
  language,
  autoFocusTriggerOnMount = false,
  onSelectLanguage
}: CodeBlockLanguageComboboxProps) {
  const comboboxId = useId()
  const listboxId = `${comboboxId}-listbox`
  const containerRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1)

  const closePopover = useCallback(() => {
    setIsOpen(false)
    setQuery('')
    setHighlightedIndex(-1)
  }, [])

  useDismissable(isOpen, containerRef, closePopover, { capture: true })

  useLayoutEffect(() => {
    if (autoFocusTriggerOnMount) {
      triggerRef.current?.focus()
    }
  }, [autoFocusTriggerOnMount])

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus()
    }
  }, [isOpen])

  const canonicalLanguage = resolveCanonicalLanguageInput(language)
  const displayLabel = formatCodeBlockLanguageLabel(language)

  const optionItems = useMemo((): ComboboxOptionItem[] => {
    const trimmedQuery = query.trim()
    const matchingPresets = filterCodeBlockLanguageOptions(trimmedQuery)

    const items: ComboboxOptionItem[] = matchingPresets.map((option) => ({
      key: `preset-${option.value || 'plaintext'}`,
      value: option.value,
      label: option.label
    }))

    if (trimmedQuery.length > 0) {
      const resolvedCustomValue = resolveCanonicalLanguageInput(trimmedQuery)
      const alreadyListed = items.some((item) => item.value === resolvedCustomValue)
      if (resolvedCustomValue.length > 0 && !alreadyListed) {
        items.push({
          key: `custom-${resolvedCustomValue}`,
          value: resolvedCustomValue,
          label: `직접 지정: ${trimmedQuery}`,
          isCustom: true
        })
      }
    }

    return items
  }, [query])

  optionRefs.current.length = optionItems.length

  useEffect(() => {
    if (isOpen && highlightedIndex >= 0 && highlightedIndex < optionItems.length) {
      optionRefs.current[highlightedIndex]?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [highlightedIndex, isOpen, optionItems.length])

  const getOptionId = (item: ComboboxOptionItem): string => `${comboboxId}-${item.key}`
  const activeOptionId =
    highlightedIndex >= 0 && highlightedIndex < optionItems.length
      ? getOptionId(optionItems[highlightedIndex])
      : undefined

  const dismissAndFocusTrigger = useCallback(() => {
    closePopover()
    triggerRef.current?.focus()
  }, [closePopover])

  const commitLanguage = useCallback(
    (nextValue: string) => {
      onSelectLanguage(nextValue)
      dismissAndFocusTrigger()
    },
    [dismissAndFocusTrigger, onSelectLanguage]
  )

  const handlePopoverKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) {
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      dismissAndFocusTrigger()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      if (optionItems.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const currentIndex =
        highlightedIndex >= 0
          ? highlightedIndex
          : optionRefs.current.indexOf(document.activeElement as HTMLButtonElement)
      const nextIndex =
        currentIndex < 0
          ? delta > 0
            ? 0
            : optionItems.length - 1
          : (currentIndex + delta + optionItems.length) % optionItems.length
      setHighlightedIndex(nextIndex)
      if (document.activeElement !== inputRef.current) {
        optionRefs.current[nextIndex]?.focus()
      }
      return
    }
    event.stopPropagation()
  }

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) {
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (highlightedIndex >= 0 && highlightedIndex < optionItems.length) {
        commitLanguage(optionItems[highlightedIndex].value)
        return
      }
      if (query.trim().length > 0) {
        const resolved = resolveCanonicalLanguageInput(query)
        if (resolved.length > 0 || optionItems.some((item) => item.value === '')) {
          commitLanguage(resolved)
        } else {
          dismissAndFocusTrigger()
        }
        return
      }
      dismissAndFocusTrigger()
    }
  }

  return (
    <div
      ref={containerRef}
      className="code-block-language-combobox"
      onBlur={(event) => {
        if (
          isOpen &&
          event.relatedTarget instanceof Node &&
          !containerRef.current?.contains(event.relatedTarget)
        ) {
          closePopover()
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="code-block-language-trigger"
        aria-label="코드 블록 언어 선택"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onKeyDown={(event) => {
          if (isOpen && event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            closePopover()
          }
        }}
        onClick={() => {
          if (isOpen) {
            closePopover()
          } else {
            setIsOpen(true)
          }
        }}
      >
        <span className="code-block-language-trigger-label">{displayLabel}</span>
        <ChevronDown size={13} strokeWidth={1.75} aria-hidden="true" />
      </button>

      {isOpen && (
        <div
          className="code-block-language-popover"
          onMouseDown={(event) => {
            if (event.target !== inputRef.current) {
              event.preventDefault()
            }
          }}
          onKeyDown={handlePopoverKeyDown}
        >
          <input
            ref={inputRef}
            type="text"
            className="code-block-language-input"
            aria-label="언어 검색 또는 직접 입력"
            aria-controls={listboxId}
            aria-activedescendant={activeOptionId}
            placeholder="언어 선택 또는 직접 입력..."
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setHighlightedIndex(-1)
            }}
            onKeyDown={handleInputKeyDown}
          />
          <div
            id={listboxId}
            role="listbox"
            aria-label="코드 블록 언어 목록"
            className="code-block-language-list"
          >
            {optionItems.map((item, index) => {
              const isSelected = !item.isCustom && item.value === canonicalLanguage
              const isHighlighted = index === highlightedIndex
              return (
                <button
                  ref={(el) => {
                    optionRefs.current[index] = el
                  }}
                  id={getOptionId(item)}
                  key={item.key}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`code-block-language-option${isSelected ? ' is-selected' : ''}${isHighlighted ? ' is-highlighted' : ''}`}
                  onFocus={() => setHighlightedIndex(index)}
                  onClick={() => commitLanguage(item.value)}
                >
                  {item.label}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
