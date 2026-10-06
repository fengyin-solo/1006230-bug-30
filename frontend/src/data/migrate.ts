import type { EntryRow } from './types'
import { BUSINESS_DATE_FIELD, DATE_SOURCE, MISSING_TAG, NUMERIC_FIELDS } from './ledger-config'

// 存量数据迁移：版本化执行，只跑一次；任何一模块都按「业务日期回填 + 缺失取值标注」处理。
export const SCHEMA_VERSION = 2

const HYDROLOGY_KEY = 'hydrology'
const H_REVIEWED = '已复核'
const H_OBSERVED = '已观测'
const H_DISPATCHED = '已调度'

const TRACE_FIELD = '复核退回痕迹'
const RETURN_COUNT_FIELD = '退回次数'
const CORRECTED_FIELD = '存量拨正'
const CONCLUSION_FIELDS = ['调度结论', '调度依据', '调度时间', '调度人员', '复核意见', '复核时间', '复核人员']

function stampNow(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 数值取值：解析得出数字就保留，取不到（占位文字、空值）单独标注「缺失」。 */
export function numericOrMissing(value: string | number | boolean | undefined): string | number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : MISSING_TAG
  }
  if (typeof value !== 'string' || value.trim() === '' || value.trim() === MISSING_TAG) {
    return MISSING_TAG
  }
  const parsed = Number(value.replace(/[^\d.-]/g, ''))
  return Number.isFinite(parsed) ? value : MISSING_TAG
}

/**
 * 拨正裁决（早期只打退回标记、状态卡在已调度/已复核的存量）：
 * 凡带回退痕迹（复核退回/撤回，或退回次数大于 0）却不在待调度的，
 * 一律退回「已观测」待调度，清掉上一轮调度/复核结论，并在「存量拨正」里留痕。
 */
function correctHydrologyRow(row: EntryRow, stamp: string): EntryRow {
  const next: EntryRow = { ...row }
  const status = String(next.status)
  const trace = String(next[TRACE_FIELD] ?? '')
  const count = Number(next[RETURN_COUNT_FIELD] ?? 0)
  const hasReturnTrace = /退回|撤回/.test(trace)
  const returned = hasReturnTrace || count > 0

  if (returned && (status === H_DISPATCHED || status === H_REVIEWED)) {
    next.status = H_OBSERVED
    for (const field of CONCLUSION_FIELDS) {
      next[field] = ''
    }
    next[CORRECTED_FIELD] = `${stamp} 存量拨正：原状态「${status}」实际已退回，退回待调度并清除上一轮调度结论`
  }
  if (returned && !Number.isFinite(count)) {
    next[RETURN_COUNT_FIELD] = 1
  }
  // 列表、详情、队列读同一份状态字段，消除「调度状态」列与状态不一致。
  next['调度状态'] = String(next.status)
  next.pending = next.status !== H_REVIEWED
  const finalCount = Number(next[RETURN_COUNT_FIELD] ?? 0)
  next.abnormal = next.status === H_OBSERVED && finalCount > 0
  return next
}

export function migrateModule(key: string, rows: EntryRow[]): EntryRow[] {
  const dateSource = DATE_SOURCE[key]
  const numericFields = NUMERIC_FIELDS[key] ?? []
  const stamp = stampNow()
  return rows.map((rawRow) => {
    let row: EntryRow = { ...rawRow }
    if (dateSource) {
      const source = row[dateSource]
      row[BUSINESS_DATE_FIELD] =
        typeof source === 'string' && source.trim() !== '' ? source.slice(0, 10) : MISSING_TAG
    } else {
      row[BUSINESS_DATE_FIELD] = MISSING_TAG
    }
    for (const field of numericFields) {
      row[field] = numericOrMissing(row[field])
    }
    if (key === HYDROLOGY_KEY) {
      row = correctHydrologyRow(row, stamp)
    }
    return row
  })
}

export function migrateRows(all: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const result: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(all)) {
    result[key] = migrateModule(key, rows)
  }
  return result
}
