import { SEED_ROWS } from './seed'
import { migrateModule, migrateRows, SCHEMA_VERSION } from './migrate'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydropower-plant-om:entries'

// 存储信封：{ version, rows }。旧版只有裸 rows，读到旧版按存量迁移一次。
type Envelope = {
  version: number
  rows: Record<string, EntryRow[]>
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seededEnvelope(): Envelope {
  // 播种即按业务日期回填、缺失取值标注、卡住存量拨正，页面与导出从第一次打开就是同一份口径。
  return { version: SCHEMA_VERSION, rows: migrateRows(clone(SEED_ROWS)) }
}

function writeEnvelope(envelope: Envelope): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
  }
}

function upgradeEnvelope(envelope: Envelope): Envelope {
  if (envelope.version >= SCHEMA_VERSION) {
    return envelope
  }
  // 版本落后：对全部存量模块跑迁移。迁移一次性完成，不写中间态。
  return { version: SCHEMA_VERSION, rows: migrateRows(envelope.rows) }
}

function readEnvelope(): Envelope {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seededEnvelope()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const fresh = seededEnvelope()
    writeEnvelope(fresh)
    return fresh
  }
  try {
    const parsed = JSON.parse(raw) as Envelope | Record<string, EntryRow[]>
    // 兼容旧版裸数据：没有 version 字段时按 version 0 处理。
    const envelope: Envelope =
      parsed !== null && !Array.isArray(parsed) && 'rows' in parsed && 'version' in parsed
        ? (parsed as Envelope)
        : { version: 0, rows: parsed as Record<string, EntryRow[]> }
    const fallback = seededEnvelope()
    // 后加的模块（种子里有、存量里没有）同样过一遍迁移后并入。
    const merged = { ...fallback.rows, ...envelope.rows }
    let next: Envelope
    if (envelope.version >= SCHEMA_VERSION) {
      next = { version: SCHEMA_VERSION, rows: merged }
    } else {
      next = { version: SCHEMA_VERSION, rows: migrateRows(merged) }
    }
    writeEnvelope(next)
    return next
  } catch {
    const fallback = seededEnvelope()
    writeEnvelope(fallback)
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readEnvelope().rows
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  // 先在草稿上改完再一次性整笔落盘；失败保留旧缓存，不留中间态。
  const next = { ...allRows(), [key]: rows }
  if (typeof window !== 'undefined' && window.localStorage) {
    const draft = JSON.stringify({ version: SCHEMA_VERSION, rows: next })
    // setItem 本身是单调用原子写入；前面构造若抛异常，不会执行到这里。
    window.localStorage.setItem(STORAGE_KEY, draft)
  }
  cache = next
}

export function resetRows(key: string): EntryRow[] {
  // 重置回种子也要走迁移口径，避免重置后业务日期、缺失标注回退。
  const rows = migrateModule(key, clone(SEED_ROWS[key] ?? []))
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
