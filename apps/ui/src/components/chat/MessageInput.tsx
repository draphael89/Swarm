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
import { AttachedFiles } from '@/components/chat/AttachedFiles'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  fileToPendingAttachment,
  type PendingAttachment,
} from '@/lib/file-attachments'
import { cn } from '@/lib/utils'
import type { ConversationAttachment } from '@/lib/ws-types'

const TEXTAREA_MAX_HEIGHT = 186

interface MessageInputProps {
  onSend: (message: string, attachments?: ConversationAttachment[]) => void
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
  const [attachedFiles, setAttachedFiles] = useState<PendingAttachment[]>([])
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    // Temporarily hide overflow so scrollbar gutter doesn't affect scrollHeight
    textarea.style.overflowY = 'hidden'
    textarea.style.height = 'auto'
    const nextHeight = Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT)
    textarea.style.height = `${nextHeight}px`
    // Only enable scrolling when content actually exceeds max height
    textarea.style.overflowY = textarea.scrollHeight > TEXTAREA_MAX_HEIGHT ? 'auto' : 'hidden'
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

      const uploaded = await Promise.all(files.map(fileToPendingAttachment))
      const nextAttachments = uploaded.filter((attachment): attachment is PendingAttachment => attachment !== null)

      if (nextAttachments.length === 0) {
        return
      }

      setAttachedFiles((previous) => [...previous, ...nextAttachments])
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
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)

    if (files.length === 0) return

    event.preventDefault()
    await addFiles(files)
  }

  const removeAttachment = (attachmentId: string) => {
    setAttachedFiles((previous) => previous.filter((attachment) => attachment.id !== attachmentId))
  }

  const submitMessage = useCallback(() => {
    const trimmed = input.trim()
    const hasContent = trimmed.length > 0 || attachedFiles.length > 0
    if (!hasContent || disabled || blockedByLoading) {
      return
    }

    onSend(
      trimmed,
      attachedFiles.length > 0
        ? attachedFiles.map((attachment) => {
            if (attachment.type === 'text') {
              return {
                type: 'text' as const,
                mimeType: attachment.mimeType,
                text: attachment.text,
                fileName: attachment.fileName,
              }
            }

            if (attachment.type === 'binary') {
              return {
                type: 'binary' as const,
                mimeType: attachment.mimeType,
                data: attachment.data,
                fileName: attachment.fileName,
              }
            }

            return {
              mimeType: attachment.mimeType,
              data: attachment.data,
              fileName: attachment.fileName,
            }
          })
        : undefined,
    )

    setInput('')
    setAttachedFiles([])
  }, [attachedFiles, blockedByLoading, disabled, input, onSend])

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

  const hasContent = input.trim().length > 0 || attachedFiles.length > 0
  const canSubmit = hasContent && !disabled && !blockedByLoading
  const placeholder = disabled
    ? 'Waiting for connection...'
    : allowWhileLoading && isLoading
      ? `Send another message to ${agentLabel}...`
      : `Message ${agentLabel}...`

  return (
    <form onSubmit={handleSubmit} className="sticky bottom-0 shrink-0 bg-background p-3">
      <div className="overflow-hidden rounded-2xl border border-border">
        <AttachedFiles attachments={attachedFiles} onRemove={removeAttachment} />

        <div className="group flex flex-col">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className={cn(
              'w-full resize-none border-0 bg-transparent text-sm leading-normal text-foreground shadow-none focus:outline-none',
              'min-h-[44px]',
              'px-4 pt-3 pb-2',
              '[&::-webkit-scrollbar]:w-1.5',
              '[&::-webkit-scrollbar-track]:bg-transparent',
              '[&::-webkit-scrollbar-thumb]:bg-transparent',
              '[&::-webkit-scrollbar-thumb]:rounded-full',
              'group-hover:[&::-webkit-scrollbar-thumb]:bg-border',
            )}
          />

          <Input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
            aria-label="Attach files"
          />

          <div className="flex items-center justify-between px-1.5 pb-1.5 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 rounded-full text-muted-foreground/60 hover:text-foreground"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              aria-label="Attach files"
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
