const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const scheduler = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── API: 案件列表 ─────────────────────────────────────────────
app.get('/api/cases', (req, res) => {
  try {
    const {
      q = '', year = '', state = '', firm = '', status = '',
      page = 1, limit = 20, sort = 'date_filed', dir = 'desc',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;
    const SAFE_SORTS = ['date_filed','plaintiff','state','law_firm','case_number'];
    const sortCol = SAFE_SORTS.includes(sort) ? sort : 'date_filed';
    const sortDir = dir === 'asc' ? 'ASC' : 'DESC';

    const wheres = [], params = [];
    if (q) {
      wheres.push(`(plaintiff LIKE ? OR brand LIKE ? OR case_number LIKE ? OR law_firm LIKE ? OR case_name LIKE ?)`);
      const p = `%${q}%`;
      params.push(p, p, p, p, p);
    }
    if (year) { wheres.push(`strftime('%Y', date_filed) = ?`); params.push(year); }
    if (state) { wheres.push(`state = ?`); params.push(state.toUpperCase()); }
    if (firm) { wheres.push(`law_firm LIKE ?`); params.push(`%${firm}%`); }
    if (status) { wheres.push(`status = ?`); params.push(status); }

    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';

    const countRow = db.queryOne(`SELECT COUNT(*) as total FROM cases ${where}`, params);
    const rows = db.query(
      `SELECT id, case_number, case_name, plaintiff, state, court_id, law_firm, brand,
              date_filed, status, defendant_count, source_url
       FROM cases ${where}
       ORDER BY ${sortCol} ${sortDir}
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    res.json({ total: countRow.total, page: pageNum, limit: limitNum, data: rows });
  } catch (err) {
    console.error('/api/cases error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: 单条详情 ─────────────────────────────────────────────
app.get('/api/cases/:id', (req, res) => {
  try {
    const row = db.queryOne('SELECT * FROM cases WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: 统计 ─────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const month = today.substring(0, 7);
    const total   = db.queryOne(`SELECT COUNT(*) as n FROM cases`);
    const todayN  = db.queryOne(`SELECT COUNT(*) as n FROM cases WHERE date_filed = ?`, [today]);
    const monthN  = db.queryOne(`SELECT COUNT(*) as n FROM cases WHERE strftime('%Y-%m', date_filed) = ?`, [month]);
    const lastSync = db.queryOne(`SELECT ended_at, inserted FROM sync_log ORDER BY id DESC LIMIT 1`);
    const daily   = db.query(`SELECT date_filed as day, COUNT(*) as count FROM cases WHERE date_filed >= date('now','-14 days') GROUP BY date_filed ORDER BY date_filed`);
    const byState = db.query(`SELECT state, COUNT(*) as count FROM cases GROUP BY state ORDER BY count DESC LIMIT 10`);
    const syncStatus = scheduler.getStatus();
    res.json({
      total: total?.n || 0,
      today: todayN?.n || 0,
      this_month: monthN?.n || 0,
      last_sync: lastSync?.ended_at || null,
      syncing: syncStatus.running,
      daily_trend: daily,
      by_state: byState,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: 律所排行 ─────────────────────────────────────────────
app.get('/api/firms', (req, res) => {
  try {
    const { year } = req.query;
    const where = year
      ? `WHERE strftime('%Y', date_filed)='${parseInt(year)}' AND law_firm!=''`
      : `WHERE law_firm!=''`;
    const rows = db.query(`SELECT law_firm, COUNT(*) as count FROM cases ${where} GROUP BY law_firm ORDER BY count DESC LIMIT 15`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: 品牌排行 ─────────────────────────────────────────────
app.get('/api/brands', (req, res) => {
  try {
    const rows = db.query(`SELECT brand, COUNT(*) as count FROM cases WHERE brand!='' AND brand NOT LIKE '%待确认%' GROUP BY brand ORDER BY count DESC LIMIT 20`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: 手动触发同步 ─────────────────────────────────────────
app.post('/api/sync', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token !== (process.env.ADMIN_TOKEN || 'tro-admin-2024')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  scheduler.triggerNow();
  res.json({ ok: true, message: '已触发增量同步' });
});

// ── API: 健康检查 ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  const row = db.queryOne('SELECT COUNT(*) as n FROM cases');
  res.json({ ok: true, cases: row?.n || 0, time: new Date().toISOString() });
});

// ── 前端静态文件 ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── 启动 ──────────────────────────────────────────────────────
db.initSchema();
scheduler.start();

app.listen(PORT, () => {
  console.log(`\n🚀 TRO查询系统已启动: http://localhost:${PORT}`);
  console.log(`📊 健康检查: http://localhost:${PORT}/health`);
  console.log(`🔑 CourtListener Token: ${(process.env.COURTLISTENER_TOKEN || '').substring(0, 8)}...`);
});
