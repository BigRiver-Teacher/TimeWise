<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
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

/* ------------------------------ 猜你想问 ------------------------------ */
/** 快捷提问文案：点一下就等于手打这句并发送 */
const quickQuestions: string[] = ["今天还有哪些任务？", "我还有哪些任务没完成？"];

/** 只在「还没聊起来」时展示：AI 开场白之后、用户第一次发言之前 */
const showQuickAsk = computed<boolean>(
  () => messages.value.length <= 1 && !isThinking.value,
);

/** 点击胶囊：填进输入框后直接走原有的发送逻辑 */
function handleQuickAsk(question: string): void {
  if (isThinking.value) return;

  inputText.value = question;
  sendMessage();
  void scrollToBottom();
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

        <!-- 猜你想问：还没发过消息时出现，点一下就直接发送 -->
        <div v-if="showQuickAsk" class="quick-ask">
          <p class="quick-ask-label">猜你想问</p>
          <div class="quick-ask-chips">
            <button
              v-for="question in quickQuestions"
              :key="question"
              type="button"
              class="quick-chip"
              @click="handleQuickAsk(question)"
            >
              {{ question }}
            </button>
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
$brand: #4f46e5;
$brand-deep: #4338ca;
$ai: #8b5cf6;

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
  border-radius: 50%;
  background: linear-gradient(135deg, #7c6cf0, $brand 55%, $ai);
  color: #fff;
  cursor: pointer;
  box-shadow:
    0 12px 26px -12px rgba($brand, 0.9),
    0 2px 6px rgba(16, 24, 40, 0.14);
  transition:
    transform 0.25s cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow 0.25s ease;

  svg {
    width: 26px;
    height: 26px;
  }

  &:hover {
    transform: scale(1.08);
    box-shadow:
      0 16px 30px -12px rgba($brand, 0.95),
      0 4px 10px rgba(16, 24, 40, 0.16);
  }

  &:active {
    transform: scale(0.97);
  }

  &:focus-visible {
    outline: 3px solid rgba($brand, 0.45);
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
  max-height: calc(100vh - 160px);
  border: 1px solid var(--glass-border);
  border-radius: 18px;
  background: var(--glass-bg);
  box-shadow: var(--glass-shadow);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  overflow: hidden;
  transform-origin: bottom right;
  color: var(--app-text, #1f2937);
}

/* 平滑弹出 / 收起 */
.chat-pop-enter-active,
.chat-pop-leave-active {
  transition:
    opacity 0.26s ease,
    transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
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
  gap: 10px;
  flex-shrink: 0;
  padding: 13px 14px;
  border-bottom: 1px solid var(--app-line, rgba(0, 0, 0, 0.08));
}

.chat-avatar,
.bubble-avatar {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  border-radius: 50%;
  background: linear-gradient(135deg, $ai, $brand);
  color: #fff;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.chat-avatar {
  width: 34px;
  height: 34px;
  font-size: 11.5px;
}

.chat-title-group {
  min-width: 0;
  flex: 1;
}

.chat-title {
  font-size: 13.5px;
  font-weight: 700;
  line-height: 1.4;
}

.chat-sub {
  margin-top: 1px;
  font-size: 11.5px;
  color: var(--app-text-subtle, #79818f);
}

.chat-close {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--app-text-subtle, #79818f);
  cursor: pointer;
  transition:
    background 0.2s ease,
    color 0.2s ease,
    border-color 0.2s ease;

  svg {
    width: 16px;
    height: 16px;
  }

  &:hover {
    border-color: var(--app-line, rgba(0, 0, 0, 0.08));
    background: var(--chip-bg, #f9fafb);
    color: var(--app-text, #1f2937);
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
  font-size: 9.5px;
}

.bubble {
  max-width: 78%;
  padding: 9px 12px;
  border-radius: 14px;
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.is-ai .bubble {
  border: 1px solid var(--app-line, rgba(0, 0, 0, 0.08));
  border-bottom-left-radius: 4px;
  background: var(--chip-bg, #f9fafb);
  color: var(--app-text, #1f2937);
}

.is-user .bubble {
  border-bottom-right-radius: 4px;
  background: linear-gradient(135deg, #6d63f0, $brand-deep);
  color: #fff;
  box-shadow: 0 8px 16px -12px rgba($brand, 0.95);
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
    border-radius: 50%;
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

/* ---------------- 猜你想问 ---------------- */
.quick-ask {
  flex-shrink: 0;
  padding: 0 14px 10px;
}

.quick-ask-label {
  margin-bottom: 6px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--app-text-subtle, #79818f);
}

.quick-ask-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.quick-chip {
  padding: 6px 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-pill, 999px);
  background: var(--brand-soft, #eef2ff);
  color: var(--brand, #4f46e5);
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.4;
  cursor: pointer;
  @include transition(transform, background, border-color);

  &:hover {
    transform: scale(1.04);
    border-color: rgba($brand, 0.3);
    background: rgba($brand, 0.15);
  }

  &:active {
    transform: scale(0.98);
  }

  &:focus-visible {
    outline: 2px solid rgba($brand, 0.45);
    outline-offset: 2px;
  }
}

/* ---------------- 输入区 ---------------- */
.chat-input {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  padding: 12px 14px 14px;
  border-top: 1px solid var(--app-line, rgba(0, 0, 0, 0.08));
}

.chat-field {
  flex: 1;
  min-width: 0;
  height: 38px;
  padding: 0 12px;
  border: 1px solid var(--app-line, rgba(0, 0, 0, 0.1));
  border-radius: 10px;
  background: var(--input-bg, rgba(255, 255, 255, 0.55));
  color: var(--app-text, #1f2937);
  font-size: 13px;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease;

  &::placeholder {
    color: var(--app-text-subtle, #79818f);
  }

  &:focus {
    outline: none;
    border-color: rgba($brand, 0.5);
    box-shadow: 0 0 0 3px rgba($brand, 0.14);
  }
}

.chat-send {
  height: 38px;
  padding: 0 16px;
  border: none;
  border-radius: 10px;
  background: linear-gradient(135deg, #6d63f0, $brand);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition:
    opacity 0.2s ease,
    transform 0.2s ease,
    box-shadow 0.2s ease;

  &:not(:disabled):hover {
    transform: translateY(-1px);
    box-shadow: 0 8px 18px -10px rgba($brand, 0.9);
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  &:focus-visible {
    outline: 2px solid rgba($brand, 0.45);
    outline-offset: 2px;
  }
}

/* ---------------- 移动端：避开底部导航栏 ---------------- */
@media (max-width: 768px) {
  .fab {
    right: 16px;
    bottom: 76px;
    width: 52px;
    height: 52px;

    svg {
      width: 24px;
      height: 24px;
    }
  }

  .chat-panel {
    right: 12px;
    bottom: 138px;
    left: 12px;
    width: auto;
    height: 460px;
    max-height: calc(100vh - 190px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .fab,
  .chat-send {
    transition: none;
  }

  .chat-pop-enter-active,
  .chat-pop-leave-active {
    transition: opacity 0.2s ease;
  }

  .chat-pop-enter-from,
  .chat-pop-leave-to {
    transform: none;
  }

  .bubble--typing i {
    animation: none;
  }
}
</style>
