// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TaskMarkdown, markdownToPlainText } from '../src/client/board/task-markdown.tsx'

describe('Task Markdown presentation', () => {
  it('user reads headings, lists, emphasis, code and tables instead of delimiters', () => {
    // Given a Markdown task description.
    const source = '## Heading\n\n**Strong** and *emphasis*\n\n- [x] Complete\n- [ ] Pending\n\n```ts\nconst value = 1\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |'
    // When rendered in task details.
    const html = renderToStaticMarkup(<TaskMarkdown source={source} />)
    // Then semantic elements replace Markdown punctuation.
    expect(html).toContain('<h2')
    expect(html).toContain('<strong>Strong</strong>')
    expect(html).toContain('<em>emphasis</em>')
    expect(html).toContain('<pre')
    expect(html).toContain('<table')
    expect(markdownToPlainText('Fix **bug**!')).toBe('Fix bug!')
    expect(html).toContain('disabled=')
    expect(markdownToPlainText('### Steps\n- [x] Check `output`')).toBe('Steps Check output')
  })
  it('user cannot execute raw HTML or unsafe links from a task', () => {
    // Given hostile HTML, script URLs and a remote tracking image.
    const source = '<script>alert(1)</script>\n\n[bad](javascript:alert) [data](data:text/html,test) ![image](https://example.com/tracker) [safe](https://example.com)'
    // When the task is displayed.
    const html = renderToStaticMarkup(<TaskMarkdown source={source} />)
    // Then only safe explicit navigation survives and no image is fetched.
    expect(html).not.toContain('<script')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('data:text')
    expect(html).not.toContain('<img')
    expect(html).toContain('href="https://example.com/"')
    expect(html).toContain('noopener noreferrer')
  })
})
