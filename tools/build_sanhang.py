# -*- coding: utf-8 -*-
"""把 三航杯赛程.xlsx 转成引擎用的 league JSON（只做甲组）。

已与用户确认：
  - 甲组 10 队单循环，共 9 轮 45 场；赛程表只排了 35 场，
    缺的 10 场按"尚未排期"处理，计入剩余比赛由模型模拟。
  - 乙组（16 队 4 组）暂不纳入。

轮次处理：
  10 队单循环标准是 9 轮 × 5 场。已排期比赛保留其原始日期，
  轮次用"圆桌法"(circle method) 生成的标准单循环表对齐：
  同一对阵无论原表排在哪天，都归到它在该标准表里所属的轮次。
  待排期的 10 场自然落到空位里，最终正好 9 轮 45 场。

Excel 数据问题：
  - 10.30 / 11.10 / 11.20 / 11.30 被存成 float 后丢尾零，按单调性还原。
  - 日期为空的行继承上一行日期。
"""
import openpyxl, io, json, re
from itertools import combinations
from collections import Counter, defaultdict

import os
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(BASE, 'data', '三航杯赛程.xlsx')
OUT = os.path.join(BASE, 'data', 'sanhang-a.json')

ws = openpyxl.load_workbook(SRC, data_only=True)['工作表1']

# ---------- 1. 读原始行 ----------
raw = []
for r in range(2, ws.max_row + 1):
    t = ws.cell(r, 3).value
    if t is None:
        continue
    t = str(t).strip()
    if not t:
        continue
    raw.append({
        'row': r,
        'date': ws.cell(r, 1).value,
        'time': ws.cell(r, 2).value,
        'text': t,
        'hs': ws.cell(r, 4).value,
        'as': ws.cell(r, 5).value,
    })

# ---------- 2. 日期解析（尾零还原） ----------
def parse_md(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        s = repr(float(v)) if isinstance(v, float) else str(v)
        if '.' in s:
            a, b = s.split('.')
            b = b.rstrip('0') or '0'
            return (int(a), int(b), len(b) == 1)
        return (int(v), 1, False)
    s = str(v).strip()
    m = re.match(r'^(\d{1,2})[.．](\d{1,2})$', s)
    if m:
        a, b = m.group(1), m.group(2)
        return (int(a), int(b), len(b) == 1)
    return None

prev = None
for it in raw:
    d = parse_md(it['date'])
    it['parsed'] = d
    if d is None:
        continue
    mo, dy, lost = d
    if prev is not None and (mo, dy) <= prev and lost:
        cand = (mo, dy * 10)
        if cand > prev:
            mo, dy = cand
            it['fixedFrom'] = '%d.%d' % (d[0], d[1])
    it['md'] = (mo, dy)
    prev = (mo, dy)

last = None
for it in raw:
    if it.get('md') is None:
        it['md'] = last
    else:
        last = it['md']

# ---------- 3. 对阵 / 占位 ----------
PAIR = re.compile(r'^([^\-]+)-([^\-]+)$')
pairs, placeholders = [], []
for it in raw:
    m = PAIR.match(it['text'])
    if m and '决赛' not in it['text'] and '半决赛' not in it['text']:
        pairs.append(dict(it, home=m.group(1).strip(), away=m.group(2).strip()))
    else:
        placeholders.append(it)

# ---------- 4. 甲组 ----------
cnt = Counter()
for m in pairs:
    cnt[m['home']] += 1
    cnt[m['away']] += 1
top = max(cnt.values())
GROUP_A = sorted(k for k, v in cnt.items() if v == top)
a_set = set(GROUP_A)
a_pairs = [m for m in pairs if m['home'] in a_set and m['away'] in a_set]

# ---------- 5. 标准单循环轮次表（圆桌法） ----------
def circle_rounds(teams):
    """返回 [(round_idx, (a, b)), ...]，10 队 9 轮 45 场"""
    ts = list(teams)
    if len(ts) % 2 == 1:
        ts.append(None)          # 轮空
    n = len(ts)
    rounds = []
    fixed = ts[0]
    rot = ts[1:]
    for r in range(n - 1):
        pairs = []
        left = [fixed] + rot[:len(rot) // 2] if False else None
        # 标准圆桌：fixed 与 rot 最后一个配对
        arr = [fixed] + rot
        for i in range(n // 2):
            a, b = arr[i], arr[n - 1 - i]
            if a is not None and b is not None:
                pairs.append((a, b))
        rounds.append(pairs)
        rot = [rot[-1]] + rot[:-1]      # 旋转
    return rounds

std = circle_rounds(GROUP_A)
pair_to_round = {}
for ri, pairs in enumerate(std):
    for a, b in pairs:
        pair_to_round[tuple(sorted([a, b]))] = ri + 1

# 校验：45 场齐全
assert len(pair_to_round) == len(list(combinations(GROUP_A, 2))), \
    '标准表不完整: %d' % len(pair_to_round)

# ---------- 6. 生成比赛 ----------
# 每轮的主客场：原表给了方向就沿用，否则用标准表的顺序
round_matches = defaultdict(list)
for m in a_pairs:
    key = tuple(sorted([m['home'], m['away']]))
    rnd = pair_to_round[key]
    played = m['hs'] is not None and m['as'] is not None
    md = m.get('md')
    round_matches[rnd].append({
        'home': m['home'],
        'away': m['away'],
        'date': ('2026-%02d-%02d' % md) if md else None,
        'hs': m['hs'], 'as': m['as'],
        'played': played,
        'srcRow': m['row'],
    })

# 待排期：标准表里没有出现在原表的那 10 场
scheduled_keys = set(tuple(sorted([m['home'], m['away']])) for m in a_pairs)
missing = [(a, b) for (a, b) in
           [tuple(sorted(p)) for p in combinations(GROUP_A, 2)]
           if (a, b) not in scheduled_keys]

for a, b in missing:
    rnd = pair_to_round[tuple(sorted([a, b]))]
    round_matches[rnd].append({
        'home': a, 'away': b,
        'date': None, 'hs': None, 'as': None,
        'played': False, 'srcRow': None,
    })

# 按轮次输出
matches = []
for rnd in range(1, len(std) + 1):
    ms = round_matches.get(rnd, [])
    # 轮内排序：有日期的在前
    ms.sort(key=lambda x: (x['date'] is None, x['date'] or ''))
    for m in ms:
        matches.append({
            'id': 'm%03d' % (len(matches) + 1),
            'round': rnd,
            'date': m['date'],
            'home': m['home'],
            'away': m['away'],
            'homeGoals': int(m['hs']) if m['played'] else None,
            'awayGoals': int(m['as']) if m['played'] else None,
            'played': m['played'],
        })

# ---------- 7. 校验 ----------
per_team = Counter()
for m in matches:
    per_team[m['home']] += 1
    per_team[m['away']] += 1

per_round = Counter(m['round'] for m in matches)

conflict = 0
for rnd in range(1, len(std) + 1):
    seen = set()
    for m in matches:
        if m['round'] != rnd:
            continue
        if m['home'] in seen or m['away'] in seen:
            conflict += 1
        seen.add(m['home'])
        seen.add(m['away'])

# ---------- 8. 组装 ----------
league = {
    'id': 'sanhang-a',
    'name': '2026-2027西北工业大学三航杯甲组',
    'season': '2026-2027',
    'teams': [{'id': t, 'name': t} for t in GROUP_A],
    'matches': matches,
    'points': {'win': 3, 'draw': 1, 'loss': 0},
    'tiebreak': ['points', 'gd', 'gf', 'wins'],
    'slots': [
        {'from': 1, 'to': 1, 'type': 'title', 'label': '常规赛冠军', 'color': '#ffd54f'},
        {'from': 1, 'to': 4, 'type': 'playoff', 'label': '晋级季后赛', 'color': '#2e7d32'},
        {'from': 9, 'to': 10, 'type': 'relegation', 'label': '降级至乙组', 'color': '#c62828'},
    ],
    'model': {},
    'meta': {
        'source': '三航杯赛程.xlsx',
        'fetchedAt': '2026-10-24T00:00:00.000Z',
        'maxRound': len(std),
        'note': '校级联赛；10 队单循环 9 轮 45 场，已排期 %d 场，其余 %d 场待排期'
                % (len(a_pairs), len(missing)),
        'scheduledMatches': len(a_pairs),
        'pendingMatches': len(missing),
        'dateFixes': [
            {'row': it['row'], 'from': it['fixedFrom'], 'to': '%d.%d' % it['md']}
            for it in raw if it.get('fixedFrom')
        ],
        'skippedRows': [{'row': p['row'], 'text': p['text']} for p in placeholders],
    },
}

io.open(OUT, 'w', encoding='utf-8', newline='').write(
    json.dumps(league, ensure_ascii=False, indent=2) + '\n')

# ---------- 9. 报告 ----------
rep = []
rep.append('甲组：%d 队，%d 场，%d 轮' % (len(league['teams']), len(matches), len(std)))
rep.append('  已排期 %d 场（已赛 %d），待排期 %d 场' % (
    len(a_pairs), sum(1 for m in matches if m['played']), len(missing)))
rep.append('  每队场次：%s' % ('全部 9 场 OK' if all(v == 9 for v in per_team.values()) else dict(per_team)))
rep.append('  每轮场次：%s' % [per_round.get(r, 0) for r in range(1, len(std) + 1)])
rep.append('  同轮重复出场：%d' % conflict)
rep.append('')
rep.append('日期修正：')
for f in league['meta']['dateFixes']:
    rep.append('  r%-3d %s -> %s' % (f['row'], f['from'], f['to']))
rep.append('')
rep.append('待排期对阵（已补入对应轮次）：')
for a, b in missing:
    rep.append('  %s - %s  -> 第 %d 轮' % (a, b, pair_to_round[tuple(sorted([a, b]))]))
rep.append('')
rep.append('跳过的占位行：')
for p in placeholders:
    rep.append('  r%-3d %s' % (p['row'], p['text']))

io.open(r'C:\Users\Admin\AppData\Local\Temp\sanhang_report.txt', 'w', encoding='utf-8').write('\n'.join(rep))
print('written')
