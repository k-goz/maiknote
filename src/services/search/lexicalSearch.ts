import type { Note } from '@/types/note'
import type { SearchProvider } from '@/types/search'

export class LexicalSearchProvider implements SearchProvider {
  name = 'lexical'

  async search(query: string, notes: Note[]): Promise<Note[]> {
    if (!query || !query.trim()) {
      return notes
    }

    const q = query.trim().toLowerCase()
    const terms = q.split(/\s+/).filter(Boolean)

    return notes.filter((note) => {
      const title = (note.title || '').toLowerCase()
      const content = (note.content || '').toLowerCase()
      const project = (note.project || '').toLowerCase()
      const path = (note.relativePath || '').toLowerCase()
      const tags = (note.tags || []).map(t => t.toLowerCase())
      const aliases = Array.isArray(note.frontmatter?.aliases)
        ? note.frontmatter.aliases.map((a: any) => String(a).toLowerCase())
        : []

      // Every term must match at least one field
      return terms.every((term) => {
        return (
          title.includes(term) ||
          content.includes(term) ||
          project.includes(term) ||
          path.includes(term) ||
          tags.some(t => t.includes(term)) ||
          aliases.some((a: string) => a.includes(term))
        )
      })
    })
  }
}

export const defaultSearchProvider = new LexicalSearchProvider()
