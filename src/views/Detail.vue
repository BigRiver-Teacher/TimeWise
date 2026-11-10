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
import { isAbsoluteTime, isStandardTime, toStandardTime } from "@/utils/memoTime";
import { REMINDER_ADVANCE_RULES, formatAdvanceLabel } from "@/constants/reminder";

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

/** 后端 reminderConfig（TEXT / JSON 字符串）反序列化后的结构 */
interface ReminderConfig {
  /** 预计通知时间，空串表示按系统推荐 */
  notifyAt: string;
  /** 是否手动覆盖系统推荐 */
  override: boolean;
  /** 手动提醒时间点（单位小时，降序），最多 REMINDER_MAX_COUNT 条 */
  manualReminders: number[];
}

/** 手动提醒条目上限：沿用项目现有「最多 6 条」的约定 */
const REMINDER_MAX_COUNT = 6;

/** 默认配置：字段缺失 / 解析失败时的兜底 */
function createDefaultReminderConfig(): ReminderConfig {
  return { notifyAt: "", override: false, manualReminders: [] };
}

/* ------------------------------ 基础信息 ------------------------------ */
const route = useRoute();
const router = useRouter();
const memoStore = useMemoStore();

/** 后端接口地址（与 store 保持一致） */
const API_BASE = "http://localhost:3000/api";

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

/**
 * 展示区只读时间文案：
 * - 已是绝对时间 → 原样展示，打开多少次、放多少天都不变
 * - 历史残留的相对词 → 按该条记录自身的 createdAt 一次性换算（不写回、不随打开时间漂移）
 * - 没有 createdAt 参照 → 留空，绝不按当前时刻重新解释
 */
const displayTime = computed<string>(() => {
  const item = memo.value;
  if (!item) return "";
  if (isAbsoluteTime(item.time)) return item.time;
  if (!item.createdAt) return "";
  return toStandardTime(item.time, item.createdAt);
});

/* ------------------------------ 未保存状态 ------------------------------ */
const savedSnapshot = ref(JSON.stringify(form));
const isDirty = computed(() => JSON.stringify(form) !== savedSnapshot.value);

/**
 * 保存成功后的整体刷新会再次触发下面的回填 watch，
 * 用这个开关挡住，避免把用户刚刚保存的配置闪回成旧值。
 */
let suppressRefill = false;

/** 已读取过提醒配置的条目 id：store 反复刷新时不重复请求 */
let configLoadedFor: number | null = null;

/** 本次会话里已经保存过的条目 id：阻止在途的读取结果覆盖刚保存的配置 */
let configSavedFor: number | null = null;

/** 正在把后端配置写进表单：此时不触发 override 的「恢复系统推荐」副作用 */
let applyingConfig = false;

/**
 * 条目就绪 / 切换条目时，把真实数据填进表单。
 * 提醒配置不在 Pinia 的展示字段里，按 id 单独从接口读取后反序列化回填。
 */
watch(
  memo,
  (value) => {
    if (!value) return;

    // 已是标准绝对时间 → 原样回填；历史残留的相对词（「明天下午2点」等）
    // 按该条记录自身的 createdAt 一次性换算，之后反复打开也不会逐日顺延。
    // 解析不出来就留空，避免把非法值塞进 date-picker。
    const standardTime = isStandardTime(value.time)
      ? value.time
      : value.createdAt
        ? toStandardTime(value.time, value.createdAt)
        : "";

    if (!suppressRefill) {
      form.title = value.title;
      form.time = standardTime;
      form.priority = value.priority;
      savedSnapshot.value = JSON.stringify(form);
    }

    void ensureReminderConfig(value.id);
  },
  { immediate: true },
);

/**
 * 反序列化 reminderConfig：
 * 空串、JSON 损坏、字段类型不符等任何异常都退回默认配置，绝不阻断页面渲染。
 */
function parseReminderConfig(raw: unknown): ReminderConfig {
  const fallback = createDefaultReminderConfig();
  if (typeof raw !== "string" || !raw.trim()) return fallback;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return fallback;

    const record = parsed as Record<string, unknown>;
    const notifyAt =
      typeof record.notifyAt === "string" ? record.notifyAt.trim() : "";
    const override = record.override === true;

    const manualReminders: number[] = [];
    if (Array.isArray(record.manualReminders)) {
      for (const item of record.manualReminders) {
        if (typeof item !== "number" || !Number.isFinite(item) || item <= 0) {
          continue;
        }
        if (manualReminders.includes(item)) continue;

        manualReminders.push(item);
        if (manualReminders.length >= REMINDER_MAX_COUNT) break;
      }
      manualReminders.sort((a, b) => b - a);
    }

    return { notifyAt, override, manualReminders };
  } catch (error) {
    console.warn("[Detail] 提醒配置解析失败，已回退默认配置：", error);
    return fallback;
  }
}

/** 把表单里的提醒设置序列化成落库用的 JSON 字符串 */
function serializeReminderConfig(): string {
  const config: ReminderConfig = {
    // 预计通知时间为空时按系统推荐提醒，落库仍存空字符串
    notifyAt: form.notifyAt ?? "",
    override: override.value,
    manualReminders: override.value ? [...manualReminders.value] : [],
  };
  return JSON.stringify(config);
}

/** 把后端配置写进表单（override 的联动 watch 由 applyingConfig 挡住） */
function applyReminderConfig(config: ReminderConfig): void {
  applyingConfig = true;
  form.notifyAt = config.notifyAt;
  override.value = config.override;
  manualReminders.value = config.override ? [...config.manualReminders] : [];
  savedSnapshot.value = JSON.stringify(form);

  void nextTick(() => {
    applyingConfig = false;
  });
}

/**
 * 读取并回填提醒配置：
 * - 直接刷新进入详情、本地缓存为空时同样能拿到后端真实配置
 * - 接口异常、配置缺失、格式损坏一律按默认配置渲染
 */
async function ensureReminderConfig(id: number): Promise<void> {
  if (!Number.isInteger(id) || id <= 0) return;
  if (configLoadedFor === id) return;
  configLoadedFor = id;

  try {
    const response = await fetch(`${API_BASE}/memos`);
    if (!response.ok) throw new Error(`GET /memos 返回 ${response.status}`);

    const list: unknown = await response.json();
    if (!Array.isArray(list) || memoId.value !== id) return;
    // 在途期间已经保存过：以用户刚保存的配置为准，忽略旧快照
    if (configSavedFor === id) return;

    const target = list.find(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        (item as { id?: unknown }).id === id,
    ) as { reminderConfig?: unknown } | undefined;

    applyReminderConfig(parseReminderConfig(target?.reminderConfig));
  } catch (error) {
    // 允许 store 下次刷新时重试；本次保持默认配置，不影响页面可用性
    configLoadedFor = null;
    console.warn("[Detail] 读取提醒配置失败，已按默认配置渲染：", error);
  }
}

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

async function handleSave() {
  // 并发保存：loading 期间重复点击直接忽略，避免后到的请求用旧值覆盖新值
  if (saving.value) return;
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
  // 数据尚未加载完成（store 里还没有这条）时不允许保存，避免用空值覆盖库中内容
  if (!memo.value) {
    ElMessage.warning("数据还在加载，请稍后再保存");
    return;
  }

  // time 一律取表单里的标准字符串（YYYY-MM-DD HH:mm:ss），绝不回传 memo.time 的原文。
  // 回填时已经按原记录 createdAt 固化过一次，这里再以同一个 createdAt 为基准归一，
  // 保证「重复打开 / 反复保存」时时间值恒定，不会随保存当天漂移。
  const standardTime = isStandardTime(form.time)
    ? form.time
    : toStandardTime(form.time, memo.value.createdAt);

  const payload: Record<string, unknown> = {
    title: form.title,
    priority: form.priority,
    // 类型 / 概括 / 原文不在表单里，原样回传，避免被后端清空
    type: memo.value.type,
    aiSummary: memo.value.aiSummary,
    originText: memo.value.originText ?? "",
    // 提醒配置随保存一起落库（预计通知时间 / 是否手动覆盖 / 手动提醒时间点）
    reminderConfig: serializeReminderConfig(),
  };

  // 清空时间后不下发 time 字段：后端保留库中原值，不把空串写进去
  if (standardTime) payload.time = standardTime;

  saving.value = true;
  // 保存期间的 store 刷新不参与回填，防止把刚保存的配置闪回旧值
  suppressRefill = true;
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
    if (current && standardTime) current.time = standardTime;

    // 已保存的条目不再接受在途读取结果，也不重复拉取配置
    configLoadedFor = id;
    configSavedFor = id;
    savedSnapshot.value = JSON.stringify(form);
    ElMessage.success("修改已保存");

    // 再与后端对齐：force 会先等在途的初始化拉取结束再补拉一次，
    // 保证拿到的是本次保存之后的数据，而不是初始化时的旧快照
    await memoStore.fetchMemos(true);
  } catch (error) {
    console.warn("[Detail] 保存待办失败：", error);
    ElMessage.error("保存失败，请检查后端服务");
  } finally {
    saving.value = false;
    suppressRefill = false;
  }
}

function goBack() {
  // 优先浏览器历史回退；直接刷新进入详情时没有站内历史，回总览兜底
  const historyState = window.history.state as { back?: string | null } | null;
  if (historyState?.back) {
    router.back();
    return;
  }
  router.push("/overview");
}

/* ------------------------------ 智能提醒 ------------------------------ */
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

/** 当前紧急程度对应的阶梯式提前量（跟随 form.priority 实时变化，取自公共常量） */
const suggestedReminderHours = computed<number[]>(
  () => REMINDER_ADVANCE_RULES[form.priority] ?? REMINDER_ADVANCE_RULES.low,
);

/** 页面展示用的阶梯式提醒文案：如 ["提前 24 小时", "提前 6 小时", "提前 3 小时"] */
const suggestedReminders = computed<string[]>(() =>
  suggestedReminderHours.value.map(formatAdvanceLabel),
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
    label: formatAdvanceLabel(hours),
    hours,
    removable: false,
  }));
});

watch(override, (enabled) => {
  // 回填后端配置时不要把手动列表重置成系统推荐
  if (applyingConfig) return;
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

    const prevSuggested = REMINDER_ADVANCE_RULES[prev] ?? [];
    const untouched =
      manualReminders.value.length === prevSuggested.length &&
      manualReminders.value.every((hours, index) => hours === prevSuggested[index]);

    if (untouched) manualReminders.value = [...(REMINDER_ADVANCE_RULES[next] ?? [])];
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
  // 手动提醒沿用项目「最多 6 条」的上限
  if (manualReminders.value.length >= REMINDER_MAX_COUNT) return;

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
    <header class="action-bar tw-page-head">
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
          <h1 class="tw-page-title">详情</h1>
          <p class="tw-page-subtitle">
            {{
              memo
                ? "编辑主题、时间与提醒设置"
                : "未找到该待办，可能已被删除或尚未同步"
            }}
          </p>
        </div>
      </div>

      <div class="bar-right">
        <span v-if="isDirty" class="dirty-chip tw-status-pill is-warn">有未保存的修改</span>
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
      <section class="tw-panel">
        <div class="tw-panel-head">
          <span class="tw-panel-icon">
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
          <div class="tw-panel-title-group">
            <h2 class="tw-panel-title">基础信息</h2>
            <p class="tw-panel-sub">修改后点击右上角「保存修改」生效</p>
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
      <section class="tw-panel">
        <div class="tw-panel-head">
          <span class="tw-panel-icon is-ai">
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
          <div class="tw-panel-title-group">
            <h2 class="tw-panel-title">AI 对照</h2>
            <p class="tw-panel-sub">
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
                <span class="tw-ai-badge">AI</span>
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
              <li>时间：{{ displayTime || "未记录时间" }}</li>
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
      <section class="tw-panel">
        <div class="tw-panel-head">
          <span class="tw-panel-icon is-ai">
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
          <div class="tw-panel-title-group">
            <h2 class="tw-panel-title">智能提醒</h2>
            <p class="tw-panel-sub">系统会按紧急程度自动推荐提醒节奏</p>
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
            :disabled="
              !availablePresets.length ||
              manualReminders.length >= REMINDER_MAX_COUNT
            "
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
$text: var(--app-text);
$text-muted: var(--app-text-muted);
$text-subtle: var(--app-text-subtle);

.detail-page {
  /* EP 主色 / 控件底色由 main.css 全局令牌统一提供，页面不再局部覆盖 */
  --el-text-color-regular: #{$text};
  --el-border-radius-base: var(--radius-sm);

  color: $text;
  font-size: var(--fs-base);
}

.icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

/* ---------------- 顶部操作栏：宽度/间距走 tw-page-head，本页只调对齐 ---------------- */
.action-bar {
  align-items: center;
  gap: 20px;
}

.bar-left {
  display: flex;
  gap: 14px;
}

.back-btn {
  padding: 0 8px 0 4px;
  color: $text-muted;
  font-size: var(--fs-sm);
  font-weight: 500;

  .icon {
    width: 15px;
    height: 15px;
    margin-right: 2px;
  }

  &:hover {
    color: var(--brand);
    background: transparent;
  }

  @include focus-ring;
}

.bar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 「有未保存的修改」胶囊：样式统一走 tw-status-pill is-warn */
.dirty-chip {
  flex-shrink: 0;
}

.save-btn {
  min-width: 116px;
  height: 42px;
  border: none;
  border-radius: var(--radius-md);
  font-weight: 600;
  box-shadow: 0 6px 16px -8px tint(brand, 70%);
  transition:
    transform var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);

  &:hover:not(:disabled):not(.is-disabled) {
    transform: translateY(-1px);
    box-shadow: 0 10px 22px -10px tint(brand, 80%);
  }

  &:active:not(:disabled):not(.is-disabled) {
    transform: translateY(0) scale(0.98);
  }

  /* 禁用态不抬起、不发光 */
  &:disabled,
  &.is-disabled {
    transform: none;
    box-shadow: none;
  }

  @include focus-ring;
}

/* ---------------- 卡片 ---------------- */
.content {
  max-width: var(--content-max);
  margin: 0 auto;
}

.tw-panel {
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

/* 面板头结构统一走全局 tw-panel-* */

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
  color: var(--app-text);
  font-size: var(--fs-sm);
  font-weight: 600;
  line-height: 1.4;
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

/* 底色 / 描边 / hover / focus 统一走 main.css 的全局表单规则，这里只定尺寸 */
.detail-form :deep(.el-input__wrapper),
.detail-form :deep(.el-select__wrapper) {
  min-height: 40px;
  border-radius: var(--radius-sm);
}

.detail-form :deep(.el-input__count) {
  background: transparent;
  color: $text-subtle;
}

/* 表单兜底提示：时间换算不出来 / 可留空时给一句说明，不再标红报错 */
.field-hint {
  width: 100%;
  margin-top: 6px;
  color: $text-muted;
  font-size: var(--fs-xs);
  line-height: 1.6;

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
  border-radius: var(--radius-md);
  transition:
    border-color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}

.source-col:hover {
  border-color: var(--app-text-subtle);
  box-shadow: var(--shadow-sm);
}

.summary-col:hover {
  border-color: tint(ai, 55%);
  box-shadow: 0 8px 20px -14px tint(ai, 50%);
}

.source-col {
  border: 1px solid var(--app-line);
  background: var(--chip-bg);
}

.summary-col {
  border: 1px solid tint(ai, 35%);
  background: var(--ai-soft);
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
  color: var(--app-text);
  font-size: var(--fs-sm);
  font-weight: 700;
}

.summary-col .col-title {
  color: var(--ai-text);
}

.col-meta {
  color: $text-subtle;
  font-size: var(--fs-xs);
}

.source-text {
  color: var(--app-text-muted);
  font-size: var(--fs-sm);
  line-height: 1.9;
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
  color: var(--brand);
  font-size: var(--fs-sm);
  font-weight: 600;

  .icon {
    width: 14px;
    height: 14px;
    transition: transform var(--dur) var(--ease);

    &.is-flipped {
      transform: rotate(180deg);
    }
  }

  &:hover,
  &:focus-visible {
    background: transparent;
    opacity: 0.82;
  }

  @include focus-ring;
}

.source-file {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: auto;
  padding-top: 14px;
  color: $text-subtle;
  font-size: var(--fs-xs);

  .icon {
    width: 14px;
    height: 14px;
  }
}

/* AI 徽标统一走全局 .tw-ai-badge（紫渐变身份色） */

.summary-text {
  color: var(--ai-text);
  font-size: var(--fs-base);
  font-weight: 600;
  line-height: 1.75;
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
  color: var(--app-text-muted);
  font-size: var(--fs-sm);
  line-height: 1.7;
}

.key-point-index {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  margin-top: 2px;
  border-radius: 6px;
  background: var(--ai-soft);
  color: var(--ai-text);
  font-size: var(--fs-xs);
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
  color: $text-muted;
  font-size: var(--fs-sm);
}

.summary-points {
  margin: 12px 0 0;
  padding: 0;
  list-style: none;

  li {
    position: relative;
    padding-left: 14px;
    color: var(--app-text-muted);
    font-size: var(--fs-sm);
    line-height: 1.9;

    &::before {
      content: "";
      position: absolute;
      top: 9px;
      left: 2px;
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: tint(ai, 65%);
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
  border-color: tint(ai, 35%);
  background: var(--chip-bg);
  color: var(--ai-text);
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
  color: $text-muted;
  font-size: var(--fs-sm);
}

.remind-tip {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 18px;
  padding: 12px 14px;
  border: 1px solid tint(ai, 22%);
  border-radius: var(--radius-md);
  background: tint(ai, 7%);

  .icon {
    width: 15px;
    height: 15px;
    margin-top: 3px;
    color: var(--ai);
  }

  p {
    color: var(--app-text-muted);
    font-size: var(--fs-sm);
    line-height: 1.75;
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
  color: var(--app-text);
  font-size: var(--fs-sm);
  font-weight: 600;
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
  border: 1px solid var(--app-line);
  border-radius: var(--radius-pill);
  background: var(--chip-bg);
  color: var(--app-text-muted);
  font-size: var(--fs-sm);
  transition:
    border-color var(--dur) var(--ease),
    background var(--dur) var(--ease),
    transform var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);

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
    border-color: tint(ai, 40%);
    background: tint(ai, 6%);
    color: var(--ai-text);

    .icon {
      color: var(--ai);
    }
  }
}

.chip-remove {
  margin-left: 2px;
  padding: 0 2px;
  border: none;
  background: transparent;
  color: $text-subtle;
  font-size: var(--fs-base);
  line-height: 1;
  cursor: pointer;
  transition: color var(--dur) var(--ease);

  &:hover {
    color: var(--danger);
  }

  @include focus-ring;
}

.reminder-empty {
  color: $text-muted;
  font-size: var(--fs-sm);
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
  border-radius: var(--radius-sm);
}

.remind-hint {
  margin-top: 12px;
  color: $text-subtle;
  font-size: var(--fs-xs);
}

/* ---------------- 响应式（断点统一走 _mixins 的 mobile(768px)，原 760px） ---------------- */
@include mobile {
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

  .tw-panel-head {
    flex-wrap: wrap;
  }

  .preset-select {
    flex: 1;
    width: auto;
  }

  /* 给右下角 AI 悬浮球留出高度 */
  .content {
    padding-bottom: 44px;
  }
}
</style>
