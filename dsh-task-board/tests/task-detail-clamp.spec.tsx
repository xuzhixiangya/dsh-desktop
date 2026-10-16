// @vitest-environment jsdom
/**
 * Detail clamp: the description and prompt bodies render behind a max-height
 * clamp; the expand toggle appears only when the content really overflows the
 * clamp, expands on click, and a new source starts clamped again. jsdom has
 * no layout engine, so the tests drive the measured height through an
 * HTMLElement.prototype.scrollHeight stub (the real signal the component
 * reads) — short content then means "no overflow", tall content "overflowing".
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClampedMarkdown } from '../src/client/board/ClampedMarkdown.tsx'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => { root.unmount() })
  }
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

/** Render the clamp body; rerender drives the source-change path. */
async function renderClamp(source: string): Promise<{ container: HTMLElement; rerender: (next: string) => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(<ClampedMarkdown source={source} />) })
  return {
    container,
    rerender: async (next: string) => { await act(async () => { root.render(<ClampedMarkdown source={next} />) }) },
  }
}

/** Stub the rendered content height the measure effect reads. */
function stubContentHeight(px: number): { set: (next: number) => void } {
  const spy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(px) // test-standards-allow: jsdom has no layout engine, so the one geometry signal the component consumes (scrollHeight) is stubbed at the prototype
  return { set: (next: number) => { spy.mockReturnValue(next) } }
}

/** The clamp state attribute the component always paints on its body. */
function clampState(container: HTMLElement): string | null {
  return container.querySelector('[data-clamped]')?.getAttribute('data-clamped') ?? null
}

/** The expand/collapse toggle, or null when the content fits the clamp. */
function toggleOf(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector('button')
}

describe('clamped detail markdown', () => {
  it('user reading a short text sees the full body and no toggle', async () => {
    // Given content that fits the clamp (no layout height in jsdom means no overflow)
    // When the body renders
    const { container } = await renderClamp('short note')

    // Then the text is rendered, unclamped, and no expand toggle is offered
    expect(container.textContent).toContain('short note')
    expect(clampState(container)).toBe('false')
    expect(toggleOf(container)).toBeNull()
  })

  it('user reading an overflowing text gets a collapsed body and can expand and re-collapse it', async () => {
    // Given content taller than the clamp
    stubContentHeight(500)

    // When the body renders
    const { container } = await renderClamp('a very long text')

    // Then it starts clamped, with the toggle offered in the collapsed state
    expect(clampState(container)).toBe('true')
    const toggle = toggleOf(container) as HTMLButtonElement
    expect(toggle.textContent).toBe('展开全文')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    // When the user expands it
    await act(async () => { toggle.click() })

    // Then the clamp lifts and the toggle offers to collapse
    expect(clampState(container)).toBe('false')
    expect(toggle.textContent).toBe('收起')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    // When the user collapses it again
    await act(async () => { toggle.click() })

    // Then the clamp returns with the toggle back in the collapsed state
    expect(clampState(container)).toBe('true')
    expect(toggle.textContent).toBe('展开全文')
  })

  it('user opening a different task starts clamped again even after expanding', async () => {
    // Given an expanded long text
    stubContentHeight(500)
    const { container, rerender } = await renderClamp('first long text')
    await act(async () => { toggleOf(container)!.click() })
    expect(clampState(container)).toBe('false')

    // When the detail view switches to another long text
    await rerender('second long text')

    // Then the new text starts clamped again with the toggle collapsed
    expect(clampState(container)).toBe('true')
    expect(container.textContent).toContain('second long text')
    expect(toggleOf(container)?.textContent).toBe('展开全文')
  })

  it('user opening a short text after a long one loses the toggle entirely', async () => {
    // Given a rendered long text with its toggle
    const height = stubContentHeight(500)
    const { container, rerender } = await renderClamp('a very long text')
    expect(toggleOf(container)?.textContent).toBe('展开全文')

    // When the content shrinks below the clamp
    height.set(40)
    await rerender('short')

    // Then the body renders unclamped and the toggle disappears
    expect(clampState(container)).toBe('false')
    expect(toggleOf(container)).toBeNull()
  })
})
