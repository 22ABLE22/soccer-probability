/* 引擎自测：合成联赛 + 已知答案的极端情形 */
const E = require('../src/engine.js');
const assert = require('assert');

function ok(name, cond) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name); process.exitCode = 1; }
}

/* ---------- 1. 4 队双循环，已赛 3 轮，看概率是否归一 ---------- */
{
  const teams = ['A', 'B', 'C', 'D'];
  // 4 队双循环 = 6 轮 × 2 场 = 12 场，前 4 轮已赛
  const schedule = [
    [['A','B',2,0],['C','D',1,1]],
    [['B','C',0,3],['D','A',2,2]],
    [['A','C',1,0],['B','D',1,1]],
    [['C','A',2,1],['D','B',3,0]],
    [['A','D',1,1],['C','B',2,2]],
    [['B','A',0,1],['D','C',0,1]],
  ];
  const matches = [];
  schedule.forEach((round, r) => {
    for (const m of round) {
      matches.push({
        round: r + 1, home: m[0], away: m[1],
        homeGoals: r < 4 ? m[2] : null, awayGoals: r < 4 ? m[3] : null,
        played: r < 4
      });
    }
  });
  const league = E.normalizeLeague({
    id: 'syn', name: 'Synthetic', teams,
    matches,
    slots: [
      { from: 1, to: 1, type: 'title', label: '冠军' },
      { from: 4, to: 4, type: 'relegation', label: '降级' }
    ]
  });
  const res = E.simulate(league, { iterations: 20000, seed: 'a', asOfRound: 4 });
  const sumTitle = res.teams.reduce((s, t) => s + (t.slots.title || 0), 0);
  const sumRel = res.teams.reduce((s, t) => s + (t.slots.relegation || 0), 0);
  ok('title probabilities sum to 1', Math.abs(sumTitle - 1) < 1e-9);
  ok('relegation probabilities sum to 1', Math.abs(sumRel - 1) < 1e-9);
  const sumAll = res.teams.reduce((s, t) => {
    let x = 0; for (let p = 1; p <= 4; p++) x += t.positions[p]; return s + x;
  }, 0);
  ok('position matrix sums to 4', Math.abs(sumAll - 4) < 1e-9);
}

/* ---------- 2. 种子可复现 ---------- */
{
  const teams = ['A', 'B', 'C'];
  const matches = [
    { round: 1, home: 'A', away: 'B', homeGoals: 1, awayGoals: 0, played: true },
    { round: 1, home: 'C', away: 'A', homeGoals: 0, awayGoals: 0, played: true },
    { round: 2, home: 'B', away: 'C', played: false },
    { round: 2, home: 'A', away: 'C', played: false },
  ];
  const league = E.normalizeLeague({ name: 'S', teams, matches });
  const a = E.simulate(league, { iterations: 3000, seed: 'same' });
  const b = E.simulate(league, { iterations: 3000, seed: 'same' });
  ok('same seed -> identical results',
    JSON.stringify(a.teams.map(t => t.slots)) === JSON.stringify(b.teams.map(t => t.slots)));
  const c = E.simulate(league, { iterations: 3000, seed: 'other' });
  ok('different seed -> different (usually)',
    JSON.stringify(a.teams.map(t => t.expectedPoints)) !== JSON.stringify(c.teams.map(t => t.expectedPoints)));
}

/* ---------- 3. 理论上无敌队：8 分领先且只剩 1 轮 ---------- */
{
  const teams = ['A', 'B', 'C', 'D'];
  const matches = [];
  // A 三胜，其他互相打
  const played = [
    ['A','B',3,0],['A','C',3,0],['A','D',3,0],
    ['B','C',1,1],['B','D',1,1],['C','D',1,1],
  ];
  played.forEach((m, i) => matches.push({
    round: 1, home: m[0], away: m[1], homeGoals: m[2], awayGoals: m[3], played: true
  }));
  // 最后一轮：B-C, D-A
  matches.push({ round: 2, home: 'B', away: 'C', played: false });
  matches.push({ round: 2, home: 'D', away: 'A', played: false });
  const league = E.normalizeLeague({ name: 'T', teams, matches });
  const res = E.simulate(league, { iterations: 5000, seed: 'x' });
  const A = res.teams.find(t => t.id === 'A');
  ok('A title = 100% (9 pts vs max 7 for others)', Math.abs(A.slots.title - 1) < 1e-12);
  ok('A expected position = 1', Math.abs(A.expectedPosition - 1) < 1e-12);

  const el = E.eliminate(league, { team: 'A', position: 1 });
  ok('A mathematically secured title', el.exact === true && el.alreadySecured === true);
}

/* ---------- 4. 罚分 ---------- */
{
  const teams = [{ id: 'A', name: 'A', deduction: 6 }, 'B', 'C'];
  const matches = [
    { round: 1, home: 'A', away: 'B', homeGoals: 1, awayGoals: 0, played: true },
    { round: 1, home: 'C', away: 'A', homeGoals: 1, awayGoals: 0, played: true },
    { round: 2, home: 'B', away: 'C', played: false },
  ];
  const league = E.normalizeLeague({ teams, matches });
  const stats = E.computeStats(league);
  ok('deduction applied (3 - 6 = -3)', stats.points[0] === -3);
}

/* ---------- 5. 相互战绩 tiebreak ---------- */
{
  const league = E.normalizeLeague({
    teams: ['A', 'B', 'C'],
    tiebreak: ['points', 'h2hPoints', 'gd', 'gf'],
    matches: [
      { round: 1, home: 'A', away: 'B', homeGoals: 2, awayGoals: 0, played: true },
      { round: 1, home: 'B', away: 'A', homeGoals: 1, awayGoals: 0, played: true },
      { round: 1, home: 'C', away: 'A', homeGoals: 0, awayGoals: 0, played: true },
      { round: 1, home: 'C', away: 'B', homeGoals: 0, awayGoals: 0, played: true },
    ]
  });
  // A: 3分(胜B) + 1分(平C) = 4, B: 3(胜A)+1(平C)=4, C: 2
  const stats = E.computeStats(league);
  const order = E.rankTeams(stats, league, null, league.matches, null);
  const names = order.map(i => league.teams[i].id);
  // A 与 B 同分；h2h A 2-0 胜、0-1 负 -> 净胜球 A +1 > B -1，A 应在前
  ok('h2h tiebreak puts A above B', names.indexOf('A') < names.indexOf('B'));
}

/* ---------- 6. whatIf ---------- */
{
  const teams = ['A', 'B'];
  const league = E.normalizeLeague({
    teams,
    matches: [
      { round: 2, id: 'x', home: 'A', away: 'B', played: false }
    ]
  });
  const r = E.simulate(league, {
    iterations: 2000, seed: 'w',
    whatIf: [{ matchId: 'x', homeGoals: 5, awayGoals: 0 }]
  });
  const A = r.teams.find(t => t.id === 'A');
  ok('whatIf forces deterministic result', Math.abs(A.expectedPoints - 3) < 1e-9);
}

console.log('\ndone');
