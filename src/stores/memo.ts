// src/stores/memo.ts
import { computed, ref } from "vue";
import { defineStore } from "pinia";

/** 紧急程度 */
export type MemoPriority = "high" | "medium" | "low";

/** 单条待办 */
export interface MemoItem {
  id: number;
  title: string;
  time: string;
  priority: MemoPriority;
  type: string;
  aiSummary: string;
  /** 是否已完成：后端用 0/1 存，接口返回布尔值，前端统一用 boolean */
  completed?: boolean;
  /** 录入时识别到的原文（详情页「原文识别内容」用），没有则显示占位文案 */
  originText?: string;
  /** AI 提炼的 2-4 条要点（详情页「AI 智能概括」下方列表），老数据可能没有 */
  keyPoints?: string[];
  /** 刚新增、还没被点开过的条目：首页卡片做紫色呼吸光晕，点开后置为 false */
  isNew?: boolean;
}

/** 新增时不需要传 id */
export type NewMemo = Omit<MemoItem, "id">;

/** 本地后端地址 */
const API_BASE = "http://localhost:3000/api";

/** localStorage 存储键（离线兜底用） */
const STORAGE_KEY = "timewise-memos";

const PRIORITIES: readonly MemoPriority[] = ["high", "medium", "low"];

/* ---------------------------- localStorage 兜底 ---------------------------- */

/** 读取本地缓存：脏数据 / 隐私模式 / JSON 损坏都不影响页面 */
function loadMemos(): MemoItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map(toMemoItem)
      .filter((memo): memo is MemoItem => memo !== null);
  } catch (error) {
    console.warn("[memo] 读取本地缓存失败，已按空列表处理：", error);
    return [];
  }
}

/** 写入本地缓存（失败不影响内存中的数据） */
function saveMemos(list: MemoItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (error) {
    console.warn("[memo] 写入本地缓存失败：", error);
  }
}

/* ---------------------------- 数据归一化 ---------------------------- */

/**
 * 把 keyPoints 收敛成 string[]：
 * - 接口已解析成数组 → 直接用
 * - 后端返回 JSON 字符串 / 旧 localStorage 缓存 → 先 JSON.parse
 * - 过滤非字符串、空串、重复项，最多保留 6 条
 * 返回 undefined 表示没有可用要点，详情页据此显示占位文案。
 */
function toKeyPoints(value: unknown): string[] | undefined {
  let list: unknown = value;

  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(list)) return undefined;

  const points: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;

    const text = item.trim();
    if (!text || points.includes(text)) continue;

    points.push(text);
    if (points.length >= 6) break;
  }

  return points.length ? points : undefined;
}

/**
 * 把后端 / 缓存里的原始数据收敛成 MemoItem：
 * - 校验必需字段，结构不对直接丢弃（返回 null）
 * - completed 统一转成布尔值（兼容 0/1、true/false）
 * - 忽略 createdAt 等前端暂不使用的字段
 */
function toMemoItem(value: unknown): MemoItem | null {
  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;
  const validShape =
    typeof record.id === "number" &&
    typeof record.title === "string" &&
    typeof record.time === "string" &&
    typeof record.type === "string" &&
    typeof record.aiSummary === "string" &&
    PRIORITIES.includes(record.priority as MemoPriority);

  if (!validShape) return null;

  return {
    id: record.id as number,
    title: record.title as string,
    time: record.time as string,
    priority: record.priority as MemoPriority,
    type: record.type as string,
    aiSummary: record.aiSummary as string,
    // 后端已返回布尔值；这里再兜一层 0/1 的老数据
    completed: record.completed === true || record.completed === 1,
    originText:
      typeof record.originText === "string" ? record.originText : undefined,
    keyPoints: toKeyPoints(record.keyPoints),
    // 后端不返回该字段，只有本地缓存 / 乐观新增时才有；非 true 一律视为无高亮
    isNew: record.isNew === true,
  };
}

/** 后端与本地缓存都为空时的兜底假数据，保证 AI 悬浮球有数据可读 */
function createFallbackMemo(): MemoItem {
  return {
    id: 999,
    title: "欢迎使用智能备忘录",
    time: "今天 20:00",
    priority: "medium",
    type: "日常",
    aiSummary: "这是后端未启动时的离线示例数据，启动 server 后会自动换成真实待办。",
    completed: false,
    keyPoints: ["离线示例要点：启动本地 server 后即可看到真实数据", "录入通知后这里会显示 AI 提取的要点"],
  };
}

/* ---------------------------- store ---------------------------- */

export const useMemoStore = defineStore("memo", () => {
  /** 待办列表：先用本地缓存渲染，随后由 fetchMemos 与后端对齐 */
  const memos = ref<MemoItem[]>(loadMemos());

  /** 当前待办总数 */
  const total = computed(() => memos.value.length);

  /** 避免重复请求（自动同步 + 手动刷新同时触发时） */
  let fetching = false;

  /** 生成本地临时 id（负数，表示尚未同步到后端） */
  function nextTempId(): number {
    const minId = memos.value.reduce(
      (min, memo) => Math.min(min, memo.id),
      0,
    );
    return minId - 1;
  }

  /** 收集当前所有「新条目」的 id：后端不存 isNew，覆盖列表前必须先记下来 */
  function collectNewIds(): Set<number> {
    const ids = new Set<number>();
    for (const memo of memos.value) {
      if (memo.isNew === true) ids.add(memo.id);
    }
    return ids;
  }

  /** 把「新条目」标记盖回去（只认本地已记录过的 id），调用方随后统一 saveMemos */
  function restoreNewFlags(list: MemoItem[], ids: Set<number>): void {
    if (!ids.size) return;

    for (const memo of list) {
      if (ids.has(memo.id)) memo.isNew = true;
    }
  }

  /**
   * 从后端拉取全部待办（后端已按 createdAt 降序返回）。
   * 失败时回落到 localStorage；本地也没有数据就塞一条默认假数据兜底。
   *
   * isNew 是纯前端状态，后端不返回；所以拉取前先记住哪些条目亮着高亮，
   * 赋值后再按 id 补回来，避免「新增 → 自动刷新 → 高亮消失」。
   */
  async function fetchMemos(): Promise<void> {
    if (fetching) return;
    fetching = true;

    // 必须在 memos.value 被覆盖之前收集
    const newIds = collectNewIds();

    try {
      const response = await fetch(`${API_BASE}/memos`);
      if (!response.ok) throw new Error(`GET /memos 返回 ${response.status}`);

      const data: unknown = await response.json();
      if (!Array.isArray(data)) throw new Error("GET /memos 返回的不是数组");

      const list = data
        .map(toMemoItem)
        .filter((memo): memo is MemoItem => memo !== null);

      // 后端数据里没有 isNew，这里把本地记录的 id 重新标成「新」
      restoreNewFlags(list, newIds);

      memos.value = list;
      // 成功后同步写回 localStorage，离线时也能看到最近一次的数据
      saveMemos(list);
    } catch (error) {
      console.warn("[memo] 拉取后端失败，使用本地缓存兜底：", error);

      const cached = loadMemos();
      const list = cached.length ? cached : [createFallbackMemo()];

      restoreNewFlags(list, newIds);

      memos.value = list;
      saveMemos(list);
    } finally {
      fetching = false;
    }
  }

  /**
   * 新增待办：先乐观插入一条临时数据（负 id），
   * POST 成功后用后端返回的完整数据（真实自增 id）替换它。
   */
  async function addMemo(input: NewMemo): Promise<MemoItem> {
    const payload = {
      title: input.title,
      time: input.time,
      priority: input.priority,
      type: input.type,
      aiSummary: input.aiSummary,
      // 原文长文本随条目一起入库，详情页「原文识别内容」用
      originText: input.originText ?? "",
      // AI 要点：详情页「AI 智能概括」下方列表用，没有就存空数组
      keyPoints: input.keyPoints ?? [],
    };

    const tempMemo: MemoItem = {
      id: nextTempId(),
      ...payload,
      completed: input.completed ?? false,
      // 新条目先打上「未读高亮」标记，首页卡片会做呼吸光晕，点开后清除
      isNew: true,
    };
    memos.value.unshift(tempMemo);
    saveMemos(memos.value);

    try {
      const response = await fetch(`${API_BASE}/memos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`POST /memos 返回 ${response.status}`);

      const created = toMemoItem(await response.json());
      if (!created) throw new Error("POST /memos 返回的数据结构不正确");

      // 后端不存 isNew（纯前端临时状态），换成真实 id 后要手动补回来
      created.isNew = true;

      // 用带真实 id 的数据替换本地临时数据
      const index = memos.value.findIndex((memo) => memo.id === tempMemo.id);
      if (index === -1) {
        memos.value.unshift(created);
      } else {
        memos.value.splice(index, 1, created);
      }
      saveMemos(memos.value);

      return created;
    } catch (error) {
      // 后端不可用：保留本地临时数据，联网后可用 fetchMemos 重新对齐
      console.warn("[memo] 新增待办失败，已保留本地临时数据：", error);
      return tempMemo;
    }
  }

  /**
   * 清除「新条目」高亮：只改本地状态并写回缓存，不需要请求后端。
   * 首页卡片点开（或键盘回车）时调用。
   */
  function markMemoSeen(id: number): void {
    const memo = memos.value.find((item) => item.id === id);
    if (!memo || !memo.isNew) return;

    memo.isNew = false;
    saveMemos(memos.value);
  }

  /**
   * 切换完成状态：先本地乐观更新，PUT 成功后同步缓存；
   * 请求失败则回滚本地状态，保证界面与后端一致。
   */
  async function toggleCompleted(id: number): Promise<void> {
    const memo = memos.value.find((item) => item.id === id);
    if (!memo) return;

    const nextCompleted = !memo.completed;

    // 负数 id 是尚未同步的临时数据，没法 PUT，只切本地状态
    if (id < 0) {
      memo.completed = nextCompleted;
      saveMemos(memos.value);
      return;
    }

    memo.completed = nextCompleted;
    saveMemos(memos.value);

    try {
      const response = await fetch(`${API_BASE}/memos/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: nextCompleted }),
      });
      if (!response.ok) throw new Error(`PUT /memos/${id} 返回 ${response.status}`);

      const updated = toMemoItem(await response.json());
      if (updated) {
        const index = memos.value.findIndex((item) => item.id === id);
        if (index !== -1) memos.value.splice(index, 1, updated);
      }
      saveMemos(memos.value);
    } catch (error) {
      console.warn("[memo] 更新完成状态失败，已回滚本地状态：", error);
      memo.completed = !nextCompleted;
      saveMemos(memos.value);
    }
  }

  /**
   * 删除一条待办：
   * - 负数 id 是尚未同步到后端的临时数据，直接本地过滤；
   * - 其余先 DELETE 后端，成功后再从 memos 中过滤并更新本地缓存。
   * 返回是否删除成功，方便调用方给提示。
   */
  async function deleteMemo(id: number): Promise<boolean> {
    const removeLocal = (): void => {
      memos.value = memos.value.filter((memo) => memo.id !== id);
      saveMemos(memos.value);
    };

    // 还没同步到后端的临时条目，后端没有记录，只删本地
    if (id < 0) {
      removeLocal();
      return true;
    }

    try {
      const response = await fetch(`${API_BASE}/memos/${id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(`DELETE /memos/${id} 返回 ${response.status}`);
      }

      removeLocal();
      return true;
    } catch (error) {
      console.warn("[memo] 删除待办失败：", error);
      return false;
    }
  }

  /** 清空列表（演示空状态 / 测试用；只清本地，不删后端数据） */
  function clearMemos(): void {
    memos.value = [];
    saveMemos(memos.value);
  }

  // 首次使用 store 时自动与后端对齐；后端不可用则走上面的兜底逻辑
  void fetchMemos();

  return {
    memos,
    total,
    fetchMemos,
    addMemo,
    toggleCompleted,
    markMemoSeen,
    deleteMemo,
    clearMemos,
  };
});
