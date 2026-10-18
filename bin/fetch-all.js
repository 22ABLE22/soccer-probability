#!/usr/bin/env node
/*!
 * 抓取联赛赛程 -> data/*.json
 *
 * 仅在 GitHub Actions 里运行（见 .github/workflows/refresh-data.yml）。
 * 网站本身是纯前端，不依赖这个脚本。
 *
 *   node bin/fetch-all.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data');

/* ------------------------------------------------------------------ *
 * 联赛清单：cid 为懂球帝的联赛编号
 * ------------------------------------------------------------------ */
const LEAGUES = [
  { key: 'china-l1', cid: 129, name: '中甲', season: '2026', promotion: 2, relegation: 2 },
  { key: 'csl', cid: 43, name: '中超', season: '2026', relegation: 2,
    extraSlots: [{ from: 1, to: 3, type: 'afc', label: '亚冠区' }] },
  { key: 'epl', cid: 4, name: '英超', season: '2026-27', relegation: 3,
    extraSlots: [{ from: 1, to: 4, type: 'ucl', label: '欧冠区' }, { from: 5, to: 5, type: 'uel', label: '欧联区' }] },
  { key: 'laliga', cid: 3, name: '西甲', season: '2026-27', relegation: 3,
    extraSlots: [{ from: 1, to: 4, type: 'ucl', label: '欧冠区' }, { from: 5, to: 6, type: 'uel', label: '欧联/欧协' }] },
  { key: 'seriea', cid: 9, name: '意甲', season: '2026-27', relegation: 3,
    extraSlots: [{ from: 1, to: 4, type: 'ucl', label: '欧冠区' }, { from: 5, to: 6, type: 'uel', label: '欧联/欧协' }] },
  { key: 'bundesliga', cid: 5, name: '德甲', season: '2026-27', relegation: 2, relegationPlayoff: 1,
    extraSlots: [{ from: 1, to: 4, type: 'ucl', label: '欧冠区' }, { from: 5, to: 5, type: 'uel', label: '欧联区' }] },
  { key: 'ligue1', cid: 12, name: '法甲', season: '2026-27', relegation: 2, relegationPlayoff: 1,
    extraSlots: [{ from: 1, to: 4, type: 'ucl', label: '欧冠区' }] }
];

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */
function request(url, timeoutMs) {
  const u = new URL(url);
  const mod = u.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; soccer-calculator/1.0)',
        'Accept': 'text/html;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      },
      timeout: timeoutMs || 30000
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(request(new URL(res.headers.location, url).toString(), timeoutMs));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */
const decode = s => String(s)
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const pick = (s, re) => { const m = re.exec(s); return m ? m[1] : ''; };

function parseScheduleHtml(html) {
  const rows = [];
  const tokenRe = /<div class="dp-schedule-group__title[^"]*"[^>]*>([\s\S]*?)<\/div>|<a href="\/match\/(\d+)" class="dp-schedule-row"[\s\S]*?<\/a>/g;
  let round = null, roundIndex = 0, m;

  while ((m = tokenRe.exec(html)) !== null) {
    if (m[1] != null) {
      const text = decode(m[1].replace(/<[^>]+>/g, '')).trim();
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
    const sm = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(decode(score || ''));
    if (sm) { homeGoals = Number(sm[1]); awayGoals = Number(sm[2]); }
    const st = (status || '').trim();
    const finished = sm != null && (st.indexOf('已结束') >= 0 || st === '');

    rows.push({
      id, round,
      date: (time || '').trim() || null,
      home: decode(home).trim(),
      away: decode(away).trim(),
      homeGoals, awayGoals,
      played: finished
    });
  }
  return rows;
}

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

    const nm = /<a href="\/team\/\d+"[^>]*>([^<]+)<\/a>/.exec(block);
    if (!nm) continue;

    const num = i => {
      const v = decode(tds[i].replace(/<[^>]+>/g, '')).trim().replace('+', '');
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const gfa = decode(tds[6].replace(/<[^>]+>/g, '')).trim().split('/');

    out.push({
      rank: num(0),
      name: decode(nm[1]).trim(),
      played: num(1), wins: num(2), draws: num(3), losses: num(4),
      gf: gfa.length === 2 ? Number(gfa[0]) : null,
      ga: gfa.length === 2 ? Number(gfa[1]) : null,
      gd: num(7), points: num(8)
    });
  }
  return out;
}

/** 由官方积分榜反推罚分 */
function applyDeductions(league, official) {
  if (!official || !official.length) return [];
  const byName = new Map(official.map(r => [r.name, r]));
  const computed = new Map(league.teams.map(t => [t.id, 0]));
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

  const rep = [];
  for (const t of league.teams) {
    const off = byName.get(t.id);
    if (!off || off.points == null) continue;
    const diff = computed.get(t.id) - off.points;
    if (diff > 0) { t.deduction = diff; rep.push({ team: t.id, deduction: diff }); }
  }
  return rep;
}

function defaultSlots(n, meta) {
  const promo = meta.promotion || 0;
  const releg = meta.relegation || 0;
  const playoff = meta.relegationPlayoff || 0;
  const slots = [{ from: 1, to: 1, type: 'title', label: '冠军', color: '#ffd54f' }];
  if (promo >= 1) {
    slots.push({
      from: 1, to: promo, type: 'promotion', color: '#2e7d32',
      label: promo === 1 ? '升级' : '升级 (' + promo + ' 席)'
    });
  }
  for (const e of (meta.extraSlots || [])) {
    slots.push({ from: e.from, to: Math.min(n, e.to), type: e.type, label: e.label });
  }
  if (releg > 0) {
    slots.push({
      from: Math.max(1, n - releg - playoff + 1), to: n - playoff,
      type: 'relegation', label: '降级', color: '#c62828'
    });
  }
  if (playoff > 0) {
    slots.push({ from: n - playoff + 1, to: n, type: 'playoff', label: '降级附加赛', color: '#ef6c00' });
  }
  return slots;
}

function rowsToLeague(rows, meta) {
  const names = new Set();
  for (const r of rows) { names.add(r.home); names.add(r.away); }
  const teams = Array.from(names).map(n => ({ id: n, name: n }));
  const matches = rows.map((r, i) => ({
    id: r.id || ('m' + i),
    round: r.round, date: r.date,
    home: r.home, away: r.away,
    homeGoals: r.homeGoals, awayGoals: r.awayGoals,
    played: r.played === true
  }));
  const rounds = rows.map(r => r.round).filter(x => x != null);

  return {
    id: meta.key,
    name: meta.name,
    season: meta.season || '',
    teams,
    matches,
    points: { win: 3, draw: 1, loss: 0 },
    tiebreak: ['points', 'gd', 'gf', 'wins'],
    slots: defaultSlots(teams.length, meta),
    model: {},
    meta: {
      source: 'dongqiudi:' + meta.cid,
      fetchedAt: new Date().toISOString(),
      maxRound: Math.max.apply(null, rounds)
    }
  };
}

async function fetchLeague(meta) {
  const base = 'https://www.dongqiudi.com/data?cid=' + meta.cid;
  const html = await request(base + '&tab=schedule');
  const rows = parseScheduleHtml(html);
  if (!rows.length) throw new Error('赛程页无数据');

  const league = rowsToLeague(rows, meta);
  league.meta.url = base;

  try {
    const sHtml = await request(base + '&tab=standings');
    const official = parseStandingsHtml(sHtml);
    if (official.length) {
      league.meta.deductions = applyDeductions(league, official);
      league.meta.officialTable = official;
    }
  } catch (e) {
    league.meta.deductionsError = String(e.message || e);
  }
  return league;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let ok = 0;

  for (const meta of LEAGUES) {
    process.stdout.write('  ' + meta.key.padEnd(12));
    try {
      const league = await fetchLeague(meta);
      const file = path.join(OUT, meta.key + '-' + (meta.season || 'latest') + '.json');
      fs.writeFileSync(file, JSON.stringify(league, null, 2), 'utf8');
      const played = league.matches.filter(m => m.played).length;
      console.log('✓  ' + league.teams.length + ' 队  ' + played + '/' + league.matches.length + ' 场');
      ok++;
      await new Promise(r => setTimeout(r, 400));   // 对上游友好
    } catch (e) {
      console.log('✗  ' + e.message);
    }
  }

  console.log('\n完成：' + ok + '/' + LEAGUES.length + ' 个联赛');
  if (ok === 0) process.exitCode = 1;
}

main();
