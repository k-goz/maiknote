/**
 * Note data model
 */
export interface Note {
  id: string // UUID, also used as filename e.g. "note_uuid.md"
  title: string // Auto-extracted from first line, max 50 chars
  content: string // Markdown content
  createdAt: number // Unix timestamp
  updatedAt: number // Unix timestamp
  tags?: string[] // Optional tags
  isPinned: boolean // Whether the note is pinned
  isLocked: boolean // Whether the note is locked (cannot edit or delete)
  directoryId?: string // null/undefined = root directory
  backgroundColor?: string // Optional background color for the note
  trashedAt?: number // Unix timestamp when moved to trash
  // Boss Brain V1 fields
  relativePath?: string // e.g. "00-Inbox/2026-09-17-2342-healthtwin-home-cta-a82c.md"
  status?: string // 'inbox' | 'active' | 'archived' | string
  type?: string // 'note' | 'project' | 'area' | 'decision' | string
  project?: string // Associated project
  source?: string // Default 'maiknote'
  frontmatter?: BossBrainFrontmatter // Parsed frontmatter
  wikilinks?: string[] // Extracted wikilinks e.g. ["HealthTwin", "Roadmap"]
  backlinks?: string[] // Notes referencing this note
  mtime?: number // Disk modification timestamp
  isDirty?: boolean // Has unpersisted local changes
  hasConflict?: boolean // External change detected while local note is dirty
  conflictContent?: string // Disk content when conflict occurred
  conflictType?: 'modified' | 'deleted' // Nature of the external conflict
  diskState?: 'normal' | 'missing' // Whether disk file exists or was deleted/moved
}

export interface BossBrainFrontmatter {
  id: string
  title: string
  created: string // ISO 8601
  updated: string // ISO 8601
  type?: string
  status?: string
  project?: string
  tags?: string[]
  source?: string
  aliases?: string[]
  supersedes?: string
  superseded_by?: string
  [key: string]: any
}

/**
 * Metadata structure for storing note index
 */
export interface NoteMetadata {
  version: number
  notes: NoteMetadataItem[]
}

export interface NoteMetadataItem {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  tags?: string[]
  isPinned: boolean
  isLocked: boolean
  directoryId?: string
  backgroundColor?: string
  trashedAt?: number
}

/**
 * Directory structure for organizing notes
 */
export interface Directory {
  id: string
  name: string
  parentId: string | null // null = root level
  createdAt: number
  updatedAt: number
}

export interface DirectoryData {
  version: number
  directories: Directory[]
}
