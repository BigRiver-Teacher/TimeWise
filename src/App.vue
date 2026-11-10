<script setup lang="ts">
import { onMounted, onUnmounted, watch } from "vue";
import { ElMessage } from "element-plus";
import { RouterView } from "vue-router";
import {
  Calendar,
  Clock,
  Cpu,
  DataAnalysis,
  Document,
  MagicStick,
  Notebook,
  Setting,
} from "@element-plus/icons-vue";
import AIAssistant from "@/components/AIAssistant.vue";
import { useMemoStore } from "@/stores/memo";
import { useSettingsStore } from "@/stores/settings";
import { REMINDER_ADVANCE_RULES } from "@/constants/reminder";
import { isAbsoluteTime, parseMemoTime } from "@/utils/memoTime";

/* ---------------------------- 全局任务提醒 ---------------------------- */
/** 每 60 秒检查一次 */
const CHECK_INTERVAL_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** 已提醒过的 key：`memoId_档位小时`，不同档位各自提醒一次 */
const remindedKeys = new Set<string>();
let reminderTimer: ReturnType<typeof setInterval> | undefined;
/** 权限申请只发起一次，避免每次点铃铛都弹窗 */
let permissionRequested = false;

const memoStore = useMemoStore();
const settingsStore = useSettingsStore();

/**
 * 只接受绝对时间：优先走统一解析器的绝对时间分支，
 * 其余交给 new Date()；解析不了直接跳过，绝不在轮询里重解释中文相对词。
 */
function parseDueTime(raw: string): Date | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;

  if (isAbsoluteTime(text)) return parseMemoTime(text);

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 某条任务的某个档位是否已经提醒过 */
function reminderKey(memoId: number, hours: number): string {
  return `${memoId}_${hours}`;
}

/** 清理某条任务的全部提醒记录（删除 / 负 id 换成真实 id 时调用） */
function forgetMemoReminders(memoId: number): void {
  const prefix = `${memoId}_`;
  for (const key of remindedKeys) {
    if (key.startsWith(prefix)) remindedKeys.delete(key);
  }
}

/**
 * 铃铛入口的权限引导：
 * - default → 首次点击时申请一次
 * - granted → 直接放行（正常进入提醒中心）
 * - denied → 不弹窗，只给轻提示
 * - 浏览器不支持通知 → 放行，不打断导航
 */
async function handleBellClick(event: MouseEvent): Promise<void> {
  const target = event.target as HTMLElement | null;
  if (!target?.closest('[aria-label="提醒中心"]')) return;
  if (typeof Notification === "undefined") return;

  if (Notification.permission === "granted") return;
  if (Notification.permission === "denied") {
    ElMessage.warning("请在浏览器设置中允许通知");
    return;
  }
  if (permissionRequested) return;

  permissionRequested = true;
  try {
    const result = await Notification.requestPermission();
    if (result === "denied") {
      ElMessage.warning("请在浏览器设置中允许通知");
    }
  } catch (error) {
    console.warn("[reminder] 通知权限申请失败：", error);
  }
}

/** 某个档位到点时如何提示：开关打开发系统通知，关闭则只留页面内轻提示 */
function pushReminder(title: string, hours: number): void {
  const text = `你的任务「${title}」还有不到 ${hours} 小时截止`;

  if (settingsStore.inApp && typeof Notification !== "undefined" && Notification.permission === "granted") {
    try {
      new Notification("知时 TimeWise 提醒", { body: text });
      return;
    } catch (error) {
      console.warn("[reminder] 弹出通知失败：", error);
    }
  }

  // 关闭应用内提醒 / 权限未授予 / 通知构造失败：保留页面内轻提示
  ElMessage.info(text);
}

/** 按优先级分档检查：每条任务的每个档位各自触发一次 */
function checkUpcomingMemos(): void {
  const now = Date.now();

  for (const memo of memoStore.memos) {
    if (memo.completed) continue;

    const due = parseDueTime(memo.time);
    if (!due) continue;

    const remaining = due.getTime() - now;
    if (remaining <= 0) continue;

    const tiers = REMINDER_ADVANCE_RULES[memo.priority] ?? REMINDER_ADVANCE_RULES.low;

    for (const hours of tiers) {
      const key = reminderKey(memo.id, hours);
      if (remindedKeys.has(key)) continue;
      // 还没进入这一档的提醒窗口
      if (remaining > hours * HOUR_MS) continue;

      remindedKeys.add(key);
      pushReminder(memo.title, hours);
    }
  }
}

/* ---------------------------- 背景图标鼠标视差 ---------------------------- */
/** 位移缩放：鼠标从屏幕中心移动半个屏幕，图标大约偏移 10~20px */
const PARALLAX_DIVISOR = 50;

let parallaxFrame = 0;
let parallaxX = 0;
let parallaxY = 0;
const reduceMotionQuery =
  typeof window !== "undefined"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : undefined;

/** 系统是否要求「减少动效」：是则完全不参与视差 */
function isReducedMotion(): boolean {
  return reduceMotionQuery?.matches ?? false;
}

/** 把最新位移写进 CSS 变量（一帧只写一次，避免高频重排） */
function flushParallax(): void {
  parallaxFrame = 0;
  const root = document.documentElement;
  root.style.setProperty("--mouse-x", `${parallaxX.toFixed(2)}px`);
  root.style.setProperty("--mouse-y", `${parallaxY.toFixed(2)}px`);
}

/** 鼠标移动：算出相对屏幕中心的偏移，交给 rAF 合并成一次写入 */
function handlePointerMove(event: MouseEvent): void {
  if (isReducedMotion()) return;

  parallaxX = (event.clientX - window.innerWidth / 2) / PARALLAX_DIVISOR;
  parallaxY = (event.clientY - window.innerHeight / 2) / PARALLAX_DIVISOR;

  if (parallaxFrame === 0) parallaxFrame = requestAnimationFrame(flushParallax);
}

/** 运行时切换「减少动效」偏好：立即启停视差监听 */
function handleReduceMotionChange(event: MediaQueryListEvent): void {
  if (event.matches) {
    window.removeEventListener("mousemove", handlePointerMove);
    if (parallaxFrame) {
      cancelAnimationFrame(parallaxFrame);
      parallaxFrame = 0;
    }
    parallaxX = 0;
    parallaxY = 0;
    const root = document.documentElement;
    root.style.setProperty("--mouse-x", "0px");
    root.style.setProperty("--mouse-y", "0px");
    return;
  }

  window.addEventListener("mousemove", handlePointerMove, { passive: true });
}

/**
 * 任务被删除 / 负 id 换成真实 id 后，清掉对应的已提醒记录，
 * 避免 id 复用时被旧的去重 key 挡住。
 */
watch(
  () => memoStore.memos.map((memo) => memo.id),
  (ids, previous) => {
    if (!previous) return;
    const alive = new Set(ids);
    for (const id of previous) {
      if (!alive.has(id)) forgetMemoReminders(id);
    }
  },
);

onMounted(() => {
  // 首次打开不主动申请权限，等用户点击铃铛再引导
  checkUpcomingMemos();
  reminderTimer = setInterval(checkUpcomingMemos, CHECK_INTERVAL_MS);

  // 铃铛入口的权限引导（捕获阶段，不影响原有导航行为）
  document.addEventListener("click", handleBellClick, true);

  // 背景图标视差：只有系统允许动效时才监听
  if (!isReducedMotion()) {
    // passive：不阻断页面滚动
    window.addEventListener("mousemove", handlePointerMove, { passive: true });
  }
  reduceMotionQuery?.addEventListener("change", handleReduceMotionChange);
});

onUnmounted(() => {
  // 清理定时器，避免组件卸载后继续轮询 / 内存泄漏
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = undefined;
  }

  // 清理权限引导监听、动效偏好监听
  document.removeEventListener("click", handleBellClick, true);
  reduceMotionQuery?.removeEventListener("change", handleReduceMotionChange);

  // 清理视差监听与未执行完的动画帧
  window.removeEventListener("mousemove", handlePointerMove);
  if (parallaxFrame) {
    cancelAnimationFrame(parallaxFrame);
    parallaxFrame = 0;
  }
});
</script>

<template>
  <!-- 全局漂浮图标背景层：在业务内容之下、页面背景之上，且不拦截任何点击 -->
  <div class="bg-icons-container" aria-hidden="true">
    <span class="bg-icon icon-1"><Clock /></span>
    <span class="bg-icon icon-2"><Document /></span>
    <span class="bg-icon icon-3"><Setting /></span>
    <span class="bg-icon icon-4"><Cpu /></span>
    <span class="bg-icon icon-5"><MagicStick /></span>
    <span class="bg-icon icon-6"><DataAnalysis /></span>
    <span class="bg-icon icon-7"><Calendar /></span>
    <span class="bg-icon icon-8"><Notebook /></span>
  </div>

  <RouterView />
  <AIAssistant />
</template>

<style scoped lang="scss">
.bg-icons-container {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: -1;
  pointer-events: none;
  overflow: hidden;
}

.bg-icon {
  position: absolute;
  display: block;
  color: #4f46e5;
  opacity: var(--bg-icon-opacity, 0.05);
  animation: float-1 18s ease-in-out infinite;
  will-change: transform;

  /*
   * 鼠标视差：用独立的 translate 属性而不是 transform，
   * 这样能和上面 float 动画（改的是 transform）叠加，不会互相覆盖。
   * --parallax-factor 由每个图标单独给值：大图标小、小图标大，才有远近层次。
   */
  translate: calc(var(--mouse-x, 0px) * var(--parallax-factor, 0.5))
    calc(var(--mouse-y, 0px) * var(--parallax-factor, 0.5));

  :deep(svg) {
    display: block;
    width: 100%;
    height: 100%;
  }
}

/* 位置 / 尺寸 / 颜色 / 动画各自错开，形成自然漂浮感；
   --parallax-factor 决定视差幅度：越大的图标给出越小的系数（感觉更远） */
.icon-1 {
  --parallax-factor: 0.5;
  top: 8%;
  left: 12%;
  width: 72px;
  height: 72px;
  color: #4f46e5;
  animation: float-1 18s ease-in-out infinite;
}

.icon-2 {
  --parallax-factor: 0.3;
  top: 14%;
  right: 10%;
  width: 108px;
  height: 108px;
  color: #8b5cf6;
  animation: float-2 22s ease-in-out infinite;
  animation-delay: -6s;
}

.icon-3 {
  --parallax-factor: 0.75;
  top: 38%;
  left: 5%;
  width: 56px;
  height: 56px;
  color: #10b981;
  animation: float-3 25s ease-in-out infinite;
  animation-delay: -10s;
}

.icon-4 {
  --parallax-factor: 0.25;
  top: 44%;
  right: 14%;
  width: 120px;
  height: 120px;
  color: #6366f1;
  animation: float-1 20s ease-in-out infinite;
  animation-delay: -14s;
}

.icon-5 {
  --parallax-factor: 0.4;
  bottom: 16%;
  left: 24%;
  width: 88px;
  height: 88px;
  color: #8b5cf6;
  animation: float-2 24s ease-in-out infinite;
  animation-delay: -4s;
}

.icon-6 {
  --parallax-factor: 0.6;
  right: 8%;
  bottom: 6%;
  width: 64px;
  height: 64px;
  color: #0ea5e9;
  animation: float-3 19s ease-in-out infinite;
  animation-delay: -8s;
}

.icon-7 {
  --parallax-factor: 0.85;
  top: 66%;
  left: 48%;
  width: 44px;
  height: 44px;
  color: #f59e0b;
  animation: float-1 23s ease-in-out infinite;
  animation-delay: -12s;
}

.icon-8 {
  --parallax-factor: 1;
  top: 5%;
  left: 54%;
  width: 40px;
  height: 40px;
  color: #10b981;
  animation: float-2 21s ease-in-out infinite;
  animation-delay: -2s;
}

/* 缓慢上下浮动 + 微弱旋转 */
@keyframes float-1 {
  0%,
  100% {
    transform: translateY(0) rotate(0deg);
  }

  50% {
    transform: translateY(-24px) rotate(5deg);
  }
}

@keyframes float-2 {
  0%,
  100% {
    transform: translateY(0) rotate(0deg);
  }

  50% {
    transform: translateY(20px) rotate(-6deg);
  }
}

@keyframes float-3 {
  0%,
  100% {
    transform: translate3d(0, 0, 0) rotate(0deg);
  }

  33% {
    transform: translate3d(12px, -16px, 0) rotate(4deg);
  }

  66% {
    transform: translate3d(-10px, 10px, 0) rotate(-4deg);
  }
}

/* 移动端减少几枚，避免拥挤（断点统一走 _mixins 的 mobile(768px)） */
@include mobile {
  .icon-3,
  .icon-7 {
    display: none;
  }

  .icon-2 {
    width: 84px;
    height: 84px;
  }

  .icon-4 {
    width: 92px;
    height: 92px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .bg-icon {
    animation: none;
    /* 关掉动效偏好时也不跟鼠标位移，避免视觉晃动 */
    translate: none;
  }
}
</style>
