/*
 * 同分排名规则测试
 *
 * 各联赛的同分规则不同，必须分别验证：
 *   中超/中甲/西甲/意甲：相互战绩优先
 *   英超/德甲/法甲：总净胜球优先
 *
 * 同时验证 h2hAwayGoals 规则真的区分客场进球（此前它与 h2hGf 相同，是个 bug）。
 */
const E = require('../src/engine.js');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let bad = 0;
const check = (n, c, x) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x ? '  ' + x : ''));
  if (!c) bad++;
};

/* ---------- 1. 用合成联赛验证「相互战绩优先」 ---------- */
{
  // A 与 B 同分，但 A 净胜球远好于 B；B 相互战绩占优
  // 规则若为 h2h 优先，B 应排在前
  const teams = ['A', 'B', 'C'];
  const matches = [
    // B 胜 A（相互战绩 B 占优）
    { round: 1, home: 'B', away: 'A', homeGoals: 3, awayGoals: 0, played: true },
    // A 大胜 C，净胜球远超 B
    { round: 1, home: 'A', away: 'C', homeGoals: 8, awayGoals: 0, played: true },
    // B 小胜 C
    { round: 2, home: 'B', away: 'C', homeGoals: 1, awayGoals: 0, played: true },
    // A 再胜 C
    { round: 2, home: 'A', away: 'C', homeGoals: 3, awayGoals: 0, played: true },
  ];
  const base = { teams, matches };

  const h2hFirst = E.normalizeLeague(Object.assign({}, base, {
    tiebreak: ['points', 'h2hPoints', 'h2hGd', 'h2hGf', 'gd', 'gf']
  }));
  const gdFirst = E.normalizeLeague(Object.assign({}, base, {
    tiebreak: ['points', 'gd', 'gf', 'wins']
  }));

  const t1 = E.simulate(h2hFirst, { iterations: 1, seed: 'a' }).currentTable;
  const t2 = E.simulate(gdFirst, { iterations: 1, seed: 'a' }).currentTable;

  // A: 胜C(8-0) + 胜C(3-0) + 负B(0-3) = 6分, 净 +8
  // B: 胜A(3-0) + 胜C(1-0) = 6分, 净 +4
  // C: 0分
  check('合成联赛中 A/B 同分', t1[0].points === 6 && t1[1].points === 6,
    '(' + t1[0].points + '/' + t1[1].points + ')');
  check('h2h 优先时 B 排第一', t1[0].id === 'B', '(实际 ' + t1[0].id + ')');
  check('gd 优先时 A 排第一', t2[0].id === 'A', '(实际 ' + t2[0].id + ')');
}

/* ---------- 2. h2hAwayGoals 必须区分客场进球 ---------- */
{
  // A 与 B 相互战绩：主客场总比分相同，但 A 客场进球多
  //   A 主场 1-1 B
  //   B 主场 0-0 A   -> A 客场 0 球；不理想
  // 换一组：
  //   A 主场 0-0 B
  //   B 主场 1-1 A   -> A 客场 1 球，B 客场 0 球
  // 相互战绩积分相同(2分)、净胜球相同(0)、进球相同(1)，只能靠客场进球区分
  const teams = ['A', 'B', 'C', 'D'];
  const matches = [
    { round: 1, home: 'A', away: 'B', homeGoals: 0, awayGoals: 0, played: true },
    { round: 2, home: 'B', away: 'A', homeGoals: 1, awayGoals: 1, played: true },
    // 让 C、D 各打几场，凑出联赛结构
    { round: 1, home: 'C', away: 'D', homeGoals: 1, awayGoals: 0, played: true },
    { round: 2, home: 'D', away: 'C', homeGoals: 1, awayGoals: 0, played: true },
    { round: 3, home: 'A', away: 'C', homeGoals: 1, awayGoals: 0, played: true },
    { round: 3, home: 'B', away: 'D', homeGoals: 1, awayGoals: 0, played: true },
  ];

  const lg = E.normalizeLeague({
    teams, matches,
    tiebreak: ['points', 'h2hPoints', 'h2hGd', 'h2hGf', 'h2hAwayGoals', 'gd', 'gf', 'wins']
  });
  const table = E.simulate(lg, { iterations: 1, seed: 'a' }).currentTable;
  const posA = table.findIndex(r => r.id === 'A');
  const posB = table.findIndex(r => r.id === 'B');

  // A 与 B 都是 4 分（各 1 胜 1 平？实际：A 平B、平B、胜C = 5分；B 平A、平A、胜D = 5分）
  const rowA = table.find(r => r.id === 'A');
  const rowB = table.find(r => r.id === 'B');
  check('A/B 同分', rowA.points === rowB.points, '(' + rowA.points + '/' + rowB.points + ')');
  check('客场进球多者(A)排前', posA < posB,
    '(A 第' + (posA + 1) + '，B 第' + (posB + 1) + ')');
}

/* ---------- 3. 各联赛实际配置的规则符合预期 ---------- */
{
  const expect = {
    'china-l1-2026.json': { h2hFirst: true, name: '中甲' },
    'csl-2026.json': { h2hFirst: true, name: '中超' },
    'laliga-2026-27.json': { h2hFirst: true, name: '西甲' },
    'seriea-2026-27.json': { h2hFirst: true, name: '意甲' },
    'epl-2026-27.json': { h2hFirst: false, name: '英超' },
    'bundesliga-2026-27.json': { h2hFirst: false, name: '德甲' },
    'ligue1-2026-27.json': { h2hFirst: false, name: '法甲' },
  };

  for (const f of Object.keys(expect)) {
    const p = path.join(ROOT, 'data', f);
    if (!fs.existsSync(p)) { check(f + ' 存在', false); continue; }
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const tb = d.tiebreak || [];
    const idxH2h = tb.findIndex(r => r.indexOf('h2h') === 0);
    const idxGd = tb.indexOf('gd');

    if (expect[f].h2hFirst) {
      const ok = idxH2h >= 0 && idxGd >= 0 && idxH2h < idxGd;
      check(expect[f].name + ' 配置为相互战绩优先', ok, JSON.stringify(tb));
    } else {
      const ok = idxH2h < 0 || idxGd < 0 || idxGd < idxH2h;
      check(expect[f].name + ' 配置为净胜球优先', ok, JSON.stringify(tb));
    }
  }
}

/* ---------- 4. 概率仍归一 ---------- */
{
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'csl-2026.json'), 'utf8'));
  const res = E.simulate(E.normalizeLeague(d), { iterations: 20000, seed: 's' });
  const sum = res.teams.reduce((s, t) => s + (t.slots.title || 0), 0);
  check('中超冠军概率合计 = 100%', Math.abs(sum - 1) < 1e-9, '(' + (sum * 100).toFixed(2) + '%)');

  // 冠军不应由单队包揽（因为大连英博相互战绩占优）
  const maxTitle = Math.max.apply(null, res.teams.map(t => t.slots.title || 0));
  check('中超冠军不是 100% 单队包揽', maxTitle < 0.999,
    '(最大 ' + (maxTitle * 100).toFixed(2) + '%)');
}

console.log('\n' + (bad ? bad + ' 项失败' : '全部通过'));
if (bad) process.exitCode = 1;
