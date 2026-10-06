<template>
  <section class="page" data-module="hydrology">
    <header class="page-head">
      <div>
        <h2>水情调度管理</h2>
        <p class="page-desc">待观测→已观测→已调度→已复核按链路顺序流转；复核退回整笔退回待调度并清除上一轮调度结论。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记水情记录</button>
        <button class="btn" type="button" @click="exportRows">导出水情调度清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="tab-row">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-btn"
        :class="{ active: activeTab === tab.key }"
        type="button"
        @click="switchTab(tab.key)"
      >
        {{ tab.label }}<span class="tab-count">{{ tab.count }}</span>
      </button>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form v-if="activeTab === 'ledger'" class="filter-bar" @submit.prevent="reload">
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
          <th v-for="column in tableColumns" :key="column">{{ column }}</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in tableColumns" :key="column">
            <button v-if="column === '记录编号'" class="link" type="button" @click="openDetail(row)">
              {{ row[column] ?? '—' }}
            </button>
            <template v-else>
              <span :class="{ 'missing-tag': row[column] === '缺失' }">{{ row[column] || '—' }}</span>
            </template>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action.name"
              class="link"
              :class="{ danger: action.name === '复核退回' }"
              type="button"
              @click="runAction(action.name, row)"
            >
              {{ action.name }}
            </button>
            <button
              v-if="activeTab !== 'saved'"
              class="link"
              type="button"
              @click="saveCopy(row)"
            >
              另存
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="tableColumns.length + 1" class="empty-state">{{ emptyText }}</td>
        </tr>
      </tbody>
    </table>

    <footer v-if="activeTab === 'ledger'" class="page-foot">
      <span>
        共 {{ total }} 条水情记录，第 {{ page }} / {{ totalPages }} 页
      </span>
      <span class="pager">
        <button class="btn" type="button" :disabled="page <= 1" @click="goPage(page - 1)">上一页</button>
        <button class="btn" type="button" :disabled="page >= totalPages" @click="goPage(page + 1)">下一页</button>
      </span>
    </footer>
    <footer v-else class="page-foot">
      <span>共 {{ total }} 条{{ activeTab === 'queue' ? '待调度' : '另存' }}记录（与水情台账读同一份）</span>
    </footer>
    <footer v-if="errorMessage" class="page-foot">
      <span class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="detail" class="modal-mask" @click.self="closeDetail">
      <div class="modal-card">
        <header class="modal-head">
          <h3>水情记录详情 {{ detail['记录编号'] }}</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>
        <table class="data-table">
          <tbody>
            <tr v-for="field in detailFields" :key="field">
              <th>{{ field }}</th>
              <td>
                <span :class="{ 'missing-tag': detail[field] === '缺失' }">{{ detail[field] || '—' }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <footer class="modal-actions">
          <button
            v-for="action in actionsFor(detail)"
            :key="action.name"
            class="btn"
            :class="{ primary: action.name !== '复核退回', danger: action.name === '复核退回' }"
            type="button"
            @click="runAction(action.name, detail)"
          >
            {{ action.name }}
          </button>
        </footer>
        <p v-if="detailMessage" class="error-text">{{ detailMessage }}</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  hydrologyPage,
  locateRow,
  pendingDispatchCount,
  pendingDispatchRows,
  saveHydrologyCopy,
  savedRows,
  todayFlowTotals,
} from '@/data/hydrology'
import { listRows } from '@/data/local-store'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const session = useSessionStore()
const meta = moduleMeta('hydrology')
// 「调度状态」与状态字段同源并在每次动作时同步，是台账与详情唯一的状态列；导出列也与它一致。
const columns = meta.fields
const PAGE_SIZE = 5
const STATUS_FLOW = ['待观测', '已观测', '已调度', '已复核']

type TabKey = 'ledger' | 'queue' | 'saved'
const activeTab = ref<TabKey>('ledger')

const rows = ref<EntryRow[]>([])
const total = ref(0)
const page = ref(1)
const filters = ref<Record<string, string>>({})
const filterFields = ['记录编号', '观测时间', '上游水位']
const errorMessage = ref('')

const detail = ref<EntryRow | null>(null)
const detailMessage = ref('')

const stats = computed(() => {
  const flow = todayFlowTotals()
  return [
    { label: `今日入库流量（${flow.date}）`, value: `${flow.inflow} m³/s` },
    { label: '今日出库流量', value: `${flow.outflow} m³/s` },
    { label: '待调度记录', value: pendingDispatchCount() },
  ]
})

const tabs = computed(() => [
  { key: 'ledger' as TabKey, label: '水情台账', count: listRows(meta.key).length },
  { key: 'queue' as TabKey, label: '待调度队列', count: pendingDispatchCount() },
  { key: 'saved' as TabKey, label: '另存记录', count: savedRows().length },
])

const tableColumns = computed(() =>
  activeTab.value === 'queue'
    ? columns.filter((field) => ['记录编号', '观测时间', '上游水位', '下游水位', '入库流量', '出库流量', '退回次数', '复核退回痕迹'].includes(field))
    : columns,
)

const emptyText = computed(() => {
  if (activeTab.value === 'queue') return '待调度队列为空：没有已观测待下达调度的水情记录'
  if (activeTab.value === 'saved') return '还没有另存的水情记录，可在台账中点击「另存」'
  return '暂无符合条件的水情记录'
})

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

const statusSummary = computed(() =>
  STATUS_FLOW.map((status) => ({
    status,
    count: listRows(meta.key).filter((row) => String(row.status) === status).length,
  })),
)

// 详情字段：业务字段 + 链路留痕，与列表读同一条源记录。
const detailFields = columns

function refreshDetail(id?: number) {
  if (!detail.value) return
  const targetId = id ?? Number(detail.value.id)
  detail.value = listRows(meta.key).find((row) => Number(row.id) === targetId) ?? null
}

function reload() {
  errorMessage.value = ''
  if (activeTab.value === 'ledger') {
    const payload = hydrologyPage(listRows(meta.key), filters.value, page.value, PAGE_SIZE)
    rows.value = payload.items
    total.value = payload.total
    page.value = payload.page
  } else if (activeTab.value === 'queue') {
    rows.value = pendingDispatchRows()
    total.value = rows.value.length
  } else {
    rows.value = savedRows()
    total.value = rows.value.length
  }
}

function switchTab(key: TabKey) {
  activeTab.value = key
  detail.value = null
  reload()
}

function goPage(next: number) {
  page.value = next
  reload()
}

function resetFilters() {
  filters.value = {}
  page.value = 1
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '水情记录登记入口尚未接入审批流'
}

type ActionDef = { name: string }
// 链路只能按顺序走：按当前状态给动作，退回只出现在已调度/已复核。
function actionsFor(row: EntryRow): ActionDef[] {
  const status = String(row.status)
  if (status === '待观测') return [{ name: '提交观测' }]
  if (status === '已观测') return [{ name: '下达调度' }]
  if (status === '已调度') return [{ name: '提交复核' }, { name: '复核退回' }]
  if (status === '已复核') return [{ name: '复核退回' }]
  return []
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  detailMessage.value = ''
  const id = Number(row.id)
  const result = applyAction(meta.key, id, action, session.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    detailMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  if (activeTab.value === 'ledger') {
    // 动作后定位：在当前过滤条件下找到该记录所在页，保持原次序翻过去。
    const located = locateRow(listRows(meta.key), filters.value, id, PAGE_SIZE)
    if (located.found) {
      page.value = located.page
    }
  }
  reload()
  refreshDetail(id)
}

function openDetail(row: EntryRow) {
  detailMessage.value = ''
  detail.value = listRows(meta.key).find((item) => Number(item.id) === Number(row.id)) ?? row
}

function closeDetail() {
  detail.value = null
}

function saveCopy(row: EntryRow) {
  errorMessage.value = ''
  const { duplicated } = saveHydrologyCopy(Number(row.id))
  errorMessage.value = duplicated ? '该记录已另存，重复另存不会多出记录' : '已另存到水情记录清单'
  reload()
}

onMounted(reload)
</script>
