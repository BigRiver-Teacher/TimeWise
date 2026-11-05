<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { BarSeriesOption } from 'echarts/charts'
import type { GridComponentOption, TooltipComponentOption } from 'echarts/components'
import type { ComposeOption } from 'echarts/core'
import { useMemoStore } from '@/stores/memo'
import type { MemoItem } from '@/stores/memo'
import { formatMonthDay, parseMemoTime, toDateKey } from '@/utils/memoTime'

// 按需注册：只打包柱状图 + 坐标系 + 提示框，避免引入整包
echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer])

type ChartOption = ComposeOption<BarSeriesOption | GridComponentOption | TooltipComponentOption>

/* ------------------------------ 类型定义 ------------------------------ */
type Priority = 'high' | 'medium' | 'low'

interface ReminderItem {
  id: number
  title: string
  timeLabel: string
  type: string
  priority: Priority
  /** 底部提醒文案，按优先级给出：提前 3 小时 / 6 小时 / 1 天提醒 */
  advanceLabel: string
}

interface ReminderGroup {
  priority: Priority
  label: string
  color: string
  items: ReminderItem[]
}

interface DailyPoint {
  /** YYYY-MM-DD，用于把待办按天分桶 */
  key: string
  /** 坐标轴上的短标签，如 “11-03” */
  label: string
  high: number
  medium: number
  low: number
}

/* ------------------------------ 优先级元信息 ------------------------------ */
const priorityMeta: Record<Priority, { label: string; color: string; cssVar: string }> = {
  high: { label: '紧急', color: 'var(--prio-high)', cssVar: '--prio-high' },
  medium: { label: '重要', color: 'var(--prio-mid)', cssVar: '--prio-mid' },
  low: { label: '普通', color: 'var(--prio-low)', cssVar: '--prio-low' },
}

/** 底部提醒文案：按优先级给出提前量 */
const advanceLabels: Record<Priority, string> = {
  high: '提前 3 小时提醒',
  medium: '提前 6 小时提醒',
  low: '提前 1 天提醒',
}

/* ------------------------------ 图表数据（Pinia 真实数据） ------------------------------ */
const memoStore = useMemoStore()

/* ------------------------------ 时间轴数据（Pinia 真实数据） ------------------------------ */
/** 未完成的待办：时间轴只列还没做完的事 */
const activeMemos = computed<MemoItem[]>(() =>
  memoStore.memos.filter((memo) => !memo.completed),
)

const totalReminders = computed<number>(() => activeMemos.value.length)

/** 组内按截止时间升序；解析不出来时间的排在最后 */
function compareByDueTime(a: MemoItem, b: MemoItem): number {
  const aTime = parseMemoTime(a.time)?.getTime() ?? Number.MAX_SAFE_INTEGER
  const bTime = parseMemoTime(b.time)?.getTime() ?? Number.MAX_SAFE_INTEGER
  return aTime - bTime
}

/** 按紧急程度分组：标题 / 圆点颜色都走 priorityMeta，空组由模板隐藏 */
const reminderGroups = computed<ReminderGroup[]>(() =>
  (['high', 'medium', 'low'] as Priority[]).map((priority) => ({
    priority,
    label: priorityMeta[priority].label,
    color: priorityMeta[priority].color,
    items: activeMemos.value
      .filter((memo) => memo.priority === priority)
      .sort(compareByDueTime)
      .map((memo) => ({
        id: memo.id,
        title: memo.title || '未命名任务',
        timeLabel: memo.time || '未设置时间',
        type: memo.type || '未分类',
        priority,
        advanceLabel: advanceLabels[priority],
      })),
  })),
)

/** 最近一条待办：未完成里时间最早且能解析出来的那条 */
const nextReminder = computed<{ date: Date; memo: MemoItem } | null>(() => {
  let best: { date: Date; memo: MemoItem } | null = null

  for (const memo of activeMemos.value) {
    const date = parseMemoTime(memo.time)
    if (!date) continue
    if (!best || date.getTime() < best.date.getTime()) best = { date, memo }
  }

  return best
})

/** 相对今天的友好时间：今天 18:00 / 明天 09:30 / 11-15 18:00 */
function friendlyTime(date: Date): string {
  const now = new Date()
  const dayMs = 24 * 60 * 60 * 1000
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const dayDiff = Math.round((startOfTarget - startOfToday) / dayMs)
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`

  if (dayDiff === 0) return `今天 ${hhmm}`
  if (dayDiff === 1) return `明天 ${hhmm}`
  if (dayDiff === 2) return `后天 ${hhmm}`
  if (dayDiff === -1) return `昨天 ${hhmm}`
  return `${formatMonthDay(date)} ${hhmm}`
}

/** 顶部副标题：条数 + 最近一条的真实触发时间 */
const headSubtitle = computed<string>(() => {
  if (!totalReminders.value) return '暂无未完成的待办，添加一条后这里会自动出现提醒。'

  const next = nextReminder.value
  if (!next) return `共 ${totalReminders.value} 条待办提醒，其中部分还没有可识别的时间。`

  return `共 ${totalReminders.value} 条待办提醒，最近一条将在 ${friendlyTime(next.date)} 触发。`
})

/**
 * 未来 7 天（含今天）的待办分布：
 * - 只统计未完成的任务；
 * - 时间解析不出具体日期的（如「本周内」）跳过；
 * - 按 priority 统计每天三个维度的数量，供堆叠柱状图使用。
 */
const weekData = computed<DailyPoint[]>(() => {
  const days: DailyPoint[] = []
  const today = new Date()

  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
    days.push({
      key: toDateKey(date),
      label: formatMonthDay(date),
      high: 0,
      medium: 0,
      low: 0,
    })
  }

  for (const memo of memoStore.memos) {
    if (memo.completed) continue

    const due = parseMemoTime(memo.time)
    if (!due) continue

    const bucket = days.find((day) => day.key === toDateKey(due))
    if (!bucket) continue

    bucket[memo.priority] += 1
  }

  return days
})

const priorityTotals = computed(() =>
  (['high', 'medium', 'low'] as Priority[]).map((priority) => ({
    priority,
    label: priorityMeta[priority].label,
    color: priorityMeta[priority].color,
    count: weekData.value.reduce((sum, day) => sum + day[priority], 0),
  })),
)

const weekTotal = computed(() =>
  weekData.value.reduce((sum, day) => sum + day.high + day.medium + day.low, 0),
)

/* ------------------------------ 图表 ------------------------------ */
const chartEl = ref<HTMLDivElement>()
let chart: ReturnType<typeof echarts.init> | null = null
let resizeObserver: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null

/** canvas 不认 var()，按当前主题读取 CSS 变量的计算值 */
function chartPalette() {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string) => style.getPropertyValue(name).trim()
  return {
    axisLabel: read('--app-text-muted'),
    axisLine: read('--app-line'),
    splitLine: read('--app-line-soft'),
    tooltipBg: read('--glass-bg-strong'),
    tooltipBorder: read('--glass-border'),
    tooltipText: read('--app-text'),
    tooltipShadow: read('--shadow-hover'),
    prio: {
      high: read(priorityMeta.high.cssVar),
      medium: read(priorityMeta.medium.cssVar),
      low: read(priorityMeta.low.cssVar),
    } as Record<Priority, string>,
  }
}

function buildChartOption(): ChartOption {
  const palette = chartPalette()
  const seriesDefs: Array<{ priority: Priority; name: string; color: string }> = [
    { priority: 'low', name: '普通', color: palette.prio.low },
    { priority: 'medium', name: '重要', color: palette.prio.medium },
    { priority: 'high', name: '紧急', color: palette.prio.high },
  ]

  return {
    grid: { left: 4, right: 8, top: 18, bottom: 2, containLabel: true },
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.tooltipBg,
      borderColor: palette.tooltipBorder,
      borderWidth: 1,
      padding: [10, 12],
      textStyle: { color: palette.tooltipText, fontSize: 12 },
      extraCssText: `border-radius:12px;box-shadow:${palette.tooltipShadow};backdrop-filter:blur(12px);`,
    },
    xAxis: {
      type: 'category',
      data: weekData.value.map((day) => day.label),
      axisLine: { lineStyle: { color: palette.axisLine } },
      axisTick: { show: false },
      axisLabel: { color: palette.axisLabel, fontSize: 11, margin: 10 },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { color: palette.axisLabel, fontSize: 11 },
      splitLine: { lineStyle: { color: palette.splitLine, type: 'dashed' } },
    },
    series: seriesDefs.map((def, index) => ({
      name: def.name,
      type: 'bar',
      stack: 'total',
      barWidth: 26,
      data: weekData.value.map((day) => day[def.priority]),
      itemStyle: {
        color: def.color,
        // 只有最上层的「紧急」需要圆角，避免堆叠处出现缺口
        borderRadius: index === seriesDefs.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0],
      },
    })),
  }
}

// Pinia 里的待办变化 → weekData 重新求值 → 用新数据重绘图表
watch(weekData, () => {
  chart?.setOption(buildChartOption())
})

onMounted(() => {
  if (!chartEl.value) return
  chart = echarts.init(chartEl.value)
  chart.setOption(buildChartOption())
  // 容器宽度会随侧栏/窗口变化，用 ResizeObserver 而不是只监听 window
  resizeObserver = new ResizeObserver(() => chart?.resize())
  resizeObserver.observe(chartEl.value)

  // 亮 / 暗切换时按新主题重绘（canvas 读不到 CSS 变量）
  themeObserver = new MutationObserver(() => chart?.setOption(buildChartOption()))
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
})

onUnmounted(() => {
  themeObserver?.disconnect()
  themeObserver = null
  resizeObserver?.disconnect()
  resizeObserver = null
  chart?.dispose()
  chart = null
})
</script>

<template>
  <div class="reminder-page">
    <!-- 顶部 -->
    <header class="page-head">
      <div class="head-text">
        <h1 class="page-title">提醒中心</h1>
        <p class="page-subtitle">{{ headSubtitle }}</p>
      </div>

      <div class="head-note">
        <span class="note-dot"></span>
        应用内提醒已开启
      </div>
    </header>

    <!-- 未来 7 天分布 -->
    <section class="panel">
      <div class="panel-head">
        <span class="panel-icon">
          <svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="4" y="5" width="16" height="16" rx="4" stroke="currentColor" stroke-width="1.7" />
            <path d="M8 3v4M16 3v4M4 10h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
            <path d="M8 15v3M12 12.5v5.5M16 14v4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
          </svg>
        </span>
        <div class="panel-title-group">
          <h2 class="panel-title">未来 7 天提醒分布</h2>
          <p class="panel-sub">按紧急程度堆叠，共 {{ weekTotal }} 个提醒时间点</p>
        </div>

        <ul class="chart-legend">
          <li v-for="item in priorityTotals" :key="item.priority" class="legend-item">
            <i class="legend-dot" :style="{ backgroundColor: item.color }"></i>
            {{ item.label }}
            <b>{{ item.count }}</b>
          </li>
        </ul>
      </div>

      <div class="chart-wrap">
        <div ref="chartEl" class="week-chart" role="img" aria-label="未来 7 天提醒分布柱状图"></div>
        <el-empty
          v-if="weekTotal === 0"
          class="chart-empty"
          :image-size="64"
          description="未来 7 天暂无待办提醒"
        />
      </div>
    </section>

    <!-- 按紧急程度分组的时间轴 -->
    <section class="panel timeline-panel">
      <div class="panel-head">
        <span class="panel-icon is-ai">
          <svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 3.2.8 4.6 1.5 5.5H5c.7-.9 1.5-2.3 1.5-5.5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
            <path d="M10 18.5a2 2 0 0 0 4 0" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
          </svg>
        </span>
        <div class="panel-title-group">
          <h2 class="panel-title">提醒时间轴</h2>
          <p class="panel-sub">按紧急程度分组，越靠前越需要优先处理</p>
        </div>
      </div>

      <div class="groups">
        <template v-for="group in reminderGroups" :key="group.priority">
          <div v-if="group.items.length" class="group">
            <div class="group-head">
              <span class="group-dot" :style="{ backgroundColor: group.color }"></span>
              <h3 class="group-title">{{ group.label }}</h3>
              <span class="group-count">{{ group.items.length }} 条</span>
            </div>

            <el-timeline class="reminder-timeline">
              <el-timeline-item
                v-for="item in group.items"
                :key="item.id"
                :color="group.color"
                size="large"
              >
                <article class="reminder-card">
                  <div class="card-head">
                    <h4 class="card-title">{{ item.title }}</h4>
                    <el-tag class="card-type" effect="plain" size="small" round>{{ item.type }}</el-tag>
                  </div>

                  <p class="card-time">
                    <svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.7" />
                      <path d="M12 7.8V12l2.8 1.7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
                    </svg>
                    {{ item.timeLabel }}
                  </p>

                  <p class="card-meta">{{ item.advanceLabel }} · 邮件 + 应用内</p>
                </article>
              </el-timeline-item>
            </el-timeline>
          </div>
        </template>

        <!-- 一条未完成的待办都没有：底部空状态 -->
        <el-empty
          v-if="!totalReminders"
          :image-size="72"
          description="暂无未完成的待办提醒，去总览页勾掉已完成的事项或新建一条"
        />
      </div>
    </section>
  </div>
</template>

<style scoped lang="scss">
.reminder-page {
  --el-text-color-regular: var(--app-text);

  max-width: var(--content-max);
  margin: 0 auto;
  color: var(--app-text);
  font-size: var(--fs-base);
}

.icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

/* ---------------- 顶部 ---------------- */
.page-head {
  @include page-head;
}

.page-title {
  @include page-title;
}

.page-subtitle {
  @include page-subtitle;
}

.head-note {
  @include status-pill(success);
}

.note-dot {
  @include status-dot(success);
}

/* ---------------- 面板 ---------------- */
.panel {
  @include glass-panel;

  & + & {
    margin-top: 16px;
  }
}

.panel-head {
  @include panel-head;
}

.panel-icon {
  @include panel-icon(brand);

  .icon {
    width: 18px;
    height: 18px;
  }

  &.is-ai {
    @include panel-icon(ai);
  }
}

.panel-title-group {
  min-width: 0;
}

.panel-title {
  @include panel-title;
}

.panel-sub {
  @include panel-sub;
}

/* ---------------- 图例 ---------------- */
.chart-legend {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 0 0 0 auto;
  padding: 0;
  list-style: none;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--app-text-muted);
  font-size: var(--fs-xs);

  b {
    color: var(--app-text);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 3px;
}

/* ---------------- 图表 ---------------- */
.chart-wrap {
  position: relative;
}

.week-chart {
  width: 100%;
  height: 240px;
}

.chart-empty {
  position: absolute;
  inset: 0;
  padding: 0;
  pointer-events: none;

  :deep(.el-empty__description p) {
    color: var(--app-text-subtle);
    font-size: var(--fs-sm);
  }
}

/* ---------------- 时间轴 ---------------- */
.timeline-panel {
  padding-bottom: 8px;
}

.group + .group {
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px dashed var(--app-line);
}

.group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.group-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.group-title {
  color: var(--app-text);
  font-size: var(--fs-base);
  font-weight: 600;
}

.group-count {
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: var(--chip-bg);
  color: var(--app-text-muted);
  font-size: var(--fs-xs);
  font-weight: 600;
}

.reminder-timeline {
  padding-left: 2px;

  :deep(.el-timeline-item) {
    padding-bottom: 12px;
  }

  :deep(.el-timeline-item__tail) {
    border-left: 2px solid var(--app-line-soft);
  }

  :deep(.el-timeline-item__node) {
    box-shadow: 0 0 0 4px tint(brand, 10%);
  }

  :deep(.el-timeline-item__wrapper) {
    padding-left: 24px;
  }
}

.reminder-card {
  @include inner-card;

  padding: 12px 16px;

  &:hover {
    border-color: tint(brand, 25%);
  }
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.card-title {
  color: var(--app-text);
  font-size: var(--fs-base);
  font-weight: 600;
  line-height: 1.5;
}

.card-type {
  flex-shrink: 0;
  border-color: var(--app-line);
  background: var(--chip-bg);
  color: var(--app-text-muted);
  font-size: var(--fs-xs);
  font-weight: 500;
}

.card-time {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  color: var(--app-text-muted);
  font-size: var(--fs-xs);

  .icon {
    width: 14px;
    height: 14px;
    color: var(--app-text-subtle);
  }
}

.card-meta {
  margin-top: 4px;
  color: var(--app-text-subtle);
  font-size: var(--fs-xs);
}

/* ---------------- 响应式 ---------------- */
@include mobile {
  .panel {
    padding: 16px;
  }

  .panel-head {
    flex-wrap: wrap;
  }

  .chart-legend {
    width: 100%;
    margin: 4px 0 0;
    gap: 12px;
  }

  .week-chart {
    height: 210px;
  }

  .head-note {
    padding: 4px 10px;
  }
}
</style>
