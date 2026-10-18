/*
 * 离线测试：确认 dist/index.html 在 file:// 协议下也能出结果
 * （这是"双击打开即用"的核心保证）
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function findBrowser() {
  return [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'
  ].find(c => fs.existsSync(c));
}

async function main() {
  const browser = findBrowser();
  if (!browser) { console.log('SKIP: 无浏览器'); return; }

  const index = path.join(DIST, 'index.html');
  if (!fs.existsSync(index)) { console.log('FAIL: dist/index.html 不存在，先运行 node bin/build.js'); process.exitCode = 1; return; }

  // 检查数据是否内联
  const html = fs.readFileSync(index, 'utf8');
  const inlined = /window\.SOCCER_DATA\s*=\s*\{/.test(html);
  console.log((inlined ? '  PASS  ' : '  FAIL  ') + '数据已内联到 index.html');
  let bad = inlined ? 0 : 1;

  const dump = path.join(os.tmpdir(), 'soccer-offline-' + Date.now() + '.html');
  await new Promise(res => {
    execFile(browser, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      '--virtual-time-budget=15000', '--dump-dom',
      'file:///' + index.replace(/\\/g, '/')
    ], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (stdout) fs.writeFileSync(dump, stdout, 'utf8');
      res();
    });
  });

  if (!fs.existsSync(dump)) { console.log('  FAIL  没拿到 DOM'); process.exitCode = 1; return; }
  const dom = fs.readFileSync(dump, 'utf8');

  const hasRows = /id="probTable"[\s\S]{0,200}?<tbody>/.test(dom) &&
    /广东广州豹/.test(dom);
  console.log((hasRows ? '  PASS  ' : '  FAIL  ') + 'file:// 下成功渲染出结果');
  if (!hasRows) bad++;

  const statusText = (/<div id="status"[^>]*>([\s\S]{0,200}?)<\/div>/.exec(dom) || [, ''])[1]
    .replace(/<[^>]+>/g, '').trim();
  const hasErr = statusText.indexOf('出错了') >= 0;
  console.log((hasErr ? '  FAIL  ' : '  PASS  ') + 'file:// 下无错误' +
    (hasErr ? '（' + statusText.slice(0, 60) + '）' : ''));
  if (hasErr) bad++;

  const pcts = (dom.match(/\d+\.\d%/g) || []).length;
  console.log((pcts > 20 ? '  PASS  ' : '  FAIL  ') + '概率数值数量 (' + pcts + ')');
  if (pcts <= 20) bad++;

  try { fs.unlinkSync(dump); } catch (e) {}

  console.log('\n' + (bad ? bad + ' 项失败' : '全部通过'));
  if (bad) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
