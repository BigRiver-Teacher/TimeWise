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
    createdAt  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

module.exports = db;
