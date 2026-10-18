# 足球联赛概率计算器

**🔗 在线使用：<https://22able22.github.io/soccer-probability/>**

通用足球联赛 **夺冠 / 升级 / 附加赛 / 保级** 概率计算器。
双泊松进球模型 + 蒙特卡洛模拟，零依赖，可跑在浏览器、命令行、GitHub Pages 或打包桌面端。

已内置联赛数据：**英超 · 西甲 · 意甲 · 德甲 · 法甲 · 中超 · 中甲**

```
中甲 2026 · 100,000 次模拟 · 442ms
                球队  期望分  期望名次    冠军   升级(2席)    降级
          广东广州豹    66.3      1.00  100.0%     100.0%     0.0%
            南通支云    55.8      2.26    0.0%      81.4%     0.0%
            广西恒宸    51.3      3.81    0.0%       7.2%     0.0%
            陕西联合    50.5      3.92    0.0%       4.8%     0.0%
            深圳青年人    50.7      4.06    0.0%       6.6%     0.0%
                梅州客家    18.8     15.44    0.0%       0.0%    99.3%
                佛山南狮    18.7     15.55    0.0%       0.0%    99.4%
```

---

## 一、先回答平台问题

| 方案 | 支持？ | 说明 |
|---|---|---|
| **GitHub Pages** | ✅ **最适合公开分享** | 纯静态站，把 `dist/` 推上去即可。只能读构建时打进去的 JSON 快照，**不能**在线抓数据（浏览器跨域） |
| **本地 HTML 双击** | ✅ **推荐日常使用** | `dist/index.html` 已把**引擎和数据都内联**（约 350 KB），`file://` 下可直接用，**断网也行**，不用启服务器 |
| **本地端口 HTML** | ✅ 需要抓最新数据时用它 | `node bin/serve.js` → `http://127.0.0.1:8787`，额外提供 `/api/league` 抓取代理 |
| **打包 EXE** | ⚠️ 不推荐 | 离线场景已被单文件 HTML 覆盖；EXE 只增加体积与杀软误报。真要做可用 pkg/Electron，但收益很小 |
| **CLI** | ✅ | `node bin/cli.js sim ...`，适合批量、脚本化、回溯历史 |

**推荐组合：**
- 日常看结果 → 双击 `dist/index.html`
- 要最新数据 / 改数据源 → `node bin/serve.js`，界面里把「数据源」切到「在线抓取」
- 要分享给别人 → 把 `dist/` 推到 GitHub Pages

> 注意：`file://` 下浏览器禁止 `fetch` 本地文件，所以「数据源 = 在线抓取」在双击模式下用不了。
> 这是浏览器的安全限制，不是程序缺陷；需要用最新数据时请走 `bin/serve.js`。

### GitHub 上有没有现成的？
搜过了，**没有可直接用的通用方案**。能找到的都是单联赛的英超玩具项目：

| 项目 | ★ | 局限 |
|---|---|---|
| `andrewbaisden/league-sim` | 0 | 只有英超，无升降级规则引擎 |
| `salikfaisal/Club_Soccer_Season_Projections` | 8 | 固定 7 个欧洲联赛，不支持中甲这类自定义联赛 |
| `pvinas23/MatchPredict` | 3 | 绑定 MySQL + Flask 全栈，赛程配置写死 |
| `Akadyan/WhoWillWin_football` | 0 | 只有英超/西甲，无升级附加赛 |

它们都不满足"**任何联赛 + 可配置升降级名额 + 任意时间节点回溯**"，所以本项目从零实现。

---

## 二、模型怎么算的

### 1. 攻防强度估计

对每支球队，用已赛比赛估计"进攻强度"和"防守强度"：

```
att_i = (球队_i 场均进球 / 联赛场均)       ← 收缩到 1.0
def_i = (球队_i 场均失球 / 联赛场均)
```

带**收缩（shrinkage）**，避免开局样本太小而失真：

```
w = 已赛场次 / (已赛场次 + shrink)      // shrink 默认 6
att_i_final = w × att_i + (1 − w) × 1.0
```

即：只踢了 2 场的球队，其比率会被拉回联赛平均；踢满 20 场则基本信任原始比率。

### 2. 主场优势

```
homeAdv = sqrt(主场总进球 / 客场总进球)      // 数据估计，钳制在 [1.00, 1.60]
```

### 3. 单场进球期望

对主队 H、客队 A：

```
λ_H = 联赛场均 × homeAdv × att_H × def_A
λ_A = 联赛场均 × (1/homeAdv) × att_A × def_H
```

### 4. 采样比分

主客队进球独立服从泊松分布：

```
G_H ~ Poisson(λ_H),   G_A ~ Poisson(λ_A)
```

用**逆变换采样 + 预计算 CDF**，比每次调用 `Math.random()` 后再算阶乘快得多（实测 44 万场/秒）。

### 5. 蒙特卡洛

重复 N 次：
1. 从当前真实积分榜出发
2. 采样所有剩余比赛比分
3. 按联赛规则排名（积分 → 净胜球 → 进球数 → **相互战绩** → …）
4. 记录每队最终名次

最后用频率估计概率：`P(名次 ∈ 区间) = 命中次数 / N`。

### 6. 排名规则可配置

`tiebreak` 数组按顺序生效，支持：

```
points     积分          gd        净胜球        gf        进球数
wins       胜场          h2hPoints 相互战绩积分   h2hGd     相互战绩净胜球
h2hGf      相互战绩进球   name      队名（确定性） seed      初始种子
```

相互战绩规则会自动对**同分的那一小群球队**构建小联赛（mini-league），符合 UEFA/中甲的实际做法。

---

## 三、快速开始

```bash
cd E:\Users\Admin\github\soccer

# 1) 离线看界面（最简单，双击也行）
start dist/index.html

# 2) 带在线抓取的本地服务
node bin/serve.js
#   → http://127.0.0.1:8787

# 3) 命令行
node bin/cli.js demo
node bin/cli.js fetch --league china-l1 --season 2026
node bin/cli.js sim   --file data/china-l1-2026.json --iter 200000
```

无需 `npm install` —— 本项目**零外部依赖**。

---

## 四、命令行用法

```bash
node bin/cli.js <命令> [选项]
```

| 命令 | 作用 |
|---|---|
| `fetch` | 抓取赛程 + 积分榜，存成 JSON |
| `table` | 打印某个时间节点的积分榜 |
| `sim` | 蒙特卡洛模拟，输出概率表 |
| `bounds` | 理论最高/最低积分，判定"已锁定/已出局" |
| `check` | 精确穷举：某队能否进入前 N |
| `demo` | 内置 5 队演示数据 |
| `leagues` | 列出内置联赛 key |

### 常用选项

| 选项 | 说明 |
|---|---|
| `--league <key>` | 联赛 key（见 `leagues` 命令） |
| `--cid <n>` | 直接指定懂球帝 cid（支持任意联赛） |
| `--file <path>` | 从本地 JSON 读取（不联网） |
| `--round <n>` | **只用 ≤n 轮的已赛结果**，回溯历史节点 |
| `--iter <n>` | 模拟次数，默认 50000 |
| `--seed <s>` | 随机种子，保证可复现 |
| `--whatif "主@客=2-1"` | 强制指定未赛比赛结果，多个用 `\|` 分隔 |
| `--json <path>` | 把完整结果写成 JSON |
| `--slots '<json>'` | 自定义名次区间 |

### 例子

```bash
# 回溯到第 20 轮，看当时的冲超形势
node bin/cli.js sim --file data/china-l1-2026.json --round 20 --iter 200000

# 假设南通最后一轮输给梅州，陕西的概率会变成多少？
node bin/cli.js sim --file data/china-l1-2026.json \
  --whatif "梅州客家@南通支云=1-0" --iter 200000

# 广州豹是否已锁定冠军？
node bin/cli.js check --file data/china-l1-2026.json --team 广东广州豹 --position 1

# 自定义区间：前 4 欧冠、第 5 欧联、后 3 降级
node bin/cli.js sim --file data/epl-2026-27.json --slots \
 '[{"from":1,"to":1,"type":"title","label":"冠军"},
   {"from":1,"to":4,"type":"ucl","label":"欧冠"},
   {"from":5,"to":5,"type":"uel","label":"欧联"},
   {"from":18,"to":20,"type":"relegation","label":"降级"}]'
```

---

## 五、作为库调用

```js
const Engine = require('./src/engine.js');

const league = Engine.normalizeLeague({
  name: '示例联赛',
  teams: ['A', 'B', 'C', 'D'],
  matches: [
    { round: 1, home: 'A', away: 'B', homeGoals: 2, awayGoals: 0, played: true },
    { round: 2, home: 'A', away: 'C', played: false },
    // ...
  ],
  tiebreak: ['points', 'gd', 'gf', 'wins'],
  slots: [
    { from: 1, to: 1, type: 'title', label: '冠军' },
    { from: 4, to: 4, type: 'relegation', label: '降级' }
  ]
});

const res = Engine.simulate(league, {
  iterations: 100000,
  seed: 'my-seed',
  asOfRound: 1,                    // 回溯到第 1 轮之后
  whatIf: [{ home: 'A', away: 'C', homeGoals: 3, awayGoals: 1 }]
});

for (const t of res.teams) {
  console.log(t.name,
    '冠军', (t.slots.title * 100).toFixed(1) + '%',
    '降级', ((t.slots.relegation || 0) * 100).toFixed(1) + '%');
}
```

### 返回结构

```js
{
  currentTable: [{ rank, id, name, played, wins, draws, losses, gf, ga, gd, points }],
  teams: [{
    id, name,
    expectedPoints,        // 期望最终积分
    expectedPosition,      // 期望最终名次
    mostLikelyPosition,    // 最可能名次
    positions,             // positions[p] = 最终排第 p 的概率
    topK,                  // topK[k] = 最终进入前 k 的概率
    slots,                 // { title: 0.8, relegation: 0.02, ... }
  }],
  projectedTable,          // 按期望名次排序
  model: { globalAvg, homeAdvantage, attack, defence, playedMatches },
  iterations, seed, asOfRound
}
```

---

## 六、数据从哪来

`src/fetch.js` 解析懂球帝的联赛数据页（`dongqiudi.com/data?cid=...`）：

- **赛程页** → 每场比赛的轮次、主客、比分、是否已赛
- **积分榜页** → 官方积分，用来**反推罚分**

罚分反推很关键：中甲 2026 赛季有 4 队被扣分（宁波 −3、梅州 −9、苏州 −3、亚泰 −4），
赛程页完全看不出来。本工具用「按赛果算出的积分 − 官方积分」得到扣分值，
再写进 `teams[].deduction`。实测 16 队积分与官方**逐队吻合**。

内置联赛：

```
csl  中超      china-l1 中甲     china-l2 中乙
epl  英超      laliga   西甲     seriea   意甲
bundesliga 德甲  ligue1 法甲     spl      苏超
saudi 沙特联    mls 美职联        j1  J1      k1  K1
```

不在列表里的联赛，用 `--cid <懂球帝 cid>` 也能抓。

---

## 七、目录结构

```
soccer/
├─ bin/
│  ├─ cli.js          命令行入口
│  ├─ serve.js        本地服务器 + 抓取代理
│  ├─ build.js        构建 dist/（内联引擎与数据）
│  └─ fetch-all.js    批量抓取所有联赛
├─ src/
│  ├─ engine.js       概率引擎（UMD，Node/浏览器通用）
│  └─ fetch.js        懂球帝解析器
├─ web/
│  └─ index.html      Web 界面源码
├─ data/              联赛快照 JSON
├─ dist/              构建产物（单文件站点，可直接发布或双击）
└─ tests/
   ├─ test-engine.js      引擎单元测试（11 项）
   ├─ test-ui.js          无头浏览器冒烟测试
   ├─ test-ui-deep.js     CDP 深度交互测试
   ├─ test-offline.js     file:// 离线可用性
   └─ test-calibration.js 历史节点校准
```

---

## 八、测试

```bash
node tests/test-engine.js        # 引擎逻辑（11 项）
node tests/test-ui.js            # 页面能渲染（HTTP）
node tests/test-ui-deep.js       # what-if / 回溯 / 概率归一（CDP 交互）
node tests/test-offline.js       # file:// 离线可用
node tests/test-calibration.js   # 历史节点校准
```

### 引擎测试覆盖

| 用例 | 验证点 |
|---|---|
| 概率归一 | 冠军概率和 = 100%，名次矩阵每行和 = 1 |
| 种子可复现 | 同 seed 结果完全一致 |
| 极端情形 | 9 分 vs 最高 7 分 → 冠军概率 100% |
| 罚分 | −6 分正确生效 |
| 相互战绩 | 同分时按小联赛排序 |
| what-if | 强制比分使概率变确定 |

### 校准结果（中甲 2026）

| 预测节点 | 平均名次误差 | 冠军识别 |
|---|---|---|
| 第 10 轮 | 2.9 | 实际冠军排第 2（29.8%） |
| 第 15 轮 | 0.9 | ✅ 第 1（69.5%） |
| 第 20 轮 | 0.9 | ✅ 第 1（94.7%） |
| 第 24 轮 | 0.6 | ✅ 第 1（99.3%） |

误差随赛季推进单调收敛，说明模型没有系统性偏差。

---

## 九、已知限制

1. **不建模赛程密度/伤病/轮换**。模型只看进球率，不看"这是不是一周双赛"。
2. **不看转会**。赛季中换帅、买人不会反映到攻防强度上，除非该队之后踢了足够多比赛。
3. **升级附加赛按 50/50 处理**。若某联赛的升级名额由附加赛决定（如英冠），
   本工具只算"进入附加赛区"的概率，不模拟附加赛本身。
4. **同分规则依赖你配置的 `tiebreak`**。默认 `points → gd → gf → wins`；
   中甲、英超、西甲等实际规则不同，需要时用 `tiebreak` 覆盖。
5. **精度**：10 万次模拟时，概率的标准误约 ±0.16 个百分点（p=0.5 时）；
   想看 0.1% 量级的小概率，建议 50 万次以上。
6. **数据源单一**。只解析懂球帝；换源需要写新的解析器。

---

## 十、许可

MIT。数据版权归懂球帝所有，本工具仅做本地计算与展示。
