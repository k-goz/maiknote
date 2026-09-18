/**
 * Utility functions for slugifying titles and generating stable Boss Brain file names.
 */

export function padZero(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

/**
 * Returns formatted local timestamp prefix: YYYY-MM-DD-HHmm
 */
export function formatFilenameDate(date: Date = new Date()): string {
  const y = date.getFullYear()
  const m = padZero(date.getMonth() + 1)
  const d = padZero(date.getDate())
  const h = padZero(date.getHours())
  const min = padZero(date.getMinutes())
  return `${y}-${m}-${d}-${h}${min}`
}

/**
 * Returns ISO 8601 string with local timezone offset (e.g. 2026-09-17T23:42:00+08:00)
 */
export function formatISO8601WithOffset(date: Date = new Date()): string {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const hours = pad(offset / 60)
  const mins = pad(offset % 60)

  const y = date.getFullYear()
  const m = pad(date.getMonth() + 1)
  const d = pad(date.getDate())
  const hh = pad(date.getHours())
  const mm = pad(date.getMinutes())
  const ss = pad(date.getSeconds())

  return `${y}-${m}-${d}T${hh}:${mm}:${ss}${sign}${hours}:${mins}`
}

/**
 * Generates a clean URL/filesystem-safe slug from a string.
 * Supports alphanumeric and Chinese characters.
 */
export function slugify(text: string): string {
  if (!text) return 'untitled'

  // Remove markdown headers/bullets
  let cleaned = text.replace(/^[#*>\-\s]+/, '').trim()
  // Take first line only
  cleaned = cleaned.split('\n')[0].trim()

  // Replace spaces and special symbols with hyphens, preserve alphanumeric, underscores and CJK characters
  const slug = cleaned
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  return slug.substring(0, 40) || 'untitled'
}

/**
 * Generates a random 4-character hex string
 */
export function randomSuffix(len: number = 4): string {
  const chars = '0123456789abcdef'
  let res = ''
  for (let i = 0; i < len; i++) {
    res += chars[Math.floor(Math.random() * chars.length)]
  }
  return res
}

/**
 * Generates full Boss Brain filename: YYYY-MM-DD-HHmm--<slug>-<hash>.md
 */
export function generateBossBrainFilename(title: string, date: Date = new Date()): string {
  const datePrefix = formatFilenameDate(date)
  const slug = slugify(title)
  const hash = randomSuffix(4)
  return `${datePrefix}--${slug}-${hash}.md`
}

/**
 * Generates unique persistent ID for frontmatter
 */
export function generateNoteId(title: string, date: Date = new Date()): string {
  const datePrefix = formatFilenameDate(date)
  const slug = slugify(title)
  const hash = randomSuffix(4)
  return `${datePrefix}-${slug}-${hash}`
}
