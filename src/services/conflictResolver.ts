import type { Note } from '@/types/note'

export interface ConflictResolutionCallbacks {
  saveNote: (note: Note) => Promise<void>
  createRecoveredNote: (title: string, content: string, sourceNote?: Note) => Promise<Note>
  deleteFromMemory: (noteId: string) => void
}

/**
 * Resolves conflict for both 'modified' and 'deleted' conflicts.
 * Follows strict F3 specifications:
 * - keep-local: re-create/write file on disk and save local content through canonical saveNote(note)
 *   preserving all Frontmatter.
 * - keep-disk: if deleted, discard local draft from memory; if modified, adopt disk content
 * - conflict-copy: save local draft as 00-Inbox/<title>-recovered-<id>.md with full Frontmatter,
 *   then discard deleted note, or create conflict copy note for modified note.
 */
export async function resolveNoteConflict(
  note: Note,
  choice: 'keep-local' | 'keep-disk' | 'conflict-copy',
  callbacks: ConflictResolutionCallbacks
): Promise<void> {
  const isDeletedConflict = note.conflictType === 'deleted' || note.diskState === 'missing'

  if (choice === 'keep-local') {
    note.hasConflict = false
    note.conflictType = undefined
    note.conflictContent = undefined
    note.diskState = 'normal'
    note.isDirty = false
    note.updatedAt = Date.now()
    if (note.relativePath) {
      await callbacks.saveNote(note)
    }
  } else if (choice === 'keep-disk') {
    if (isDeletedConflict) {
      // User accepts external deletion: discard local draft and remove from memory
      callbacks.deleteFromMemory(note.id)
    } else {
      // User accepts disk version
      if (note.conflictContent !== undefined) {
        note.content = note.conflictContent
      }
      note.hasConflict = false
      note.conflictType = undefined
      note.conflictContent = undefined
      note.isDirty = false
    }
  } else if (choice === 'conflict-copy') {
    if (isDeletedConflict) {
      // Save local draft to recovered note with full Frontmatter in 00-Inbox/, then accept deletion of original
      const recoveredTitle = `${note.title || 'Untitled'} (Recovered)`
      await callbacks.createRecoveredNote(recoveredTitle, note.content, note)
      callbacks.deleteFromMemory(note.id)
    } else {
      // Create conflict copy note with local content, original adopts disk version
      const conflictTitle = `${note.title || 'Untitled'} (Conflict Copy)`
      await callbacks.createRecoveredNote(conflictTitle, note.content, note)
      if (note.conflictContent !== undefined) {
        note.content = note.conflictContent
      }
      note.hasConflict = false
      note.conflictType = undefined
      note.conflictContent = undefined
      note.isDirty = false
    }
  }
}
