// 存量台账回填配置：每个模块业务日期取哪个字段、哪些字段是数值取值。
// 取源字段缺失时业务日期/取值单独标注「缺失」，不猜值。

export const BUSINESS_DATE_FIELD = '业务日期'
export const MISSING_TAG = '缺失'

export const DATE_SOURCE: Record<string, string> = {
  station: '投运日期',
  governor: '校验日期',
  excitation: '检查日期',
  transformer: '试验日期',
  gate: '操作时间',
  seepage: '监测日期',
  trashrack: '清理日期',
  bearing: '检测日期',
  cooling: '检查日期',
  hydrology: '观测时间',
  flood: '操作时间',
  generation: '计划日期',
  protection: '上次校验日',
  defect: '发现日期',
}

// 需要按数值解析、解析不出来就单独标注「缺失」的取值字段。
export const NUMERIC_FIELDS: Record<string, string[]> = {
  hydrology: ['上游水位', '下游水位', '入库流量', '出库流量'],
  bearing: ['上导温度', '下导温度', '油位高度', '振动数值'],
  flood: ['开启孔数', '泄洪流量'],
}
