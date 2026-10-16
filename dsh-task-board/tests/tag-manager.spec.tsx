// @vitest-environment jsdom
/**
 * The label manager as an operator uses it: the labels in use with their usage
 * counts, the ledger-wide rename it dispatches, and the confirmation a delete
 * has to pass through before anything is rewritten.
 */
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TagManagerModal, tagUsage } from '../src/client/board/TagManagerModal.tsx'
import { t } from '../src/client/locales.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
const NOW = 1_700_000_000_000

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
})

/** One task carrying the given labels. */
function task(id: string, tags?: TaskRecord['tags']): TaskRecord {
  return { ...createTask({ title: id, description: '', prompt: id }, NOW, id), ...(tags === undefined ? {} : { tags }) }
}

/** Controller double recording every ledger-wide label edit it is asked for. */
function fakeController(tasks: TaskRecord[]) {
  const calls: string[] = []
  const controller = {
    getSnapshot: () => ({ tasks, pendingTaskIds: [], transportError: undefined } as unknown as ControllerSnapshot),
    renameTag: async (from: string, to: string) => { calls.push('rename ' + from + '->' + to); return true },
    deleteTag: async (name: string) => { calls.push('delete ' + name); return true },
  } as unknown as BoardController
  return { controller, calls }
}

/** Mount one element into a fresh container attached to the document. */
function render(element: ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(element) })
  return container
}

/** Click one button by its visible label. */
function click(container: HTMLElement, label: string): void {
  const found = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === label)
  if (found === undefined) throw new Error('no button labelled ' + label)
  act(() => { found.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/** Type into a React-controlled input (the native setter defeats React's value tracker). */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('label manager', () => {
  it('user opening the label manager sees each label with the number of tasks carrying it', () => {
    // Given a board where one label is on two cards and another on one
    const { controller } = fakeController([
      task('a', [{ name: 'ship' }, { name: 'keep' }]),
      task('b', [{ name: 'ship' }]),
      task('c'),
    ])

    // When the manager opens
    const container = render(<TagManagerModal controller={controller} onClose={() => {}} />)

    // Then every label in use is listed with its usage count
    const rows = [...container.querySelectorAll('li')].map(row => row.textContent ?? '')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('ship')
    expect(rows[0]).toContain(t('tags.usage', { count: '2' }))
    expect(rows[1]).toContain('keep')
    expect(rows[1]).toContain(t('tags.usage', { count: '1' }))
  })

  it('user renaming a label from its row dispatches one ledger-wide rename', async () => {
    // Given a label carried by one card
    const { controller, calls } = fakeController([task('a', [{ name: 'ship' }]), task('b', [{ name: 'ship' }])])
    const container = render(<TagManagerModal controller={controller} onClose={() => {}} />)

    // When the user opens the row editor, types a new name and saves it
    click(container, t('tags.rename'))
    const input = container.querySelector('input') as HTMLInputElement
    typeInto(input, 'release')
    await act(async () => {
      const save = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === t('tags.save'))
      save?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Then the controller was asked once for the ledger-wide rename
    expect(calls).toEqual(['rename ship->release'])
  })

  it('user deleting a label is asked first, and the question names the usage count', () => {
    // Given a label carried by two cards
    const { controller, calls } = fakeController([task('a', [{ name: 'ship' }]), task('b', [{ name: 'ship' }])])
    const container = render(<TagManagerModal controller={controller} onClose={() => {}} />)

    // When the user asks to delete it
    click(container, t('tags.delete'))

    // Then nothing was written yet and the confirmation names the label and its usage
    expect(calls).toEqual([])
    const question = document.querySelector('[role="alertdialog"]')
    expect(question?.textContent).toContain('ship')
    expect(question?.textContent).toContain(t('tags.deleteConfirm', { name: 'ship', count: '2' }))
  })

  it('user confirming the delete rewrites the label off every card', async () => {
    // Given a label carried by two cards
    const { controller, calls } = fakeController([task('a', [{ name: 'ship' }]), task('b', [{ name: 'ship' }])])
    const container = render(<TagManagerModal controller={controller} onClose={() => {}} />)
    click(container, t('tags.delete'))

    // When the user confirms in the dialog
    await act(async () => {
      const dialog = document.querySelector('[role="alertdialog"]')
      const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find(candidate => candidate.textContent === t('tags.deleteOk'))
      confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Then the controller was asked to remove it once
    expect(calls).toEqual(['delete ship'])
  })

  it('operator reading the usage of a label counts every card that carries it', () => {
    // Given an archived card and an on-board card sharing a label, plus one without it
    const tasks = [
      task('a', [{ name: 'ship' }]),
      { ...task('b', [{ name: 'ship' }]), archivedAt: NOW - 1 },
      task('c', [{ name: 'other' }]),
    ]

    // When the manager reads the usage counts
    const usage = tagUsage(tasks)

    // Then both cards count towards the shared label and the unrelated one is separate
    expect(usage).toEqual([{ name: 'ship', count: 2 }, { name: 'other', count: 1 }])
  })

  it('user with an empty board sees the manager explain that no label is in use', () => {
    // Given a board with no labels at all
    const { controller } = fakeController([task('a')])

    // When the manager opens
    const container = render(<TagManagerModal controller={controller} onClose={() => {}} />)

    // Then it says so instead of rendering an empty list
    expect(container.textContent).toContain(t('tags.empty'))
    expect(container.querySelectorAll('li')).toHaveLength(0)
  })

  it('user pressing Escape while renaming cancels the edit instead of closing the manager', () => {
    // Given an open manager with a row editor open
    const { controller } = fakeController([task('a', [{ name: 'ship' }])])
    const onClose = vi.fn()
    const container = render(<TagManagerModal controller={controller} onClose={onClose} />)
    click(container, t('tags.rename'))
    expect(container.querySelectorAll('input')).toHaveLength(1)

    // When Escape is pressed
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })

    // Then the editor is gone, the manager is still open and nothing was closed
    expect(container.querySelectorAll('input')).toHaveLength(0)
    expect(container.textContent).toContain(t('tags.title'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('user closing the manager asks the board to close it', () => {
    // Given an open manager and a close recorder
    const { controller } = fakeController([task('a', [{ name: 'ship' }])])
    const onClose = vi.fn()
    const container = render(<TagManagerModal controller={controller} onClose={onClose} />)

    // When the user closes it from the footer
    click(container, t('tags.done'))

    // Then the board was asked to close the surface
    expect(onClose).toHaveBeenCalledOnce()
  })
})
