import { load, dump } from 'js-yaml'
import type { BossBrainFrontmatter } from '@/types/note'

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
  const body = trimmed.slice(match[0].length)

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
