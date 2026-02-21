import { useMemo } from 'react'
import {
  Code2,
  Database,
  FileCode2,
  FileText,
  Image,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { ArtifactReference } from '@/lib/artifacts'
import {
  categorizeArtifact,
  type ArtifactCategory,
} from '@/lib/collect-artifacts'
import { cn } from '@/lib/utils'

interface ArtifactsSidebarProps {
  artifacts: ArtifactReference[]
  isOpen: boolean
  onClose: () => void
  onArtifactClick: (artifact: ArtifactReference) => void
}

interface GroupedArtifacts {
  label: string
  category: ArtifactCategory
  items: ArtifactReference[]
}

const CATEGORY_ORDER: ArtifactCategory[] = ['document', 'code', 'data', 'image', 'other']

const CATEGORY_LABELS: Record<ArtifactCategory, string> = {
  document: 'Documents',
  code: 'Code',
  data: 'Data',
  image: 'Images',
  other: 'Other',
}

function getCategoryIcon(category: ArtifactCategory) {
  switch (category) {
    case 'document':
      return FileText
    case 'code':
      return Code2
    case 'data':
      return Database
    case 'image':
      return Image
    case 'other':
      return FileCode2
  }
}

function getFileIcon(fileName: string) {
  const category = categorizeArtifact(fileName)
  return getCategoryIcon(category)
}

function groupArtifacts(artifacts: ArtifactReference[]): GroupedArtifacts[] {
  const groups = new Map<ArtifactCategory, ArtifactReference[]>()

  for (const artifact of artifacts) {
    const category = categorizeArtifact(artifact.fileName)
    const existing = groups.get(category)
    if (existing) {
      existing.push(artifact)
    } else {
      groups.set(category, [artifact])
    }
  }

  return CATEGORY_ORDER
    .filter((cat) => groups.has(cat))
    .map((cat) => ({
      label: CATEGORY_LABELS[cat],
      category: cat,
      items: groups.get(cat)!,
    }))
}

function truncatePath(path: string, maxLength = 40): string {
  if (path.length <= maxLength) return path
  const segments = path.split('/')
  if (segments.length <= 3) return path

  const fileName = segments[segments.length - 1]
  const remaining = maxLength - fileName.length - 4 // account for .../
  if (remaining <= 0) return `…/${fileName}`

  let prefix = ''
  for (const seg of segments.slice(0, -1)) {
    if ((prefix + seg + '/').length > remaining) break
    prefix += `${seg}/`
  }

  return prefix ? `${prefix}…/${fileName}` : `…/${fileName}`
}

export function ArtifactsSidebar({
  artifacts,
  isOpen,
  onClose,
  onArtifactClick,
}: ArtifactsSidebarProps) {
  const grouped = useMemo(() => groupArtifacts(artifacts), [artifacts])
  const hasMultipleGroups = grouped.length > 1

  return (
    <div
      className={cn(
        'flex h-full shrink-0 flex-col border-l border-border/80 bg-card/50',
        'transition-[width,opacity] duration-200 ease-out',
        isOpen ? 'w-[300px] opacity-100' : 'w-0 opacity-0 overflow-hidden',
      )}
      aria-label="Artifacts panel"
      aria-hidden={!isOpen}
    >
      {/* Header */}
      <div className="flex h-[62px] shrink-0 items-center justify-between gap-2 border-b border-border/80 px-3">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-xs font-semibold text-foreground truncate">
            Artifacts
          </h2>
          {artifacts.length > 0 && (
            <span className="inline-flex items-center justify-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {artifacts.length}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
          onClick={onClose}
          aria-label="Close artifacts panel"
        >
          <X className="size-3.5" />
        </Button>
      </div>

      {/* Content */}
      <ScrollArea
        className={cn(
          'min-h-0 flex-1',
          '[&>[data-slot=scroll-area-scrollbar]]:w-1.5',
          '[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-transparent',
          'hover:[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-border',
        )}
      >
        {artifacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
            <FileText className="mb-2 size-8 text-muted-foreground/40" aria-hidden="true" />
            <p className="text-xs text-muted-foreground">
              No artifacts yet
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground/70">
              Files and links from the conversation will appear here.
            </p>
          </div>
        ) : (
          <div className="p-2">
            {grouped.map((group) => {
              const GroupIcon = getCategoryIcon(group.category)
              return (
                <div key={group.category} className="mb-1 last:mb-0">
                  {hasMultipleGroups && (
                    <div className="flex items-center gap-1.5 px-2 pb-1 pt-2">
                      <GroupIcon className="size-3 text-muted-foreground/70" aria-hidden="true" />
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                        {group.label}
                      </span>
                    </div>
                  )}
                  <div className="space-y-0.5">
                    {group.items.map((artifact) => (
                      <ArtifactRow
                        key={artifact.path}
                        artifact={artifact}
                        onClick={onArtifactClick}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

function ArtifactRow({
  artifact,
  onClick,
}: {
  artifact: ArtifactReference
  onClick: (artifact: ArtifactReference) => void
}) {
  const FileIcon = getFileIcon(artifact.fileName)
  const truncatedPath = truncatePath(artifact.path)

  return (
    <button
      type="button"
      className={cn(
        'group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
        'transition-colors duration-100',
        'hover:bg-accent/70',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60',
      )}
      onClick={() => onClick(artifact)}
      title={artifact.path}
    >
      <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
        <FileIcon className="size-3.5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">
          {artifact.fileName}
        </span>
        <span className="block truncate font-mono text-[10px] text-muted-foreground/70">
          {truncatedPath}
        </span>
      </span>
    </button>
  )
}
