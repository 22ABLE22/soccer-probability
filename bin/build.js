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
 *    只有内联数据才能做到"双击打开即用"。 */
const bag = {};
let copied = 0;
if (fs.existsSync(DATA)) {
  for (const f of fs.readdirSync(DATA)) {
    if (!f.endsWith('.json')) continue;
    const src = path.join(DATA, f);
    fs.copyFileSync(src, path.join(DIST, 'data', f));
    // 文件名形如 china-l1-2026.json -> key = china-l1
    const key = f.replace(/-\d{4}(-\d{2})?\.json$/, '');
    try {
      bag[key] = JSON.parse(fs.readFileSync(src, 'utf8'));
    } catch (e) {
      console.warn('  跳过损坏的 ' + f + ': ' + e.message);
      continue;
    }
    copied++;
  }
}
const bagJson = JSON.stringify(bag);
console.log('  数据快照    ' + copied + ' 个（内联 ' + (bagJson.length / 1024).toFixed(0) + ' KB）');

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

/* 5. 版权/说明 */
fs.writeFileSync(path.join(DIST, 'README.txt'),
  'Soccer Probability Calculator\n' +
  '打开 index.html 即可使用（无需服务器，无需联网）。\n' +
  '若要在线抓取最新数据，见项目根目录的 README.md。\n', 'utf8');

console.log('\n完成 → ' + DIST);
console.log('可直接双击 dist/index.html，或把 dist/ 推送到 GitHub Pages。');
