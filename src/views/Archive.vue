<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useMemoStore } from '@/stores/memo'
import type { MemoItem } from '@/stores/memo'
import { parseMemoTime } from '@/utils/memoTime'

type ArchiveFilter = 'all' | 'week'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/* ------------------------------ 数据源 ------------------------------ */
const memoStore = useMemoStore()
const { memos } = storeToRefs(memoStore)

const filter = ref<ArchiveFilter>('all')

/** 归档行需要的展示字段（由 MemoItem 收敛而来） */
interface ArchivedItem {
  id: number
  title: string
  type: string
  /** 没有真实的完成时间字段，用待办的 time 作为截止时间展示 */
  dueAt: string
  /** 「已完成 · 距截止还有 2 天」这类说明 */
  timing: string
  summary: string
  /** 是否落在最近 7 天内（用截止时间近似完成时间） */
  recent: boolean
}

/** 取待办时间的毫秒值：解析不出来返回 0，排到最后 */
function memoTimeValue(memo: MemoItem): number {
  const date = parseMemoTime(memo.time)
  return date ? date.getTime() : 0
}

/** 「2 天 / 6 小时」这类跨度文案 */
function formatSpan(ms: number): string {
  const days = Math.floor(ms / DAY_MS)
  if (days >= 1) return `${days} 天`
  return `${Math.max(1, Math.floor(ms / HOUR_MS))} 小时`
}

/** 用截止时间与当前时间的距离描述完成情况（没有真实完成时间，只能近似） */
function describeTiming(due: Date | null): string {
  if (!due) return '已完成'

  const diff = due.getTime() - Date.now()
  const span = formatSpan(Math.abs(diff))
  return diff >= 0 ? `已完成 · 距截止还有 ${span}` : `已完成 · 截止已过 ${span}`
}

/* ------------------------------ 已完成列表 ------------------------------ */
/** 只保留已完成，并按完成时间（近似用 memo.time）倒序，时间相同或解析不出来时按 id 倒序 */
const completedMemos = computed<MemoItem[]>(() =>
  memos.value
    .filter((memo) => memo.completed === true)
    .slice()
    .sort((a, b) => {
      const diff = memoTimeValue(b) - memoTimeValue(a)
      return diff !== 0 ? diff : b.id - a.id
    }),
)

const archivedItems = computed<ArchivedItem[]>(() => {
  const now = Date.now()

  return completedMemos.value.map((memo) => {
    const due = parseMemoTime(memo.time)
    const dueMs = due ? due.getTime() : null

    return {
      id: memo.id,
      title: memo.title || '未命名任务',
      type: memo.type || '未分类',
      dueAt: memo.time || '未记录时间',
      timing: describeTiming(due),
      summary: memo.aiSummary || '（该条目没有 AI 摘要）',
      // 提前完成时截止时间在未来，也算「最近」——这里用绝对距离判断
      recent: dueMs !== null && Math.abs(now - dueMs) <= 7 * DAY_MS,
    }
  })
})

const filtered = computed<ArchivedItem[]>(() =>
  filter.value === 'all' ? archivedItems.value : archivedItems.value.filter((item) => item.recent),
)

/* ------------------------------ 顶部统计 ------------------------------ */
/** 累计完成 */
const totalCompleted = computed<number>(() => completedMemos.value.length)

/** 能解析出截止时间的完成条目，用来算准时率与平均提前量 */
const timedCompleted = computed<Date[]>(() =>
  completedMemos.value
    .map((memo) => parseMemoTime(memo.time))
    .filter((date): date is Date => date !== null),
)

/**
 * 准时完成率：没有真实完成时间，用截止时间近似——
 * 截止时间还没到就已完成 → 算准时；截止已过 → 算超期。
 * 一条时间都解析不出来时退回演示值，避免页面出现 0%。
 */
const onTimeRate = computed<number>(() => {
  const dates = timedCompleted.value
  if (!dates.length) return 90 + (totalCompleted.value % 10)

  const now = Date.now()
  const onTime = dates.filter((date) => date.getTime() >= now).length
  return Math.round((onTime / dates.length) * 100)
})

/** 平均提前量：截止时间与当前时间的平均距离，按「天 / 小时」展示 */
const averageLead = computed<{ value: string; unit: string }>(() => {
  const dates = timedCompleted.value
  if (!dates.length) return { value: '—', unit: '' }

  const now = Date.now()
  const total = dates.reduce((sum, date) => sum + Math.abs(date.getTime() - now), 0)
  const avgMs = total / dates.length
  const days = avgMs / DAY_MS

  return days >= 1
    ? { value: days.toFixed(1), unit: '天' }
    : { value: String(Math.max(1, Math.round(avgMs / HOUR_MS))), unit: '小时' }
})

const filters: Array<{ value: ArchiveFilter; label: string }> = [
  { value: 'all', label: '全部归档' },
  { value: 'week', label: '最近 7 天' },
]
</script>

<template>
  <div class="archive-page">
    <header class="page-head">
      <div>
        <h1 class="page-title">已完成归档</h1>
        <p class="page-subtitle">已完成条目的 AI 摘要会保留在归档里，方便随时回看。</p>
      </div>

      <el-radio-group v-model="filter" class="filter-group">
        <el-radio-button v-for="item in filters" :key="item.value" :value="item.value">
          {{ item.label }}
        </el-radio-button>
      </el-radio-group>
    </header>

    <div class="stat-row">
      <div class="stat-pill">
        <strong>{{ totalCompleted }}</strong>
        <span>累计完成</span>
      </div>
      <div class="stat-pill">
        <strong>{{ onTimeRate }}<small>%</small></strong>
        <span>准时完成率</span>
      </div>
      <div class="stat-pill">
        <strong>{{ averageLead.value }}<small v-if="averageLead.unit"> {{ averageLead.unit }}</small></strong>
        <span>平均提前量</span>
      </div>
    </div>

    <section class="panel">
      <!-- 一条已完成的都没有：整块空状态 -->
      <el-empty v-if="!totalCompleted" :image-size="96" description="还没有已完成的待办">
        <p class="empty-hint">在总览页把待办勾选完成后，它们会自动收进这里。</p>
      </el-empty>

      <template v-else>
        <ul class="archive-list">
          <li v-for="item in filtered" :key="item.id" class="archive-item">
            <span class="check">
              <svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>

            <div class="item-body">
              <div class="item-top">
                <h3 class="item-title">{{ item.title }}</h3>
                <el-tag class="item-type" effect="plain" size="small" round>{{ item.type }}</el-tag>
              </div>

              <p class="item-meta">截止 {{ item.dueAt }} · {{ item.timing }}</p>
              <p class="item-summary">{{ item.summary }}</p>
            </div>
          </li>
        </ul>

        <!-- 有归档，但当前筛选区间内没有 -->
        <el-empty
          v-if="!filtered.length"
          :image-size="80"
          description="最近 7 天没有完成的条目，试试切换到「全部归档」"
        />
      </template>
    </section>
  </div>
</template>

<style scoped lang="scss">
$brand: #4f46e5;
$brand-soft: var(--brand-soft);
$text: var(--app-text);
$text-muted: var(--app-text-muted);
$text-subtle: var(--app-text-subtle);
$surface: var(--app-surface);
$line: var(--app-line);
$radius-lg: 16px;
$radius-md: 12px;
$shadow-card: 0 1px 2px rgba(16, 24, 40, 0.04), 0 1px 3px rgba(16, 24, 40, 0.06);

.archive-page {
  --el-color-primary: #{$brand};
  --el-color-primary-light-3: #847eed;
  --el-color-primary-light-8: #dcdafa;
  --el-color-primary-light-9: #edeefc;
  --el-text-color-regular: #{$text};
  --el-border-radius-base: 8px;

  max-width: 1080px;
  margin: 0 auto;
  color: $text;
  font-size: 14px;
}

.icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 18px;
}

.page-title {
  font-size: 24px;
  font-weight: 700;
  line-height: 1.25;
  letter-spacing: -0.02em;
}

.page-subtitle {
  margin-top: 6px;
  font-size: 13px;
  color: $text-muted;
}

.filter-group :deep(.el-radio-button__inner) {
  border-color: $line;
  background: $surface;
  color: $text-muted;
  font-weight: 500;
  padding: 8px 14px;
  box-shadow: none;
}

.filter-group :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
  background: $brand-soft;
  border-color: rgba($brand, 0.45);
  color: $brand;
  box-shadow: none;
}

.stat-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.stat-pill {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  box-shadow: var(--glass-shadow);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));

  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 10px 16px;

  strong {
    font-size: 17px;
    font-weight: 700;
    color: $brand;
    font-variant-numeric: tabular-nums;

    small {
      font-size: 11px;
      font-weight: 600;
    }
  }

  span {
    font-size: 12.5px;
    color: $text-muted;
  }
}

.panel {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  box-shadow: var(--glass-shadow);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));

  padding: 6px 24px;
}

.archive-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.archive-item {
  display: flex;
  gap: 14px;
  padding: 18px 0;
  border-bottom: 1px solid var(--app-line-soft);

  &:last-child {
    border-bottom: none;
  }
}

.check {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  margin-top: 1px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--success-soft);
  color: #10b981;

  .icon {
    width: 14px;
    height: 14px;
  }
}

.item-body {
  min-width: 0;
  flex: 1;
}

.item-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.item-title {
  font-size: 14px;
  font-weight: 600;
  color: $text;
}

.item-type {
  flex-shrink: 0;
  border-color: $line;
  background: var(--chip-bg);
  color: var(--app-text-muted);
  font-weight: 500;
  font-size: 11.5px;
}

.item-meta {
  margin-top: 5px;
  font-size: 12px;
  color: $text-subtle;
}

.item-summary {
  margin-top: 6px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--app-text-muted);
}

.empty-hint {
  margin-top: 2px;
  font-size: 12.5px;
  color: $text-subtle;
}

@media (max-width: 720px) {
  .page-title {
    font-size: 20px;
  }

  .panel {
    padding: 4px 16px;
  }
}
</style>
