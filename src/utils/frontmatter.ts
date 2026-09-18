import { load, dump } from 'js-yaml'
import type { BossBrainFrontmatter } from '@/types/note'
import { formatISO8601WithOffset } from './slug.ts'

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/**
 * Parses markdown file content and extracts YAML frontmatter and body.
 * Robust against empty, missing, or malformed frontmatter.
 */
export function extractFrontmatterAndBody(content: string): {
  frontmatter: Partial<BossBrainFrontmatter>
  body: string
  hasFrontmatter: boolean
} {
  const trimmed = content || ''
  const match = trimmed.match(FRONTMATTER_REGEX)

  if (!match) {
    return {
      frontmatter: {},
      body: trimmed,
      hasFrontmatter: false,
    }
  }

  const yamlText = match[1]
  const body = trimmed.slice(match[0].length).replace(/^\r?\n/, '')

  try {
    const parsed = load(yamlText)
    if (parsed && typeof parsed === 'object') {
      return {
        frontmatter: parsed as Partial<BossBrainFrontmatter>,
        body,
        hasFrontmatter: true,
      }
    }
  } catch (err) {
    console.warn('Failed to parse YAML frontmatter:', err)
  }

  return {
    frontmatter: {},
    body: trimmed,
    hasFrontmatter: false,
  }
}

/**
 * Extracts note title from markdown content (H1 or first non-empty line, max 50 chars).
 */
export function extractTitle(content: string): string {
  const firstLine = (content || '').trimStart().split('\n', 1)[0]?.trim() || ''
  if (firstLine.startsWith('#')) {
    return firstLine.replace(/^#+\s*/, '').substring(0, 50)
  }
  return firstLine.substring(0, 50) || 'Untitled'
}

/**
 * Builds canonical Boss Brain frontmatter with strict precedence (H2):
 * 1. Unknown / custom extended fields from existing frontmatter are preserved: ...(baseFm)
 * 2. Boss Brain canonical schema fields from active Note state are strictly authoritative:
 *    id, title, created, updated, type, status, project, tags, source, isPinned, isLocked, backgroundColor.
 */
export function buildCanonicalFrontmatter(
  note: {
    id: string
    title: string
    createdAt?: number | string
    updatedAt?: number | string
    type?: string
    status?: string
    project?: string
    tags?: string[]
    source?: string
    isPinned?: boolean
    isLocked?: boolean
    backgroundColor?: string
    frontmatter?: Record<string, any>
  },
  existingFrontmatter?: Record<string, any>
): BossBrainFrontmatter & Record<string, any> {
  const baseFm = existingFrontmatter || note.frontmatter || {}

  const createdDate =
    baseFm.created ||
    (note.createdAt ? formatISO8601WithOffset(new Date(note.createdAt)) : formatISO8601WithOffset(new Date()))
  const updatedDate = formatISO8601WithOffset(new Date(note.updatedAt || Date.now()))

  return {
    // 1. Unknown / custom extended frontmatter fields preserved
    ...baseFm,
    // 2. Boss Brain canonical fields: Note state is strictly authoritative
    id: note.id,
    title: note.title,
    created: createdDate,
    updated: updatedDate,
    type: note.type || baseFm.type || 'note',
    status: note.status || baseFm.status || 'inbox',
    project: note.project !== undefined ? note.project : (baseFm.project ?? ''),
    tags: note.tags !== undefined ? [...note.tags] : (baseFm.tags ? [...baseFm.tags] : []),
    source: note.source || baseFm.source || 'maiknote',
    isPinned: note.isPinned ?? false,
    isLocked: note.isLocked ?? false,
    backgroundColor: note.backgroundColor,
  }
}

/**
 * Formats frontmatter and markdown body into standard Markdown file content.
 */
export function stringifyWithFrontmatter(
  frontmatter: Record<string, any>,
  body: string
): string {
  const cleanFm: Record<string, any> = {}
  for (const [key, val] of Object.entries(frontmatter)) {
    if (val !== undefined && val !== null) {
      cleanFm[key] = val
    }
  }

  if (Object.keys(cleanFm).length === 0) {
    return body || ''
  }

  const yamlStr = dump(cleanFm, {
    lineWidth: -1,
    noRefs: true,
    forceQuotes: false,
  }).trim()

  const trimmedBody = body !== undefined ? body : ''
  return `---\n${yamlStr}\n---\n\n${trimmedBody}`
}
