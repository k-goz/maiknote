import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type { Note, NoteMetadata, BossBrainFrontmatter } from '@/types/note'
import { useFileSystem } from '@/composables/useFileSystem'
import { useDirectoryStore } from '@/stores/directoryStore'
import { useSettingStore } from '@/stores/settingStore'
import { vaultIndexer } from '@/services/vaultIndexer'
import { initializeBossBrainVault } from '@/services/vaultManager'
import {
  generateBossBrainFilename,
  generateNoteId,
  formatISO8601WithOffset,
} from '@/utils/slug'
import {
  extractFrontmatterAndBody,
  stringifyWithFrontmatter,
} from '@/utils/frontmatter'
import { resolveWikilinkTarget } from '@/utils/wikilink'
import { diffVaultSnapshot, mergeScannedWithPreservedNotes } from '@/services/vaultChangeDetector'
import { resolveNoteConflict } from '@/services/conflictResolver'
import i18n from '@/i18n'

export const useNoteStore = defineStore('note', () => {
  // File system
  const fs = useFileSystem()
  const settingStore = useSettingStore()

  // State
  const notes = ref<Note[]>([])
  const currentNoteId = ref<string | null>(null)
  const searchQuery = ref('')
  const navigationHint = ref<{ message: string; visible: boolean }>({ message: '', visible: false })
  const isLoading = ref(false)
  const loadError = ref<Error | null>(null)
  const filterDirectoryId = ref<string | null>(null) // null = root 目录
  const deletingNoteId = ref<string | null>(null) // 正在播放删除动画的笔记 ID
  // 导航方向：由导航行为显式设置，编辑器直接绑定此值控制切换动画（上一条=left、下一条/新建=right）
  const navDirection = ref<'left' | 'right' | 'up' | 'down'>('right')

  // 监听 currentNoteId 变化，保存到 localStorage
  watch(currentNoteId, (newId) => {
    if (newId) {
      localStorage.setItem('lastOpenedNoteId', newId)
    }
  })

  // Getters
  const activeNotes = computed(() => notes.value.filter(n => !n.trashedAt))

  const trashedNotes = computed(() =>
    notes.value.filter(n => n.trashedAt).sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0))
  )

  const currentNote = computed(() =>
    activeNotes.value.find(n => n.id === currentNoteId.value) ?? null
  )

  const currentIndex = computed(() =>
    activeNotes.value.findIndex(n => n.id === currentNoteId.value)
  )

  /** 按 filterDirectoryId 过滤后的笔记列表 */
  const activeNoteList = computed(() => {
    if (filterDirectoryId.value === null) {
      if (settingStore.settings.enableBossBrain) {
        return activeNotes.value
      }
      return activeNotes.value.filter(n => !n.directoryId)
    }
    const targetDir = filterDirectoryId.value
    return activeNotes.value.filter(n =>
      n.directoryId === targetDir ||
      (n.relativePath && n.relativePath.startsWith(`${targetDir}/`))
    )
  })

  /** 当前笔记在 activeNoteList 中的索引 */
  const activeIndex = computed(() =>
    activeNoteList.value.findIndex(n => n.id === currentNoteId.value)
  )

  const filteredNotes = computed(() => {
    if (!searchQuery.value) return activeNotes.value
    const query = searchQuery.value.toLowerCase()
    return activeNotes.value.filter(n => {
      const titleMatch = (n.title || '').toLowerCase().includes(query)
      const contentMatch = (n.content || '').toLowerCase().includes(query)
      const tagMatch = (n.tags || []).some(t => t.toLowerCase().includes(query))
      const projectMatch = (n.project || '').toLowerCase().includes(query)
      const pathMatch = (n.relativePath || '').toLowerCase().includes(query)
      const aliasMatch = Array.isArray(n.frontmatter?.aliases) &&
        n.frontmatter.aliases.some((a: any) => String(a).toLowerCase().includes(query))
      return titleMatch || contentMatch || tagMatch || projectMatch || pathMatch || aliasMatch
    })
  })

  const pinnedNotes = computed(() =>
    activeNoteList.value.filter(n => n.isPinned)
  )

  const unpinnedNotes = computed(() =>
    activeNoteList.value.filter(n => !n.isPinned)
  )

  // Helper: Check if note is empty
  function isNoteEmpty(note: Note | null): boolean {
    if (!note) return false
    return !note.content || note.content.trim() === ''
  }

  // Helper: Show navigation hint
  let hintTimeout: ReturnType<typeof setTimeout> | null = null
  function showHint(message: string) {
    if (hintTimeout) {
      clearTimeout(hintTimeout)
    }
    navigationHint.value = { message, visible: true }
    hintTimeout = setTimeout(() => {
      navigationHint.value = { message: '', visible: false }
    }, 2000)
  }

  // Helper: Shake window when at boundary
  function shakeWindow() {
    const el = document.getElementById('app')
    if (!el) return
    el.classList.remove('shake')
    // Force reflow to restart animation
    void el.offsetWidth
    el.classList.add('shake')
    setTimeout(() => el.classList.remove('shake'), 400)
  }

  // ============================================
  // Persistence Functions
  // ============================================

  // Debounced save state
  let saveTimeout: ReturnType<typeof setTimeout> | null = null
  const pendingSaveNotes = new Set<string>()
  let metadataSavePending = false

  // Disk snapshot tracking for external change detection
  const lastDiskSnapshot = new Map<string, { mtime: number; size: number }>()

  function updateDiskSnapshot(items: Array<{ relativePath?: string; mtime?: number; size?: number; content?: string }>) {
    lastDiskSnapshot.clear()
    for (const item of items) {
      if (item.relativePath) {
        lastDiskSnapshot.set(item.relativePath, {
          mtime: item.mtime || 0,
          size: (item as any).size || (item.content ? item.content.length : 0),
        })
      }
    }
  }

  /**
   * Schedule a save (debounced)
   */
  function scheduleSave(note?: Note) {
    if (note) {
      note.isDirty = true
      pendingSaveNotes.add(note.id)
    } else {
      metadataSavePending = true
    }

    if (saveTimeout) {
      clearTimeout(saveTimeout)
    }

    saveTimeout = setTimeout(async () => {
      const notesToSave = Array.from(pendingSaveNotes)
        .map(id => notes.value.find(n => n.id === id))
        .filter((n): n is Note => n !== undefined)

      for (const note of notesToSave) {
        try {
          if (settingStore.settings.enableBossBrain && settingStore.settings.vaultPath && note.relativePath) {
            const vaultPath = settingStore.settings.vaultPath
            const frontmatter: BossBrainFrontmatter = {
              id: note.id,
              title: note.title,
              created: formatISO8601WithOffset(new Date(note.createdAt)),
              updated: formatISO8601WithOffset(new Date(note.updatedAt)),
              type: note.type || 'note',
              status: note.status || 'inbox',
              project: note.project || '',
              tags: note.tags || [],
              source: note.source || 'maiknote',
              ...(note.frontmatter || {}),
              isPinned: note.isPinned,
              isLocked: note.isLocked,
              backgroundColor: note.backgroundColor,
            }
            note.frontmatter = frontmatter
            const fullMarkdown = stringifyWithFrontmatter(frontmatter, note.content)
            const writeRes = await fs.writeVaultTextFile(vaultPath, note.relativePath, fullMarkdown)
            note.isDirty = false
            note.mtime = writeRes.modified_ms
            ;(note as any).size = writeRes.size
            lastDiskSnapshot.set(note.relativePath, { mtime: writeRes.modified_ms, size: writeRes.size })
          } else {
            await fs.writeNote(note.id, note.content, note.directoryId)
          }
        } catch (e) {
          console.error('Failed to save note:', e)
        }
      }

      if (settingStore.settings.enableBossBrain && settingStore.settings.vaultPath) {
        await vaultIndexer.saveCache(settingStore.settings.vaultPath, notes.value)
      } else {
        if (notesToSave.length > 0 || metadataSavePending) {
          try {
            await saveMetadataToCloud()
          } catch (e) {
            console.error('Failed to save metadata to iCloud:', e)
          }
        }
      }

      pendingSaveNotes.clear()
      metadataSavePending = false
      saveTimeout = null
    }, 500)
  }

  /**
   * Load all notes
   */
  async function loadNotes(): Promise<void> {
    if (isLoading.value) return

    isLoading.value = true
    loadError.value = null

    try {
      if (settingStore.settings.enableBossBrain) {
        if (!settingStore.settings.vaultPath) {
          const defaultPath = await fs.getDefaultVaultPath()
          settingStore.updateSettings('vaultPath', defaultPath)
        }

        const vaultPath = settingStore.settings.vaultPath
        if (vaultPath) {
          await initializeBossBrainVault(vaultPath)
          const scanned = await vaultIndexer.scanVault(vaultPath)

          if (scanned.length > 0) {
            notes.value = scanned
            updateDiskSnapshot(scanned)

            const lastOpenedId = localStorage.getItem('lastOpenedNoteId')
            const active = activeNoteList.value
            if (lastOpenedId && active.some(n => n.id === lastOpenedId)) {
              currentNoteId.value = lastOpenedId
            } else if (active.length > 0) {
              currentNoteId.value = active[0].id
            } else {
              currentNoteId.value = scanned[0].id
            }
            return
          } else {
            // Vault is completely empty, create first note in 00-Inbox/
            await createNoteAtHead()
            return
          }
        }
      }

      // Legacy MaikNote loader fallback
      const metadata = await fs.readMetadata()
      const loadedNotes: Note[] = []

      for (const item of metadata.notes) {
        const content = await fs.readNote(item.id, item.directoryId)
        loadedNotes.push({
          id: item.id,
          title: item.title,
          content,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          tags: item.tags,
          isPinned: item.isPinned,
          isLocked: item.isLocked,
          directoryId: item.directoryId,
          backgroundColor: item.backgroundColor,
          trashedAt: item.trashedAt,
        })
      }

      notes.value = loadedNotes

      const lastOpenedId = localStorage.getItem('lastOpenedNoteId')
      const active = activeNoteList.value
      if (lastOpenedId && active.some(n => n.id === lastOpenedId)) {
        currentNoteId.value = lastOpenedId
      } else if (active.length > 0) {
        currentNoteId.value = active[0].id
      } else {
        createNoteAtHead()
      }
    } catch (e) {
      loadError.value = e as Error
      console.error('Failed to load notes:', e)
      createNoteAtHead()
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Save metadata to iCloud (legacy)
   */
  async function saveMetadataToCloud(): Promise<void> {
    const metadata: NoteMetadata = {
      version: 1,
      notes: notes.value.map((note) => ({
        id: note.id,
        title: note.title,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        tags: note.tags,
        isPinned: note.isPinned,
        isLocked: note.isLocked,
        directoryId: note.directoryId,
        backgroundColor: note.backgroundColor,
        trashedAt: note.trashedAt,
      })),
    }
    await fs.writeMetadata(metadata)
  }

  /**
   * Save a single note immediately
   */
  async function saveNoteToStorage(note: Note): Promise<void> {
    try {
      if (settingStore.settings.enableBossBrain && settingStore.settings.vaultPath && note.relativePath) {
        const vaultPath = settingStore.settings.vaultPath
        const frontmatter: BossBrainFrontmatter = {
          id: note.id,
          title: note.title,
          created: formatISO8601WithOffset(new Date(note.createdAt)),
          updated: formatISO8601WithOffset(new Date(note.updatedAt)),
          type: note.type || 'note',
          status: note.status || 'inbox',
          project: note.project || '',
          tags: note.tags || [],
          source: note.source || 'maiknote',
          ...(note.frontmatter || {}),
          isPinned: note.isPinned,
          isLocked: note.isLocked,
          backgroundColor: note.backgroundColor,
        }
        note.frontmatter = frontmatter
        const fullMarkdown = stringifyWithFrontmatter(frontmatter, note.content)
        const writeRes = await fs.writeVaultTextFile(vaultPath, note.relativePath, fullMarkdown)
        note.mtime = writeRes.modified_ms
        ;(note as any).size = writeRes.size
        note.isDirty = false
        lastDiskSnapshot.set(note.relativePath, { mtime: writeRes.modified_ms, size: writeRes.size })
        await vaultIndexer.saveCache(vaultPath, notes.value)
      } else {
        await fs.writeNote(note.id, note.content, note.directoryId)
        await saveMetadataToCloud()
      }
    } catch (e) {
      console.error('Failed to save note to storage:', e)
      throw e
    }
  }

  /**
   * Helper to construct a new Note object
   */
  function buildNewNote(initialTitle = 'New Note', initialContent = ''): Note {
    const now = Date.now()
    const isBossBrain = settingStore.settings.enableBossBrain

    if (isBossBrain) {
      const filename = generateBossBrainFilename(initialTitle || 'New Note', new Date(now))
      const targetFolder = currentDirectoryId() || '00-Inbox'
      const relativePath = `${targetFolder}/${filename}`
      const id = generateNoteId(initialTitle || 'New Note', new Date(now))

      const frontmatter: BossBrainFrontmatter = {
        id,
        title: initialTitle,
        created: formatISO8601WithOffset(new Date(now)),
        updated: formatISO8601WithOffset(new Date(now)),
        type: 'note',
        status: 'inbox',
        project: '',
        tags: [],
        source: 'maiknote',
      }

      return {
        id,
        title: initialTitle,
        content: initialContent,
        createdAt: now,
        updatedAt: now,
        isPinned: false,
        isLocked: false,
        directoryId: targetFolder,
        relativePath,
        status: 'inbox',
        type: 'note',
        project: '',
        source: 'maiknote',
        frontmatter,
        wikilinks: [],
        backlinks: [],
        mtime: now,
        isDirty: false,
      }
    }

    return {
      id: crypto.randomUUID(),
      title: initialTitle,
      content: initialContent,
      createdAt: now,
      updatedAt: now,
      isPinned: false,
      isLocked: false,
      directoryId: currentDirectoryId(),
    }
  }

  // ============================================
  // Store Actions
  // ============================================

  function setNotes(newNotes: Note[]) {
    notes.value = newNotes
  }

  function selectNote(id: string) {
    const active = activeNoteList.value
    const oldIdx = active.findIndex(n => n.id === currentNoteId.value)
    const newIdx = active.findIndex(n => n.id === id)
    if (oldIdx >= 0 && newIdx >= 0) {
      navDirection.value = newIdx > oldIdx ? 'right' : 'left'
    }
    currentNoteId.value = id
  }

  function setFilterDirectory(id: string | null) {
    filterDirectoryId.value = id
    const directoryStore = useDirectoryStore()
    directoryStore.selectDirectory(id)
    const active = activeNoteList.value
    const hasCurrent = active.some(n => n.id === currentNoteId.value)
    if (!hasCurrent) {
      if (active.length > 0) {
        currentNoteId.value = active[0].id
      } else {
        createNoteAtHead()
      }
    }
  }

  function currentDirectoryId(): string | undefined {
    return filterDirectoryId.value ?? undefined
  }

  async function createNoteAtHead(): Promise<Note> {
    const newNote = buildNewNote('New Note', '')
    notes.value.unshift(newNote)
    currentNoteId.value = newNote.id
    await saveNoteToStorage(newNote)
    return newNote
  }

  async function createNoteAtTail(): Promise<Note> {
    const newNote = buildNewNote('New Note', '')
    notes.value.push(newNote)
    navDirection.value = 'right'
    currentNoteId.value = newNote.id
    await saveNoteToStorage(newNote)
    return newNote
  }

  async function createNoteAfterCurrent(): Promise<Note> {
    const newNote = buildNewNote('New Note', '')
    const index = notes.value.findIndex(n => n.id === currentNoteId.value)
    if (index !== -1) {
      notes.value.splice(index + 1, 0, newNote)
    } else {
      notes.value.push(newNote)
    }
    navDirection.value = 'right'
    currentNoteId.value = newNote.id
    await saveNoteToStorage(newNote)
    return newNote
  }

  async function createNoteBeforeCurrent(): Promise<Note> {
    const newNote = buildNewNote('New Note', '')
    const index = notes.value.findIndex(n => n.id === currentNoteId.value)
    if (index !== -1) {
      notes.value.splice(index, 0, newNote)
    } else {
      notes.value.push(newNote)
    }
    navDirection.value = 'left'
    currentNoteId.value = newNote.id
    await saveNoteToStorage(newNote)
    return newNote
  }

  async function createNoteWithContent(title: string, content: string): Promise<Note> {
    const newNote = buildNewNote(title, content)
    const currentIndex = notes.value.findIndex(n => n.id === currentNoteId.value)
    if (currentIndex !== -1) {
      notes.value.splice(currentIndex + 1, 0, newNote)
    } else {
      notes.value.push(newNote)
    }
    navDirection.value = 'right'
    currentNoteId.value = newNote.id
    await saveNoteToStorage(newNote)
    return newNote
  }

  function updateNote(id: string, updates: Partial<Omit<Note, 'id' | 'createdAt'>>) {
    const index = notes.value.findIndex(n => n.id === id)
    if (index !== -1) {
      const note = notes.value[index]
      note.isDirty = true
      Object.assign(note, updates, { updatedAt: Date.now() })
      if (updates.content) {
        note.title = extractTitle(updates.content)
      }
      scheduleSave(note)
    }
  }

  function setDeletingNoteId(id: string | null) {
    deletingNoteId.value = id
  }

  async function deleteNote(id: string) {
    const note = notes.value.find(n => n.id === id)
    if (note?.isLocked || note?.trashedAt) {
      return
    }
    if (note) {
      const oldActive = activeNoteList.value
      const oldActiveIndex = oldActive.findIndex(n => n.id === id)
      note.trashedAt = Date.now()
      note.updatedAt = Date.now()
      note.isPinned = false
      note.status = 'archived'
      deletingNoteId.value = null

      if (settingStore.settings.enableBossBrain && settingStore.settings.vaultPath && note.relativePath) {
        const vaultPath = settingStore.settings.vaultPath
        const oldRel = note.relativePath
        const filename = oldRel.split('/').pop() || `${note.id}.md`
        const newRel = `90-Archive/${filename}`
        note.relativePath = newRel
        note.directoryId = '90-Archive'

        try {
          const content = await fs.readVaultTextFile(vaultPath, oldRel)
          await fs.writeVaultTextFile(vaultPath, newRel, content)
          await fs.deleteVaultFile(vaultPath, oldRel)
        } catch (e) {
          console.warn('Failed moving file to 90-Archive:', e)
        }
        await vaultIndexer.saveCache(vaultPath, notes.value)
      } else {
        await saveMetadataToCloud()
      }

      if (currentNoteId.value === id) {
        const active = activeNoteList.value
        const newIndex = Math.min(Math.max(0, oldActiveIndex - 1), active.length - 1)
        navDirection.value = oldActiveIndex > 0 ? 'left' : 'right'
        currentNoteId.value = active[newIndex]?.id ?? null
      }
    }
  }

  async function restoreNote(id: string): Promise<void> {
    const note = notes.value.find(n => n.id === id)
    if (!note?.trashedAt) return

    note.trashedAt = undefined
    note.updatedAt = Date.now()
    note.status = 'inbox'

    if (settingStore.settings.enableBossBrain && settingStore.settings.vaultPath && note.relativePath) {
      const vaultPath = settingStore.settings.vaultPath
      const oldRel = note.relativePath
      const filename = oldRel.split('/').pop() || `${note.id}.md`
      const newRel = `00-Inbox/${filename}`
      note.relativePath = newRel
      note.directoryId = '00-Inbox'

      try {
        const content = await fs.readVaultTextFile(vaultPath, oldRel)
        await fs.writeVaultTextFile(vaultPath, newRel, content)
        await fs.deleteVaultFile(vaultPath, oldRel)
      } catch (e) {
        console.warn('Failed restoring file from 90-Archive:', e)
      }
      await vaultIndexer.saveCache(vaultPath, notes.value)
    } else {
      await saveMetadataToCloud()
    }
  }

  async function permanentlyDeleteNote(id: string): Promise<void> {
    const index = notes.value.findIndex(n => n.id === id)
    if (index === -1) return

    const [note] = notes.value.splice(index, 1)

    if (settingStore.settings.enableBossBrain && settingStore.settings.vaultPath && note.relativePath) {
      const vaultPath = settingStore.settings.vaultPath
      await fs.deleteVaultFile(vaultPath, note.relativePath)
      await vaultIndexer.saveCache(vaultPath, notes.value)
    } else {
      await fs.deleteNote(id, note.directoryId)
      await saveMetadataToCloud()
    }

    if (currentNoteId.value === id) {
      currentNoteId.value = activeNoteList.value[0]?.id ?? null
    }
  }

  async function emptyTrash(): Promise<void> {
    const ids = trashedNotes.value.map(n => n.id)
    for (const id of ids) {
      await permanentlyDeleteNote(id)
    }
  }

  function togglePin(id: string) {
    const note = notes.value.find(n => n.id === id)
    if (note) {
      note.isPinned = !note.isPinned
      note.updatedAt = Date.now()
      scheduleSave(note)
    }
  }

  async function toggleLock(id: string) {
    const note = notes.value.find(n => n.id === id)
    if (note) {
      note.isLocked = !note.isLocked
      note.updatedAt = Date.now()
      if (note.isLocked) {
        await fs.setNoteReadonly(id)
      } else {
        await fs.setNoteReadwrite(id)
      }
      scheduleSave(note)
    }
  }

  function selectPrev() {
    const active = activeNoteList.value
    const idx = active.findIndex(n => n.id === currentNoteId.value)
    if (idx > 0) {
      navDirection.value = 'left'
      currentNoteId.value = active[idx - 1].id
    }
  }

  function selectNext() {
    const active = activeNoteList.value
    const idx = active.findIndex(n => n.id === currentNoteId.value)
    if (idx < active.length - 1) {
      navDirection.value = 'right'
      currentNoteId.value = active[idx + 1].id
    }
  }

  async function navigatePrevOrCreate() {
    const active = activeNoteList.value
    const activeIdx = active.findIndex(n => n.id === currentNoteId.value)
    const isEmpty = currentNote.value && isNoteEmpty(currentNote.value)

    if (activeIdx === 0) {
      shakeWindow()
      showHint(i18n.global.t('nav.firstNote'))
      return
    }

    if (isEmpty) {
      const idToDelete = currentNoteId.value!
      await permanentlyDeleteNote(idToDelete)
      navDirection.value = 'left'
      currentNoteId.value = active[activeIdx - 1]?.id || null
    } else {
      navDirection.value = 'left'
      currentNoteId.value = active[activeIdx - 1]?.id || null
    }
  }

  async function navigateNextOrCreate() {
    const active = activeNoteList.value
    const activeIdx = active.findIndex(n => n.id === currentNoteId.value)
    const isEmpty = currentNote.value && isNoteEmpty(currentNote.value)

    if (activeIdx >= active.length - 1) {
      if (isEmpty) {
        shakeWindow()
        showHint(i18n.global.t('nav.lastNote'))
      } else {
        await createNoteAtTail()
      }
      return
    }

    if (isEmpty) {
      const idToDelete = currentNoteId.value!
      await permanentlyDeleteNote(idToDelete)
      navDirection.value = 'right'
      currentNoteId.value = active[activeIdx + 1]?.id || null
    } else {
      navDirection.value = 'right'
      currentNoteId.value = active[activeIdx + 1]?.id || null
    }
  }

  function pinToTop(id: string) {
    const index = notes.value.findIndex(n => n.id === id)
    if (index > 0) {
      const [note] = notes.value.splice(index, 1)
      notes.value.unshift(note)
      note.updatedAt = Date.now()
      scheduleSave(note)
    }
  }

  function reorderNotes(noteIds: string[]) {
    const noteMap = new Map(notes.value.map(n => [n.id, n]))
    const reordered = noteIds.map(id => noteMap.get(id)).filter((n): n is Note => n !== undefined)
    const reorderedIds = new Set(noteIds)
    const remaining = notes.value.filter(n => !reorderedIds.has(n.id))
    notes.value = [...reordered, ...remaining]
    scheduleSave()
  }

  function getNotesByDirectory(directoryId: string | null): Note[] {
    if (directoryId === null) {
      return activeNotes.value
    }
    return activeNotes.value.filter(n =>
      n.directoryId === directoryId ||
      (n.relativePath && n.relativePath.startsWith(`${directoryId}/`))
    )
  }

  async function moveNoteToDirectory(noteId: string, directoryId: string | null): Promise<void> {
    const note = notes.value.find(n => n.id === noteId)
    if (note && !note.trashedAt) {
      if (settingStore.settings.enableBossBrain && settingStore.settings.vaultPath && note.relativePath) {
        const vaultPath = settingStore.settings.vaultPath
        const oldRel = note.relativePath
        const filename = oldRel.split('/').pop() || `${note.id}.md`
        const targetDir = directoryId || '00-Inbox'
        const newRel = `${targetDir}/${filename}`

        note.relativePath = newRel
        note.directoryId = directoryId || undefined
        note.updatedAt = Date.now()

        try {
          const content = await fs.readVaultTextFile(vaultPath, oldRel)
          await fs.writeVaultTextFile(vaultPath, newRel, content)
          await fs.deleteVaultFile(vaultPath, oldRel)
        } catch (e) {
          console.error('Failed moving note file in vault:', e)
        }
        await vaultIndexer.saveCache(vaultPath, notes.value)
      } else {
        const fromDir = note.directoryId ?? null
        const toDir = directoryId
        note.directoryId = directoryId || undefined
        note.updatedAt = Date.now()
        await fs.moveNoteFile(noteId, fromDir, toDir)
        scheduleSave()
      }
    }
  }

  // ============================================
  // External Modification & Conflict Handling
  // ============================================

  async function checkExternalChanges(): Promise<void> {
    if (!settingStore.settings.enableBossBrain || !settingStore.settings.vaultPath) return
    const vaultPath = settingStore.settings.vaultPath

    try {
      const files = await fs.scanVaultFiles(vaultPath)
      const diskFiles = files.filter(f => !f.relative_path.startsWith('.bossbrain/'))

      const diskSnapshot = new Map<string, { mtime: number; size: number }>()
      for (const f of diskFiles) {
        diskSnapshot.set(f.relative_path, { mtime: f.modified_ms, size: f.size })
      }

      const diff = diffVaultSnapshot(diskSnapshot, lastDiskSnapshot, notes.value)
      if (!diff.hasAnyDiff) return

      // Handle current open note if it changed on disk
      const current = currentNote.value
      if (current && current.relativePath) {
        if (!diskSnapshot.has(current.relativePath)) {
          // File was deleted or moved on disk externally (F2-01)
          if (current.isDirty) {
            current.hasConflict = true
            current.conflictType = 'deleted'
            current.diskState = 'missing'
          }
        } else {
          const curDisk = diskSnapshot.get(current.relativePath)!
          const curLast = lastDiskSnapshot.get(current.relativePath)
          const isCurModified = curDisk && (
            (curLast && (curDisk.mtime !== curLast.mtime || curDisk.size !== curLast.size)) ||
            (current.mtime && curDisk.mtime > current.mtime + 500)
          )

          if (isCurModified) {
            const raw = await fs.readVaultTextFile(vaultPath, current.relativePath)
            const { frontmatter, body } = extractFrontmatterAndBody(raw)

            if (current.isDirty) {
              current.hasConflict = true
              current.conflictType = 'modified'
              current.conflictContent = body
            } else {
              current.content = body
              current.frontmatter = frontmatter as BossBrainFrontmatter
              current.title = frontmatter.title || current.title
              current.mtime = curDisk.mtime
              ;(current as any).size = curDisk.size
              current.hasConflict = false
              current.conflictType = undefined
              current.diskState = 'normal'
            }
          }
        }
      }

      // Safe refresh of vault
      await rescanVault(false)
    } catch (e) {
      console.warn('Error checking external vault changes:', e)
    }
  }

  async function resolveConflict(noteId: string, choice: 'keep-local' | 'keep-disk' | 'conflict-copy'): Promise<void> {
    const note = notes.value.find(n => n.id === noteId)
    if (!note) return

    await resolveNoteConflict(note, choice, {
      writeVaultTextFile: async (rel, content) => {
        const vaultPath = settingStore.settings.vaultPath!
        const res = await fs.writeVaultTextFile(vaultPath, rel, content)
        lastDiskSnapshot.set(rel, { mtime: res.modified_ms, size: res.size })
        return res
      },
      createNoteWithContent: async (title, content) => {
        return await createNoteWithContent(title, content)
      },
      deleteFromMemory: (id) => {
        const idx = notes.value.findIndex(n => n.id === id)
        if (idx !== -1) {
          notes.value.splice(idx, 1)
          if (currentNoteId.value === id) {
            currentNoteId.value = notes.value[0]?.id || ''
          }
        }
      },
    })
  }

  async function rescanVault(forceRebuild = false): Promise<void> {
    if (!settingStore.settings.enableBossBrain || !settingStore.settings.vaultPath) return
    const vaultPath = settingStore.settings.vaultPath

    isLoading.value = true
    try {
      const scanned = await vaultIndexer.scanVault(vaultPath, forceRebuild)
      const oldId = currentNoteId.value

      const { mergedNotes, isEmptyVault } = mergeScannedWithPreservedNotes(scanned, notes.value)

      if (!isEmptyVault) {
        notes.value = mergedNotes
        updateDiskSnapshot(scanned)

        if (oldId && mergedNotes.some(n => n.id === oldId)) {
          currentNoteId.value = oldId
        } else if (mergedNotes.length > 0) {
          currentNoteId.value = mergedNotes[0].id
        }
      } else {
        // Truly empty vault with NO dirty notes in memory (F1-03 & F2-02)
        notes.value = []
        lastDiskSnapshot.clear()
        await createNoteAtHead()
      }
    } catch (e) {
      console.error('Failed to rescan vault:', e)
    } finally {
      isLoading.value = false
    }
  }

  function navigateToWikilink(target: string): boolean {
    const found = resolveWikilinkTarget(target, notes.value)
    if (found) {
      selectNote(found.id)
      return true
    }
    return false
  }

  async function initialize(): Promise<void> {
    await loadNotes()
  }

  function extractTitle(content: string): string {
    const firstLine = content.trimStart().split('\n', 1)[0]?.trim() || ''
    if (firstLine.startsWith('#')) {
      return firstLine.replace(/^#+\s*/, '').substring(0, 50)
    }
    return firstLine.substring(0, 50) || 'Untitled'
  }

  return {
    // State
    notes,
    currentNoteId,
    searchQuery,
    navigationHint,
    isLoading,
    loadError,
    filterDirectoryId,
    deletingNoteId,
    navDirection,
    // Getters
    currentNote,
    currentIndex,
    activeNoteList,
    activeIndex,
    activeNotes,
    trashedNotes,
    filteredNotes,
    pinnedNotes,
    unpinnedNotes,
    // Actions
    setNotes,
    selectNote,
    setFilterDirectory,
    createNote: createNoteAfterCurrent,
    createNoteAtHead,
    createNoteAtTail,
    createNoteAfterCurrent,
    createNoteBeforeCurrent,
    createNoteWithContent,
    updateNote,
    deleteNote,
    setDeletingNoteId,
    restoreNote,
    permanentlyDeleteNote,
    emptyTrash,
    togglePin,
    toggleLock,
    reorderNotes,
    getNotesByDirectory,
    moveNoteToDirectory,
    selectPrev,
    selectNext,
    navigatePrevOrCreate,
    navigateNextOrCreate,
    pinToTop,
    // Boss Brain Specific Actions
    checkExternalChanges,
    resolveConflict,
    rescanVault,
    navigateToWikilink,
    // Persistence
    initialize,
    loadNotes,
    saveNoteToStorage,
    saveNoteToCloud: saveNoteToStorage,
    saveMetadataToCloud,
  }
})
