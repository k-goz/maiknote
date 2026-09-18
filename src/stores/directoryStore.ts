import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type { Directory, DirectoryData } from '@/types/note'
import { useFileSystem } from '@/composables/useFileSystem'
import { useSettingStore } from '@/stores/settingStore'

export const useDirectoryStore = defineStore('directory', () => {
  const fs = useFileSystem()
  const settingStore = useSettingStore()

  // State
  const directories = ref<Directory[]>([])
  const currentDirectoryId = ref<string | null>(null) // null = root
  const isLoading = ref(false)

  // 监听 currentDirectoryId 变化，保存到 localStorage
  watch(currentDirectoryId, (newId) => {
    if (newId !== undefined) {
      localStorage.setItem('lastSelectedDirectoryId', newId ?? '')
    }
  })

  /** 从 localStorage 恢复上次选择的目录 */
  function restoreLastDirectory(): string | null {
    const saved = localStorage.getItem('lastSelectedDirectoryId')
    if (saved && saved !== '') {
      const dir = directories.value.find(d => d.id === saved)
      if (dir) {
        currentDirectoryId.value = saved
        return saved
      }
    }
    currentDirectoryId.value = null
    return null
  }

  // Getters
  const rootDirectories = computed(() =>
    directories.value.filter(d => d.parentId === null)
  )

  function getChildren(parentId: string): Directory[] {
    return directories.value.filter(d => d.parentId === parentId)
  }

  function getDirectory(id: string): Directory | undefined {
    return directories.value.find(d => d.id === id)
  }

  function getFlattenedDirectoryIds(): (string | null)[] {
    const ids: (string | null)[] = [null]

    function appendChildren(parentId: string | null) {
      for (const dir of directories.value.filter(d => d.parentId === parentId)) {
        ids.push(dir.id)
        appendChildren(dir.id)
      }
    }

    appendChildren(null)
    return ids
  }

  function getAdjacentDirectoryId(direction: 'prev' | 'next'): string | null {
    const ids = getFlattenedDirectoryIds()
    const currentIndex = ids.findIndex(id => id === currentDirectoryId.value)
    const index = currentIndex === -1 ? 0 : currentIndex
    const nextIndex = direction === 'prev'
      ? Math.max(0, index - 1)
      : Math.min(ids.length - 1, index + 1)

    return ids[nextIndex] ?? null
  }

  // Actions
  async function loadDirectories(): Promise<void> {
    if (isLoading.value) return
    isLoading.value = true

    try {
      if (settingStore.settings.enableBossBrain) {
        const standardFolders = [
          '00-Inbox',
          '01-Projects',
          '02-Areas',
          '03-Knowledge',
          '04-Playbooks',
          '05-Decisions',
          '90-Archive',
        ]

        const now = Date.now()
        const dirs: Directory[] = standardFolders.map(name => ({
          id: name,
          name,
          parentId: null,
          createdAt: now,
          updatedAt: now,
        }))

        // Also check if any subfolders exist in the vault
        if (settingStore.settings.vaultPath) {
          try {
            const files = await fs.scanVaultFiles(settingStore.settings.vaultPath)
            const subfolderSet = new Set<string>()

            for (const f of files) {
              const parts = f.relative_path.split('/')
              if (parts.length > 2) {
                // e.g. 01-Projects/TestProject/README.md -> parent is parts[0], subfolder is parts.slice(0, 2).join('/')
                const parentId = parts[0]
                const subfolderId = parts.slice(0, 2).join('/')
                const subfolderName = parts[1]
                if (!subfolderSet.has(subfolderId) && !subfolderName.startsWith('.')) {
                  subfolderSet.add(subfolderId)
                  dirs.push({
                    id: subfolderId,
                    name: subfolderName,
                    parentId,
                    createdAt: now,
                    updatedAt: now,
                  })
                }
              }
            }
          } catch (e) {
            console.warn('Failed scanning subfolders in vault:', e)
          }
        }

        directories.value = dirs
        return
      }

      const data = await fs.readDirectories()
      directories.value = data.directories
    } catch (e) {
      console.error('Failed to load directories:', e)
    } finally {
      isLoading.value = false
    }
  }

  async function saveDirectories(): Promise<void> {
    if (settingStore.settings.enableBossBrain) {
      return
    }
    const data: DirectoryData = {
      version: 1,
      directories: directories.value,
    }
    await fs.writeDirectories(data)
  }

  async function createDirectory(name: string, parentId: string | null = null): Promise<Directory> {
    const now = Date.now()
    const folderId = parentId ? `${parentId}/${name}` : name
    const newDir: Directory = {
      id: folderId,
      name,
      parentId,
      createdAt: now,
      updatedAt: now,
    }
    directories.value.push(newDir)

    if (settingStore.settings.enableBossBrain && settingStore.settings.vaultPath) {
      // In Boss Brain mode, ensure vault folder exists
      try {
        await fs.writeVaultTextFile(settingStore.settings.vaultPath, `${folderId}/.keep`, '')
      } catch (e) {
        console.warn('Failed creating vault directory:', e)
      }
    } else {
      await fs.createDirectoryFolder(newDir.id)
      await saveDirectories()
    }

    return newDir
  }

  async function renameDirectory(id: string, newName: string): Promise<void> {
    const dir = directories.value.find(d => d.id === id)
    if (dir) {
      dir.name = newName
      dir.updatedAt = Date.now()
      await saveDirectories()
    }
  }

  function isDescendantOf(id: string, possibleAncestorId: string): boolean {
    let dir = directories.value.find(d => d.id === id)
    while (dir?.parentId) {
      if (dir.parentId === possibleAncestorId) return true
      dir = directories.value.find(d => d.id === dir?.parentId)
    }
    return false
  }

  async function moveDirectory(
    id: string,
    newParentId: string | null,
    position: 'inside' | 'before' | 'after' = 'inside',
    referenceId?: string
  ): Promise<void> {
    const dir = directories.value.find(d => d.id === id)
    if (!dir) return
    if (newParentId === id || (newParentId && isDescendantOf(newParentId, id))) return

    if (position !== 'inside' && referenceId) {
      const reference = directories.value.find(d => d.id === referenceId)
      if (!reference || reference.id === id || isDescendantOf(reference.id, id)) return
      newParentId = reference.parentId
    }

    const nextDirectories = directories.value.filter(d => d.id !== id)
    dir.parentId = newParentId
    dir.updatedAt = Date.now()

    if (position !== 'inside' && referenceId) {
      const referenceIndex = nextDirectories.findIndex(d => d.id === referenceId)
      if (referenceIndex !== -1) {
        nextDirectories.splice(position === 'before' ? referenceIndex : referenceIndex + 1, 0, dir)
        directories.value = nextDirectories
        await saveDirectories()
        return
      }
    }

    nextDirectories.push(dir)
    directories.value = nextDirectories
    await saveDirectories()
  }

  async function deleteDirectory(id: string): Promise<void> {
    const dir = directories.value.find(d => d.id === id)
    if (!dir) return
    const parentId = dir.parentId

    if (!settingStore.settings.enableBossBrain) {
      await fs.deleteDirectoryFolder(id)
    }

    const index = directories.value.findIndex(d => d.id === id)
    if (index !== -1) {
      directories.value.splice(index, 1)
    }

    for (const child of directories.value) {
      if (child.parentId === id) {
        child.parentId = parentId
        child.updatedAt = Date.now()
      }
    }

    if (currentDirectoryId.value === id) {
      currentDirectoryId.value = null
    }

    await saveDirectories()
  }

  function selectDirectory(id: string | null) {
    currentDirectoryId.value = id
  }

  return {
    directories,
    currentDirectoryId,
    isLoading,
    rootDirectories,
    getChildren,
    getDirectory,
    getFlattenedDirectoryIds,
    getAdjacentDirectoryId,
    isDescendantOf,
    loadDirectories,
    saveDirectories,
    restoreLastDirectory,
    createDirectory,
    renameDirectory,
    moveDirectory,
    deleteDirectory,
    selectDirectory,
  }
})
