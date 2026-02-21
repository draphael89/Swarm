import { describe, expect, it } from 'vitest'
import { markdownToTelegramHtml } from '../integrations/telegram/telegram-markdown.js'

describe('markdownToTelegramHtml', () => {
  it('converts emphasis and links to Telegram HTML', () => {
    const output = markdownToTelegramHtml('Hello **world** [site](https://example.com)')

    expect(output).toContain('<b>world</b>')
    expect(output).toContain('<a href="https://example.com">site</a>')
  })

  it('escapes unsafe html before rendering', () => {
    const output = markdownToTelegramHtml('Use <script>alert(1)</script> safely')

    expect(output).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(output).not.toContain('<script>')
  })

  it('renders fenced code blocks as preformatted html', () => {
    const output = markdownToTelegramHtml('```ts\nconst answer = 42\n```')

    expect(output).toContain('<pre><code class="language-ts">const answer = 42</code></pre>')
  })

  it('collapses excessive newlines in output', () => {
    const output = markdownToTelegramHtml('line1\n\n\n\nline2')

    expect(output).toBe('line1\n\nline2')
  })
})
