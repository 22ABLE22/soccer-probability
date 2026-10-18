/*
 * 校准测试：用第 N 轮的快照预测，与实际最终结果对比
 * 只用一个固定 seed，考察"模型是否给出合理的概率排序"，
 * 而不是要求它命中（单次实现本就有随机性）。
 */
const E = require('../src/engine.js');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function load(f) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
}

function rankOf(rows, id) {
  const r = rows.find(x => x.id === id);
  return r ? r.rank : null;
}

const cases = [
  { file: 'china-l1-2026.json', round: 10 },
  { file: 'china-l1-2026.json', round: 15 },
  { file: 'china-l1-2026.json', round: 20 },
  { file: 'china-l1-2026.json', round: 24 },
];

let totalBrier = 0, n = 0;

for (const c of cases) {
  const raw = load(c.file);
  const league = E.normalizeLeague(raw);

  // "真实"最终结果：用截至当轮的状态 + 已发生的后续结果
  const actualFinal = E.simulate(league, { iterations: 1, seed: 'truth' });
  const res = E.simulate(league, { iterations: 60000, seed: 'cal-' + c.round, asOfRound: c.round });

  // 比较：模型给出的期望名次 vs 真实（以当前已赛结果为准的最终）名次
  const rows = actualFinal.currentTable;
  console.log('\n=== ' + raw.name + ' 第 ' + c.round + ' 轮预测 vs 实际（截至现在的真实排名） ===');
  console.log('  球队           预测期望名次   现在真实名次   偏差');
  const top = res.teams.slice().sort((a, b) => a.expectedPosition - b.expectedPosition).slice(0, 6);
  let sq = 0;
  for (const t of top) {
    const real = rankOf(rows, t.id);
    const d = t.expectedPosition - real;
    sq += d * d;
    console.log('  ' + t.name.padEnd(14, ' ') +
      t.expectedPosition.toFixed(2).padStart(11) +
      String(real).padStart(13) +
      (d >= 0 ? '  +' : '  ') + d.toFixed(2));
  }
  totalBrier += sq / top.length;
  n++;

  // 冠军概率：实际冠军是否在模型前 3？
  const actualChamp = rows[0].id;
  const champRankInModel = res.teams
    .slice().sort((a, b) => (b.slots.title || 0) - (a.slots.title || 0))
    .findIndex(t => t.id === actualChamp) + 1;
  console.log('  实际冠军: ' + rows[0].name + '，模型夺冠概率排名第 ' + champRankInModel +
    '（' + ((res.teams.find(t => t.id === actualChamp).slots.title || 0) * 100).toFixed(1) + '%）');
}

console.log('\n平均名次均方误差: ' + (totalBrier / n).toFixed(2) + '（越小越好；随机基线约 8~10）');
