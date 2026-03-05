const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'tro.db'));

// 性能优化
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cases (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      case_number    TEXT NOT NULL,
      case_name      TEXT DEFAULT '',
      plaintiff      TEXT DEFAULT '',
      state          TEXT DEFAULT '',
      court_id       TEXT DEFAULT '',
      law_firm       TEXT DEFAULT '',
      brand          TEXT DEFAULT '',
      date_filed     TEXT NOT NULL,
      nature_of_suit TEXT DEFAULT '',
      status         TEXT DEFAULT 'active',
      defendant_count INTEGER DEFAULT 1,
      source_url     TEXT DEFAULT '',
      docket_id      INTEGER,
      created_at     TEXT DEFAULT (datetime('now')),
      updated_at     TEXT DEFAULT (datetime('now')),
      UNIQUE(case_number, court_id)
    );
    CREATE INDEX IF NOT EXISTS idx_date   ON cases(date_filed DESC);
    CREATE INDEX IF NOT EXISTS idx_state  ON cases(state);
    CREATE INDEX IF NOT EXISTS idx_firm   ON cases(law_firm);
    CREATE INDEX IF NOT EXISTS idx_status ON cases(status);

    CREATE TABLE IF NOT EXISTS sync_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT DEFAULT (datetime('now')),
      ended_at   TEXT,
      mode       TEXT,
      fetched    INTEGER DEFAULT 0,
      inserted   INTEGER DEFAULT 0,
      updated    INTEGER DEFAULT 0,
      errors     INTEGER DEFAULT 0,
      message    TEXT
    );
  `);
  console.log('[DB] 数据库初始化完成');
}

// 统一查询接口（兼容异步风格）
function query(sql, params = []) {
  const stmt = db.prepare(sql);
  if (/^\s*(SELECT|PRAGMA)/i.test(sql)) {
    return stmt.all(...params);
  } else {
    return stmt.run(...params);
  }
}

// 单行查询
function queryOne(sql, params = []) {
  return db.prepare(sql).get(...params);
}

module.exports = { query, queryOne, initSchema, db };
