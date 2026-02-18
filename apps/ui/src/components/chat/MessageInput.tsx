import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { ArrowUp, Paperclip } from 'lucide-react'
import { AttachedImages } from '@/components/chat/AttachedImages'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { fileToPendingImageAttachment, isImageFile, type PendingImageAttachment } from '@/lib/image-attachments'
import type { ConversationImageAttachment } from '@/lib/ws-types'

interface MessageInputProps {
  onSend: (message: string, attachments?: ConversationImageAttachment[]) => void
  isLoading: boolean
  disabled?: boolean
  agentLabel?: string
  allowWhileLoading?: boolean
}

export interface MessageInputHandle {
  setInput: (value: string) => void
  focus: () => void
  addFiles: (files: File[]) => Promise<void>
}

export const MessageInput = forwardRef<MessageInputHandle, MessageInputProps>(function MessageInput(
  { onSend, isLoading, disabled = false, agentLabel = 'agent', allowWhileLoading = false },
  ref,
) {
  const [input, setInput] = useState('')
  const [attachedImages, setAttachedImages] = useState<PendingImageAttachment[]>([])
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`
  }, [])

  const blockedByLoading = isLoading && !allowWhileLoading

  useEffect(() => {
    resizeTextarea()
  }, [input, resizeTextarea])

  useEffect(() => {
    if (!disabled && !blockedByLoading) {
      textareaRef.current?.focus()
    }
  }, [blockedByLoading, disabled])

  const addFiles = useCallback(
    async (files: File[]) => {
      if (disabled || files.length === 0) return

      const imageFiles = files.filter(isImageFile)
      if (imageFiles.length === 0) {
        return
      }

      const uploaded = await Promise.all(imageFiles.map(fileToPendingImageAttachment))
      const nextAttachments = uploaded.filter((attachment): attachment is PendingImageAttachment => attachment !== null)

      if (nextAttachments.length === 0) {
        return
      }

      setAttachedImages((previous) => [...previous, ...nextAttachments])
    },
    [disabled],
  )

  useImperativeHandle(
    ref,
    () => ({
      setInput: (value: string) => {
        setInput(value)
        requestAnimationFrame(() => textareaRef.current?.focus())
      },
      focus: () => {
        textareaRef.current?.focus()
      },
      addFiles,
    }),
    [addFiles],
  )

  const handleFileSelect = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    await addFiles(files)
    event.target.value = ''
  }

  const handlePaste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)

    if (files.length === 0) return

    event.preventDefault()
    await addFiles(files)
  }

  const removeAttachment = (attachmentId: string) => {
    setAttachedImages((previous) => previous.filter((attachment) => attachment.id !== attachmentId))
  }

  const submitMessage = useCallback(() => {
    const trimmed = input.trim()
    const hasContent = trimmed.length > 0 || attachedImages.length > 0
    if (!hasContent || disabled || blockedByLoading) {
      return
    }

    onSend(
      trimmed,
      attachedImages.length > 0
        ? attachedImages.map((attachment) => ({
            mimeType: attachment.mimeType,
            data: attachment.data,
            fileName: attachment.fileName,
          }))
        : undefined,
    )

    setInput('')
    setAttachedImages([])
  }, [attachedImages, blockedByLoading, disabled, input, onSend])

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      submitMessage()
    },
    [submitMessage],
  )

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submitMessage()
    }
  }

  const hasContent = input.trim().length > 0 || attachedImages.length > 0
  const canSubmit = hasContent && !disabled && !blockedByLoading
  const placeholder = disabled
    ? 'Waiting for connection...'
    : allowWhileLoading && isLoading
      ? `Send another message to ${agentLabel}...`
      : `Message ${agentLabel}...`

  return (
    <form onSubmit={handleSubmit} className="sticky bottom-0 bg-background p-3">
      <div className="overflow-hidden rounded-2xl border border-border">
        <AttachedImages attachments={attachedImages} onRemove={removeAttachment} />

        <div className="group relative flex">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className={cn(
              'flex-1 resize-none border-0 bg-transparent text-sm text-foreground shadow-none focus:outline-none',
              'min-h-[68px] max-h-[220px]',
              'px-4 pt-3 pb-11',
              '[&::-webkit-scrollbar]:w-1.5',
              '[&::-webkit-scrollbar-track]:bg-transparent',
              '[&::-webkit-scrollbar-thumb]:bg-transparent',
              '[&::-webkit-scrollbar-thumb]:rounded-full',
              'group-hover:[&::-webkit-scrollbar-thumb]:bg-border',
            )}
          />

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleFileSelect}
            aria-label="Attach images"
          />

          <div className="absolute bottom-1.5 left-1.5 right-1.5 z-10 flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 rounded-full text-muted-foreground/60 hover:text-foreground"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              aria-label="Attach images"
            >
              <Paperclip className="size-3.5" />
            </Button>

            <Button
              type="submit"
              disabled={!canSubmit}
              size="icon"
              className={cn(
                'size-7 rounded-full transition-all',
                canSubmit
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95'
                  : 'cursor-default bg-muted text-muted-foreground/40',
              )}
              aria-label="Send message"
            >
              <ArrowUp className="size-3.5" strokeWidth={2.5} />
            </Button>
          </div>
        </div>
      </div>
    </form>
  )
})
