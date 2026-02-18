import type { ConversationImageAttachment } from './ws-types'

export interface PendingImageAttachment extends ConversationImageAttachment {
  id: string
  fileName: string
  dataUrl: string
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

export async function fileToPendingImageAttachment(file: File): Promise<PendingImageAttachment | null> {
  if (!isImageFile(file)) {
    return null
  }

  const dataUrl = await readFileAsDataUrl(file)
  const base64Data = extractBase64FromDataUrl(dataUrl)
  if (!base64Data) {
    return null
  }

  return {
    id: createAttachmentId(),
    mimeType: file.type || 'image/png',
    fileName: file.name || 'image',
    data: base64Data,
    dataUrl,
  }
}

function createAttachmentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('Failed to read image attachment.'))
    reader.readAsDataURL(file)
  })
}

function extractBase64FromDataUrl(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/)
  if (!match) {
    return null
  }

  return match[1] ?? null
}
