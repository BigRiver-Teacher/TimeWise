// server/db.js
// 创建 / 连接本地 SQLite 数据库，并初始化 memos 表
const path = require('node:path');
const Database = require('better-sqlite3');

// 数据库文件就放在 server 目录下，和代码一起，方便查看与备份
const dbPath = path.join(__dirname, 'memo.db');
const db = new Database(dbPath);

// WAL 模式：读写并发更友好，异常退出后也不容易损坏
db.pragma('journal_mode = WAL');

// 已有数据库（表已存在，CREATE TABLE IF NOT EXISTS 不会补列）需要手动执行一次：
//   ALTER TABLE memos ADD COLUMN originText TEXT NOT NULL DEFAULT '';
//   ALTER TABLE memos ADD COLUMN keyPoints TEXT NOT NULL DEFAULT '[]';
// completedAt 由下面的幂等迁移自动补列，无需手动执行
db.exec(`
  CREATE TABLE IF NOT EXISTS memos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    time       TEXT    NOT NULL DEFAULT '',
    priority   TEXT    NOT NULL DEFAULT 'medium',
    type       TEXT    NOT NULL DEFAULT '日常',
    aiSummary  TEXT    NOT NULL DEFAULT '',
    originText TEXT    NOT NULL DEFAULT '',
    -- AI 要点：JSON 数组字符串，例如 ["截止时间：11月15日","注意事项：严禁抄袭"]
    keyPoints  TEXT    NOT NULL DEFAULT '[]',
    completed  INTEGER NOT NULL DEFAULT 0,
    -- 真实完成时间：本地时间 "YYYY-MM-DD HH:mm:ss"，未完成 / 历史数据为空串
    completedAt TEXT   NOT NULL DEFAULT '',
    -- 提醒配置：JSON 字符串，例如 {"notifyAt":"","override":false,"manualReminders":[6,3]}
    reminderConfig TEXT NOT NULL DEFAULT '',
    createdAt  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

/**
 * 幂等列迁移：老库缺列时自动补上，已有列直接跳过。
 * - 启动时执行一次，重复启动不会报错、不会重复加列
 * - ALTER TABLE 本身是原子操作，迁移中断后重启会重新检查并补齐
 */
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return;

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn('memos', 'completedAt', "TEXT DEFAULT ''");
// 老库升级：补 reminderConfig 列，默认空串（解析失败由前端退化为默认配置）
ensureColumn('memos', 'reminderConfig', "TEXT NOT NULL DEFAULT ''");

module.exports = db;
