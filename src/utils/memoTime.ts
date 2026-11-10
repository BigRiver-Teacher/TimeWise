// src/utils/memoTime.ts
// 待办时间的解析与格式化：首页（过期判断）、提醒中心（7 天分布）、详情页共用

/** 补零：1 → "01" */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * 文本里没有具体时刻时的兜底小时：上午 10 点。
 * 用 00:00 会让「明天」（也就是明天刚过零点）立刻变成已过期，用 10:00 更接近真实使用习惯。
 */
const DEFAULT_HOUR = 10;

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
 * 「N点」后面紧跟这些名词时，中文数字是在计数而不是报时刻：
 * 三点建议 / 两点要求 / 一点注意。这类写法保持原文，绝不折算成 03:00 / 02:00 / 01:00。
 */
const QUANTIFIER_NOUNS =
  /^(?:建议|要求|注意|意见|结论|事项|内容|问题|方法|原则|步骤|要点|想法|感受|变化)/;

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

      // 「三点建议」「两点要求」「一点注意」：数字后面接的是名词，属于计数，保持原样
      if (QUANTIFIER_NOUNS.test(text.slice(offset + match.length))) return match;

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

/** 时段修正结果：折算后的小时 + 需要连日期一起顺延的天数 */
interface PeriodShift {
  hour: number;
  dayShift: number;
}

/**
 * 时段修正：把中文时段词折算成 24 小时制。
 *  - 下午 / 傍晚：小时 < 12 → +12（下午两点 → 14、傍晚六点 → 18）
 *  - 晚上 / 夜里 / 夜间：「十二点」是一天的结束 → 次日 00:00（dayShift = 1）；
 *    其余小时 < 12 → +12（晚上八点 → 20）
 *  - 中午 / 正午：小时 < 11 → +12（中午一点 → 13，中午十二点保持 12）
 *  - 凌晨：正好 12 点 → 0（凌晨十二点 → 当天 00:00）
 *  - 上午 / 早上 / 早晨：保持原样（上午九点 → 9）
 */
function applyPeriod(text: string, hour: number): PeriodShift {
  const isNight = /晚上|夜里|夜间/.test(text);
  const isAfternoon = /下午|傍晚/.test(text);
  const isNoon = /中午|正午/.test(text);
  const isEarlyMorning = /凌晨/.test(text);

  // 「晚上十二点」= 当天结束，按次日 00:00 处理，日期要一并顺延
  if (isNight && hour === 12) return { hour: 0, dayShift: 1 };
  if (isNight && hour < 12) return { hour: hour + 12, dayShift: 0 };
  if (isAfternoon && hour < 12) return { hour: hour + 12, dayShift: 0 };
  if (isNoon && hour < 11) return { hour: hour + 12, dayShift: 0 };
  if (isEarlyMorning && hour === 12) return { hour: 0, dayShift: 0 };

  return { hour, dayShift: 0 };
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

/* ---------------------------- 绝对时间识别 ---------------------------- */

/** YYYY-MM-DD / YYYY-MM-DD HH:mm / YYYY-MM-DD HH:mm:ss（分隔符支持空格或 T） */
const ABSOLUTE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** 绝对日期时间的解析结果 */
interface AbsoluteTime {
  date: Date;
  /** 是否带「时:分」 */
  hasClock: boolean;
  /** 是否带秒 */
  hasSeconds: boolean;
}

/** 解析已经是绝对日期时间的文本（不含任何相对词）；非法日期返回 null */
function parseAbsoluteTime(value: string): AbsoluteTime | null {
  const match = ABSOLUTE_TIME_PATTERN.exec((value ?? "").trim());
  if (!match) return null;

  const [, y = "0", mo = "0", d = "0", h = "0", mi = "0", s = "0"] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);

  if (!isValidClock(hour, minute, second)) return null;

  const date = new Date(year, month - 1, day, hour, minute, second);
  // 闰日 / 2 月 30 日这类会被 Date 自动进位，这里拦掉
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return {
    date,
    hasClock: match[4] !== undefined,
    hasSeconds: match[6] !== undefined,
  };
}

/** 是否已经是标准格式 "YYYY-MM-DD HH:mm:ss"（绝对时间且秒位齐全） */
export function isStandardTime(value: string): boolean {
  const parsed = parseAbsoluteTime(value);
  return parsed !== null && parsed.hasClock && parsed.hasSeconds;
}

/**
 * 是否已经是绝对日期时间（含 "2026-11-05 18:30" 这类缺秒写法）。
 * 历史数据迁移用它判断「合法记录跳过不修改」。
 */
export function isAbsoluteTime(value: string): boolean {
  const parsed = parseAbsoluteTime(value);
  return parsed !== null && parsed.hasClock;
}

/** 把 Date / 时间戳 / "YYYY-MM-DD HH:mm:ss" 统一成基准 Date；无效时回落到当前时刻 */
function resolveBase(input?: Date | number | string): Date {
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? new Date() : new Date(input.getTime());
  }

  if (typeof input === "number") {
    const date = new Date(input);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }

  if (typeof input === "string") {
    const absolute = parseAbsoluteTime(input);
    if (absolute) return absolute.date;

    const fallback = new Date(input.trim());
    if (!Number.isNaN(fallback.getTime())) return fallback;
  }

  return new Date();
}

/**
 * 无年份中文日期的基准年：按基准年构造出的月日若早于基准日 00:00，则视为次年。
 * 例：12 月里写「1 月 5 日」，得到的是明年 1 月 5 日，而不是今年已经过去的 1 月 5 日。
 */
function resolveYearForMonthDay(base: Date, month: number, day: number): number {
  const year = base.getFullYear();
  const startOfToday = new Date(year, base.getMonth(), base.getDate());
  const candidate = new Date(year, month - 1, day);
  return candidate.getTime() < startOfToday.getTime() ? year + 1 : year;
}

/* ---------------------------- 模糊期限（按基准时刻换算） ---------------------------- */

function endOfDay(year: number, month: number, day: number): Date {
  return new Date(year, month, day, 23, 59, 59, 0);
}

/** 本周的某一天（周一为一周起点）：targetDay 与 Date.getDay() 一致，0=周日 … 6=周六 */
function thisWeekDay(base: Date, targetDay: number): Date {
  const mondayIndex = (base.getDay() + 6) % 7;
  const targetIndex = (targetDay + 6) % 7;
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate() + targetIndex - mondayIndex,
  );
}

/** 「N天内 / N日以内」→ N（>0），解析不出返回 null */
function daysWithinOffset(text: string): number | null {
  const match = text.match(
    /([一二两三四五六七八九十]{1,3}|\d{1,2})\s*[天日]\s*(?:之|以)?内/,
  );
  const raw = match?.[1];
  if (!raw) return null;

  const value = /^\d+$/.test(raw) ? Number(raw) : cnNumberToValue(raw);
  return value !== null && value > 0 ? value : null;
}

/**
 * 模糊期限 → 具体截止时刻（当天 23:59:59）：
 * 下周末 / 本周末前 / 本周内 / 下月底 / 月底 / N天内。
 */
function parseFuzzyDeadline(text: string, base: Date): Date | null {
  if (/下(?:个)?周末/.test(text)) {
    const sunday = thisWeekDay(base, 0);
    return endOfDay(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 7);
  }

  if (/本周(?:末|前)|这周末|周末前/.test(text)) {
    const sunday = thisWeekDay(base, 0);
    return endOfDay(sunday.getFullYear(), sunday.getMonth(), sunday.getDate());
  }

  if (/本周内|这周内/.test(text)) {
    const friday = thisWeekDay(base, 5);
    return endOfDay(friday.getFullYear(), friday.getMonth(), friday.getDate());
  }

  if (/下个?月底|下月末/.test(text)) {
    const lastDay = new Date(base.getFullYear(), base.getMonth() + 2, 0);
    return endOfDay(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate());
  }

  if (/月底|月末/.test(text)) {
    const lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0);
    return endOfDay(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate());
  }

  const days = daysWithinOffset(text);
  if (days !== null) {
    return endOfDay(base.getFullYear(), base.getMonth(), base.getDate() + days);
  }

  return null;
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
 *  - 模糊期限：两天内 / 本周内 / 本周末前 / 下周末 / 月底 / 下月底（解析为当天 23:59:59）
 *
 * baseInput 是本次换算的基准时刻（Date / 时间戳 / "YYYY-MM-DD HH:mm:ss"）：
 * 相对词全部以它为起点，缺省取当前时刻，旧调用（不传第二个参数）行为不变。
 *
 * 只写了日期、没写时刻时（如「明天」「2026年11月15日」）统一按基准日 10:00:00 处理；
 * 没有日期线索时以基准日为「今天」；既没有日期也没有时刻（如「尽快」）返回 null。
 */
export function parseMemoTime(
  raw: string,
  baseInput?: Date | number | string,
): Date | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  // 基准时刻：所有相对词（今天 / 明天 / 周X / 两天内…）都以它为起点换算。
  // 不传时取当前时刻，保持旧调用的解析行为不变。
  const base = resolveBase(baseInput);

  /* ---------- ③-0 模糊期限：两天内 / 本周末前 / 月底 … ---------- */
  const fuzzy = parseFuzzyDeadline(text, base);
  if (fuzzy) return fuzzy;

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

  /* ---------- ③-3 时段修正：下午两点 → 14 点；没写时刻则兜底 10:00 ---------- */
  const period = clock
    ? applyPeriod(text, clock.hour)
    : { hour: DEFAULT_HOUR, dayShift: 0 };
  const hour = period.hour;
  const minute = clock ? clock.minute : 0;
  const second = clock ? clock.second : 0;

  /* ---------- ③-4 日期解析（优先级：显式日期 > 后天/明天/今天 > 周X > 默认今天） ---------- */

  // 4.1 显式日期：2026年11月15日 / 11月15日（缺年份时按基准年，已过去则顺延到次年）
  const cnDate = text.match(/(?:(\d{4})\s*年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  const cnMonth = cnDate?.[2];
  const cnDay = cnDate?.[3];
  if (cnMonth && cnDay) {
    const month = Number(cnMonth);
    const day = Number(cnDay);
    const year = cnDate?.[1] ? Number(cnDate[1]) : resolveYearForMonthDay(base, month, day);
    const date = new Date(year, month - 1, day, hour, minute, second);

    // 非法日期（2 月 30 日之类）会被 Date 自动进位，这里拦掉
    if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;

    // 「晚上十二点」这类跨到次日 00:00 的写法，日期也要一起顺延
    if (period.dayShift) date.setDate(date.getDate() + period.dayShift);
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
    if (period.dayShift) date.setDate(date.getDate() + period.dayShift);
    return date;
  }

  const now = base;

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
    now.getDate() + (dayOffset ?? 0) + period.dayShift,
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
export function toStandardTime(
  raw: string,
  baseInput?: Date | number | string,
): string {
  const date = parseMemoTime(raw, baseInput);
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
