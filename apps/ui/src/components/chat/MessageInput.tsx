import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { ArrowUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface MessageInputProps {
  onSend: (message: string) => void
  isLoading: boolean
  disabled?: boolean
  agentLabel?: string
  allowWhileLoading?: boolean
}

export interface MessageInputHandle {
  setInput: (value: string) => void
  focus: () => void
}

export const MessageInput = forwardRef<MessageInputHandle, MessageInputProps>(function MessageInput(
  { onSend, isLoading, disabled = false, agentLabel = 'agent', allowWhileLoading = false },
  ref,
) {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

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
    }),
    [],
  )

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const trimmed = input.trim()
      if (!trimmed || disabled || blockedByLoading) return

      onSend(trimmed)
      setInput('')
    },
    [blockedByLoading, disabled, input, onSend],
  )

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      const trimmed = input.trim()
      if (!trimmed || disabled || blockedByLoading) return
      onSend(trimmed)
      setInput('')
    }
  }

  const canSubmit = input.trim().length > 0 && !disabled && !blockedByLoading
  const placeholder = disabled
    ? 'Waiting for connection...'
    : allowWhileLoading && isLoading
      ? `Send another message to ${agentLabel}...`
      : `Message ${agentLabel}...`

  return (
    <form onSubmit={handleSubmit} className="sticky bottom-0 bg-background p-3">
      <div className="overflow-hidden rounded-2xl border border-border">
        <div className="group relative flex">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
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

          <div className="absolute bottom-1.5 right-1.5 z-10 flex items-center gap-1">
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
            >
              <ArrowUp className="size-3.5" strokeWidth={2.5} />
            </Button>
          </div>
        </div>
      </div>
    </form>
  )
})
