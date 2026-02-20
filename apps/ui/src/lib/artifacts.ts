export interface ArtifactReference {
  path: string
  fileName: string
  href: string
}

const ARTIFACT_SHORTCODE_PATTERN = /\[artifact:([^\]\n]+)\]/gi
const SWARM_FILE_PREFIX = 'swarm-file://'
const VSCODE_FILE_LINK_PATTERN = /^vscode(?:-insiders)?:\/\/file\/+/i
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/

export function normalizeArtifactShortcodes(content: string): string {
  return content.replace(ARTIFACT_SHORTCODE_PATTERN, (match, rawPath) => {
    const normalizedPath = String(rawPath).trim()
    if (!normalizedPath) {
      return match
    }

    return `[artifact:${normalizedPath}](${toSwarmFileHref(normalizedPath)})`
  })
}

export function parseArtifactReference(href: string | undefined): ArtifactReference | null {
  if (!href) {
    return null
  }

  const trimmed = href.trim()
  if (!trimmed) {
    return null
  }

  const lowered = trimmed.toLowerCase()

  if (lowered.startsWith(SWARM_FILE_PREFIX)) {
    const rawPath = trimmed.slice(SWARM_FILE_PREFIX.length).split(/[?#]/, 1)[0]
    const decodedPath = safeDecodeURIComponent(rawPath)
    if (!decodedPath) {
      return null
    }

    return createArtifactReference(decodedPath, trimmed)
  }

  if (VSCODE_FILE_LINK_PATTERN.test(trimmed)) {
    const rawPath = trimmed.replace(VSCODE_FILE_LINK_PATTERN, '').split(/[?#]/, 1)[0]
    const decodedPath = safeDecodeURIComponent(rawPath)
    if (!decodedPath) {
      return null
    }

    const normalizedPath =
      decodedPath.startsWith('/') || WINDOWS_ABSOLUTE_PATH_PATTERN.test(decodedPath)
        ? decodedPath
        : `/${decodedPath}`

    return createArtifactReference(normalizedPath, trimmed)
  }

  return null
}

export function toSwarmFileHref(path: string): string {
  const normalizedPath = path.trim()
  if (!normalizedPath) {
    return SWARM_FILE_PREFIX
  }

  return `${SWARM_FILE_PREFIX}${encodeURI(normalizedPath)}`
}

export function toVscodeInsidersHref(path: string): string {
  const normalizedPath = path.trim()
  if (!normalizedPath) {
    return 'vscode-insiders://file'
  }

  const prefixedPath =
    normalizedPath.startsWith('/') || WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalizedPath)
      ? normalizedPath
      : `/${normalizedPath}`

  return `vscode-insiders://file${encodeURI(prefixedPath)}`
}

function createArtifactReference(path: string, href: string): ArtifactReference {
  const trimmedPath = path.trim()

  return {
    path: trimmedPath,
    fileName: fileNameFromPath(trimmedPath),
    href,
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function fileNameFromPath(path: string): string {
  const withoutTrailingSlash = path.replace(/[\\/]+$/, '')
  if (!withoutTrailingSlash) {
    return path
  }

  const segments = withoutTrailingSlash.split(/[\\/]/)
  return segments[segments.length - 1] || withoutTrailingSlash
}
