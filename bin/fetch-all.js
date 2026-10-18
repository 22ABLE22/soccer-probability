#!/usr/bin/env node
/*! 批量抓取所有内置联赛快照到 data/ */
'use strict';

const fs = require('fs');
const path = require('path');
const { fetchLeague, LEAGUES } = require('../src/fetch.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data');

// 每个 key 对应的赛季标签（用于文件名与展示）
const SEASONS = {
  'csl': '2026',
  'china-l1': '2026',
  'china-l2': '2026',
  'epl': '2026-27',
  'laliga': '2026-27',
  'seriea': '2026-27',
  'bundesliga': '2026-27',
  'ligue1': '2026-27',
  'spl': '2026-27',
  'saudi': '2026-27',
  'mls': '2026',
  'j1': '2026',
  'k1': '2026'
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const keys = Object.keys(LEAGUES).filter(k => !LEAGUES[k].cup);
  const results = [];

  for (const key of keys) {
    const season = SEASONS[key] || '';
    process.stdout.write('  ' + key.padEnd(12));
    try {
      const league = await fetchLeague({ league: key, season });
      const file = path.join(OUT, key + '-' + (season || 'latest') + '.json');
      fs.writeFileSync(file, JSON.stringify(league, null, 2), 'utf8');
      const played = league.matches.filter(m => m.played).length;
      console.log('✓  ' + league.teams.length + ' 队  ' + played + '/' + league.matches.length + ' 场');
      results.push({ key, ok: true });
      await new Promise(r => setTimeout(r, 400));   // 对上游友好一点
    } catch (e) {
      console.log('✗  ' + e.message);
      results.push({ key, ok: false, error: e.message });
    }
  }

  const ok = results.filter(r => r.ok).length;
  console.log('\n完成：' + ok + '/' + results.length + ' 个联赛');
}

main();
