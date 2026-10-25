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

// GitHub Actions 的日志按 UTF-8 解析，但 Node 在 Linux runner 上按管道编码
// 输出中文会变成乱码。这里统一用 UTF-8 Buffer 写 stdout。
const out = (s) => process.stdout.write(Buffer.from(String(s), 'utf8'));
const outln = (s) => out((s == null ? '' : s) + '\n');

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
/* 同分排名规则（各联赛不同，必须分别配置）
 *
 * 中超 / 中甲（中国足协规程）：
 *   相互比赛积分 → 相互比赛净胜球 → 相互比赛进球 → 总净胜球 → 总进球 → ...
 *
 * 英超：总积分 → 总净胜球 → 总进球 →（若涉及冠军/降级/欧战）相互战绩
 *   由于我们的场景正好涉及冠军与降级，故把 h2h 放在 gd 之前会失真；
 *   严格做法是「先 gd/gf，再 h2h」。这里采用 gd → gf → h2h 的顺序。
 *
 * 西甲：两队同分先看相互战绩净胜球；多队同分看相互积分与相互净胜球；
 *   之后才用总净胜球、总进球。这里用 h2h 优先。
 *
 * 意甲：相互积分 → 相互净胜球 → 总净胜球 → 总进球。h2h 优先。
 *
 * 德甲：总净胜球 → 总进球 → 相互积分 → 相互进球 → 相互客场进球。
 *   gd 优先于 h2h。
 *
 * 法甲：总净胜球 → 总进球 → 附加赛。gd 优先。
 */
const LEAGUES = [
  { key: 'china-l1', cid: 129, name: '中甲', season: '2026', promotion: 2, relegation: 2,
    tiebreak: ['points', 'h2hPoints', 'h2hGd', 'h2hGf', 'gd', 'gf', 'wins'] },
  { key: 'csl', cid: 43, name: '中超', season: '2026', relegation: 2,
    extraSlots: [{ from: 1, to: 3, type: 'afc', label: '亚冠区' }],
    tiebreak: ['points', 'h2hPoints', 'h2hGd', 'h2hGf', 'gd', 'gf', 'wins'] },
  { key: 'epl', cid: 4, name: '英超', season: '2026-27', relegation: 3,
    extraSlots: [{ from: 1, to: 4, type: 'ucl', label: '欧冠区' }, { from: 5, to: 5, type: 'uel', label: '欧联区' }],
    tiebreak: ['points', 'gd', 'gf', 'h2hPoints', 'h2hAwayGoals', 'wins'] },
  { key: 'laliga', cid: 3, name: '西甲', season: '2026-27', relegation: 3,
    extraSlots: [{ from: 1, to: 4, type: 'ucl', label: '欧冠区' }, { from: 5, to: 6, type: 'uel', label: '欧联/欧协' }],
    tiebreak: ['points', 'h2hPoints', 'h2hGd', 'h2hGf', 'gd', 'gf', 'wins'] },
  { key: 'seriea', cid: 9, name: '意甲', season: '2026-27', relegation: 3,
    extraSlots: [{ from: 1, to: 4, type: 'ucl', label: '欧冠区' }, { from: 5, to: 6, type: 'uel', label: '欧联/欧协' }],
    tiebreak: ['points', 'h2hPoints', 'h2hGd', 'h2hGf', 'gd', 'gf', 'wins'] },
  { key: 'bundesliga', cid: 5, name: '德甲', season: '2026-27', relegation: 2, relegationPlayoff: 1,
    extraSlots: [{ from: 1, to: 4, type: 'ucl', label: '欧冠区' }, { from: 5, to: 5, type: 'uel', label: '欧联区' }],
    tiebreak: ['points', 'gd', 'gf', 'h2hPoints', 'h2hGf', 'h2hAwayGoals', 'wins'] },
  { key: 'ligue1', cid: 12, name: '法甲', season: '2026-27', relegation: 2, relegationPlayoff: 1,
    extraSlots: [{ from: 1, to: 4, type: 'ucl', label: '欧冠区' }],
    tiebreak: ['points', 'gd', 'gf', 'wins'] }
];

/* ------------------------------------------------------------------ *
 * HTTP（带重试）
 * 懂球帝对机房 IP 有反爬，偶发 567 / 403 / 429，重试通常能过。
 * ------------------------------------------------------------------ */
const RETRYABLE = new Set([403, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 567]);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function requestOnce(url, timeoutMs) {
  const u = new URL(url);
  const mod = u.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Connection': 'close'
      },
      timeout: timeoutMs || 30000
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(requestOnce(new URL(res.headers.location, url).toString(), timeoutMs));
      }
      if (res.statusCode !== 200) {
        res.resume();
        const err = new Error('HTTP ' + res.statusCode);
        err.status = res.statusCode;
        return reject(err);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * 带指数退避的重试。
 * @param {string} url
 * @param {object} opts { attempts, timeoutMs, label }
 */
async function request(url, opts) {
  const o = opts || {};
  const attempts = o.attempts || 4;
  const timeoutMs = o.timeoutMs || 30000;
  let lastErr;

  for (let i = 1; i <= attempts; i++) {
    try {
      return await requestOnce(url, timeoutMs);
    } catch (e) {
      lastErr = e;
      const retryable = e.status == null || RETRYABLE.has(e.status);
      if (i === attempts || !retryable) break;
      // 1.5s, 4s, 8s ...
      const wait = Math.round(1500 * Math.pow(1.8, i - 1));
      if (o.label) out('[retry ' + i + '/' + (attempts - 1) + ' ' + wait + 'ms] ');
      await sleep(wait);
    }
  }
  throw lastErr;
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

    // 状态判定：
    //   已结束 / 完场        -> 计入积分
    //   进行中 90' / 中场    -> 进行中，比分是暂时的，按"未赛"处理
    //   未开始 / 空 + 无比分 -> 未赛
    const live = /进行中|中场|补时|^\d+'/.test(st);
    const finished = !live && sm != null && (st.indexOf('已结束') >= 0 || st === '');

    rows.push({
      id, round,
      date: (time || '').trim() || null,
      home: decode(home).trim(),
      away: decode(away).trim(),
      // 进行中的比赛不保留临时比分，避免被当成最终结果计入积分
      homeGoals: finished ? homeGoals : null,
      awayGoals: finished ? awayGoals : null,
      played: finished,
      live: live || undefined,
      rawStatus: st || undefined
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
    played: r.played === true,
    // 进行中的比赛：比分暂不计入，但保留标记供页面提示
    live: r.live === true ? true : undefined
  }));
  const rounds = rows.map(r => r.round).filter(x => x != null);
  const liveCount = rows.filter(r => r.live).length;

  return {
    id: meta.key,
    name: meta.name,
    season: meta.season || '',
    teams,
    matches,
    points: { win: 3, draw: 1, loss: 0 },
    tiebreak: meta.tiebreak || ['points', 'gd', 'gf', 'wins'],
    slots: defaultSlots(teams.length, meta),
    model: {},
    meta: {
      source: 'dongqiudi:' + meta.cid,
      fetchedAt: new Date().toISOString(),
      maxRound: Math.max.apply(null, rounds),
      liveMatches: liveCount || undefined
    }
  };
}

async function fetchLeague(meta) {
  const base = 'https://www.dongqiudi.com/data?cid=' + meta.cid;

  // 抓赛程页。
  // 注意：懂球帝限流时可能返回 200 但内容不是赛程页（验证页/空壳），
  // 这种情况必须当作可重试错误，否则会直接判为"赛程页无数据"。
  let rows = [];
  const maxTries = 5;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const html = await request(base + '&tab=schedule', {
      label: meta.key, attempts: 3, timeoutMs: 25000
    });
    rows = parseScheduleHtml(html);
    if (rows.length) break;

    if (attempt === maxTries) {
      throw new Error('赛程页无数据（返回内容异常，可能是限流页）');
    }
    const wait = Math.round(2000 * Math.pow(1.8, attempt - 1));
    out('[retry ' + attempt + '/' + (maxTries - 1) + ' ' + wait + 'ms: 内容异常] ');
    await sleep(wait);
  }

  const league = rowsToLeague(rows, meta);
  league.meta.url = base;

  try {
    const sHtml = await request(base + '&tab=standings', { label: meta.key, attempts: 3 });
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

  const okList = [];
  const failList = [];

  for (const meta of LEAGUES) {
    out('  ' + meta.key.padEnd(12));
    const file = path.join(OUT, meta.key + '-' + (meta.season || 'latest') + '.json');

    try {
      const league = await fetchLeague(meta);
      const played = league.matches.filter(m => m.played).length;

      // 防倒退：如果新数据比旧数据"已赛更少"，视为异常，保留旧文件
      if (fs.existsSync(file)) {
        try {
          const old = JSON.parse(fs.readFileSync(file, 'utf8'));
          const oldPlayed = old.matches.filter(m => m.played).length;
          if (played < oldPlayed) {
            outln('⚠ 已赛数倒退（新 ' + played + ' < 旧 ' + oldPlayed + '），保留旧文件');
            failList.push({ key: meta.key, reason: '数据倒退 ' + played + ' < ' + oldPlayed });
            continue;
          }
        } catch (e) { /* 旧文件坏了就覆盖 */ }
      }

      fs.writeFileSync(file, JSON.stringify(league, null, 2), 'utf8');
      outln('✓  ' + league.teams.length + ' 队  ' + played + '/' + league.matches.length + ' 场');
      okList.push(meta.key);
      await sleep(800);   // 对上游友好
    } catch (e) {
      outln('✗  ' + e.message);
      failList.push({ key: meta.key, reason: e.message });
    }
  }

  /* ---- 汇总 ---- */
  outln('');
  outln('成功 ' + okList.length + '/' + LEAGUES.length + ' 个联赛');
  if (failList.length) {
    outln('失败 ' + failList.length + ' 个：');
    for (const f of failList) outln('  - ' + f.key + '：' + f.reason);
  }

  // 写一份状态文件，供 CI 与页面提示
  const statusFile = path.join(OUT, '_status.json');
  fs.writeFileSync(statusFile, JSON.stringify({
    updatedAt: new Date().toISOString(),
    ok: okList,
    failed: failList
  }, null, 2), 'utf8');

  // 只要有失败就返回非零，让 CI 显红（但已成功的联赛文件仍会被提交）
  if (failList.length) process.exitCode = 2;
}

main();
