import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { extractFrontmatterAndBody, stringifyWithFrontmatter } from '../src/utils/frontmatter.ts'
import { slugify, generateBossBrainFilename, formatFilenameDate, formatISO8601WithOffset } from '../src/utils/slug.ts'
import { extractWikilinks, resolveWikilinkTarget, computeBacklinks } from '../src/utils/wikilink.ts'

// --- UNIT Tests ---

test('[UNIT] 1. YAML Frontmatter Parse & Stringify', () => {
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

test('[UNIT] 2. Slug and Filename Generation (from src/utils/slug.ts)', () => {
  const title = 'HealthTwin 首页应该加强 CTA'
  const filename = generateBossBrainFilename(title, new Date(2026, 8, 17, 23, 42))
  assert.match(filename, /^2026-09-17-2342--healthtwin-首页应该加强-cta-[0-9a-f]{4}\.md$/)
})

test('[UNIT] 3. Wikilinks Extraction (from src/utils/wikilink.ts)', () => {
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

test('[UNIT] 4. Wikilink Target Resolution and Backlinks (from src/utils/wikilink.ts)', () => {
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

  const matchedByTitle = resolveWikilinkTarget('HealthTwin', notes)
  assert.equal(matchedByTitle?.id, 'note-1')

  const matchedByAlias = resolveWikilinkTarget('数字孪生', notes)
  assert.equal(matchedByAlias?.id, 'note-1')

  const matchedNonExistent = resolveWikilinkTarget('NonExistentNote', notes)
  assert.equal(matchedNonExistent, null)

  const backlinks = computeBacklinks(notes)
  assert.deepEqual(backlinks.get('note-3')?.sort(), ['note-1', 'note-2'])
  assert.deepEqual(backlinks.get('note-1'), ['note-2'])
  assert.deepEqual(backlinks.get('note-2'), [])
})

test('[UNIT] 5. [F2-04] Asset relative path computation by note directory depth', () => {
  const computeRelAssetPath = (relPath, filename) => {
    const parts = relPath.split('/').filter(Boolean)
    const depth = parts.length > 1 ? parts.length - 1 : 0
    const prefix = depth > 0 ? '../'.repeat(depth) : ''
    return `${prefix}_assets/${filename}`
  }

  assert.equal(computeRelAssetPath('root-note.md', 'test.png'), '_assets/test.png')
  assert.equal(computeRelAssetPath('00-Inbox/note.md', 'test.png'), '../_assets/test.png')
  assert.equal(computeRelAssetPath('01-Projects/HealthTwin/spec.md', 'test.png'), '../../_assets/test.png')
})

test('[UNIT] 6. [F2-05] Disk-accurate byte length vs character length for UTF-8 Chinese characters', () => {
  const chineseText = '你好，世界！这是一条包含中文字符的测试笔记。'
  const charLength = chineseText.length
  const byteLength = Buffer.byteLength(chineseText, 'utf-8')

  // Chinese UTF-8 characters are 3 bytes each; byteLength > charLength
  assert.notEqual(charLength, byteLength)
  assert.equal(charLength, 22)
  assert.equal(byteLength, 66)

  // Demonstrates why disk size metadata must use byte length rather than text.length
  // to avoid spurious diff detections when comparing disk snapshot with in-memory size.
})

test('[UNIT] 7. [F3-03] Timezone-independent filename format invariant', () => {
  const title = 'HealthTwin 首页应该加强 CTA'
  const date = new Date(2026, 8, 18, 10, 30) // Explicit components
  const filename = generateBossBrainFilename(title, date)
  const expectedPrefix = formatFilenameDate(date)

  // Invariant 1: starts with formatFilenameDate
  assert.ok(filename.startsWith(`${expectedPrefix}--`))
  // Invariant 2: matches full regex structure YYYY-MM-DD-HHmm--<slug>-<hash>.md
  assert.match(filename, /^\d{4}-\d{2}-\d{2}-\d{4}--healthtwin-首页应该加强-cta-[0-9a-f]{4}\.md$/)
  // Invariant 3: ISO 8601 with offset contains timezone offset and is valid ISO date
  const iso = formatISO8601WithOffset(date)
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
})
