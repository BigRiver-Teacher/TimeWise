<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
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

/* ---------------------------- 全局任务提醒 ---------------------------- */
/** 截止前 30 分钟内提醒 */
const REMIND_WINDOW_MS = 30 * 60 * 1000;
/** 每 60 秒检查一次 */
const CHECK_INTERVAL_MS = 60 * 1000;
/** 已提醒过的 memo id，避免同一任务重复弹通知 */
const remindedIds = new Set<number>();
let reminderTimer: ReturnType<typeof setInterval> | undefined;

const memoStore = useMemoStore();

/**
 * 把自由格式的 time 字段转成 Date：
 * 「2026-11-05 18:00」「11 月 20 日 23:59」「今天 18:00」「明天 09:30」「周五 16:00」
 * 无法识别出具体时间点时返回 null（例如「本周内」「下周一」）。
 */
function parseMemoTime(raw: string): Date | null {
  const text = raw.trim();
  if (!text) return null;

  // 1) 带年份的完整日期
  const full = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (full) {
    return new Date(
      Number(full[1]),
      Number(full[2]) - 1,
      Number(full[3]),
      Number(full[4] ?? 0),
      Number(full[5] ?? 0),
    );
  }

  // 2) 没有具体的「时:分」就跳过
  const clock = text.match(/(\d{1,2}):(\d{2})/);
  if (!clock) return null;

  const hour = Number(clock[1]);
  const minute = Number(clock[2]);

  const now = new Date();
  const target = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hour,
    minute,
  );

  // 3) X 月 Y 日
  const monthDay = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (monthDay) {
    target.setMonth(Number(monthDay[1]) - 1, Number(monthDay[2]));
    return target;
  }

  // 4) 相对日期
  if (text.includes("后天")) {
    target.setDate(target.getDate() + 2);
  } else if (/明[天早晚]/.test(text)) {
    target.setDate(target.getDate() + 1);
  }

  // 5) 周X / 星期X / 礼拜X
  const weekday = text.match(/(?:周|星期|礼拜)([一二三四五六日天1-7])/);
  const weekdayKey = weekday?.[1];
  if (weekdayKey) {
    const weekMap: Record<string, number> = {
      一: 1,
      二: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      日: 0,
      天: 0,
      "1": 1,
      "2": 2,
      "3": 3,
      "4": 4,
      "5": 5,
      "6": 6,
      "7": 0,
    };
    const targetDay = weekMap[weekdayKey];
    if (targetDay !== undefined) {
      target.setDate(target.getDate() + ((targetDay - now.getDay() + 7) % 7));
    }
  }

  return target;
}

/** 申请浏览器通知权限（只在还未决定时申请一次） */
async function requestNotificationPermission(): Promise<void> {
  if (typeof Notification === "undefined") {
    console.warn("[reminder] 当前浏览器不支持通知");
    return;
  }
  if (Notification.permission !== "default") return;

  try {
    await Notification.requestPermission();
  } catch (error) {
    console.warn("[reminder] 通知权限申请失败：", error);
  }
}

/** 检查一次「30 分钟内到期」的待办并弹通知 */
function checkUpcomingMemos(): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;

  const now = Date.now();

  for (const memo of memoStore.memos) {
    if (memo.completed) continue;
    if (remindedIds.has(memo.id)) continue;

    const due = parseMemoTime(memo.time);
    if (!due) continue;

    const diff = due.getTime() - now;
    // 只提醒「未来 30 分钟内（且还没过期）」的任务
    if (diff <= 0 || diff >= REMIND_WINDOW_MS) continue;

    try {
      new Notification("知时 TimeWise 提醒", {
        body: `你的任务「${memo.title}」还有不到 30 分钟截止！`,
      });
      remindedIds.add(memo.id);
    } catch (error) {
      console.warn("[reminder] 弹出通知失败：", error);
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

onMounted(() => {
  void requestNotificationPermission();
  checkUpcomingMemos();
  reminderTimer = setInterval(checkUpcomingMemos, CHECK_INTERVAL_MS);

  // 背景图标视差：只有系统允许动效时才监听
  if (!isReducedMotion()) {
    // passive：不阻断页面滚动
    window.addEventListener("mousemove", handlePointerMove, { passive: true });
  }
});

onUnmounted(() => {
  // 清理定时器，避免组件卸载后继续轮询 / 内存泄漏
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = undefined;
  }

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

/* 移动端减少几枚，避免拥挤 */
@media (max-width: 768px) {
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
