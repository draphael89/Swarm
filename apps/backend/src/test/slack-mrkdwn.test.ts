import { describe, expect, it } from 'vitest'
import { markdownToSlackMrkdwn } from '../integrations/slack/slack-mrkdwn.js'

describe('markdownToSlackMrkdwn', () => {
  it('converts markdown emphasis and links to Slack mrkdwn', () => {
    const output = markdownToSlackMrkdwn('Hello **world** [site](https://example.com)')

    expect(output).not.toContain('**world**')
    expect(output).toContain('*world*')
    expect(output).toContain('<https://example.com|site>')
  })

  it('strips HTML comments before conversion', () => {
    const output = markdownToSlackMrkdwn('Before\n<!-- hidden-note -->\nAfter')

    expect(output).not.toContain('hidden-note')
    expect(output).not.toContain('<!--')
  })

  it('normalizes code fences before conversion', () => {
    const output = markdownToSlackMrkdwn('~~~ts\nconst answer = 42\n~~~')

    expect(output).toBe('```\nconst answer = 42\n```')
  })

  it('collapses excessive newlines in output', () => {
    const output = markdownToSlackMrkdwn('```\na\n\n\n\n\nb\n```')

    expect(output).toBe('```\na\n\nb\n```')
  })
})
