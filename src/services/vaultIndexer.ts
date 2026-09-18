import { useFileSystem } from '@/composables/useFileSystem'
import type { Note, BossBrainFrontmatter } from '@/types/note'
import { extractFrontmatterAndBody } from '@/utils/frontmatter'
import { extractWikilinks, computeBacklinks } from '@/utils/wikilink'
import { generateIndexMarkdown } from './vaultManager'

export interface VaultIndexCacheItem {
  id: string
  title: string
  relativePath: string
  mtime: number
  size: number
  createdAt: number
  updatedAt: number
  tags: string[]
  type: string
  status: string
  project?: string
  frontmatter: Partial<BossBrainFrontmatter>
  wikilinks: string[]
  backlinks: string[]
  isPinned?: boolean
  isLocked?: boolean
  backgroundColor?: string
}

export interface VaultIndexCache {
  version: number
  lastIndexedAt: number
  items: Record<string, VaultIndexCacheItem>
}

const CACHE_FILE_PATH = '.bossbrain/index.json'

function extractTitleFromBody(body: string, defaultName: string): string {
  const lines = body.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#')) {
      return trimmed.replace(/^#+\s*/, '').substring(0, 60)
    }
    return trimmed.substring(0, 60)
  }
  return defaultName
}

function extractInlineTags(body: string): string[] {
  const tagRegex = /(?:^|\s)#([a-zA-Z0-9_\u4e00-\u9fa5]+)/g
  const tags: string[] = []
  const matches = body.matchAll(tagRegex)
  for (const m of matches) {
    if (m[1]) tags.push(m[1])
  }
  return tags
}

export class VaultIndexer {
  private fs = useFileSystem()

  /**
   * Load cache from .bossbrain/index.json
   */
  async loadCache(vaultPath: string): Promise<VaultIndexCache | null> {
    try {
      const raw = await this.fs.readVaultTextFile(vaultPath, CACHE_FILE_PATH)
      if (raw) {
        return JSON.parse(raw) as VaultIndexCache
      }
    } catch {
      // Cache doesn't exist or invalid
    }
    return null
  }

  /**
   * Save cache to .bossbrain/index.json
   */
  async saveCache(vaultPath: string, notes: Note[]): Promise<void> {
    try {
      const items: Record<string, VaultIndexCacheItem> = {}
      for (const n of notes) {
        if (!n.relativePath) continue
        items[n.relativePath] = {
          id: n.id,
          title: n.title,
          relativePath: n.relativePath,
          mtime: n.mtime || Date.now(),
          size: (n as any).size ?? n.content.length,
          createdAt: n.createdAt,
          updatedAt: n.updatedAt,
          tags: n.tags || [],
          type: n.type || 'note',
          status: n.status || 'inbox',
          project: n.project,
          frontmatter: n.frontmatter || {},
          wikilinks: n.wikilinks || [],
          backlinks: n.backlinks || [],
          isPinned: n.isPinned,
          isLocked: n.isLocked,
          backgroundColor: n.backgroundColor,
        }
      }

      const cacheData: VaultIndexCache = {
        version: 1,
        lastIndexedAt: Date.now(),
        items,
      }

      await this.fs.writeVaultTextFile(vaultPath, CACHE_FILE_PATH, JSON.stringify(cacheData, null, 2))
    } catch (e) {
      console.warn('Failed to save vault index cache:', e)
    }
  }

  /**
   * Full or incremental scan of the vault.
   * If cache is missing, completely rebuilds from markdown files!
   */
  async scanVault(vaultPath: string, forceRebuild = false): Promise<Note[]> {
    if (!vaultPath) return []

    // 1. List all .md files in the vault
    const fileEntries = await this.fs.scanVaultFiles(vaultPath)
    // Filter out internal system files like .bossbrain/
    const mdFiles = fileEntries.filter(f => !f.relative_path.startsWith('.bossbrain/'))

    // 2. Load cache
    const cache = forceRebuild ? null : await this.loadCache(vaultPath)
    const cachedMap = cache?.items || {}

    const notes: Note[] = []

    for (const file of mdFiles) {
      const relPath = file.relative_path
      const cached = cachedMap[relPath]

      // Check if file is unmodified according to cache
      if (cached && cached.mtime === file.modified_ms && (cached.size === undefined || cached.size === file.size) && !forceRebuild) {
        // Read content only
        try {
          const raw = await this.fs.readVaultTextFile(vaultPath, relPath)
          const { body, frontmatter } = extractFrontmatterAndBody(raw)

          const noteObj: Note = {
            id: cached.id,
            title: cached.title,
            content: body,
            createdAt: cached.createdAt,
            updatedAt: cached.updatedAt,
            tags: cached.tags,
            isPinned: cached.isPinned ?? false,
            isLocked: cached.isLocked ?? false,
            backgroundColor: cached.backgroundColor,
            relativePath: relPath,
            status: cached.status,
            type: cached.type,
            project: cached.project,
            frontmatter: frontmatter as BossBrainFrontmatter,
            wikilinks: cached.wikilinks,
            backlinks: cached.backlinks || [],
            mtime: file.modified_ms,
          }
          ;(noteObj as any).size = file.size
          notes.push(noteObj)
          continue
        } catch (e) {
          console.warn(`Failed reading cached file ${relPath}, will re-parse:`, e)
        }
      }

      // Re-parse file from disk
      try {
        const raw = await this.fs.readVaultTextFile(vaultPath, relPath)
        const { frontmatter, body } = extractFrontmatterAndBody(raw)

        const filename = relPath.split('/').pop()?.replace(/\.md$/i, '') || 'untitled'
        const title = frontmatter.title || extractTitleFromBody(body, filename)

        // Parse dates (ISO 8601 or fallback to mtime)
        let createdAt = file.modified_ms
        if (frontmatter.created) {
          const t = Date.parse(frontmatter.created)
          if (!isNaN(t)) createdAt = t
        }

        let updatedAt = file.modified_ms
        if (frontmatter.updated) {
          const t = Date.parse(frontmatter.updated)
          if (!isNaN(t)) updatedAt = t
        }

        // Tags
        const fmTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : []
        const inlineTags = extractInlineTags(body)
        const combinedTags = Array.from(new Set([...fmTags, ...inlineTags]))

        // Wikilinks
        const links = extractWikilinks(body).map(l => l.target)

        // Persistent note ID
        const noteId = frontmatter.id || filename

        // Status & type
        const defaultStatus = relPath.startsWith('00-Inbox') ? 'inbox' : 'active'
        const status = frontmatter.status || defaultStatus
        const type = frontmatter.type || 'note'
        const project = frontmatter.project || ''

        const noteObj: Note = {
          id: noteId,
          title,
          content: body,
          createdAt,
          updatedAt,
          tags: combinedTags,
          isPinned: Boolean(frontmatter.isPinned),
          isLocked: Boolean(frontmatter.isLocked),
          backgroundColor: frontmatter.backgroundColor,
          relativePath: relPath,
          status,
          type,
          project,
          frontmatter: frontmatter as BossBrainFrontmatter,
          wikilinks: links,
          backlinks: [],
          mtime: file.modified_ms,
        }
        ;(noteObj as any).size = file.size
        notes.push(noteObj)
      } catch (err) {
        console.error(`Error parsing markdown file ${relPath}:`, err)
      }
    }

    // 3. Compute backlinks across all notes
    const backlinksMap = computeBacklinks(notes)
    for (const note of notes) {
      note.backlinks = backlinksMap.get(note.id) || []
    }

    // 4. Update cache
    await this.saveCache(vaultPath, notes)

    // 5. Update _system/INDEX.md (only for non-system notes)
    try {
      const nonSystemNotes = notes.filter(n => !n.relativePath?.startsWith('_system/'))
      const indexMd = generateIndexMarkdown(nonSystemNotes)
      await this.fs.writeVaultTextFile(vaultPath, '_system/INDEX.md', indexMd)
    } catch (e) {
      console.warn('Failed updating _system/INDEX.md:', e)
    }

    return notes
  }
}

export const vaultIndexer = new VaultIndexer()
