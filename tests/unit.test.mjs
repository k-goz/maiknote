import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { load, dump } from 'js-yaml'

// --- Unit under test imports / definitions matching src/utils ---

function extractFrontmatterAndBody(content) {
  const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
  const trimmed = content || ''
  const match = trimmed.match(FRONTMATTER_REGEX)

  if (!match) {
    return { frontmatter: {}, body: trimmed, hasFrontmatter: false }
  }

  const yamlText = match[1]
  const body = trimmed.slice(match[0].length).replace(/^\r?\n/, '')

  try {
    const parsed = load(yamlText)
    if (parsed && typeof parsed === 'object') {
      return { frontmatter: parsed, body, hasFrontmatter: true }
    }
  } catch (err) {
    // fallback
  }

  return { frontmatter: {}, body: trimmed, hasFrontmatter: false }
}

function stringifyWithFrontmatter(frontmatter, body) {
  const cleanFm = {}
  for (const [key, val] of Object.entries(frontmatter)) {
    if (val !== undefined && val !== null) {
      cleanFm[key] = val
    }
  }

  if (Object.keys(cleanFm).length === 0) {
    return body || ''
  }

  const yamlStr = dump(cleanFm, {
    lineWidth: -1,
    noRefs: true,
    forceQuotes: false,
  }).trim()

  const trimmedBody = body !== undefined ? body : ''
  return `---\n${yamlStr}\n---\n\n${trimmedBody}`
}

function slugify(text) {
  if (!text) return 'untitled'
  let cleaned = text.replace(/^[#*>\-\s]+/, '').trim()
  cleaned = cleaned.split('\n')[0].trim()
  const slug = cleaned
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return slug.substring(0, 40) || 'untitled'
}

function generateBossBrainFilename(title, date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  const datePrefix = `${y}-${m}-${d}-${h}${min}`
  const slug = slugify(title)
  return `${datePrefix}--${slug}-a82c.md`
}

function extractWikilinks(content) {
  if (!content) return []
  const WIKILINK_REGEX = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g
  const links = []
  const matches = content.matchAll(WIKILINK_REGEX)
  for (const m of matches) {
    links.push({
      raw: m[0],
      target: m[1].trim(),
      heading: m[2]?.trim(),
      alias: m[3]?.trim(),
    })
  }
  return links
}

function resolveWikilinkTarget(target, notes) {
  if (!target) return null
  const norm = target.trim().toLowerCase().replace(/[-_\s]+/g, ' ')

  // 1 & 2: Title match
  const titleMatch = notes.find(n => n.title.trim().toLowerCase().replace(/[-_\s]+/g, ' ') === norm)
  if (titleMatch) return titleMatch

  // 3: ID match
  const idMatch = notes.find(n => n.id === target || n.id.toLowerCase() === norm)
  if (idMatch) return idMatch

  // 4: Alias match
  const aliasMatch = notes.find(n => {
    const aliases = n.frontmatter?.aliases
    return Array.isArray(aliases) && aliases.some(a => String(a).trim().toLowerCase() === norm)
  })
  if (aliasMatch) return aliasMatch

  // 5: File match
  const fileMatch = notes.find(n => {
    if (!n.relativePath) return false
    const base = n.relativePath.split('/').pop().replace(/\.md$/i, '')
    return base.toLowerCase().includes(norm)
  })
  if (fileMatch) return fileMatch

  return null
}

function computeBacklinks(notes) {
  const map = new Map()
  for (const n of notes) {
    map.set(n.id, new Set())
  }
  for (const note of notes) {
    const links = extractWikilinks(note.content)
    for (const link of links) {
      const targetNote = resolveWikilinkTarget(link.target, notes)
      if (targetNote && targetNote.id !== note.id) {
        if (!map.has(targetNote.id)) map.set(targetNote.id, new Set())
        map.get(targetNote.id).add(note.id)
      }
    }
  }
  const result = new Map()
  for (const [id, set] of map.entries()) {
    result.set(id, Array.from(set))
  }
  return result
}

function safeVaultPathValidate(relPath) {
  if (!relPath || relPath.trim() === '') {
    throw new Error('Relative path cannot be empty')
  }
  if (relPath.startsWith('/') || relPath.startsWith('\\') || path.isAbsolute(relPath)) {
    throw new Error('Relative path cannot be absolute')
  }
  const normalized = path.normalize(relPath)
  if (normalized.startsWith('..') || normalized.includes('/../') || normalized.includes('\\..\\')) {
    throw new Error('Relative path cannot escape vault root')
  }
  return true
}

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

test('[UNIT] 2. Slug and Filename Generation', () => {
  const title = 'HealthTwin 首页应该加强 CTA'
  const filename = generateBossBrainFilename(title, new Date(2026, 8, 17, 23, 42))
  assert.equal(filename, '2026-09-17-2342--healthtwin-首页应该加强-cta-a82c.md')
})

test('[UNIT] 3. Wikilinks Extraction', () => {
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

test('[UNIT] 4. Wikilink Target Resolution and Backlinks', () => {
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

test('[UNIT] 5. [F1-05] Path Traversal Validation Logic', () => {
  assert.throws(() => safeVaultPathValidate(''), /Relative path cannot be empty/)
  assert.throws(() => safeVaultPathValidate('/etc/passwd'), /Relative path cannot be absolute/)
  assert.throws(() => safeVaultPathValidate('../secret.txt'), /Relative path cannot escape vault root/)
  assert.throws(() => safeVaultPathValidate('00-Inbox/../../secret.txt'), /Relative path cannot escape vault root/)
  assert.equal(safeVaultPathValidate('00-Inbox/2026-09-17-note.md'), true)
  assert.equal(safeVaultPathValidate('01-Projects/HealthTwin/spec.md'), true)
})
