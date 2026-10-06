import { MODULE_BY_KEY } from '@/data/modules'
import {
  hydrologyAction,
  HYDROLOGY_KEY,
  isPendingDispatch,
} from '@/data/hydrology'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageQuery,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 待办口径统一由状态派生：列表、看板、另一个入口读到同一个数，不依赖可能漂移的存量标记。
const FINAL_STATUS: Record<string, string[]> = {
  // 水情：待观测、已观测都还在待办；已复核才闭环。待调度队列另外只取已观测。
  hydrology: ['已复核'],
  flood: ['已结束'],
}

export function isPendingRow(meta: ModuleMeta, row: EntryRow): boolean {
  const finals = FINAL_STATUS[meta.key] ?? [meta.statuses[meta.statuses.length - 1]]
  return !finals.includes(String(row.status))
}

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

/** 按过滤条件收窄后，保持原次序分页；不传分页参数时一次性返回全部（与旧调用兼容）。 */
export function listEntries(
  key: string,
  query: Record<string, string> | PageQuery = {},
): PageResult {
  // 旧调用传的是纯过滤对象，新调用带 filters/page/size，这里归一化一次。
  const normalized: PageQuery =
    'filters' in query || 'page' in query || 'size' in query
      ? (query as PageQuery)
      : { filters: query as Record<string, string> }
  const filters = normalized.filters ?? {}
  const matched = filterRows(listRows(key), filters)
  const page = normalized.page ?? 1
  const safeSize =
    normalized.size && normalized.size > 0 ? normalized.size : matched.length || 1
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

function guardedStatuses(meta: ModuleMeta, action: string): string[] | null {
  const rule = meta.guardedActions?.[action]
  if (!rule) {
    return null
  }
  return Array.isArray(rule) ? rule : [rule]
}

export function runAction(key: string, id: number, action: string, operator?: string): ActionResult {
  // 水情调度链路有独立状态机：退回清结论、幂等、事务化都在领域逻辑里处理。
  if (key === HYDROLOGY_KEY) {
    return hydrologyAction(id, action, operator)
  }
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
  const allowed = guardedStatuses(meta, action)
  if (allowed && !allowed.includes(current)) {
    return {
      ok: false,
      message: `当前状态「${current}」不能${action}（仅「${allowed.join('、')}」可执行）`,
    }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const isRollback = (meta.rollbackActions ?? []).includes(action)
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    // 反向动作不闭环：退回的记录要重新出现在待办里。
    pending: isRollback ? true : isPendingRow(meta, { ...rows[index], status: target } as EntryRow),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  try {
    const next = [...rows]
    next[index] = updated
    saveRows(key, next)
  } catch {
    return { ok: false, message: `${action}未完成，数据整笔退回，记录仍保持「${current}」` }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  // 水情字段末列就是「调度状态」，导出列与页面台账一一对应，不再追加重复的状态列。
  const header = key === HYDROLOGY_KEY ? ['编号', ...meta.fields] : ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    const cells =
      key === HYDROLOGY_KEY
        ? [row.id, ...meta.fields.map((field) => row[field] ?? '')]
        : [row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status]
    lines.push(cells.map((cell) => String(cell)).join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
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

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => isPendingRow(meta, row)).length,
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

// —— 跨模块同一个口径：泄洪操作页读到的待调度条数，直接来自水情这份数据 ——

export { isPendingDispatch }
