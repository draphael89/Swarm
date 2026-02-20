import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Loader2, X } from 'lucide-react'
import type { ArtifactReference } from '@/lib/artifacts'
import { toVscodeInsidersHref } from '@/lib/artifacts'
import { cn } from '@/lib/utils'
import { MarkdownMessage } from './MarkdownMessage'

interface ArtifactPanelProps {
  artifact: ArtifactReference | null
  wsUrl: string
  onClose: () => void
  onArtifactClick?: (artifact: ArtifactReference) => void
}

interface ReadFileResult {
  path: string
  content: string
}

const MARKDOWN_FILE_PATTERN = /\.(md|markdown|mdx)$/i

export function ArtifactPanel({ artifact, wsUrl, onClose, onArtifactClick }: ArtifactPanelProps) {
  const [isVisible, setIsVisible] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [resolvedPath, setResolvedPath] = useState<string | null>(null)

  const artifactPath = artifact?.path ?? null

  useEffect(() => {
    if (!artifactPath) {
      setIsVisible(false)
      return
    }

    setIsVisible(false)
    const frame = window.requestAnimationFrame(() => {
      setIsVisible(true)
    })

    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [artifactPath])

  useEffect(() => {
    if (!artifactPath) {
      setContent('')
      setResolvedPath(null)
      setError(null)
      setIsLoading(false)
      return
    }

    const abortController = new AbortController()

    setIsLoading(true)
    setError(null)
    setContent('')
    setResolvedPath(null)

    void (async () => {
      try {
        const file = await readArtifactFile({
          wsUrl,
          path: artifactPath,
          signal: abortController.signal,
        })

        if (abortController.signal.aborted) {
          return
        }

        setContent(file.content)
        setResolvedPath(file.path)
        setError(null)
      } catch (readError) {
        if (abortController.signal.aborted) {
          return
        }

        setError(readError instanceof Error ? readError.message : 'Failed to read file.')
      } finally {
        if (!abortController.signal.aborted) {
          setIsLoading(false)
        }
      }
    })()

    return () => {
      abortController.abort()
    }
  }, [artifactPath, wsUrl])

  useEffect(() => {
    if (!artifactPath) {
      return
    }

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeydown)
    return () => {
      window.removeEventListener('keydown', handleKeydown)
    }
  }, [artifactPath, onClose])

  const displayPath = resolvedPath ?? artifactPath ?? ''
  const isMarkdown = useMemo(() => MARKDOWN_FILE_PATTERN.test(displayPath), [displayPath])

  if (!artifact) {
    return null
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Artifact: ${artifact.fileName}`}>
      <button
        type="button"
        className="flex-1 bg-background/55 backdrop-blur-[1px]"
        aria-label="Close artifact panel"
        onClick={onClose}
      />

      <aside
        className={cn(
          'relative h-full w-full max-w-[min(920px,92vw)] border-l border-border bg-background shadow-2xl',
          'transition-transform duration-200 ease-out',
          isVisible ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 space-y-0.5">
            <h2 className="truncate text-sm font-semibold text-foreground">{artifact.fileName}</h2>
            <p className="truncate text-xs text-muted-foreground">{displayPath}</p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <a
              href={toVscodeInsidersHref(displayPath || artifact.path)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
            >
              <ExternalLink className="size-3" aria-hidden="true" />
              VS Code
            </a>

            <button
              type="button"
              className="inline-flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted"
              onClick={onClose}
              aria-label="Close artifact panel"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div
          className={cn(
            'h-[calc(100%-61px)] overflow-y-auto px-4 py-4',
            '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent',
            '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/70',
          )}
        >
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              <span>Loading file…</span>
            </div>
          ) : error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : isMarkdown ? (
            <article className="mx-auto max-w-3xl">
              <MarkdownMessage
                content={content}
                variant="document"
                enableMermaid
                onArtifactClick={onArtifactClick}
              />
            </article>
          ) : (
            <pre className="overflow-x-auto rounded-md border border-border/70 bg-muted/30 p-3">
              <code className="font-mono text-[13px] leading-relaxed whitespace-pre">{content}</code>
            </pre>
          )}
        </div>
      </aside>
    </div>
  )
}

async function readArtifactFile({
  wsUrl,
  path,
  signal,
}: {
  wsUrl: string
  path: string
  signal: AbortSignal
}): Promise<ReadFileResult> {
  const endpoint = resolveReadFileEndpoint(wsUrl)

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path }),
    signal,
  })

  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && typeof payload.error === 'string'
        ? payload.error
        : `File read failed (${response.status})`

    throw new Error(message)
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid file read response.')
  }

  const resolvedPath = typeof payload.path === 'string' ? payload.path : path
  const content = typeof payload.content === 'string' ? payload.content : ''

  return {
    path: resolvedPath,
    content,
  }
}

function resolveReadFileEndpoint(wsUrl: string): string {
  try {
    const parsed = new URL(wsUrl)
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    parsed.pathname = '/api/read-file'
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return '/api/read-file'
  }
}
