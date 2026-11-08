<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import type { UploadFile, UploadUserFile } from "element-plus";
import { useMemoStore } from "@/stores/memo";
import { useSettingsStore } from "@/stores/settings";
import { toDateKey, toStandardTime } from "@/utils/memoTime";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import mammoth from "mammoth";

// pdf.js 的 worker 交给 Vite 以 URL 形式打包，避免写死资源路径
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** AI 处理步骤：进度条推进时同步高亮当前步骤 */
const steps = [
  { title: "文档读取", desc: "从 PDF / Word / 图片中提取文字内容" },
  { title: "本地 AI 理解", desc: "本地大模型阅读文本并抽取任务要素" },
  { title: "结构化输出", desc: "校验并补全标题、时间、优先级与摘要" },
];

/** 文本输入 */
const noticeText = ref("");
/** 上传的图片 / 文档（auto-upload 关闭，纯前端演示） */
const fileList = ref<UploadUserFile[]>([]);

/* ---------------------------- 文件内容提取 ---------------------------- */
type SourceKind = "pdf" | "docx" | "doc" | "image" | "text";
type ExtractStatus = "idle" | "reading" | "ready" | "error";
type Priority = "high" | "medium" | "low";

interface ExtractedSource {
  kind: SourceKind;
  name: string;
  /** pdf / docx / txt 为纯文本，图片为 Base64 data URL */
  content: string;
  /** 纯文本字符数，图片记 0 */
  chars: number;
  /** 仅图片：Base64 data URL */
  base64: string;
  /** 列表里的截断预览 */
  preview: string;
}

interface ParseSourceInfo {
  kind: SourceKind;
  name: string;
  chars: number;
}

/** 本地模型返回并补全后的结构化结果（points / tags 由模型字段派生，供模板复用） */
interface ParsedMemo {
  title: string;
  time: string;
  priority: Priority;
  type: string;
  aiSummary: string;
  /** AI 提炼的 2-4 条要点，随条目入库，详情页「AI 智能概括」下方展示 */
  keyPoints: string[];
  points: string[];
  tags: string[];
}

/** 本地 Ollama 配置 */
const OLLAMA_ENDPOINT = "http://localhost:11434/api/generate";
const OLLAMA_CHAT_ENDPOINT = "http://localhost:11434/api/chat";
/** 快速模式用的轻量文本模型 */
const OLLAMA_MODEL_FAST = "qwen2.5:0.5b";
/** 精准模式用的完整文本模型（也是 fast 模型缺失时的兜底） */
const OLLAMA_MODEL_QUALITY = "qwen2.5:3b";
/** 视觉模型（图片走 /api/chat 的 images 通道） */
const OLLAMA_VISION_MODEL = "qwen2.5vl:3b";
/** 首次请求要加载本地模型，留足超时时间 */
const OLLAMA_TIMEOUT = 90_000;
/** 视觉模型还要做图像编码，给更长的超时 */
const OLLAMA_VISION_TIMEOUT = 180_000;

const priorityMeta: Record<Priority, { label: string; color: string }> = {
  high: { label: "高", color: "var(--prio-high)" },
  medium: { label: "中", color: "var(--prio-mid)" },
  low: { label: "低", color: "var(--prio-low)" },
};

const extracted = ref<ExtractedSource | null>(null);
const extractStatus = ref<ExtractStatus>("idle");
const extractError = ref("");
/** 当前正在解析的文件名（解析中还没结果时可读） */
const activeName = ref("");
/** 本次解析的数据来源 */
const parseSource = ref<ParseSourceInfo | null>(null);
/** 解析完成后的结构化结果 */
const parseResult = ref<ParsedMemo | null>(null);

/**
 * 文本通道的最终内容：文档提取结果 + 文本框补充说明。
 * - 两者都有 → 拼成一段，标明哪部分是用户补充、哪部分是文档内容
 * - 只有其中之一 → 就发那一项
 * - 图片走视觉通道，这里只返回补充说明（图片内容以 Base64 单独传）
 */
const extractedText = computed<string>(() => {
  const source = extracted.value;
  const notice = noticeText.value.trim();
  const fileText =
    source && source.kind !== "image" ? source.content.trim() : "";

  if (notice && fileText) {
    return `用户补充说明：${notice}\n\n提取的文档内容：${fileText}`;
  }
  if (fileText) return fileText;
  return notice;
});

const extractStatusText = computed<string>(() => {
  if (extractStatus.value === "reading")
    return "正在解析「" + activeName.value + "」…";
  if (extractStatus.value === "error")
    return extractError.value || "文件解析失败";

  const source = extracted.value;
  if (extractStatus.value === "ready" && source) {
    if (source.kind === "image") {
      const kb = Math.max(1, Math.round((source.base64.length * 0.75) / 1024));
      return "已将「" + source.name + "」转换为 Base64 · " + kb + " KB";
    }
    return "已从「" + source.name + "」提取 " + source.chars + " 字";
  }
  return "";
});

/** 按扩展名 / MIME 判断文件类型 */
function detectKind(file: File): SourceKind {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
  if (name.endsWith(".docx")) return "docx";
  // .doc 是老版二进制格式，浏览器里没有可靠解析库，交给本地后端处理
  if (name.endsWith(".doc")) return "doc";
  if (file.type.startsWith("image/")) return "image";
  return "text";
}

/** PDF：用 pdfjs-dist 提取前 N 页的纯文本 */
async function extractPdfText(file: File, maxPages: number): Promise<string> {
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;
  try {
    const pageCount = Math.min(pdf.numPages, maxPages);
    const pages: string[] = [];

    for (let pageNo = 1; pageNo <= pageCount; pageNo += 1) {
      const page = await pdf.getPage(pageNo);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (pageText) pages.push(pageText);
      page.cleanup();
    }

    if (!pages.length) throw new Error("PDF 里没有可提取的文字，可能是扫描件");
    return pages.join("\n");
  } finally {
    await loadingTask.destroy();
  }
}

/** DOCX：用 mammoth 提取纯文本 */
async function extractDocxText(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  const text = result.value.replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new Error("文档里没有可提取的文字");
  return text;
}

/** 本地后端地址（.doc 解析依赖 Node 端的 word-extractor） */
const API_BASE = "http://localhost:3000/api";

/** DOC（Word 97-2003）：浏览器端没有可靠解析库，交给本地后端提取纯文本 */
async function extractDocText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();

  const response = await fetch(`${API_BASE}/extract-doc`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: buffer,
  });

  if (!response.ok) {
    let detail = ".doc 解析失败，请确认本地后端已启动";
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload && payload.error) detail = payload.error;
    } catch {
      // 后端没返回 JSON 时保留默认文案
    }
    throw new Error(detail);
  }

  const data = (await response.json()) as { text?: string };
  const text = typeof data.text === "string" ? data.text.trim() : "";
  if (!text) throw new Error(".doc 里没有可提取的文字");
  return text;
}

/** 图片压缩：宽度上限（超过则等比缩放）与 JPEG 输出质量 */
const IMAGE_MAX_WIDTH = 1024;
const IMAGE_JPEG_QUALITY = 0.8;

/** objectURL → HTMLImageElement */
function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片读取失败"));
    image.src = src;
  });
}

/**
 * 图片 → Base64（先用 Canvas 压缩）：
 * 1. 宽度超过 1024px 时等比缩放到 1024px；
 * 2. 统一以 JPEG(quality 0.8) 输出 data URL，显著减小传输体积与模型耗时。
 */
async function readImageAsBase64(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await loadImageElement(objectUrl);

    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    if (!sourceWidth || !sourceHeight) throw new Error("无法读取图片尺寸");

    // 只有超过上限才缩放，否则保持原尺寸（但仍转 JPEG 降低体积）
    const scale =
      sourceWidth > IMAGE_MAX_WIDTH ? IMAGE_MAX_WIDTH / sourceWidth : 1;
    const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
    const targetHeight = Math.max(1, Math.round(sourceHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器不支持 Canvas 压缩");

    // PNG 的透明区域转成 JPEG 会变黑，先铺一层白底
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, targetWidth, targetHeight);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, targetWidth, targetHeight);

    const dataUrl = canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY);
    if (!dataUrl.startsWith("data:image/jpeg")) {
      throw new Error("图片压缩失败");
    }

    const compressedKb = Math.round(
      ((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75) / 1024,
    );
    console.info(
      "[Input] 图片已压缩：",
      Math.round(file.size / 1024) + "KB → " + compressedKb + "KB",
      `(${sourceWidth}×${sourceHeight} → ${targetWidth}×${targetHeight})`,
    );

    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** el-upload 的 on-change：选完文件立刻开始提取 */
function handleUploadChange(uploadFile: UploadFile): void {
  void processUpload(uploadFile);
}

async function processUpload(uploadFile: UploadFile): Promise<void> {
  const raw = uploadFile.raw;
  if (!raw) return;

  activeName.value = raw.name;
  parseResult.value = null;
  isDone.value = false;

  const kind = detectKind(raw);

  extractStatus.value = "reading";
  extractError.value = "";

  try {
    let content = "";
    let chars = 0;
    let base64 = "";

    if (kind === "pdf") {
      content = await extractPdfText(raw, 3);
      chars = content.length;
    } else if (kind === "docx") {
      content = await extractDocxText(raw);
      chars = content.length;
    } else if (kind === "doc") {
      content = await extractDocText(raw);
      chars = content.length;
    } else if (kind === "image") {
      base64 = await readImageAsBase64(raw);
      content = base64;
    } else {
      content = (await raw.text()).trim();
      chars = content.length;
      if (!content) throw new Error("文件内容为空");
    }

    const source: ExtractedSource = {
      kind,
      name: raw.name,
      content,
      chars,
      base64,
      preview: "",
    };
    source.preview = base64
      ? base64.slice(0, 64) + "…"
      : content.length > 140
        ? content.slice(0, 140) + "…"
        : content;

    extracted.value = source;
    extractStatus.value = "ready";

    // 只做文本提取，不自动请求 AI：
    // 用户可以在文本框里补一句说明，再手动点底部「开始智能解析」触发解析
    // void startParse();
  } catch (error) {
    extracted.value = null;
    extractStatus.value = "error";
    extractError.value =
      error instanceof Error ? error.message : "文件解析失败";
  }
}

/* ---------------------------- 解析状态机（本地 Ollama） ---------------------------- */
const isProcessing = ref(false);
const isDone = ref(false);
/** 0 - 100，向 progressTarget 平滑逼近 */
const progress = ref(0);
/** 阶段：读取文档 → 请求本地模型 → 完成 */
type ParseStage = "idle" | "reading" | "thinking" | "done";
const parseStage = ref<ParseStage>("idle");
/** 进度条目标值：读取 28% → 等待模型时爬到 92% → 完成 100% */
const progressTarget = ref(0);

let progressTimer: ReturnType<typeof setInterval> | undefined;
let fetchController: AbortController | undefined;
/** 每次解析的递增标记：卸载或重新解析时让旧请求的结果失效 */
let parseRunId = 0;

function stopProgressLoop() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = undefined;
}

function startProgressLoop() {
  stopProgressLoop();
  progressTimer = setInterval(() => {
    if (progress.value < progressTarget.value) {
      progress.value = Math.min(progressTarget.value, progress.value + 2);
    }
  }, 70);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 优先级判定规则：文本通道与视觉通道共用同一份，避免两处规则漂移。
 * 关键是把「什么情况才算 high」写死：有触发词或 24 小时内截止；
 * 其余按有无明确时间分到 medium / low，避免模型无脑全输出 high。
 */
const PRIORITY_RULE = `【优先级判定规则】（请严格逐条比对，不要默认输出 "high"）：
1. "high"：仅当满足其一才输出——① 原文出现「截止」「截止时间」「紧急」「马上」「立刻」「尽快」「今天之内」「今晚之前」等紧急字眼；② 截止时间距离现在不足 24 小时。
2. "medium"：有明确的时间或日期，但不紧迫。例如普通通知、常规作业、比赛报名、会议安排、材料提交等。
3. "low"：长期规划、需要长期推进、没有明确时间限制，或只是「有空再看」一类的待办。
判定顺序：先看截止时间 → 再看措辞。若既没有紧急字眼、又无法确定时间在 24 小时内，禁止输出 "high"。`;

/**
 * 时间字段的硬性要求：文本通道与视觉通道共用。
 * 模型容易把「明天3点」概括成「近期」这类模糊词，导致前端解析不出时间。
 */
const TIME_WARNING = `【时间提取警告】：如果原文写的是「后天下午」「明天3点」，请务必原样提取到 time 字段中。绝对不要自己概括成「本周末前」「近期」这种模糊词汇！`;

/* ---------------------------- AI 解析偏好（来自设置页） ---------------------------- */
const settingsStore = useSettingsStore();

/** 按设置页选的「摘要长度」拼出对 aiSummary 的字数要求 */
function buildSummaryRule(): string {
  switch (settingsStore.summaryLength) {
    case "short":
      return "【摘要长度】请极度精简，aiSummary 必须是 20 字以内的一句话。";
    case "long":
      return "【摘要长度】aiSummary 请详细说明，包含前因后果，50-100 字。";
    default:
      return "【摘要长度】aiSummary 保持在 50 字以内，三行以内即可。";
  }
}

/** 按设置页选的「解析模型」挑文本模型：fast 用轻量模型，quality 用完整模型 */
function resolveTextModel(): string {
  return settingsStore.aiModel === "quality"
    ? OLLAMA_MODEL_QUALITY
    : OLLAMA_MODEL_FAST;
}

/** 拼接给本地模型的 Prompt：只取前 2000 字，防止超出上下文 */
function buildPrompt(text: string): string {
  return `你是一个待办提取助手。请阅读以下文本，提取任务信息。
${text.substring(0, 2000)}
（注意：只提取前2000字以防止超出限制）

【时间提取要求】：
1. 请务必仔细寻找任何形式的时间线索，包括具体的日期（如 11月15日）、相对时间（如 今天、明天、两天内、下周），以及「X 天内」「X 小时后」「本周末前」这类模糊期限。
2. 原文里同时出现多个时间时（例如「需要在两天内完成认证，我今天就需要完成」），取最先到期、最紧迫的那个作为 time，直接输出其原始措辞（如「今天」）；其余时间线索写进 keyPoints。
3. 提取到时间就按原文措辞输出，标准格式优先：具体日期写成「11月15日」「2026-11-15 18:30」，相对时间原样写成「今天」「明天」「两天内」「下周」。
4. 如果整段文本里没有任何时间线索，time 填空字符串 ""，绝对不许编造时间。

${PRIORITY_RULE}

${TIME_WARNING}

${buildSummaryRule()}

【强制要求】：请务必只输出严格的 JSON 格式，不要输出任何多余的解释说明，不要使用 \`\`\`json 代码块。
其中 priority 只能填 high、medium、low 三者之一，必须按上面的规则判定。
另需输出 "keyPoints"：从原文提炼 2-4 个关键要点，逐条写成「维度：内容」，
只保留原文里确实出现的信息（截止时间、交付要求、注意事项、地点、参与方式等），
每条不超过 20 字，不要与 aiSummary 重复。格式如下：
{
  "title": "任务标题(如：参加创新大赛)",
  "time": "截止时间或相关时间",
  "priority": "high/medium/low",
  "type": "任务类型(如：比赛/学习)",
  "aiSummary": "一句话摘要概括核心内容",
  "keyPoints": ["截止时间：11月15日", "交付要求：需要包含源码和文档", "注意事项：严禁抄袭"]
}`;
}

/** 视觉通道的 Prompt：先让模型读图，再直接吐 JSON */
function buildVisionPrompt(): string {
  return `你是一个多模态待办提取助手。请先识别图片里的全部文字内容（可能是老师的通知、实验要求、板书或聊天截图），
再从识别出的文字中提取任务信息。

${PRIORITY_RULE}

${TIME_WARNING}

${buildSummaryRule()}

【强制要求】：请务必只输出严格的 JSON 格式，不要输出任何多余的解释说明，不要使用 \`\`\`json 代码块。
其中 priority 只能填 high、medium、low 三者之一，必须按上面的规则判定。
另需输出 "keyPoints"：从原文提炼 2-4 个关键要点，逐条写成「维度：内容」，
只保留原文里确实出现的信息（截止时间、交付要求、注意事项、地点、参与方式等），
每条不超过 20 字，不要与 aiSummary 重复。格式如下：
{
  "title": "任务标题(如：参加创新大赛)",
  "time": "截止时间或相关时间",
  "priority": "high/medium/low",
  "type": "任务类型(如：比赛/学习)",
  "aiSummary": "一句话摘要概括核心内容",
  "keyPoints": ["截止时间：11月15日", "交付要求：需要包含源码和文档", "注意事项：严禁抄袭"]
}`;
}

interface OllamaGenerateResponse {
  response?: string;
  done?: boolean;
}

interface OllamaChatResponse {
  message?: { role?: string; content?: string };
  done?: boolean;
}

/** 送给本地模型的输入：文本通道用 text，视觉通道用 base64 */
interface LocalModelInput {
  kind: SourceKind;
  text: string;
  base64: string;
}

/** Ollama 的 images 只接受纯 Base64，去掉 data:image/png;base64, 前缀 */
function stripDataUrlPrefix(base64: string): string {
  const comma = base64.indexOf(",");
  return base64.startsWith("data:") && comma !== -1
    ? base64.slice(comma + 1)
    : base64;
}

/** 本地缺少指定模型（Ollama 返回 404 model not found）时抛这个，方便上层回退 */
class ModelMissingError extends Error {}

/** 用指定模型发一次 /api/generate */
async function requestTextModelWith(
  text: string,
  model: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(OLLAMA_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: buildPrompt(text),
      stream: false,
      format: "json",
    }),
    signal,
  });

  if (response.status === 404) {
    throw new ModelMissingError(`本地缺少模型 ${model}`);
  }
  if (!response.ok) throw new Error("Ollama 响应异常：" + response.status);

  const data = (await response.json()) as OllamaGenerateResponse;
  if (typeof data.response !== "string" || !data.response.trim()) {
    throw new Error("Ollama 返回内容为空");
  }
  return data.response;
}

/**
 * 文本模型：POST /api/generate
 * 模型档位跟随设置页：fast → qwen2.5:0.5b，quality → qwen2.5:3b。
 * 本机没拉过 0.5b 时自动回退到 3b，避免「改完设置反而解析不了」。
 */
async function requestTextModel(
  text: string,
  signal: AbortSignal,
): Promise<string> {
  const model = resolveTextModel();

  try {
    return await requestTextModelWith(text, model, signal);
  } catch (error) {
    if (model !== OLLAMA_MODEL_QUALITY && error instanceof ModelMissingError) {
      console.warn(`[Input] ${error.message}，已回退到 ${OLLAMA_MODEL_QUALITY}`);
      return requestTextModelWith(text, OLLAMA_MODEL_QUALITY, signal);
    }
    throw error;
  }
}

/** 视觉模型：POST /api/chat，图片以 Base64 放进 messages[].images */
async function requestVisionModel(
  input: LocalModelInput,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(OLLAMA_CHAT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_VISION_MODEL,
      messages: [
        {
          role: "user",
          // 图片 + 文本框补充说明时，把补充说明一起带给视觉模型
          content: input.text
            ? `${buildVisionPrompt()}\n\n【用户补充说明】：${input.text}`
            : buildVisionPrompt(),
          images: [stripDataUrlPrefix(input.base64)],
        },
      ],
      stream: false,
      format: "json",
    }),
    signal,
  });

  if (!response.ok) throw new Error("Ollama 响应异常：" + response.status);

  const data = (await response.json()) as OllamaChatResponse;
  const content = data.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Ollama 返回内容为空");
  }
  return content;
}

/** 按输入类型自动切换模型：图片走视觉 /api/chat，其余走文本 /api/generate */
async function requestLocalModel(input: LocalModelInput): Promise<string> {
  const controller = new AbortController();
  fetchController = controller;

  const timeout =
    input.kind === "image" ? OLLAMA_VISION_TIMEOUT : OLLAMA_TIMEOUT;
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    return input.kind === "image"
      ? await requestVisionModel(input, controller.signal)
      : await requestTextModel(input.text, controller.signal);
  } finally {
    clearTimeout(timeoutId);
  }
}

/** 去掉模型可能带出的 ```json 标记后再 JSON.parse，解析失败会抛错 */
function parseModelJson(raw: string): unknown {
  const cleaned = raw
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();
  if (!cleaned) throw new Error("模型返回为空");

  try {
    return JSON.parse(cleaned);
  } catch {
    // 兜底：有些模型会在 JSON 前后加解释文字，截取第一个 { 到最后一个 }
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start)
      throw new Error("模型返回的不是合法 JSON");
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

/** 小模型偶尔会把数组写成字符串或塞进脏数据，这里统一收敛成 2-4 条干净要点 */
function toKeyPoints(value: unknown, fallback: string[]): string[] {
  let list: unknown = value;

  // 兜底：模型有时返回 "[\"a\",\"b\"]" 这样的字符串
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      list = null;
    }
  }
  if (!Array.isArray(list)) return fallback;

  const points: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;

    const text = item.trim();
    if (!text || points.includes(text)) continue;

    points.push(text);
    if (points.length >= 4) break;
  }

  return points.length ? points : fallback;
}

/** 把模型输出收敛成页面需要的结构，字段缺失时用兜底值，避免整页崩掉 */
function toParsedMemo(value: unknown): ParsedMemo {
  const record = (
    typeof value === "object" && value !== null ? value : {}
  ) as Record<string, unknown>;

  const pick = (key: string, fallback: string): string => {
    const raw = record[key];
    return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
  };

  const title = pick("title", "未命名任务");
  const time = pick("time", "未提及");
  const type = pick("type", "日常");
  const rawPriority = pick("priority", "medium").toLowerCase();
  const priority: Priority =
    rawPriority === "high" ? "high" : rawPriority === "low" ? "low" : "medium";
  const aiSummary = pick("aiSummary", title);

  // 模型没给 keyPoints 时，用结构化字段兜底，保证列表不空
  const fallbackPoints = [
    "截止时间：" + time,
    "任务类型：" + type,
    "优先级：" + priorityMeta[priority].label,
  ];
  const keyPoints = toKeyPoints(record.keyPoints, fallbackPoints);

  return {
    title,
    time,
    priority,
    type,
    aiSummary,
    keyPoints,
    // 模板沿用原来的 points / tags
    points: keyPoints,
    tags: [type],
  };
}

/** 触发解析：读取阶段动画 → 请求本地 Ollama → 渲染结构化结果 */
async function startParse(): Promise<void> {
  if (isProcessing.value) return;

  const source = extracted.value;
  const text = extractedText.value;
  const imageBase64 = source?.kind === "image" ? source.base64 : "";

  if (!text && !imageBase64) {
    ElMessage.warning("请先粘贴文本或上传文件");
    return;
  }

  // 图片走视觉模型（补充说明一并带上），其余走文本模型（text 里已是文档 + 补充说明的合并结果）
  const modelInput: LocalModelInput = imageBase64
    ? { kind: "image", text: noticeText.value.trim(), base64: imageBase64 }
    : { kind: source?.kind ?? "text", text, base64: "" };

  stopProgressLoop();
  const runId = ++parseRunId;

  // 记录本次解析的数据来源：文档 + 文本混合时名字里体现出来
  parseSource.value = source
    ? {
        kind: source.kind,
        name:
          source.kind !== "image" && noticeText.value.trim()
            ? `${source.name} + 补充说明`
            : source.name,
        chars: text.length,
      }
    : noticeText.value.trim()
      ? {
          kind: "text",
          name: "文本框内容",
          chars: text.length,
        }
      : null;

  parseResult.value = null;
  isProcessing.value = true;
  isDone.value = false;
  progress.value = 0;
  progressTarget.value = 28;
  parseStage.value = "reading";
  startProgressLoop();

  // 让「文档读取」这段进度先走一会儿，视觉上更连贯
  await delay(700);
  if (runId !== parseRunId) return;

  parseStage.value = "thinking";
  progressTarget.value = 92;

  try {
    // 输入在进入函数时就已取好，避免等待期间内容被清空
    const rawResponse = await requestLocalModel(modelInput);
    if (runId !== parseRunId) return;

    parseResult.value = toParsedMemo(parseModelJson(rawResponse));
    progressTarget.value = 100;
    progress.value = 100;
    parseStage.value = "done";
    isDone.value = true;
  } catch (error) {
    // 组件已卸载或已被新的解析取代：不再打扰用户
    if (runId !== parseRunId) return;

    console.error("[Input] 本地 AI 解析失败：", error);
    ElMessage.error("本地AI连接失败，请检查Ollama服务");

    parseResult.value = null;
    parseStage.value = "idle";
    progress.value = 0;
    progressTarget.value = 0;
  } finally {
    if (runId === parseRunId) {
      isProcessing.value = false;
      stopProgressLoop();
    }
  }
}

/** 「重新解析」：作废旧请求，重新跑一遍 */
function restartParse() {
  parseRunId += 1;
  stopProgressLoop();
  isProcessing.value = false;
  isDone.value = false;
  progress.value = 0;
  progressTarget.value = 0;
  parseStage.value = "idle";
  void startParse();
}

onUnmounted(() => {
  parseRunId += 1;
  stopProgressLoop();
  fetchController?.abort();
});

/* ---------------------------- 保存到待办 ---------------------------- */
const router = useRouter();
const memoStore = useMemoStore();
const saving = ref(false);

/** 把解析结果写入 Pinia，提示成功并回到首页 */
async function saveToTodo(): Promise<void> {
  const result = parseResult.value;
  if (!result || saving.value) return;

  saving.value = true;

  try {
    // 原文：文本 / PDF / Word 的提取结果直接入库；图片只有 Base64，不存进 originText
    const originText =
      extracted.value && extracted.value.kind !== "image"
        ? extracted.value.content
        : noticeText.value.trim();

    // AI 提取的时间可能是「明天下午两点」这类相对说法，必须先换算成绝对时间再入库：
    // 否则库里存的相对词永远不会「变旧」，首页的逾期判断和提醒都会失效。
    // 解析不出来（或为空）时兜底成「今天的 10:00:00」，不能用 00:00:00。
    const standardTime =
      toStandardTime(result.time) || `${toDateKey(new Date())} 10:00:00`;

    await memoStore.addMemo({
      title: result.title,
      time: standardTime,
      priority: result.priority,
      type: result.type,
      aiSummary: result.aiSummary,
      originText,
      keyPoints: result.keyPoints,
    });
    ElMessage.success("已保存至待办清单");
    void router.push("/").finally(() => {
      saving.value = false;
    });
  } catch (error) {
    console.error("[Input] 保存待办失败：", error);
    ElMessage.error("保存失败，请重试");
    saving.value = false;
  }
}

/** 进度 → 当前步骤下标（0/1/2），完成后全部点亮 */
const activeStep = computed(() => {
  if (isDone.value) return steps.length;
  if (!isProcessing.value) return 0;
  if (progress.value < 34) return 0;
  if (progress.value < 68) return 1;
  return 2;
});

/** 空闲时不让第一步误显示成“进行中” */
const processStatus = computed(() => {
  if (isDone.value) return "finish" as const;
  return isProcessing.value ? ("process" as const) : ("wait" as const);
});

const statusText = computed(() => {
  if (parseStage.value === "done") return "解析完成，已生成待办草稿";
  if (parseStage.value === "reading") return "正在识别文档内容…";
  if (parseStage.value === "thinking") return "正在请求本地 AI 理解…";
  if (!isProcessing.value) return "等待提交内容";
  return `正在进行「${steps[activeStep.value]?.title ?? ""}」…`;
});

const statusLabel = computed(() => {
  if (parseStage.value === "done") return "已完成";
  if (parseStage.value === "thinking") return "AI 理解中";
  return isProcessing.value ? "处理中" : "等待中";
});

const statusClass = computed(() => {
  if (isDone.value) return "is-done";
  return isProcessing.value ? "is-processing" : "is-idle";
});
</script>

<template>
  <div class="input-page">
    <!-- 顶部：标题 -->
    <header class="page-head">
      <h1 class="page-title">信息录入</h1>
      <p class="page-subtitle">
        粘贴老师通知，或直接上传图片 / 文档，AI 自动提取关键信息。
      </p>
    </header>

    <div class="workbench">
      <!-- 左：多模态输入 -->
      <section class="panel input-panel">
        <div class="panel-head">
          <span class="panel-icon">
            <svg
              class="icon"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4 7.5A2.5 2.5 0 0 1 6.5 5h4l2 2.5h5A2.5 2.5 0 0 1 20 10v6.5A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-9Z"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          <div class="panel-title-group">
            <h2 class="panel-title">多模态输入</h2>
            <p class="panel-sub">文本、图片、文档可任选其一，也可混合提交</p>
          </div>
        </div>

        <div class="field">
          <div class="field-head">
            <label class="field-label" for="notice-input">文本内容</label>
            <span class="field-hint">支持直接粘贴</span>
          </div>

          <el-input
            id="notice-input"
            v-model="noticeText"
            type="textarea"
            :rows="8"
            resize="none"
            maxlength="500"
            show-word-limit
            placeholder="粘贴老师通知或实验要求..."
          />
        </div>

        <div class="field">
          <div class="field-head">
            <span class="field-label">图片 / 文档</span>
            <span class="field-hint">可选</span>
          </div>

          <el-upload
            v-model:file-list="fileList"
            class="uploader"
            drag
            multiple
            :auto-upload="false"
            :limit="5"
            accept="image/*,.pdf,.doc,.docx,.txt,.md"
            :on-change="handleUploadChange"
          >
            <div class="upload-inner">
              <span class="upload-icon">
                <svg
                  class="icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M12 16V5"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                  />
                  <path
                    d="m7.5 9.5 4.5-4.5 4.5 4.5"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                  <path
                    d="M4 15v2.5A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V15"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                  />
                </svg>
              </span>
              <p class="upload-title">
                上传图片/文档，<span class="upload-ai">AI 自动提取</span>
              </p>
              <p class="upload-hint">
                支持 PDF（取前 3 页）/ DOCX / DOC / 图片，单个文件不超过 20MB
              </p>
            </div>
          </el-upload>

          <div
            v-if="extractStatus !== 'idle'"
            class="source-status"
            :class="'is-' + extractStatus"
          >
            <span class="source-dot"></span>
            <p class="source-text">{{ extractStatusText }}</p>
          </div>

          <pre
            v-if="
              extractStatus === 'ready' &&
              extracted &&
              extracted.kind !== 'image'
            "
            class="source-preview"
            >{{ extracted.preview }}</pre
          >
        </div>
      </section>

      <!-- 右：AI 处理状态 -->
      <aside class="panel status-panel" aria-live="polite">
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
            <h2 class="panel-title">AI 处理状态</h2>
            <p class="panel-sub">解析耗时约 3 秒</p>
          </div>
          <span class="status-chip" :class="statusClass">
            <i v-if="isProcessing" class="status-dot"></i>
            {{ statusLabel }}
          </span>
        </div>

        <el-steps
          class="ai-steps"
          :active="activeStep"
          :process-status="processStatus"
          finish-status="success"
          direction="vertical"
        >
          <el-step
            v-for="step in steps"
            :key="step.title"
            :title="step.title"
            :description="step.desc"
          />
        </el-steps>

        <!-- 处理中 / 完成 / 空闲 三态切换（结果内容来自写死的 JSON 假数据） -->
        <Transition name="fade" mode="out-in">
        <div v-if="isProcessing" class="progress-block">
          <div class="progress-meta">
            <span class="progress-label">{{ statusText }}</span>
            <strong class="progress-value">{{ Math.round(progress) }}%</strong>
          </div>
          <el-progress
            :percentage="progress"
            :show-text="false"
            :stroke-width="8"
          />
          <p class="progress-hint">解析过程中请勿关闭页面</p>
        </div>

        <div v-else-if="isDone && parseResult" class="result-block">
          <div class="result-head">
            <span class="result-check">
              <svg
                class="icon"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="m5 12.5 4.5 4.5L19 7.5"
                  stroke="currentColor"
                  stroke-width="2.2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
            <div>
              <p class="result-title">解析完成</p>
              <p class="result-sub">
                识别到 1 条待办 · {{ parseResult.points.length }} 个关键点
              </p>
            </div>
          </div>

          <p class="result-summary">{{ parseResult.aiSummary }}</p>

          <div class="result-tags">
            <span class="result-chip">{{ parseResult.type }}</span>
            <span
              class="result-chip"
              :style="{ color: priorityMeta[parseResult.priority].color }"
            >
              {{ priorityMeta[parseResult.priority].label }}优先级
            </span>
            <span class="result-chip">{{ parseResult.time }}</span>
          </div>

          <p class="result-field">
            <span class="result-field-label">主题</span>{{ parseResult.title }}
          </p>

          <ul class="result-points">
            <li v-for="point in parseResult.points" :key="point">
              {{ point }}
            </li>
          </ul>

          <p v-if="parseSource" class="result-source">
            来源：{{ parseSource.name }}
            <template v-if="parseSource.kind === 'image'">· Base64</template>
            <template v-else>· {{ parseSource.chars }} 字</template>
          </p>

          <details class="result-json">
            <summary>查看解析 JSON</summary>
            <pre>{{ JSON.stringify(parseResult, null, 2) }}</pre>
          </details>

          <div class="result-actions">
            <el-button
              type="primary"
              class="save-btn"
              :loading="saving"
              @click="saveToTodo"
            >
              保存至待办
            </el-button>
            <el-button
              class="again-btn"
              text
              type="primary"
              @click="restartParse"
            >
              重新解析
            </el-button>
          </div>
        </div>

        <div v-else class="idle-block">
          <span class="idle-icon">
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
                stroke-width="1.6"
                stroke-dasharray="3 3"
              />
              <path
                d="M12 8.5v4l2.5 1.5"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
              />
            </svg>
          </span>
          <p>提交内容后，这里会实时展示 AI 的解析进度</p>
        </div>
        </Transition>
      </aside>
    </div>

    <!-- 底部操作 -->
    <footer class="action-bar">
      <p class="action-hint">
        解析结果会自动写入待办清单，可在
        <RouterLink to="/" class="inline-link">总览</RouterLink>
        中查看。
      </p>

      <el-button
        type="primary"
        size="large"
        class="parse-btn"
        :loading="isProcessing"
        @click="startParse"
      >
        <svg
          v-if="!isProcessing"
          class="icon"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M11 4.5 12.7 9l4.5 1.7-4.5 1.7L11 17l-1.7-4.6L4.8 10.7 9.3 9Z"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linejoin="round"
          />
          <path
            d="M17.6 15.4l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7Z"
            fill="currentColor"
            opacity=".6"
          />
        </svg>
        {{ isProcessing ? "AI 解析中…" : "开始智能解析" }}
      </el-button>
    </footer>
  </div>
</template>

<style scoped lang="scss">
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
$shadow-hover: 0 12px 28px -12px rgba(16, 24, 40, 0.16);

/* 本页的主色是 AI 紫，仅作用于页面作用域 */
.input-page {
  --el-color-primary: #{$ai};
  --el-color-primary-light-3: #a687f8;
  --el-color-primary-light-5: #c0a9fa;
  --el-color-primary-light-7: #dacdfc;
  --el-color-primary-light-8: #e7defd;
  --el-color-primary-light-9: #f3effe;
  --el-color-primary-dark-2: #6f3bdd;
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

/* ---------------- 顶部 ---------------- */
.page-head {
  max-width: 1200px;
  margin: 0 auto 22px;
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

/* ---------------- 工作区 ---------------- */
.workbench {
  display: grid;
  grid-template-columns: minmax(0, 1.12fr) minmax(0, 0.88fr);
  gap: 20px;
  align-items: start;
  max-width: 1200px;
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
  background: var(--brand-soft);
  color: #4f46e5;

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
  color: $text;
}

.panel-sub {
  margin-top: 2px;
  font-size: 12.5px;
  color: $text-subtle;
}

/* ---------------- 表单字段 ---------------- */
.field {
  margin-top: 20px;
}

.field-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}

.field-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--app-text);
}

.field-hint {
  font-size: 12px;
  color: $text-subtle;
}

.input-panel :deep(.el-textarea__inner) {
  border-radius: $radius-md;
  background: var(--input-bg);
  color: $text;
  font-size: 14px;
  line-height: 1.75;
  padding: 14px 16px 26px;
  box-shadow: 0 0 0 1px $line inset;
  resize: none;
  transition: box-shadow 0.2s ease;

  &::placeholder {
    color: var(--app-text-subtle);
  }

  &:hover {
    box-shadow: 0 0 0 1px var(--app-line) inset;
  }

  &:focus {
    box-shadow: 0 0 0 2px rgba($ai, 0.35) inset;
  }
}

.input-panel :deep(.el-input__count) {
  right: 14px;
  bottom: 8px;
  background: transparent;
  color: $text-subtle;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

/* ---------------- 上传区 ---------------- */
.uploader {
  width: 100%;
}

.uploader :deep(.el-upload) {
  width: 100%;
}

.uploader :deep(.el-upload-dragger) {
  width: 100%;
  padding: 26px 18px;
  border: 1px dashed #d9d3f0;
  border-radius: 14px;
  background: var(--input-bg);
  transition:
    border-color 0.2s ease,
    background 0.2s ease;

  &:hover {
    border-color: rgba($ai, 0.6);
    background: var(--input-bg);
  }

  &.is-dragover {
    border-color: $ai;
    border-style: solid;
    background: rgba(237, 233, 255, 0.7);
  }
}

.upload-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.upload-icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  margin-bottom: 4px;
  border-radius: 50%;
  background: rgba($ai, 0.1);
  color: $ai;

  .icon {
    width: 19px;
    height: 19px;
  }
}

.upload-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--app-text);
}

.upload-ai {
  color: $ai;
}

.upload-hint {
  font-size: 12px;
  color: $text-subtle;
}

.uploader :deep(.el-upload-list) {
  margin-top: 10px;
}

.uploader :deep(.el-upload-list__item) {
  border-radius: $radius-sm;
  font-size: 13px;
  color: var(--app-text-muted);
}

/* ---------------- 状态面板 ---------------- */
.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;

  &.is-idle {
    background: var(--chip-bg);
    color: $text-muted;
  }

  &.is-processing {
    background: rgba($ai, 0.12);
    color: $ai-deep;
  }

  &.is-done {
    background: var(--success-soft);
    color: var(--success-text);
  }
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: pulse 1.1s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }

  50% {
    opacity: 0.35;
    transform: scale(0.7);
  }
}

.ai-steps {
  margin-top: 22px;

  :deep(.el-step__title) {
    font-size: 13.5px;
    font-weight: 600;
    line-height: 1.5;
  }

  :deep(.el-step__description) {
    padding-right: 8px;
    font-size: 12px;
    color: $text-subtle;
    line-height: 1.6;
  }

  :deep(.el-step__head.is-wait) {
    color: var(--app-line);
    border-color: var(--app-line);
  }

  :deep(.el-step__title.is-wait) {
    color: $text-muted;
  }

  :deep(.el-step__head.is-process) {
    color: $ai;
    border-color: $ai;
  }

  :deep(.el-step__title.is-process) {
    color: $ai-deep;
  }

  :deep(.el-step__title.is-finish) {
    color: $text;
  }

  :deep(.el-step__line) {
    background-color: var(--app-line-soft);
  }

  :deep(.el-step__icon) {
    width: 24px;
    height: 24px;
    font-size: 12px;
    background: $surface;
  }
}

/* ---------------- 进度 ---------------- */
.progress-block {
  margin-top: 22px;
  padding: 16px;
  border: 1px solid rgba($ai, 0.2);
  border-radius: $radius-md;
  background: linear-gradient(180deg, rgba($ai, 0.06), rgba($ai, 0.02));
}

.progress-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.progress-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--ai-text);
}

.progress-value {
  font-size: 15px;
  font-weight: 700;
  color: $ai-deep;
  font-variant-numeric: tabular-nums;
}

.progress-block :deep(.el-progress-bar__outer) {
  background-color: #ece9f7;
}

.progress-block :deep(.el-progress-bar__inner) {
  background-image: linear-gradient(90deg, $ai, #a78bfa);
  transition: width 0.18s linear;
}

.progress-hint {
  margin-top: 10px;
  font-size: 12px;
  color: $text-subtle;
}

/* ---------------- 结果 ---------------- */
.result-block {
  margin-top: 22px;
  padding: 16px;
  border: 1px solid rgba(16, 185, 129, 0.28);
  border-radius: $radius-md;
  background: rgba(236, 253, 245, 0.55);
}

.result-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.result-check {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--success-soft);
  color: #10b981;

  .icon {
    width: 16px;
    height: 16px;
  }
}

.result-title {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--success-text);
}

.result-sub {
  margin-top: 2px;
  font-size: 12px;
  color: $text-muted;
}

.again-btn {
  margin-top: 4px;
  padding-left: 0;
  font-size: 12.5px;
  font-weight: 600;
}

.result-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.result-actions .again-btn {
  margin-top: 0;
}

.save-btn {
  flex: 1;
  min-width: 0;
  height: 38px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
}

/* ---------------- 文档提取状态 ---------------- */
.source-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 8px 12px;
  border: 1px solid var(--app-line);
  border-radius: $radius-sm;
  background: var(--chip-bg);
  font-size: 12.5px;
  color: $text-muted;

  .source-dot {
    width: 7px;
    height: 7px;
    flex-shrink: 0;
    border-radius: 50%;
    background: $text-subtle;
  }

  &.is-reading .source-dot {
    background: $ai;
    animation: pulse 1.1s ease-in-out infinite;
  }

  &.is-ready {
    border-color: rgba(16, 185, 129, 0.3);

    .source-dot {
      background: #10b981;
    }

    .source-text {
      color: var(--success-text);
    }
  }

  &.is-error {
    border-color: rgba(239, 68, 68, 0.32);

    .source-dot {
      background: #ef4444;
    }

    .source-text {
      color: #ef4444;
    }
  }
}

.source-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-preview {
  margin-top: 8px;
  padding: 10px 12px;
  max-height: 96px;
  overflow: auto;
  border: 1px dashed var(--app-line);
  border-radius: $radius-sm;
  background: var(--input-bg);
  color: $text-subtle;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ---------------- 解析结果详情 ---------------- */
.result-summary {
  margin-top: 10px;
  font-size: 12.5px;
  line-height: 1.7;
  color: $text-muted;
}

.result-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.result-chip {
  padding: 2px 9px;
  border: 1px solid var(--app-line);
  border-radius: 999px;
  background: var(--chip-bg);
  color: $text-muted;
  font-size: 11.5px;
  font-weight: 500;
}

.result-field {
  margin-top: 10px;
  font-size: 12.5px;
  color: $text;
}

.result-field-label {
  margin-right: 8px;
  color: $text-subtle;
}

.result-points {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;

  li {
    position: relative;
    padding-left: 13px;
    font-size: 12px;
    line-height: 1.85;
    color: $text-muted;

    &::before {
      content: "";
      position: absolute;
      top: 8px;
      left: 2px;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: rgba($ai, 0.7);
    }
  }
}

.result-source {
  margin-top: 10px;
  font-size: 11.5px;
  color: $text-subtle;
}

.result-json {
  margin-top: 8px;
  font-size: 12px;
  color: $text-muted;

  summary {
    cursor: pointer;
    color: $ai-deep;
    font-size: 12px;
    font-weight: 600;
  }

  pre {
    margin-top: 8px;
    padding: 10px 12px;
    max-height: 180px;
    overflow: auto;
    border: 1px solid var(--app-line);
    border-radius: $radius-sm;
    background: var(--input-bg);
    color: $text-muted;
    font-size: 11.5px;
    line-height: 1.65;
  }
}

/* ---------------- 空闲 ---------------- */
.idle-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 22px;
  padding: 24px 16px;
  border: 1px dashed rgba(226, 225, 234, 0.9);
  border-radius: $radius-md;
  background: var(--input-bg);
  text-align: center;
  color: $text-subtle;
  font-size: 12.5px;
  line-height: 1.6;
}

.idle-icon {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--chip-bg);
  color: var(--app-text-subtle);

  .icon {
    width: 18px;
    height: 18px;
  }
}

/* ---------------- 底部操作 ---------------- */
.action-bar {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  box-shadow: var(--glass-shadow);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));

  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  max-width: 1200px;
  margin: 20px auto 0;
  padding: 16px 20px;
}

.action-hint {
  font-size: 12.5px;
  color: $text-muted;
}

.inline-link {
  color: $ai-deep;
  font-weight: 600;

  &:hover {
    text-decoration: underline;
  }
}

.parse-btn {
  min-width: 168px;
  height: 44px;
  border: none;
  border-radius: $radius-md;
  background: linear-gradient(135deg, $ai, $ai-deep);
  font-size: 14.5px;
  font-weight: 600;
  box-shadow: 0 8px 18px -8px rgba($ai, 0.75);
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease,
    filter 0.2s ease;

  .icon {
    width: 16px;
    height: 16px;
    margin-right: 7px;
  }

  &:hover:not(.is-disabled) {
    background: linear-gradient(135deg, #9668f7, #6f3bdd);
    transform: translateY(-1px);
    box-shadow: 0 12px 24px -10px rgba($ai, 0.8);
  }

  &.is-disabled {
    box-shadow: none;
    opacity: 0.6;
  }
}

/* ---------------- 响应式 ---------------- */
@media (max-width: 1024px) {
  .workbench {
    grid-template-columns: minmax(0, 1fr);
  }

  .status-panel {
    order: 2;
  }
}

@media (max-width: 720px) {
  .panel {
    padding: 18px;
  }

  .action-bar {
    align-items: stretch;
    flex-direction: column;
  }

  .parse-btn {
    width: 100%;
  }
}
</style>
