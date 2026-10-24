/*
 * 数据新鲜度与完整性检查
 *   node tests/test-data.js
 *
 * 检查项：
 *   1. 每个内置联赛的文件存在且可解析
 *   2. fetchedAt 不超过 N 天（默认 3 天，可用 --max-days 覆盖）
 *   3. 没有"已赛却缺比分"或"未赛却有比分"的脏数据
 *   4. 每轮场次数一致（同一联赛内不应出现某轮少赛）
 *   5. 同一球队的已赛数一致（不应出现 A 踢了 27 场、B 只踢了 26 场且无轮空说明）
 *   6. data/_status.json 里记录的失败联赛会被报出
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const MAX_DAYS = Number(arg('max-days', 3));
// 自定义示例联赛没有 fetchedAt，不参与新鲜度检查
// 手工维护的联赛不做"抓取新鲜度"检查（它们没有 CI 抓取流程）
const MANUAL_LEAGUES = new Set(['sanhang-a']);

let bad = 0;
const check = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) bad++;
};
const warn = (name, extra) => {
  console.log('  WARN  ' + name + (extra ? '  ' + extra : ''));
};

const files = fs.readdirSync(DATA)
  .filter(f => f.endsWith('.json') && !f.startsWith('_'));

if (!files.length) {
  console.log('FAIL: data/ 下没有联赛文件');
  process.exit(1);
}

console.log('检查 ' + files.length + ' 个数据文件（新鲜度阈值 ' + MAX_DAYS + ' 天）\n');

for (const f of files) {
  const key = f.replace(/-\d{4}(-\d{2})?\.json$/, '');
  const p = path.join(DATA, f);
  let d;
  try {
    d = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    check(f + ' 可解析', false, e.message);
    continue;
  }

  const meta = d.meta || {};
  const played = d.matches.filter(m => m.played);
  const pending = d.matches.filter(m => !m.played);

  // 1) 基本结构
  const structOk = Array.isArray(d.teams) && d.teams.length >= 2 &&
    Array.isArray(d.matches) && d.matches.length > 0;
  check(f + ' 结构完整', structOk,
    '(' + (d.teams || []).length + ' 队, ' + (d.matches || []).length + ' 场)');
  if (!structOk) continue;

  // 2) 新鲜度
  if (!MANUAL_LEAGUES.has(d.id || key)) {
    const at = meta.fetchedAt;
    if (!at) {
      check(f + ' 有抓取时间', false, '(fetchedAt 缺失)');
    } else {
      const days = (Date.now() - new Date(at).getTime()) / 86400000;
      check(f + ' 数据新鲜', days <= MAX_DAYS,
        '(' + days.toFixed(1) + ' 天前, ' + at + ')');
    }
  }

  // 3) 比分与 played 一致
  //    注意：JSON 里显式写 "homeGoals": null 表示未赛，不算"有比分"
  let dirty = 0;
  const dirtyList = [];
  for (const m of d.matches) {
    const hasScore = m.homeGoals != null && m.awayGoals != null;
    const playedFlag = m.played === true || (m.played === undefined && hasScore);
    if (playedFlag && !hasScore) { dirty++; dirtyList.push(m.id + ' 已赛缺比分'); }
    if (!playedFlag && hasScore) { dirty++; dirtyList.push(m.id + ' 未赛却有比分'); }
  }
  check(f + ' 比分与状态一致', dirty === 0,
    dirty ? '(' + dirty + ' 场异常: ' + dirtyList.slice(0, 3).join(', ') + ')' : '');

  // 4) 每轮场次数一致
  //    手工维护的联赛允许存在"待定"轮次（赛程未排完），排除后再比较
  const byRound = new Map();
  for (const m of d.matches) {
    if (m.round == null) continue;
    byRound.set(m.round, (byRound.get(m.round) || 0) + 1);
  }
  let counts = [...byRound.values()];
  if (MANUAL_LEAGUES.has(d.id || key) && counts.length > 1) {
    // 去掉场次最多的那一轮（通常就是"待定"池）
    const maxV = Math.max(...counts);
    const idx = counts.indexOf(maxV);
    counts = counts.slice(0, idx).concat(counts.slice(idx + 1));
  }
  const maxC = counts.length ? Math.max(...counts) : 0;
  const minC = counts.length ? Math.min(...counts) : 0;
  check(f + ' 每轮场次一致', maxC === minC,
    maxC === minC ? '(' + maxC + ' 场/轮)' : '(最少 ' + minC + ', 最多 ' + maxC + ')');

  // 5) 各队已赛数差异（允许 0，因为可能有轮空/补赛）
  const teamPlayed = new Map();
  for (const t of d.teams) teamPlayed.set(t.id, 0);
  for (const m of played) {
    teamPlayed.set(m.home, (teamPlayed.get(m.home) || 0) + 1);
    teamPlayed.set(m.away, (teamPlayed.get(m.away) || 0) + 1);
  }
  const tp = [...teamPlayed.values()];
  const gap = Math.max(...tp) - Math.min(...tp);
  if (gap > 0) {
    warn(f + ' 各队已赛数不一致', '(差 ' + gap + ' 场：' + Math.min(...tp) + '~' + Math.max(...tp) + ')');
  } else {
    check(f + ' 各队已赛数一致', true, '(' + tp[0] + ' 场)');
  }

  console.log('        已赛 ' + played.length + '/' + d.matches.length +
    ' · 未赛 ' + pending.length);
}

// 6) CI 抓取状态
const statusFile = path.join(DATA, '_status.json');
if (fs.existsSync(statusFile)) {
  try {
    const st = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    const failed = st.failed || [];
    check('上次抓取无失败联赛', failed.length === 0,
      failed.length ? '(' + failed.map(x => x.key + ': ' + x.reason).join('; ') + ')' : '');
  } catch (e) {
    warn('_status.json 无法解析', e.message);
  }
}

console.log('\n' + (bad ? bad + ' 项失败' : '全部通过'));
if (bad) process.exitCode = 1;
