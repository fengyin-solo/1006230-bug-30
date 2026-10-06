/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  // 开启后动作只能沿 statuses 顺序推进，跳步（如未观测直接调度）会被拒绝。
  ordered?: boolean
}

export type ListQuery = {
  filters?: Record<string, string>
  page?: number
  size?: number
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
  // 当前过滤条件下的总页数：页面分页器与导出共用同一口径。
  totalPages: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
