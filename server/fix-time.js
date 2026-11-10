// server/fix-time.js
// 历史数据迁移：把 memos.time 里的相对时间（「明天」「今天 18:00」「本周末前」…）
// 按每条记录自身的 createdAt 一次性改写成绝对时间（YYYY-MM-DD HH:mm:ss）。
//
// 用法（在项目根目录）：
//   node server/fix-time.js             # 预演：只打印将要改成什么，不写库
//   node server/fix-time.js --apply     # 真正写库（写前自动备份成 server/memos-<时间>.bak）
//
// 说明：解析规则与 src/utils/memoTime.ts 保持一致（纯 JS 重写一份，脚本可以直接跑，
// 不需要先编译 TypeScript）。重复执行是安全的：
//   - 已是合法绝对时间的记录跳过不修改；
//   - createdAt 缺失 / 格式异常的记录跳过并在预演清单里列出；
//   - 只修改 time 字段，不触碰其他列。

const path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'memo.db');
const APPLY = process.argv.includes('--apply');

/* ---------------------------- 基础工具 ---------------------------- */

function pad(value) {
  return String(value).padStart(2, '0');
}

/** 没有具体时刻时的兜底小时：上午 10 点（不用 0 点，避免一入库就「过期」） */
const DEFAULT_HOUR = 10;

function formatStandardTime(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/* ---------------------------- 绝对时间识别 ---------------------------- */

const ABSOLUTE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** 解析已经是绝对日期时间的文本；非法日期返回 null */
function parseAbsoluteTime(value) {
  const match = ABSOLUTE_TIME_PATTERN.exec((value || '').trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);

  if (!isValidClock(hour, minute, second)) return null;

  const date = new Date(year, month - 1, day, hour, minute, second);
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

/** 是否已经是标准格式 "YYYY-MM-DD HH:mm:ss" */
function isStandardTime(value) {
  const parsed = parseAbsoluteTime(value);
  return parsed !== null && parsed.hasClock && parsed.hasSeconds;
}

/** 是否已经是绝对日期时间（含 "2026-11-05 18:30" 这类缺秒写法） */
function isAbsoluteTime(value) {
  const parsed = parseAbsoluteTime(value);
  return parsed !== null && parsed.hasClock;
}

/** 把 Date / 时间戳 / "YYYY-MM-DD HH:mm:ss" 统一成基准 Date；无效时回落到当前时刻 */
function resolveBase(input) {
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? new Date() : new Date(input.getTime());
  }

  if (typeof input === 'number') {
    const date = new Date(input);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }

  if (typeof input === 'string') {
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
function resolveYearForMonthDay(base, month, day) {
  const year = base.getFullYear();
  const startOfToday = new Date(year, base.getMonth(), base.getDate());
  const candidate = new Date(year, month - 1, day);
  return candidate.getTime() < startOfToday.getTime() ? year + 1 : year;
}

/* ---------------------------- 中文数字 → 阿拉伯数字 ---------------------------- */

const CN_DIGITS = {
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

function cnNumberToValue(cn) {
  const text = (cn || '').trim();
  if (!text) return null;

  const tenIndex = text.indexOf('十');
  if (tenIndex === -1) {
    const single = CN_DIGITS[text];
    return single === undefined ? null : single;
  }

  const head = text.slice(0, tenIndex);
  const tail = text.slice(tenIndex + 1);
  if (tail.length > 1) return null;

  const tens = head ? CN_DIGITS[head] : 1;
  if (tens === undefined) return null;

  const ones = tail ? CN_DIGITS[tail] : 0;
  if (ones === undefined) return null;

  return tens * 10 + ones;
}

/** 「N点」后面跟这些字符时基本可以认定是时刻 */
function isClockFollower(next) {
  if (!next) return true;
  return /[\s，。、；：,.;:!！?？（）()\-~～—…半整钟刻分到至左右前后]/.test(next);
}

const CLOCK_LEADERS =
  /今天|今日|明天|明日|后天|昨天|今晚|明早|明晚|上午|下午|中午|早上|早晨|凌晨|晚上|傍晚|夜里|夜间|周[一二三四五六日天1-7]|星期|礼拜|[日号]/;

/**
 * 「N点」后面紧跟这些名词时，中文数字是在计数而不是报时刻：
 * 三点建议 / 两点要求 / 一点注意。这类写法保持原文，绝不折算成 03:00 / 02:00 / 01:00。
 */
const QUANTIFIER_NOUNS =
  /^(?:建议|要求|注意|意见|结论|事项|内容|问题|方法|原则|步骤|要点|想法|感受|变化)/;

/** 两点 → 2点、十点半 → 10点半、九点二十分 → 9点20分 */
function normalizeChineseClock(text) {
  if (!/[\u4e00-\u9fa5]/.test(text)) return text;

  let result = text.replace(
    /([一二两三四五六七八九十]{1,3})(\s*)([点时])/g,
    (match, cn, space, unit, offset) => {
      const value = cnNumberToValue(cn);
      if (value === null) return match;

      const next = text.charAt(offset + match.length);
      if (next === '点' || next === '儿') return match;

      // 「三点建议」「两点要求」「一点注意」：数字后面接的是名词，属于计数，保持原样
      if (QUANTIFIER_NOUNS.test(text.slice(offset + match.length))) return match;

      if (cn === '一' || cn === '两') {
        const before = text.slice(0, offset);
        if (!isClockFollower(next) && !CLOCK_LEADERS.test(before)) return match;
      }

      return `${value}${space}${unit}`;
    },
  );

  result = result.replace(
    /([点时])(\s*)([一二两三四五六七八九十]{1,3})(\s*)(分)/g,
    (match, unit, space1, cn, space2) => {
      const value = cnNumberToValue(cn);
      return value === null ? match : `${unit}${space1}${value}${space2}分`;
    },
  );

  result = result.replace(
    /([点时])(\s*)([一二两三四五六七八九十]{1,3})(?=\s*(?:$|[，。、；：,.;:!！?？]))/g,
    (match, unit, space, cn) => {
      const value = cnNumberToValue(cn);
      return value === null ? match : `${unit}${space}${value}分`;
    },
  );

  return result;
}

/* ---------------------------- 时刻 / 日期工具 ---------------------------- */

function isValidClock(hour, minute, second) {
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
function applyPeriod(text, hour) {
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

function relativeDayOffset(text) {
  if (text.includes('大后天')) return 3;
  if (text.includes('后天')) return 2;
  if (/明天|明日|明早|明晚/.test(text)) return 1;
  if (/今天|今日|今晚|今早|今儿/.test(text)) return 0;
  if (text.includes('昨天')) return -1;
  return null;
}

function weekdayOffset(text, today) {
  const match = text.match(/(?:周|星期|礼拜)([一二三四五六日天1-7])/);
  const key = match && match[1];
  if (!key) return null;

  const weekMap = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    日: 0,
    天: 0,
    1: 1,
    2: 2,
    3: 3,
    4: 4,
    5: 5,
    6: 6,
    7: 0,
  };
  const targetDay = weekMap[key];
  if (targetDay === undefined) return null;

  const offset = (targetDay - today.getDay() + 7) % 7;
  return /下周|下星期|下礼拜/.test(text) ? offset + 7 : offset;
}

/* ---------------------------- 模糊期限 ---------------------------- */

function endOfDay(year, month, day) {
  return new Date(year, month, day, 23, 59, 59, 0);
}

/** 本周的某一天（周一为一周起点）：targetDay 同 Date.getDay()，0=周日 … 6=周六 */
function thisWeekDay(today, targetDay) {
  const mondayIndex = (today.getDay() + 6) % 7;
  const targetIndex = (targetDay + 6) % 7;
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + targetIndex - mondayIndex);
}

function daysWithinOffset(text) {
  const match = text.match(/([一二两三四五六七八九十]{1,3}|\d{1,2})\s*[天日]\s*(?:之|以)?内/);
  const raw = match && match[1];
  if (!raw) return null;

  const value = /^\d+$/.test(raw) ? Number(raw) : cnNumberToValue(raw);
  if (value === null || value <= 0) return null;
  return value;
}

function parseFuzzyDeadline(text, today) {
  if (/下(?:个)?周末/.test(text)) {
    const sunday = thisWeekDay(today, 0);
    return endOfDay(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 7);
  }

  if (/本周(?:末|前)|这周末|周末前/.test(text)) {
    const sunday = thisWeekDay(today, 0);
    return endOfDay(sunday.getFullYear(), sunday.getMonth(), sunday.getDate());
  }

  if (/本周内|这周内/.test(text)) {
    const friday = thisWeekDay(today, 5);
    return endOfDay(friday.getFullYear(), friday.getMonth(), friday.getDate());
  }

  if (/下个?月底|下月末/.test(text)) {
    const lastDay = new Date(today.getFullYear(), today.getMonth() + 2, 0);
    return endOfDay(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate());
  }

  if (/月底|月末/.test(text)) {
    const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    return endOfDay(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate());
  }

  const days = daysWithinOffset(text);
  if (days !== null) {
    return endOfDay(today.getFullYear(), today.getMonth(), today.getDate() + days);
  }

  return null;
}

/* ---------------------------- 主解析函数（与 memoTime.ts 对齐） ---------------------------- */

/**
 * 把自由格式的时间文本解析成 Date。
 * baseInput 是本次换算的基准时刻（Date / 时间戳 / "YYYY-MM-DD HH:mm:ss"），
 * 相对词全部以它为起点；不传时取当前时刻。
 */
function parseMemoTime(raw, baseInput) {
  const text = (raw || '').trim();
  if (!text) return null;

  const base = resolveBase(baseInput);

  // 0) 模糊期限兜底：本周末 / 本周内 / 月底 / N天内
  const fuzzy = parseFuzzyDeadline(text, base);
  if (fuzzy) return fuzzy;

  // 1) 中文数字转阿拉伯数字
  const normalized = normalizeChineseClock(text);

  // 2) 抽时刻：冒号优先，其次「点 / 时」
  let clock = null;

  const colonMatch = normalized.match(/(\d{1,2})[:：](\d{1,2})(?:[:：](\d{1,2}))?/);
  if (colonMatch) {
    const hour = Number(colonMatch[1]);
    const minute = Number(colonMatch[2]);
    const second = colonMatch[3] ? Number(colonMatch[3]) : 0;
    if (isValidClock(hour, minute, second)) clock = { hour, minute, second };
  }

  if (!clock) {
    const dotPattern = /(\d{1,2})\s*[点时](?:\s*(半)|(\d{1,2})\s*分)?/g;
    let dotMatch = dotPattern.exec(normalized);

    while (dotMatch) {
      const hour = Number(dotMatch[1]);
      const minute = dotMatch[2] === '半' ? 30 : dotMatch[3] ? Number(dotMatch[3]) : 0;

      const prevChar = normalized.charAt(dotMatch.index - 1);
      const isOrdinal = /[第其哪这那几]/.test(prevChar);

      if (!isOrdinal && isValidClock(hour, minute, 0)) {
        clock = { hour, minute, second: 0 };
        break;
      }

      dotMatch = dotPattern.exec(normalized);
    }
  }

  // 3) 时段修正；没写时刻就兜底 10:00
  const period = clock ? applyPeriod(text, clock.hour) : { hour: DEFAULT_HOUR, dayShift: 0 };
  const hour = period.hour;
  const minute = clock ? clock.minute : 0;
  const second = clock ? clock.second : 0;

  // 4) 日期：显式日期 > 大后天/后天/明天/今天 > 周X
  const cnDate = text.match(/(?:(\d{4})\s*年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  const cnMonth = cnDate && cnDate[2];
  const cnDay = cnDate && cnDate[3];
  if (cnMonth && cnDay) {
    const month = Number(cnMonth);
    const day = Number(cnDay);
    const year = cnDate[1] ? Number(cnDate[1]) : resolveYearForMonthDay(base, month, day);
    const date = new Date(year, month - 1, day, hour, minute, second);

    if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;

    // 「晚上十二点」这类跨到次日 00:00 的写法，日期也要一起顺延
    if (period.dayShift) date.setDate(date.getDate() + period.dayShift);
    return date;
  }

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
  const relativeOffset = relativeDayOffset(text);
  const weekOffset = relativeOffset === null ? weekdayOffset(text, now) : null;
  const dayOffset = relativeOffset === null ? weekOffset : relativeOffset;

  if (dayOffset === null && !clock) return null;

  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + (dayOffset === null ? 0 : dayOffset) + period.dayShift,
    hour,
    minute,
    second,
  );
}

/* ---------------------------- 可复用的标准化函数 ---------------------------- */

/**
 * 把任意 time 文本标准化成 "YYYY-MM-DD HH:mm:ss"。
 * - undefined / null / 空串 → 空串（表示未记录时间）
 * - 已是绝对时间 → 归一成标准格式
 * - 相对词 → 按 base 换算（POST 用请求时刻，PUT / 迁移用记录 createdAt）
 * - 无法解析 → { ok: false, reason }
 *
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }}
 */
function normalizeMemoTime(raw, base) {
  if (raw === undefined || raw === null) return { ok: true, value: '' };
  if (typeof raw !== 'string') return { ok: false, reason: 'time 必须是字符串' };

  const text = raw.trim();
  if (!text) return { ok: true, value: '' };

  if (isAbsoluteTime(text)) {
    const absolute = parseAbsoluteTime(text);
    return { ok: true, value: formatStandardTime(absolute.date) };
  }

  const parsed = parseMemoTime(text, base);
  if (!parsed) return { ok: false, reason: `无法识别的时间：${text}` };

  return { ok: true, value: formatStandardTime(parsed) };
}

/* ---------------------------- 迁移主流程 ---------------------------- */

/** 备份文件名用的时间戳：YYYYMMDD-HHmmss */
function backupStamp(date) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** createdAt 至少要像 "YYYY-MM-DD ..." 才能当作换算基准 */
const CREATED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}/;

function main() {
  const db = new Database(DB_PATH);

  try {
    const rows = db.prepare('SELECT id, title, time, createdAt FROM memos ORDER BY id').all();
    const update = db.prepare('UPDATE memos SET time = ? WHERE id = ?');

    const changes = [];
    const skipped = [];

    for (const row of rows) {
      const current = (row.time || '').trim();
      const createdAt = (row.createdAt || '').trim();

      if (!current) {
        skipped.push({ id: row.id, title: row.title, from: '(空)', reason: '未记录时间，保持不变' });
        continue;
      }

      // 已是合法绝对时间：跳过不修改，保证重复执行幂等
      if (isAbsoluteTime(current)) continue;

      if (!CREATED_AT_PATTERN.test(createdAt)) {
        skipped.push({
          id: row.id,
          title: row.title,
          from: current,
          reason: `createdAt 缺失或格式异常（${createdAt || '空'}），无法确定换算基准`,
        });
        continue;
      }

      // 一律以该记录自己的 createdAt 为基准，绝不用迁移当天的日期
      const parsed = parseMemoTime(current, createdAt);
      if (!parsed) {
        // 解析不出具体时间（如「未提及」「开展阶段 开展阶段」）：统一置空，
        // 不保留原文、不伪造「今天 10:00」
        changes.push({ id: row.id, title: row.title, from: current, to: '', reason: '无法解析，置空' });
        continue;
      }

      const next = formatStandardTime(parsed);
      if (next !== current) {
        changes.push({ id: row.id, title: row.title, from: current, to: next });
      }
    }

    console.log(`数据库：${DB_PATH}`);
    console.log(`共 ${rows.length} 条记录，需要改写 ${changes.length} 条，跳过 ${skipped.length} 条。`);

    if (changes.length) {
      console.log('\n将要改写的记录：');
      for (const item of changes) {
        console.log(`  #${item.id} ${item.title}`);
        console.log(`      ${item.from}  →  ${item.to || '(空)'}${item.reason ? `  （${item.reason}）` : ''}`);
      }
    }

    if (skipped.length) {
      console.log('\n跳过的记录：');
      for (const item of skipped) {
        console.log(`  #${item.id} ${item.title}  （${item.from}）  ${item.reason}`);
      }
    }

    if (!APPLY) {
      console.log('\n这是预演，没有写库。确认无误后执行：node server/fix-time.js --apply');
      return;
    }

    if (!changes.length) {
      console.log('\n没有需要改写的记录，数据库保持不变。');
      return;
    }

    // 写库前做一份一致性备份（VACUUM INTO 在 WAL 模式下也是安全快照），
    // 备份文件保留在原处，不会被脚本删除。
    const backupPath = path.join(__dirname, `memos-${backupStamp(new Date())}.bak`);
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    console.log(`\n已备份数据库到：${backupPath}`);

    try {
      const applyAll = db.transaction((items) => {
        for (const item of items) update.run(item.to, item.id);
      });
      applyAll(changes);
    } catch (error) {
      console.error(`\n迁移失败：${error.message}`);
      console.error(`事务已回滚，数据库未被改动；备份保留在：${backupPath}`);
      console.error(`如需手动回滚：copy "${backupPath}" "${DB_PATH}"`);
      process.exitCode = 1;
      return;
    }

    console.log(`已更新 ${changes.length} 条记录的时间字段。`);
  } finally {
    db.close();
  }
}

module.exports = {
  normalizeMemoTime,
  parseMemoTime,
  formatStandardTime,
  isStandardTime,
  isAbsoluteTime,
};

// 供 server.js require 复用；直接 node server/fix-time.js 时才执行迁移
if (require.main === module) main();
