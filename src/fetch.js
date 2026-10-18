/*!
 * football-data-fetch v1.0.0
 * 把 dongqiudi 的联赛赛程页解析成 engine 认识的 JSON。
 *
 * 只依赖 Node 内置模块（https / http）。浏览器端由 web/index.html 内联同款解析逻辑。
 *
 * 已知联赛 cid（懂球帝 data?cid=...）
 */
'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

const LEAGUES = {
  // 中国
  'csl': {
    cid: 43, name: '中超', country: '中国', tier: 1, relegation: 2,
    extraSlots: [{ from: 1, to: 3, type: 'afc', label: '亚冠区' }]
  },
  'china-l1': {
    cid: 129, name: '中甲', country: '中国', tier: 2, promotion: 2, relegation: 2
  },
  'china-l2': {
    cid: 1535, name: '中乙', country: '中国', tier: 3, promotion: 2, relegation: 2
  },
  'china-csl-cup': { cid: 251, name: '足协杯', country: '中国', cup: true },
  // 欧洲主流
  'epl': {
    cid: 4, name: '英超', country: '英格兰', tier: 1, relegation: 3,
    extraSlots: [{ from: 1, to: 4, type: 'ucl', label: '欧冠区' },
                 { from: 5, to: 5, type: 'uel', label: '欧联区' }]
  },
  'laliga': {
    cid: 3, name: '西甲', country: '西班牙', tier: 1, relegation: 3,
    extraSlots: [{ from: 1, to: 4, type: 'ucl', label: '欧冠区' },
                 { from: 5, to: 6, type: 'uel', label: '欧联/欧协' }]
  },
  'seriea': {
    cid: 9, name: '意甲', country: '意大利', tier: 1, relegation: 3,
    extraSlots: [{ from: 1, to: 4, type: 'ucl', label: '欧冠区' },
                 { from: 5, to: 6, type: 'uel', label: '欧联/欧协' }]
  },
  'bundesliga': {
    cid: 5, name: '德甲', country: '德国', tier: 1, relegation: 2, relegationPlayoff: 1,
    extraSlots: [{ from: 1, to: 4, type: 'ucl', label: '欧冠区' },
                 { from: 5, to: 5, type: 'uel', label: '欧联区' }]
  },
  'ligue1': {
    cid: 12, name: '法甲', country: '法国', tier: 1, relegation: 2, relegationPlayoff: 1,
    extraSlots: [{ from: 1, to: 4, type: 'ucl', label: '欧冠区' }]
  },
  'ucl': { cid: 6, name: '欧冠', country: '欧洲', cup: true },
  'uel': { cid: 14, name: '欧联', country: '欧洲', cup: true },
  'spl': { cid: 8647, name: '苏超', country: '苏格兰', tier: 1, relegation: 1, relegationPlayoff: 1 },
  'saudi': { cid: 197, name: '沙特联', country: '沙特', tier: 1, relegation: 3 },
  'mls': { cid: 26, name: '美职联', country: '美国', tier: 1 },
  'j1': { cid: 227, name: 'J1', country: '日本', tier: 1, relegation: 3 },
  'k1': { cid: 230, name: 'K1', country: '韩国', tier: 1, relegation: 3 },
};

function request(url, opts) {
  const o = opts || {};
  const u = new URL(url);
  const mod = u.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.request({
      method: 'GET',
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (compatible; soccer-probability/1.0)',
        'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }, o.headers || {}),
      timeout: o.timeout || 25000
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(request(new URL(res.headers.location, url).toString(), o));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout: ' + url)); });
    req.on('error', reject);
    req.end();
  });
}

/* ------------------------------------------------------------------ *
 * 解析：从赛程页 HTML 里抽出 <a class="dp-schedule-row"> 行 + 轮次标题
 * ------------------------------------------------------------------ */
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseScheduleHtml(html) {
  const rows = [];
  // 轮次标题与赛程行按出现顺序切分
  // 注意：标题可能带有 dp-schedule-group__title--current 之类的修饰类
  const tokenRe = /<div class="dp-schedule-group__title[^"]*"[^>]*>([\s\S]*?)<\/div>|<a href="\/match\/(\d+)" class="dp-schedule-row"[\s\S]*?<\/a>/g;
  let round = null;
  let roundIndex = 0;
  let m;
  while ((m = tokenRe.exec(html)) !== null) {
    if (m[1] != null) {
      const text = decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim();
      roundIndex += 1;
      const num = /第\s*(\d+)\s*轮/.exec(text);
      round = num ? Number(num[1]) : roundIndex;
      continue;
    }
    const block = m[0];
    const id = m[2];
    const time = pick(block, /dp-schedule-row__time[^>]*>([^<]*)</);
    const status = pick(block, /dp-schedule-row__status[^>]*>([^<]*)</);
    const home = pick(block, /team--home[^>]*>([^<]*)</);
    const away = pick(block, /team--away[^>]*>([^<]*)</);
    const score = pick(block, /dp-schedule-row__score[^>]*>([^<]*)</);
    if (!home || !away) continue;

    let homeGoals = null, awayGoals = null;
    const sm = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(decodeEntities(score || ''));
    if (sm) { homeGoals = Number(sm[1]); awayGoals = Number(sm[2]); }

    const st = (status || '').trim();
    const finished = sm != null && (st.indexOf('已结束') >= 0 || st === '' || st.indexOf('完') >= 0);
    const live = /进行中|中场|[0-9]+'/.test(st);

    rows.push({
      id,
      round,
      date: (time || '').trim() || null,
      home: decodeEntities(home).trim(),
      away: decodeEntities(away).trim(),
      homeGoals,
      awayGoals,
      played: finished,
      live: live || undefined,
      rawStatus: st || undefined
    });
  }
  return rows;
}

function pick(s, re) {
  const m = re.exec(s);
  return m ? m[1] : '';
}

/* ------------------------------------------------------------------ *
 * 解析积分榜页：用于反推罚分（赛程页不含罚分）
 * ------------------------------------------------------------------ */
function parseStandingsHtml(html) {
  const out = [];
  const rowRe = /<tr class="dp-row"[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const block = m[1];
    const tds = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let t;
    while ((t = tdRe.exec(block)) !== null) tds.push(t[1]);
    if (tds.length < 9) continue;

    const nameMatch = /<a href="\/team\/\d+"[^>]*>([^<]+)<\/a>/.exec(block);
    const name = nameMatch ? decodeEntities(nameMatch[1]).trim() : null;
    if (!name) continue;

    const num = i => {
      const v = decodeEntities(tds[i].replace(/<[^>]+>/g, '')).trim();
      const n = Number(v.replace('+', ''));
      return Number.isFinite(n) ? n : null;
    };
    const gfa = decodeEntities(tds[6].replace(/<[^>]+>/g, '')).trim();
    const parts = gfa.split('/');

    out.push({
      rank: num(0),
      name,
      played: num(1),
      wins: num(2),
      draws: num(3),
      losses: num(4),
      gf: parts.length === 2 ? Number(parts[0]) : null,
      ga: parts.length === 2 ? Number(parts[1]) : null,
      gd: num(7),
      points: num(8)
    });
  }
  return out;
}

/**
 * 用官方积分榜反推罚分：
 *   罚分 = 由赛果算出的积分 - 官方积分
 * 只对"已赛且官方榜已结算"的情形可靠；进行中的比赛会被跳过。
 */
function deriveDeductions(league, officialRows) {
  const byName = new Map();
  for (const r of officialRows) byName.set(r.name, r);

  const computed = new Map();
  for (const t of league.teams) computed.set(t.id, 0);
  const P = league.points || { win: 3, draw: 1, loss: 0 };
  for (const m of league.matches) {
    if (!m.played) continue;
    if (m.homeGoals > m.awayGoals) {
      computed.set(m.home, computed.get(m.home) + P.win);
      computed.set(m.away, computed.get(m.away) + P.loss);
    } else if (m.homeGoals === m.awayGoals) {
      computed.set(m.home, computed.get(m.home) + P.draw);
      computed.set(m.away, computed.get(m.away) + P.draw);
    } else {
      computed.set(m.away, computed.get(m.away) + P.win);
      computed.set(m.home, computed.get(m.home) + P.loss);
    }
  }

  const report = [];
  for (const t of league.teams) {
    const off = byName.get(t.id);
    if (!off || off.points == null) continue;
    const diff = computed.get(t.id) - off.points;
    if (diff > 0) {
      t.deduction = diff;
      report.push({ team: t.id, deduction: diff, computed: computed.get(t.id), official: off.points });
    }
  }
  return report;
}

/** 把解析出的行整理成 engine 的 league JSON */
function rowsToLeague(rows, meta) {
  const m = meta || {};
  const nameSet = new Set();
  for (const r of rows) { nameSet.add(r.home); nameSet.add(r.away); }
  const teams = Array.from(nameSet).map(n => ({ id: n, name: n }));

  const matches = rows.map((r, i) => ({
    id: r.id || 'm' + i,
    round: r.round,
    date: r.date,
    home: r.home,
    away: r.away,
    homeGoals: r.homeGoals,
    awayGoals: r.awayGoals,
    played: r.played === true
  }));

  const rounds = rows.map(r => r.round).filter(x => x != null);
  return {
    id: m.id || 'league',
    name: m.name || 'League',
    season: m.season || '',
    teams,
    matches,
    points: m.points || { win: 3, draw: 1, loss: 0 },
    tiebreak: m.tiebreak || ['points', 'gd', 'gf', 'wins'],
    slots: m.slots || defaultSlots(teams.length, m),
    model: m.model || {},
    meta: { source: m.source || 'dongqiudi', fetchedAt: new Date().toISOString(), maxRound: Math.max.apply(null, rounds) }
  };
}

/** 未指定 slots 时按升降级名额生成常用区间 */
function defaultSlots(n, m) {
  const promo = m && m.promotion != null ? Number(m.promotion) : 0;
  const releg = m && m.relegation != null ? Number(m.relegation) : 0;
  const playoff = m && m.relegationPlayoff != null ? Number(m.relegationPlayoff) : 0;
  const extra = (m && m.extraSlots) || [];

  const slots = [{ from: 1, to: 1, type: 'title', label: '冠军', color: '#ffd54f' }];

  if (promo >= 1) {
    slots.push({
      from: 1, to: promo,
      type: 'promotion',
      label: promo === 1 ? '升级' : (promo === n ? '升级/冠军' : '升级 (' + promo + ' 席)'),
      color: '#2e7d32'
    });
  }
  for (const e of extra) {
    slots.push({
      from: e.from, to: Math.min(n, e.to),
      type: e.type, label: e.label, color: e.color || '#1565c0'
    });
  }
  if (releg > 0) {
    slots.push({
      from: Math.max(1, n - releg - playoff + 1),
      to: n - playoff,
      type: 'relegation',
      label: '降级',
      color: '#c62828'
    });
  }
  if (playoff > 0) {
    slots.push({
      from: n - playoff + 1, to: n,
      type: 'playoff',
      label: '降级附加赛',
      color: '#ef6c00'
    });
  }
  return slots;
}

/* ------------------------------------------------------------------ *
 * 对外
 * ------------------------------------------------------------------ */
async function fetchLeague(options) {
  const o = options || {};
  let cid = o.cid;
  let meta = {};

  if (o.league) {
    const known = LEAGUES[o.league];
    if (!known) throw new Error('unknown league key: ' + o.league + '; known: ' + Object.keys(LEAGUES).join(', '));
    cid = known.cid;
    meta = {
      id: o.league,
      name: known.name,
      country: known.country,
      promotion: known.promotion,
      relegation: known.relegation,
      relegationPlayoff: known.relegationPlayoff,
      extraSlots: known.extraSlots,
      season: o.season || ''
    };
  }
  if (cid == null) throw new Error('need options.league or options.cid');

  const url = 'https://www.dongqiudi.com/data?cid=' + cid + '&tab=schedule';
  const html = await request(url, { timeout: o.timeout || 30000 });
  const rows = parseScheduleHtml(html);
  if (!rows.length) throw new Error('no fixtures parsed from ' + url);

  const league = rowsToLeague(rows, Object.assign(meta, {
    source: 'dongqiudi:' + cid,
    slots: o.slots,
    tiebreak: o.tiebreak
  }));
  league.meta.url = url;
  league.meta.cid = cid;

  // 反推罚分（可选，失败不影响主流程）
  if (o.deductions !== false) {
    try {
      const sUrl = 'https://www.dongqiudi.com/data?cid=' + cid + '&tab=standings';
      const sHtml = await request(sUrl, { timeout: o.timeout || 30000 });
      const official = parseStandingsHtml(sHtml);
      if (official.length) {
        const rep = deriveDeductions(league, official);
        league.meta.officialTable = official;
        league.meta.deductions = rep;
      }
    } catch (e) {
      league.meta.deductionsError = String(e.message || e);
    }
  }

  return league;
}

module.exports = {
  fetchLeague, parseScheduleHtml, parseStandingsHtml,
  deriveDeductions, rowsToLeague, LEAGUES, request
};
