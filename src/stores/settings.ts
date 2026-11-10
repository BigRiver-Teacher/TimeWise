// src/stores/settings.ts
// 设置偏好：提醒渠道开关 + AI 解析偏好（模型档位 / 摘要长度）。
// 改动即时生效，并自动持久化到 localStorage。
import { ref, watch } from "vue";
import { defineStore } from "pinia";

/** 解析模型档位：fast = 小而快，quality = 模型更大、概括更完整 */
export type AiModelMode = "fast" | "quality";
/** 摘要长度：一句话 / 三行以内 / 完整段落 */
export type SummaryLength = "short" | "medium" | "long";

const STORAGE_KEY = "timewise-ai-settings";

interface PersistedSettings {
  aiModel: AiModelMode;
  summaryLength: SummaryLength;
  /** 应用内提醒 */
  inApp: boolean;
  /** 邮件提醒 */
  email: boolean;
  /** 每周总结 */
  weeklyDigest: boolean;
}

const DEFAULT_SETTINGS: PersistedSettings = {
  aiModel: "fast",
  summaryLength: "medium",
  inApp: true,
  email: false,
  weeklyDigest: true,
};

function isAiModel(value: unknown): value is AiModelMode {
  return value === "fast" || value === "quality";
}

function isSummaryLength(value: unknown): value is SummaryLength {
  return value === "short" || value === "medium" || value === "long";
}

/** 读取本地偏好：脏数据 / 隐私模式 / JSON 损坏都退回默认值 */
function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_SETTINGS };

    const record = parsed as Record<string, unknown>;
    return {
      aiModel: isAiModel(record.aiModel) ? record.aiModel : DEFAULT_SETTINGS.aiModel,
      summaryLength: isSummaryLength(record.summaryLength)
        ? record.summaryLength
        : DEFAULT_SETTINGS.summaryLength,
      inApp: typeof record.inApp === "boolean" ? record.inApp : DEFAULT_SETTINGS.inApp,
      email: typeof record.email === "boolean" ? record.email : DEFAULT_SETTINGS.email,
      weeklyDigest:
        typeof record.weeklyDigest === "boolean"
          ? record.weeklyDigest
          : DEFAULT_SETTINGS.weeklyDigest,
    };
  } catch (error) {
    console.warn("[settings] 读取 AI 偏好失败，已按默认值处理：", error);
    return { ...DEFAULT_SETTINGS };
  }
}

export const useSettingsStore = defineStore("settings", () => {
  const initial = loadSettings();

  /** 解析模型：fast / quality */
  const aiModel = ref<AiModelMode>(initial.aiModel);
  /** 摘要长度：short / medium / long */
  const summaryLength = ref<SummaryLength>(initial.summaryLength);
  /** 应用内提醒 */
  const inApp = ref<boolean>(initial.inApp);
  /** 邮件提醒（本期仅保存开关，不发送邮件） */
  const email = ref<boolean>(initial.email);
  /** 每周总结（本期仅保存开关，不发送邮件） */
  const weeklyDigest = ref<boolean>(initial.weeklyDigest);

  /**
   * 持久化成功计数：每次真正写入 localStorage 后自增。
   * 设置页监听它来决定是否展示「已自动保存」，写入失败时它不会变化。
   */
  const saveTick = ref(0);

  /** 任一偏好变化就写回 localStorage，设置页不需要「保存」按钮 */
  watch(
    [aiModel, summaryLength, inApp, email, weeklyDigest],
    ([model, length, nextInApp, nextEmail, nextWeekly]) => {
      try {
        const next: PersistedSettings = {
          aiModel: model,
          summaryLength: length,
          inApp: nextInApp,
          email: nextEmail,
          weeklyDigest: nextWeekly,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        saveTick.value += 1;
      } catch (error) {
        // localStorage 被禁用 / 配额已满 / 跨标签页写入冲突：
        // 保留内存状态，不抛出异常，页面继续可操作
        console.warn("[settings] 保存设置失败：", error);
      }
    },
    { flush: "post" },
  );

  /** 恢复默认值（预留给「重置」按钮用） */
  function resetSettings(): void {
    aiModel.value = DEFAULT_SETTINGS.aiModel;
    summaryLength.value = DEFAULT_SETTINGS.summaryLength;
    inApp.value = DEFAULT_SETTINGS.inApp;
    email.value = DEFAULT_SETTINGS.email;
    weeklyDigest.value = DEFAULT_SETTINGS.weeklyDigest;
  }

  return {
    aiModel,
    summaryLength,
    inApp,
    email,
    weeklyDigest,
    saveTick,
    resetSettings,
  };
});
