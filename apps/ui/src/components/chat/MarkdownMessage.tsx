import { memo } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownMessageProps {
  content: string
}

export const MarkdownMessage = memo(function MarkdownMessage({ content }: MarkdownMessageProps) {
  return (
    <div className="text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={defaultUrlTransform}
        components={{
          p({ children }) {
            return <p className="mb-2 last:mb-0 break-words whitespace-pre-wrap">{children}</p>
          },
          ul({ children }) {
            return <ul className="mb-2 list-disc space-y-0.5 pl-5 last:mb-0">{children}</ul>
          },
          ol({ children }) {
            return <ol className="mb-2 list-decimal space-y-0.5 pl-5 last:mb-0">{children}</ol>
          },
          li({ children }) {
            return <li className="break-words">{children}</li>
          },
          a({ children, href }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-primary underline underline-offset-2"
              >
                {children}
              </a>
            )
          },
          code({ className, children }) {
            const contentValue = String(children)
            const hasLanguageClass = /language-/.test(className ?? '')
            const isBlock = hasLanguageClass || contentValue.includes('\n')

            if (isBlock) {
              return (
                <pre className="my-2 overflow-x-auto rounded-md border border-border/70 bg-muted/45 p-2">
                  <code className="font-mono text-xs text-foreground">{children}</code>
                </pre>
              )
            }

            return <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs text-foreground">{children}</code>
          },
          pre({ children }) {
            return <>{children}</>
          },
          strong({ children }) {
            return <strong className="font-semibold">{children}</strong>
          },
          em({ children }) {
            return <em className="italic">{children}</em>
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
