<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { useMemoStore } from "@/stores/memo";

/** 聊天消息：role 决定气泡在左（AI）还是右（用户） */
interface ChatMessage {
  id: number;
  role: "ai" | "user";
  text: string;
}

const REST_REPLY = "喝杯水休息一下吧！";
const FALLBACK_REPLY =
  "我还在学习如何回答这个问题，等接入本地大模型后我就更聪明啦！";

/** 待办数据来自 Pinia，首页保存的条目这里能直接读到 */
const memoStore = useMemoStore();

const isOpen = ref<boolean>(false);
const inputText = ref<string>("");
const isThinking = ref<boolean>(false);

const messages = ref<ChatMessage[]>([
  { id: 1, role: "ai", text: "你好，何同学！我是你的智能备忘录助手。" },
]);

const listRef = ref<HTMLDivElement>();
let nextId = 2;
let replyTimer: ReturnType<typeof setTimeout> | undefined;

/** 读取 Pinia 里的待办，过滤掉已完成的，拼成一段文字回复 */
function buildTodoReply(): string {
  const memos = memoStore.memos || [];

  // 1. 过滤掉已经打勾完成的任务
  const uncompleted = memos.filter((memo) => !memo.completed);

  // 2. 获取当前时间（只精确到天）
  const now = new Date();
  // 把今天的时间格式化为 YYYY-MM-DD 并设为 00:00:00
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const overdueTasks: string[] = [];
  const pendingTasks: string[] = [];

  uncompleted.forEach((memo, index) => {
    const timeStr = memo.time || "";
    const title = memo.title;
    let isOverdue = false;

    // 【核心逻辑】尝试从字符串中提取日期
    // 匹配格式1：2026-10-31 或 2026/10/31
    const standardMatch = timeStr.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    // 匹配格式2：10月31日
    const chineseMatch = timeStr.match(/(\d{1,2})月(\d{1,2})日/);

    let taskDate: Date | null = null;

    if (standardMatch) {
      taskDate = new Date(
        parseInt(standardMatch[1]!),
        parseInt(standardMatch[2]!) - 1,
        parseInt(standardMatch[3]!),
      );
    } else if (chineseMatch) {
      // 如果只有月日，默认用今年的年份
      taskDate = new Date(
        now.getFullYear(),
        parseInt(chineseMatch[1]!) - 1,
        parseInt(chineseMatch[2]!),
      );
    }

    // 如果成功解析出了日期，且日期早于今天，就算过期
    if (taskDate && taskDate < todayStart) {
      isOverdue = true;
    }

    if (isOverdue) {
      overdueTasks.push(`${title}（${timeStr}）`);
    } else {
      pendingTasks.push(`${index + 1}. ${title}（${timeStr}）`);
    }
  });

  // 3. 组装最终回复
  let reply = "";

  if (overdueTasks.length > 0) {
    reply += `⚠️ 注意，你有 ${overdueTasks.length} 项任务已经过期：\n`;
    reply += overdueTasks.map((t, i) => `${i + 1}. ${t}`).join("\n") + "\n\n";
  }

  if (pendingTasks.length > 0) {
    reply += `📌 你今天还有 ${pendingTasks.length} 项未完成：\n`;
    reply += pendingTasks.join("\n");
  }

  if (uncompleted.length === 0) {
    return "你今天没有未完成的待办，可以安心休息一下～";
  }

  return reply;
}

/** 关键词 → 回复内容
 *  情绪词优先：像「今天好累」这种既含「今天」又含「累」的输入，
 *  更该得到安慰而不是一份待办清单。 */
function replyFor(text: string): string {
  if (/累|辛苦/.test(text)) return REST_REPLY;
  if (/今天|任务|没完成/.test(text)) return buildTodoReply();
  return FALLBACK_REPLY;
}

/** 等 DOM 更新后滚到底部 */
async function scrollToBottom(): Promise<void> {
  await nextTick();
  const el = listRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

/** 发送消息：先上屏用户消息，800ms 后追加 AI 回复 */
function sendMessage(): void {
  const text = inputText.value.trim();
  if (!text || isThinking.value) return;

  messages.value.push({ id: nextId, role: "user", text });
  nextId += 1;
  inputText.value = "";
  isThinking.value = true;
  void scrollToBottom();

  replyTimer = setTimeout(() => {
    messages.value.push({ id: nextId, role: "ai", text: replyFor(text) });
    nextId += 1;
    isThinking.value = false;
    void scrollToBottom();
  }, 800);
}

function togglePanel(): void {
  isOpen.value = !isOpen.value;
  if (isOpen.value) void scrollToBottom();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && isOpen.value) isOpen.value = false;
}

onMounted(() => window.addEventListener("keydown", onKeydown));

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  if (replyTimer) clearTimeout(replyTimer);
  replyTimer = undefined;
});
</script>

<template>
  <div class="ai-assistant">
    <!-- 聊天窗口 -->
    <Transition name="chat-pop">
      <section
        v-if="isOpen"
        class="chat-panel"
        role="dialog"
        aria-modal="true"
        aria-label="AI 助手对话"
      >
        <header class="chat-head">
          <span class="chat-avatar">AI</span>
          <div class="chat-title-group">
            <p class="chat-title">智能备忘录助手</p>
            <p class="chat-sub">在线 · 随时可以问我今天的安排</p>
          </div>
          <button
            type="button"
            class="chat-close"
            aria-label="关闭对话"
            @click="togglePanel"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="m7 7 10 10M17 7 7 17"
                stroke="currentColor"
                stroke-width="1.9"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </header>

        <div ref="listRef" class="chat-list" aria-live="polite">
          <div
            v-for="message in messages"
            :key="message.id"
            class="chat-row"
            :class="`is-${message.role}`"
          >
            <span v-if="message.role === 'ai'" class="bubble-avatar">AI</span>
            <p class="bubble">{{ message.text }}</p>
          </div>

          <!-- 思考中 -->
          <div v-if="isThinking" class="chat-row is-ai">
            <span class="bubble-avatar">AI</span>
            <p class="bubble bubble--typing" aria-label="AI 正在输入">
              <i></i><i></i><i></i>
            </p>
          </div>
        </div>

        <form class="chat-input" @submit.prevent="sendMessage">
          <input
            v-model="inputText"
            class="chat-field"
            type="text"
            placeholder="比如：今天还有哪些任务？"
            aria-label="输入消息"
          />
          <button
            class="chat-send"
            type="submit"
            :disabled="!inputText.trim() || isThinking"
          >
            发送
          </button>
        </form>
      </section>
    </Transition>

    <!-- 悬浮球 -->
    <button
      type="button"
      class="fab"
      :aria-expanded="isOpen"
      :aria-label="isOpen ? '收起 AI 助手' : '打开 AI 助手'"
      @click="togglePanel"
    >
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 3.2 13.9 9l5.6 1.9-5.6 1.9L12 18.5l-1.9-5.7L4.5 10.9 10.1 9Z"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
        />
        <path
          d="M18.4 15.4l.8 2.3 2.3.8-2.3.8-.8 2.3-.8-2.3-2.3-.8 2.3-.8Z"
          fill="currentColor"
          opacity=".7"
        />
      </svg>
    </button>
  </div>
</template>

<style scoped lang="scss">
/* ---------------- 悬浮球 ---------------- */
.fab {
  position: fixed;
  right: 30px;
  bottom: 30px;
  z-index: 1100;
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: var(--ai-gradient);
  color: var(--el-color-white);
  cursor: pointer;
  box-shadow: var(--shadow-brand), var(--shadow-sm);
  transition:
    transform 0.25s var(--ease),
    box-shadow 0.25s var(--ease);

  svg {
    width: 26px;
    height: 26px;
  }

  &:hover {
    transform: scale(1.08);
    box-shadow: var(--shadow-brand), var(--shadow-hover);
  }

  &:active {
    transform: scale(0.97);
  }

  &:focus-visible {
    outline-width: 3px;
    outline-offset: 3px;
  }
}

/* ---------------- 弹窗 ---------------- */
.chat-panel {
  position: fixed;
  right: 30px;
  bottom: 100px;
  z-index: 1101;
  display: flex;
  flex-direction: column;
  width: 360px;
  height: 520px;
  max-height: calc(100dvh - 160px);
  overflow: hidden;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  background: var(--glass-bg-strong);
  box-shadow: var(--glass-shadow), var(--shadow-hover);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  transform-origin: bottom right;
  color: var(--app-text);
}

/* 平滑弹出 / 收起 */
.chat-pop-enter-active,
.chat-pop-leave-active {
  transition:
    opacity 0.26s ease,
    transform 0.28s var(--ease);
}

.chat-pop-enter-from,
.chat-pop-leave-to {
  opacity: 0;
  transform: translateY(14px) scale(0.94);
}

/* ---------------- 头部 ---------------- */
.chat-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  padding: 12px 16px;
  border-bottom: 1px solid var(--app-line-soft);
}

.chat-avatar,
.bubble-avatar {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  border-radius: var(--radius-pill);
  background: var(--ai-gradient);
  color: var(--el-color-white);
  font-weight: 700;
  letter-spacing: 0.02em;
}

.chat-avatar {
  width: 36px;
  height: 36px;
  font-size: var(--fs-xs);
}

.chat-title-group {
  min-width: 0;
  flex: 1;
}

.chat-title {
  font-size: var(--fs-md);
  font-weight: 600;
  line-height: 1.4;
}

.chat-sub {
  margin-top: 1px;
  font-size: var(--fs-xs);
  color: var(--app-text-subtle);
}

.chat-close {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--app-text-subtle);
  cursor: pointer;
  @include transition(background, color, border-color);

  svg {
    width: 16px;
    height: 16px;
  }

  &:hover,
  &:focus-visible {
    border-color: var(--app-line);
    background: var(--chip-bg);
    color: var(--app-text);
  }

  &:active {
    transform: scale(0.96);
  }
}

/* ---------------- 消息列表 ---------------- */
.chat-list {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  padding: 16px 14px;
  overflow-y: auto;
  scroll-behavior: smooth;
  overscroll-behavior: contain;
}

.chat-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  max-width: 100%;

  &.is-user {
    justify-content: flex-end;
  }
}

.bubble-avatar {
  width: 24px;
  height: 24px;
  font-size: var(--fs-xs);
}

.bubble {
  max-width: 78%;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  font-size: var(--fs-sm);
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.is-ai .bubble {
  border: 1px solid tint(ai, 22%);
  border-bottom-left-radius: var(--radius-sm);
  background: var(--ai-soft);
  color: var(--app-text);
  box-shadow: var(--shadow-sm);
}

.is-user .bubble {
  border: 1px solid tint(brand, 22%);
  border-bottom-right-radius: var(--radius-sm);
  background: var(--brand-soft);
  color: var(--app-text);
  box-shadow: var(--shadow-sm);
}

/* 思考中的三个点 */
.bubble--typing {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 12px;

  i {
    width: 6px;
    height: 6px;
    border-radius: var(--radius-pill);
    background: currentColor;
    opacity: 0.45;
    animation: typing-bounce 1.1s ease-in-out infinite;

    &:nth-child(2) {
      animation-delay: 0.15s;
    }

    &:nth-child(3) {
      animation-delay: 0.3s;
    }
  }
}

@keyframes typing-bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.4;
  }

  30% {
    transform: translateY(-4px);
    opacity: 0.9;
  }
}

/* ---------------- 输入区 ---------------- */
.chat-input {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  padding: 12px 16px 16px;
  border-top: 1px solid var(--app-line-soft);
}

.chat-field {
  flex: 1;
  min-width: 0;
  height: 38px;
  padding: 0 12px;
  border: 1px solid var(--app-line);
  border-radius: var(--radius-sm);
  background: var(--input-bg);
  color: var(--app-text);
  font-size: var(--fs-sm);
  @include transition(border-color, box-shadow);

  &::placeholder {
    color: var(--app-text-subtle);
  }

  &:hover {
    border-color: tint(brand, 40%);
  }

  &:focus {
    outline: none;
    border-color: var(--brand);
    box-shadow: 0 0 0 3px tint(brand, 14%);
  }
}

.chat-send {
  height: 38px;
  padding: 0 16px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--ai-gradient);
  color: var(--el-color-white);
  font-size: var(--fs-sm);
  font-weight: 600;
  cursor: pointer;
  @include transition(opacity, transform, box-shadow);

  &:not(:disabled):hover {
    transform: translateY(-1px);
    box-shadow: var(--shadow-brand);
  }

  &:not(:disabled):active {
    transform: translateY(0) scale(0.98);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

/* ---------------- 移动端：避开底部导航栏和安全区 ---------------- */
@include mobile {
  .fab {
    right: 16px;
    bottom: calc(76px + env(safe-area-inset-bottom));
    width: 52px;
    height: 52px;

    svg {
      width: 24px;
      height: 24px;
    }
  }

  .chat-panel {
    right: 12px;
    bottom: calc(138px + env(safe-area-inset-bottom));
    left: 12px;
    width: auto;
    height: 460px;
    max-height: calc(100dvh - 190px - env(safe-area-inset-bottom));
  }
}

@media (prefers-reduced-motion: reduce) {
  .chat-pop-enter-from,
  .chat-pop-leave-to {
    transform: none;
  }

  .bubble--typing i {
    animation: none;
  }
}
</style>
