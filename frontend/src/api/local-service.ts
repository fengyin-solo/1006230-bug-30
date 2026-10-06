import {
  ACTION_DISPATCH,
  ACTION_REVIEW_RETURN,
  ACTION_SUBMIT_OBSERVATION,
  ACTION_SUBMIT_REVIEW,
  HYDROLOGY_COLUMNS,
  HYDROLOGY_KEY,
  HYDROLOGY_STATUSES,
  HYDROLOGY_TRAIL_FIELDS,
  MISSING_TAG,
  STATUS_OBSERVED,
  buildDispatchedRow,
  buildReturnedRow,
  canReturn,
  compareByObservationTime,
  findRow,
  hydrologyStats,
  isPendingDispatch,
} from '@/domain/hydrology'
import { MODULE_BY_KEY } from '@/data/modules'
import { listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ListQuery,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export const DEFAULT_PAGE_SIZE = 5

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

function orderedRows(key: string): EntryRow[] {
  const rows = [...listRows(key)]
  if (key === HYDROLOGY_KEY) {
    rows.sort(compareByObservationTime)
  }
  return rows
}

// 按过滤条件收窄后再分页，分页切片不改变次序；未传分页时向后兼容（整页返回）。
export function listEntries(key: string, query: ListQuery = {}): PageResult {
  const filters = query.filters ?? {}
  const matched = filterRows(orderedRows(key), filters)
  if (query.page === undefined || query.size === undefined) {
    return { items: matched, total: matched.length, page: 1, size: matched.length, totalPages: 1 }
  }
  const size = Math.max(1, query.size)
  const totalPages = Math.max(1, Math.ceil(matched.length / size))
  const page = Math.min(Math.max(1, query.page), totalPages)
  const start = (page - 1) * size
  return {
    items: matched.slice(start, start + size),
    total: matched.length,
    page,
    size,
    totalPages,
  }
}

// 找到记录后把页码定位到它在过滤结果中的位置，供动作执行后「定位回这条」。
export function locatePage(
  key: string,
  id: number,
  filters: Record<string, string>,
  size: number,
): number {
  const matched = filterRows(orderedRows(key), filters)
  const index = matched.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return 1
  }
  return Math.floor(index / Math.max(1, size)) + 1
}

function lastStatus(meta: ModuleMeta): string {
  return meta.statuses[meta.statuses.length - 1]
}

// 顺序链路校验：目标状态必须恰好是当前状态的下一站，跳步与回头都拒绝。
function assertSequential(meta: ModuleMeta, current: string, target: string): string | null {
  if (!meta.ordered) {
    return null
  }
  const currentIndex = meta.statuses.indexOf(current)
  const targetIndex = meta.statuses.indexOf(target)
  if (currentIndex < 0) {
    return `${meta.entity}当前状态「${current}」不在链路上，无法流转`
  }
  if (targetIndex !== currentIndex + 1) {
    if (targetIndex <= currentIndex) {
      return `${meta.entity}已走过「${target}」，链路不能倒退`
    }
    const next = meta.statuses[currentIndex + 1]
    return `链路只能按顺序走，请先执行到「${next}」`
  }
  return null
}

function commitRow(key: string, rows: EntryRow[], index: number, updated: EntryRow): void {
  // 先在副本上完成全部改动，校验通过后才整笔落库；任何异常抛出时旧快照原样保留。
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
}

// 水情动作单独走领域规则：复核退回、按新观测值重判、链路顺序都在这里闭环。
type HydrologyOutcome = EntryRow | ActionResult | 'continue'

function isActionOutcome(value: HydrologyOutcome): value is ActionResult {
  return value !== 'continue' && typeof (value as ActionResult).ok === 'boolean'
}

function runHydrologyAction(row: EntryRow, action: string): HydrologyOutcome {
  const current = String(row.status)

  if (action === ACTION_REVIEW_RETURN) {
    if (current === STATUS_OBSERVED) {
      // 同一轮复核退回只退一次：重复触发直接拒绝，不再多盖一条痕迹。
      return { ok: false, message: '该水情记录已在待调度队列，重复退回不再记录' }
    }
    if (!canReturn(row)) {
      return { ok: false, message: `状态为「${current}」的水情记录不能复核退回` }
    }
    return buildReturnedRow(row)
  }

  if (action === ACTION_DISPATCH) {
    if (current !== STATUS_OBSERVED) {
      return {
        ok: false,
        message:
          current === '待观测'
            ? '链路只能按顺序走，请先提交观测'
            : '该水情记录已经下达过调度，无需重复下达',
      }
    }
    try {
      return buildDispatchedRow(row)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '调度判定失败' }
    }
  }

  if (action === ACTION_SUBMIT_OBSERVATION) {
    if (current !== '待观测') {
      return { ok: false, message: '该水情记录已提交观测，不能重复提交' }
    }
  }

  if (action === ACTION_SUBMIT_REVIEW) {
    if (current !== '已调度') {
      return {
        ok: false,
        message:
          current === '已复核'
            ? '该水情记录已经复核'
            : '链路只能按顺序走，请先下达调度再提交复核',
      }
    }
  }

  return 'continue'
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)

  if (key === HYDROLOGY_KEY) {
    const outcome = runHydrologyAction(rows[index], action)
    if (outcome !== 'continue') {
      if (isActionOutcome(outcome)) {
        return outcome
      }
      try {
        commitRow(key, rows, index, outcome)
      } catch {
        return { ok: false, message: '数据保存失败，本次操作已整笔退回' }
      }
      if (action === ACTION_REVIEW_RETURN) {
        return { ok: true, message: '复核已退回，水情记录回到待调度队列，上一轮调度结论已清除' }
      }
      if (action === ACTION_DISPATCH) {
        return {
          ok: true,
          message: `已按最新观测值下达调度，调度结论「${outcome['调度结论']}」，当前状态「${target}」`,
        }
      }
      return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
    }
  } else {
    if (current === target) {
      return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
    }
    const blocked = assertSequential(meta, current, target)
    if (blocked) {
      return { ok: false, message: blocked }
    }
  }

  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus(meta),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  try {
    commitRow(key, rows, index, updated)
  } catch {
    return { ok: false, message: '数据保存失败，本次操作已整笔退回' }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

// 导出明细沿用当前过滤条件与同一排序；空值按页面的「缺失」口径标注，页面台账对得上。
export function exportEntries(
  key: string,
  filters: Record<string, string> = {},
): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const rows = filterRows(orderedRows(key), filters)

  if (key === HYDROLOGY_KEY) {
    const header = ['编号', ...HYDROLOGY_COLUMNS, '当前状态', ...HYDROLOGY_TRAIL_FIELDS]
    const lines = [header.join(',')]
    for (const row of rows) {
      const cells = HYDROLOGY_COLUMNS.map((field) => {
        const value = row[field]
        if (field !== '记录编号' && (value === null || value === undefined || value === '')) {
          return MISSING_TAG
        }
        return value ?? MISSING_TAG
      })
      lines.push(
        [
          row.id,
          ...cells,
          row.status,
          row['调度结论'] ?? '',
          row['调度时间'] ?? '',
          row['退回痕迹'] ?? '',
          row['缺失取值'] ? `${MISSING_TAG}：${row['缺失取值']}` : '',
        ]
          .map(csvCell)
          .join(','),
      )
    }
    return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
  }

  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string, filters: Record<string, string> = {}): void {
  const { filename, content } = exportEntries(key, filters)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function getHydrologyStats() {
  return hydrologyStats(listRows(HYDROLOGY_KEY))
}

// 泄洪侧读的待调度条数：直接数水情台账里的「已观测」，两边永远是同一份数据。
export function pendingDispatchCount(): number {
  return listRows(HYDROLOGY_KEY).filter(isPendingDispatch).length
}

export function getHydrologyRow(id: number): EntryRow | undefined {
  return findRow(listRows(HYDROLOGY_KEY), id)
}

export function hydrologyStatusRows(): EntryRow[] {
  return orderedRows(HYDROLOGY_KEY)
}

export function countByStatus(key: string, status: string): number {
  return listRows(key).filter((row) => String(row.status) === status).length
}

export { HYDROLOGY_STATUSES }

export function loadOverview(): OverviewResult {
  const rowsByKey: Record<string, EntryRow[]> = {}
  for (const key of MODULE_BY_KEY.keys()) {
    rowsByKey[key] = listRows(key)
  }
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rowsByKey[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
