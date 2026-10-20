/**
 * Product name and conduct shown to the model.
 * Only the system-prompt sections change; tool schemas and runtime context stay upstream.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AssembledSection } from '@deepseek-ai/dsh-system-prompt'
import { DESKTOP_DISPLAY_NAME } from './product-identity.ts'

const UPSTREAM_HARNESS_NAME = 'DeepSeek Harness'
const UPSTREAM_IDENTITY = `You are an AI agent powered by ${UPSTREAM_HARNESS_NAME}.`
const UPSTREAM_CODING_PERSONA = 'You are a coding agent powered by the {{model}} model.'

/** Name the model should see wherever the upstream harness name remains. */
export const DESKTOP_HARNESS_NAME = 'YX（银星智能） Harness'

const DESKTOP_BUILDER_NAME = 'YX（银星智能）'

/** Opening identity for this desktop agent. */
export const DESKTOP_AGENT_IDENTITY = `You are ${DESKTOP_DISPLAY_NAME} Agent, built by ${DESKTOP_BUILDER_NAME}.`

/**
 * Capability and language rule. Office work sits beside coding, and the reply
 * stays in the language of the user's message, including the reasoning.
 */
export const DESKTOP_AGENT_CONDUCT = 'You handle software engineering and office work, not coding alone. Reply in the language the user writes in. Think in that same language, and keep the whole reply in it.'

const DESKTOP_CODING_PERSONA = `You are powered by the {{model}} model. ${DESKTOP_AGENT_CONDUCT}`

function brandSection(section: AssembledSection): AssembledSection {
  let text = section.text
  if (text.includes(UPSTREAM_IDENTITY)) text = text.replaceAll(UPSTREAM_IDENTITY, DESKTOP_AGENT_IDENTITY)
  if (text.includes(UPSTREAM_CODING_PERSONA)) text = text.replaceAll(UPSTREAM_CODING_PERSONA, DESKTOP_CODING_PERSONA)
  if (text.includes(UPSTREAM_HARNESS_NAME)) text = text.replaceAll(UPSTREAM_HARNESS_NAME, DESKTOP_HARNESS_NAME)
  if (text === section.text) return section
  return { ...section, text }
}

function brandSections(sections: readonly AssembledSection[]): AssembledSection[] {
  const branded = sections.map(brandSection)
  if (branded.some(section => section.text.includes(DESKTOP_AGENT_CONDUCT))) return branded
  return [...branded, { name: 'desktop:agent-conduct', text: DESKTOP_AGENT_CONDUCT }]
}

/**
 * Rewrite assembled system-prompt sections after every other listener.
 * @param ctx - host context that assembles model prompts.
 * @returns disposer that restores the upstream wording.
 */
export function installSystemPromptBrand(ctx: Context): () => boolean {
  return ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    return { ...assembled, sections: brandSections(assembled.sections) }
  }, { prepend: true })
}
