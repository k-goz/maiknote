import { useFileSystem } from '@/composables/useFileSystem'
import type { Note } from '@/types/note'
import { formatISO8601WithOffset } from '@/utils/slug'

export const DEFAULT_VAULT_SUBPATH = 'Library/Mobile Documents/com~apple~CloudDocs/BossBrain'

export const SYSTEM_AGENTS_MD = `# AGENTS.md — Boss Brain Agent Protocol

Welcome, Agent (Codex / Antigravity / Claude Code).
This knowledge vault is the **durable long-term source of truth** for this system.

## 1. Guiding Philosophy
- **Files are truth, indexes are cache**: Every durable fact or decision is stored in human-readable Markdown with YAML frontmatter.
- **Minimal Context**: Do NOT ingest the entire vault into your working context. 
- **Read _system/INDEX.md first**: Locate the target project, area, or knowledge topic, and read only the necessary files.
- **Durable value only**: Do not write temporary logs, verbose compiler output, secrets, or chat transcripts into the vault.

## 2. Agent Workflow
1. **Start of Task**:
   - Read \`_system/INDEX.md\` to orient yourself.
   - Navigate to relevant project or topic.
   - Read specific documentation notes.
2. **Execution**:
   - Perform your software engineering or research task.
3. **Task Completion / Memory Review**:
   - Ask yourself: Did this session produce a **durable decision**, **validated learning**, **architecture choice**, or **status change**?
   - If NO: Do not write anything to the vault.
   - If YES: Update the designated note or create a new note in the appropriate folder (e.g. \`01-Projects/<name>/STATUS.md\`, \`05-Decisions/\`).
   - If a new decision supersedes an older one, do not delete history; record \`supersedes: <old-id>\` or annotate \`superseded_by\`.

## 3. Project Structure Convention
When formalizing a project in \`01-Projects/<ProjectName>/\`:
- \`README.md\`: Project goal, scope, and key anchors.
- \`STATUS.md\`: Current verified status (not a bloated changelog).
- \`DECISIONS.md\`: Architectural & product decisions.
- \`LEARNINGS.md\`: Reusable verified insights.
- \`notes/\`: Working notes and materials.
`

export const SYSTEM_MEMORY_RULES_MD = `# MEMORY_RULES.md — Long-Term Memory Protocol

Strict rules governing what AI agents and users write to durable memory.

## ✅ What May Be Written to Long-Term Memory
1. **Explicit User Rules**: Long-term preferences and constraints confirmed by the user.
2. **Validated Technical Facts**: Discovered system constraints, benchmark results, verified workarounds.
3. **Confirmed Product Decisions**: Feature scope, UX decisions, deprecations.
4. **Key Architecture Choices**: Schemas, interfaces, technology choices.
5. **Reusable Playbooks & Solutions**: Debugging recipes, deployment scripts, test methodologies.
6. **Project Milestones & Blockers**: Current active blockers requiring attention.

## ❌ Strictly Forbidden
1. **Secrets & Credentials**: API keys, passwords, bearer tokens, cookies, auth headers, private keys.
2. **Ephemeral Noise**: Raw build logs, verbose terminal traces, temp dumps.
3. **Unverified Speculation**: Guesses or AI hallucinations presented as facts.
4. **Duplicate Content**: Ingesting the same information repeatedly across files.
5. **Silent Deletions**: Never erase past decisions without referencing them.

## 🔄 Conflict & Evolution Handling
When new facts contradict older records:
- Do NOT silently delete the old record.
- Record the new fact with date and source.
- Add \`supersedes: <old-id>\` to the new record's frontmatter.
- Mark the previous entry with \`superseded_by: <new-id>\` and reference the reason.
`

export const SYSTEM_SCHEMA_MD = `# SCHEMA.md — Boss Brain Markdown Schema

Every note in the vault follows this schema.

## 1. Filename Convention
\`YYYY-MM-DD-HHmm--<slug>-<hash>.md\`
- Example: \`2026-09-17-2342--healthtwin-home-cta-a82c.md\`
- Stable once created. Does not rename on minor title edits.

## 2. YAML Frontmatter
\`\`\`yaml
---
id: 2026-09-17-2342-healthtwin-home-cta-a82c
title: HealthTwin 首页应该加强 CTA
created: 2026-09-17T23:42:00+08:00
updated: 2026-09-17T23:42:00+08:00
type: note
status: inbox
project: ""
tags: []
source: maiknote
---
\`\`\`

## 3. Wikilinks
- Standard: \`[[Title]]\`
- With Alias: \`[[Target|Display Text]]\`
- With Heading: \`[[Target#Heading]]\`
`

export const SYSTEM_CHANGELOG_MD = `# CHANGELOG.md — Boss Brain History

## [1.0.0] - ${formatISO8601WithOffset()}
- Initialized Boss Brain V1 Vault.
- Configured Inbox, Projects, Areas, Knowledge, Playbooks, Decisions, Archive, Assets, and System folders.
- Established Agent Memory Protocol & Schema.
`

/**
 * Generates _system/INDEX.md content dynamically from notes in vault.
 */
export function generateIndexMarkdown(notes: Note[]): string {
  const nowStr = formatISO8601WithOffset()

  const inboxNotes = notes.filter(n => n.relativePath?.startsWith('00-Inbox') || n.status === 'inbox')
  const projectNotes = notes.filter(n => n.relativePath?.startsWith('01-Projects'))
  const areaNotes = notes.filter(n => n.relativePath?.startsWith('02-Areas'))
  const knowledgeNotes = notes.filter(n => n.relativePath?.startsWith('03-Knowledge'))
  const playbookNotes = notes.filter(n => n.relativePath?.startsWith('04-Playbooks'))
  const decisionNotes = notes.filter(n => n.relativePath?.startsWith('05-Decisions'))

  function renderList(list: Note[], max = 10): string {
    if (list.length === 0) return '_Empty_\n'
    const slice = list.slice(0, max)
    const items = slice.map(n => `- [[${n.title}]] (\`${n.relativePath || n.id}\`)`).join('\n')
    const more = list.length > max ? `\n- _...and ${list.length - max} more_` : ''
    return `${items}${more}\n`
  }

  return `# Boss Brain Index
_Updated: ${nowStr}_

This file is the high-level entry index for AI agents and human navigation.
Do NOT dump full note contents into this index.

## 📥 00-Inbox (${inboxNotes.length})
${renderList(inboxNotes)}

## 🚀 01-Projects (${projectNotes.length})
${renderList(projectNotes)}

## 🌐 02-Areas (${areaNotes.length})
${renderList(areaNotes)}

## 📚 03-Knowledge (${knowledgeNotes.length})
${renderList(knowledgeNotes)}

## 📖 04-Playbooks (${playbookNotes.length})
${renderList(playbookNotes)}

## ⚖️ 05-Decisions (${decisionNotes.length})
${renderList(decisionNotes)}
`
}

/**
 * Ensures vault directory structure and creates standard system documents if missing.
 */
export async function initializeBossBrainVault(vaultPath: string): Promise<void> {
  const fs = useFileSystem()
  await fs.ensureVaultStructure(vaultPath)

  // Write system files if they don't exist
  const systemFiles = [
    { name: '_system/AGENTS.md', content: SYSTEM_AGENTS_MD },
    { name: '_system/MEMORY_RULES.md', content: SYSTEM_MEMORY_RULES_MD },
    { name: '_system/SCHEMA.md', content: SYSTEM_SCHEMA_MD },
    { name: '_system/CHANGELOG.md', content: SYSTEM_CHANGELOG_MD },
  ]

  for (const file of systemFiles) {
    try {
      await fs.readVaultTextFile(vaultPath, file.name)
    } catch {
      // File doesn't exist, write it
      await fs.writeVaultTextFile(vaultPath, file.name, file.content)
    }
  }

  // Ensure initial INDEX.md exists
  try {
    await fs.readVaultTextFile(vaultPath, '_system/INDEX.md')
  } catch {
    await fs.writeVaultTextFile(vaultPath, '_system/INDEX.md', generateIndexMarkdown([]))
  }
}
