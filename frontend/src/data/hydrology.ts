import { listRows, saveRows } from './local-store'
import type { ActionResult, EntryRow, LocateResult, PageResult } from './types'

// 水情调度链路的唯一事实来源：水情列表、待调度队列、另存清单、导出明细都从这里读。
export const HYDROLOGY_KEY = 'hydrology'

export const H_STATUS = {
  todo: '待观测',
  observed: '已观测',
  dispatched: '已调度',
  reviewed: '已复核',
} as const

export const MISSING = '缺失'

// 链路字段：退回时清掉的上一轮调度结论；重新下达调度时按最新观测值重算。
const CONCLUSION_FIELDS = ['调度结论', '调度依据', '调度时间', '调度人员', '复核意见', '复核时间', '复核人员']
const TRACE_FIELD = '复核退回痕迹'
const RETURN_COUNT_FIELD = '退回次数'
const CORRECTED_FIELD = '存量拨正'
const CONCLUSION_FIELD = '调度结论'
const INFLOW_FIELD = '入库流量'
const OBSERVED_AT_FIELD = '观测时间'

// 待调度：只认「已观测」。待观测还没观测完，已调度/已复核已经离开调度队列。
export function isPendingDispatch(row: EntryRow): boolean {
  return String(row.status) === H_STATUS.observed
}

/** 退回状态判定：以状态为准（唯一事实），旧版只打标记不改状态的记录由迁移在这里拨正。 */
export function isReturnedState(row: EntryRow): boolean {
  return isPendingDispatch(row) && Number(row[RETURN_COUNT_FIELD] ?? 0) > 0
}

function toNumber(value: string | number | boolean | undefined): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : Number.NaN
  }
  if (typeof value !== 'string' || value.trim() === '' || value === MISSING) {
    return Number.NaN
  }
  return Number(value.replace(/[^\d.-]/g, ''))
}

/**
 * 调度判定：退回后重新下达调度必须按新的观测值判定，不沿用上一轮结论。
 * 入库流量 ≥3000 建议泄洪，≥1500 调峰泄放，其余常规调度。
 */
export function dispatchVerdict(row: EntryRow): {
  verdict: string
  basis: string
} {
  const inflow = toNumber(row[INFLOW_FIELD])
  if (Number.isNaN(inflow)) {
    return { verdict: MISSING, basis: '入库流量缺失，无法判定' }
  }
  if (inflow >= 3000) {
    return { verdict: '泄洪调度', basis: `入库流量 ${inflow} m³/s ≥ 3000，达泄洪阈值` }
  }
  if (inflow >= 1500) {
    return { verdict: '调峰泄放', basis: `入库流量 ${inflow} m³/s ≥ 1500，达调峰阈值` }
  }
  return { verdict: '常规调度', basis: `入库流量 ${inflow} m³/s，低于调峰阈值` }
}

function nowStamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function commit(rows: EntryRow[]): void {
  // 所有字段都在内存行上改完才一次性落盘：事务没走完不落中间态。
  saveRows(HYDROLOGY_KEY, rows)
}

/**
 * 水情动作。
 * 复核退回幂等：已经在待调度（已观测）的记录再点退回只提示一次，不新增痕迹、不新增记录。
 */
export function hydrologyAction(
  id: number,
  action: string,
  operator = '值班管理员',
): ActionResult {
  const rows = listRows(HYDROLOGY_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的水情记录` }
  }
  const current = rows[index]
  const status = String(current.status)
  const stamp = nowStamp()

  const next: EntryRow = { ...current }

  if (action === '提交观测') {
    if (status !== H_STATUS.todo) {
      return { ok: false, message: `当前状态「${status}」不能提交观测，链路只能按待观测→已观测→已调度→已复核顺序走` }
    }
    next.status = H_STATUS.observed
  } else if (action === '下达调度') {
    if (status !== H_STATUS.observed) {
      return { ok: false, message: `当前状态「${status}」不在待调度队列，只有已观测的记录才能下达调度` }
    }
    const { verdict, basis } = dispatchVerdict(current)
    if (verdict === MISSING) {
      return { ok: false, message: '入库流量缺失，按最新观测值无法判定调度方案，请补测后再下达调度' }
    }
    next.status = H_STATUS.dispatched
    next[CONCLUSION_FIELD] = verdict
    next['调度依据'] = basis
    next['调度时间'] = stamp
    next['调度人员'] = operator
    next['复核意见'] = ''
    next['复核时间'] = ''
    next['复核人员'] = ''
  } else if (action === '提交复核') {
    if (status !== H_STATUS.dispatched) {
      return { ok: false, message: `当前状态「${status}」不能提交复核，请先下达调度` }
    }
    next.status = H_STATUS.reviewed
    next['复核意见'] = '复核通过'
    next['复核时间'] = stamp
    next['复核人员'] = operator
  } else if (action === '复核退回') {
    // 已退回的重复触发只记一次：状态已经是待调度，直接幂等返回。
    if (status === H_STATUS.observed) {
      return { ok: true, message: '该记录已在待调度队列，重复退回不重复记账' }
    }
    if (status !== H_STATUS.dispatched && status !== H_STATUS.reviewed) {
      return { ok: false, message: `当前状态「${status}」没有可退回的调度结论` }
    }
    // 整笔退回：状态回到待调度（已观测），上一轮调度/复核结论全部清掉。
    next.status = H_STATUS.observed
    for (const field of CONCLUSION_FIELDS) {
      next[field] = ''
    }
    const count = Number(current[RETURN_COUNT_FIELD] ?? 0)
    next[RETURN_COUNT_FIELD] = Number.isFinite(count) ? count + 1 : 1
    next[TRACE_FIELD] = `${stamp} ${operator} 复核退回（原状态：${status}）`
  } else {
    return { ok: false, message: `水情记录没有登记「${action}」这个动作` }
  }

  // 调度状态列与状态字段读同一份，详情页、列表、队列不会再各说各话。
  next['调度状态'] = next.status
  next.pending = next.status !== H_STATUS.reviewed
  // 异常标记只表达「已退回待调度、等重新判定」这件事，不再用来代替状态。
  next.abnormal = isReturnedState(next)

  try {
    const draft = [...rows]
    draft[index] = next
    commit(draft)
    return { ok: true, message: `水情记录已${action}，当前状态「${next.status}」` }
  } catch {
    return { ok: false, message: `${action}未完成，数据整笔退回，记录仍保持「${status}」` }
  }
}

// —— 待调度队列：泄洪操作页读到的待调度条数与水情这边是同一个数 ——

function byObservedAt(rows: EntryRow[]): EntryRow[] {
  return [...rows].sort((a, b) => {
    const ta = String(a[OBSERVED_AT_FIELD] ?? '')
    const tb = String(b[OBSERVED_AT_FIELD] ?? '')
    if (ta !== tb) {
      return ta < tb ? -1 : 1
    }
    return Number(a.id) - Number(b.id)
  })
}

export function pendingDispatchRows(): EntryRow[] {
  return byObservedAt(listRows(HYDROLOGY_KEY).filter(isPendingDispatch))
}

export function pendingDispatchCount(): number {
  return listRows(HYDROLOGY_KEY).filter(isPendingDispatch).length
}

export function todayFlowTotals(day?: string): { inflow: number; outflow: number; date: string } {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const today = day ?? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  let inflow = 0
  let outflow = 0
  for (const row of listRows(HYDROLOGY_KEY)) {
    if (!String(row[OBSERVED_AT_FIELD] ?? '').startsWith(today)) {
      continue
    }
    const inV = toNumber(row['入库流量'])
    const outV = toNumber(row['出库流量'])
    if (!Number.isNaN(inV)) inflow += inV
    if (!Number.isNaN(outV)) outflow += outV
  }
  return { inflow, outflow, date: today }
}

// —— 过滤收窄 + 分页保持原次序 + 定位 ——

export function hydrologyPage(
  rows: EntryRow[],
  filters: Record<string, string>,
  page: number,
  size: number,
): PageResult {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  // 先按过滤条件收窄，再保持收窄后的原次序分页。
  const matched =
    pairs.length === 0
      ? rows
      : rows.filter((row) =>
          pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
        )
  const safeSize = size > 0 ? size : matched.length || 1
  const totalPages = Math.max(1, Math.ceil(matched.length / safeSize))
  const safePage = Math.min(Math.max(1, page), totalPages)
  const start = (safePage - 1) * safeSize
  return {
    items: matched.slice(start, start + safeSize),
    total: matched.length,
    page: safePage,
    size: safeSize,
  }
}

export function locateRow(
  rows: EntryRow[],
  filters: Record<string, string>,
  id: number,
  size: number,
): LocateResult {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  const matched =
    pairs.length === 0
      ? rows
      : rows.filter((row) =>
          pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
        )
  const index = matched.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { page: 1, index: -1, found: false }
  }
  const safeSize = size > 0 ? size : matched.length || 1
  return { page: Math.floor(index / safeSize) + 1, index: index % safeSize, found: true }
}

// —— 另存的水情记录：只存编号引用，读同一份源数据，同一条反复另存只记一次 ——

const SAVED_KEY = 'hydropower-plant-om:saved-hydrology'

function readSavedIds(): number[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  try {
    const raw = window.localStorage.getItem(SAVED_KEY)
    return raw ? (JSON.parse(raw) as number[]) : []
  } catch {
    return []
  }
}

export function savedRows(): EntryRow[] {
  const ids = new Set(readSavedIds())
  return byObservedAt(listRows(HYDROLOGY_KEY).filter((row) => ids.has(Number(row.id))))
}

export function saveHydrologyCopy(id: number): { duplicated: boolean; ok: boolean } {
  const ids = readSavedIds()
  if (ids.includes(id)) {
    return { duplicated: true, ok: true }
  }
  const next = [...ids, id]
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(SAVED_KEY, JSON.stringify(next))
  }
  return { duplicated: false, ok: true }
}
