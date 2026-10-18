#!/usr/bin/env node
/*!
 * soccer-probability CLI
 *
 *   node bin/cli.js fetch   --league china-l1 --out data/china-l1-2026.json
 *   node bin/cli.js table   --file data/china-l1-2026.json
 *   node bin/cli.js sim     --league china-l1 --round 27 --iter 100000
 *   node bin/cli.js sim     --file data/x.json --whatif "陕西联合@无锡吴钩=3-0"
 *   node bin/cli.js bounds  --league china-l1
 *   node bin/cli.js check   --league china-l1 --team 陕西联合 --position 2
 *   node bin/cli.js demo
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Engine = require('../src/engine.js');
const { fetchLeague, LEAGUES } = require('../src/fetch.js');

/* ---------------------------- 参数解析 ---------------------------- */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); }
      else {
        const next = argv[i + 1];
        if (next == null || next.startsWith('--')) { out[a.slice(2)] = true; }
        else { out[a.slice(2)] = next; i++; }
      }
    } else out._.push(a);
  }
  return out;
}

const ROOT = path.resolve(__dirname, '..');

function dataPath(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

/* ---------------------------- 显示工具 ---------------------------- */
const C = process.stdout.isTTY
  ? {
      reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
      green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
      blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m'
    }
  : new Proxy({}, { get: () => '' });

function pad(s, n, right) {
  s = String(s);
  // 中文按 2 个宽度计算
  let w = 0;
  for (const ch of s) w += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  const fill = ' '.repeat(Math.max(0, n - w));
  return right ? fill + s : s + fill;
}

function pct(x, digits) {
  const d = digits == null ? 1 : digits;
  return (x * 100).toFixed(d) + '%';
}

function colorFor(prob) {
  if (prob >= 0.99) return C.green;
  if (prob >= 0.5) return C.green;
  if (prob >= 0.1) return C.yellow;
  if (prob > 0.001) return C.dim;
  return C.gray;
}

/* ---------------------------- 数据加载 ---------------------------- */
async function loadLeague(args) {
  if (args.file) {
    const p = dataPath(args.file);
    if (!fs.existsSync(p)) throw new Error('file not found: ' + p);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw;
  }
  if (args.league || args.cid) {
    const key = args.league;
    const league = await fetchLeague({
      league: key,
      cid: args.cid != null ? Number(args.cid) : undefined,
      season: args.season || '',
      slots: args.slots ? JSON.parse(args.slots) : undefined
    });
    return league;
  }
  throw new Error('need --file or --league');
}

/* ---------------------------- 子命令 ---------------------------- */
async function cmdFetch(args) {
  const raw = await loadLeague(args);
  const outName = args.out ||
    ('data/' + (raw.id || 'league') + '-' + (raw.season || 'season') + '.json');
  const p = dataPath(outName);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(raw, null, 2), 'utf8');

  const played = raw.matches.filter(m => m.played).length;
  console.log(C.bold + '已保存 ' + C.cyan + path.relative(ROOT, p) + C.reset);
  console.log('  联赛      ' + raw.name + (raw.season ? ' ' + raw.season : ''));
  console.log('  球队      ' + raw.teams.length);
  console.log('  比赛      ' + raw.matches.length + '  (已赛 ' + played + ', 未赛 ' + (raw.matches.length - played) + ')');
  console.log('  最大轮次  ' + raw.meta.maxRound);
}

function loadFromFile(args) {
  return JSON.parse(fs.readFileSync(dataPath(args.file), 'utf8'));
}

async function cmdTable(args) {
  const raw = args.file ? loadFromFile(args) : await loadLeague(args);
  const league = Engine.normalizeLeague(raw);
  const asOfRound = args.round != null ? Number(args.round) : null;
  const stats = Engine.computeStats(league, { asOfRound });

  console.log(C.bold + raw.name + (raw.season ? ' ' + raw.season : '') +
    C.reset + C.gray + '   积分榜' + (asOfRound ? ' (截至第 ' + asOfRound + ' 轮)' : '') + C.reset);
  console.log(C.gray + '─'.repeat(74) + C.reset);
  console.log(C.gray +
    pad('#', 4) + pad('球队', 18, true) + pad('赛', 4, true) + pad('胜', 4, true) +
    pad('平', 4, true) + pad('负', 4, true) + pad('进/失', 9, true) +
    pad('净胜', 6, true) + pad('积分', 6, true) + C.reset);

  // 复用引擎当前榜
  const res = Engine.simulate(league, { iterations: 1, asOfRound });
  for (const r of res.currentTable) {
    const line = pad(r.rank, 4) + pad(r.name, 18, true) +
      pad(r.played, 4, true) + pad(r.wins, 4, true) + pad(r.draws, 4, true) +
      pad(r.losses, 4, true) + pad(r.gf + '/' + r.ga, 9, true) +
      pad((r.gd > 0 ? '+' : '') + r.gd, 6, true) + C.bold + pad(r.points, 6, true) + C.reset;
    console.log(line);
  }
}

function buildWhatIf(args) {
  const list = [];
  const raw = args.whatif;
  if (!raw) return list;
  const arr = Array.isArray(raw) ? raw : String(raw).split('|');
  for (const item of arr) {
    // 形式 A: "主队@客队=2-1"
    // 形式 B: "matchId=2-1"
    const m = /^(?:([^=@]+)@([^=]+)|([^=]+))=(?:(\d+)-(\d+)|([^=]+))$/.exec(String(item).trim());
    if (!m) throw new Error('bad --whatif format: ' + item);
    const hg = m[4] != null ? Number(m[4]) : Number(m[6]);
    const ag = m[5] != null ? Number(m[5]) : 0;
    if (m[1] != null) list.push({ home: m[1].trim(), away: m[2].trim(), homeGoals: hg, awayGoals: ag });
    else list.push({ matchId: m[3].trim(), homeGoals: hg, awayGoals: ag });
  }
  return list;
}

async function cmdSim(args) {
  const raw = args.file ? loadFromFile(args) : await loadLeague(args);
  const league = Engine.normalizeLeague(raw);
  const iterations = Number(args.iter || 50000);
  const asOfRound = args.round != null ? Number(args.round) : null;
  const whatIf = buildWhatIf(args);

  const t0 = Date.now();
  const res = Engine.simulate(league, {
    iterations,
    seed: args.seed || 'cli',
    asOfRound,
    whatIf
  });
  const ms = Date.now() - t0;

  const title = raw.name + (raw.season ? ' ' + raw.season : '');
  console.log(C.bold + title + C.reset + C.gray +
    '   ' + iterations.toLocaleString() + ' 次模拟' +
    (asOfRound ? ' | 截至第 ' + asOfRound + ' 轮' : '') +
    (whatIf.length ? ' | what-if ' + whatIf.length + ' 场' : '') +
    ' | ' + ms + 'ms' + C.reset);

  if (whatIf.length) {
    for (const w of whatIf) {
      console.log(C.yellow + '  ▸ 指定结果: ' + (w.home || w.matchId) + ' vs ' + (w.away || '') +
        '  ' + w.homeGoals + '-' + w.awayGoals + C.reset);
    }
  }

  console.log(C.gray + '  模型: 场均进球 ' + res.model.globalAvg.toFixed(2) +
    ' / 队, 主场系数 ' + res.model.homeAdvantage.toFixed(2) +
    ', 已赛 ' + res.model.playedMatches + ' 场' + C.reset);
  console.log();

  // 表头
  const slotTypes = [];
  for (const s of league.slots) if (slotTypes.indexOf(s.type) < 0) slotTypes.push(s.type);

  let head = pad('球队', 20, true) + pad('期望分', 8, true) + pad('期望名次', 9, true);
  for (const t of slotTypes) {
    const s = league.slots.find(x => x.type === t);
    head += pad(s.label || t, Math.max(10, wcwidth(s.label || t) + 2), true);
  }
  console.log(C.bold + head + C.reset);
  console.log(C.gray + '─'.repeat(wcwidth(head)) + C.reset);

  const ordered = res.projectedTable.map(p => res.teams.find(t => t.id === p.id));
  for (const t of ordered) {
    let line = pad(t.name, 20, true) + pad(t.expectedPoints.toFixed(1), 8, true) +
      pad(t.expectedPosition.toFixed(2), 9, true);
    for (const type of slotTypes) {
      const p = t.slots[type] || 0;
      const s = league.slots.find(x => x.type === type);
      const w = Math.max(10, wcwidth(s.label || type) + 2);
      line += colorFor(p) + pad(pct(p), w, true) + C.reset;
    }
    console.log(line);
  }

  if (args.json) {
    const p = dataPath(args.json);
    fs.writeFileSync(p, JSON.stringify(res, null, 2), 'utf8');
    console.log('\n' + C.gray + '已写出 ' + path.relative(ROOT, p) + C.reset);
  }
  return res;
}

function wcwidth(s) {
  let w = 0;
  for (const ch of String(s)) w += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return w;
}

async function cmdBounds(args) {
  const raw = args.file ? loadFromFile(args) : await loadLeague(args);
  const league = Engine.normalizeLeague(raw);
  const b = Engine.theoreticalBounds(league, { asOfRound: args.round != null ? Number(args.round) : null });

  console.log(C.bold + raw.name + C.reset + C.gray + '   理论边界（剩余 ' + b.remainingMatches + ' 场）' + C.reset);
  console.log(C.gray + '  ' + b.note + C.reset);
  console.log();
  console.log(C.bold + pad('球队', 20, true) + pad('当前', 6, true) + pad('理论最高', 9, true) +
    pad('理论最低', 9, true) + pad('最好名次', 9, true) + pad('最差名次', 9, true) +
    pad('已锁定', 16, true) + C.reset);
  for (const t of b.teams.slice().sort((x, y) => y.maxPoints - x.maxPoints)) {
    const g = (t.guaranteed || []).join(',');
    console.log(pad(t.name, 20, true) + pad(t.currentPoints, 6, true) +
      pad(t.maxPoints, 9, true) + pad(t.minPoints, 9, true) +
      pad(t.bestPossiblePosition, 9, true) + pad(t.worstPossiblePosition, 9, true) +
      C.green + pad(g || '-', 16, true) + C.reset);
  }
}

async function cmdCheck(args) {
  const raw = args.file ? loadFromFile(args) : await loadLeague(args);
  const league = Engine.normalizeLeague(raw);
  const team = args.team;
  const pos = Number(args.position || 1);
  if (!team) throw new Error('need --team');
  const r = Engine.eliminate(league, {
    team, position: pos,
    asOfRound: args.round != null ? Number(args.round) : null
  });
  console.log(C.bold + team + C.reset + C.gray + ' 能否进入前 ' + pos + C.reset);
  if (r.exact) {
    console.log('  枚举 ' + r.combos.toLocaleString() + ' 种剩余结果');
    console.log('  存在达成可能 : ' + (r.canReach ? C.green + '是' : C.red + '否') + C.reset);
    console.log('  已经锁定     : ' + (r.alreadySecured ? C.green + '是' : C.gray + '否') + C.reset);
    console.log('  已经出局     : ' + (r.alreadyEliminated ? C.red + '是' : C.gray + '否') + C.reset);
  } else {
    console.log(C.yellow + '  组合过多，退回松弛界: ' + r.reason + C.reset);
    console.log('  最好名次 ' + r.bounds.best + ' / 最差名次 ' + r.bounds.worst);
    console.log('  存在达成可能 : ' + (r.canReach ? '是' : '否'));
    console.log('  已经锁定     : ' + (r.alreadySecured ? '是' : '否'));
  }
}

async function cmdDemo() {
  console.log(C.bold + '内置演示联赛' + C.reset + C.gray + '（5 队，剩 2 轮）' + C.reset);
  const raw = {
    id: 'demo', name: 'Demo League', season: '2026',
    teams: ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'],
    matches: [
      { round: 1, home: 'Alpha', away: 'Bravo', homeGoals: 3, awayGoals: 1, played: true },
      { round: 1, home: 'Charlie', away: 'Delta', homeGoals: 2, awayGoals: 2, played: true },
      { round: 1, home: 'Echo', away: 'Alpha', homeGoals: 0, awayGoals: 1, played: true },
      { round: 2, home: 'Bravo', away: 'Charlie', homeGoals: 1, awayGoals: 1, played: true },
      { round: 2, home: 'Delta', away: 'Echo', homeGoals: 3, awayGoals: 0, played: true },
      { round: 3, home: 'Alpha', away: 'Charlie', homeGoals: 2, awayGoals: 0, played: true },
      { round: 3, home: 'Bravo', away: 'Delta', homeGoals: 0, awayGoals: 2, played: true },
      { round: 3, home: 'Echo', away: 'Charlie', homeGoals: 1, awayGoals: 1, played: true },
      { round: 4, home: 'Alpha', away: 'Delta', played: false },
      { round: 4, home: 'Bravo', away: 'Echo', played: false },
      { round: 5, home: 'Delta', away: 'Bravo', played: false },
      { round: 5, home: 'Charlie', away: 'Alpha', played: false },
    ],
    slots: [
      { from: 1, to: 1, type: 'title', label: '冠军' },
      { from: 5, to: 5, type: 'relegation', label: '降级' }
    ]
  };
  const league = Engine.normalizeLeague(raw);
  const res = Engine.simulate(league, { iterations: 50000, seed: 'demo' });
  console.log();
  for (const t of res.teams.slice().sort((a, b) => a.expectedPosition - b.expectedPosition)) {
    console.log('  ' + pad(t.name, 10, true) + pad('期望分 ' + t.expectedPoints.toFixed(2), 14, true) +
      pad('冠军 ' + pct(t.slots.title || 0), 14, true) +
      pad('降级 ' + pct(t.slots.relegation || 0), 14, true));
  }
}

/* ---------------------------- 主入口 ---------------------------- */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  try {
    switch (cmd) {
      case 'fetch': await cmdFetch(args); break;
      case 'table': await cmdTable(args); break;
      case 'sim': await cmdSim(args); break;
      case 'bounds': await cmdBounds(args); break;
      case 'check': await cmdCheck(args); break;
      case 'demo': await cmdDemo(); break;
      case 'leagues':
        for (const k of Object.keys(LEAGUES)) {
          const v = LEAGUES[k];
          console.log('  ' + pad(k, 14) + pad(v.name, 10) + 'cid=' + v.cid);
        }
        break;
      default:
        console.log(help());
    }
  } catch (e) {
    console.error(C.red + '错误: ' + e.message + C.reset);
    process.exit(1);
  }
}

function help() {
  return [
    C.bold + 'soccer-probability' + C.reset + C.gray + ' — 通用足球联赛概率计算' + C.reset,
    '',
    C.bold + '用法' + C.reset,
    '  node bin/cli.js <command> [options]',
    '',
    C.bold + '命令' + C.reset,
    '  fetch    抓取联赛赛程并保存 JSON',
    '  table    打印（某个时间节点的）积分榜',
    '  sim      蒙特卡洛模拟，输出各项概率',
    '  bounds   理论最高/最低积分与名次',
    '  check    精确判定某队能否进入前 N',
    '  demo     内置演示数据',
    '  leagues  列出内置联赛 key',
    '',
    C.bold + '常用选项' + C.reset,
    '  --league <key>     联赛 key（见 leagues）',
    '  --cid <n>          直接指定懂球帝 cid',
    '  --file <path>      从本地 JSON 读取',
    '  --round <n>        只用 <= n 轮的已赛结果（回溯历史节点）',
    '  --iter <n>         模拟次数，默认 50000',
    '  --seed <s>         随机种子（可复现）',
    '  --whatif "主@客=2-1"  强制指定未赛比赛结果，可多个用 | 分隔',
    '  --json <path>      把完整结果写成 JSON',
    '  --slots \'[{...}]\'  自定义名次区间',
    '',
    C.bold + '示例' + C.reset,
    '  node bin/cli.js fetch --league china-l1 --out data/china-l1-2026.json',
    '  node bin/cli.js sim --league china-l1 --round 24 --iter 200000',
    '  node bin/cli.js sim --file data/china-l1-2026.json --whatif "梅州客家@南通支云=1-0"',
    '  node bin/cli.js check --league china-l1 --team 陕西联合 --position 2'
  ].join('\n');
}

if (require.main === module) main();
module.exports = { parseArgs };
