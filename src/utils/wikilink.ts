import type { Note } from '@/types/note'

export interface ParsedWikilink {
  raw: string
  target: string
  heading?: string
  alias?: string
}

// Matches [[Target]], [[Target|Alias]], [[Target#Heading]], [[Target#Heading|Alias]]
const WIKILINK_REGEX = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g

/**
 * Extracts all wikilinks from markdown content.
 */
export function extractWikilinks(content: string): ParsedWikilink[] {
  if (!content) return []
  const links: ParsedWikilink[] = []
  const matches = content.matchAll(WIKILINK_REGEX)

  for (const m of matches) {
    links.push({
      raw: m[0],
      target: m[1].trim(),
      heading: m[2]?.trim(),
      alias: m[3]?.trim(),
    })
  }

  return links
}

/**
 * Normalizes text for lenient matching.
 */
function normalizeForMatch(str: string): string {
  return str.trim().toLowerCase().replace(/[-_\s]+/g, ' ')
}

/**
 * Resolves a wikilink target string to a Note from the pool.
 * Match order:
 * 1. Exact title match
 * 2. Case-insensitive title match
 * 3. Exact note id match
 * 4. Alias match (if defined in frontmatter)
 * 5. Filename / slug match
 */
export function resolveWikilinkTarget(target: string, notes: Note[]): Note | null {
  if (!target) return null
  const normTarget = normalizeForMatch(target)

  // 1 & 2: Match title
  const titleMatch = notes.find(n => normalizeForMatch(n.title) === normTarget)
  if (titleMatch) return titleMatch

  // 3: Match id
  const idMatch = notes.find(n => n.id === target || normalizeForMatch(n.id) === normTarget)
  if (idMatch) return idMatch

  // 4: Match alias in frontmatter
  const aliasMatch = notes.find(n => {
    const aliases = n.frontmatter?.aliases
    if (Array.isArray(aliases)) {
      return aliases.some(a => typeof a === 'string' && normalizeForMatch(a) === normTarget)
    }
    return false
  })
  if (aliasMatch) return aliasMatch

  // 5: Match relativePath or filename without .md
  const fileMatch = notes.find(n => {
    if (!n.relativePath) return false
    const base = n.relativePath.split('/').pop()?.replace(/\.md$/i, '') || ''
    return normalizeForMatch(base) === normTarget || normalizeForMatch(base).includes(normTarget)
  })
  if (fileMatch) return fileMatch

  return null
}

/**
 * Computes backlink map for all notes in the vault.
 * Returns Map<targetNoteId, sourceNoteIds[]>
 */
export function computeBacklinks(notes: Note[]): Map<string, string[]> {
  const backlinksMap = new Map<string, Set<string>>()

  for (const note of notes) {
    if (!backlinksMap.has(note.id)) {
      backlinksMap.set(note.id, new Set())
    }
  }

  for (const note of notes) {
    const links = extractWikilinks(note.content)
    for (const link of links) {
      const targetNote = resolveWikilinkTarget(link.target, notes)
      if (targetNote && targetNote.id !== note.id) {
        if (!backlinksMap.has(targetNote.id)) {
          backlinksMap.set(targetNote.id, new Set())
        }
        backlinksMap.get(targetNote.id)!.add(note.id)
      }
    }
  }

  const result = new Map<string, string[]>()
  for (const [id, set] of backlinksMap.entries()) {
    result.set(id, Array.from(set))
  }

  return result
}
