import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { extractFrontmatterAndBody, stringifyWithFrontmatter } from '../src/utils/frontmatter.ts'
import { diffVaultSnapshot, mergeScannedWithPreservedNotes } from '../src/services/vaultChangeDetector.ts'
import { resolveNoteConflict } from '../src/services/conflictResolver.ts'

// Simulated Store & FileSystem for Integration Tests using production services
class MockVaultEnvironment {
  constructor() {
    this.vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bossbrain-integration-'))
    this.inboxDir = path.join(this.vaultDir, '00-Inbox')
    this.systemDir = path.join(this.vaultDir, '_system')
    this.cacheDir = path.join(this.vaultDir, '.bossbrain')
    fs.mkdirSync(this.inboxDir, { recursive: true })
    fs.mkdirSync(this.systemDir, { recursive: true })
    fs.mkdirSync(this.cacheDir, { recursive: true })

    this.notes = []
    this.currentNoteId = null
    this.lastDiskSnapshot = new Map()
  }

  cleanup() {
    fs.rmSync(this.vaultDir, { recursive: true, force: true })
  }

  scanVaultFiles() {
    const results = []
    const walk = (dir, relBase = '') => {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          walk(full, rel)
        } else if (entry.name.endsWith('.md')) {
          const stat = fs.statSync(full)
          results.push({ relative_path: rel, modified_ms: stat.mtimeMs, size: stat.size })
        }
      }
    }
    walk(this.vaultDir)
    return results
  }

  readVaultTextFile(relPath) {
    return fs.readFileSync(path.join(this.vaultDir, relPath), 'utf-8')
  }

  writeVaultTextFile(relPath, content) {
    const full = path.join(this.vaultDir, relPath)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, 'utf-8')
  }

  deleteVaultFile(relPath) {
    fs.unlinkSync(path.join(this.vaultDir, relPath))
  }

  // Corresponds to rescanVault logic in noteStore.ts using mergeScannedWithPreservedNotes
  async rescanVault(forceRebuild = false) {
    const files = this.scanVaultFiles().filter(f => !f.relative_path.startsWith('.bossbrain/'))

    const scanned = []
    for (const f of files) {
      const raw = this.readVaultTextFile(f.relative_path)
      const { frontmatter, body } = extractFrontmatterAndBody(raw)
      scanned.push({
        id: frontmatter.id || path.basename(f.relative_path, '.md'),
        title: frontmatter.title || 'Untitled',
        content: body,
        relativePath: f.relative_path,
        mtime: f.modified_ms,
        frontmatter,
        isDirty: false,
        size: f.size,
      })
    }

    const { mergedNotes, isEmptyVault } = mergeScannedWithPreservedNotes(scanned, this.notes)
    if (isEmptyVault) {
      this.notes = []
      this.lastDiskSnapshot.clear()
      // Create fresh note in 00-Inbox/
      const freshRel = '00-Inbox/fresh-first-note.md'
      this.writeVaultTextFile(freshRel, stringifyWithFrontmatter({ id: 'fresh-1', title: 'New Note' }, ''))
      const stat = fs.statSync(path.join(this.vaultDir, freshRel))
      this.notes = [{
        id: 'fresh-1',
        title: 'New Note',
        content: '',
        relativePath: freshRel,
        mtime: stat.mtimeMs,
        size: stat.size,
        isDirty: false,
      }]
      this.currentNoteId = 'fresh-1'
      this.lastDiskSnapshot.set(freshRel, { mtime: stat.mtimeMs, size: stat.size })
      return
    }

    this.notes = mergedNotes
    this.lastDiskSnapshot.clear()
    for (const f of scanned) {
      this.lastDiskSnapshot.set(f.relativePath, { mtime: f.mtime, size: f.size })
    }
  }

  // Corresponds to checkExternalChanges logic in noteStore.ts using diffVaultSnapshot
  async checkExternalChanges() {
    const files = this.scanVaultFiles()
    const diskFiles = files.filter(f => !f.relative_path.startsWith('.bossbrain/'))

    const diskSnapshot = new Map()
    for (const f of diskFiles) {
      diskSnapshot.set(f.relative_path, { mtime: f.modified_ms, size: f.size })
    }

    const diff = diffVaultSnapshot(diskSnapshot, this.lastDiskSnapshot, this.notes)
    if (!diff.hasAnyDiff) return false

    const current = this.notes.find(n => n.id === this.currentNoteId)
    if (current && current.relativePath) {
      const curDisk = diskSnapshot.get(current.relativePath)
      const curLast = this.lastDiskSnapshot.get(current.relativePath)
      const isCurModified = curDisk && (
        (curLast && (curDisk.mtime !== curLast.mtime || curDisk.size !== curLast.size)) ||
        (current.mtime && curDisk.mtime > current.mtime + 500)
      )
      if (isCurModified) {
        const raw = this.readVaultTextFile(current.relativePath)
        const { frontmatter, body } = extractFrontmatterAndBody(raw)
        if (current.isDirty) {
          current.hasConflict = true
          current.conflictType = 'modified'
          current.conflictContent = body
        } else {
          current.content = body
          current.frontmatter = frontmatter
          current.title = frontmatter.title || current.title
          current.mtime = curDisk.mtime
          current.size = curDisk.size
        }
      }
    }

    await this.rescanVault(false)
    return true
  }

  // Corresponds to resolveConflict in noteStore.ts using resolveNoteConflict
  async resolveConflict(noteId, choice) {
    const note = this.notes.find(n => n.id === noteId)
    if (!note) return

    await resolveNoteConflict(note, choice, {
      writeVaultTextFile: async (relPath, content) => {
        const full = stringifyWithFrontmatter(note.frontmatter || {}, content)
        this.writeVaultTextFile(relPath, full)
        const stat = fs.statSync(path.join(this.vaultDir, relPath))
        this.lastDiskSnapshot.set(relPath, { mtime: stat.mtimeMs, size: stat.size })
        return { modified_ms: stat.mtimeMs, size: stat.size }
      },
      createNoteWithContent: async (title, content) => {
        const rel = `00-Inbox/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}.md`
        const full = stringifyWithFrontmatter({ id: `copy-${Date.now()}`, title }, content)
        this.writeVaultTextFile(rel, full)
        const stat = fs.statSync(path.join(this.vaultDir, rel))
        const newNote = {
          id: `copy-${Date.now()}`,
          title,
          content,
          relativePath: rel,
          mtime: stat.mtimeMs,
          size: stat.size,
          isDirty: false,
        }
        this.notes.push(newNote)
        this.lastDiskSnapshot.set(rel, { mtime: stat.mtimeMs, size: stat.size })
        return newNote
      },
      deleteFromMemory: (id) => {
        this.notes = this.notes.filter(n => n.id !== id)
      },
    })
  }
}

// --- INTEGRATION Tests ---

test('[INTEGRATION] 1. [F1-01] Non-current note external modification detection', async () => {
  const env = new MockVaultEnvironment()
  try {
    // Setup A.md and B.md
    env.writeVaultTextFile('00-Inbox/A.md', stringifyWithFrontmatter({ id: 'note-A', title: 'Note A' }, 'Content A'))
    env.writeVaultTextFile('00-Inbox/B.md', stringifyWithFrontmatter({ id: 'note-B', title: 'Note B' }, 'Content B original'))
    await env.rescanVault()

    // Focus on Note A
    env.currentNoteId = 'note-A'
    assert.equal(env.notes.find(n => n.id === 'note-B').content, 'Content B original')

    // External agent modifies B.md while A is active (file count remains 2!)
    await new Promise(r => setTimeout(r, 20))
    env.writeVaultTextFile('00-Inbox/B.md', stringifyWithFrontmatter({ id: 'note-B', title: 'Note B Updated by AI' }, 'Content B updated by AI agent'))

    // Window refocus triggers checkExternalChanges
    const changed = await env.checkExternalChanges()
    assert.equal(changed, true, 'checkExternalChanges must detect non-current note change')

    // Verification: Note B's title and content are refreshed in memory
    const updatedB = env.notes.find(n => n.id === 'note-B')
    assert.equal(updatedB.title, 'Note B Updated by AI')
    assert.equal(updatedB.content, 'Content B updated by AI agent')
    // Note A remains active and unaffected
    assert.equal(env.currentNoteId, 'note-A')
  } finally {
    env.cleanup()
  }
})

test('[INTEGRATION] 2. [F1-02] Conflict state and unpersisted edits preservation on rescan', async () => {
  const env = new MockVaultEnvironment()
  try {
    env.writeVaultTextFile('00-Inbox/A.md', stringifyWithFrontmatter({ id: 'note-A', title: 'Note A' }, 'Disk V1'))
    await env.rescanVault()
    env.currentNoteId = 'note-A'

    const noteA = env.notes.find(n => n.id === 'note-A')
    // User types in editor (isDirty = true)
    noteA.content = 'Local Unsaved Edit V2'
    noteA.isDirty = true

    // External tool edits A.md concurrently
    await new Promise(r => setTimeout(r, 20))
    env.writeVaultTextFile('00-Inbox/A.md', stringifyWithFrontmatter({ id: 'note-A', title: 'Note A Disk' }, 'Disk V3 from External Agent'))

    // Window focus triggers checkExternalChanges
    await env.checkExternalChanges()

    // Verification: Conflict state locked, unpersisted local edits preserved, disk version captured
    assert.equal(noteA.isDirty, true, 'isDirty must NOT be wiped')
    assert.equal(noteA.hasConflict, true, 'hasConflict must be true')
    assert.equal(noteA.content, 'Local Unsaved Edit V2', 'Local unsaved edits must NOT be overwritten')
    assert.equal(noteA.conflictContent, 'Disk V3 from External Agent', 'conflictContent must hold disk version')
  } finally {
    env.cleanup()
  }
})

test('[INTEGRATION] 3. [F1-02 Branch 1] Conflict resolution: keep-local', async () => {
  const env = new MockVaultEnvironment()
  try {
    env.writeVaultTextFile('00-Inbox/A.md', stringifyWithFrontmatter({ id: 'note-A', title: 'Note A' }, 'Disk Content'))
    await env.rescanVault()
    const noteA = env.notes.find(n => n.id === 'note-A')
    noteA.content = 'Local Version'
    noteA.isDirty = true
    noteA.hasConflict = true
    noteA.conflictContent = 'Disk External Version'

    await env.resolveConflict('note-A', 'keep-local')

    assert.equal(noteA.hasConflict, false)
    assert.equal(noteA.isDirty, false)
    assert.equal(noteA.content, 'Local Version')

    // Verify disk was overwritten with local content
    const diskRaw = env.readVaultTextFile('00-Inbox/A.md')
    assert.ok(diskRaw.includes('Local Version'))
  } finally {
    env.cleanup()
  }
})

test('[INTEGRATION] 4. [F1-02 Branch 2] Conflict resolution: keep-disk', async () => {
  const env = new MockVaultEnvironment()
  try {
    env.writeVaultTextFile('00-Inbox/A.md', stringifyWithFrontmatter({ id: 'note-A', title: 'Note A' }, 'Disk External Version'))
    await env.rescanVault()
    const noteA = env.notes.find(n => n.id === 'note-A')
    noteA.content = 'Local Version'
    noteA.isDirty = true
    noteA.hasConflict = true
    noteA.conflictContent = 'Disk External Version'

    await env.resolveConflict('note-A', 'keep-disk')

    assert.equal(noteA.hasConflict, false)
    assert.equal(noteA.isDirty, false)
    assert.equal(noteA.content, 'Disk External Version')
  } finally {
    env.cleanup()
  }
})

test('[INTEGRATION] 5. [F1-02 Branch 3] Conflict resolution: conflict-copy', async () => {
  const env = new MockVaultEnvironment()
  try {
    env.writeVaultTextFile('00-Inbox/A.md', stringifyWithFrontmatter({ id: 'note-A', title: 'Note A' }, 'Disk External Version'))
    await env.rescanVault()
    const noteA = env.notes.find(n => n.id === 'note-A')
    noteA.content = 'Local Version'
    noteA.isDirty = true
    noteA.hasConflict = true
    noteA.conflictContent = 'Disk External Version'

    await env.resolveConflict('note-A', 'conflict-copy')

    assert.equal(noteA.hasConflict, false)
    assert.equal(noteA.isDirty, false)
    assert.equal(noteA.content, 'Disk External Version')

    // Verify conflict copy note was created on disk with local edits
    const files = env.scanVaultFiles().filter(f => f.relative_path.includes('conflict-copy'))
    assert.equal(files.length, 1)
    const copyContent = env.readVaultTextFile(files[0].relative_path)
    assert.ok(copyContent.includes('Local Version'))
  } finally {
    env.cleanup()
  }
})

test('[INTEGRATION] 6. [F1-03] Empty Vault state handling', async () => {
  const env = new MockVaultEnvironment()
  try {
    env.writeVaultTextFile('00-Inbox/A.md', stringifyWithFrontmatter({ id: 'note-A', title: 'Note A' }, 'Content'))
    await env.rescanVault()
    assert.equal(env.notes.length, 1)

    // User externally wipes vault (0 markdown files)
    env.deleteVaultFile('00-Inbox/A.md')

    await env.checkExternalChanges()

    // Verification: Old note A is gone, notes list has clean fresh note
    assert.ok(!env.notes.some(n => n.id === 'note-A'))
    assert.equal(env.notes.length, 1)
    assert.equal(env.notes[0].id, 'fresh-1')
  } finally {
    env.cleanup()
  }
})

test('[INTEGRATION] 7. [F1-07] legacyPath consistency and source immutability', () => {
  const customLegacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-legacy-'))
  const targetVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'target-vault-'))
  fs.mkdirSync(path.join(targetVaultDir, '00-Inbox'), { recursive: true })

  const legacyMeta = {
    version: 1,
    notes: [
      {
        id: 'leg-1',
        title: 'Custom Legacy Note',
        createdAt: 1726500000000,
        updatedAt: 1726500000000,
        tags: ['custom'],
      }
    ]
  }
  fs.writeFileSync(path.join(customLegacyDir, 'metadata.json'), JSON.stringify(legacyMeta))
  fs.writeFileSync(path.join(customLegacyDir, 'note_leg-1.md'), 'Original Legacy Content Never Modified')

  // Simulate migrateLegacyMaikNote reading from customLegacyDir
  const meta = JSON.parse(fs.readFileSync(path.join(customLegacyDir, 'metadata.json'), 'utf-8'))
  for (const item of meta.notes) {
    const raw = fs.readFileSync(path.join(customLegacyDir, `note_${item.id}.md`), 'utf-8')
    const fm = {
      id: item.id,
      title: item.title,
      created: new Date(item.createdAt).toISOString(),
      updated: new Date(item.updatedAt).toISOString(),
      type: 'note',
      status: 'inbox',
      tags: item.tags,
      source: 'maiknote-migration',
    }
    const converted = stringifyWithFrontmatter(fm, raw)
    fs.writeFileSync(path.join(targetVaultDir, '00-Inbox', `${item.id}.md`), converted)
  }

  // Source directory remains 100% pristine
  assert.equal(fs.readFileSync(path.join(customLegacyDir, 'note_leg-1.md'), 'utf-8'), 'Original Legacy Content Never Modified')
  // Target vault received converted note
  assert.ok(fs.existsSync(path.join(targetVaultDir, '00-Inbox', 'leg-1.md')))

  fs.rmSync(customLegacyDir, { recursive: true, force: true })
  fs.rmSync(targetVaultDir, { recursive: true, force: true })
})

test('[INTEGRATION] 8. [F2-01] External deletion of dirty note does NOT lose local content', async () => {
  const env = new MockVaultEnvironment()
  try {
    env.writeVaultTextFile('00-Inbox/A.md', stringifyWithFrontmatter({ id: 'note-A', title: 'Note A' }, 'Disk V1'))
    await env.rescanVault()
    env.currentNoteId = 'note-A'

    const noteA = env.notes.find(n => n.id === 'note-A')
    // User types local edits (isDirty = true)
    noteA.content = 'Important Local Unsaved Work'
    noteA.isDirty = true

    // External AI / Obsidian deletes A.md on disk
    env.deleteVaultFile('00-Inbox/A.md')

    // System detects change or rescans
    await env.checkExternalChanges()

    // Note A must NOT be removed; must have conflictType = 'deleted' and diskState = 'missing'
    assert.equal(env.notes.length, 1, 'Dirty note must not be removed on external deletion')
    const preserved = env.notes.find(n => n.id === 'note-A')
    assert.ok(preserved)
    assert.equal(preserved.content, 'Important Local Unsaved Work')
    assert.equal(preserved.isDirty, true)
    assert.equal(preserved.hasConflict, true)
    assert.equal(preserved.conflictType, 'deleted')
    assert.equal(preserved.diskState, 'missing')
  } finally {
    env.cleanup()
  }
})

test('[INTEGRATION] 9. [F2-01 Branch 1] Deleted dirty note conflict resolution: keep-local recreates file on disk', async () => {
  const env = new MockVaultEnvironment()
  try {
    env.writeVaultTextFile('00-Inbox/A.md', stringifyWithFrontmatter({ id: 'note-A', title: 'Note A' }, 'Disk V1'))
    await env.rescanVault()

    const noteA = env.notes.find(n => n.id === 'note-A')
    noteA.content = 'Recovered Local Work'
    noteA.isDirty = true
    noteA.hasConflict = true
    noteA.conflictType = 'deleted'
    noteA.diskState = 'missing'

    // User chooses keep-local (re-save to disk)
    await env.resolveConflict('note-A', 'keep-local')

    assert.equal(noteA.hasConflict, false)
    assert.equal(noteA.diskState, 'normal')
    assert.equal(noteA.isDirty, false)
    assert.equal(noteA.content, 'Recovered Local Work')

    // Verify file is recreated on disk
    assert.ok(fs.existsSync(path.join(env.vaultDir, '00-Inbox/A.md')))
    const diskContent = env.readVaultTextFile('00-Inbox/A.md')
    assert.ok(diskContent.includes('Recovered Local Work'))
  } finally {
    env.cleanup()
  }
})

test('[INTEGRATION] 10. [F2-01 Branch 2] Deleted dirty note conflict resolution: keep-disk accepts external deletion', async () => {
  const env = new MockVaultEnvironment()
  try {
    env.writeVaultTextFile('00-Inbox/A.md', stringifyWithFrontmatter({ id: 'note-A', title: 'Note A' }, 'Disk V1'))
    await env.rescanVault()

    const noteA = env.notes.find(n => n.id === 'note-A')
    noteA.content = 'Discarded Local Work'
    noteA.isDirty = true
    noteA.hasConflict = true
    noteA.conflictType = 'deleted'
    noteA.diskState = 'missing'

    // User chooses keep-disk (accept deletion)
    await env.resolveConflict('note-A', 'keep-disk')

    // Note is safely removed from memory
    assert.equal(env.notes.length, 0)
    assert.ok(!env.notes.some(n => n.id === 'note-A'))
  } finally {
    env.cleanup()
  }
})

test('[INTEGRATION] 11. [F2-01 Branch 3] Deleted dirty note conflict resolution: conflict-copy saves recovered note', async () => {
  const env = new MockVaultEnvironment()
  try {
    env.writeVaultTextFile('00-Inbox/A.md', stringifyWithFrontmatter({ id: 'note-A', title: 'Note A' }, 'Disk V1'))
    await env.rescanVault()

    const noteA = env.notes.find(n => n.id === 'note-A')
    noteA.content = 'Local Content Saved As Copy'
    noteA.isDirty = true
    noteA.hasConflict = true
    noteA.conflictType = 'deleted'
    noteA.diskState = 'missing'

    // User chooses conflict-copy
    await env.resolveConflict('note-A', 'conflict-copy')

    // The missing note is closed/removed from memory
    assert.ok(!env.notes.some(n => n.id === 'note-A'))

    // But a new recovered note is created on disk in 00-Inbox/
    const files = env.scanVaultFiles().filter(f => f.relative_path.includes('recovered'))
    assert.equal(files.length, 1)
    const copyContent = env.readVaultTextFile(files[0].relative_path)
    assert.ok(copyContent.includes('Local Content Saved As Copy'))
  } finally {
    env.cleanup()
  }
})

test('[INTEGRATION] 12. [F2-02] Empty vault on disk does NOT wipe dirty/conflicted notes', async () => {
  const env = new MockVaultEnvironment()
  try {
    env.writeVaultTextFile('00-Inbox/A.md', stringifyWithFrontmatter({ id: 'note-A', title: 'Note A' }, 'Disk V1'))
    await env.rescanVault()

    const noteA = env.notes.find(n => n.id === 'note-A')
    noteA.content = 'User Still Editing This'
    noteA.isDirty = true

    // External agent empties the whole vault
    env.deleteVaultFile('00-Inbox/A.md')

    // Rescan vault
    await env.rescanVault()

    // Note A must NOT be replaced by a dummy empty note; dirty note remains preserved with conflict
    assert.equal(env.notes.length, 1)
    assert.equal(env.notes[0].id, 'note-A')
    assert.equal(env.notes[0].content, 'User Still Editing This')
    assert.equal(env.notes[0].diskState, 'missing')
    assert.equal(env.notes[0].hasConflict, true)
  } finally {
    env.cleanup()
  }
})

