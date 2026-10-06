import { normalizeHydrologyRows, HYDROLOGY_KEY } from '@/domain/hydrology'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydropower-plant-om:entries'
const VERSION_KEY = 'hydropower-plant-om:schema-version'
const SCHEMA_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 种子数据同样要过一遍存量修复：新版本种子里就带了「退回痕迹」样例，
// 必须先拨正再展示，不能等已经写进 localStorage。
function freshSeed(): Record<string, EntryRow[]> {
  const seed = clone(SEED_ROWS)
  seed[HYDROLOGY_KEY] = normalizeHydrologyRows(seed[HYDROLOGY_KEY])
  return seed
}

// 存量拨正只在这里做一次：幂等，后续重复读取不会再改动数据。
function upgrade(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  return {
    ...data,
    [HYDROLOGY_KEY]: normalizeHydrologyRows(data[HYDROLOGY_KEY] ?? []),
  }
}

let cache: Record<string, EntryRow[]> | null = null

function persist(next: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    // 整笔写入：快照与版本号都成功才算落库，写一半失败不覆盖旧快照（不留中间态）。
    const snapshot = JSON.stringify(next)
    const oldSnapshot = window.localStorage.getItem(STORAGE_KEY)
    const oldVersion = window.localStorage.getItem(VERSION_KEY)
    try {
      window.localStorage.setItem(STORAGE_KEY, snapshot)
      window.localStorage.setItem(VERSION_KEY, String(SCHEMA_VERSION))
    } catch (error) {
      if (oldSnapshot !== null) {
        window.localStorage.setItem(STORAGE_KEY, oldSnapshot)
      }
      if (oldVersion !== null) {
        window.localStorage.setItem(VERSION_KEY, oldVersion)
      }
      throw error
    }
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = freshSeed()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const version = Number(window.localStorage.getItem(VERSION_KEY) ?? '1')
    const merged: Record<string, EntryRow[]> = { ...clone(SEED_ROWS), ...parsed }
    const data = version < SCHEMA_VERSION ? upgrade(merged) : merged
    if (version < SCHEMA_VERSION) {
      persist(data)
    }
    return data
  } catch {
    persist(fallback)
    return fallback
  }
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 整笔保存：调用方先在内存里构造好完整的新数组，再一次性落库（另存的就是这份快照）。
export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  persist(next)
  cache = next
}

export function resetRows(key: string): EntryRow[] {
  const rows = freshSeed()[key] ?? []
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
