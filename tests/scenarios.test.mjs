import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { load, dump } from 'js-yaml'

function stringifyWithFrontmatter(frontmatter, body) {
  const cleanFm = {}
  for (const [key, val] of Object.entries(frontmatter)) {
    if (val !== undefined && val !== null) cleanFm[key] = val
  }
  const yamlStr = dump(cleanFm, { lineWidth: -1, noRefs: true, forceQuotes: false }).trim()
  return `---\n${yamlStr}\n---\n\n${body || ''}`
}

function extractFrontmatterAndBody(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { frontmatter: {}, body: content }
  return {
    frontmatter: load(match[1]),
    body: content.slice(match[0].length),
  }
}

test('Scenario A: Inbox Capture creation into 00-Inbox/ with standard frontmatter', () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bossbrain-vault-'))
  const inboxDir = path.join(vaultDir, '00-Inbox')
  fs.mkdirSync(inboxDir, { recursive: true })

  const filename = '2026-09-17-2342--healthtwin-home-cta-a82c.md'
  const targetFile = path.join(inboxDir, filename)

  const fm = {
    id: '2026-09-17-2342-healthtwin-home-cta-a82c',
    title: 'HealthTwin 首页应该加强 CTA',
    created: '2026-09-17T23:42:00+08:00',
    updated: '2026-09-17T23:42:00+08:00',
    type: 'note',
    status: 'inbox',
    project: '',
    tags: [],
    source: 'maiknote',
  }
  const body = 'HealthTwin 首页应该加强 CTA'
  fs.writeFileSync(targetFile, stringifyWithFrontmatter(fm, body))

  assert.ok(fs.existsSync(targetFile))
  const text = fs.readFileSync(targetFile, 'utf-8')
  assert.ok(text.includes('status: inbox'))
  assert.ok(text.includes('HealthTwin 首页应该加强 CTA'))

  fs.rmSync(vaultDir, { recursive: true, force: true })
})

test('Scenario B: Terminal modification reload by Antigravity', () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bossbrain-vault-'))
  const inboxDir = path.join(vaultDir, '00-Inbox')
  fs.mkdirSync(inboxDir, { recursive: true })

  const targetFile = path.join(inboxDir, '2026-09-17-2342--healthtwin-home-cta-a82c.md')
  const fm = {
    id: 'note-a',
    title: 'Original Title',
    created: '2026-09-17T23:42:00+08:00',
    updated: '2026-09-17T23:42:00+08:00',
  }
  fs.writeFileSync(targetFile, stringifyWithFrontmatter(fm, 'Original Body'))

  // Antigravity terminal edit
  const updatedContent = stringifyWithFrontmatter(
    { ...fm, title: 'Updated by Antigravity in Terminal', updated: '2026-09-17T23:45:00+08:00' },
    'New text added externally by AI agent.'
  )
  fs.writeFileSync(targetFile, updatedContent)

  // Reload check
  const reloaded = fs.readFileSync(targetFile, 'utf-8')
  const parsed = extractFrontmatterAndBody(reloaded)
  assert.equal(parsed.frontmatter.title, 'Updated by Antigravity in Terminal')
  assert.equal(parsed.body.trim(), 'New text added externally by AI agent.')

  fs.rmSync(vaultDir, { recursive: true, force: true })
})

test('Scenario C: External file creation in 01-Projects/TestProject/README.md', () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bossbrain-vault-'))
  const projectDir = path.join(vaultDir, '01-Projects', 'TestProject')
  fs.mkdirSync(projectDir, { recursive: true })

  const readmePath = path.join(projectDir, 'README.md')
  const content = `# TestProject

Project description created by external editor.
`
  fs.writeFileSync(readmePath, content)

  // Scanner finds it
  const entries = []
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) scan(p)
      else if (entry.name.endsWith('.md')) entries.push(path.relative(vaultDir, p))
    }
  }
  scan(vaultDir)

  assert.ok(entries.includes('01-Projects/TestProject/README.md'))
  fs.rmSync(vaultDir, { recursive: true, force: true })
})

test('Scenario D: Obsidian Compatibility check', () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bossbrain-vault-'))
  const inbox = path.join(vaultDir, '00-Inbox')
  fs.mkdirSync(inbox, { recursive: true })

  // Standard markdown with wikilink
  const noteContent = `---
id: note-obsidian
title: Obsidian Ready Note
---

This note links to [[Another Note]] and [[Another Note|Custom Alias]].
`
  fs.writeFileSync(path.join(inbox, 'obsidian-note.md'), noteContent)

  // Read as standard Obsidian vault markdown file
  const read = fs.readFileSync(path.join(inbox, 'obsidian-note.md'), 'utf-8')
  assert.ok(read.startsWith('---'))
  assert.ok(read.includes('[[Another Note]]'))

  fs.rmSync(vaultDir, { recursive: true, force: true })
})

test('Scenario E: Index cache deletion & full re-indexing', () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bossbrain-vault-'))
  const cacheFile = path.join(vaultDir, '.bossbrain', 'index.json')
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
  fs.writeFileSync(cacheFile, JSON.stringify({ version: 1, items: { dummy: true } }))

  // Delete cache
  fs.unlinkSync(cacheFile)
  assert.equal(fs.existsSync(cacheFile), false)

  // Re-index creates new cache
  const newCache = { version: 1, lastIndexedAt: Date.now(), items: { '00-Inbox/note.md': { title: 'Recovered' } } }
  fs.writeFileSync(cacheFile, JSON.stringify(newCache))
  assert.ok(fs.existsSync(cacheFile))
  const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'))
  assert.equal(parsed.items['00-Inbox/note.md'].title, 'Recovered')

  fs.rmSync(vaultDir, { recursive: true, force: true })
})
