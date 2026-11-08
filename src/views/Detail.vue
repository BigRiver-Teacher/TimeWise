<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  watch,
} from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import type { FormInstance, FormRules } from "element-plus";
import { useMemoStore } from "@/stores/memo";
import type { MemoItem } from "@/stores/memo";
import { toStandardTime } from "@/utils/memoTime";

/* ------------------------------ 严格类型定义 ------------------------------ */
type Priority = "high" | "medium" | "low";

/** 基础信息表单：四个字段全部显式声明类型 */
interface DetailForm {
  /** 主题 */
  title: string;
  /** 时间，date-picker 用 value-format 直接产出字符串，避免 Date|null 的松散类型 */
  time: string;
  /** 紧急程度 */
  priority: Priority;
  /** 预计通知时间 */
  notifyAt: string;
}

interface PriorityOption {
  value: Priority;
  label: string;
  color: string;
}

interface ReminderPreset {
  hours: number;
  label: string;
}

/* ------------------------------ 基础信息 ------------------------------ */
const route = useRoute();
const router = useRouter();
const memoStore = useMemoStore();

const form = reactive<DetailForm>({
  title: "",
  time: "",
  priority: "medium",
  notifyAt: "",
});

const formRef = ref<FormInstance>();
const saving = ref(false);

const rules: FormRules<DetailForm> = {
  title: [{ required: true, message: "请输入备忘主题", trigger: "blur" }],
  // 时间 / 通知时间允许留空：
  // AI 提取的原文（如「本周末前」）可能换算不出标准时间，此时 form.time 是空串，
  // 若仍标记 required，输入框会标红并且 validate() 直接阻断保存。
  priority: [{ required: true, message: "请选择紧急程度", trigger: "change" }],
};

const priorityOptions: PriorityOption[] = [
  { value: "high", label: "高", color: "var(--prio-high)" },
  { value: "medium", label: "中", color: "var(--prio-mid)" },
  { value: "low", label: "低", color: "var(--prio-low)" },
];

const priorityLabel = computed(
  () => priorityOptions.find((opt) => opt.value === form.priority)?.label ?? "",
);

/* ------------------------------ 当前条目（来自 URL 的 id） ------------------------------ */
const memoId = computed<number | null>(() => {
  const raw = route.query.id;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.trim() === "") return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
});

/** 从 store 里找当前条目：刷新时 store 先读本地缓存，再与后端对齐 */
const memo = computed<MemoItem | null>(() => {
  if (memoId.value === null) return null;
  return memoStore.memos.find((item) => item.id === memoId.value) ?? null;
});

/** 「AI 智能概括」区展示用的优先级文案（跟随真实数据，而不是表单） */
const memoPriorityLabel = computed<string>(() => {
  const priority = memo.value?.priority;
  return (
    priorityOptions.find((opt) => opt.value === priority)?.label ?? "未设置"
  );
});

/* ------------------------------ 未保存状态 ------------------------------ */
const savedSnapshot = ref(JSON.stringify(form));
const isDirty = computed(() => JSON.stringify(form) !== savedSnapshot.value);

/** 条目就绪 / 切换条目时，把真实数据填进表单 */
watch(
  memo,
  (value) => {
    if (!value) return;

    // memo.time 可能是「明天下午2点」「2026年11月15日」这类中文文本，
    // 统一交给 @/utils/memoTime 换算（含下午/晚上/中午/凌晨 与「N点」写法）；
    // 解析不出来就留空，避免把非法值塞进 date-picker
    const standardTime = toStandardTime(value.time);

    form.title = value.title;
    form.time = standardTime;
    form.priority = value.priority;
    // 目前没有独立的「预计通知时间」字段，先用同一个标准时间兜底
    form.notifyAt = standardTime;
    savedSnapshot.value = JSON.stringify(form);
  },
  { immediate: true },
);

/* ------------------------------ 原文折叠 ------------------------------ */
/** 原文默认展示高度（px）：超出后折叠，并在底部加渐隐遮罩 */
const SOURCE_COLLAPSE_HEIGHT = 250;

const sourceBodyRef = ref<HTMLDivElement | null>(null);
/** 是否展开全文 */
const isExpanded = ref(false);
/** 内容真实高度：展开时作为 max-height 目标值，实现「高度平滑过渡」而不是直接跳变 */
const sourceFullHeight = ref(SOURCE_COLLAPSE_HEIGHT);
/** 内容是否真的超过折叠高度，决定要不要显示「展开全文」按钮 */
const isOverflowing = ref(false);

/** 量一次真实高度：scrollHeight 不受 max-height 限制，折叠状态下也能拿到全文高度 */
function measureSource(): void {
  const el = sourceBodyRef.value;
  if (!el) return;

  sourceFullHeight.value = el.scrollHeight;
  isOverflowing.value = el.scrollHeight > SOURCE_COLLAPSE_HEIGHT + 4;
}

/** 折叠 → 固定 250px；展开 → 真实高度。两者的差值由 CSS transition 补动画 */
const sourceMaxHeight = computed<string>(() =>
  isExpanded.value
    ? `${sourceFullHeight.value}px`
    : `${SOURCE_COLLAPSE_HEIGHT}px`,
);

function toggleSource(): void {
  isExpanded.value = !isExpanded.value;
}

/** 切换条目 / 原文变化后重新量高度（DOM 更新完再量），并收回展开状态 */
watch(
  () => memo.value?.originText,
  () => {
    isExpanded.value = false;
    void nextTick(measureSource);
  },
);

onMounted(() => {
  void nextTick(measureSource);
  // 窗口宽度变化会让文本重排，折叠阈值也要重算
  window.addEventListener("resize", measureSource);
});

onUnmounted(() => {
  window.removeEventListener("resize", measureSource);
});

/** 「AI 智能概括」下方的要点列表（老数据没有该字段时为空数组） */
const summaryKeyPoints = computed<string[]>(() => memo.value?.keyPoints ?? []);

/** 后端接口地址（与 store 保持一致） */
const API_BASE = "http://localhost:3000/api";

async function handleSave() {
  if (!formRef.value) return;
  try {
    await formRef.value.validate();
  } catch {
    ElMessage.warning("请先补全必填信息");
    return;
  }

  const id = memoId.value;
  if (id === null) {
    ElMessage.warning("未找到要保存的待办，无法保存");
    return;
  }
  if (id < 0) {
    ElMessage.warning("该条目还没同步到后端，请稍后再保存");
    return;
  }

  // time 一律取表单里的标准字符串（YYYY-MM-DD HH:mm:ss），
  // 绝不回传 memo.time（那是 AI 提取的中文原文，例如「2026年11月15日」）
  const payload = {
    title: form.title,
    time: form.time,
    priority: form.priority,
    // 类型 / 概括 / 原文不在表单里，原样回传，避免被后端清空
    type: memo.value?.type ?? "日常",
    aiSummary: memo.value?.aiSummary ?? "",
    originText: memo.value?.originText ?? "",
  };

  saving.value = true;
  try {
    const response = await fetch(`${API_BASE}/memos/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok)
      throw new Error(`PUT /memos/${id} 返回 ${response.status}`);

    // 关键：先把 Pinia 里这条的 time 手动同步成表单里的标准时间，再整体刷新。
    // 否则 fetchMemos 替换整个数组、watch(memo) 再触发时，会拿旧的中文 time
    // 重新解析一遍，把用户刚改好的 form.time 覆盖回去。
    const current = memoStore.memos.find((item) => item.id === id);
    if (current) current.time = form.time;

    savedSnapshot.value = JSON.stringify(form);
    ElMessage.success("修改已保存");

    // 再与后端对齐（此时 store 里的 time 已经是标准格式，watch 回填不会回跳）
    await memoStore.fetchMemos();
  } catch (error) {
    console.warn("[Detail] 保存待办失败：", error);
    ElMessage.error("保存失败，请检查后端服务");
  } finally {
    saving.value = false;
  }
}

function goBack() {
  router.push("/");
}

/* ------------------------------ 智能提醒 ------------------------------ */
/**
 * 阶梯式提醒表：紧急程度 → 提前量（小时），从早到晚递减。
 * 高: 24 / 6 / 3 小时；中: 6 / 3 小时；低: 3 小时。
 */
const suggestedHoursByPriority: Record<Priority, number[]> = {
  high: [24, 6, 3],
  medium: [6, 3],
  low: [3],
};

/** 可手动添加的提醒预设 */
const reminderPresets: ReminderPreset[] = [
  { hours: 168, label: "提前 7 天" },
  { hours: 72, label: "提前 3 天" },
  { hours: 48, label: "提前 2 天" },
  { hours: 24, label: "提前 1 天" },
  { hours: 12, label: "提前 12 小时" },
  { hours: 6, label: "提前 6 小时" },
  { hours: 3, label: "提前 3 小时" },
  { hours: 1, label: "提前 1 小时" },
];

/** 手动覆盖系统推荐 */
const override = ref(false);
/** 手动模式下的提醒列表，切换开关时用系统推荐值初始化 */
const manualReminders = ref<number[]>([]);
const pendingPreset = ref<number | null>(null);

/** 提前量 → 文案："提前 24 小时" */
function reminderLabel(hours: number): string {
  return `提前 ${hours} 小时`;
}

/** 当前紧急程度对应的阶梯式提前量（跟随 form.priority 实时变化） */
const suggestedReminderHours = computed<number[]>(
  () => suggestedHoursByPriority[form.priority] ?? suggestedHoursByPriority.low,
);

/** 页面展示用的阶梯式提醒文案：如 ["提前 24 小时", "提前 6 小时", "提前 3 小时"] */
const suggestedReminders = computed<string[]>(() =>
  suggestedReminderHours.value.map(reminderLabel),
);

/** 小时 → “3 天 / 6 小时”（手动预设用，7 天这类长间隔更易读） */
function formatHours(hours: number): string {
  if (hours % 24 === 0) return `${hours / 24} 天`;
  return `${hours} 小时`;
}

interface ReminderChip {
  key: string;
  label: string;
  /** 删除时用的小时数（自动推荐也能换算，但不可删） */
  hours: number;
  /** 只有手动模式才允许删除 */
  removable: boolean;
}

/**
 * 「提醒时间点」胶囊的数据源：
 * - 自动模式 → 由 suggestedReminders（阶梯式提醒）渲染，不可删除
 * - 手动模式 → 渲染 manualReminders，带删除按钮
 */
const reminderChips = computed<ReminderChip[]>(() => {
  if (override.value) {
    return manualReminders.value.map((hours) => ({
      key: `manual-${hours}`,
      label: `提前 ${formatHours(hours)}`,
      hours,
      removable: true,
    }));
  }

  return suggestedReminderHours.value.map((hours) => ({
    key: `auto-${hours}`,
    label: reminderLabel(hours),
    hours,
    removable: false,
  }));
});

watch(override, (enabled) => {
  if (enabled) manualReminders.value = [...suggestedReminderHours.value];
});

/**
 * 切换紧急程度时实时响应：
 * 手动列表若还等于「上一档的推荐值」（说明用户没改过），就跟着换成新一档推荐；
 * 用户自己增删过的列表则保留，不强改。
 */
watch(
  () => form.priority,
  (next, prev) => {
    if (!override.value) return;

    const prevSuggested = suggestedHoursByPriority[prev] ?? [];
    const untouched =
      manualReminders.value.length === prevSuggested.length &&
      manualReminders.value.every((hours, index) => hours === prevSuggested[index]);

    if (untouched) manualReminders.value = [...(suggestedHoursByPriority[next] ?? [])];
  },
);

const availablePresets = computed<ReminderPreset[]>(() =>
  reminderPresets.filter(
    (preset) => !manualReminders.value.includes(preset.hours),
  ),
);

function addReminder(): void {
  const hours = pendingPreset.value;
  if (hours === null || manualReminders.value.includes(hours)) return;
  manualReminders.value = [...manualReminders.value, hours].sort(
    (a, b) => b - a,
  );
  pendingPreset.value = null;
}

function removeReminder(hours: number): void {
  manualReminders.value = manualReminders.value.filter(
    (item) => item !== hours,
  );
}
</script>

<template>
  <div class="detail-page">
    <!-- 顶部操作栏 -->
    <header class="action-bar">
      <div class="bar-left">
        <el-button class="back-btn" text @click="goBack">
          <svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M14 6l-6 6 6 6"
              stroke="currentColor"
              stroke-width="1.9"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          返回
        </el-button>

        <div class="bar-title">
          <h1 class="page-title">详情</h1>
          <p class="page-subtitle">
            {{
              memo
                ? "编辑主题、时间与提醒设置"
                : "未找到该待办，可能已被删除或尚未同步"
            }}
          </p>
        </div>
      </div>

      <div class="bar-right">
        <span v-if="isDirty" class="dirty-chip">有未保存的修改</span>
        <el-button
          type="primary"
          size="large"
          class="save-btn"
          :loading="saving"
          @click="handleSave"
        >
          保存修改
        </el-button>
      </div>
    </header>

    <div class="content">
      <!-- 基础信息 -->
      <section class="panel">
        <div class="panel-head">
          <span class="panel-icon">
            <svg
              class="icon"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v11A2.5 2.5 0 0 1 16.5 20h-9A2.5 2.5 0 0 1 5 17.5v-11Z"
                stroke="currentColor"
                stroke-width="1.7"
              />
              <path
                d="M8.5 9h7M8.5 12.5h7M8.5 16h4"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
              />
            </svg>
          </span>
          <div class="panel-title-group">
            <h2 class="panel-title">基础信息</h2>
            <p class="panel-sub">修改后点击右上角「保存修改」生效</p>
          </div>
        </div>

        <el-form
          ref="formRef"
          class="detail-form"
          :model="form"
          :rules="rules"
          label-position="top"
          @submit.prevent
        >
          <el-form-item label="主题" prop="title">
            <el-input
              v-model="form.title"
              maxlength="60"
              show-word-limit
              placeholder="请输入备忘主题"
            />
          </el-form-item>

          <div class="form-row">
            <el-form-item label="时间" prop="time">
              <el-date-picker
                v-model="form.time"
                type="datetime"
                value-format="YYYY-MM-DD HH:mm:ss"
                format="YYYY-MM-DD HH:mm"
                placeholder="选择时间"
                class="full-width"
              />
              <!-- 兜底提示：AI 原文解析不出标准时间时只是留空，不再标红阻断保存 -->
              <p v-if="!form.time && memo?.time" class="field-hint is-warn">
                原时间是「{{ memo.time }}」，无法自动换算成标准时间，请手动选择；留空也可以直接保存。
              </p>
              <p v-else-if="!form.time" class="field-hint">时间可以留空，之后再补。</p>
            </el-form-item>

            <el-form-item label="紧急程度" prop="priority">
              <el-select
                v-model="form.priority"
                placeholder="选择紧急程度"
                class="full-width"
              >
                <el-option
                  v-for="option in priorityOptions"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value"
                >
                  <span
                    class="option-dot"
                    :style="{ backgroundColor: option.color }"
                  ></span>
                  {{ option.label }}
                </el-option>
              </el-select>
            </el-form-item>
          </div>

          <el-form-item label="预计通知时间" prop="notifyAt">
            <el-date-picker
              v-model="form.notifyAt"
              type="datetime"
              value-format="YYYY-MM-DD HH:mm:ss"
              format="YYYY-MM-DD HH:mm"
              placeholder="选择预计通知时间"
              class="full-width"
            />
            <p v-if="!form.notifyAt" class="field-hint">
              与「时间」联动，可留空；留空时按「时间」提醒。
            </p>
          </el-form-item>
        </el-form>
      </section>

      <!-- AI 对照 -->
      <section class="panel">
        <div class="panel-head">
          <span class="panel-icon is-ai">
            <svg
              class="icon"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.3 10.1 12.8 4.5 10.9 10.1 9Z"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linejoin="round"
              />
              <path
                d="M18.5 15.5l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9Z"
                fill="currentColor"
                opacity=".55"
              />
            </svg>
          </span>
          <div class="panel-title-group">
            <h2 class="panel-title">AI 对照</h2>
            <p class="panel-sub">
              OCR 原文与模型概括逐句对照，方便核对关键信息
            </p>
          </div>
        </div>

        <div class="compare-grid">
          <!-- 原文 -->
          <div class="compare-col source-col">
            <div class="col-head">
              <span class="col-title">原文识别内容</span>
              <span class="col-meta">
                {{ memo?.originText ? "来自录入时的识别结果" : "暂无原文" }}
              </span>
            </div>

            <!-- 原文：默认折叠到 250px，底部渐隐；点「展开全文」后平滑撑开 -->
            <div
              ref="sourceBodyRef"
              class="source-body"
              :class="{
                'is-collapsible': isOverflowing && !isExpanded,
                'is-expanded': isExpanded,
              }"
              :style="{ maxHeight: sourceMaxHeight }"
            >
              <p class="source-text">
                {{ memo?.originText || "（该条待办暂无完整原文记录）" }}
              </p>
            </div>

            <el-button
              v-if="isOverflowing"
              class="expand-btn"
              text
              @click="toggleSource"
            >
              <svg
                class="icon"
                :class="{ 'is-flipped': isExpanded }"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="m6 9 6 6 6-6"
                  stroke="currentColor"
                  stroke-width="1.9"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              {{ isExpanded ? "收起" : "展开全文" }}
            </el-button>

            <div class="source-file">
              <svg
                class="icon"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M6 3.5h7L18.5 9v11.5H6V3.5Z"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linejoin="round"
                />
                <path
                  d="M13 3.5V9h5.5"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linejoin="round"
                />
              </svg>
              {{ memo ? "条目 #" + memo.id + " · " + memo.type : "未找到条目" }}
            </div>
          </div>

          <!-- 概括 -->
          <div class="compare-col summary-col">
            <div class="col-head">
              <span class="col-title">
                <span class="ai-badge">AI</span>
                智能概括
              </span>
            </div>

            <p class="summary-text">
              {{ memo?.aiSummary || "（暂无 AI 概括）" }}
            </p>

            <!-- AI 要点：模型提取的 2-4 条关键信息，录入时随条目一起入库 -->
            <ul v-if="summaryKeyPoints.length" class="key-points">
              <li
                v-for="(point, index) in summaryKeyPoints"
                :key="`${index}-${point}`"
                class="key-point"
              >
                <span class="key-point-index">{{ index + 1 }}</span>
                <span class="key-point-text">{{ point }}</span>
              </li>
            </ul>
            <p v-else class="key-points-empty">
              AI 暂未提取到要点，可对照左侧原文核对。
            </p>

            <ul class="summary-points">
              <li>时间：{{ memo?.time || "未填写" }}</li>
              <li>类型：{{ memo?.type || "未分类" }}</li>
              <li>优先级：{{ memoPriorityLabel }}</li>
            </ul>

            <div v-if="memo" class="summary-tags">
              <el-tag class="ai-tag" effect="plain" size="small" round>
                {{ memo.type }}
              </el-tag>
              <el-tag class="ai-tag" effect="plain" size="small" round>
                {{ memoPriorityLabel }}
              </el-tag>
            </div>
          </div>
        </div>
      </section>

      <!-- 智能提醒 -->
      <section class="panel">
        <div class="panel-head">
          <span class="panel-icon is-ai">
            <svg
              class="icon"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
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
          </span>
          <div class="panel-title-group">
            <h2 class="panel-title">智能提醒</h2>
            <p class="panel-sub">系统会按紧急程度自动推荐提醒节奏</p>
          </div>

          <label class="override-switch">
            <span class="override-label">手动覆盖系统推荐</span>
            <el-switch v-model="override" />
          </label>
        </div>

        <!-- 系统提示 -->
        <div class="remind-tip">
          <svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle
              cx="12"
              cy="12"
              r="8.5"
              stroke="currentColor"
              stroke-width="1.7"
            />
            <path
              d="M12 11v5.5"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
            />
            <circle cx="12" cy="7.8" r="1" fill="currentColor" />
          </svg>
          <p>
            系统已根据紧急程度（<b>{{ priorityLabel }}</b>），自动为您设定
            <b>{{ suggestedReminders.join("、") }}</b> 提醒。
          </p>
        </div>

        <!-- 提醒时间点：由 reminderChips（阶梯式提醒）循环渲染，不再写死 -->
        <div class="remind-row">
          <span class="remind-label">提醒时间点</span>

          <div class="reminder-chips">
            <span
              v-for="chip in reminderChips"
              :key="chip.key"
              class="reminder-chip"
              :class="{ 'is-manual': override }"
            >
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
              {{ chip.label }}
              <button
                v-if="chip.removable"
                type="button"
                class="chip-remove"
                :aria-label="`移除 ${chip.label} 的提醒`"
                @click="removeReminder(chip.hours)"
              >
                ×
              </button>
            </span>

            <span v-if="!reminderChips.length" class="reminder-empty"
              >暂无提醒时间点</span
            >
          </div>
        </div>

        <!-- 手动模式下可增删 -->
        <div v-if="override" class="manual-row">
          <el-select
            v-model="pendingPreset"
            class="preset-select"
            placeholder="添加提醒时间点"
            :disabled="!availablePresets.length"
          >
            <el-option
              v-for="preset in availablePresets"
              :key="preset.hours"
              :label="preset.label"
              :value="preset.hours"
            />
          </el-select>

          <el-button
            class="add-btn"
            :disabled="pendingPreset === null"
            @click="addReminder"
          >
            添加
          </el-button>
        </div>

        <p class="remind-hint">
          <template v-if="override"
            >已切换为手动设置，增删后记得保存修改。</template
          >
          <template v-else
            >关闭覆盖将恢复系统推荐方案，修改紧急程度会自动重新计算。</template
          >
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped lang="scss">
$brand: #4f46e5;
$brand-soft: var(--brand-soft);
$ai: #8b5cf6;
$ai-deep: #7c3aed;
$ai-soft: var(--ai-soft);
$text: var(--app-text);
$text-muted: var(--app-text-muted);
$text-subtle: var(--app-text-subtle);
$bg: var(--app-bg);
$surface: var(--app-surface);
$line: var(--app-line);
$radius-lg: 16px;
$radius-md: 12px;
$radius-sm: 8px;
$shadow-card:
  0 1px 2px rgba(16, 24, 40, 0.04),
  0 1px 3px rgba(16, 24, 40, 0.06);

.detail-page {
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

/* ---------------- 顶部操作栏 ---------------- */
.action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
  max-width: 1080px;
  margin: 0 auto 20px;
}

.bar-left {
  display: flex;
  // align-items: center;
  gap: 14px;
}

.back-btn {
  padding: 0 8px 0 4px;
  color: $text-muted;
  font-size: 13px;
  font-weight: 500;

  .icon {
    width: 15px;
    height: 15px;
    margin-right: 2px;
  }

  &:hover {
    color: $brand;
    background: transparent;
  }
}

.page-title {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.25;
  letter-spacing: -0.02em;
}

.page-subtitle {
  margin-top: 4px;
  font-size: 13px;
  color: $text-muted;
}

.bar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.dirty-chip {
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn-text);
  font-size: 12px;
  font-weight: 600;
}

.save-btn {
  min-width: 116px;
  height: 42px;
  border: none;
  border-radius: $radius-md;
  font-weight: 600;
  box-shadow: 0 6px 16px -8px rgba($brand, 0.7);
  transition:
    transform 0.2s var(--ease),
    box-shadow 0.2s ease;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 22px -10px rgba($brand, 0.8);
  }

  &:active {
    transform: translateY(0) scale(0.98);
    transition-duration: 0.1s;
  }
}

/* ---------------- 卡片 ---------------- */
.content {
  max-width: 1080px;
  margin: 0 auto;
}

.panel {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  box-shadow: var(--glass-shadow);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));

  padding: 22px 24px 24px;

  animation: rise-in 0.5s var(--ease) backwards;

  &:nth-of-type(1) {
    animation-delay: 0ms;
  }

  &:nth-of-type(2) {
    animation-delay: 80ms;
  }

  &:nth-of-type(3) {
    animation-delay: 160ms;
  }

  & + & {
    margin-top: 18px;
  }
}

.panel-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.panel-icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 11px;
  background: $brand-soft;
  color: $brand;
  flex-shrink: 0;

  .icon {
    width: 19px;
    height: 19px;
  }

  &.is-ai {
    background: linear-gradient(135deg, rgba($ai, 0.14), rgba($ai, 0.06));
    color: $ai;
  }
}

.panel-title-group {
  min-width: 0;
}

.panel-title {
  font-size: 15px;
  font-weight: 700;
  line-height: 1.4;
}

.panel-sub {
  margin-top: 2px;
  font-size: 12.5px;
  color: $text-subtle;
}

/* ---------------- 表单 ---------------- */
.detail-form {
  margin-top: 20px;
}

.detail-form :deep(.el-form-item) {
  margin-bottom: 18px;
}

.detail-form :deep(.el-form-item__label) {
  margin-bottom: 6px;
  padding: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--app-text);
}

.form-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  text-align: center;
}

.full-width {
  width: 100%;
}

/* El 的日期选择器默认固定 220px，宽度需要覆盖到内部 input 上 */
.detail-form :deep(.el-date-editor.el-input),
.detail-form :deep(.el-date-editor.el-input__wrapper) {
  width: 100%;
}

.detail-form :deep(.el-input__wrapper),
.detail-form :deep(.el-select__wrapper) {
  min-height: 40px;
  border-radius: $radius-sm;
  background: var(--input-bg);
  box-shadow: 0 0 0 1px $line inset;
  transition: box-shadow 0.2s ease;

  &:hover {
    box-shadow: 0 0 0 1px var(--app-line) inset;
  }

  &.is-focus {
    box-shadow: 0 0 0 2px rgba($brand, 0.3) inset;
  }
}

.detail-form :deep(.el-input__count) {
  background: transparent;
  color: $text-subtle;
}

/* 表单兜底提示：时间换算不出来 / 可留空时给一句说明，不再标红报错 */
.field-hint {
  width: 100%;
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.6;
  color: $text-subtle;

  &.is-warn {
    color: var(--warn-text);
  }
}

.option-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 7px;
  border-radius: 50%;
  vertical-align: middle;
}

/* ---------------- AI 对照 ---------------- */
.compare-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 20px;
}

.compare-col {
  display: flex;
  flex-direction: column;
  padding: 18px 20px;
  border-radius: $radius-md;
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

.source-col:hover {
  border-color: var(--app-text-subtle);
  box-shadow: var(--shadow-sm);
}

.summary-col:hover {
  border-color: rgba($ai, 0.55);
  box-shadow: 0 8px 20px -14px rgba($ai, 0.5);
}

.source-col {
  border: 1px solid $line;
  background: var(--chip-bg);
}

.summary-col {
  border: 1px solid rgba($ai, 0.35);
  background: $ai-soft;
}

.col-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}

.col-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 700;
  color: var(--app-text);
}

.summary-col .col-title {
  color: var(--ai-text);
}

.col-meta {
  font-size: 12px;
  color: $text-subtle;
}

.source-text {
  font-size: 13px;
  line-height: 1.9;
  color: var(--app-text-muted);
  white-space: pre-wrap;
}

/* ---------------- 原文折叠 ---------------- */
.source-body {
  position: relative;
  overflow: hidden;
  /* 高度由内联 max-height 控制，这里只负责过渡动画 */
  transition: max-height 0.34s ease;

  /* 底部渐隐遮罩：常驻但默认透明，收起/展开时才有淡出动画 */
  &::after {
    content: "";
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 76px;
    background: var(--fade-mask);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.28s ease;
  }

  &.is-collapsible::after {
    opacity: 1;
  }
}

/* 用双类选择器压过 Element Plus 的 .el-button.is-text 默认色 */
.source-col .expand-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  align-self: flex-start;
  height: 26px;
  margin-top: 6px;
  padding: 0 2px;
  font-size: 12.5px;
  font-weight: 600;
  color: $brand;

  .icon {
    width: 14px;
    height: 14px;
    transition: transform 0.28s ease;

    &.is-flipped {
      transform: rotate(180deg);
    }
  }

  &:hover,
  &:focus-visible {
    background: transparent;
    opacity: 0.82;
  }
}

.source-file {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: auto;
  padding-top: 14px;
  font-size: 12px;
  color: $text-subtle;

  .icon {
    width: 14px;
    height: 14px;
  }
}

.ai-badge {
  height: 18px;
  padding: 0 6px;
  border-radius: 6px;
  background: linear-gradient(135deg, $ai, $ai-deep);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 18px;
  letter-spacing: 0.04em;
}

.summary-text {
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.75;
  color: var(--ai-text);
}

/* ---------------- AI 要点列表 ---------------- */
.key-points {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}

.key-point {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12.8px;
  line-height: 1.7;
  color: var(--app-text-muted);
}

.key-point-index {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  margin-top: 2px;
  border-radius: 6px;
  background: var(--ai-soft);
  color: var(--ai-text);
  font-size: 11px;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
}

.key-point-text {
  min-width: 0;
  word-break: break-word;
}

.key-points-empty {
  margin-top: 10px;
  font-size: 12.5px;
  color: $text-subtle;
}

.summary-points {
  margin: 12px 0 0;
  padding: 0;
  list-style: none;

  li {
    position: relative;
    padding-left: 14px;
    font-size: 12.5px;
    line-height: 1.9;
    color: var(--app-text-muted);

    &::before {
      content: "";
      position: absolute;
      top: 9px;
      left: 2px;
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: rgba($ai, 0.65);
    }
  }
}

.summary-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}

.ai-tag {
  border-color: rgba($ai, 0.35);
  background: var(--chip-bg);
  color: $ai-deep;
  font-weight: 500;
}

/* ---------------- 智能提醒 ---------------- */
.override-switch {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
  cursor: pointer;
}

.override-label {
  font-size: 12.5px;
  color: $text-muted;
}

.remind-tip {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 18px;
  padding: 12px 14px;
  border: 1px solid rgba($ai, 0.22);
  border-radius: $radius-md;
  background: rgba($ai, 0.07);

  .icon {
    width: 15px;
    height: 15px;
    margin-top: 3px;
    color: $ai-deep;
  }

  p {
    font-size: 12.5px;
    line-height: 1.75;
    color: var(--app-text-muted);
  }

  b {
    color: var(--ai-text);
  }
}

.remind-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 18px;
  flex-wrap: wrap;
}

.remind-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--app-text);
}

.reminder-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.reminder-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid $line;
  border-radius: 999px;
  background: var(--chip-bg);
  font-size: 12.5px;
  color: var(--app-text-muted);
  transition:
    border-color 0.2s ease,
    background 0.2s ease,
    transform 0.2s var(--ease),
    box-shadow 0.2s ease;

  &:hover {
    transform: translateY(-1px);
    box-shadow: var(--shadow-sm);
  }

  .icon {
    width: 13px;
    height: 13px;
    color: $text-subtle;
  }

  &.is-manual {
    border-color: rgba($ai, 0.4);
    background: rgba($ai, 0.06);
    color: var(--ai-text);

    .icon {
      color: $ai;
    }
  }
}

.chip-remove {
  margin-left: 2px;
  padding: 0 2px;
  border: none;
  background: transparent;
  color: $text-subtle;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.2s ease;

  &:hover {
    color: #ef4444;
  }
}

.reminder-empty {
  font-size: 12.5px;
  color: $text-subtle;
}

.manual-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.preset-select {
  width: 190px;
}

.add-btn {
  height: 34px;
  border-radius: $radius-sm;
}

.remind-hint {
  margin-top: 12px;
  font-size: 12px;
  color: $text-subtle;
}

/* ---------------- 响应式 ---------------- */
@media (max-width: 760px) {
  .action-bar {
    align-items: flex-start;
  }

  .form-row,
  .compare-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .override-switch {
    width: 100%;
    margin-left: 0;
    justify-content: space-between;
  }

  .panel-head {
    flex-wrap: wrap;
  }

  .preset-select {
    flex: 1;
    width: auto;
  }
}
</style>
