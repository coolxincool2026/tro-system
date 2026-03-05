const axios = require('axios');
const db = require('./db');

const TOKEN = process.env.COURTLISTENER_TOKEN;

const COURT_STATE = {
  ilnd:'IL',ilcd:'IL',flsd:'FL',flmd:'FL',
  nysd:'NY',nyed:'NY',cacd:'CA',cand:'CA',
  txsd:'TX',txnd:'TX',ohnd:'OH',wawd:'WA',
  gand:'GA',njd:'NJ'
};

const KNOWN_BRANDS = [
  'Nike','Louis Vuitton','Gucci','Chanel','Hermes','Prada','Rolex',
  'Burberry','Coach','Michael Kors','Adidas','Under Armour','North Face',
  'UGG','Birkenstock','Fear of God','BOSCH','Makita','DeWalt','3M',
  'Apple','Samsung','Lacoste','Tommy Hilfiger','Ralph Lauren','Carhartt'
];

const SEARCH_QUERIES = [
  'temporary restraining order does defendants counterfeit',
  'schedule A defendants trademark counterfeit',
  'john does trademark infringement counterfeit sellers',
  'TRO counterfeit trademark does 1',
  'preliminary injunction counterfeit defendants online sellers'
];

class TROCrawler {
  constructor() {
    this.headers = { 'Authorization': 'Token ' + TOKEN, 'Content-Type': 'application/json' };
    this.stats = { fetched: 0, inserted: 0, updated: 0, errors: 0 };
    this.aborted = false;
    this.seenIds = new Set();
  }

  sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  abort() { this.aborted = true; }

  async fetchAll() {
    var dateFrom = new Date(Date.now() - 730 * 86400000).toISOString().split('T')[0];
    console.log('[Crawler] 全量抓取开始，起始日期: ' + dateFrom);
    await this.searchByKeywords(dateFrom);
    console.log('[Crawler] 全量完成: ' + JSON.stringify(this.stats));
  }

  async fetchIncremental() {
    var dateFrom = new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0];
    console.log('[Crawler] 增量抓取，起始: ' + dateFrom);
    await this.searchByKeywords(dateFrom);
    console.log('[Crawler] 增量完成: ' + JSON.stringify(this.stats));
    this.stats = { fetched: 0, inserted: 0, updated: 0, errors: 0 };
  }

  async searchByKeywords(dateFrom) {
    for (var i = 0; i < SEARCH_QUERIES.length; i++) {
      if (this.aborted) return;
      console.log('[Crawler] 搜索: ' + SEARCH_QUERIES[i]);
      await this.searchDockets(SEARCH_QUERIES[i], dateFrom);
      await this.sleep(1000);
    }
  }

  async searchDockets(query, dateFrom) {
    var page = 1;
    while (page <= 10) {
      if (this.aborted) return;
      try {
        var resp = await axios.get('https://www.courtlistener.com/api/rest/v4/search/', {
          headers: this.headers,
          params: { q: query, type: 'r', filed_after: dateFrom, order_by: 'score desc', page: page },
          timeout: 30000
        });
        var results = resp.data.results || [];
        if (results.length === 0) break;
        console.log('[Crawler] 第' + page + '页: ' + results.length + ' 条');
        for (var j = 0; j < results.length; j++) {
          var item = results[j];
          var uid = item.docket_id || item.id;
          if (uid && this.seenIds.has(uid)) continue;
          if (uid) this.seenIds.add(uid);
          this.saveCase(item);
        }
        this.stats.fetched += results.length;
        page++;
        if (!resp.data.next) break;
        await this.sleep(500);
      } catch (err) {
        if (err.response && err.response.status === 429) { await this.sleep(60000); continue; }
        if (err.response && err.response.status === 401) {
          console.error('[Crawler] Token无效！请检查 COURTLISTENER_TOKEN 环境变量');
          this.aborted = true;
          return;
        }
        console.error('[Crawler] 错误: ' + err.message);
        this.stats.errors++;
        break;
      }
    }
  }

  extractPlaintiff(caseName) {
    var m = caseName.match(/^(.+?)\s+vs?\.?\s+/i);
    return (m ? m[1] : caseName).trim().substring(0, 150);
  }

  extractBrand(caseName, plaintiff) {
    for (var i = 0; i < KNOWN_BRANDS.length; i++) {
      if (caseName.toLowerCase().indexOf(KNOWN_BRANDS[i].toLowerCase()) !== -1) return KNOWN_BRANDS[i];
    }
    var short = plaintiff.replace(/,?\s*(inc\.|llc|ltd|corp\.?|co\.|group|plc).*$/i, '').trim();
    return short.length < 50 ? short : 'unknown';
  }

  getState(courtId) {
    return COURT_STATE[courtId] || (courtId || '').substring(0, 2).toUpperCase() || 'US';
  }

  saveCase(item) {
    try {
      var caseName = (item.caseName || item.case_name || '').substring(0, 500);
      var courtId = item.court_id || item.court || '';
      var caseNum = item.docketNumber || item.docket_number || '';
      var dateFiled = item.dateFiled || item.date_filed || '';
      var docketId = item.docket_id || item.id || null;
      if (!caseName || !dateFiled) return;
      var plaintiff = this.extractPlaintiff(caseName);
      var brand = this.extractBrand(caseName, plaintiff);
      var state = this.getState(courtId);
      var status = (item.dateTerminated || item.date_terminated) ? 'closed' : 'active';
      var sourceUrl = item.absolute_url ? 'https://www.courtlistener.com' + item.absolute_url : '';
      var existing = db.queryOne('SELECT id FROM cases WHERE case_number=? AND court_id=?', [caseNum, courtId]);
      if (existing) {
        db.query("UPDATE cases SET status=?, updated_at=datetime('now') WHERE id=?", [status, existing.id]);
        this.stats.updated++;
      } else {
        db.query(
          'INSERT OR IGNORE INTO cases (case_number,case_name,plaintiff,state,court_id,law_firm,brand,date_filed,nature_of_suit,status,defendant_count,source_url,docket_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [caseNum,caseName,plaintiff,state,courtId,'',brand,dateFiled,'',status,1,sourceUrl,docketId]
        );
        this.stats.inserted++;
        if (this.stats.inserted % 50 === 0) console.log('[Crawler] 已入库 ' + this.stats.inserted + ' 条...');
      }
    } catch (err) {
      if (err.message.indexOf('UNIQUE') === -1) {
        console.error('[Crawler] 保存失败: ' + err.message);
        this.stats.errors++;
      }
    }
  }
}

module.exports = TROCrawler;
