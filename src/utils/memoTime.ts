// src/utils/memoTime.ts
// 待办时间的解析与格式化：首页（过期判断）、提醒中心（7 天分布）、详情页共用

/** 补零：1 → "01" */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/* ---------------------------- 一、中文数字 → 阿拉伯数字 ---------------------------- */

/** 中文数字字符 → 数值（只覆盖 0-99 里会用到的个位，「两」按 2 算） */
const CN_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 「一 / 两 / 十 / 十二 / 二十 / 二十三」→ 阿拉伯数字；解析不出来返回 null */
function cnNumberToValue(cn: string): number | null {
  const text = cn.trim();
  if (!text) return null;

  const tenIndex = text.indexOf("十");

  // 没有「十」：单个数字，如 一 / 两 / 九
  if (tenIndex === -1) {
    const single = CN_DIGITS[text];
    return single === undefined ? null : single;
  }

  // 有「十」：十 / 十二 / 二十 / 二十三（「十」前面没数字时按 1 个十算）
  const head = text.slice(0, tenIndex);
  const tail = text.slice(tenIndex + 1);
  if (tail.length > 1) return null;

  const tens = head ? CN_DIGITS[head] : 1;
  if (tens === undefined) return null;

  const ones = tail ? CN_DIGITS[tail] : 0;
  if (ones === undefined) return null;

  return tens * 10 + ones;
}

/** 「N点」后面跟这些字符时基本可以认定是时刻：3点半、3点到、3点左右、3点整… */
function isClockFollower(next: string): boolean {
  if (!next) return true; // 到句子结尾
  return /[\s，。、；：,.;:!！?？（）()\-~～—…半整钟刻分到至左右前后]/.test(next);
}

/** 前面出现过这些词时，中文数字基本可以确定是时刻（下午两点、明天十点…） */
const CLOCK_LEADERS =
  /今天|今日|明天|明日|后天|昨天|今晚|明早|明晚|上午|下午|中午|早上|早晨|凌晨|晚上|傍晚|夜里|夜间|周[一二三四五六日天1-7]|星期|礼拜|[日号]/;

/**
 * 把口语的中文数字时刻换成阿拉伯数字，交给后面的正则统一处理：
 *   两点 → 2点、二点 → 2点、十点 → 10点、十一点半 → 11点半、九点二十分 → 9点20分
 *
 * 只处理「数字 + 点/时」的小时位与紧随其后的分钟位，所以：
 *  - 「十一月」「十二月」这类日期不受影响（数字后面跟的是「月」而不是「点/时」）
 *  - 「两小时」这类时长也不受影响（「两」后面是「小」）
 *  - 「一点建议」「两点结论」这种不是时刻的写法，靠上下文判断后保持原样
 */
function normalizeChineseClock(text: string): string {
  // 整段没有中文就不会命中，直接返回
  if (!/[\u4e00-\u9fa5]/.test(text)) return text;

  // 1) 小时位：一点 / 两点 / 十点 / 十一点 / 十二点 / 九时
  let result = text.replace(
    /([一二两三四五六七八九十]{1,3})(\s*)([点时])/g,
    (match: string, cn: string, space: string, unit: string, offset: number) => {
      const value = cnNumberToValue(cn);
      if (value === null) return match;

      // 「一点点」「一点儿」不是时刻
      const next = text.charAt(offset + match.length);
      if (next === "点" || next === "儿") return match;

      // 「一 / 两」最容易撞上「一点建议」「两点结论」，加一层上下文判断；
      // 三~十二基本只会出现在时刻里，直接替换
      if (cn === "一" || cn === "两") {
        const before = text.slice(0, offset);
        if (!isClockFollower(next) && !CLOCK_LEADERS.test(before)) return match;
      }

      return `${value}${space}${unit}`;
    },
  );

  // 2) 分钟位（带「分」）：九点二十分 / 十一点四十五分
  result = result.replace(
    /([点时])(\s*)([一二两三四五六七八九十]{1,3})(\s*)(分)/g,
    (match: string, unit: string, space1: string, cn: string, space2: string) => {
      const value = cnNumberToValue(cn);
      return value === null ? match : `${unit}${space1}${value}${space2}分`;
    },
  );

  // 3) 分钟位（省略「分」，但停在句末 / 标点前）：九点二十、十点二十。
  //    这类要补一个「分」，否则会被当成整点
  result = result.replace(
    /([点时])(\s*)([一二两三四五六七八九十]{1,3})(?=\s*(?:$|[，。、；：,.;:!！?？]))/g,
    (match: string, unit: string, space: string, cn: string) => {
      const value = cnNumberToValue(cn);
      return value === null ? match : `${unit}${space}${value}分`;
    },
  );

  return result;
}

/* ---------------------------- 二、时刻与日期的小工具 ---------------------------- */

/** 一天里的某个时刻 */
interface ClockParts {
  hour: number;
  minute: number;
  second: number;
}

/** 时刻合法性：小时 0-23、分/秒 0-59 */
function isValidClock(hour: number, minute: number, second: number): boolean {
  return (
    Number.isInteger(hour) &&
    hour >= 0 &&
    hour <= 23 &&
    Number.isInteger(minute) &&
    minute >= 0 &&
    minute <= 59 &&
    Number.isInteger(second) &&
    second >= 0 &&
    second <= 59
  );
}

/**
 * 时段修正：把中文时段词折算成 24 小时制。
 *  - 下午 / 晚上 / 傍晚 / 夜里：小时 < 12 → +12（下午两点 → 14、晚上八点 → 20）
 *  - 中午 / 正午：小时 < 11 → +12（中午一点 → 13，中午十二点保持 12）
 *  - 凌晨：正好 12 点 → 0（凌晨十二点 → 00:00）
 *  - 上午 / 早上 / 早晨：保持原样（上午九点 → 9）
 */
function applyPeriod(text: string, hour: number): number {
  const isAfternoonOrNight = /下午|晚上|傍晚|夜里|夜间/.test(text);
  const isNoon = /中午|正午/.test(text);
  const isEarlyMorning = /凌晨/.test(text);

  if (isAfternoonOrNight && hour < 12) return hour + 12;
  if (isNoon && hour < 11) return hour + 12;
  if (isEarlyMorning && hour === 12) return 0;

  return hour;
}

/**
 * 相对日期词 → 相对今天的天数偏移。
 * 优先级：大后天 > 后天 > 明天 > 今天 > 昨天，都没命中返回 null。
 */
function relativeDayOffset(text: string): number | null {
  if (text.includes("大后天")) return 3;
  if (text.includes("后天")) return 2;
  if (/明天|明日|明早|明晚/.test(text)) return 1;
  if (/今天|今日|今晚|今早|今儿/.test(text)) return 0;
  if (text.includes("昨天")) return -1;
  return null;
}

/**
 * 「周X / 星期X / 礼拜X」→ 相对今天的天数偏移，取最近的那个周X（今天就是 0）。
 * 带「下周 / 下星期 / 下礼拜」时再往后推 7 天。
 */
function weekdayOffset(text: string, today: Date): number | null {
  const match = text.match(/(?:周|星期|礼拜)([一二三四五六日天1-7])/);
  const key = match?.[1];
  if (!key) return null;

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
  const targetDay = weekMap[key];
  if (targetDay === undefined) return null;

  const offset = (targetDay - today.getDay() + 7) % 7;
  const isNextWeek = /下周|下星期|下礼拜/.test(text);
  return isNextWeek ? offset + 7 : offset;
}

/* ---------------------------- 三、主解析函数 ---------------------------- */

/**
 * 把自由格式的时间文本解析成 Date（本地时区），解析不出来返回 null。
 *
 * 支持的写法：
 *  - 中文日期：2026年11月15日 / 11月15日 / 2026年11月15日 下午2点
 *  - 数字日期：2026-11-15 / 2026/11/15 / 2026.11.15（可带 18:30）
 *  - 相对日期：大后天 / 后天 / 明天 / 今天 / 昨天 / 周X / 下周X
 *  - 时刻：18:30 / 9：30 / 8点 / 8点半 / 9点30分 / 中文数字「两点」「十点」
 *  - 时段：下午两点 → 14:00、晚上八点 → 20:00、上午九点 → 09:00
 *
 * 没有日期线索时以「今天」为基准；既没有日期也没有时刻（如「本周内」「尽快」）返回 null。
 */
export function parseMemoTime(raw: string): Date | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  /* ---------- ③-1 先把中文数字口语转成阿拉伯数字：两点 → 2点 ---------- */
  const normalized = normalizeChineseClock(text);

  /* ---------- ③-2 抽时刻：冒号写法优先，其次「点 / 时」写法 ---------- */
  let clock: ClockParts | null = null;

  const colonMatch = normalized.match(/(\d{1,2})[:：](\d{1,2})(?:[:：](\d{1,2}))?/);
  if (colonMatch) {
    const hour = Number(colonMatch[1]);
    const minute = Number(colonMatch[2]);
    const second = colonMatch[3] ? Number(colonMatch[3]) : 0;
    // 数值非法（如 25:00）就继续往下找「N点」的写法
    if (isValidClock(hour, minute, second)) clock = { hour, minute, second };
  }

  if (!clock) {
    // 「N点 / N点半 / N点M分 / N时M分」
    const dotPattern = /(\d{1,2})\s*[点时](?:\s*(半)|(\d{1,2})\s*分)?/g;
    let dotMatch: RegExpExecArray | null = dotPattern.exec(normalized);

    while (dotMatch) {
      const hour = Number(dotMatch[1]);
      const minute = dotMatch[2] === "半" ? 30 : dotMatch[3] ? Number(dotMatch[3]) : 0;

      // 「第 3 点」「其 2 点」这类是条目序号，不是时刻，跳过继续往后找
      const prevChar = normalized.charAt(dotMatch.index - 1);
      const isOrdinal = /[第其哪这那几]/.test(prevChar);

      if (!isOrdinal && isValidClock(hour, minute, 0)) {
        clock = { hour, minute, second: 0 };
        break;
      }

      dotMatch = dotPattern.exec(normalized);
    }
  }

  /* ---------- ③-3 时段修正：下午两点 → 14 点 ---------- */
  const hour = clock ? applyPeriod(text, clock.hour) : 0;
  const minute = clock ? clock.minute : 0;
  const second = clock ? clock.second : 0;

  /* ---------- ③-4 日期解析（优先级：显式日期 > 后天/明天/今天 > 周X > 默认今天） ---------- */

  // 4.1 显式日期：2026年11月15日 / 11月15日（缺年份按今年）
  const cnDate = text.match(/(?:(\d{4})\s*年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  const cnMonth = cnDate?.[2];
  const cnDay = cnDate?.[3];
  if (cnMonth && cnDay) {
    const year = cnDate?.[1] ? Number(cnDate[1]) : new Date().getFullYear();
    const month = Number(cnMonth);
    const day = Number(cnDay);
    const date = new Date(year, month - 1, day, hour, minute, second);

    // 非法日期（2 月 30 日之类）会被 Date 自动进位，这里拦掉
    if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return date;
  }

  // 4.2 显式日期：2026-11-15 / 2026/11/15 / 2026.11.15
  const isoDate = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (isoDate) {
    const year = Number(isoDate[1]);
    const month = Number(isoDate[2]);
    const day = Number(isoDate[3]);
    const date = new Date(year, month - 1, day, hour, minute, second);

    if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return date;
  }

  const now = new Date();

  // 4.3 相对日期词：大后天 / 后天 / 明天 / 今天（优先级高于周X）
  const relativeOffset = relativeDayOffset(text);

  // 4.4 周X：只在没写「今天/明天/后天」时才算「最近的周X」
  const weekOffset = relativeOffset === null ? weekdayOffset(text, now) : null;

  const dayOffset = relativeOffset ?? weekOffset;

  // 既没有日期线索，也没有任何时刻 → 不是可解析的时间
  if (dayOffset === null && !clock) return null;

  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + (dayOffset ?? 0),
    hour,
    minute,
    second,
  );
}

/** Date → "YYYY-MM-DD HH:mm:ss"（el-date-picker 的 value-format） */
export function formatStandardTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * 自由格式时间 → "YYYY-MM-DD HH:mm:ss"，解析失败返回空字符串。
 * 时段词、中文数字、「N点」写法都由 parseMemoTime 统一处理，
 * 所以详情页、首页、提醒中心的换算结果天然一致。
 */
export function toStandardTime(raw: string): string {
  const date = parseMemoTime(raw);
  return date ? formatStandardTime(date) : "";
}

/** Date → "YYYY-MM-DD"，用于按天分桶 */
export function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Date → "MM-DD"，用于图表坐标轴 */
export function formatMonthDay(date: Date): string {
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
