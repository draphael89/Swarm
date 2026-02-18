import { X } from 'lucide-react'
import type { PendingImageAttachment } from '@/lib/image-attachments'

interface AttachedImagesProps {
  attachments: PendingImageAttachment[]
  onRemove: (id: string) => void
}

export function AttachedImages({ attachments, onRemove }: AttachedImagesProps) {
  if (attachments.length === 0) {
    return null
  }

  return (
    <div className="flex flex-wrap gap-2 border-b border-border px-4 py-2">
      {attachments.map((attachment) => (
        <div key={attachment.id} className="group relative">
          <img
            src={attachment.dataUrl}
            alt={attachment.fileName || 'Attached image'}
            className="size-16 rounded border border-border object-cover"
          />
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            className="absolute -right-1.5 -top-1.5 rounded-full bg-muted p-0.5 text-muted-foreground opacity-0 transition-colors hover:bg-red-600 hover:text-white focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-red-300 group-hover:opacity-100"
            aria-label={`Remove ${attachment.fileName || 'attachment'}`}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
