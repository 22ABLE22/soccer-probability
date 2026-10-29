#!/usr/bin/env node
/*!
 * 构建 dist/ —— 可直接推到 GitHub Pages 的纯静态站点
 *
 *   node bin/build.js
 *
 * 产物：
 *   dist/index.html          界面（内联引擎，单文件可离线双击打开）
 *   dist/engine.js           引擎（也给 Node 用）
 *   dist/data/*.json         联赛快照
 *   dist/.nojekyll           让 Pages 不忽略下划线开头的文件
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const WEB = path.join(ROOT, 'web');
const DATA = path.join(ROOT, 'data');

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

console.log('构建中…');
rmrf(DIST);
mkdirp(path.join(DIST, 'data'));

/* 1. 引擎 */
const engineSrc = fs.readFileSync(path.join(ROOT, 'src', 'engine.js'), 'utf8');
fs.writeFileSync(path.join(DIST, 'engine.js'), engineSrc, 'utf8');
console.log('  engine.js  ' + (engineSrc.length / 1024).toFixed(1) + ' KB');

/* 2. 数据快照：既写到 dist/data/，也内联进 index.html
 *    原因：file:// 协议下浏览器禁止 fetch 本地文件，
 *    只有内联数据才能做到"双击打开即用"。
 *
 *    文件名约定（用于推断 key）：
 *      china-l1-2026.json     -> china-l1
 *      epl-2026-27.json       -> epl
 *      校联赛-2026.json        -> 校联赛
 *    若 JSON 里自带 id 字段，则优先用 id。
 */
const bag = {};
let copied = 0;
const skipped = [];

/* 手工录入的联赛没有"抓取时间"，改用最后一次提交时间。
 * 回退链：git log -> 文件 mtime -> 已赛比赛的最大日期
 * （CI 是浅克隆，git 取不到时自动落到下一级，所以 workflow 里加了 fetch-depth: 0）
 */
function lastCommitTime(rel) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', rel], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000,
    }).trim();
    if (out) return new Date(out).toISOString();
  } catch (e) { /* 无 git 或浅克隆取不到，继续回退 */ }
  return null;
}

function lastPlayedDate(json) {
  let max = null;
  for (const m of json.matches || []) {
    if (!m.played || !m.date) continue;
    const t = new Date(m.date);
    if (!isNaN(t) && (!max || t > max)) max = t;
  }
  return max ? max.toISOString() : null;
}

function stampUpdatedAt(json, src, f) {
  if (!(json.meta && json.meta.manual)) return null;
  const rel = path.relative(ROOT, src).replace(/\\/g, '/');
  const at = lastCommitTime(rel)
    || lastPlayedDate(json)
    || new Date(fs.statSync(src).mtime).toISOString();
  if (!at) return null;
  json.meta.updatedAt = at;
  return at;
}

if (fs.existsSync(DATA)) {
  for (const f of fs.readdirSync(DATA)) {
    if (!f.endsWith('.json')) continue;
    if (f.startsWith('_')) continue;   // _status.json 等内部文件不当作联赛数据
    const src = path.join(DATA, f);

    let json;
    try {
      json = JSON.parse(fs.readFileSync(src, 'utf8'));
    } catch (e) {
      skipped.push(f + '（JSON 语法错误：' + e.message + '）');
      continue;
    }
    if (!json || !Array.isArray(json.teams) || !Array.isArray(json.matches)) {
      skipped.push(f + '（缺少 teams 或 matches 数组）');
      continue;
    }

    const updatedAt = stampUpdatedAt(json, src, f);

    const key = json.id || f.replace(/-\d{4}(-\d{2})?\.json$/, '').replace(/\.json$/, '');
    if (bag[key]) skipped.push(f + '（key 与已有数据重复：' + key + '）');
    else {
      bag[key] = json;
      // 手工录入联赛的 updatedAt 是构建时算出来的，要连同数据一起写进 dist
      if (updatedAt) fs.writeFileSync(path.join(DIST, 'data', f), JSON.stringify(json, null, 2) + '\n', 'utf8');
      else fs.copyFileSync(src, path.join(DIST, 'data', f));
      copied++;
      if (updatedAt) console.log('    手工录入 ' + key + ' 最后更新 ' + updatedAt);
    }
  }
}

const bagJson = JSON.stringify(bag);
console.log('  数据快照    ' + copied + ' 个（内联 ' + (bagJson.length / 1024).toFixed(0) + ' KB）');
if (skipped.length) {
  for (const s of skipped) console.log('    跳过 ' + s);
}

/* 3. 单文件 index.html：把 <script src="engine.js"> 换成内联 */
let html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
html = html.replace(
  '<script src="engine.js"></script>',
  '<script>\n' + engineSrc + '\n</script>\n' +
  '<script>window.SOCCER_DATA = ' + bagJson + ';</script>'
);
fs.writeFileSync(path.join(DIST, 'index.html'), html, 'utf8');
console.log('  index.html  ' + (html.length / 1024).toFixed(1) + ' KB (引擎 + 数据已内联)');

/* 4. Pages 配置 */
fs.writeFileSync(path.join(DIST, '.nojekyll'), '', 'utf8');

/* 5. 许可证与说明 */
const licPath = path.join(ROOT, 'LICENSE');
if (fs.existsSync(licPath)) {
  fs.copyFileSync(licPath, path.join(DIST, 'LICENSE'));
}
fs.writeFileSync(path.join(DIST, 'README.txt'),
  '足球计算器 —— 纯前端联赛概率模拟\n\n' +
  '打开 index.html 即可使用（无需服务器、无需联网、不上传任何数据）。\n' +
  '在线版：https://22able22.github.io/soccer-probability/\n' +
  '源码：https://github.com/22ABLE22/soccer-probability\n' +
  '许可：MIT\n', 'utf8');

console.log('\n完成 → ' + DIST);
console.log('可直接双击 dist/index.html，或把 dist/ 推送到 GitHub Pages。');
