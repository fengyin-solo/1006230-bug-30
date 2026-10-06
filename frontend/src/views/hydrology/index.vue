<template>
  <section class="page" data-module="hydrology">
    <header class="page-head">
      <div>
        <h2>水情调度管理</h2>
        <p class="page-desc">维护水情记录，围绕记录编号、观测时间、上游水位、下游水位做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记水情记录</button>
        <button class="btn" type="button" @click="exportRows">导出当前台账</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <div class="tab-bar" role="tablist">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-item"
        :class="{ active: activeTab === tab.key }"
        type="button"
        role="tab"
        @click="switchTab(tab.key)"
      >
        {{ tab.label }}
        <span v-if="tab.key === 'queue'" class="tab-badge">{{ stats[2].value }}</span>
      </button>
    </div>

    <form class="filter-bar" @submit.prevent="reload(1)">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th v-for="field in trailFields" :key="field">{{ field }}</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-returned': !!row['退回痕迹'] }">
          <td v-for="column in columns" :key="column">
            <template v-if="isMeasureColumn(column) && isMissing(row[column])">
              <span class="missing-tag">缺失</span>
            </template>
            <template v-else>{{ displayValue(row[column]) }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td>{{ displayValue(row['调度结论']) }}</td>
          <td>{{ displayValue(row['调度时间']) }}</td>
          <td>
            <span v-if="row['退回痕迹']" class="return-trail">已退回 {{ row['退回痕迹'] }}</span>
            <span v-else>—</span>
          </td>
          <td>{{ row['缺失取值'] ? `缺失：${row['缺失取值']}` : '完整' }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              :class="{ 'link-danger': action === '复核退回' }"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + trailFields.length + 2" class="empty-state">
            暂无符合条件的水情记录
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条水情调度记录，第 {{ page }} / {{ totalPages }} 页</span>
      <span class="pager">
        <button class="btn" type="button" :disabled="page <= 1" @click="reload(page - 1)">上一页</button>
        <button
          class="btn"
          type="button"
          :disabled="page >= totalPages"
          @click="reload(page + 1)"
        >
          下一页
        </button>
      </span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="flashMessage" class="flash-text">{{ flashMessage }}</span>
    </footer>

    <div v-if="detailRow" class="modal-mask" role="dialog" aria-modal="true" @click.self="closeDetail">
      <div class="modal-panel">
        <header class="modal-head">
          <h3>水情记录详情 · {{ detailRow['记录编号'] }}</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>
        <table class="data-table detail-table">
          <tbody>
            <tr v-for="item in detailItems" :key="item.label">
              <th>{{ item.label }}</th>
              <td>
                <template v-if="item.measure && isMissing(item.value)">
                  <span class="missing-tag">缺失</span>
                </template>
                <template v-else>{{ displayValue(item.value) }}</template>
              </td>
            </tr>
          </tbody>
        </table>
        <footer class="modal-foot">
          <button
            v-for="action in availableActions(detailRow)"
            :key="action"
            class="btn"
            :class="{ primary: action !== '复核退回', danger: action === '复核退回' }"
            type="button"
            @click="runAction(action, detailRow)"
          >
            {{ action }}
          </button>
        </footer>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  DEFAULT_PAGE_SIZE,
  downloadEntries,
  getHydrologyStats,
  hydrologyStatusRows,
  listEntries,
  locatePage,
  moduleMeta,
  runAction as applyAction,
  HYDROLOGY_STATUSES,
} from '@/api/local-service'
import {
  ACTION_DISPATCH,
  ACTION_REVIEW_RETURN,
  ACTION_SUBMIT_OBSERVATION,
  ACTION_SUBMIT_REVIEW,
  HYDROLOGY_COLUMNS,
  HYDROLOGY_TRAIL_FIELDS,
  MEASURE_FIELDS,
  STATUS_DISPATCHED,
  STATUS_OBSERVED,
  STATUS_OBSERVING,
} from '@/domain/hydrology'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('hydrology')
const columns = HYDROLOGY_COLUMNS
const trailFields = HYDROLOGY_TRAIL_FIELDS
const filterFields = columns.slice(0, 3)
const size = DEFAULT_PAGE_SIZE

const tabs = [
  { key: 'all', label: '全部记录' },
  { key: 'queue', label: '待调度队列' },
] as const

type TabKey = (typeof tabs)[number]['key']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const page = ref(1)
const totalPages = ref(1)
const errorMessage = ref('')
const flashMessage = ref('')
const filters = ref<Record<string, string>>({})
const activeTab = ref<TabKey>('all')
const detailRow = ref<EntryRow | null>(null)
const stats = ref([
  { label: '今日入库流量（m³/s）', value: 0 },
  { label: '今日出库流量（m³/s）', value: 0 },
  { label: '待调度记录', value: 0 },
])

// 状态汇总、指标都不过滤：与调度队列、泄洪侧读数同源，避免两边对不上。
const statusSummary = computed(() => {
  const all = hydrologyStatusRows()
  return HYDROLOGY_STATUSES.map((status: string) => ({
    status,
    count: all.filter((row) => String(row.status) === status).length,
  }))
})

const detailItems = computed(() => {
  if (!detailRow.value) {
    return []
  }
  const row = detailRow.value
  return [
    { label: '当前状态', value: row.status, measure: false },
    ...columns.map((field) => ({
      label: field,
      value: row[field],
      measure: MEASURE_FIELDS.includes(field),
    })),
    { label: '调度结论', value: row['调度结论'], measure: false },
    { label: '调度时间', value: row['调度时间'], measure: false },
    { label: '退回痕迹', value: row['退回痕迹'] ? `已退回 ${row['退回痕迹']}` : '', measure: false },
    { label: '缺失取值', value: row['缺失取值'] ? `缺失：${row['缺失取值']}` : '完整', measure: false },
  ]
})

function effectiveFilters(): Record<string, string> {
  if (activeTab.value === 'queue') {
    // 调度队列只收「已观测（待调度）」；其余状态在这里一律看不到。
    return { ...filters.value, status: STATUS_OBSERVED }
  }
  return { ...filters.value }
}

function availableActions(row: EntryRow): string[] {
  switch (String(row.status)) {
    case STATUS_OBSERVING:
      return [ACTION_SUBMIT_OBSERVATION]
    case STATUS_OBSERVED:
      return [ACTION_DISPATCH]
    case STATUS_DISPATCHED:
      return [ACTION_SUBMIT_REVIEW, ACTION_REVIEW_RETURN]
    default:
      // 已复核只能由复核入口退回，详情与列表给出同一动作集。
      return [ACTION_REVIEW_RETURN]
  }
}

function isMeasureColumn(column: string): boolean {
  return MEASURE_FIELDS.includes(column)
}

function isMissing(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === ''
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || String(value).trim() === '') {
    return '—'
  }
  return String(value)
}

function switchTab(key: TabKey) {
  activeTab.value = key
  reload(1)
}

function resetFilters() {
  filters.value = {}
  reload(1)
}

function refreshStats() {
  const payload = getHydrologyStats()
  stats.value = [
    { label: '今日入库流量（m³/s）', value: payload.todayInflow },
    { label: '今日出库流量（m³/s）', value: payload.todayOutflow },
    { label: '待调度记录', value: payload.pendingDispatch },
  ]
}

function exportRows() {
  downloadEntries(meta.key, effectiveFilters())
}

function openCreate() {
  errorMessage.value = '水情记录登记入口尚未接入审批流'
}

function openDetail(row: EntryRow) {
  errorMessage.value = ''
  detailRow.value = row
}

function closeDetail() {
  detailRow.value = null
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  flashMessage.value = result.message
  detailRow.value = null
  // 保持过滤条件与原次序，定位到动作后这条记录所在页。
  const targetPage = locatePage(meta.key, Number(row.id), effectiveFilters(), size)
  reload(targetPage)
}

function reload(nextPage?: number) {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, {
      filters: effectiveFilters(),
      page: nextPage ?? page.value,
      size,
    })
    rows.value = payload.items
    total.value = payload.total
    page.value = payload.page
    totalPages.value = payload.totalPages
    refreshStats()
    if (detailRow.value) {
      // 详情弹窗读的是同一份台账：动作后按 id 回查，两处状态不可能再不一致。
      const latest = hydrologyStatusRows().find((item) => item.id === detailRow.value?.id)
      detailRow.value = latest ?? null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '水情调度列表读取失败'
  }
}

onMounted(() => reload(1))
</script>
