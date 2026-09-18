import { useFileSystem } from '@/composables/useFileSystem'
import type { NoteMetadata, BossBrainFrontmatter } from '@/types/note'
import { stringifyWithFrontmatter } from '@/utils/frontmatter'
import { generateBossBrainFilename, formatISO8601WithOffset } from '@/utils/slug'

export interface MigrationReport {
  total: number
  success: number
  failed: number
  skipped: number
  conflicts: number
  errors: Array<{ id: string; error: string }>
}

export async function migrateLegacyMaikNote(
  vaultPath: string,
  legacyPath?: string
): Promise<MigrationReport> {
  const fs = useFileSystem()
  const report: MigrationReport = {
    total: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    conflicts: 0,
    errors: [],
  }

  // 1. Determine legacy path (default iCloud MaikNote folder)
  let sourceDir = legacyPath
  if (!sourceDir) {
    try {
      sourceDir = await fs.getICloudPath()
    } catch (e) {
      report.errors.push({ id: 'init', error: 'Could not resolve legacy iCloud path' })
      return report
    }
  }

  // 2. Read legacy metadata.json safely
  let metadata: NoteMetadata
  try {
    const rawMeta = await fs.readMetadata(sourceDir)
    metadata = rawMeta
  } catch (e: any) {
    report.errors.push({ id: 'metadata', error: `Failed to read legacy metadata: ${e.message}` })
    return report
  }

  if (!metadata || !metadata.notes || metadata.notes.length === 0) {
    return report
  }

  report.total = metadata.notes.length

  // Ensure target folder 00-Inbox exists
  await fs.ensureVaultStructure(vaultPath)

  // 3. Process each legacy note (strictly read & copy, NEVER delete or modify source)
  for (const item of metadata.notes) {
    try {
      // Read content from legacy location
      const content = await fs.readNote(item.id, item.directoryId, sourceDir)
      const createdDate = new Date(item.createdAt || Date.now())
      const updatedDate = new Date(item.updatedAt || item.createdAt || Date.now())

      const frontmatter: BossBrainFrontmatter = {
        id: item.id,
        title: item.title || 'Untitled',
        created: formatISO8601WithOffset(createdDate),
        updated: formatISO8601WithOffset(updatedDate),
        type: 'note',
        status: item.trashedAt ? 'archived' : 'inbox',
        project: '',
        tags: item.tags || [],
        source: 'maiknote-migration',
        isPinned: item.isPinned,
        isLocked: item.isLocked,
        backgroundColor: item.backgroundColor,
      }

      const fullMarkdown = stringifyWithFrontmatter(frontmatter, content)
      const filename = generateBossBrainFilename(item.title || 'note', createdDate)
      const targetFolder = item.trashedAt ? '90-Archive' : '00-Inbox'
      const relativePath = `${targetFolder}/${filename}`

      // Check for collision
      try {
        await fs.readVaultTextFile(vaultPath, relativePath)
        // If it already exists without error, skip to avoid overwriting
        report.skipped++
        report.conflicts++
        continue
      } catch {
        // Does not exist, safe to write
      }

      await fs.writeVaultTextFile(vaultPath, relativePath, fullMarkdown)
      report.success++
    } catch (err: any) {
      report.failed++
      report.errors.push({
        id: item.id,
        error: err.message || String(err),
      })
    }
  }

  return report
}
