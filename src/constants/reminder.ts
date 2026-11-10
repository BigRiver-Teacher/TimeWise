// src/constants/reminder.ts
// 提前量规则：全局唯一的提醒阶梯定义。
// App.vue 的通知轮询、提醒中心、条目详情都从这里取值，禁止在页面里硬编码阶梯值。
import type { MemoPriority } from "@/stores/memo";

/**
 * 各紧急程度的提醒档位（小时，由远到近）。
 * 每个档位独立触发一次提醒，同一档位不重复弹窗。
 */
export const REMINDER_ADVANCE_RULES: Record<MemoPriority, number[]> = {
  high: [24, 6, 3],
  medium: [6, 3],
  low: [3],
};

/** 提前量 → 文案："提前 24 小时" */
export function formatAdvanceLabel(hours: number): string {
  return `提前 ${hours} 小时`;
}

/** 优先级 → 档位文案数组，如 ["提前 24 小时", "提前 6 小时", "提前 3 小时"] */
export function advanceLabelsFor(priority: MemoPriority): string[] {
  return REMINDER_ADVANCE_RULES[priority].map(formatAdvanceLabel);
}

/** 优先级 → 一句话说明，如 "提前 24 / 6 / 3 小时提醒" */
export function advanceSummaryFor(priority: MemoPriority): string {
  return `提前 ${REMINDER_ADVANCE_RULES[priority].join(" / ")} 小时提醒`;
}
