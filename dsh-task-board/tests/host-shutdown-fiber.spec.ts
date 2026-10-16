/**
 * End-to-end proof against a REAL cordis fiber.
 *
 * host-shutdown-tools.spec.ts drives a context double, so the INACTIVE_EFFECT
 * refusal there is raised by the test. This file drives cordis itself: the
 * board's host half is mounted on a real plugin fiber through the real
 * `Fiber.effect`, a provider contributes its tools while that fiber is live,
 * and the fiber is then disposed exactly as a Ctrl+C shutdown does. The
 * refusal therefore comes from cordis, with the same code the issue reported.
 *
 * The tool service is a scoped proxy bound to the caller's fiber, which is what
 * the real host hands out (`ScopedLayers` / `Proxy.register` in the reported
 * stack): an effect it creates belongs to the plugin that called `register`, so
 * a call made from a disposer is refused by that fiber, not by the provider's.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Config, apply } from '../src/index.ts'
import {
  TASK_BOARD_API_VERSION,
  type TaskBoardExtension,
  type TaskBoardExtensionHost,
} from '../src/core/extension.ts'

/**
 * The board resolves its ledger from DSH_HOME. That must never be the
 * developer's live home: point it at a scratch directory and restore it after.
 */
let previousHome: string | undefined
let scratchHome: string | undefined

beforeEach(() => {
  previousHome = process.env.DSH_HOME
  scratchHome = mkdtempSync(join(tmpdir(), 'dsh-task-board-fiber-'))
  process.env.DSH_HOME = scratchHome
})

afterEach(() => {
  if (scratchHome !== undefined) rmSync(scratchHome, { recursive: true, force: true })
  scratchHome = undefined
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

/** A session-list gateway double: the board's poll reads the roster through it. */
function emptyRosterGateway(): TypertGateway {
  return {
    invoke: async () => ({ items: [] }),
    stream: async () => ({ async *[Symbol.asyncIterator]() {} }),
  } as unknown as TypertGateway
}

/** One provider tool definition, in the shape the tool registry accepts. */
function toolDefinition(name: string): ToolDefinition {
  return { name, description: 'provider tool', parameters: {}, execute: async () => ({}) } as unknown as ToolDefinition
}

/** A provider contributing the named tools once it starts. */
function provider(id: string, toolNames: string[]): TaskBoardExtension {
  return {
    id,
    apiVersion: TASK_BOARD_API_VERSION,
    start: (face: TaskBoardExtensionHost) => {
      for (const name of toolNames) face.registerTool(toolDefinition(name))
    },
  }
}

describe('real cordis fiber shutdown', () => {
  it('operator stopping dsh web through a real fiber disposes without a registration failure', async () => {
    // Given a real cordis application mounting the board on its own fiber,
    // with the host's scoped tool proxy bound to that fiber
    const app = new Context()
    const published: Array<{ registerExtension?: (extension: TaskBoardExtension) => () => void }> = []
    const boardFiber = await app.registry.plugin({
      name: '@linxin666/dsh-client-ui-task-board-probe',
      apply: (ctx: Context) => {
        const tools = {
          register: (definition: ToolDefinition) =>
            ctx.effect(() => () => {}, 'register ' + definition.name) as () => void,
        }
        const shim = {
          get: (name: string) => name === 'typertGateway' ? emptyRosterGateway() : name === 'tools' ? tools : undefined,
          typertGateway: emptyRosterGateway(),
          workspaceRegistry: {},
          agents: { get: () => undefined },
          commands: { execute: async () => undefined },
          systemPrompt: { section: () => () => {} },
          webServer: { register: () => () => {} },
          // cordis rejects an effect body that returns nothing, so an effect
          // returning no disposer is normalized into one, as a real host does.
          effect: (body: () => unknown) => {
            const disposer = body()
            const release = typeof disposer === 'function' ? disposer as () => void : () => {}
            return ctx.effect(() => release, 'board effect')
          },
          on: () => {},
          provide: (name: string, value: unknown) => {
            if (name === 'taskBoard') published.push(value as { registerExtension?: (extension: TaskBoardExtension) => () => void })
          },
        }
        apply(shim as never, Config({ enabled: true }))
      },
    })

    // When a provider contributes three tools while the fiber is still live,
    // and the fiber is then disposed the way a Ctrl+C shutdown does
    published[0]?.registerExtension?.(provider('reports', ['reports_list', 'reports_get', 'reports_refresh']))
    const reported: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { reported.push(args.map(value => String(value)).join(' ')) }
    try {
      await boardFiber.dispose()
    } finally {
      console.error = originalError
    }

    // Then the disposal reported no registration failure, and the fiber that
    // raised none is genuinely a disposed one, which refuses late effects
    expect(reported.filter(line => line.includes('registration failed'))).toEqual([])
    expect(boardFiber.state).toBe(4)
  })
})
