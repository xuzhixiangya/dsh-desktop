/**
 * Native panel registration contract (the desktop Plugins-page container).
 *
 * The board is an official center-column panel: it contributes a row into the
 * sidebar shell's own global panel list (`sidebar.panellist`) and its page into
 * the layout's keyed `main` slot. The shell — not this plugin — owns the row
 * box, the label, the active highlight, the collapsed rail and the panel
 * switch, which is exactly what makes the board render in the same container
 * the desktop application's Plugins page uses.
 *
 * These assertions read the registration source and the page stylesheet, so a
 * regression that reintroduces a self-drawn sidebar row or a DOM takeover of
 * the conversation column fails here.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/board.module.css', import.meta.url), 'utf8')
const source = readFileSync(new URL('../src/client/native-panel.tsx', import.meta.url), 'utf8')

/** The declarations of one class/attribute rule, or '' when the rule is absent. */
function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 's'))?.[1] ?? ''
}

describe('task-board native panel registration', () => {
  it('operator sees the sidebar row come from the shell seat, not a hand-drawn row', () => {
    // Given the registration source
    // When the sidebar row is contributed
    // Then it lands in the shell's own global panel list...
    expect(source).toContain("slots.inject('sidebar.panellist'")
    expect(source).toContain("name: 'sidebar.panellist'")
    // ...and the row supplies ONLY a glyph, because the shell owns the button,
    // the label, the tooltip, the active highlight and the rail geometry.
    expect(source).toContain('export function TaskBoardPanelIcon')
    expect(source).toContain('aria-hidden="true"')
  })

  it('operator sees the board page come from the layout main seat', () => {
    // Given the registration source
    // When the board page is contributed
    // Then it is a keyed 'main' occupant addressed by the shared panel id
    expect(source).toContain("slots.inject('main'")
    expect(source).toContain("name: 'main'")
    expect(source).toContain('key: TASK_BOARD_PANEL_ID')
    // The layout mounts it only while selected, so no rule here hides or
    // re-parents another plugin's surface.
    expect(css).not.toContain('display: none !important')
    expect(css).not.toContain("data-pane='conversation'")
    expect(css).not.toContain('[class*=\'centerCol\'] >')
  })

  it('operator sees the panel keep the semantic anchor and container-query context', () => {
    // Given the page wrapper and the stylesheet
    // When the board renders as the shell's selected panel page
    const view = rule(css, '[data-dsh-taskboard-view]')

    // Then the L2 anchor and plugin id stay on the page root
    expect(source).toContain('data-dsh-taskboard-view=""')
    expect(source).toContain('data-dsh-plugin="task-board"')
    // And the board measures the PANEL, not the viewport
    expect(view).toContain('container-name: task-board-view')
    expect(view).toContain('container-type: inline-size')
    expect(view).toContain('background: var(--dsw-alias-bg-base)')
  })

  it('operator sees the shell size the row glyph at each rail width', () => {
    // Given the icon component
    // When the shell renders it on the wide row and on the 56px rail
    // Then the glyph takes the shell's requested edge rather than a pinned 16px
    expect(source).toContain('width={size}')
    expect(source).toContain('height={size}')
  })
})
