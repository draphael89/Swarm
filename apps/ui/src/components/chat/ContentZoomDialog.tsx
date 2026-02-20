import type { ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

interface ContentZoomDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: ReactNode
  contentClassName?: string
}

export function ContentZoomDialog({
  open,
  onOpenChange,
  title,
  children,
  contentClassName,
}: ContentZoomDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay
          className={cn(
            'fixed inset-0 z-[120] bg-black/85 backdrop-blur-[2px]',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
          )}
        />

        <DialogPrimitive.Content
          data-content-zoom-dialog="true"
          className={cn(
            'fixed left-1/2 top-1/2 z-[121] h-[min(92vh,1400px)] w-[min(95vw,1600px)]',
            '-translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-white/10',
            'bg-background/95 shadow-[0_16px_80px_rgba(0,0,0,0.6)] outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
          )}
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            onOpenChange(false)
          }}
        >
          <DialogTitle className="sr-only">{title}</DialogTitle>

          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                'absolute right-3 top-3 z-10 size-8 rounded-md',
                'bg-black/55 text-white/85 backdrop-blur-sm transition-colors',
                'hover:bg-black/70 hover:text-white',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60',
              )}
              aria-label="Close expanded preview"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </DialogClose>

          <ScrollArea className="h-full">
            <div className={cn('flex min-h-full items-center justify-center p-4 sm:p-8', contentClassName)}>
              {children}
            </div>
          </ScrollArea>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}
