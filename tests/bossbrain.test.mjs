import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { extractFrontmatterAndBody, stringifyWithFrontmatter } from '../src/utils/frontmatter.ts'
import { slugify, generateBossBrainFilename, formatFilenameDate, formatISO8601WithOffset } from '../src/utils/slug.ts'
import { extractWikilinks, resolveWikilinkTarget, computeBacklinks } from '../src/utils/wikilink.ts'

// --- Test Suites ---

test('1. YAML Frontmatter Parse & Stringify', () => {
  const originalFm = {
    id: '2026-09-17-2342-healthtwin-home-cta-a82c',
    title: 'HealthTwin 首页应该加强 CTA',
    created: '2026-09-17T23:42:00+08:00',
    updated: '2026-09-17T23:42:00+08:00',
    type: 'note',
    status: 'inbox',
    project: 'HealthTwin',
    tags: ['ux', 'growth'],
    source: 'maiknote',
  }
  const body = 'HealthTwin 首页应该加强 CTA，提升转化率。'
  const markdown = stringifyWithFrontmatter(originalFm, body)

  assert.ok(markdown.startsWith('---\n'))
  assert.ok(markdown.includes('HealthTwin 首页应该加强 CTA'))

  const parsed = extractFrontmatterAndBody(markdown)
  assert.equal(parsed.hasFrontmatter, true)
  assert.equal(parsed.frontmatter.id, originalFm.id)
  assert.equal(parsed.frontmatter.title, originalFm.title)
  assert.deepEqual(parsed.frontmatter.tags, ['ux', 'growth'])
  assert.equal(parsed.frontmatter.project, 'HealthTwin')
  assert.equal(parsed.body.trim(), body.trim())
})

test('2. Slug and Filename Generation', () => {
  const title = 'HealthTwin 首页应该加强 CTA'
  const filename = generateBossBrainFilename(title, new Date(2026, 8, 17, 23, 42))
  assert.match(filename, /^2026-09-17-2342--healthtwin-首页应该加强-cta-[0-9a-f]{4}\.md$/)
})

test('3. Wikilinks Extraction and Disambiguation', () => {
  const content = `
  参见 [[HealthTwin]] 以及 [[HealthTwin|健康数字孪生]]，
  另外查看 [[上传流程#步骤二]] 和普通文本 [链接](https://example.com)。
  `
  const links = extractWikilinks(content)
  assert.equal(links.length, 3)
  assert.equal(links[0].target, 'HealthTwin')
  assert.equal(links[1].target, 'HealthTwin')
  assert.equal(links[1].alias, '健康数字孪生')
  assert.equal(links[2].target, '上传流程')
  assert.equal(links[2].heading, '步骤二')
})

test('4. Wikilink Target Resolution and Backlinks', () => {
  const notes = [
    {
      id: 'note-1',
      title: 'HealthTwin',
      content: '主项目页面，引用了 [[上传流程设计]]',
      relativePath: '01-Projects/HealthTwin/README.md',
      frontmatter: { aliases: ['数字孪生'] },
    },
    {
      id: 'note-2',
      title: '首页 CTA 改造',
      content: '基于 [[数字孪生]] 增加引导按钮，详见 [[上传流程设计#接口]]',
      relativePath: '00-Inbox/cta.md',
      frontmatter: {},
    },
    {
      id: 'note-3',
      title: '上传流程设计',
      content: '核心上传管道说明',
      relativePath: '03-Knowledge/upload.md',
      frontmatter: {},
    },
  ]

  // Test target resolution
  const matchedByTitle = resolveWikilinkTarget('HealthTwin', notes)
  assert.equal(matchedByTitle?.id, 'note-1')

  const matchedByAlias = resolveWikilinkTarget('数字孪生', notes)
  assert.equal(matchedByAlias?.id, 'note-1')

  const matchedNonExistent = resolveWikilinkTarget('NonExistentNote', notes)
  assert.equal(matchedNonExistent, null)

  // Test backlink computation
  const backlinks = computeBacklinks(notes)
  // note-3 is linked by note-1 and note-2
  assert.deepEqual(backlinks.get('note-3')?.sort(), ['note-1', 'note-2'])
  // note-1 is linked by note-2 (via alias '数字孪生')
  assert.deepEqual(backlinks.get('note-1'), ['note-2'])
  // note-2 has 0 backlinks
  assert.deepEqual(backlinks.get('note-2'), [])
})

test('5. Rebuild Index from Markdown without Cache (Scenario E)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bossbrain-test-'))
  const inboxDir = path.join(tempDir, '00-Inbox')
  const systemDir = path.join(tempDir, '_system')
  const cacheDir = path.join(tempDir, '.bossbrain')
  fs.mkdirSync(inboxDir, { recursive: true })
  fs.mkdirSync(systemDir, { recursive: true })
  fs.mkdirSync(cacheDir, { recursive: true })

  // Write markdown note with frontmatter
  const noteFile = path.join(inboxDir, '2026-09-17-2342--cta.md')
  const fm = {
    id: 'test-note-1',
    title: 'HealthTwin 首页应该加强 CTA',
    created: '2026-09-17T23:42:00+08:00',
    updated: '2026-09-17T23:42:00+08:00',
    type: 'note',
    status: 'inbox',
    project: 'HealthTwin',
    tags: ['cta', 'ui'],
  }
  fs.writeFileSync(noteFile, stringifyWithFrontmatter(fm, '正文内容，关于 CTA'))

  // Write cache file
  const cacheFile = path.join(cacheDir, 'index.json')
  fs.writeFileSync(cacheFile, JSON.stringify({ version: 1, items: {} }))

  // Simulate cache deletion
  fs.unlinkSync(cacheFile)
  assert.equal(fs.existsSync(cacheFile), false)

  // Re-scan from disk
  const files = fs.readdirSync(inboxDir)
  assert.equal(files.length, 1)

  const raw = fs.readFileSync(path.join(inboxDir, files[0]), 'utf-8')
  const parsed = extractFrontmatterAndBody(raw)

  assert.equal(parsed.frontmatter.title, 'HealthTwin 首页应该加强 CTA')
  assert.equal(parsed.frontmatter.project, 'HealthTwin')
  assert.deepEqual(parsed.frontmatter.tags, ['cta', 'ui'])
  assert.equal(parsed.body.trim(), '正文内容，关于 CTA')

  // Clean up
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('6. Legacy Migration Safety (Strictly Copy, No Deletion)', () => {
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-maiknote-'))
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-target-'))
  fs.mkdirSync(path.join(vaultDir, '00-Inbox'), { recursive: true })

  // Create legacy metadata.json and note file
  const legacyNoteId = 'legacy-uuid-1234'
  const legacyMeta = {
    version: 1,
    notes: [
      {
        id: legacyNoteId,
        title: '旧笔记标题',
        createdAt: 1726500000000,
        updatedAt: 1726500000000,
        tags: ['legacy'],
        isPinned: false,
        isLocked: false,
      }
    ]
  }
  fs.writeFileSync(path.join(legacyDir, 'metadata.json'), JSON.stringify(legacyMeta))
  fs.writeFileSync(path.join(legacyDir, `note_${legacyNoteId}.md`), '# 旧笔记内容\n保留完整')

  // Perform migration (Copy and Convert)
  const meta = JSON.parse(fs.readFileSync(path.join(legacyDir, 'metadata.json'), 'utf-8'))
  for (const item of meta.notes) {
    const rawContent = fs.readFileSync(path.join(legacyDir, `note_${item.id}.md`), 'utf-8')
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
    const converted = stringifyWithFrontmatter(fm, rawContent)
    fs.writeFileSync(path.join(vaultDir, '00-Inbox', `migrated_${item.id}.md`), converted)
  }

  // Verification 1: Legacy source files remain 100% untouched
  assert.ok(fs.existsSync(path.join(legacyDir, 'metadata.json')))
  assert.ok(fs.existsSync(path.join(legacyDir, `note_${legacyNoteId}.md`)))
  assert.equal(fs.readFileSync(path.join(legacyDir, `note_${legacyNoteId}.md`), 'utf-8'), '# 旧笔记内容\n保留完整')

  // Verification 2: Converted file exists in target vault with valid frontmatter
  const targetFiles = fs.readdirSync(path.join(vaultDir, '00-Inbox'))
  assert.equal(targetFiles.length, 1)
  const convertedRaw = fs.readFileSync(path.join(vaultDir, '00-Inbox', targetFiles[0]), 'utf-8')
  const convertedParsed = extractFrontmatterAndBody(convertedRaw)
  assert.equal(convertedParsed.frontmatter.title, '旧笔记标题')
  assert.equal(convertedParsed.frontmatter.source, 'maiknote-migration')
  assert.ok(convertedParsed.body.includes('# 旧笔记内容'))

  // Clean up
  fs.rmSync(legacyDir, { recursive: true, force: true })
  fs.rmSync(vaultDir, { recursive: true, force: true })
})
