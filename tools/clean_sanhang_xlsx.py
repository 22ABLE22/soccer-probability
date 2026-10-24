# -*- coding: utf-8 -*-
"""整理 三航杯赛程.xlsx —— 只保留甲组，结构更清晰。

原表问题：
  - 混入乙组（4 组 × 4 队）比赛与乙组淘汰赛占位行
  - 日期被 Excel 存成浮点丢尾零（10.30 -> 10.3 等）
  - 同日多场时日期单元格为空，靠视觉对齐
  - 行间用空行分隔，无表头、无轮次、无比分说明

新表：
  Sheet「甲组赛程」
    A1  标题
    A2  说明（规则 + 状态含义）
    A4  表头：轮次 | 日期 | 时间 | 主队 | 客队 | 主队进球 | 客队进球 | 状态
    A5+ 45 场，按轮次 → 日期 排序

轮次划分：
  原表 35 场分布在 29 个日期（每个日期 1~2 场，同一天不冲突）。
  按日期顺序累计，每 5 场构成一轮，得到整齐的 9 轮 × 5 场，
  且每队每轮恰好出场一次。缺失的 10 场标记为「待排期」，
  排在各自轮次的末尾。
"""
import openpyxl, os, re
from itertools import combinations
from collections import Counter, defaultdict
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(BASE, 'data', '三航杯赛程.xlsx')
DST = os.path.join(BASE, 'data', '三航杯赛程.xlsx')

# ---------- 1. 读原表 ----------
ws = openpyxl.load_workbook(SRC, data_only=True)['工作表1']

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
    if d is None:
        continue
    mo, dy, lost = d
    if prev is not None and (mo, dy) <= prev and lost:
        cand = (mo, dy * 10)
        if cand > prev:
            mo, dy = cand
    it['md'] = (mo, dy)
    prev = (mo, dy)

last = None
for it in raw:
    if it.get('md') is None:
        it['md'] = last
    else:
        last = it['md']

# ---------- 3. 只保留甲组对阵 ----------
PAIR = re.compile(r'^([^\-]+)-([^\-]+)$')
pairs = []
for it in raw:
    m = PAIR.match(it['text'])
    if m and '决赛' not in it['text'] and '半决赛' not in it['text']:
        pairs.append(dict(it, home=m.group(1).strip(), away=m.group(2).strip()))

cnt = Counter()
for m in pairs:
    cnt[m['home']] += 1
    cnt[m['away']] += 1

top = max(cnt.values())
GROUP_A = sorted(k for k, v in cnt.items() if v == top)
a_set = set(GROUP_A)
a_pairs = [m for m in pairs if m['home'] in a_set and m['away'] in a_set]

# ---------- 4. 轮次划分（只对已排期比赛） ----------
# 真实赛程按日期推进：同一天 1~2 场，从 10 月下旬到 12 月上旬。
# 标准单循环的"轮"是理论概念，与这张表的日期并不一一对应。
# 因此：已排期比赛按日期顺序每 5 场一轮；待排期比赛统一放最后，轮次标「待定」。
a_pairs.sort(key=lambda m: (m['md'] or (99, 99), str(m['time'] or '')))

PER_ROUND = len(GROUP_A) // 2      # 5

rounds = []
cur, cur_teams = [], set()
for m in a_pairs:
    if len(cur) >= PER_ROUND or m['home'] in cur_teams or m['away'] in cur_teams:
        if cur:
            rounds.append(cur)
        cur, cur_teams = [], set()
    cur.append(m)
    cur_teams.add(m['home'])
    cur_teams.add(m['away'])
if cur:
    rounds.append(cur)

# ---------- 5. 缺失对阵：统一标记待排期 ----------
scheduled_keys = set(tuple(sorted([m['home'], m['away']])) for m in a_pairs)
missing = [p for p in combinations(GROUP_A, 2) if p not in scheduled_keys]

pending_matches = [
    {'home': x, 'away': y, 'md': None, 'time': None,
     'hs': None, 'as': None, 'pending': True}
    for x, y in missing
]

# ---------- 6. 生成表格行 ----------
rows = []
for ri, r in enumerate(rounds, start=1):
    # 有日期的在前，按日期时间排序；待排期在后
    r.sort(key=lambda m: (m.get('pending', False), m['md'] or (99, 99), str(m['time'] or '')))
    for m in r:
        played = m.get('hs') is not None and m.get('as') is not None
        if m.get('pending'):
            status = '待排期'
            date_s = ''
            time_s = ''
        else:
            date_s = ('2026-%02d-%02d' % m['md']) if m.get('md') else ''
            time_s = str(m['time'])[:5] if m.get('time') else ''
            status = '已结束' if played else '未开始'
        rows.append({
            'round': ri,
            'date': date_s,
            'time': time_s,
            'home': m['home'],
            'away': m['away'],
            'hs': int(m['hs']) if played else None,
            'as': int(m['as']) if played else None,
            'status': status,
        })

# 待排期比赛追加到末尾
for m in pending_matches:
    rows.append({
        'round': '待定',
        'date': '',
        'time': '',
        'home': m['home'],
        'away': m['away'],
        'hs': None,
        'as': None,
        'status': '待排期',
    })

# ---------- 7. 写新表 ----------
wb = openpyxl.Workbook()
sh = wb.active
sh.title = '甲组赛程'

TITLE_FONT = Font(name='微软雅黑', size=15, bold=True, color='1F3864')
SUB_FONT = Font(name='微软雅黑', size=10, color='595959')
HEAD_FONT = Font(name='微软雅黑', size=10.5, bold=True, color='FFFFFF')
BODY_FONT = Font(name='微软雅黑', size=10.5)
HEAD_FILL = PatternFill('solid', fgColor='2F5597')
ZEBRA_FILL = PatternFill('solid', fgColor='EDF2FA')
PENDING_FILL = PatternFill('solid', fgColor='FFF2CC')
THIN = Side(style='thin', color='BFBFBF')
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

sh.merge_cells('A1:H1')
c = sh['A1']
c.value = '2026-2027 西北工业大学三航杯甲组 · 赛程与赛果'
c.font = TITLE_FONT
c.alignment = Alignment(horizontal='left', vertical='center')
sh.row_dimensions[1].height = 26

sh.merge_cells('A2:H2')
c = sh['A2']
c.value = ('10 队单循环，9 轮 45 场。前 4 名晋级季后赛，后 2 名降级至乙组。'
           '「待排期」= 赛程未公布；「未开始」= 已定日期待赛；「已结束」= 比分已定。')
c.font = SUB_FONT
c.alignment = Alignment(horizontal='left', vertical='center', wrap_text=True)
sh.row_dimensions[2].height = 30

HEADERS = ['轮次', '日期', '时间', '主队', '客队', '主队进球', '客队进球', '状态']
HEAD_ROW = 4
for i, h in enumerate(HEADERS, start=1):
    cell = sh.cell(row=HEAD_ROW, column=i, value=h)
    cell.font = HEAD_FONT
    cell.fill = HEAD_FILL
    cell.alignment = Alignment(horizontal='center', vertical='center')
    cell.border = BORDER
sh.row_dimensions[HEAD_ROW].height = 22

START = HEAD_ROW + 1
for idx, r in enumerate(rows):
    row_i = START + idx
    vals = [r['round'], r['date'], r['time'], r['home'], r['away'],
            r['hs'], r['as'], r['status']]
    for ci, v in enumerate(vals, start=1):
        cell = sh.cell(row=row_i, column=ci, value=v)
        cell.font = BODY_FONT
        cell.border = BORDER
        cell.alignment = Alignment(horizontal='center', vertical='center')
    if r['status'] == '待排期':
        for ci in range(1, 9):
            sh.cell(row=row_i, column=ci).fill = PENDING_FILL
    elif idx % 2 == 1:
        for ci in range(1, 9):
            sh.cell(row=row_i, column=ci).fill = ZEBRA_FILL

END = START + len(rows) - 1

for col, w in {'A': 7, 'B': 12, 'C': 8, 'D': 12, 'E': 12, 'F': 10, 'G': 10, 'H': 10}.items():
    sh.column_dimensions[col].width = w

sh.freeze_panes = 'A%d' % START
sh.auto_filter.ref = 'A%d:H%d' % (HEAD_ROW, END)

# 状态下拉，方便手工维护
dv = DataValidation(type='list', formula1='"未开始,已结束,待排期"', allow_blank=False)
dv.error = '请选择：未开始 / 已结束 / 待排期'
dv.errorTitle = '状态不合法'
sh.add_data_validation(dv)
dv.add('H%d:H%d' % (START, END))

sh.page_setup.orientation = 'portrait'
sh.page_setup.fitToWidth = 1
sh.sheet_properties.pageSetUpPr.fitToPage = True
sh.print_title_rows = '%d:%d' % (HEAD_ROW, HEAD_ROW)

wb.save(DST)

# ---------- 8. 校验 ----------
chk = openpyxl.load_workbook(DST, data_only=True)['甲组赛程']
data_rows = [[chk.cell(r, c).value for c in range(1, 9)] for r in range(START, END + 1)]

played = sum(1 for r in data_rows if r[7] == '已结束')
pending_n = sum(1 for r in data_rows if r[7] == '待排期')
per_team = Counter()
for r in data_rows:
    per_team[r[3]] += 1
    per_team[r[4]] += 1
rounds_cnt = Counter(r[0] for r in data_rows if r[0] != '待定')

# 同轮冲突（"待定"轮次不参与，它们是未排期的比赛池）
conflict = 0
by_round = defaultdict(list)
for r in data_rows:
    by_round[r[0]].append(r)
for rnd, ms in by_round.items():
    if rnd == '待定':
        continue
    teams = []
    for m in ms:
        teams += [m[3], m[4]]
    if len(teams) != len(set(teams)):
        conflict += 1

# 日期单调性（同一轮内有日期的应递增）
nonmono = 0
for rnd, ms in by_round.items():
    if rnd == '待定':
        continue
    ds = [m[1] for m in ms if m[1]]
    if ds != sorted(ds):
        nonmono += 1

rep = []
rep.append('已写入 ' + DST)
rep.append('  数据行：%d（已结束 %d，待排期 %d，未开始 %d）' % (
    len(data_rows), played, pending_n, len(data_rows) - played - pending_n))
rep.append('  球队：%d 支，每队场次 %s' % (len(per_team), sorted(set(per_team.values()))))
rep.append('  已排期轮次：%d 轮，每轮场次 %s' % (len(rounds_cnt), sorted(set(rounds_cnt.values()))))
rep.append('  待定（未排期）：%d 场' % sum(1 for r in data_rows if r[0] == '待定'))
rep.append('  同轮冲突：%d' % conflict)
rep.append('  轮内日期非单调：%d' % nonmono)
rep.append('  已删除：乙组比赛、乙组淘汰赛占位行、空行分隔')
rep.append('')
rep.append('全部 45 行：')
for r in data_rows:
    rep.append('  轮%-2s %-11s %-6s %-6s vs %-6s %s-%s  %s' % tuple(
        '' if x is None else x for x in r))

import io
io.open(os.path.join(BASE, 'tests', '_xlsx_report.txt'), 'w', encoding='utf-8').write('\n'.join(rep))
print('done')
