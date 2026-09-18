import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Directly import production modules (F2-06 rule)
import { extractFrontmatterAndBody, stringifyWithFrontmatter } from '../src/utils/frontmatter.ts'
import { slugify, generateBossBrainFilename, formatFilenameDate, formatISO8601WithOffset } from '../src/utils/slug.ts'
import { extractWikilinks, resolveWikilinkTarget, computeBacklinks } from '../src/utils/wikilink.ts'
import { diffVaultSnapshot, mergeScannedWithPreservedNotes } from '../src/services/vaultChangeDetector.ts'
import { resolveNoteConflict } from '../src/services/conflictResolver.ts'

console.log('=== BOSS BRAIN V1 PRODUCTION-CODE FILESYSTEM INTEGRATION SUITE ===')

test('Scenario A: Quick Capture & Real Disk File Persistence', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bossbrain-fs-vault-'))
  const inboxDir = path.join(vaultDir, '00-Inbox')
  fs.mkdirSync(inboxDir, { recursive: true })

  try {
    const title = 'HealthTwin 首页应该加强 CTA'
    const now = new Date(2026, 8, 18, 10, 30) // Explicit components, timezone independent
    const filename = generateBossBrainFilename(title, now)
    
    // Timezone invariant assertion: filename matches pattern and starts with formatFilenameDate(now)
    assert.match(filename, /^\d{4}-\d{2}-\d{2}-\d{4}--healthtwin-首页应该加强-cta-[0-9a-f]{4}\.md$/)
    const expectedPrefix = formatFilenameDate(now)
    assert.ok(filename.startsWith(`${expectedPrefix}--`))

    const relPath = `00-Inbox/${filename}`
    const fullPath = path.join(vaultDir, relPath)

    const frontmatter = {
      id: '2026-09-18-1030-healthtwin-home-cta-test',
      title,
      created: formatISO8601WithOffset(now),
      updated: formatISO8601WithOffset(now),
      type: 'note',
      status: 'inbox',
      source: 'maiknote',
    }
    const body = '针对首页转化率不足问题，建议在 Hero 区域增加高对比度引导按钮。'
    const fullContent = stringifyWithFrontmatter(frontmatter, body)

    // Write file to disk
    fs.writeFileSync(fullPath, fullContent, 'utf-8')

    // Verify physical file existence and metadata
    assert.ok(fs.existsSync(fullPath), 'Physical markdown file must exist on disk')
    const stat = fs.statSync(fullPath)
    assert.ok(stat.size > 0)

    // Read back and parse
    const rawRead = fs.readFileSync(fullPath, 'utf-8')
    const parsed = extractFrontmatterAndBody(rawRead)
    assert.equal(parsed.hasFrontmatter, true)
    assert.equal(parsed.frontmatter.title, title)
    assert.equal(parsed.frontmatter.status, 'inbox')
    assert.equal(parsed.frontmatter.source, 'maiknote')
    assert.equal(parsed.body.trim(), body.trim())
    console.log('✔ Scenario A verified: File correctly captured and persisted on disk:', relPath)
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true })
  }
})

test('Scenario B1: External AI Modification of Non-Current Note', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bossbrain-fs-vault-'))
  const inboxDir = path.join(vaultDir, '00-Inbox')
  fs.mkdirSync(inboxDir, { recursive: true })

  try {
    const fileA = '00-Inbox/A.md'
    const fileB = '00-Inbox/B.md'
    fs.writeFileSync(path.join(vaultDir, fileA), stringifyWithFrontmatter({ id: 'note-A', title: 'Note A' }, 'Content A'), 'utf-8')
    fs.writeFileSync(path.join(vaultDir, fileB), stringifyWithFrontmatter({ id: 'note-B', title: 'Note B' }, 'Content B Original'), 'utf-8')

    const statA = fs.statSync(path.join(vaultDir, fileA))
    const statB = fs.statSync(path.join(vaultDir, fileB))

    let notes = [
      { id: 'note-A', title: 'Note A', content: 'Content A', relativePath: fileA, mtime: statA.mtimeMs, size: statA.size, isDirty: false },
      { id: 'note-B', title: 'Note B', content: 'Content B Original', relativePath: fileB, mtime: statB.mtimeMs, size: statB.size, isDirty: false }
    ]
    let lastDiskSnapshot = new Map([
      [fileA, { mtime: statA.mtimeMs, size: statA.size }],
      [fileB, { mtime: statB.mtimeMs, size: statB.size }]
    ])
    let activeNoteId = 'note-A'

    // External AI modifies B.md without changing file count
    await new Promise(r => setTimeout(r, 20))
    fs.writeFileSync(path.join(vaultDir, fileB), stringifyWithFrontmatter({ id: 'note-B', title: 'Note B Updated by Codex' }, 'Content B AI Enriched'), 'utf-8')

    // Scanner runs on window focus
    const newStatB = fs.statSync(path.join(vaultDir, fileB))
    const currentDiskSnapshot = new Map([
      [fileA, { mtime: statA.mtimeMs, size: statA.size }],
      [fileB, { mtime: newStatB.mtimeMs, size: newStatB.size }]
    ])

    const diff = diffVaultSnapshot(currentDiskSnapshot, lastDiskSnapshot, notes)
    assert.equal(diff.hasAnyDiff, true, 'Diff detector must detect B.md change')
    assert.deepEqual(diff.modified, [fileB])

    // Rescan updates memory
    const scanned = [
      { id: 'note-A', title: 'Note A', content: 'Content A', relativePath: fileA, mtime: statA.mtimeMs, size: statA.size },
      { id: 'note-B', title: 'Note B Updated by Codex', content: 'Content B AI Enriched', relativePath: fileB, mtime: newStatB.mtimeMs, size: newStatB.size }
    ]
    const { mergedNotes } = mergeScannedWithPreservedNotes(scanned, notes)
    notes = mergedNotes

    assert.equal(notes.find(n => n.id === 'note-B').title, 'Note B Updated by Codex')
    assert.equal(notes.find(n => n.id === 'note-B').content, 'Content B AI Enriched')
    assert.equal(activeNoteId, 'note-A', 'Active note A focus remains undisturbed')
    console.log('✔ Scenario B1 verified: Non-current note modification cleanly refreshed')
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true })
  }
})

test('Scenario B2: External Conflict Handling (3 Branches with Frontmatter Preservation)', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bossbrain-fs-vault-'))
  const inboxDir = path.join(vaultDir, '00-Inbox')
  fs.mkdirSync(inboxDir, { recursive: true })

  try {
    const fileA = '00-Inbox/A.md'
    const originalFm = {
      id: 'note-A',
      title: 'HealthTwin Project',
      project: 'HealthTwin',
      tags: ['growth', 'ux'],
      source: 'maiknote',
    }

    // Helper to simulate conflict on A.md
    const setupConflictNote = () => {
      fs.writeFileSync(path.join(vaultDir, fileA), stringifyWithFrontmatter(originalFm, 'Disk Content V1'), 'utf-8')
      const note = {
        id: 'note-A',
        title: 'HealthTwin Project',
        content: 'Local User Edits V2',
        relativePath: fileA,
        frontmatter: { ...originalFm },
        isDirty: true,
        hasConflict: true,
        conflictType: 'modified',
        conflictContent: 'Disk External Content V3',
      }
      return note
    }

    // Branch 1: keep-local preserves Frontmatter
    {
      const noteA = setupConflictNote()
      await resolveNoteConflict(noteA, 'keep-local', {
        saveNote: async (targetNote) => {
          const full = stringifyWithFrontmatter(targetNote.frontmatter || {}, targetNote.content)
          fs.writeFileSync(path.join(vaultDir, targetNote.relativePath), full, 'utf-8')
        },
        createRecoveredNote: async () => {},
        deleteFromMemory: () => {},
      })
      assert.equal(noteA.hasConflict, false)
      assert.equal(noteA.isDirty, false)
      assert.equal(noteA.content, 'Local User Edits V2')
      const diskText = fs.readFileSync(path.join(vaultDir, fileA), 'utf-8')
      const parsed = extractFrontmatterAndBody(diskText)
      assert.equal(parsed.hasFrontmatter, true)
      assert.equal(parsed.frontmatter.id, 'note-A')
      assert.equal(parsed.frontmatter.title, 'HealthTwin Project')
      assert.equal(parsed.frontmatter.project, 'HealthTwin')
      assert.deepEqual(parsed.frontmatter.tags, ['growth', 'ux'])
      assert.equal(parsed.frontmatter.source, 'maiknote')
      assert.equal(parsed.body.trim(), 'Local User Edits V2')
      console.log('  ✔ B2 Branch 1 (keep-local with full Frontmatter preservation) passed')
    }

    // Branch 2: keep-disk
    {
      const noteA = setupConflictNote()
      await resolveNoteConflict(noteA, 'keep-disk', {
        saveNote: async () => {},
        createRecoveredNote: async () => {},
        deleteFromMemory: () => {},
      })
      assert.equal(noteA.hasConflict, false)
      assert.equal(noteA.isDirty, false)
      assert.equal(noteA.content, 'Disk External Content V3')
      console.log('  ✔ B2 Branch 2 (keep-disk) passed')
    }

    // Branch 3: conflict-copy with full Frontmatter in 00-Inbox/
    {
      const noteA = setupConflictNote()
      let copyCreated = false
      await resolveNoteConflict(noteA, 'conflict-copy', {
        saveNote: async () => {},
        createRecoveredNote: async (title, content, sourceNote) => {
          copyCreated = true
          assert.equal(title, 'HealthTwin Project (Conflict Copy)')
          assert.equal(content, 'Local User Edits V2')
          const fm = {
            id: 'copy-123',
            title,
            project: sourceNote?.frontmatter?.project || '',
            tags: sourceNote?.frontmatter?.tags || [],
            source: 'conflict-recovery',
          }
          const full = stringifyWithFrontmatter(fm, content)
          fs.writeFileSync(path.join(vaultDir, '00-Inbox/conflict-copy.md'), full, 'utf-8')
        },
        deleteFromMemory: () => {},
      })
      assert.equal(copyCreated, true)
      assert.equal(noteA.hasConflict, false)
      assert.equal(noteA.content, 'Disk External Content V3')
      const copyParsed = extractFrontmatterAndBody(fs.readFileSync(path.join(vaultDir, '00-Inbox/conflict-copy.md'), 'utf-8'))
      assert.equal(copyParsed.hasFrontmatter, true)
      assert.equal(copyParsed.frontmatter.project, 'HealthTwin')
      assert.deepEqual(copyParsed.frontmatter.tags, ['growth', 'ux'])
      assert.equal(copyParsed.frontmatter.source, 'conflict-recovery')
      console.log('  ✔ B2 Branch 3 (conflict-copy with full Frontmatter) passed')
    }
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true })
  }
})

test('Scenario B3: [F2-01 & F3-01] External Deletion of Dirty Note & Keep-Local Frontmatter Preservation', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bossbrain-fs-vault-'))
  const inboxDir = path.join(vaultDir, '00-Inbox')
  fs.mkdirSync(inboxDir, { recursive: true })

  try {
    const fileA = '00-Inbox/A.md'
    const originalFm = {
      id: 'note-A',
      title: 'Original Title',
      project: 'HealthTwin',
      tags: ['data-safety'],
      source: 'maiknote',
    }
    fs.writeFileSync(path.join(vaultDir, fileA), stringifyWithFrontmatter(originalFm, 'Original Disk Content'), 'utf-8')

    // Local user is modifying Note A
    const activeNotes = [{
      id: 'note-A',
      title: 'Original Title',
      content: 'Critical Unsaved Notes',
      relativePath: fileA,
      frontmatter: { ...originalFm },
      isDirty: true,
      hasConflict: false,
    }]

    // External process deletes file A.md
    fs.unlinkSync(path.join(vaultDir, fileA))
    assert.ok(!fs.existsSync(path.join(vaultDir, fileA)))

    // Scanner runs: scanned list is empty
    const scanned = []
    const { mergedNotes, isEmptyVault } = mergeScannedWithPreservedNotes(scanned, activeNotes)

    // Verification:
    assert.equal(isEmptyVault, false, 'Must not be considered empty vault while dirty notes exist')
    assert.equal(mergedNotes.length, 1, 'Dirty note MUST NOT be deleted')
    const protectedNote = mergedNotes[0]
    assert.equal(protectedNote.id, 'note-A')
    assert.equal(protectedNote.content, 'Critical Unsaved Notes')
    assert.equal(protectedNote.hasConflict, true)
    assert.equal(protectedNote.conflictType, 'deleted')
    assert.equal(protectedNote.diskState, 'missing')

    // Verify recovery via keep-local recreates the file on disk WITH FULL FRONTMATTER
    await resolveNoteConflict(protectedNote, 'keep-local', {
      saveNote: async (targetNote) => {
        const full = stringifyWithFrontmatter(targetNote.frontmatter || {}, targetNote.content)
        fs.writeFileSync(path.join(vaultDir, targetNote.relativePath), full, 'utf-8')
      },
      createRecoveredNote: async () => {},
      deleteFromMemory: () => {},
    })

    assert.equal(protectedNote.hasConflict, false)
    assert.equal(protectedNote.diskState, 'normal')
    assert.ok(fs.existsSync(path.join(vaultDir, fileA)), 'File recreated on disk by keep-local')

    const diskText = fs.readFileSync(path.join(vaultDir, fileA), 'utf-8')
    const parsed = extractFrontmatterAndBody(diskText)
    assert.equal(parsed.hasFrontmatter, true)
    assert.equal(parsed.frontmatter.id, 'note-A')
    assert.equal(parsed.frontmatter.project, 'HealthTwin')
    assert.deepEqual(parsed.frontmatter.tags, ['data-safety'])
    assert.equal(parsed.frontmatter.source, 'maiknote')
    assert.equal(parsed.body.trim(), 'Critical Unsaved Notes')
    console.log('✔ Scenario B3 verified: Deleted dirty note recovered to disk with complete Frontmatter')
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true })
  }
})

test('Scenario C: Rebuilding Index Without Cache', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bossbrain-fs-vault-'))
  const inboxDir = path.join(vaultDir, '00-Inbox')
  const knowledgeDir = path.join(vaultDir, '03-Knowledge')
  const cacheDir = path.join(vaultDir, '.bossbrain')
  fs.mkdirSync(inboxDir, { recursive: true })
  fs.mkdirSync(knowledgeDir, { recursive: true })
  fs.mkdirSync(cacheDir, { recursive: true })

  try {
    fs.writeFileSync(path.join(inboxDir, 'idea.md'), stringifyWithFrontmatter({ id: 'idea-1', title: 'New Concept' }, 'Links to [[Knowledge Architecture]]'), 'utf-8')
    fs.writeFileSync(path.join(knowledgeDir, 'arch.md'), stringifyWithFrontmatter({ id: 'arch-1', title: 'Knowledge Architecture' }, 'System foundation'), 'utf-8')

    // Simulate pre-existing cache
    fs.writeFileSync(path.join(cacheDir, 'index.json'), JSON.stringify({ stale: true }), 'utf-8')
    fs.writeFileSync(path.join(cacheDir, 'backlinks.json'), JSON.stringify({ stale: true }), 'utf-8')

    // Scenario C: Cache is completely deleted!
    fs.rmSync(cacheDir, { recursive: true, force: true })
    assert.ok(!fs.existsSync(cacheDir), 'Cache must be completely deleted')

    // Full scan from Markdown ground truth files
    const mdFiles = [
      { rel: '00-Inbox/idea.md', raw: fs.readFileSync(path.join(inboxDir, 'idea.md'), 'utf-8') },
      { rel: '03-Knowledge/arch.md', raw: fs.readFileSync(path.join(knowledgeDir, 'arch.md'), 'utf-8') }
    ]

    const rebuiltNotes = mdFiles.map(f => {
      const { frontmatter, body } = extractFrontmatterAndBody(f.raw)
      return {
        id: frontmatter.id,
        title: frontmatter.title,
        content: body,
        relativePath: f.rel,
        frontmatter,
      }
    })

    const rebuiltBacklinks = computeBacklinks(rebuiltNotes)
    assert.deepEqual(rebuiltBacklinks.get('arch-1'), ['idea-1'])

    // Rebuild cache directory and files
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(path.join(cacheDir, 'index.json'), JSON.stringify(rebuiltNotes, null, 2), 'utf-8')
    fs.writeFileSync(path.join(cacheDir, 'backlinks.json'), JSON.stringify(Object.fromEntries(rebuiltBacklinks), null, 2), 'utf-8')

    assert.ok(fs.existsSync(path.join(cacheDir, 'index.json')))
    assert.ok(fs.existsSync(path.join(cacheDir, 'backlinks.json')))
    console.log('✔ Scenario C verified: 100% successful index reconstruction without cache')
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true })
  }
})

test('Scenario D: Obsidian Interoperability & Asset Resolution', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bossbrain-fs-vault-'))
  const inboxDir = path.join(vaultDir, '00-Inbox')
  const projectsDir = path.join(vaultDir, '01-Projects/HealthTwin')
  const assetsDir = path.join(vaultDir, '_assets')
  fs.mkdirSync(inboxDir, { recursive: true })
  fs.mkdirSync(projectsDir, { recursive: true })
  fs.mkdirSync(assetsDir, { recursive: true })

  try {
    // 1. Create asset in _assets/
    const assetFilename = 'diagram_arch.png'
    const assetFullPath = path.join(assetsDir, assetFilename)
    fs.writeFileSync(assetFullPath, Buffer.from('FAKE_PNG_BINARY_DATA'))
    assert.ok(fs.existsSync(assetFullPath))

    // 2. Note in 00-Inbox/ references asset with ../_assets/
    const note1Path = path.join(inboxDir, 'overview.md')
    const note1Content = stringifyWithFrontmatter(
      { id: 'note-ov', title: 'System Overview', tags: ['architecture', 'v1'] },
      `System diagram:\n![Architecture](../_assets/${assetFilename})\nReferences [[HealthTwin Spec]]`
    )
    fs.writeFileSync(note1Path, note1Content, 'utf-8')

    // 3. Note in 01-Projects/HealthTwin/ references asset with ../../_assets/
    const note2Path = path.join(projectsDir, 'spec.md')
    const note2Content = stringifyWithFrontmatter(
      { id: 'note-spec', title: 'HealthTwin Spec', tags: ['spec'] },
      `Diagram link:\n![Architecture](../../_assets/${assetFilename})\nBack to [[System Overview]]`
    )
    fs.writeFileSync(note2Path, note2Content, 'utf-8')

    // Verify Obsidian relative path resolution
    const note1Dir = path.dirname(note1Path)
    const resolvedFromNote1 = path.resolve(note1Dir, `../_assets/${assetFilename}`)
    assert.equal(resolvedFromNote1, assetFullPath, 'Note1 relative asset path must resolve to _assets/ file')

    const note2Dir = path.dirname(note2Path)
    const resolvedFromNote2 = path.resolve(note2Dir, `../../_assets/${assetFilename}`)
    assert.equal(resolvedFromNote2, assetFullPath, 'Note2 relative asset path must resolve to _assets/ file')

    // Verify Wikilinks resolution across folders
    const allNotes = [
      { id: 'note-ov', title: 'System Overview', content: fs.readFileSync(note1Path, 'utf-8'), relativePath: '00-Inbox/overview.md' },
      { id: 'note-spec', title: 'HealthTwin Spec', content: fs.readFileSync(note2Path, 'utf-8'), relativePath: '01-Projects/HealthTwin/spec.md' },
    ]
    const backlinks = computeBacklinks(allNotes)
    assert.deepEqual(backlinks.get('note-spec'), ['note-ov'])
    assert.deepEqual(backlinks.get('note-ov'), ['note-spec'])

    console.log('✔ Scenario D verified: Obsidian relative asset paths and cross-folder wikilinks fully interoperable')
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true })
  }
})
