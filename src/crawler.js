const axios = require('axios');
const db = require('./db');

const BASE_URL = 'https://www.courtlistener.com/api/rest/v4';
const TOKEN = process.env.COURTLISTENER_TOKEN || '6a08baeba8633cc5ea4d7a686236842e789fc8d6';

const TARGET_COURTS = [
  'ilnd', 'ilcd',           // Illinois（最多TRO）
  'flsd', 'flmd',           // Florida
  'nysd', 'nyed',           // New York
  'cacd', 'cand',           // California
  'txsd', 'txnd',           // Texas
  'ohnd', 'wawd', 'gand', 'njd'
];

const COURT_STATE = {
  ilnd:'IL',ilcd:'IL',ilsd:'IL',
  flsd:'FL',flmd:'FL',flnd:'FL',
  nysd:'NY',nyed:'NY',nynd:'NY',nywd:'NY',
  cacd:'CA',caed:'CA',cand:'CA',casd:'CA',
  txsd:'TX',txed:'TX',txnd:'TX',txwd:'TX',
  ohnd:'OH',ohsd:'OH',
  wawd:'WA',waed:'WA',
  gand:'GA',gamd:'GA',
  njd:'NJ',
};

const KNOWN_BRANDS = [
  'Nike','Louis Vuitton','Gucci','Chanel','Hermès','Prada','Rolex','Tiffany',
  'Burberry','Coach','Michael Kors','Adidas','Under Armour','The North Face',
  'Columbia','Patagonia','UGG','Birkenstock','Fear of God','BOSCH','Makita',
  'DeWalt','3M','Apple','Samsung','Sony','Microsoft','Moose Knuckles','Lacoste',
  'Tommy Hilfiger','Ralph Lauren','Oakley','Ray-Ban','Carhartt','Wolverine',
];

const KNOWN_FIRMS = {
  'GBC':    ['greer burns', 'greer, burns', 'GBC Law'],
  'Keith':  ['keith szeliga', 'szeliga', 'IPLA'],
  'TME':    ['markham group', 'TME'],
  'HSP':    ['hong, severson', 'HSP'],
  'Boies':  ['boies schiller'],
  'Perkins':['perkins coie'],
  'Winston':['winston & strawn'],
  'Foley':  ['foley & lardner'],
};

class TROCrawler {
  constructor() {
    this.headers = {
      'Authorization': `Token ${TOKEN}`,
      'Content-Type': 'application/json',
    };
    this.stats = { fetched: 0, inserted: 0, updated: 0, errors: 0 };
    this.aborted = false;
  }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  abort() { this.aborted = true; }

  // ── 全量抓取（近2年）──────────────────────────────────────
  async fetchAll() {
    const dateFrom = new Date(Date.now() - 730 * 86400000).toISOString().split('T')[0];
    console.log(`[Crawler] 全量抓取开始，起始日期: ${dateFrom}`);
    for (const court of TARGET_COURTS) {
      if (this.aborted) break;
      await this.fetchCourtCases(court, dateFrom);
      await this.sleep(400);
    }
    console.log(`[Crawler] 全量完成: ${JSON.stringify(this.stats)}`);
  }

  // ── 增量抓取（近48小时）──────────────────────────────────
  async fetchIncremental() {
    const dateFrom = new Date(Date.now() - 2 * 86400000).toISOString().split('T')[0];
    console.log(`[Crawler] 增量抓取，起始: ${dateFrom}`);
    for (const court of TARGET_COURTS) {
      if (this.aborted) break;
      await this.fetchCourtCases(court, dateFrom);
      await this.sleep(200);
    }
    console.log(`[Crawler] 增量完成: ${JSON.stringify(this.stats)}`);
    this.stats = { fetched: 0, inserted: 0, updated: 0, errors: 0 };
  }

  // ── 按法院+日期抓取 ──────────────────────────────────────
  async fetchCourtCases(courtId, dateFrom) {
    // 同时抓商标(840)和版权(820)类案件
    for (const nos of ['840', '820']) {
      if (this.aborted) return;
      let cursor = null;
      let page = 0;
      const maxPages = 20; // 每个法院每类最多20页=200条

      while (page < maxPages) {
        if (this.aborted) return;
        try {
          const params = {
            court: courtId,
            date_filed__gte: dateFrom,
            nature_of_suit: nos,
            order_by: '-date_filed',
            ...(cursor ? { cursor } : {}),
          };

          const resp = await axios.get(`${BASE_URL}/dockets/`, {
            headers: this.headers,
            params,
            timeout: 25000,
          });

          const { results, next } = resp.data;
          if (!results || results.length === 0) break;

          for (const docket of results) {
            if (this.isTROCase(docket)) {
              this.saveCase(docket, courtId, nos);
            }
          }

          this.stats.fetched += results.length;
          page++;

          if (!next) break;
          cursor = new URL(next).searchParams.get('cursor');
          await this.sleep(300); // 礼貌性延迟，避免触发限流

        } catch (err) {
          if (err.response?.status === 429) {
            console.warn(`[Crawler] 限流！等待60秒... (${courtId}/${nos})`);
            await this.sleep(60000);
            continue;
          }
          if (err.response?.status === 401) {
            console.error('[Crawler] Token无效，请检查 COURTLISTENER_TOKEN');
            this.aborted = true;
            return;
          }
          console.error(`[Crawler] 错误 [${courtId}/${nos} p${page}]: ${err.message}`);
          this.stats.errors++;
          break;
        }
      }
    }
  }

  // ── TRO特征识别 ──────────────────────────────────────────
  isTROCase(docket) {
    const name = (docket.case_name || docket.case_name_short || '').toLowerCase();
    // Doe Defendants 是TRO最强特征（卖家身份未知）
    if (/\bdoes?\b/i.test(name)) return true;
    if (/schedule\s+[a-z]/i.test(name)) return true;   // "Schedule A defendants"
    if (/defendants?\s+\d+[-–]\d+/i.test(name)) return true;
    if (/\d+\s+(unknown|identified)/i.test(name)) return true;
    if (/counterfeit/i.test(name)) return true;
    return false;
  }

  extractPlaintiff(caseName) {
    const m = caseName.match(/^(.+?)\s+vs?\.?\s+/i);
    return (m ? m[1] : caseName).trim().substring(0, 150);
  }

  extractBrand(caseName, plaintiff) {
    for (const b of KNOWN_BRANDS) {
      if (caseName.toLowerCase().includes(b.toLowerCase())) return b;
    }
    // 从原告名推断
    const short = plaintiff.replace(/,?\s*(inc\.|llc|ltd|corp\.?|co\.|group).*$/i, '').trim();
    return short.length < 50 ? short : '待确认';
  }

  detectFirm(text = '') {
    const t = text.toLowerCase();
    for (const [abbr, kws] of Object.entries(KNOWN_FIRMS)) {
      if (kws.some(k => t.includes(k.toLowerCase()))) return abbr;
    }
    return '';
  }

  // ── 保存到 SQLite ─────────────────────────────────────────
  saveCase(docket, courtId, nos) {
    try {
      const caseName = (docket.case_name || docket.case_name_short || '').substring(0, 500);
      const plaintiff = this.extractPlaintiff(caseName);
      const brand = this.extractBrand(caseName, plaintiff);
      const state = COURT_STATE[courtId] || courtId.substring(0, 2).toUpperCase();
      const status = docket.date_terminated ? 'closed' : 'active';
      const caseNum = docket.docket_number || '';
      const dateFiled = docket.date_filed || '';

      if (!caseNum || !dateFiled) return;

      const existing = db.queryOne(
        'SELECT id FROM cases WHERE case_number=? AND court_id=?',
        [caseNum, courtId]
      );

      if (existing) {
        db.query(
          `UPDATE cases SET status=?, updated_at=datetime('now') WHERE id=?`,
          [status, existing.id]
        );
        this.stats.updated++;
      } else {
        db.query(
          `INSERT OR IGNORE INTO cases
           (case_number, case_name, plaintiff, state, court_id, law_firm, brand,
            date_filed, nature_of_suit, status, defendant_count, source_url, docket_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            caseNum, caseName, plaintiff, state, courtId, '',
            brand, dateFiled, nos, status, 1,
            `https://www.courtlistener.com${docket.absolute_url || ''}`,
            docket.id || null,
          ]
        );
        this.stats.inserted++;
      }
    } catch (err) {
      if (!err.message.includes('UNIQUE')) {
        console.error('[Crawler] save error:', err.message);
        this.stats.errors++;
      }
    }
  }
}

module.exports = TROCrawler;
