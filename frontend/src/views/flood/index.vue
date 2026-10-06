<template>
  <section class="page" data-module="flood">
    <header class="page-head">
      <div>
        <h2>泄洪操作管理</h2>
        <p class="page-desc">维护泄洪操作，围绕操作编号、泄洪闸号、开启孔数、泄洪流量做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记泄洪操作</button>
        <button class="btn" type="button" @click="exportRows">导出泄洪操作清单</button>
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

    <form class="filter-bar" @submit.prevent="reload">
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
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无泄洪操作数据，可先登记泄洪操作</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条泄洪操作记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { listRows } from '@/data/local-store'
import { pendingDispatchCount, todayFlowTotals } from '@/data/hydrology'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('flood')
const columns = ["操作编号", "泄洪闸号", "开启孔数", "泄洪流量", "下游预警", "操作时间", "操作人员", "操作状态"]
const actions = ["提交审批", "开启泄洪", "结束泄洪"]
const statuses = ["待审批", "已批准", "泄洪中", "已结束"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 水情待调度条数直接读水情那份数据：退回一条这里就跟着少一条/多一条，两边永远对得上。
const stats = computed(() => {
  const flow = todayFlowTotals()
  const gateCount = (status: string) =>
    listRows(meta.key).filter((row) => String(row.status) === status).length
  return [
    { label: "待审批操作", value: gateCount('待审批') },
    { label: "泄洪中闸门", value: gateCount('泄洪中') },
    { label: "水情待调度记录", value: pendingDispatchCount() },
    { label: `今日出库流量（${flow.date}）`, value: `${flow.outflow} m³/s` },
  ]
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '泄洪操作登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '泄洪操作列表读取失败'
  }
}

onMounted(reload)
</script>
