/*!
 * soccer-probability-engine v1.0.0
 * 通用足球联赛概率引擎：夺冠 / 升级 / 附加赛 / 保级 / 任意名次区间
 *
 * 纯 ES2019，零依赖，Node 与浏览器通用（UMD）。
 *
 * 模型
 *   1. 由已赛比赛估计攻防强度（带收缩的正则化比率估计）
 *   2. 主场优势由数据估计（可覆盖）
 *   3. 每场剩余比赛用双泊松(Poisson)独立进球假设生成比分
 *   4. 蒙特卡洛重复整个剩余赛程，按可配置的排名规则（含小联赛内部相互战绩）排名
 *   5. 汇总每个名次/名次区间的概率
 *
 * 另附：数学上的"理论可能/已淘汰"边界（精确穷举 or 松弛上下界）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define([], factory);
  else root.SoccerEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '1.0.0';

  /* ------------------------------------------------------------------ *
   * 随机数：可复现的 xorshift128+ （同一 seed 结果完全一致）
   * ------------------------------------------------------------------ */
  function makeRng(seed) {
    let s0 = 0x9e3779b9, s1 = 0x243f6a88, s2 = 0xb7e15162, s3 = 0xdeadbeef;
    const str = String(seed == null ? Date.now() : seed);
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    s0 = h || 1;
    s1 = (h ^ 0x9e3779b9) >>> 0 || 2;
    s2 = (h ^ 0x85ebca6b) >>> 0 || 3;
    s3 = (h ^ 0xc2b2ae35) >>> 0 || 4;
    function next() {
      // xorshift128+
      let t = s0 ^ (s0 << 11);
      s0 = s1; s1 = s2; s2 = s3;
      s3 = (s3 ^ (s3 >>> 19)) ^ (t ^ (t >>> 8));
      return (s3 >>> 0) / 4294967296;
    }
    // 预热，避免低位质量的初始相关性
    for (let i = 0; i < 20; i++) next();
    return next;
  }

  /* ------------------------------------------------------------------ *
   * 泊松分布工具
   * ------------------------------------------------------------------ */
  const MAX_GOALS = 16;

  function poissonPmf(lambda) {
    const out = new Float64Array(MAX_GOALS + 1);
    let p = Math.exp(-lambda);
    out[0] = p;
    for (let k = 1; k <= MAX_GOALS; k++) {
      p = p * lambda / k;
      out[k] = p;
    }
    return out;
  }

  /** 累积分布，最后一项归一到 1，保证采样总能命中 */
  function poissonCdf(lambda) {
    const pmf = poissonPmf(lambda);
    const cdf = new Float64Array(MAX_GOALS + 1);
    let acc = 0;
    for (let k = 0; k <= MAX_GOALS; k++) { acc += pmf[k]; cdf[k] = acc; }
    const s = acc || 1;
    for (let k = 0; k <= MAX_GOALS; k++) cdf[k] /= s;
    return cdf;
  }

  /** 依据 CDF 采样进球数（线性扫描，lambda 小时非常快） */
  function sampleGoals(cdf, u) {
    for (let k = 0; k <= MAX_GOALS; k++) if (u <= cdf[k]) return k;
    return MAX_GOALS;
  }

  /** 双泊松下单场积分期望与胜平负（用于模型校准诊断） */
  function matchProbabilities(lh, la) {
    const ph = poissonPmf(lh), pa = poissonPmf(la);
    let home = 0, draw = 0, away = 0;
    for (let i = 0; i <= MAX_GOALS; i++) {
      for (let j = 0; j <= MAX_GOALS; j++) {
        const p = ph[i] * pa[j];
        if (i > j) home += p; else if (i === j) draw += p; else away += p;
      }
    }
    const total = home + draw + away || 1;
    return { home: home / total, draw: draw / total, away: away / total };
  }

  /* ------------------------------------------------------------------ *
   * 阵容 / 赛程校验与规范化
   * ------------------------------------------------------------------ */
  const DEFAULT_POINTS = { win: 3, draw: 1, loss: 0 };
  const DEFAULT_TIEBREAK = ['points', 'gd', 'gf', 'wins'];
  const KNOWN_RULES = new Set([
    'points', 'gd', 'gf', 'wins', 'losses', 'played',
    'h2hPoints', 'h2hGd', 'h2hGf', 'h2hWins', 'h2hAwayGoals',
    'name', 'seed', 'random'
  ]);

  function normalizeLeague(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('league config must be an object');
    const teams = Array.isArray(raw.teams) ? raw.teams : null;
    if (!teams || teams.length < 2) throw new Error('league.teams must contain >= 2 teams');

    const teamList = [];
    const byId = new Map();
    teams.forEach((t, i) => {
      const item = typeof t === 'string' ? { id: t, name: t } : t;
      const id = item.id != null ? String(item.id) : String(item.name || i);
      if (byId.has(id)) throw new Error('duplicate team id: ' + id);
      const team = {
        id,
        name: item.name != null ? String(item.name) : id,
        index: i,
        deduction: Number(item.deduction || 0)   // 罚分（正数表示扣分）
      };
      teamList.push(team);
      byId.set(id, team);
    });

    const matches = (Array.isArray(raw.matches) ? raw.matches : []).map((m, i) => {
      const home = byId.get(String(m.home));
      const away = byId.get(String(m.away));
      if (!home) throw new Error('match #' + i + ' unknown home team: ' + m.home);
      if (!away) throw new Error('match #' + i + ' unknown away team: ' + m.away);
      if (home === away) throw new Error('match #' + i + ' team plays itself: ' + home.id);
      const played = m.played === true ||
        (m.homeGoals != null && m.awayGoals != null && m.played !== false);
      return {
        id: m.id != null ? String(m.id) : 'm' + i,
        round: m.round != null ? Number(m.round) : null,
        date: m.date || null,
        home: home.id,
        away: away.id,
        homeIndex: home.index,
        awayIndex: away.index,
        played,
        homeGoals: played ? Number(m.homeGoals) : null,
        awayGoals: played ? Number(m.awayGoals) : null
      };
    });

    const tiebreak = (raw.tiebreak || DEFAULT_TIEBREAK).map(String);
    for (const r of tiebreak) {
      if (!KNOWN_RULES.has(r)) throw new Error('unknown tiebreak rule: ' + r);
    }

    const slots = normalizeSlots(raw.slots, teamList.length);

    return {
      id: raw.id != null ? String(raw.id) : 'league',
      name: raw.name || 'Unnamed league',
      season: raw.season != null ? String(raw.season) : '',
      teams: teamList,
      teamById: byId,
      matches,
      points: Object.assign({}, DEFAULT_POINTS, raw.points || {}),
      tiebreak,
      slots,
      model: Object.assign({}, raw.model || {}),
      meta: raw.meta || {}
    };
  }

  /**
   * slots 定义名次区间对应的结果，例如
   *   [{ from: 1, to: 1, type: 'title', label: '冠军' },
   *    { from: 1, to: 2, type: 'promotion', label: '直接升级' },
   *    { from: 3, to: 6, type: 'playoff', label: '附加赛' },
   *    { from: 18, to: 20, type: 'relegation', label: '降级' }]
   * type 可任意自定义字符串。
   */
  function normalizeSlots(rawSlots, nTeams) {
    if (!rawSlots || !rawSlots.length) {
      return [{ from: 1, to: 1, type: 'title', label: '冠军' }];
    }
    return rawSlots.map((s, i) => {
      const from = Math.max(1, Number(s.from));
      const to = Math.min(nTeams, Number(s.to == null ? s.from : s.to));
      if (!(from <= to)) throw new Error('slot #' + i + ' has from > to');
      return {
        from,
        to,
        type: String(s.type || 'slot' + i),
        label: s.label || String(s.type || 'slot' + i),
        color: s.color || null
      };
    });
  }

  /* ------------------------------------------------------------------ *
   * 积分榜
   * ------------------------------------------------------------------ */
  function emptyStats(league) {
    const n = league.teams.length;
    return {
      played: new Int32Array(n),
      wins: new Int32Array(n),
      draws: new Int32Array(n),
      losses: new Int32Array(n),
      gf: new Int32Array(n),
      ga: new Int32Array(n),
      points: new Float64Array(n)
    };
  }

  function applyMatch(stats, league, m) {
    const P = league.points;
    const h = m.homeIndex, a = m.awayIndex;
    const hg = m.homeGoals, ag = m.awayGoals;
    stats.played[h]++; stats.played[a]++;
    stats.gf[h] += hg; stats.ga[h] += ag;
    stats.gf[a] += ag; stats.ga[a] += hg;
    if (hg > ag) {
      stats.wins[h]++; stats.losses[a]++;
      stats.points[h] += P.win; stats.points[a] += P.loss;
    } else if (hg === ag) {
      stats.draws[h]++; stats.draws[a]++;
      stats.points[h] += P.draw; stats.points[a] += P.draw;
    } else {
      stats.wins[a]++; stats.losses[h]++;
      stats.points[a] += P.win; stats.points[h] += P.loss;
    }
  }

  function computeStats(league, opts) {
    const o = opts || {};
    const stats = emptyStats(league);
    for (const m of league.matches) {
      if (!m.played) continue;
      if (o.asOfRound != null && m.round != null && m.round > o.asOfRound) continue;
      applyMatch(stats, league, m);
    }
    for (const t of league.teams) {
      if (t.deduction) stats.points[t.index] -= t.deduction;
    }
    return stats;
  }

  function remainingMatches(league, opts) {
    const o = opts || {};
    return league.matches.filter(m => {
      if (m.played && !o.includePlayed) return false;
      if (o.asOfRound != null && m.round != null && m.round > o.asOfRound) return false;
      return true;
    });
  }

  /* ------------------------------------------------------------------ *
   * 相互战绩（小联赛）
   * ------------------------------------------------------------------ */
  function buildPairResults(matches) {
    // key "i|j" -> { gf: i 视角进球, ga: i 视角失球 }
    const map = new Map();
    const key = (a, b) => a + '|' + b;
    for (const m of matches) {
      if (!m.played) continue;
      const h = m.homeIndex, a = m.awayIndex;
      if (!map.has(key(h, a))) map.set(key(h, a), { gf: 0, ga: 0, awayGf: 0 });
      if (!map.has(key(a, h))) map.set(key(a, h), { gf: 0, ga: 0, awayGf: 0 });
      const x = map.get(key(h, a));          // i=h 视角：h 是主场
      x.gf += m.homeGoals; x.ga += m.awayGoals;
      x.awayGf += 0;                          // h 在主场，客场进球为 0
      const y = map.get(key(a, h));          // i=a 视角：a 是客场
      y.gf += m.awayGoals; y.ga += m.homeGoals;
      y.awayGf += m.awayGoals;                // a 客场进球
    }
    return map;
  }

  function miniTable(groupIdx, pairMap, league) {
    const P = league.points;
    const n = league.teams.length;
    const pts = new Float64Array(n), gf = new Float64Array(n), ga = new Float64Array(n),
      w = new Float64Array(n), d = new Float64Array(n), l = new Float64Array(n),
      agf = new Float64Array(n);   // 相互比赛中的客场进球
    for (const i of groupIdx) {
      for (const j of groupIdx) {
        if (i === j) continue;
        const r = pairMap.get(i + '|' + j);
        if (!r) continue;
        gf[i] += r.gf; ga[i] += r.ga;
        agf[i] += r.awayGf || 0;
        if (r.gf > r.ga) { pts[i] += P.win; w[i]++; l[j]++; }
        else if (r.gf === r.ga) { pts[i] += P.draw; d[i]++; }
        else { pts[i] += P.loss; }
      }
    }
    return { pts, gf, ga, gd: gdOf(gf, ga), w, d, l, agf };
  }

  function gdOf(gf, ga) {
    const n = gf.length;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = gf[i] - ga[i];
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 排名（递归分组，支持任意顺序的 tiebreak 规则）
   * ------------------------------------------------------------------ */
  function ruleKey(rule, t, ctx) {
    const { stats, mini, nameOf, seedOf } = ctx;
    switch (rule) {
      case 'points': return stats.points[t];
      case 'gd': return stats.gf[t] - stats.ga[t];
      case 'gf': return stats.gf[t];
      case 'wins': return stats.wins[t];
      case 'losses': return -stats.losses[t];
      case 'played': return -stats.played[t];
      case 'h2hPoints': return mini ? mini.pts[t] : 0;
      case 'h2hGd': return mini ? mini.gd[t] : 0;
      case 'h2hGf': return mini ? mini.gf[t] : 0;
      case 'h2hWins': return mini ? mini.w[t] : 0;
      case 'h2hAwayGoals': return mini ? mini.agf[t] : 0;
      default: return 0;
    }
  }

  function rankGroup(group, rules, ctx) {
    if (group.length <= 1) return group.slice();
    if (!rules.length) {
      // 兜底：按队名稳定排序，保证结果可复现
      return group.slice().sort((a, b) => String(nameOf(ctx, a)).localeCompare(String(nameOf(ctx, b))));
    }
    const rule = rules[0];
    const rest = rules.slice(1);

    if (rule === 'name' || rule === 'seed' || rule === 'random') {
      const keyed = group.slice().sort((a, b) => {
        if (rule === 'name') return String(nameOf(ctx, a)).localeCompare(String(nameOf(ctx, b)));
        if (rule === 'seed') return seedOf(ctx, a) - seedOf(ctx, b);
        return (ctx.rng ? ctx.rng() : 0) - 0.5;
      });
      return keyed;
    }

    const isH2h = rule.indexOf('h2h') === 0;
    const mini = isH2h ? miniTable(group, ctx.pairMap, ctx.league) : null;
    const local = { stats: ctx.stats, mini, nameOf: ctx.nameOf, seedOf: ctx.seedOf };

    const buckets = new Map();
    for (const t of group) {
      const k = ruleKey(rule, t, local);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(t);
    }
    const keys = Array.from(buckets.keys()).sort((x, y) => (y > x ? 1 : y < x ? -1 : 0));
    const out = [];
    for (const k of keys) {
      const sub = buckets.get(k);
      if (sub.length === 1) out.push(sub[0]);
      else out.push.apply(out, rankGroup(sub, rest, ctx));
    }
    return out;
  }

  function nameOf(ctx, i) {
    const t = ctx.league.teams[i];
    return t ? t.name : String(i);
  }
  function seedOf(ctx, i) {
    const t = ctx.league.teams[i];
    return t ? t.index : i;
  }

  /** 返回排好序的 team index 数组 */
  function rankTeams(stats, league, pairMap, matches, rng) {
    const n = league.teams.length;
    const all = [];
    for (let i = 0; i < n; i++) all.push(i);
    const flatRules = league.tiebreak.filter(r => r !== 'points');
    const ctx = {
      stats, league,
      pairMap: pairMap || buildPairResults(matches || []),
      nameOf, seedOf, rng
    };
    return rankGroup(all, ['points'].concat(flatRules), ctx);
  }

  /* ------------------------------------------------------------------ *
   * 攻防强度估计 + 主场优势
   * ------------------------------------------------------------------ */
  function estimateModel(league, opts) {
    const o = opts || {};
    const stats = computeStats(league, o);
    const n = league.teams.length;
    const cfg = league.model || {};

    let totalGF = 0, totalPlayed = 0, homeGF = 0, awayGF = 0;
    for (const m of league.matches) {
      if (!m.played) continue;
      if (o.asOfRound != null && m.round != null && m.round > o.asOfRound) continue;
      totalGF += m.homeGoals + m.awayGoals;
      totalPlayed += 2;
      homeGF += m.homeGoals;
      awayGF += m.awayGoals;
    }

    const globalAvg = totalPlayed > 0 ? totalGF / totalPlayed : 1.35;   // 每队每场
    const shrink = cfg.shrink != null ? Number(cfg.shrink) : 6;         // 收缩强度（等效场次）

    // 主场优势：使 预测主场进球/客场进球 = 观测比值
    let homeAdv = cfg.homeAdvantage != null ? Number(cfg.homeAdvantage) : null;
    if (homeAdv == null) {
      if (homeGF > 0 && awayGF > 0) {
        homeAdv = Math.sqrt((homeGF / awayGF));
        homeAdv = Math.min(1.60, Math.max(1.00, homeAdv));
      } else {
        homeAdv = 1.15;
      }
    }

    const attack = new Float64Array(n);
    const defence = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = stats.played[i];
      const w = p / (p + shrink);                 // 0 -> 1，样本越多越信任
      const attRaw = p > 0 ? (stats.gf[i] / p) / globalAvg : 1;
      const defRaw = p > 0 ? (stats.ga[i] / p) / globalAvg : 1;
      attack[i] = w * attRaw + (1 - w) * 1;
      defence[i] = w * defRaw + (1 - w) * 1;
      if (cfg.attack && cfg.attack[league.teams[i].id] != null) attack[i] = Number(cfg.attack[league.teams[i].id]);
      if (cfg.defence && cfg.defence[league.teams[i].id] != null) defence[i] = Number(cfg.defence[league.teams[i].id]);
    }

    return {
      globalAvg, homeAdv,
      awayFactor: 1 / homeAdv,
      attack, defence,
      shrink,
      stats,
      totalMatches: totalPlayed / 2
    };
  }

  function fixtureLambdas(model, m) {
    const lh = model.globalAvg * model.homeAdv * model.attack[m.homeIndex] * model.defence[m.awayIndex];
    const la = model.globalAvg * model.awayFactor * model.attack[m.awayIndex] * model.defence[m.homeIndex];
    return [
      Math.max(0.05, Math.min(8, lh)),
      Math.max(0.05, Math.min(8, la))
    ];
  }

  /* ------------------------------------------------------------------ *
   * 蒙特卡洛模拟
   * ------------------------------------------------------------------ */
  /**
   * @param {object} league  normalizeLeague 的产物
   * @param {object} opts
   *   iterations  模拟次数，默认 50000
   *   seed        随机种子，默认固定字符串，便于复现
   *   asOfRound   只使用 <= 该轮的已赛比赛，其余全部按模型模拟
   *   whatIf      [{matchId|home+away, homeGoals, awayGoals}] 强行指定某些"未赛"比赛的比分
   *   model       覆盖模型参数
   */
  function simulate(league, opts) {
    const o = opts || {};
    const iterations = Math.max(1, Math.floor(o.iterations != null ? o.iterations : 50000));
    const asOfRound = o.asOfRound != null ? Number(o.asOfRound) : null;

    const model = estimateModel(league, { asOfRound });
    if (o.model) {
      if (o.model.homeAdvantage != null) {
        model.homeAdv = Number(o.model.homeAdvantage);
        model.awayFactor = 1 / model.homeAdv;
      }
      if (o.model.globalAvg != null) model.globalAvg = Number(o.model.globalAvg);
      if (o.model.attack) for (const k of Object.keys(o.model.attack))
        if (league.teamById.has(k)) model.attack[league.teamById.get(k).index] = Number(o.model.attack[k]);
      if (o.model.defence) for (const k of Object.keys(o.model.defence))
        if (league.teamById.has(k)) model.defence[league.teamById.get(k).index] = Number(o.model.defence[k]);
    }

    // 已赛比赛：≤asOfRound 的真实结果 + whatIf 覆盖
    const playedMatches = [];
    const forced = new Map();
    if (o.whatIf) {
      for (const w of o.whatIf) {
        const idx = league.matches.findIndex(m =>
          (w.matchId != null && m.id === String(w.matchId)) ||
          (w.home != null && w.away != null &&
            league.teamById.has(String(w.home)) && league.teamById.has(String(w.away)) &&
            m.home === String(w.home) && m.away === String(w.away)));
        if (idx < 0) throw new Error('whatIf: match not found: ' + JSON.stringify(w));
        forced.set(idx, { hg: Number(w.homeGoals), ag: Number(w.awayGoals) });
      }
    }

    const pending = [];   // {homeIndex, awayIndex, cdfH, cdfA}
    for (let i = 0; i < league.matches.length; i++) {
      const m = league.matches[i];
      if (asOfRound != null && m.round != null && m.round > asOfRound) {
        const f = forced.get(i);
        if (f) {
          pending.push({
            homeIndex: m.homeIndex, awayIndex: m.awayIndex,
            fixed: true, hg: f.hg, ag: f.ag, cdfH: null, cdfA: null
          });
        } else {
          const [lh, la] = fixtureLambdas(model, m);
          pending.push({
            homeIndex: m.homeIndex, awayIndex: m.awayIndex, fixed: false,
            cdfH: poissonCdf(lh), cdfA: poissonCdf(la), lh, la
          });
        }
        continue;
      }
      const f = forced.get(i);
      if (f) {
        playedMatches.push({
          homeIndex: m.homeIndex, awayIndex: m.awayIndex,
          homeGoals: f.hg, awayGoals: f.ag, played: true
        });
      } else if (m.played) {
        playedMatches.push(m);
      } else {
        const [lh, la] = fixtureLambdas(model, m);
        pending.push({
          homeIndex: m.homeIndex, awayIndex: m.awayIndex, fixed: false,
          cdfH: poissonCdf(lh), cdfA: poissonCdf(la), lh, la
        });
      }
    }

    const n = league.teams.length;
    const base = emptyStats(league);
    for (const m of playedMatches) applyMatch(base, league, m);
    for (const t of league.teams) if (t.deduction) base.points[t.index] -= t.deduction;

    // 统计容器
    const positionCounts = [];   // positionCounts[t][pos] = 次数
    for (let i = 0; i < n; i++) positionCounts.push(new Float64Array(n + 1));
    const pointsSum = new Float64Array(n);
    const posSum = new Float64Array(n);

    const rng = makeRng(o.seed != null ? o.seed : 'soccer-engine-v1');
    const points = new Float64Array(n);
    const gf = new Int32Array(n), ga = new Int32Array(n), wins = new Int32Array(n);
    const playedCnt = new Int32Array(n);

    const P = league.points;
    const npend = pending.length;
    const pairMapBase = buildPairResults(playedMatches);

    for (let it = 0; it < iterations; it++) {
      points.set(base.points);
      gf.set(base.gf); ga.set(base.ga); wins.set(base.wins); playedCnt.set(base.played);

      // 采样全部剩余比赛
      const simMatches = playedMatches.slice();
      for (let k = 0; k < npend; k++) {
        const f = pending[k];
        let hg, ag;
        if (f.fixed) { hg = f.hg; ag = f.ag; }
        else {
          hg = sampleGoals(f.cdfH, rng());
          ag = sampleGoals(f.cdfA, rng());
        }
        const h = f.homeIndex, a = f.awayIndex;
        playedCnt[h]++; playedCnt[a]++;
        gf[h] += hg; ga[h] += ag; gf[a] += ag; ga[a] += hg;
        if (hg > ag) { wins[h]++; points[h] += P.win; points[a] += P.loss; }
        else if (hg === ag) { points[h] += P.draw; points[a] += P.draw; }
        else { wins[a]++; points[a] += P.win; points[h] += P.loss; }
        simMatches.push({ homeIndex: h, awayIndex: a, homeGoals: hg, awayGoals: ag, played: true });
      }

      const stats = {
        played: playedCnt, wins,
        draws: null, losses: null,
        gf, ga, points
      };

      // 排名：常见配置走标量快路径
      let order;
      const fast = isSimpleTiebreak(league.tiebreak);
      if (fast) {
        const idx = new Array(n);
        for (let i = 0; i < n; i++) idx[i] = i;
        const gd = new Float64Array(n);
        for (let i = 0; i < n; i++) gd[i] = gf[i] - ga[i];
        idx.sort((x, y) =>
          (points[y] - points[x]) ||
          (gd[y] - gd[x]) ||
          (gf[y] - gf[x]) ||
          (wins[y] - wins[x]) ||
          (x - y));
        order = idx;
      } else {
        const pairMap = npend === 0 ? pairMapBase : buildPairResults(simMatches);
        order = rankTeams(stats, league, pairMap, simMatches, null);
      }

      for (let pos = 0; pos < n; pos++) {
        const t = order[pos];
        positionCounts[t][pos + 1] += 1;
        pointsSum[t] += points[t];
        posSum[t] += pos + 1;
      }
    }

    /* ---------------- 结果整理 ---------------- */
    const teamResults = league.teams.map(t => {
      const i = t.index;
      const byPosition = new Float64Array(n + 1);
      for (let p = 1; p <= n; p++) byPosition[p] = positionCounts[i][p] / iterations;

      const slotProbs = {};
      for (const s of league.slots) {
        let acc = 0;
        for (let p = s.from; p <= s.to; p++) acc += byPosition[p];
        slotProbs[s.type] = (slotProbs[s.type] || 0) + acc;
      }

      const topK = new Float64Array(n + 1);
      let run = 0;
      for (let p = 1; p <= n; p++) { run += byPosition[p]; topK[p] = run; }

      return {
        id: t.id,
        name: t.name,
        expectedPoints: pointsSum[i] / iterations,
        expectedPosition: posSum[i] / iterations,
        positions: byPosition,
        topK,
        slots: slotProbs,
        mostLikelyPosition: argmaxPosition(byPosition),
        titleProbability: slotProbs.title || 0,
        relegationProbability: slotProbs.relegation || 0
      };
    });

    const byExpectedPosition = teamResults.slice()
      .sort((a, b) => a.expectedPosition - b.expectedPosition);

    // 每支球队的"最可能最终名次"汇总，用于展示一张预测积分榜
    const projectedTable = byExpectedPosition.map((r, i) => ({
      rank: i + 1,
      id: r.id,
      name: r.name,
      expectedPoints: r.expectedPoints,
      expectedPosition: r.expectedPosition,
      slots: r.slots
    }));

    return {
      version: VERSION,
      league: { id: league.id, name: league.name, season: league.season },
      iterations,
      seed: o.seed != null ? o.seed : 'soccer-engine-v1',
      asOfRound,
      model: {
        globalAvg: model.globalAvg,
        homeAdvantage: model.homeAdv,
        attack: league.teams.map(t => ({ id: t.id, name: t.name, attack: model.attack[t.index], defence: model.defence[t.index] })),
        playedMatches: model.totalMatches
      },
      currentTable: buildCurrentTable(league, base, model),
      slots: league.slots,
      teams: teamResults,
      projectedTable
    };
  }

  function isSimpleTiebreak(rules) {
    // 只由 points/gd/gf/wins 构成且顺序一致时，可用标量比较
    const allowed = ['points', 'gd', 'gf', 'wins'];
    const norm = rules.filter(r => allowed.indexOf(r) >= 0);
    if (norm.length !== rules.length) return false;
    for (let i = 0; i < norm.length; i++) if (norm[i] !== allowed[i]) return false;
    return true;
  }

  function argmaxPosition(arr) {
    let best = 1, bv = arr[1];
    for (let p = 2; p < arr.length; p++) if (arr[p] > bv) { bv = arr[p]; best = p; }
    return best;
  }

  function buildCurrentTable(league, stats, model) {
    const pairMap = buildPairResults(league.matches.filter(m => m.played));
    const order = rankTeams(
      { played: stats.played, wins: stats.wins, draws: stats.draws, losses: stats.losses, gf: stats.gf, ga: stats.ga, points: stats.points },
      league, pairMap, league.matches.filter(m => m.played), null);
    const rows = order.map((i, pos) => {
      const t = league.teams[i];
      return {
        rank: pos + 1,
        id: t.id,
        name: t.name,
        played: stats.played[i],
        wins: stats.wins[i],
        draws: stats.draws[i],
        losses: stats.losses[i],
        gf: stats.gf[i],
        ga: stats.ga[i],
        gd: stats.gf[i] - stats.ga[i],
        points: stats.points[i]
      };
    });
    void model;
    return rows;
  }

  /* ------------------------------------------------------------------ *
   * 理论边界：最多/最少可能积分，以及"已锁定/已出局"
   * ------------------------------------------------------------------ */
  function theoreticalBounds(league, opts) {
    const o = opts || {};
    const asOfRound = o.asOfRound != null ? Number(o.asOfRound) : null;
    const stats = computeStats(league, { asOfRound });
    const pend = remainingMatches(league, { asOfRound });
    const n = league.teams.length;
    const P = league.points;

    const maxPts = new Float64Array(n);
    const minPts = new Float64Array(n);
    for (let i = 0; i < n; i++) { maxPts[i] = stats.points[i]; minPts[i] = stats.points[i]; }
    for (const m of pend) {
      maxPts[m.homeIndex] += P.win; maxPts[m.awayIndex] += P.win;
      minPts[m.homeIndex] += P.loss; minPts[m.awayIndex] += P.loss;
    }

    // 名次区间上下界
    //   若 minPts[j] > maxPts[i]，j 必然排在本队之前（积分绝对领先，无视净胜球）
    //   若 maxPts[j] < minPts[i]，j 必然排在本队之后
    //   积分可能持平时不判定为"必然"，因此界是保守（偏宽）的，但绝不会错报"已锁定"。
    const slotBounds = league.teams.map(t => {
      const i = t.index;
      let mustBeAbove = 0;
      let mustBeBelow = 0;
      let couldBeAbove = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        if (minPts[j] > maxPts[i]) mustBeAbove++;
        if (maxPts[j] < minPts[i]) mustBeBelow++;
        if (maxPts[j] >= minPts[i]) couldBeAbove++;
      }
      const n2 = n;
      const bestPos = Math.min(mustBeAbove + 1, n2);
      let worstPos = Math.max(n2 - mustBeBelow, bestPos);

      // 用"可超越者"给一个更贴近实际的期望名次上限
      const optimisticPos = Math.min(couldBeAbove + 1, n2);

      // 若某队 maxPts 严格大于所有对手 maxPts，且它能靠积分锁定名次，则冠军也锁定。
      // 这里先按"最坏名次"判断区间，再单独检查"积分上无人能及"。
      let dominatedRivals = 0;
      for (let j = 0; j < n; j++) {
        if (j !== i && maxPts[i] > maxPts[j]) dominatedRivals++;
      }
      if (dominatedRivals === n - 1) worstPos = 1;

      const secured = league.slots.filter(s => worstPos <= s.to && bestPos >= s.from).map(s => s.type);
      const eliminated = league.slots.filter(s => bestPos > s.to || worstPos < s.from).map(s => s.type);

      return {
        id: t.id,
        name: t.name,
        currentPoints: stats.points[i],
        maxPoints: maxPts[i],
        minPoints: minPts[i],
        bestPossiblePosition: bestPos,
        worstPossiblePosition: worstPos,
        optimisticPosition: optimisticPos,
        guaranteed: secured,
        eliminated
      };
    });

    return {
      asOfRound,
      remainingMatches: pend.length,
      teams: slotBounds,
      relaxed: true,
      note: '乐观/悲观界是独立的极值估计（忽略对手之间互相抢分），用于快速判定；精确判定请用 eliminate()。'
    };
  }

  /**
   * 精确判定：给定球队与名次阈值 k，穷举剩余比赛结果，
   * 判断是否存在"该队最终排名 <= k"的情形（canReach）与 ">= k" 的情形。
   * 仅在 3^remaining <= maxNodes 时穷举，否则退回松弛界并标注。
   */
  function eliminate(league, opts) {
    const o = opts || {};
    const teamId = String(o.team);
    const k = Number(o.position || 1);
    const maxNodes = o.maxNodes || 200000;
    const asOfRound = o.asOfRound != null ? Number(o.asOfRound) : null;
    const team = league.teamById.get(teamId);
    if (!team) throw new Error('unknown team: ' + teamId);

    const pend = remainingMatches(league, { asOfRound });
    const n = league.teams.length;
    const stats = computeStats(league, { asOfRound });

    const combos = Math.pow(3, pend.length);
    if (combos > maxNodes) {
      const b = theoreticalBounds(league, { asOfRound });
      const row = b.teams.find(t => t.id === teamId);
      return {
        exact: false,
        reason: 'too many combinations (' + combos.toExponential(1) + ' > ' + maxNodes + ')',
        team: teamId, position: k,
        canReach: row.bestPossiblePosition <= k,
        alreadySecured: row.worstPossiblePosition <= k,
        bounds: { best: row.bestPossiblePosition, worst: row.worstPossiblePosition }
      };
    }

    // 迭代枚举 3^m 种结果
    const m = pend.length;
    const P = league.points;
    let canReach = false, canMiss = false;

    const idxs = new Int32Array(m);
    for (let i = 0; i < m; i++) idxs[i] = 0;

    const basePts = Float64Array.from(stats.points);
    const baseGf = Int32Array.from(stats.gf);
    const baseGa = Int32Array.from(stats.ga);

    for (let code = 0; code < combos; code++) {
      // 解码 3 进制
      let c = code;
      for (let i = 0; i < m; i++) { idxs[i] = c % 3; c = (c / 3) | 0; }

      const pts = Float64Array.from(basePts);
      const gd = new Int32Array(n);
      for (let i = 0; i < n; i++) gd[i] = baseGf[i] - baseGa[i];

      for (let i = 0; i < m; i++) {
        const mt = pend[i];
        const r = idxs[i];
        if (r === 0) { // 主胜
          pts[mt.homeIndex] += P.win; pts[mt.awayIndex] += P.loss;
          gd[mt.homeIndex] += 1; gd[mt.awayIndex] -= 1;
        } else if (r === 1) { // 平
          pts[mt.homeIndex] += P.draw; pts[mt.awayIndex] += P.draw;
        } else { // 客胜
          pts[mt.awayIndex] += P.win; pts[mt.homeIndex] += P.loss;
          gd[mt.awayIndex] += 1; gd[mt.homeIndex] -= 1;
        }
      }

      // 只关心：是否有 < k 支球队严格强于本队（平手按净胜球近似）
      let better = 0;
      const ti = team.index;
      for (let j = 0; j < n; j++) {
        if (j === ti) continue;
        if (pts[j] > pts[ti]) better++;
        else if (pts[j] === pts[ti] && gd[j] > gd[ti]) better++;
      }
      const pos = better + 1;
      if (pos <= k) canReach = true;
      if (pos > k) canMiss = true;
      if (canReach && canMiss) break;
    }

    return {
      exact: true,
      team: teamId,
      position: k,
      canReach,
      canMiss,
      alreadySecured: !canMiss,
      alreadyEliminated: !canReach,
      combos,
      remainingMatches: m
    };
  }

  return {
    VERSION,
    normalizeLeague,
    computeStats,
    remainingMatches,
    estimateModel,
    matchProbabilities,
    poissonPmf,
    simulate,
    theoreticalBounds,
    eliminate,
    rankTeams
  };
});
