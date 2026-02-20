import { memo, useEffect, useId, useMemo, useState } from 'react'
import { AlertCircle, Eye, FileText } from 'lucide-react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  normalizeArtifactShortcodes,
  parseArtifactReference,
  type ArtifactReference,
} from '@/lib/artifacts'
import { cn } from '@/lib/utils'

const EXTRA_ALLOWED_PROTOCOLS = /^(vscode-insiders|vscode|swarm-file):\/\//i

let mermaidInitialized = false

function urlTransform(url: string): string {
  if (EXTRA_ALLOWED_PROTOCOLS.test(url)) return url
  return defaultUrlTransform(url)
}

interface MarkdownMessageProps {
  content: string
  variant?: 'message' | 'document'
  onArtifactClick?: (artifact: ArtifactReference) => void
  enableMermaid?: boolean
}

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  variant = 'message',
  onArtifactClick,
  enableMermaid = false,
}: MarkdownMessageProps) {
  const isDocument = variant === 'document'
  const normalizedContent = useMemo(() => normalizeArtifactShortcodes(content), [content])

  return (
    <div className={cn(isDocument ? 'text-[15px] leading-7' : 'text-sm leading-relaxed')}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
        components={{
          p({ children }) {
            return (
              <p
                className={cn(
                  isDocument
                    ? 'mb-4 last:mb-0 break-words whitespace-pre-wrap'
                    : 'mb-2 last:mb-0 break-words whitespace-pre-wrap',
                )}
              >
                {children}
              </p>
            )
          },
          h1({ children }) {
            return (
              <h1
                className={cn(
                  isDocument ? 'mb-4 text-3xl font-semibold tracking-tight' : 'mb-2 text-base font-semibold',
                )}
              >
                {children}
              </h1>
            )
          },
          h2({ children }) {
            return (
              <h2
                className={cn(
                  isDocument ? 'mb-3 text-2xl font-semibold tracking-tight' : 'mb-2 text-[15px] font-semibold',
                )}
              >
                {children}
              </h2>
            )
          },
          h3({ children }) {
            return (
              <h3
                className={cn(
                  isDocument ? 'mb-2 text-xl font-semibold tracking-tight' : 'mb-2 text-sm font-semibold',
                )}
              >
                {children}
              </h3>
            )
          },
          ul({ children }) {
            return (
              <ul
                className={cn(
                  isDocument
                    ? 'mb-4 list-disc space-y-1 pl-6 last:mb-0'
                    : 'mb-2 list-disc space-y-0.5 pl-5 last:mb-0',
                )}
              >
                {children}
              </ul>
            )
          },
          ol({ children }) {
            return (
              <ol
                className={cn(
                  isDocument
                    ? 'mb-4 list-decimal space-y-1 pl-6 last:mb-0'
                    : 'mb-2 list-decimal space-y-0.5 pl-5 last:mb-0',
                )}
              >
                {children}
              </ol>
            )
          },
          li({ children }) {
            return <li className="break-words">{children}</li>
          },
          a({ children, href }) {
            const artifact = parseArtifactReference(href)
            if (artifact && onArtifactClick) {
              return <ArtifactReferenceCard artifact={artifact} onClick={onArtifactClick} />
            }

            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  isDocument
                    ? 'break-all text-primary underline underline-offset-2 hover:text-primary/80'
                    : 'break-all text-primary underline underline-offset-2',
                )}
              >
                {children}
              </a>
            )
          },
          code({ className, children }) {
            const contentValue = String(children)
            const language = resolveCodeLanguage(className)
            const hasLanguageClass = /language-/.test(className ?? '')
            const isBlock = hasLanguageClass || contentValue.includes('\n')

            if (isBlock) {
              const normalizedCode = contentValue.replace(/\n$/, '')

              if (enableMermaid && language === 'mermaid') {
                return <MermaidDiagram code={normalizedCode} />
              }

              return (
                <pre
                  className={cn(
                    isDocument
                      ? 'my-3 overflow-x-auto rounded-md border border-border/70 bg-muted/35 p-3'
                      : 'my-2 overflow-x-auto rounded-md border border-border/70 bg-muted/45 p-2',
                  )}
                >
                  <code className={cn(isDocument ? 'font-mono text-[13px] text-foreground' : 'font-mono text-xs text-foreground')}>
                    {normalizedCode}
                  </code>
                </pre>
              )
            }

            return (
              <code
                className={cn(
                  isDocument
                    ? 'rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[13px] text-foreground'
                    : 'rounded-sm bg-muted px-1 py-0.5 font-mono text-xs text-foreground',
                )}
              >
                {children}
              </code>
            )
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
        {normalizedContent}
      </ReactMarkdown>
    </div>
  )
})

function ArtifactReferenceCard({
  artifact,
  onClick,
}: {
  artifact: ArtifactReference
  onClick: (artifact: ArtifactReference) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(artifact)}
      className={cn(
        'my-2 flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors',
        'border-sky-500/35 bg-sky-500/10 hover:bg-sky-500/15',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40',
      )}
      data-artifact-card="true"
    >
      <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-sky-500/20 text-sky-700 dark:text-sky-200">
        <FileText className="size-3.5" aria-hidden="true" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-foreground">{artifact.fileName}</span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{artifact.path}</span>
      </span>

      <span className="inline-flex size-6 shrink-0 items-center justify-center rounded bg-sky-500/15 text-sky-700 dark:text-sky-200">
        <Eye className="size-3.5" aria-hidden="true" />
      </span>
    </button>
  )
}

function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const diagramId = useId().replace(/[:]/g, '-')

  useEffect(() => {
    let cancelled = false

    setSvg(null)
    setError(null)

    void (async () => {
      try {
        const module = await import('mermaid')
        const mermaidApi = module.default

        if (!mermaidInitialized) {
          mermaidApi.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: 'default',
          })
          mermaidInitialized = true
        }

        const renderId = `mermaid-${diagramId}-${Math.random().toString(16).slice(2, 8)}`
        const { svg: renderedSvg } = await mermaidApi.render(renderId, code)

        if (cancelled) {
          return
        }

        setSvg(renderedSvg)
      } catch (renderError) {
        if (cancelled) {
          return
        }

        setError(renderError instanceof Error ? renderError.message : 'Unable to render Mermaid diagram.')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [code, diagramId])

  return (
    <div className="my-3 overflow-auto rounded-md border border-border/70 bg-muted/20 p-3">
      {error ? (
        <div className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="size-3.5" />
          <span>Mermaid render error: {error}</span>
        </div>
      ) : svg ? (
        <div
          className="[&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <p className="text-xs text-muted-foreground">Rendering Mermaid diagram…</p>
      )}
    </div>
  )
}

function resolveCodeLanguage(className: string | undefined): string | null {
  if (!className) {
    return null
  }

  const token = className
    .split(/\s+/)
    .find((entry) => entry.trim().toLowerCase().startsWith('language-'))

  if (!token) {
    return null
  }

  return token.replace(/^language-/i, '').toLowerCase()
}
