import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, FileCode2, FileText, Loader2, X } from 'lucide-react'
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
  const [isClosing, setIsClosing] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [resolvedPath, setResolvedPath] = useState<string | null>(null)
  const closingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const artifactPath = artifact?.path ?? null

  useEffect(() => {
    if (!artifactPath) {
      setIsVisible(false)
      setIsClosing(false)
      return
    }

    setIsClosing(false)
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
      if (event.key !== 'Escape') {
        return
      }

      if (event.defaultPrevented) {
        return
      }

      if (document.querySelector('[data-content-zoom-dialog="true"]')) {
        return
      }

      handleAnimatedClose()
    }

    window.addEventListener('keydown', handleKeydown)
    return () => {
      window.removeEventListener('keydown', handleKeydown)
    }
  }, [artifactPath, onClose])

  useEffect(() => {
    return () => {
      if (closingTimerRef.current) {
        clearTimeout(closingTimerRef.current)
      }
    }
  }, [])

  const handleAnimatedClose = () => {
    setIsClosing(true)
    setIsVisible(false)
    if (closingTimerRef.current) {
      clearTimeout(closingTimerRef.current)
    }
    closingTimerRef.current = setTimeout(() => {
      setIsClosing(false)
      onClose()
    }, 260)
  }

  const displayPath = resolvedPath ?? artifactPath ?? ''
  const isMarkdown = useMemo(() => MARKDOWN_FILE_PATTERN.test(displayPath), [displayPath])

  if (!artifact && !isClosing) {
    return null
  }

  const FileIcon = isMarkdown ? FileText : FileCode2

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex justify-end',
        'transition-[backdrop-filter,background-color] duration-300 ease-out',
        isVisible
          ? 'bg-background/60 backdrop-blur-[2px]'
          : 'pointer-events-none bg-transparent backdrop-blur-0',
        isClosing && !isVisible && 'pointer-events-none',
      )}
      role="dialog"
      aria-modal="true"
      aria-label={artifact ? `Artifact: ${artifact.fileName}` : 'Artifact panel'}
    >
      <button
        type="button"
        className="flex-1"
        aria-label="Close artifact panel"
        onClick={handleAnimatedClose}
        tabIndex={isVisible ? 0 : -1}
      />

      <aside
        className={cn(
          'relative flex h-full w-full max-w-[min(880px,90vw)] flex-col',
          'border-l border-border/80 bg-background',
          'shadow-[-8px_0_32px_-4px_rgba(0,0,0,0.12)]',
          'transition-all duration-[260ms] ease-[cubic-bezier(0.32,0.72,0,1)]',
          isVisible
            ? 'translate-x-0 opacity-100'
            : 'translate-x-[40%] opacity-0',
        )}
      >
        {/* Header */}
        <header className="flex h-[62px] shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-card/80 px-5 backdrop-blur">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileIcon className="size-3.5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-bold text-foreground">{artifact?.fileName}</h2>
              <p className="truncate font-mono text-[11px] text-muted-foreground">{displayPath}</p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <a
              href={toVscodeInsidersHref(displayPath || artifact?.path || '')}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium',
                'text-muted-foreground transition-colors',
                'hover:bg-muted hover:text-foreground',
              )}
            >
              <ExternalLink className="size-3" aria-hidden="true" />
              <span className="hidden sm:inline">Open in VS Code</span>
              <span className="sm:hidden">VS Code</span>
            </a>

            <div className="mx-0.5 h-4 w-px bg-border/60" aria-hidden="true" />

            <button
              type="button"
              className={cn(
                'inline-flex size-8 items-center justify-center rounded-md',
                'text-muted-foreground transition-colors',
                'hover:bg-muted hover:text-foreground',
              )}
              onClick={handleAnimatedClose}
              aria-label="Close artifact panel"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        {/* Content */}
        <div
          className={cn(
            'min-h-0 flex-1 overflow-y-auto',
            '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent',
            '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent',
            '[scrollbar-width:thin] [scrollbar-color:transparent_transparent]',
            'hover:[&::-webkit-scrollbar-thumb]:bg-border hover:[scrollbar-color:var(--color-border)_transparent]',
          )}
        >
          <div className="px-6 py-6">
            {isLoading ? (
              <div className="flex items-center gap-2.5 py-12 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                <span>Loading file…</span>
              </div>
            ) : error ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            ) : isMarkdown ? (
              <article className="mx-auto max-w-[680px]">
                <MarkdownMessage
                  content={content}
                  variant="document"
                  enableMermaid
                  onArtifactClick={onArtifactClick}
                />
              </article>
            ) : (
              <pre className="overflow-x-auto rounded-lg border border-border/60 bg-muted/25 p-4">
                <code className="font-mono text-[13px] leading-relaxed whitespace-pre text-foreground/90">{content}</code>
              </pre>
            )}
          </div>
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
