// @vitest-environment jsdom
/**
 * The board's transient-surface contract: a modal surface takes focus when it
 * opens, keeps Tab inside itself, answers Escape with a close request, returns
 * focus to the control that opened it, and — once closed — stays mounted for
 * the exit leg of its motion pair instead of disappearing on the click's tick.
 */
import { act, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from '../src/client/board/ConfirmDialog.tsx'
import { OVERLAY_EXIT_MS, usePresence } from '../src/client/board/overlay.tsx'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
  vi.useRealTimers()
})

/** Mount one element into a fresh container attached to the document. */
function mount(element: ReactElement): { container: HTMLElement; root: Root } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(element) })
  return { container, root }
}

/** A trigger button in the document, focused like the user just pressed it. */
function focusedOpener(): HTMLButtonElement {
  const opener = document.createElement('button')
  opener.textContent = 'open'
  document.body.appendChild(opener)
  opener.focus()
  return opener
}

/** Dispatch one keydown the way the browser reports it. */
function pressKey(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
}

/** A surface whose owner can close it, for the presence contract. */
function Presenced(): ReactElement {
  const [open, setOpen] = useState(true)
  const presence = usePresence(open)
  return (
    <div>
      <button type="button" onClick={() => { setOpen(false) }}>close</button>
      {presence.mounted
        ? <div data-dsh-part="surface" data-state={presence.phase} />
        : null}
    </div>
  )
}

describe('modal surface contract', () => {
  it('operator opening a confirm surface gets focus inside it and a modal declaration', () => {
    // Given a focused trigger and no surface yet
    focusedOpener()

    // When the confirm surface opens
    const { container } = mount(
      <ConfirmDialog title="删除任务" message="确认删除" confirmLabel="删除" onCancel={() => undefined} onConfirm={() => undefined} />,
    )

    // Then it is modal and focus already sits on one of its own controls
    const dialog = container.querySelector('[role="alertdialog"]')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.contains(document.activeElement)).toBe(true)
  })

  it('operator pressing Escape closes exactly once and keeps focus inside the surface', () => {
    // Given an open confirm surface
    focusedOpener()
    const onCancel = vi.fn()
    mount(<ConfirmDialog title="删除任务" message="确认删除" confirmLabel="删除" onCancel={onCancel} onConfirm={() => undefined} />)
    const surface = document.querySelector('[role="alertdialog"]')

    // When Escape is pressed
    pressKey('Escape')

    // Then the owner is asked to close once and the surface is still mounted
    // (its exit leg runs after the request)
    expect(onCancel).toHaveBeenCalledOnce()
    expect(surface?.getAttribute('role')).toBe('alertdialog')
  })

  it('operator tabbing past the last control wraps back to the first one', () => {
    // Given an open confirm surface whose last control is focused
    focusedOpener()
    const { container } = mount(
      <ConfirmDialog title="删除任务" message="确认删除" confirmLabel="删除" onCancel={() => undefined} onConfirm={() => undefined} />,
    )
    const surface = container.querySelector('[role="alertdialog"]') as HTMLElement
    const controls = [...surface.querySelectorAll('button')]
    const last = controls[controls.length - 1]
    act(() => { last.focus() })

    // When Tab is pressed at the end of the surface
    pressKey('Tab')

    // Then focus wrapped to the first control instead of leaving the surface
    expect(document.activeElement).toBe(controls[0])
  })

  it('operator pressing Escape on a nested surface closes only the top one', () => {
    // Given a task-detail-sized surface with a confirm surface mounted above it
    focusedOpener()
    const closeDetail = vi.fn()
    const closeConfirm = vi.fn()
    mount(
      <div>
        <ConfirmDialog title="任务详情" message="detail" confirmLabel="确定" onCancel={closeDetail} onConfirm={() => undefined} />
        <ConfirmDialog title="删除任务" message="confirm" confirmLabel="删除" onCancel={closeConfirm} onConfirm={() => undefined} />
      </div>,
    )

    // When Escape is pressed
    pressKey('Escape')

    // Then only the topmost surface was asked to close, and both are still up
    expect(closeConfirm).toHaveBeenCalledOnce()
    expect(closeDetail).not.toHaveBeenCalled()
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(2)
  })

  it('operator closing the surface gets focus back on the control that opened it', () => {
    // Given a focused trigger and an open surface mounted above it
    const opener = focusedOpener()
    const { root } = mount(
      <ConfirmDialog title="删除任务" message="确认删除" confirmLabel="删除" onCancel={() => undefined} onConfirm={() => undefined} />,
    )
    expect(document.activeElement).not.toBe(opener)

    // When the surface unmounts
    act(() => { root.unmount() })

    // Then focus is back on the trigger
    expect(document.activeElement).toBe(opener)
  })
})

describe('overlay presence', () => {
  it('operator closing a surface sees it stay mounted through the exit leg and then leave', () => {
    vi.useFakeTimers()
    // Given an open surface
    const { container } = mount(<Presenced />)
    const close = container.querySelector('button') as HTMLButtonElement
    expect(container.querySelectorAll('[data-dsh-part="surface"]')).toHaveLength(1)

    // When the owner closes it
    act(() => { close.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    // Then it is still mounted, on its exit leg
    expect(container.querySelector('[data-dsh-part="surface"]')?.getAttribute('data-state')).toBe('closing')

    // And only after the exit duration has elapsed does it leave the document
    act(() => { vi.advanceTimersByTime(OVERLAY_EXIT_MS + 1) })
    expect(container.querySelector('[data-dsh-part="surface"]')).toBeNull()
  })
})
