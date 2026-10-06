import type { EntryRow } from '@/data/types'

// 水情调度领域规则：状态链路、退回、调度判定、存量修复都收敛在这里，
// 列表、调度队列、详情弹窗、泄洪侧读数与导出共用同一份逻辑。

export const HYDROLOGY_KEY = 'hydrology'

export const STATUS_OBSERVING = '待观测'
export const STATUS_OBSERVED = '已观测' // 已观测即「待调度」，调度员队列只认这个状态
export const STATUS_DISPATCHED = '已调度'
export const STATUS_REVIEWED = '已复核'

export const HYDROLOGY_STATUSES = [
  STATUS_OBSERVING,
  STATUS_OBSERVED,
  STATUS_DISPATCHED,
  STATUS_REVIEWED,
]

export const ACTION_SUBMIT_OBSERVATION = '提交观测'
export const ACTION_DISPATCH = '下达调度'
export const ACTION_SUBMIT_REVIEW = '提交复核'
export const ACTION_REVIEW_RETURN = '复核退回'

// 页面与导出的列：调度状态不再单独占一列（与当前状态重复，曾是两处不一致的根源）。
export const HYDROLOGY_COLUMNS = [
  '记录编号',
  '观测时间',
  '上游水位',
  '下游水位',
  '入库流量',
  '出库流量',
  '值守人员',
]
export const HYDROLOGY_TRAIL_FIELDS = ['调度结论', '调度时间', '退回痕迹', '缺失取值']

export const FIELD_DISPATCH_CONCLUSION = '调度结论'
export const FIELD_DISPATCH_TIME = '调度时间'
export const FIELD_RETURN_TRAIL = '退回痕迹'
export const FIELD_MISSING = '缺失取值'

// 需要可计量的取值：存量里这些字段为空或仍是「样例N」占位的，统一标注为缺失。
export const MEASURE_FIELDS = ['上游水位', '下游水位', '入库流量', '出库流量']

export const MISSING_TAG = '缺失'

const PLACEHOLDER_PATTERN = /样例\s*\d*$/
const LEGACY_RETURN_FLAG = 'abnormal' // 旧版退回只留下这个标记，状态没跟着退

// 入库流量（m³/s）阈值：按当前观测值判定调度结论，退回重排后以新一轮取值重算。
const FLOOD_DISPATCH_THRESHOLD = 3000
const GENERATION_DISPATCH_THRESHOLD = 800

export function todayString(): string {
  return new Date().toISOString().slice(0, 10)
}

function isMissingValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true
  }
  const text = String(value).trim()
  return text === '' || PLACEHOLDER_PATTERN.test(text)
}

export function toNumber(value: unknown): number | null {
  if (isMissingValue(value)) {
    return null
  }
  const num = Number(String(value).replace(/,/g, ''))
  return Number.isFinite(num) ? num : null
}

export function isPendingDispatch(row: EntryRow): boolean {
  return String(row.status) === STATUS_OBSERVED
}

export function pendingDispatchRows(rows: EntryRow[]): EntryRow[] {
  return rows.filter(isPendingDispatch)
}

// 同一次序口径：观测时间升序，时间相同按编号升序；列表、队列、分页、导出都用它。
export function compareByObservationTime(a: EntryRow, b: EntryRow): number {
  const ta = String(a['观测时间'] ?? '')
  const tb = String(b['观测时间'] ?? '')
  if (ta !== tb) {
    return ta < tb ? -1 : 1
  }
  return Number(a.id) - Number(b.id)
}

// 按当前观测值判定调度结论；取值缺失（含存量占位符）直接抛错，由调用方整笔退回。
export function evaluateDispatch(row: EntryRow): string {
  const inflow = toNumber(row['入库流量'])
  if (inflow === null) {
    throw new Error('入库流量取值缺失，无法判定调度结论，请补测后重新下达')
  }
  if (inflow >= FLOOD_DISPATCH_THRESHOLD) {
    return '泄洪调度'
  }
  if (inflow >= GENERATION_DISPATCH_THRESHOLD) {
    return '发电调度'
  }
  return '蓄水调度'
}

// 存量修复（幂等）：旧版退回只打 abnormal 标记、状态没退，这里按观测时间统一拨正。
// 裁决：痕迹为真却卡在 已调度/已复核 的，一律打回「已观测」重排，上一轮结论作废，
// 退回痕迹按观测时间回填；已在「已观测」的只补痕迹、不重复计数。
export function normalizeHydrologyRows(input: EntryRow[] = []): EntryRow[] {
  return input.map((item) => {
    const row: EntryRow = { ...item }

    const missingLabels: string[] = []
    for (const field of MEASURE_FIELDS) {
      if (isMissingValue(row[field])) {
        missingLabels.push(field)
        row[field] = ''
      }
    }
    row[FIELD_MISSING] = missingLabels.join('、')

    row[FIELD_DISPATCH_CONCLUSION] = String(row[FIELD_DISPATCH_CONCLUSION] ?? '')
    row[FIELD_DISPATCH_TIME] = String(row[FIELD_DISPATCH_TIME] ?? '')
    row[FIELD_RETURN_TRAIL] = String(row[FIELD_RETURN_TRAIL] ?? '')

    const hadReturnTrail = row[LEGACY_RETURN_FLAG] === true
    const status = String(row.status)
    if (hadReturnTrail && status !== STATUS_OBSERVING) {
      row.status = STATUS_OBSERVED
      row[FIELD_DISPATCH_CONCLUSION] = ''
      row[FIELD_DISPATCH_TIME] = ''
      if (!row[FIELD_RETURN_TRAIL]) {
        row[FIELD_RETURN_TRAIL] = String(row['观测时间'] ?? todayString())
      }
    }
    if (hadReturnTrail) {
      row.abnormal = false
    }
    row.pending = row.status !== STATUS_REVIEWED
    return row
  }).sort((a, b) => compareByObservationTime(a, b))
}

// 复核退回：只允许从 已调度/已复核 退到 已观测；重复退回交调用方拒绝，不重复留痕。
export function canReturn(row: EntryRow): boolean {
  return [STATUS_DISPATCHED, STATUS_REVIEWED].includes(String(row.status))
}

export function buildReturnedRow(row: EntryRow): EntryRow {
  return {
    ...row,
    status: STATUS_OBSERVED,
    pending: true,
    abnormal: false,
    [FIELD_DISPATCH_CONCLUSION]: '',
    [FIELD_DISPATCH_TIME]: '',
    // 同一轮退回只盖一次时间戳；重新调度后该痕迹清空，下一轮退回才重新盖。
    [FIELD_RETURN_TRAIL]: String(row[FIELD_RETURN_TRAIL] ?? '') || todayString(),
  }
}

// 重新下达调度：清掉上一轮退回痕迹，按新观测值重算结论。
export function buildDispatchedRow(row: EntryRow): EntryRow {
  const conclusion = evaluateDispatch(row)
  return {
    ...row,
    status: STATUS_DISPATCHED,
    pending: true,
    abnormal: false,
    [FIELD_DISPATCH_CONCLUSION]: conclusion,
    [FIELD_DISPATCH_TIME]: todayString(),
    [FIELD_RETURN_TRAIL]: '',
  }
}

export type HydrologyStats = {
  todayInflow: number
  todayOutflow: number
  pendingDispatch: number
}

export function hydrologyStats(rows: EntryRow[]): HydrologyStats {
  const today = todayString()
  let todayInflow = 0
  let todayOutflow = 0
  for (const row of rows) {
    if (String(row['观测时间'] ?? '') !== today) {
      continue
    }
    todayInflow += toNumber(row['入库流量']) ?? 0
    todayOutflow += toNumber(row['出库流量']) ?? 0
  }
  return {
    todayInflow,
    todayOutflow,
    pendingDispatch: pendingDispatchRows(rows).length,
  }
}

// 详情弹窗与列表取同一条记录：按 id 回查，避免两处各持一份状态。
export function findRow(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}
