const cron = require('node-cron');
const TROCrawler = require('./crawler');
const db = require('./db');

let running = false;
let currentCrawler = null;

async function runSync(mode = 'incremental') {
  if (running) { console.log('[Scheduler] 上次同步未完成，跳过'); return; }
  running = true;

  const logRow = db.query(
    `INSERT INTO sync_log (started_at, mode) VALUES (datetime('now'), ?)`,
    [mode]
  );
  const logId = logRow.lastInsertRowid;

  try {
    const crawler = new TROCrawler();
    currentCrawler = crawler;

    if (mode === 'full') await crawler.fetchAll();
    else await crawler.fetchIncremental();

    const s = crawler.stats;
    db.query(
      `UPDATE sync_log SET ended_at=datetime('now'), fetched=?, inserted=?, updated=?, errors=? WHERE id=?`,
      [s.fetched, s.inserted, s.updated, s.errors, logId]
    );
    console.log(`[Scheduler] ${mode} 完成: 新增${s.inserted} 更新${s.updated} 错误${s.errors}`);
  } catch (err) {
    console.error('[Scheduler] 同步失败:', err.message);
    db.query(
      `UPDATE sync_log SET ended_at=datetime('now'), message=? WHERE id=?`,
      [err.message, logId]
    );
  } finally {
    running = false;
    currentCrawler = null;
  }
}

function start() {
  const row = db.queryOne('SELECT COUNT(*) as n FROM cases');
  if (!row || row.n === 0) {
    console.log('[Scheduler] 数据库为空，启动全量抓取...');
    runSync('full');
  } else {
    console.log(`[Scheduler] 已有 ${row.n} 条数据，增量同步`);
    runSync('incremental');
  }

  // 每30分钟增量同步
  cron.schedule('*/30 * * * *', () => {
    console.log('[Scheduler] 定时触发增量同步');
    runSync('incremental');
  });

  console.log('[Scheduler] 已启动，每30分钟同步一次');
}

function triggerNow() { runSync('incremental'); }
function getStatus() { return { running, mode: running ? 'syncing' : 'idle' }; }

module.exports = { start, triggerNow, getStatus };
