<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete } from "@element-plus/icons-vue";
import { useMemoStore } from "@/stores/memo";
import type { MemoItem, MemoPriority } from "@/stores/memo";
import { parseMemoTime } from "@/utils/memoTime";

type ViewMode = "card" | "timeline";

/** 紧急程度 → 文案 / 颜色 的统一映射，避免模板里堆三元表达式 */
const priorityMeta: Record<MemoPriority, { label: string; color: string }> = {
  high: { label: "紧急", color: "var(--prio-high)" },
  medium: { label: "重要", color: "var(--prio-mid)" },
  low: { label: "普通", color: "var(--prio-low)" },
};

/* ---------------------------- 待办数据（Pinia） ---------------------------- */
const memoStore = useMemoStore();
const { memos } = storeToRefs(memoStore);

/* ---------------------------- 交互状态 ---------------------------- */
const keyword = ref("");
const viewMode = ref<ViewMode>("card");
const router = useRouter();

/** 「新建条目」进入信息录入页，录完回到总览 */
function goToInput() {
  router.push({ name: "input" });
}

/** 点击卡片进入条目详情 */
function goToDetail(id: number) {
  router.push({ name: "detail", query: { id: String(id) } });
}

/**
 * 点开卡片：先清掉「新条目」高亮（不请求后端），再进详情。
 * 高亮只为吸引注意力，用户看一眼就该消失。
 */
function handleCardClick(memo: MemoItem) {
  memoStore.markMemoSeen(memo.id);
  goToDetail(memo.id);
}

/** 卡片上按回车进详情；焦点在删除按钮上时不触发跳转 */
function handleCardEnter(event: Event, memo: MemoItem) {
  const target = event.target as HTMLElement | null;
  if (target?.closest(".memo-delete")) return;
  handleCardClick(memo);
}

/** 切换完成状态 */
function handleToggleCompleted(memo: MemoItem) {
  memoStore.toggleCompleted(memo.id);
}

/** 删除待办：二次确认后调用 store 的 DELETE 接口 */
async function handleDelete(memo: MemoItem) {
  try {
    await ElMessageBox.confirm(
      `确定删除「${memo.title}」吗？删除后无法恢复。`,
      "删除待办",
      {
        type: "warning",
        confirmButtonText: "删除",
        cancelButtonText: "取消",
      },
    );
  } catch {
    return;
  }

  const removed = await memoStore.deleteMemo(memo.id);
  if (removed) {
    ElMessage.success("已删除该待办");
  } else {
    ElMessage.error("删除失败，请检查后端服务");
  }
}

/** 顶部铃铛进入提醒中心 */
function goToReminder() {
  router.push({ name: "reminder" });
}

function isTaskOverdue(timeStr: string): boolean {
  const due = parseMemoTime(timeStr);
  if (!due) return false;
  return due.getTime() < Date.now();
}

const priorityWeight: Record<MemoPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const NO_DUE_TIME = Number.MAX_SAFE_INTEGER;

function taskRank(memo: MemoItem): number {
  if (isTaskOverdue(memo.time)) return 2;
  return memo.completed ? 1 : 0;
}

function taskDueValue(memo: MemoItem): number {
  const due = parseMemoTime(memo.time);
  return due ? due.getTime() : NO_DUE_TIME;
}

function compareTask(a: MemoItem, b: MemoItem): number {
  const rankDiff = taskRank(a) - taskRank(b);
  if (rankDiff !== 0) return rankDiff;

  const dueDiff = taskDueValue(a) - taskDueValue(b);
  if (dueDiff !== 0) return dueDiff;

  const priorityDiff = priorityWeight[a.priority] - priorityWeight[b.priority];
  if (priorityDiff !== 0) return priorityDiff;

  return a.id - b.id;
}

const sortedMemos = computed(() => [...memos.value].sort(compareTask));

const filteredMemos = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return sortedMemos.value;
  return sortedMemos.value.filter((memo) =>
    [memo.title, memo.type, memo.aiSummary].some((field) =>
      field.toLowerCase().includes(kw),
    ),
  );
});

/* ---------------------------- 动态看板数据计算 ---------------------------- */

// 1. 今日待办：截止时间在今天且未完成的任务数
const todayCount = computed(() => {
  const now = new Date();
  return memos.value.filter((memo) => {
    if (memo.completed) return false;
    const due = parseMemoTime(memo.time);
    if (!due) return false;
    return (
      due.getFullYear() === now.getFullYear() &&
      due.getMonth() === now.getMonth() &&
      due.getDate() === now.getDate()
    );
  }).length;
});

// 2. 已逾期：截止时间早于当前时间且未完成的任务数
const overdueCount = computed(() => {
  const now = Date.now();
  return memos.value.filter((memo) => {
    if (memo.completed) return false;
    const due = parseMemoTime(memo.time);
    if (!due) return false;
    return due.getTime() < now;
  }).length;
});

// 3. 本周完成率：已完成数 / 总任务数（如果总数为 0 则返回 0）
const weeklyDoneRate = computed(() => {
  const total = memos.value.length;
  if (total === 0) return 0;
  const completed = memos.value.filter((memo) => memo.completed).length;
  return Math.round((completed / total) * 100);
});

const pageSubtitle = computed(() =>
  memos.value.length
    ? `今天有 ${todayCount.value} 项待处理，先完成最要紧的那件事。`
    : "还没有待办，点右上角「新建条目」把通知变成任务。",
);
</script>

<template>
  <div class="overview-page">
    <!-- 顶部：标题 + 搜索 + 新建 -->
    <header class="page-head">
      <div class="head-text">
        <h1 class="page-title">我的待办</h1>
        <p class="page-subtitle">{{ pageSubtitle }}</p>
      </div>

      <div class="head-actions">
        <el-input
          v-model="keyword"
          class="search-input"
          size="large"
          placeholder="搜索主题 / 类型 / AI 摘要"
          clearable
        >
          <template #prefix>
            <svg
              class="icon"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <circle
                cx="11"
                cy="11"
                r="7"
                stroke="currentColor"
                stroke-width="1.8"
              />
              <path
                d="m16.5 16.5 4 4"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
              />
            </svg>
          </template>
        </el-input>

        <el-button
          class="bell-btn"
          circle
          aria-label="提醒中心"
          title="提醒中心"
          @click="goToReminder"
        >
          <svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M6.5 10a5.5 5.5 0 0 1 11 0c0 3.2.8 4.6 1.5 5.5H5c.7-.9 1.5-2.3 1.5-5.5Z"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linejoin="round"
            />
            <path
              d="M10 18.5a2 2 0 0 0 4 0"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
            />
          </svg>
        </el-button>

        <el-button
          type="primary"
          size="large"
          class="create-btn"
          @click="goToInput"
        >
          <svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 5v14M5 12h14"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
          <span>新建条目</span>
        </el-button>
      </div>
    </header>

    <!-- 数据看板 -->
    <section class="stat-grid" aria-label="待办统计">
      <el-card shadow="never" class="stat-card">
        <div class="stat-inner">
          <span class="stat-icon is-brand">
            <svg
              class="icon"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <rect
                x="4"
                y="5"
                width="16"
                height="16"
                rx="4"
                stroke="currentColor"
                stroke-width="1.7"
              />
              <path
                d="M8 3v4M16 3v4M4 10h16"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
              />
            </svg>
          </span>
          <div class="stat-meta">
            <span class="stat-label">今日待办</span>
            <strong class="stat-value is-brand">{{ todayCount }}</strong>
          </div>
        </div>
        <p class="stat-hint">按计划今天需完成</p>
      </el-card>

      <el-card shadow="never" class="stat-card">
        <div class="stat-inner">
          <span class="stat-icon is-danger">
            <svg
              class="icon"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <circle
                cx="12"
                cy="12"
                r="8.5"
                stroke="currentColor"
                stroke-width="1.7"
              />
              <path
                d="M12 7.5V12l3 1.8"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
              />
            </svg>
          </span>
          <div class="stat-meta">
            <span class="stat-label">已逾期</span>
            <strong class="stat-value is-danger">{{ overdueCount }}</strong>
          </div>
        </div>
        <p class="stat-hint">建议今天优先清理</p>
      </el-card>

      <el-card shadow="never" class="stat-card">
        <div class="stat-inner">
          <span class="stat-icon is-success">
            <svg
              class="icon"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4 15.5 9 10l3.5 3.5L20 6"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path
                d="M15 6h5v5"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          <div class="stat-meta">
            <span class="stat-label">本周完成率</span>
            <strong class="stat-value is-success"
              >{{ weeklyDoneRate }}<small>%</small></strong
            >
          </div>
        </div>
        <el-progress
          class="stat-progress"
          :percentage="weeklyDoneRate"
          :show-text="false"
          :stroke-width="6"
          color="var(--success)"
        />
      </el-card>
    </section>

    <!-- 列表区 -->
    <section class="list-section">
      <div class="list-toolbar">
        <div class="toolbar-left">
          <span class="list-title">待办清单</span>
          <span class="list-count">{{ filteredMemos.length }} 条</span>

          <ul class="legend" aria-label="紧急程度图例">
            <li
              v-for="(meta, key) in priorityMeta"
              :key="key"
              class="legend-item"
            >
              <i
                class="legend-dot"
                :style="{ backgroundColor: meta.color }"
              ></i>
              {{ meta.label }}
            </li>
          </ul>
        </div>

        <el-radio-group v-model="viewMode" class="view-switch">
          <el-radio-button value="card">卡片视图</el-radio-button>
          <el-radio-button value="timeline">时间轴视图</el-radio-button>
        </el-radio-group>
      </div>

      <!-- 空列表：整个待办清单还没有任何条目 -->
      <div v-if="!memos.length" class="memo-empty">
        <el-empty :image-size="96" description="暂无待办">
          <el-button
            type="primary"
            round
            class="empty-create"
            @click="goToInput"
          >
            去新建条目
          </el-button>
        </el-empty>
      </div>

      <!-- 有数据但搜索没命中 -->
      <div v-else-if="!filteredMemos.length" class="memo-empty">
        <el-empty
          :image-size="88"
          description="没有匹配的条目，换个关键词试试"
        />
      </div>

      <template v-else>
        <!-- 卡片视图 -->
        <div v-if="viewMode === 'card'" class="memo-grid">
          <article
            v-for="memo in filteredMemos"
            :key="memo.id"
            class="memo-card"
            :class="[
              `is-${memo.priority}`,
              {
                'is-overdue': isTaskOverdue(memo.time) && !memo.completed,
                'is-completed': memo.completed,
                'is-new-memo': memo.isNew === true,
              },
            ]"
            role="button"
            tabindex="0"
            :aria-label="`查看「${memo.title}」详情`"
            @click="handleCardClick(memo)"
            @keydown.enter="handleCardEnter($event, memo)"
          >
            <i class="priority-bar" aria-hidden="true"></i>

            <div class="memo-body">
              <div class="memo-head">
                <div class="memo-title-row">
                  <el-checkbox
                    :model-value="memo.completed"
                    @change="handleToggleCompleted(memo)"
                    @click.stop
                    class="memo-checkbox"
                  />
                  <h3
                    class="memo-title"
                    :class="{ 'is-completed': memo.completed }"
                  >
                    {{ memo.title }}
                  </h3>
                </div>

                <div class="memo-head-right">
                  <el-tag class="memo-type" effect="plain" size="small" round>
                    {{ memo.type }}
                  </el-tag>

                  <button
                    type="button"
                    class="memo-delete"
                    aria-label="删除该待办"
                    title="删除"
                    @click.stop="handleDelete(memo)"
                  >
                    <el-icon><Delete /></el-icon>
                  </button>
                </div>
              </div>

              <p class="memo-time">
                <svg
                  class="icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="8.5"
                    stroke="currentColor"
                    stroke-width="1.7"
                  />
                  <path
                    d="M12 7.8V12l2.8 1.7"
                    stroke="currentColor"
                    stroke-width="1.7"
                    stroke-linecap="round"
                  />
                </svg>
                {{ memo.time }}
              </p>

              <p class="ai-summary">
                <span class="ai-badge">AI</span>
                <span class="ai-text">{{ memo.aiSummary }}</span>
              </p>
            </div>
          </article>
        </div>

        <!-- 时间轴视图 -->
        <ol v-else class="memo-timeline">
          <li
            v-for="memo in filteredMemos"
            :key="memo.id"
            class="timeline-item"
          >
            <i
              class="timeline-dot"
              :style="{ borderColor: priorityMeta[memo.priority].color }"
              aria-hidden="true"
            ></i>

            <div
              class="timeline-card"
              :class="{
                'is-overdue': isTaskOverdue(memo.time) && !memo.completed,
                'is-completed': memo.completed,
              }"
              role="button"
              tabindex="0"
              :aria-label="`查看「${memo.title}」详情`"
              @click="handleCardClick(memo)"
              @keydown.enter="handleCardEnter($event, memo)"
            >
              <div class="memo-head">
                <div class="memo-title-row">
                  <el-checkbox
                    :model-value="memo.completed"
                    @change="handleToggleCompleted(memo)"
                    @click.stop
                    class="memo-checkbox"
                  />
                  <h3
                    class="memo-title"
                    :class="{ 'is-completed': memo.completed }"
                  >
                    {{ memo.title }}
                  </h3>
                </div>
                <el-tag class="memo-type" effect="plain" size="small" round>
                  {{ memo.type }}
                </el-tag>
              </div>
              <p class="memo-time">
                <svg
                  class="icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="8.5"
                    stroke="currentColor"
                    stroke-width="1.7"
                  />
                  <path
                    d="M12 7.8V12l2.8 1.7"
                    stroke="currentColor"
                    stroke-width="1.7"
                    stroke-linecap="round"
                  />
                </svg>
                {{ memo.time }}
              </p>
              <p class="ai-summary">
                <span class="ai-badge">AI</span>
                <span class="ai-text">{{ memo.aiSummary }}</span>
              </p>
            </div>
          </li>
        </ol>
      </template>
    </section>
  </div>
</template>

<style scoped lang="scss">
.overview-page {
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

/* ---------------- 页头 ---------------- */
.page-head {
  @include page-head;
}

.page-title {
  @include page-title;
}

.page-subtitle {
  @include page-subtitle;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.search-input {
  width: 280px;

  :deep(.el-input__wrapper) {
    padding: 1px 12px;
    border-radius: var(--radius-sm);
    background: var(--input-bg);
    box-shadow: 0 0 0 1px var(--app-line) inset;
    @include field-states;
  }

  :deep(.el-input__prefix) {
    color: var(--app-text-subtle);
  }
}

.bell-btn {
  width: 40px;
  height: 40px;
  margin-left: 0;
  border: 1px solid var(--app-line);
  background: var(--surface-inner);
  color: var(--app-text-muted);
  @include transition(color, border-color, background);

  .icon {
    width: 18px;
    height: 18px;
  }

  &:hover,
  &:focus-visible {
    border-color: tint(brand, 35%);
    background: var(--brand-soft);
    color: var(--brand);
  }
}

.create-btn {
  height: 40px;
  padding: 0 18px;
  border: none;
  border-radius: var(--radius-sm);
  font-weight: 600;
  box-shadow: 0 4px 12px -6px tint(brand, 60%);
  @include lift-button;

  .icon {
    width: 16px;
    height: 16px;
    margin-right: 6px;
  }
}

/* ---------------- 统计卡 ---------------- */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 32px;
}

.stat-card {
  @include transition(box-shadow, transform);

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-hover);
  }

  :deep(.el-card__body) {
    padding: 20px;
  }
}

.stat-inner {
  display: flex;
  align-items: center;
  gap: 16px;
}

.stat-icon {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);

  .icon {
    width: 20px;
    height: 20px;
  }

  &.is-brand {
    color: var(--brand);
    background: var(--brand-soft);
  }

  &.is-danger {
    color: var(--danger);
    background: var(--danger-soft);
  }

  &.is-success {
    color: var(--success);
    background: var(--success-soft);
  }
}

.stat-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat-label {
  font-size: var(--fs-sm);
  color: var(--app-text-muted);
}

.stat-value {
  font-size: var(--fs-xl);
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;

  small {
    margin-left: 1px;
    font-size: var(--fs-base);
    font-weight: 600;
  }

  &.is-brand {
    color: var(--brand);
  }

  &.is-danger {
    color: var(--danger);
  }

  &.is-success {
    color: var(--success);
  }
}

.stat-hint {
  margin-top: 12px;
  font-size: var(--fs-xs);
  color: var(--app-text-subtle);
}

.stat-progress {
  margin-top: 16px;

  :deep(.el-progress-bar__outer) {
    background-color: var(--chip-bg);
  }
}

/* ---------------- 列表工具栏 ---------------- */
.list-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.list-title {
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--app-text);
}

.list-count {
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: var(--chip-bg);
  color: var(--app-text-muted);
  font-size: var(--fs-xs);
  font-weight: 600;
}

.legend {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 0 0 0 4px;
  padding: 0;
  list-style: none;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-xs);
  color: var(--app-text-muted);
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.view-switch {
  :deep(.el-radio-button__inner) {
    padding: 9px 16px;
    border-color: var(--app-line);
    background: var(--surface-inner);
    color: var(--app-text-muted);
    font-weight: 500;
    box-shadow: none;
    @include transition(background, border-color, color);
  }

  :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
    border-color: tint(brand, 45%);
    background: var(--brand-soft);
    color: var(--brand);
    box-shadow: none;
  }

  :deep(
    .el-radio-button__original-radio:focus-visible + .el-radio-button__inner
  ) {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--brand-ring);
  }
}

/* ---------------- 卡片视图 ---------------- */
.memo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}

.memo-card {
  @include glass-panel(20px 20px 20px 24px);
  position: relative;
  overflow: hidden;
  cursor: pointer;
  outline: none;
  @include transition(transform, box-shadow, border-color, background, opacity);

  &:hover {
    transform: translateY(-3px);
    border-color: tint(brand, 28%);
    box-shadow: var(--shadow-hover);
  }

  &:focus-visible {
    border-color: tint(brand, 50%);
    box-shadow:
      0 0 0 3px var(--brand-ring),
      var(--shadow-hover);
  }

  &.is-high .priority-bar {
    background: var(--prio-high);
  }

  &.is-medium .priority-bar {
    background: var(--prio-mid);
  }

  &.is-low .priority-bar {
    background: var(--prio-low);
  }
}

/*
 * 已完成的待办：只淡化文字，卡片外壳保持磨砂玻璃。
 * 之前的写法容易让整张卡一起变透明/发灰（父级 opacity 或过期样式牵连），
 * 这里把外壳的 opacity / background / border / shadow 全部显式钉回玻璃质感。
 * 第二组 :has() 是兜底：即使卡片没拿到 is-completed，只要内部勾选框已选中也按已完成处理。
 */
.memo-card.is-completed,
.timeline-card.is-completed,
.memo-card:has(.el-checkbox.is-checked),
.timeline-card:has(.el-checkbox.is-checked) {
  opacity: 1;
  background: var(--glass-bg);
  border-color: var(--glass-border);
  box-shadow: var(--glass-shadow);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));

  /* 透明度只加在文字子元素上，卡片本身保持不透明 */
  .memo-title,
  .memo-time,
  .ai-text,
  .memo-type {
    opacity: 0.62;
  }

  /* 已完成卡片仍保留 hover 反馈：边框/投影变化，但底色始终是玻璃 */
  &:hover {
    border-color: tint(brand, 28%);
    box-shadow: var(--shadow-hover);
  }

  /* 标题保留删除线，颜色略压暗，仍然清晰可读 */
  .memo-title.is-completed {
    opacity: 0.62;
    color: var(--app-text-muted);
    text-decoration: line-through;
    text-decoration-thickness: 1.5px;
    text-decoration-color: tint(brand, 45%);
  }

  /* 已完成的卡片不再挂「过期」的灰条，色条保持原本的优先级颜色 */
  &.is-high .priority-bar {
    background: var(--prio-high);
  }

  &.is-medium .priority-bar {
    background: var(--prio-mid);
  }

  &.is-low .priority-bar {
    background: var(--prio-low);
  }
}

.priority-bar {
  position: absolute;
  inset: 0 auto 0 0;
  width: 4px;
}

.memo-body {
  display: flex;
  flex-direction: column;
  min-height: 120px;
}

.memo-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.memo-title-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.memo-checkbox {
  height: 24px;
}

.memo-title {
  font-size: var(--fs-md);
  font-weight: 600;
  line-height: 1.5;
  color: var(--app-text);
  @include transition(color, opacity, text-decoration);

  /* 已完成的标题变淡并划掉 */
  &.is-completed {
    text-decoration: line-through;
    opacity: 0.5;
    color: var(--app-text-muted);
  }
}

.memo-type {
  flex-shrink: 0;
  border-color: var(--app-line);
  background: var(--chip-bg);
  color: var(--app-text-muted);
  font-size: var(--fs-xs);
  font-weight: 500;
}

.memo-head-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.memo-delete {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--app-text-subtle);
  cursor: pointer;
  opacity: 0.55;
  @include transition(opacity, color, background);

  .el-icon {
    font-size: 16px;
  }

  &:hover,
  &:focus-visible {
    opacity: 1;
    color: var(--danger);
    background: tint(danger, 12%);
  }

  &:focus-visible {
    outline-color: tint(danger, 45%);
  }
}

.memo-card:hover .memo-delete {
  opacity: 1;
}

/* 
 * 过期任务：不要直接给整个卡片加 opacity（会显得很脏），
 * 而是改变卡片的背景和边框，并降低内部文字和标签的透明度。
 * 另外如果任务完成了，优先级色条就不变成灰色了，保留原本颜色。
 */
.memo-card.is-overdue:not(.is-completed),
.timeline-card.is-overdue:not(.is-completed) {
  border-color: var(--overdue-border);
  background: var(--overdue-bg);

  .memo-title,
  .memo-time,
  .ai-summary,
  .memo-type {
    opacity: 0.6;
  }

  /* 过期且未完成的任务，色条变灰 */
  &.is-high .priority-bar,
  &.is-medium .priority-bar,
  &.is-low .priority-bar {
    background: var(--overdue-bar);
  }
}

/* 新添加的待办：品牌色呼吸光晕 */
.memo-card.is-new-memo {
  animation: memo-new-glow 1.8s ease-in-out infinite;

  &:hover {
    animation-play-state: paused;
  }
}

@keyframes memo-new-glow {
  0%,
  100% {
    box-shadow:
      0 0 0 0 tint(brand, 0%),
      var(--glass-shadow);
  }

  50% {
    box-shadow:
      0 0 0 3px tint(brand, 35%),
      0 10px 26px -10px tint(brand, 50%),
      var(--glass-shadow);
  }
}

@media (prefers-reduced-motion: reduce) {
  .memo-card.is-new-memo {
    animation: none;
    box-shadow:
      0 0 0 2px tint(brand, 45%),
      var(--glass-shadow);
  }
}

.memo-time {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: var(--fs-sm);
  color: var(--app-text-muted);

  .icon {
    width: 14px;
    height: 14px;
    color: var(--app-text-subtle);
  }
}

.ai-summary {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: auto;
  padding-top: 16px;
}

.ai-badge {
  @include ai-badge;
  flex-shrink: 0;
  margin-top: 1px;
  padding: 0 6px;
  line-height: 18px;
  letter-spacing: 0.04em;
}

.ai-text {
  display: -webkit-box;
  overflow: hidden;
  color: var(--app-text-muted);
  font-size: var(--fs-sm);
  line-height: 1.6;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}
.memo-timeline {
  position: relative;
  margin: 0;
  padding: 2px 0;
  list-style: none;

  &::before {
    content: "";
    position: absolute;
    top: 12px;
    bottom: 12px;
    left: 9px;
    width: 2px;
    border-radius: 1px;
    background: linear-gradient(180deg, var(--app-line), transparent);
  }
}

.timeline-item {
  position: relative;
  padding-left: 36px;

  & + & {
    margin-top: 12px;
  }
}

.timeline-dot {
  position: absolute;
  top: 22px;
  left: 0;
  width: 20px;
  height: 20px;
  border: 2px solid var(--app-line);
  border-radius: 50%;
  background: var(--surface-inner);
  box-shadow: 0 0 0 4px tint(brand, 8%);
}

.timeline-card {
  @include glass-panel(16px 20px);
  cursor: pointer;
  @include transition(box-shadow, transform, border-color);

  &:hover {
    transform: translateX(2px);
    border-color: tint(brand, 28%);
    box-shadow: var(--shadow-hover);
  }

  &:focus-visible {
    outline: none;
    border-color: tint(brand, 50%);
    box-shadow:
      0 0 0 3px var(--brand-ring),
      var(--shadow-hover);
  }

  .ai-summary {
    padding-top: 12px;
  }

  .memo-head {
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
  }
}

/* ---------------- 空状态 ---------------- */
.memo-empty {
  @include glass-panel(32px 0);
}

.empty-create {
  height: 36px;
  margin-top: 4px;
  padding: 0 20px;
  font-weight: 600;
}

/* ---------------- 响应式 ---------------- */
@include tablet {
  .stat-grid {
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }
}

@include mobile {
  .page-head {
    align-items: stretch;
  }

  .head-actions {
    width: 100%;
  }

  .search-input {
    flex: 1;
    width: auto;
  }

  .bell-btn,
  .legend {
    display: none;
  }

  .stat-grid {
    gap: 12px;
    margin-bottom: 24px;
  }

  .memo-grid {
    grid-template-columns: 1fr;
  }
}
</style>
