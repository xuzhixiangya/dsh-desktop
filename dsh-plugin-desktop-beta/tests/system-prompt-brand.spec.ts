import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { expect, it } from 'vitest'
import { DESKTOP_AGENT_CONDUCT, DESKTOP_AGENT_IDENTITY, DESKTOP_HARNESS_NAME, installSystemPromptBrand } from '../src/system-prompt-brand.ts'

it('names Silverstar Agent and keeps the reply in the user language', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    installSystemPromptBrand(ctx)
    ctx.systemPrompt.section({
      name: 'app:web-surface',
      order: ctx.systemPrompt.getSectionOrder('WEB_SURFACE'),
      text: 'You are interacting with the user through the DeepSeek Harness Web GUI. The model is deepseek-v4-flash.',
    })
    ctx.systemPrompt.section({
      name: 'harness:source',
      order: ctx.systemPrompt.getSectionOrder('HARNESS_SOURCE'),
      text: 'The DeepSeek Harness implementation checkout is at /tmp/deepseek-harness.',
    })
    const rendered = renderPrompt(await ctx.systemPrompt.assemble())
    expect(rendered.startsWith(DESKTOP_AGENT_IDENTITY)).toBe(true)
    expect(rendered).toContain(DESKTOP_AGENT_CONDUCT)
    expect(rendered).toContain(`through the ${DESKTOP_HARNESS_NAME} Web GUI`)
    expect(rendered).toContain(`The ${DESKTOP_HARNESS_NAME} implementation checkout is at /tmp/deepseek-harness.`)
    expect(rendered).toContain('deepseek-v4-flash')
    expect(rendered).not.toContain('DeepSeek Harness')
    expect(rendered).not.toContain('coding agent')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('replaces the coding-only persona without repeating the language rule', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt, {
      personaPrefix: 'You are a coding agent powered by the {{model}} model.',
    })
    installSystemPromptBrand(ctx)
    ctx.systemPrompt.variable('model', () => 'yx-model')
    const rendered = renderPrompt(await ctx.systemPrompt.assemble())
    expect(rendered).toContain('You are powered by the yx-model model.')
    expect(rendered).toContain(DESKTOP_AGENT_CONDUCT)
    expect(rendered.split(DESKTOP_AGENT_CONDUCT)).toHaveLength(2)
    expect(rendered).not.toContain('coding agent')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('restores the upstream system prompt after the brand listener is removed', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    const stop = installSystemPromptBrand(ctx)
    stop()
    const rendered = renderPrompt(await ctx.systemPrompt.assemble())
    expect(rendered.startsWith('You are an AI agent powered by DeepSeek Harness.')).toBe(true)
    expect(rendered).not.toContain(DESKTOP_AGENT_CONDUCT)
  } finally {
    await ctx.fiber.dispose()
  }
})
