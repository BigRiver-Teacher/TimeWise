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
/** 列表分类：待办中 / 已完成 */
type ListTab = "pending" | "completed";

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
/** 列表分类：待办中 / 已完成 */
const activeTab = ref<ListTab>("pending");
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

/** 两个分类各自的数量，用于标签上的角标 */
const pendingCount = computed(
  () => memos.value.filter((memo) => !memo.completed).length,
);
const completedCount = computed(
  () => memos.value.filter((memo) => memo.completed).length,
);

/**
 * 列表数据 = 先按分类过滤（待办中 / 已完成），再叠加关键词搜索。
 * 排序沿用 sortedMemos（未完成在前、时间升序、同时间按优先级）。
 */
const filteredMemos = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  const wantCompleted = activeTab.value === "completed";

  return sortedMemos.value.filter((memo) => {
    // 1) 分类过滤
    if (wantCompleted ? !memo.completed : memo.completed) return false;

    // 2) 关键词过滤
    if (!kw) return true;
    return [memo.title, memo.type, memo.aiSummary].some((field) =>
      field.toLowerCase().includes(kw),
    );
  });
});

/** 列表为空时的文案：区分「搜索没命中」和「这个分类本来就没有任务」 */
const emptyStateText = computed(() => {
  if (keyword.value.trim()) return "没有匹配的条目，换个关键词试试";
  if (activeTab.value === "completed") return "暂无已完成的任务，勾选完成的任务会出现在这里";
  return "待办已清空，先休息一下吧";
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

          <!-- 分类切换：待办中 / 已完成 -->
          <el-radio-group v-model="activeTab" class="tab-switch" size="small">
            <el-radio-button value="pending">
              待办中 {{ pendingCount }}
            </el-radio-button>
            <el-radio-button value="completed">
              已完成 {{ completedCount }}
            </el-radio-button>
          </el-radio-group>

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

      <!-- 有数据但当前分类 / 搜索结果为空 -->
      <div v-else-if="!filteredMemos.length" class="memo-empty">
        <el-empty :image-size="88" :description="emptyStateText" />
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
$brand: #4f46e5;
$brand-soft: var(--brand-soft);
$danger: #ef4444;
$warn: #f59e0b;
$success: #10b981;
$text: var(--app-text);
$text-muted: var(--app-text-muted);
$text-subtle: var(--app-text-subtle);
$bg: var(--app-bg);
$surface: var(--app-surface);
$line: var(--app-line);
$radius-lg: 14px;
$radius-md: 10px;
$radius-sm: 8px;
$shadow-card:
  0 1px 2px rgba(16, 24, 40, 0.04),
  0 1px 3px rgba(16, 24, 40, 0.06);
$shadow-hover:
  0 10px 24px -8px rgba(16, 24, 40, 0.16),
  0 2px 6px rgba(16, 24, 40, 0.05);

.overview-page {
  --el-color-primary: #{$brand};
  --el-color-primary-light-3: #847eed;
  --el-color-primary-light-5: #a7a3f2;
  --el-color-primary-light-7: #cac8f7;
  --el-color-primary-light-8: #dcdafa;
  --el-color-primary-light-9: #edeefc;
  --el-color-primary-dark-2: #3f38b7;
  --el-text-color-regular: #{$text};
  --el-border-radius-base: #{$radius-sm};

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
  gap: 24px;
  flex-wrap: wrap;
  max-width: 1200px;
  margin: 0 auto 24px;
}

.page-title {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.25;
  letter-spacing: -0.02em;
  color: $text;
}

.page-subtitle {
  margin-top: 6px;
  font-size: 13.5px;
  color: $text-muted;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.search-input {
  width: 280px;

  :deep(.el-input__wrapper) {
    border-radius: $radius-sm;
    background: var(--input-bg);
    box-shadow: 0 0 0 1px $line inset;
    padding: 1px 12px;
    transition: box-shadow 0.2s ease;

    &:hover {
      box-shadow: 0 0 0 1px var(--app-line) inset;
    }

    &.is-focus {
      box-shadow: 0 0 0 2px rgba($brand, 0.35) inset;
    }
  }

  :deep(.el-input__prefix) {
    color: $text-subtle;
  }
}

.bell-btn {
  width: 40px;
  height: 40px;
  margin-left: 0;
  border: 1px solid $line;
  background: $surface;
  color: $text-muted;
  transition:
    color 0.2s ease,
    border-color 0.2s ease,
    background 0.2s ease;

  .icon {
    width: 17px;
    height: 17px;
  }

  &:hover {
    border-color: rgba($brand, 0.35);
    background: $brand-soft;
    color: $brand;
  }
}

.create-btn {
  height: 40px;
  padding: 0 18px;
  border: none;
  border-radius: $radius-sm;
  font-weight: 600;
  box-shadow: 0 6px 14px -6px rgba($brand, 0.65);

  .icon {
    width: 15px;
    height: 15px;
    margin-right: 6px;
  }

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 20px -8px rgba($brand, 0.7);
  }
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  max-width: 1200px;
  margin: 0 auto 28px;
}

.stat-card {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  box-shadow: var(--glass-shadow);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));

  transition:
    box-shadow 0.22s ease,
    transform 0.22s ease;

  &:hover {
    transform: translateY(-2px);
    box-shadow: $shadow-hover;
  }

  :deep(.el-card__body) {
    padding: 18px 20px;
  }
}

.stat-inner {
  display: flex;
  align-items: center;
  gap: 14px;
}

.stat-icon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 12px;

  .icon {
    width: 20px;
    height: 20px;
  }

  &.is-brand {
    color: $brand;
    background: $brand-soft;
  }

  &.is-danger {
    color: $danger;
    background: var(--danger-soft);
  }

  &.is-success {
    color: $success;
    background: var(--success-soft);
  }
}

.stat-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat-label {
  font-size: 13px;
  color: $text-muted;
}

.stat-value {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;

  small {
    margin-left: 1px;
    font-size: 14px;
    font-weight: 600;
  }

  &.is-brand {
    color: $brand;
  }

  &.is-danger {
    color: $danger;
  }

  &.is-success {
    color: $success;
  }
}

.stat-hint {
  margin-top: 12px;
  font-size: 12px;
  color: $text-subtle;
}

.stat-progress {
  margin-top: 14px;

  :deep(.el-progress-bar__outer) {
    background-color: var(--chip-bg);
  }
}

.list-section {
  max-width: 1200px;
  margin: 0 auto;
}

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
  gap: 10px;
}

.list-title {
  font-size: 16px;
  font-weight: 700;
  color: $text;
}

.list-count {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--chip-bg);
  color: $text-muted;
  font-size: 12px;
  font-weight: 600;
}

.legend {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 0 0 0 6px;
  padding: 0;
  list-style: none;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: $text-muted;
}

.legend-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.view-switch {
  :deep(.el-radio-button__inner) {
    border-color: $line;
    background: $surface;
    color: $text-muted;
    font-weight: 500;
    padding: 9px 16px;
    box-shadow: none;
    transition: all 0.2s ease;
  }

  :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
    background: $brand-soft;
    border-color: rgba($brand, 0.45);
    color: $brand;
    box-shadow: none;
  }

  :deep(
    .el-radio-button__original-radio:focus-visible + .el-radio-button__inner
  ) {
    outline: none;
    box-shadow: inset 0 0 0 1px rgba($brand, 0.55);
  }
}

.memo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(310px, 1fr));
  gap: 16px;
}

.memo-card {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  box-shadow: var(--glass-shadow);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));

  position: relative;
  overflow: hidden;
  padding: 18px 20px 18px 24px;
  cursor: pointer;
  outline: none;
  transition:
    transform 0.22s ease,
    box-shadow 0.22s ease,
    border-color 0.22s ease;

  &:hover {
    transform: translateY(-3px);
    border-color: rgba($brand, 0.28);
    box-shadow: $shadow-hover;
  }

  &:focus-visible {
    border-color: rgba($brand, 0.5);
    box-shadow:
      0 0 0 3px rgba($brand, 0.16),
      $shadow-hover;
  }

  &.is-high .priority-bar {
    background: $danger;
  }

  &.is-medium .priority-bar {
    background: $warn;
  }

  &.is-low .priority-bar {
    background: $success;
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
  min-height: 118px;
}

.memo-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

/* 新增：包裹勾选框和标题的行 */
.memo-title-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  flex: 1;
}

.memo-checkbox {
  margin-top: 2px; /* 微调对齐 */
  line-height: 6px;
  // line-height:100%;
}

.memo-title {
  font-size: 15px;
  font-weight: 700;
  line-height: 1.45;
  color: $text;
  transition: all 0.2s ease;

  /* 新增：已完成任务的标题样式 */
  &.is-completed {
    text-decoration: line-through;
    opacity: 0.5;
  }
}

.memo-type {
  flex-shrink: 0;
  border-color: $line;
  background: var(--chip-bg);
  color: var(--app-text-muted);
  font-weight: 500;
  font-size: 11.5px;
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
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: $text-subtle;
  cursor: pointer;
  opacity: 0.55;
  transition:
    opacity 0.18s ease,
    color 0.18s ease,
    background 0.18s ease;

  .el-icon {
    font-size: 15px;
  }

  &:hover {
    opacity: 1;
    color: $danger;
    background: rgba(239, 68, 68, 0.1);
  }

  &:focus-visible {
    opacity: 1;
    outline: 2px solid rgba(239, 68, 68, 0.45);
    outline-offset: 1px;
  }
}

.memo-card:hover .memo-delete {
  opacity: 1;
}

/* 过期任务置灰 */
.memo-card.is-overdue {
  opacity: 0.55;
  background: var(--overdue-bg, var(--glass-bg));
  border-color: var(--overdue-border, rgba(156, 163, 175, 0.34));

  .memo-type {
    color: $text-subtle;
  }
}

html.dark .memo-card.is-overdue {
  background: var(--overdue-bg, rgba(50, 52, 60, 0.45));
  border-color: var(--overdue-border, rgba(255, 255, 255, 0.09));
}

.memo-card.is-overdue .priority-bar {
  background: var(--overdue-bar, #9ca3af);
}

/* 新添加的待办：紫色呼吸光晕 */
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
      0 0 0 0 rgba(139, 92, 246, 0),
      var(--glass-shadow);
  }

  50% {
    box-shadow:
      0 0 0 3px rgba(139, 92, 246, 0.38),
      0 10px 26px -10px rgba(139, 92, 246, 0.55),
      var(--glass-shadow);
  }
}

@media (prefers-reduced-motion: reduce) {
  .memo-card.is-new-memo {
    animation: none;
    box-shadow:
      0 0 0 2px rgba(139, 92, 246, 0.45),
      var(--glass-shadow);
  }
}

.memo-time {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  font-size: 12.5px;
  color: $text-muted;

  .icon {
    width: 13px;
    height: 13px;
    color: $text-subtle;
  }
}

.ai-summary {
  display: flex;
  gap: 8px;
  margin-top: auto;
  padding-top: 14px;
}

.ai-badge {
  flex-shrink: 0;
  height: 18px;
  padding: 0 6px;
  border-radius: 6px;
  background: linear-gradient(135deg, $brand, #7c6cf0);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 18px;
  letter-spacing: 0.04em;
}

.ai-text {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--app-text-muted);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}

.memo-timeline {
  position: relative;
  max-width: 920px;
  margin: 0;
  padding: 2px 0 2px 0;
  list-style: none;

  &::before {
    content: "";
    position: absolute;
    top: 12px;
    bottom: 12px;
    left: 9px;
    width: 2px;
    background: linear-gradient(180deg, var(--app-line), transparent);
  }
}

.timeline-item {
  position: relative;
  padding-left: 34px;

  & + & {
    margin-top: 12px;
  }
}

.timeline-dot {
  position: absolute;
  top: 20px;
  left: 0;
  width: 20px;
  height: 20px;
  border: 2px solid $line;
  border-radius: 50%;
  background: $surface;
  box-shadow: 0 0 0 4px $bg;
}

.timeline-card {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  box-shadow: var(--glass-shadow);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));

  padding: 16px 18px;
  transition:
    box-shadow 0.22s ease,
    transform 0.22s ease;

  &:hover {
    transform: translateX(2px);
    box-shadow: $shadow-hover;
  }

  .ai-summary {
    padding-top: 10px;
  }

  .memo-head {
    justify-content: flex-start;
    align-items: center;
    gap: 8px;
  }
}

.memo-empty {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  box-shadow: var(--glass-shadow);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));

  padding: 32px 0;
}

.empty-create {
  margin-top: 4px;
  padding: 0 20px;
  height: 36px;
  font-weight: 600;
}

@media (max-width: 1024px) {
  .stat-grid {
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }
}

@media (max-width: 720px) {
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

  .memo-grid {
    grid-template-columns: 1fr;
  }

  .legend {
    display: none;
  }
}

@media (max-width: 720px) {
  .bell-btn {
    display: none;
  }
}

/* ---------------- 待办中 / 已完成 分类切换 ---------------- */
.toolbar-left {
  flex-wrap: wrap;
}

.tab-switch {
  :deep(.el-radio-button__inner) {
    border-color: $line;
    background: $surface;
    color: $text-muted;
    font-weight: 500;
    font-size: 12.5px;
    padding: 5px 12px;
    box-shadow: none;
    transition: all 0.2s ease;
  }

  :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
    background: $brand-soft;
    border-color: rgba($brand, 0.45);
    color: $brand;
    box-shadow: none;
  }

  :deep(
    .el-radio-button__original-radio:focus-visible + .el-radio-button__inner
  ) {
    outline: none;
    box-shadow: inset 0 0 0 1px rgba($brand, 0.55);
  }
}
</style>
