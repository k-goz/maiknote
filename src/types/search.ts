import type { Note } from './note'

export interface SearchResult {
  note: Note
  score?: number
  matchedFields?: string[]
}

export interface SearchProvider {
  name: string
  search(query: string, notes: Note[]): Promise<Note[]>
}
