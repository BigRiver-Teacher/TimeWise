// server/fix-time.js
// 历史数据迁移：把 memos.time 里的相对时间（「明天」「今天 18:00」「本周末前」…）
// 一次性改写成绝对时间（YYYY-MM-DD HH:mm:ss），让逾期判断和提醒重新生效。
//
// 用法（在项目根目录）：
//   node server/fix-time.js             # 预演：只打印将要改成什么，不写库
//   node server/fix-time.js --apply     # 真正写库（写前自动把库备份成 memo.db.bak-<时间>）
//   node server/fix-time.js --apply --fallback
//                                       # 连 time 为空的记录也补成「createdAt 当天 10:00:00」
//
// 说明：解析规则与 src/utils/memoTime.ts 保持一致（纯 JS 重写一份，脚本可以直接跑，
// 不需要先编译 TypeScript）。重复执行是安全的：已经是标准格式且能原样解析的记录不会被改。

const path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'memo.db');
const APPLY = process.argv.includes('--apply');
const FALLBACK = process.argv.includes('--fallback');

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

/** 下午/晚上 +12、中午 +12、凌晨 12 点归零；上午/早上保持原样 */
function applyPeriod(text, hour) {
  if (/下午|晚上|傍晚|夜里|夜间/.test(text) && hour < 12) return hour + 12;
  if (/中午|正午/.test(text) && hour < 11) return hour + 12;
  if (/凌晨/.test(text) && hour === 12) return 0;
  return hour;
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
  const match = text.match(/([一二两三四五六七八九十]{1,3}|\d{1,2})\s*天\s*(?:之|以)?内/);
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

function parseMemoTime(raw) {
  const text = (raw || '').trim();
  if (!text) return null;

  // 0) 模糊期限兜底：本周末 / 本周内 / 月底 / N天内
  const fuzzy = parseFuzzyDeadline(text, new Date());
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
  const hour = clock ? applyPeriod(text, clock.hour) : DEFAULT_HOUR;
  const minute = clock ? clock.minute : 0;
  const second = clock ? clock.second : 0;

  // 4) 日期：显式日期 > 大后天/后天/明天/今天 > 周X
  const cnDate = text.match(/(?:(\d{4})\s*年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  const cnMonth = cnDate && cnDate[2];
  const cnDay = cnDate && cnDate[3];
  if (cnMonth && cnDay) {
    const year = cnDate[1] ? Number(cnDate[1]) : new Date().getFullYear();
    const month = Number(cnMonth);
    const day = Number(cnDay);
    const date = new Date(year, month - 1, day, hour, minute, second);

    if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return date;
  }

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
  const relativeOffset = relativeDayOffset(text);
  const weekOffset = relativeOffset === null ? weekdayOffset(text, now) : null;
  const dayOffset = relativeOffset === null ? weekOffset : relativeOffset;

  if (dayOffset === null && !clock) return null;

  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + (dayOffset === null ? 0 : dayOffset),
    hour,
    minute,
    second,
  );
}

/* ---------------------------- 迁移主流程 ---------------------------- */

/** time 为空的记录：用 createdAt 的日期补一个 10:00:00 */
function fallbackFromCreatedAt(createdAt) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(createdAt || '');
  if (match) return `${match[1]}-${match[2]}-${match[3]} 10:00:00`;

  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} 10:00:00`;
}

function main() {
  const db = new Database(DB_PATH);

  try {
    const rows = db.prepare('SELECT id, title, time, createdAt FROM memos ORDER BY id').all();
    const update = db.prepare('UPDATE memos SET time = ? WHERE id = ?');

    const changes = [];
    const skipped = [];

    for (const row of rows) {
      const current = (row.time || '').trim();

      if (!current) {
        if (FALLBACK) {
          const next = fallbackFromCreatedAt(row.createdAt);
          changes.push({ id: row.id, title: row.title, from: '(空)', to: next });
        } else {
          skipped.push({ id: row.id, title: row.title, from: '(空)', reason: '没有时间，加 --fallback 才会补 10:00' });
        }
        continue;
      }

      const parsed = parseMemoTime(current);
      if (!parsed) {
        skipped.push({ id: row.id, title: row.title, from: current, reason: '解析不出具体时间' });
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
        console.log(`      ${item.from}  →  ${item.to}`);
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

    // 写库前做一份一致性备份（VACUUM INTO 在 WAL 模式下也是安全快照）
    const stamp = new Date()
      .toLocaleString('sv-SE')
      .replace(/[-: ]/g, '')
      .replace(/,/g, '');
    const backupPath = path.join(__dirname, `memo.db.bak-${stamp}`);
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    console.log(`\n已备份数据库到：${backupPath}`);

    const applyAll = db.transaction((items) => {
      for (const item of items) update.run(item.to, item.id);
    });
    applyAll(changes);

    console.log(`已更新 ${changes.length} 条记录的时间字段。`);
  } finally {
    db.close();
  }
}

main();
