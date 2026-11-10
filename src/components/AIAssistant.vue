<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useMemoStore } from "@/stores/memo";
import { useUserStore } from "@/stores/user";
import { parseMemoTime } from "@/utils/memoTime";

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
/** 用户资料同样来自 Pinia：设置页改完昵称，这里实时同步 */
const userStore = useUserStore();

const isOpen = ref<boolean>(false);
const inputText = ref<string>("");
const isThinking = ref<boolean>(false);

/** 昵称读取失败（存储不可用等）时回落到默认昵称，不允许白屏 */
const userName = computed<string>(() => {
  try {
    return userStore.userName?.trim() || "何同学";
  } catch {
    return "何同学";
  }
});

/** 开场白：跟随昵称变化，不再写死 */
const greeting = computed<string>(
  () => `你好，${userName.value}！我是你的智能备忘录助手。`,
);

const messages = ref<ChatMessage[]>([
  { id: 1, role: "ai", text: greeting.value },
]);

/** 已挂载（悬浮球常驻）时改昵称，开场白也要立即更新，后续聊天记录保持不动 */
watch(greeting, (text) => {
  const first = messages.value[0];
  if (first && first.role === "ai") first.text = text;
});

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

  uncompleted.forEach((memo) => {
    const timeStr = memo.time || "";
    const title = memo.title;
    let isOverdue = false;

    // 全站统一解析：与总览 / 提醒中心 / 详情 / 全局通知共用同一个解析器，
    // 跨年、相对日期、中文数字时刻的结论天然一致
    const taskDate = parseMemoTime(timeStr);

    // 解析成功且日期早于今天 00:00 才算过期；解析不出来直接跳过，不按 0 点兜底
    if (taskDate && taskDate < todayStart) {
      isOverdue = true;
    }

    if (isOverdue) {
      overdueTasks.push(`${title}（${timeStr}）`);
    } else {
      pendingTasks.push(`${title}（${timeStr}）`);
    }
  });

  // 3. 组装最终回复
  let reply = "";

  // 编号跨分组连续递增：逾期在前、待办在后，序号与当前有效待办一一对应
  let seq = 0;

  if (overdueTasks.length > 0) {
    reply += `⚠️ 注意，你有 ${overdueTasks.length} 项任务已经过期：\n`;
    reply += overdueTasks.map((t) => `${++seq}. ${t}`).join("\n") + "\n\n";
  }

  if (pendingTasks.length > 0) {
    reply += `📌 你今天还有 ${pendingTasks.length} 项未完成：\n`;
    reply += pendingTasks.map((t) => `${++seq}. ${t}`).join("\n");
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
  background: var(--ai-gradient);
  color: #fff;
  cursor: pointer;
  box-shadow:
    0 12px 26px -12px tint(brand, 90%),
    0 2px 6px rgba(16, 24, 40, 0.14);
  transition:
    transform var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);

  /* 呼吸光环：提示 AI 助手常驻可用，展开时隐藏避免干扰 */
  &::after {
    content: "";
    position: absolute;
    inset: -3px;
    border-radius: 50%;
    border: 2px solid tint(brand, 50%);
    opacity: 0;
    pointer-events: none;
    animation: fab-ring 3s ease-out infinite;
  }

  &[aria-expanded="true"]::after {
    animation: none;
  }

  svg {
    width: 26px;
    height: 26px;
  }

  &:hover {
    transform: scale(1.08);
    box-shadow:
      0 16px 30px -12px tint(brand, 95%),
      0 4px 10px rgba(16, 24, 40, 0.16);
  }

  &:active {
    transform: scale(0.97);
  }

  @include focus-ring;
}

@keyframes fab-ring {
  0% {
    opacity: 0.55;
    transform: scale(1);
  }

  70%,
  100% {
    opacity: 0;
    transform: scale(1.45);
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
  border-radius: var(--radius-lg);
  background: var(--glass-bg);
  box-shadow: var(--glass-shadow);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
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
  background: var(--ai-gradient);
  color: #fff;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.chat-avatar {
  width: 34px;
  height: 34px;
  font-size: var(--fs-xs);
}

.chat-title-group {
  min-width: 0;
  flex: 1;
}

.chat-title {
  font-size: var(--fs-base);
  font-weight: 700;
  line-height: 1.4;
}

.chat-sub {
  margin-top: 1px;
  color: var(--app-text-muted, #79818f);
  font-size: var(--fs-xs);
}

.chat-close {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--app-text-subtle, #79818f);
  cursor: pointer;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease),
    border-color var(--dur) var(--ease);

  svg {
    width: 16px;
    height: 16px;
  }

  &:hover {
    border-color: var(--app-line, rgba(0, 0, 0, 0.08));
    background: var(--chip-bg, #f9fafb);
    color: var(--app-text, #1f2937);
  }

  @include focus-ring;
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

  /* 新消息（含思考中的点点）从底部弹入 */
  animation: rise-in 0.32s var(--ease, ease) backwards;

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
  border-radius: var(--radius-lg);
  font-size: var(--fs-sm);
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
  background: linear-gradient(135deg, var(--brand), var(--brand-hover));
  color: #fff;
  box-shadow: 0 8px 16px -12px tint(brand, 95%);
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
  color: var(--app-text-muted, #79818f);
  font-size: var(--fs-xs);
  line-height: 1.4;
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
  font-size: var(--fs-sm);
  font-weight: 500;
  line-height: 1.4;
  cursor: pointer;
  @include transition(transform, background, border-color);

  &:hover {
    transform: scale(1.04);
    border-color: tint(brand, 30%);
    background: tint(brand, 15%);
  }

  &:active {
    transform: scale(0.98);
  }

  @include focus-ring;
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
  border-radius: var(--radius-md);
  background: var(--input-bg, rgba(255, 255, 255, 0.55));
  color: var(--app-text, #1f2937);
  font-size: var(--fs-sm);
  transition:
    border-color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);

  &::placeholder {
    color: var(--app-text-subtle, #79818f);
  }

  &:hover {
    border-color: tint(brand, 40%);
  }

  &:focus {
    outline: none;
    border-color: tint(brand, 50%);
    box-shadow: 0 0 0 3px tint(brand, 14%);
  }
}

.chat-send {
  height: 38px;
  padding: 0 16px;
  border: none;
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, var(--brand), var(--brand-hover));
  color: #fff;
  font-size: var(--fs-sm);
  font-weight: 600;
  cursor: pointer;
  transition:
    opacity var(--dur) var(--ease),
    transform var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);

  &:not(:disabled):hover {
    transform: translateY(-1px);
    box-shadow: 0 8px 18px -10px tint(brand, 90%);
  }

  &:active:not(:disabled) {
    transform: translateY(0) scale(0.98);
  }

  /* 禁用态不抬起、不发光 */
  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
  }

  @include focus-ring;
}

/* ---------------- 移动端：避开底部导航栏（断点统一走 mobile(768px)） ---------------- */
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
    max-height: calc(100vh - 190px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .fab,
  .chat-send {
    transition: none;
  }

  .fab::after {
    animation: none;
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
