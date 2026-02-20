import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownMessage } from './MarkdownMessage'

describe('MarkdownMessage', () => {
  it('renders common markdown formatting for speak_to_user content', () => {
    const content = [
      'Visit [example](https://example.com).',
      '',
      'Use `pnpm test`.',
      '',
      '```ts',
      'console.log("hello")',
      '```',
      '',
      '- alpha',
      '- beta',
      '',
      'This is **bold** and *italic*.',
    ].join('\n')

    const html = renderToStaticMarkup(createElement(MarkdownMessage, { content }))

    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('<code class="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs text-foreground">pnpm test</code>')
    expect(html).toContain('<pre class="my-2 overflow-x-auto rounded-md border border-border/70 bg-muted/45 p-2">')
    expect(html).toContain('<ul class="mb-2 list-disc space-y-0.5 pl-5 last:mb-0">')
    expect(html).toContain('<strong class="font-semibold">bold</strong>')
    expect(html).toContain('<em class="italic">italic</em>')
  })

  it('keeps raw HTML escaped and sanitizes javascript links', () => {
    const content = ['[xss](javascript:alert(1))', '', '<script>alert("x")</script>'].join('\n')

    const html = renderToStaticMarkup(createElement(MarkdownMessage, { content }))

    expect(html).not.toContain('href="javascript:alert(1)"')
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
  })

  it('renders artifact links as clickable artifact cards when callback is provided', () => {
    const content = '[artifact:/Users/example/worktrees/swarm/README.md]'

    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content,
        onArtifactClick: () => {},
      }),
    )

    expect(html).toContain('data-artifact-card="true"')
    expect(html).toContain('README.md')
    expect(html).toContain('/Users/example/worktrees/swarm/README.md')
  })
})
