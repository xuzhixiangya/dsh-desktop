/**
 * Test helper for the collapsible regions of the task form (the create and
 * edit dialogs). A region renders its fields only while expanded, so a test
 * that drives a field inside one opens it first — the same gesture a user
 * performs — instead of reaching into hidden state.
 */
import { act } from 'react'

/**
 * Expand one collapsed form region by its title.
 * @param container - The rendered tree.
 * @param title - The region title (its localized copy).
 * @returns The region's header button.
 * @throws When no region carries that title.
 */
export function openFormSection(container: HTMLElement, title: string): HTMLButtonElement {
  const header = [...container.querySelectorAll<HTMLButtonElement>('[data-dsh-part="form-section"] > button')]
    .find(button => (button.textContent ?? '').startsWith(title))
  if (header === undefined) throw new Error(`no form region titled ${title}`)
  if (header.getAttribute('aria-expanded') !== 'true') {
    act(() => { header.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  }
  return header
}
