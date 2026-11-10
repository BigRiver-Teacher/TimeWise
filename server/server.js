// server/server.js
// 智能备忘录 · 本地后端（Express + better-sqlite3）
const express = require('express');
const cors = require('cors');
const WordExtractor = require('word-extractor');
const db = require('./db');
// 与迁移脚本共用同一套时间标准化逻辑，保证接口写入和修数据结果一致
const { normalizeMemoTime } = require('./fix-time');

const app = express();
const PORT = 3000;

// word-extractor 负责解析 Word 97-2003 的 .doc（浏览器端跑不了这个库）
const wordExtractor = new WordExtractor();

// 允许前端（默认 http://localhost:5178）跨域访问
app.use(cors());
// 解析 JSON 请求体（/api/extract-doc 自己用 raw 中间件处理二进制）
app.use(express.json());

/* ------------------------------ 小工具 ------------------------------ */

/** 数据库里 completed 是 0/1，返回给前端统一转成布尔值 */
function toMemo(row) {
  if (!row) return row;
  return {
    ...row,
    completed: Boolean(row.completed),
    // keyPoints 在库里是 JSON 字符串，出库时还原成数组给前端直接用
    keyPoints: parseKeyPoints(row.keyPoints),
    // 提醒配置保持 JSON 字符串出库，解析与兜底由前端负责
    reminderConfig:
      typeof row.reminderConfig === 'string' ? row.reminderConfig : '',
  };
}

/**
 * 把出参里的 keyPoints 还原成字符串数组。
 * 脏数据（空串 / 非数组 / JSON 损坏）统一返回空数组，避免前端渲染崩掉。
 */
function parseKeyPoints(raw) {
  if (Array.isArray(raw)) return raw.filter((item) => typeof item === 'string');
  if (typeof raw !== 'string' || !raw.trim()) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item) => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * 把入参里的 keyPoints 收敛成 JSON 字符串入库：
 * 只收字符串、去空、去重、最多 6 条；不合法时沿用 fallback（更新场景保留原值）。
 */
function normalizeKeyPoints(value, fallback = '[]') {
  if (!Array.isArray(value)) return fallback;

  const points = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;

    const text = item.trim();
    if (!text || points.includes(text)) continue;

    points.push(text);
    if (points.length >= 6) break;
  }

  return JSON.stringify(points);
}

/** 把 true/false、0/1 统一成布尔；其他值返回 null 表示不合法 */
function normalizeCompleted(value) {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return Boolean(value);
  return null;
}

/**
 * reminderConfig 统一按 TEXT 存取：只接受字符串（前端序列化后的 JSON），
 * 其他类型视为非法，更新场景沿用 fallback（即库中原值）。
 */
function normalizeReminderConfig(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

/**
 * 当前本地时间，格式 "YYYY-MM-DD HH:mm:ss"，
 * 与库里 time / createdAt 的格式保持一致，便于直接比较。
 */
function formatLocalNow() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');

  return [
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
  ].join(' ');
}

function normalizePriority(value) {
  return ['high', 'medium', 'low'].includes(value) ? value : 'medium';
}

function normalizeText(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

/* ------------------------------ 预处理语句 ------------------------------ */

const listStmt = db.prepare(`
  SELECT * FROM memos
  ORDER BY datetime(createdAt) DESC, id DESC
`);

const insertStmt = db.prepare(`
  INSERT INTO memos (title, time, priority, type, aiSummary, originText, keyPoints, completed)
  VALUES (@title, @time, @priority, @type, @aiSummary, @originText, @keyPoints, @completed)
`);

const getByIdStmt = db.prepare('SELECT * FROM memos WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM memos WHERE id = ?');

/* ------------------------------ 路由 ------------------------------ */

// GET /api/memos：按创建时间降序返回所有待办
app.get('/api/memos', (req, res) => {
  try {
    const rows = listStmt.all();
    res.json(rows.map(toMemo));
  } catch (error) {
    console.error('[GET /api/memos]', error);
    res.status(500).json({ error: '查询待办失败' });
  }
});

// POST /api/memos：新增一条待办，返回带自增 id 的完整数据
app.post('/api/memos', (req, res) => {
  try {
    const body = req.body ?? {};
    const title = normalizeText(body.title, '').trim();

    if (!title) {
      return res.status(400).json({ error: 'title 不能为空' });
    }

    const completed = normalizeCompleted(body.completed) ?? false;

    // 以请求时刻为基准把相对时间词一次性固化；无法解析直接拒绝，绝不原样落库
    const time = normalizeMemoTime(body.time, new Date());
    if (!time.ok) {
      return res.status(400).json({ error: `time 不合法：${time.reason}` });
    }

    const info = insertStmt.run({
      title,
      time: time.value,
      priority: normalizePriority(body.priority),
      type: normalizeText(body.type, '日常'),
      aiSummary: normalizeText(body.aiSummary, ''),
      originText: normalizeText(body.originText, ''),
      keyPoints: normalizeKeyPoints(body.keyPoints),
      completed: completed ? 1 : 0,
    });

    const row = getByIdStmt.get(info.lastInsertRowid);
    res.status(201).json(toMemo(row));
  } catch (error) {
    console.error('[POST /api/memos]', error);
    res.status(500).json({ error: '新增待办失败' });
  }
});

// PUT /api/memos/:id：支持两种用法
//   1) 只传 { completed } → 切换完成状态
//   2) 传 { title, time, priority, type, aiSummary, originText, keyPoints } → 全量更新（也可同时带 completed）
app.put('/api/memos/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'id 不合法' });
  }

  const existing = getByIdStmt.get(id);
  if (!existing) {
    return res.status(404).json({ error: '待办不存在' });
  }

  const body = req.body ?? {};
  // 只允许白名单字段更新，字段名不来自用户输入，拼接 SQL 是安全的
  const updates = {};

  if (body.title !== undefined) {
    const title = normalizeText(body.title, '').trim();
    if (!title) {
      return res.status(400).json({ error: 'title 不能为空' });
    }
    updates.title = title;
  }

  if (body.time !== undefined) {
    // 以原记录的 createdAt 为基准换算；只更新传入的字段，其他列保持不动
    const time = normalizeMemoTime(body.time, existing.createdAt);
    if (!time.ok) {
      return res.status(400).json({ error: `time 不合法：${time.reason}` });
    }
    updates.time = time.value;
  }
  if (body.type !== undefined) {
    updates.type = normalizeText(body.type, existing.type);
  }
  if (body.aiSummary !== undefined) {
    updates.aiSummary = normalizeText(body.aiSummary, existing.aiSummary);
  }
  if (body.originText !== undefined) {
    updates.originText = normalizeText(body.originText, existing.originText);
  }
  // keyPoints 是数组，合法才覆盖；不合法时保留原值，避免被一次脏请求清空
  if (body.keyPoints !== undefined) {
    updates.keyPoints = normalizeKeyPoints(body.keyPoints, existing.keyPoints);
  }
  if (body.priority !== undefined) {
    updates.priority = normalizePriority(body.priority);
  }
  // reminderConfig 只收字符串，其他类型保留原值，避免被一次脏请求清空
  if (body.reminderConfig !== undefined) {
    updates.reminderConfig = normalizeReminderConfig(
      body.reminderConfig,
      existing.reminderConfig || '',
    );
  }
  if (body.completed !== undefined) {
    const completed = normalizeCompleted(body.completed);
    if (completed === null) {
      return res.status(400).json({ error: 'completed 必须是布尔值' });
    }
    updates.completed = completed ? 1 : 0;
    // 完成时间只跟随完成状态显式变更：
    // 完成 → 写入当前本地时间（重复完成也覆盖为新值）；取消完成 → 清空
    updates.completedAt = completed ? formatLocalNow() : '';
  }

  const fields = Object.keys(updates);
  if (!fields.length) {
    return res.status(400).json({ error: '没有需要更新的字段' });
  }

  try {
    const sql = `UPDATE memos SET ${fields
      .map((field) => `${field} = @${field}`)
      .join(', ')} WHERE id = @id`;

    db.prepare(sql).run({ ...updates, id });

    res.json(toMemo(getByIdStmt.get(id)));
  } catch (error) {
    console.error('[PUT /api/memos/:id]', error);
    res.status(500).json({ error: '更新待办失败' });
  }
});

// DELETE /api/memos/:id：删除一条待办
app.delete('/api/memos/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'id 不合法' });
  }

  try {
    const info = deleteStmt.run(id);
    if (info.changes === 0) {
      return res.status(404).json({ error: '待办不存在' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[DELETE /api/memos/:id]', error);
    res.status(500).json({ error: '删除待办失败' });
  }
});

// POST /api/extract-doc：接收 .doc 二进制内容，用 word-extractor 提取纯文本
app.post(
  '/api/extract-doc',
  express.raw({ type: '*/*', limit: '20mb' }),
  async (req, res) => {
    try {
      const buffer = req.body;
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return res.status(400).json({ error: '没有收到文件内容' });
      }

      const document = await wordExtractor.extract(buffer);
      const text = document
        .getBody()
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      if (!text) {
        return res.status(422).json({ error: '.doc 里没有可提取的文字' });
      }

      res.json({ text });
    } catch (error) {
      console.error('[POST /api/extract-doc]', error);
      res.status(500).json({ error: '.doc 解析失败，请确认文件未加密且格式正确' });
    }
  },
);

// 其余 /api 路径统一返回 JSON 404，避免拿到 HTML
app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

/* ------------------------------ 启动 ------------------------------ */

const server = app.listen(PORT, () => {
  console.log(`智能备忘录后端已启动：http://localhost:${PORT}`);
  console.log('  GET    /api/memos');
  console.log('  POST   /api/memos');
  console.log('  PUT    /api/memos/:id   （completed 或全量字段）');
  console.log('  DELETE /api/memos/:id');
  console.log('  POST   /api/extract-doc （.doc → 纯文本）');
});

/** Ctrl+C 时先关数据库再退出，避免 WAL 文件残留 */
function shutdown() {
  server.close(() => {
    db.close();
    console.log('已关闭数据库连接，进程退出。');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
