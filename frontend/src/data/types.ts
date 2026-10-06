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
  /** 状态机：哪些动作只允许从指定状态发出；缺省的动作沿用原来的通用流转。 */
  guardedActions?: Record<string, string | string[]>
  /** 反向动作：目标状态不是链路终点，执行后仍要留在待办队列里。 */
  rollbackActions?: string[]
}

export type PageQuery = {
  filters?: Record<string, string>
  page?: number
  size?: number
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

/** 过滤收窄后某条记录在原次序中的定位：页码 + 页内序号。 */
export type LocateResult = {
  page: number
  index: number
  found: boolean
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
