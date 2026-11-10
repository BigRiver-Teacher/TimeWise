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
  /** 是否落在最近 7 天内（以真实完成时间为准） */
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
  const recentFrom = now - 7 * DAY_MS

  return completedMemos.value.map((memo) => {
    const due = parseMemoTime(memo.time)
    const completedAtText = memo.completedAt ?? ''
    const completedAt = completedAtText ? parseMemoTime(completedAtText) : null
    const completedMs = completedAt ? completedAt.getTime() : null

    return {
      id: memo.id,
      title: memo.title || '未命名任务',
      type: memo.type || '未分类',
      dueAt: memo.time || '未记录时间',
      timing: describeTiming(due),
      summary: memo.aiSummary || '（该条目没有 AI 摘要）',
      // 以真实完成时间为准：过去 7 天内完成才算「最近」；
      // 没有完成时间的历史条目一律不计入
      recent: completedMs !== null && completedMs >= recentFrom && completedMs <= now,
    }
  })
})

const filtered = computed<ArchivedItem[]>(() =>
  filter.value === 'all' ? archivedItems.value : archivedItems.value.filter((item) => item.recent),
)

/* ------------------------------ 顶部统计 ------------------------------ */
/** 累计完成 */
const totalCompleted = computed<number>(() => completedMemos.value.length)

/** 能同时解析出真实完成时间与截止时间的已完成条目；任一缺失 / 不可解析则整体跳过 */
interface TimedCompletion {
  completedAt: Date
  due: Date
}

const timedCompletions = computed<TimedCompletion[]>(() => {
  const result: TimedCompletion[] = []

  for (const memo of completedMemos.value) {
    const completedAtText = memo.completedAt ?? ''
    if (!completedAtText) continue

    const completedAt = parseMemoTime(completedAtText)
    const due = parseMemoTime(memo.time)
    if (!completedAt || !due) continue

    result.push({ completedAt, due })
  }

  return result
})

/**
 * 准时完成率：completedAt <= time 视为准时。
 * 分子是准时条目数，分母是「完成时间与截止时间都可解析」的条目数；
 * 分母为 0 时返回 null，由页面显示占位符「—」。
 */
const onTimeRate = computed<number | null>(() => {
  const items = timedCompletions.value
  if (!items.length) return null

  const onTime = items.filter(
    (item) => item.completedAt.getTime() <= item.due.getTime(),
  ).length
  return Math.round((onTime / items.length) * 100)
})

/** 平均提前量：只统计准时条目，取（截止时间 − 完成时间）的平均值 */
const averageLead = computed<{ value: string; unit: string }>(() => {
  const onTimeItems = timedCompletions.value.filter(
    (item) => item.completedAt.getTime() <= item.due.getTime(),
  )
  if (!onTimeItems.length) return { value: '—', unit: '' }

  const total = onTimeItems.reduce(
    (sum, item) => sum + (item.due.getTime() - item.completedAt.getTime()),
    0,
  )
  const avgMs = total / onTimeItems.length
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
    <header class="tw-page-head">
      <div>
        <h1 class="tw-page-title">已完成归档</h1>
        <p class="tw-page-subtitle">已完成条目的 AI 摘要会保留在归档里，方便随时回看。</p>
      </div>

      <el-radio-group v-model="filter" class="filter-group tw-segment">
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
        <strong>{{ onTimeRate === null ? '—' : onTimeRate }}<small v-if="onTimeRate !== null">%</small></strong>
        <span>准时完成率</span>
      </div>
      <div class="stat-pill">
        <strong>{{ averageLead.value }}<small v-if="averageLead.unit"> {{ averageLead.unit }}</small></strong>
        <span>平均提前量</span>
      </div>
    </div>

    <section class="tw-panel">
      <!-- 一条已完成的都没有：整块空状态 -->
      <el-empty v-if="!totalCompleted" :image-size="96" description="还没有已完成的待办">
        <p class="empty-hint">在总览页把待办勾选完成后，它们会自动收进这里。</p>
      </el-empty>

      <template v-else>
        <ul class="archive-list">
          <li
            v-for="(item, index) in filtered"
            :key="item.id"
            class="archive-item"
            :style="{ '--i': index }"
          >
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
$text: var(--app-text);
$text-muted: var(--app-text-muted);
$text-subtle: var(--app-text-subtle);

.archive-page {
  /* EP 主色与控件底色由 main.css 全局令牌统一提供，页面不再局部覆盖 */
  --el-text-color-regular: #{$text};
  --el-border-radius-base: var(--radius-sm);

  max-width: var(--content-max);
  margin: 0 auto;
  color: $text;
  font-size: var(--fs-base);
}

.icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

/* 页头 / 面板结构统一走全局 tw-*，此处只保留本页控件尺寸 */
.filter-group :deep(.el-radio-button__inner) {
  padding: 8px 14px;
  font-weight: 500;
}

.stat-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.stat-pill {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 10px 16px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  background: var(--glass-bg);
  box-shadow: var(--glass-shadow);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  transition:
    transform var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-hover);
  }

  strong {
    color: var(--brand);
    font-size: var(--fs-md);
    font-weight: 700;
    font-variant-numeric: tabular-nums;

    small {
      font-size: var(--fs-xs);
      font-weight: 600;
    }
  }

  span {
    color: $text-muted;
    font-size: var(--fs-sm);
  }
}

.archive-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.archive-item {
  display: flex;
  gap: 14px;
  margin: 0 -12px;
  padding: 18px 12px;
  border-bottom: 1px solid var(--app-line-soft);
  border-radius: var(--radius-md);
  transition: background var(--dur) var(--ease);
  animation: rise-in 0.4s var(--ease) backwards;
  @include stagger-delay(40ms, 8);

  &:hover {
    background: var(--chip-bg);
  }

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
  color: var(--success);

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
  min-width: 0;
  color: $text;
  font-size: var(--fs-base);
  font-weight: 600;
  @include line-clamp(2);
}

.item-type {
  flex-shrink: 0;
  border-color: var(--app-line);
  background: var(--chip-bg);
  color: var(--app-text-muted);
  font-size: var(--fs-xs);
  font-weight: 500;
}

.item-meta {
  margin-top: 5px;
  color: $text-subtle;
  font-size: var(--fs-xs);
}

.item-summary {
  margin-top: 6px;
  color: var(--app-text-muted);
  font-size: var(--fs-sm);
  line-height: 1.7;
}

.empty-hint {
  margin-top: 2px;
  color: $text-muted;
  font-size: var(--fs-sm);
}

/* 断点统一为 _mixins 的 mobile(768px)（原 720px 与全站断点并存） */
@include mobile {
  .tw-panel {
    padding: 16px;
  }

  /* 统计胶囊：两列等高排布，第三项独占一行，避免最后一项上下留白失衡 */
  .stat-row {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .stat-pill {
    justify-content: center;
    min-height: 46px;

    &:last-child {
      grid-column: 1 / -1;
    }
  }

  /* 给右下角 AI 悬浮球留出高度（FAB 52px + 安全距离 16px） */
  .archive-list {
    padding-bottom: 44px;
  }
}
</style>
