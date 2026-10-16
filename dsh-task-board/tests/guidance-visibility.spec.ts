/**
 * The task-board announcement is visibility-gated: the guidance names the
 * `task_board_*` tools, so it renders only while at least one of them is
 * reachable. This is the native convention
 * (`@deepseek-ai/dsh-tool-subagent` renders its section through the same
 * `tools.get(name, scope)` read), and it is what keeps a deployment that
 * serves no tool registry — or a scope whose tools were restricted away — from
 * carrying guidance for tools it cannot call.
 */
import { describe, expect, it } from 'vitest'
import { TASK_BOARD_TOOL_NAMES } from '../src/host/agent-tools.ts'
import { visibleToolText } from '../src/tool-surface.ts'
import { TASK_BOARD_GUIDANCE } from '../src/index.ts'

/** A registry stub exposing exactly the given names. */
function registryWith(names: readonly string[]) {
  const visible = new Set(names)
  return { get: (name: string) => (visible.has(name) ? { name } : undefined) }
}

describe('task-board announcement visibility', () => {
  it('user on a registry without the board tools reads no board announcement', () => {
    // Given a deployment whose tool surface does not carry the board tools
    const text = visibleToolText(registryWith([]), TASK_BOARD_TOOL_NAMES, TASK_BOARD_GUIDANCE)

    // When the announcement renders for a scope
    // Then it is empty rather than naming tools the session cannot call
    expect(text({ scope: {} })).toBe('')
  })

  it('user whose board tools are reachable reads the announcement', () => {
    // Given the board's tools are on the wire
    const text = visibleToolText(registryWith(['task_board_list']), TASK_BOARD_TOOL_NAMES, TASK_BOARD_GUIDANCE)

    // When it renders
    // Then the guidance is present
    expect(text({ scope: {} })).toBe(TASK_BOARD_GUIDANCE)
  })

  it('operator sees the announcement cover every registered board tool name', () => {
    // Given the registered surface
    // When the gate is asked about each name in turn
    // Then each one renders the guidance, so none is silently ungated
    expect(TASK_BOARD_TOOL_NAMES.length).toBe(8)
    for (const name of TASK_BOARD_TOOL_NAMES) {
      expect(visibleToolText(registryWith([name]), TASK_BOARD_TOOL_NAMES, 'G')({})).toBe('G')
    }
  })
})
