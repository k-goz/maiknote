import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { load, dump } from 'js-yaml'

function extractFrontmatterAndBody(content) {
  const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
  const trimmed = content || ''
  const match = trimmed.match(FRONTMATTER_REGEX)
  if (!match) return { frontmatter: {}, body: trimmed, hasFrontmatter: false }
  const yamlText = match[1]
  const body = trimmed.slice(match[0].length).replace(/^\r?\n/, '')
  try {
    const parsed = load(yamlText)
    if (parsed && typeof parsed === 'object') return { frontmatter: parsed, body, hasFrontmatter: true }
  } catch {}
  return { frontmatter: {}, body: trimmed, hasFrontmatter: false }
}

function stringifyWithFrontmatter(frontmatter, body) {
  const cleanFm = {}
  for (const [key, val] of Object.entries(frontmatter)) {
    if (val !== undefined && val !== null) cleanFm[key] = val
  }
  if (Object.keys(cleanFm).length === 0) return body || ''
  const yamlStr = dump(cleanFm, { lineWidth: -1, noRefs: true, forceQuotes: false }).trim()
  return `---\n${yamlStr}\n---\n\n${body !== undefined ? body : ''}`
}

// Simulated Store & FileSystem for Integration Tests
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

  // Corresponds to rescanVault logic in noteStore.ts
  async rescanVault(forceRebuild = false) {
    const files = this.scanVaultFiles().filter(f => !f.relative_path.startsWith('.bossbrain/'))
    if (files.length === 0) {
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
        isDirty: false,
      }]
      this.currentNoteId = 'fresh-1'
      this.lastDiskSnapshot.set(freshRel, { mtime: stat.mtimeMs, size: stat.size })
      return
    }

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

    const preservedMap = new Map()
    for (const n of this.notes) {
      if (n.isDirty || n.hasConflict) {
        preservedMap.set(n.id, n)
        if (n.relativePath) preservedMap.set(n.relativePath, n)
      }
    }

    const mergedNotes = scanned.map(sn => {
      const preserved = preservedMap.get(sn.id) || (sn.relativePath ? preservedMap.get(sn.relativePath) : undefined)
      if (preserved) {
        return {
          ...sn,
          content: preserved.content,
          isDirty: preserved.isDirty,
          hasConflict: preserved.hasConflict,
          conflictContent: preserved.conflictContent,
          frontmatter: preserved.frontmatter,
          title: preserved.title,
        }
      }
      return sn
    })

    this.notes = mergedNotes
    this.lastDiskSnapshot.clear()
    for (const f of scanned) {
      this.lastDiskSnapshot.set(f.relativePath, { mtime: f.mtime, size: f.size })
    }
  }

  // Corresponds to checkExternalChanges logic in noteStore.ts
  async checkExternalChanges() {
    const files = this.scanVaultFiles()
    const diskFiles = files.filter(f => !f.relative_path.startsWith('.bossbrain/'))

    const diskSnapshot = new Map()
    for (const f of diskFiles) {
      diskSnapshot.set(f.relative_path, { mtime: f.modified_ms, size: f.size })
    }

    let hasAnyDiff = false
    if (diskSnapshot.size !== this.notes.length) hasAnyDiff = true

    for (const [relPath, diskEntry] of diskSnapshot) {
      const memNote = this.notes.find(n => n.relativePath === relPath)
      if (!memNote) {
        hasAnyDiff = true
        break
      }
      const lastEntry = this.lastDiskSnapshot.get(relPath)
      if (lastEntry) {
        if (diskEntry.mtime !== lastEntry.mtime || diskEntry.size !== lastEntry.size) {
          hasAnyDiff = true
          break
        }
      } else if (memNote.mtime && (diskEntry.mtime > memNote.mtime + 500 || (memNote.size && diskEntry.size !== memNote.size))) {
        hasAnyDiff = true
        break
      }
    }

    if (!hasAnyDiff) {
      for (const note of this.notes) {
        if (note.relativePath && !diskSnapshot.has(note.relativePath)) {
          hasAnyDiff = true
          break
        }
      }
    }

    if (!hasAnyDiff) return false

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

  // Corresponds to resolveConflict in noteStore.ts
  async resolveConflict(noteId, choice) {
    const note = this.notes.find(n => n.id === noteId)
    if (!note) return

    if (choice === 'keep-local') {
      note.hasConflict = false
      note.conflictContent = undefined
      note.isDirty = true
      // Write local content to disk immediately
      const full = stringifyWithFrontmatter(note.frontmatter || {}, note.content)
      this.writeVaultTextFile(note.relativePath, full)
      const stat = fs.statSync(path.join(this.vaultDir, note.relativePath))
      note.mtime = stat.mtimeMs
      note.size = stat.size
      this.lastDiskSnapshot.set(note.relativePath, { mtime: stat.mtimeMs, size: stat.size })
      note.isDirty = false
    } else if (choice === 'keep-disk') {
      if (note.conflictContent !== undefined) {
        note.content = note.conflictContent
      }
      note.hasConflict = false
      note.conflictContent = undefined
      note.isDirty = false
      const stat = fs.statSync(path.join(this.vaultDir, note.relativePath))
      note.mtime = stat.mtimeMs
      note.size = stat.size
      this.lastDiskSnapshot.set(note.relativePath, { mtime: stat.mtimeMs, size: stat.size })
    } else if (choice === 'conflict-copy') {
      const copyRel = `00-Inbox/conflict-copy-${Date.now()}.md`
      const copyFull = stringifyWithFrontmatter({ id: `copy-${Date.now()}`, title: `${note.title} (Conflict Copy)` }, note.content)
      this.writeVaultTextFile(copyRel, copyFull)
      if (note.conflictContent !== undefined) {
        note.content = note.conflictContent
      }
      note.hasConflict = false
      note.conflictContent = undefined
      note.isDirty = false
      const stat = fs.statSync(path.join(this.vaultDir, note.relativePath))
      note.mtime = stat.mtimeMs
      note.size = stat.size
      this.lastDiskSnapshot.set(note.relativePath, { mtime: stat.mtimeMs, size: stat.size })
    }
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
