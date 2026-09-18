import type { Note } from '@/types/note'

export interface DiskFileSnapshot {
  mtime: number
  size: number
}

export interface DiffResult {
  hasAnyDiff: boolean
  added: string[]
  modified: string[]
  deleted: string[]
}

/**
 * Compare disk snapshot with previous disk snapshot / in-memory notes.
 * Detects any file added, modified, or deleted across the entire vault.
 */
export function diffVaultSnapshot(
  diskSnapshot: Map<string, DiskFileSnapshot>,
  lastDiskSnapshot: Map<string, DiskFileSnapshot>,
  notes: Note[]
): DiffResult {
  const added: string[] = []
  const modified: string[] = []
  const deleted: string[] = []

  // 1. Check disk files against previous snapshot / notes
  for (const [relPath, diskEntry] of diskSnapshot) {
    const last = lastDiskSnapshot.get(relPath)
    if (!last) {
      const memNote = notes.find(n => n.relativePath === relPath)
      if (!memNote) {
        added.push(relPath)
      } else if (memNote.mtime && (diskEntry.mtime > memNote.mtime + 500 || ((memNote as any).size && diskEntry.size !== (memNote as any).size))) {
        modified.push(relPath)
      }
    } else {
      if (diskEntry.mtime !== last.mtime || diskEntry.size !== last.size) {
        modified.push(relPath)
      }
    }
  }

  // 2. Check for deleted files from disk
  for (const note of notes) {
    if (note.relativePath && !diskSnapshot.has(note.relativePath)) {
      deleted.push(note.relativePath)
    }
  }

  const hasAnyDiff = added.length > 0 || modified.length > 0 || deleted.length > 0 || diskSnapshot.size !== notes.length

  return {
    hasAnyDiff,
    added,
    modified,
    deleted,
  }
}

/**
 * Merge scanned notes from disk with current in-memory notes.
 * F2-01 & F2-02:
 * Any note that has isDirty === true or hasConflict === true MUST NEVER BE LOST!
 * If missing from scanned, it is kept with conflictType = 'deleted' and hasConflict = true.
 */
export function mergeScannedWithPreservedNotes(
  scanned: Note[],
  currentNotes: Note[]
): {
  mergedNotes: Note[]
  isEmptyVault: boolean
} {
  // Map of all dirty or conflicting notes in memory
  const dirtyOrConflictNotes = new Map<string, Note>()
  for (const n of currentNotes) {
    if (n.isDirty || n.hasConflict) {
      dirtyOrConflictNotes.set(n.id, n)
      if (n.relativePath) dirtyOrConflictNotes.set(n.relativePath, n)
    }
  }

  // Track which dirty/conflict notes were matched in scanned
  const matchedDirtyIds = new Set<string>()

  const mergedNotes: Note[] = scanned.map(sn => {
    const preserved = dirtyOrConflictNotes.get(sn.id) || (sn.relativePath ? dirtyOrConflictNotes.get(sn.relativePath) : undefined)
    if (preserved) {
      matchedDirtyIds.add(preserved.id)
      return {
        ...sn,
        content: preserved.content,
        isDirty: preserved.isDirty,
        hasConflict: preserved.hasConflict,
        conflictContent: preserved.conflictContent,
        conflictType: preserved.conflictType || 'modified',
        diskState: 'normal',
        frontmatter: preserved.frontmatter,
        title: preserved.title,
      }
    }
    return sn
  })

  // F2-01: Any dirty/conflict note that was NOT in scanned has been deleted or moved on disk!
  // MUST NOT BE SILENTLY DISCARDED!
  for (const [, preserved] of dirtyOrConflictNotes.entries()) {
    if (!matchedDirtyIds.has(preserved.id)) {
      matchedDirtyIds.add(preserved.id)
      mergedNotes.unshift({
        ...preserved,
        hasConflict: true,
        conflictType: 'deleted',
        diskState: 'missing',
      })
    }
  }

  // F2-02: Empty vault check
  // Only considered empty vault if scanned is 0 AND mergedNotes is 0 (i.e. no dirty notes need protection)
  const isEmptyVault = scanned.length === 0 && mergedNotes.length === 0

  return {
    mergedNotes,
    isEmptyVault,
  }
}
