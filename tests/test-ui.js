/*
 * 首屏冒烟测试：打开 dist/index.html（HTTP），验证
 *   - 引擎已加载
 *   - 联赛默认留空
 *   - 显示引导提示，不自动计算
 *   - 页面无报错
 * 完整的交互流程见 test-ui-deep.js / test-theme.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = 8811;

function serve() {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
  return new Promise(res => {
    const s = http.createServer((q, r) => {
      let p = new URL(q.url, 'http://x').pathname;
      if (p === '/') p = '/index.html';
      fs.readFile(path.join(DIST, p), (e, b) => {
        if (e) { r.writeHead(404); r.end('nf'); return; }
        r.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
        r.end(b);
      });
    });
    s.listen(PORT, '127.0.0.1', () => res(s));
  });
}

function findBrowser() {
  return [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'
  ].find(c => fs.existsSync(c));
}

async function main() {
  const server = await serve();
  const browser = findBrowser();
  if (!browser) { console.log('SKIP: 无浏览器'); server.close(); return; }

  const dump = path.join(os.tmpdir(), 'soccer-dom-' + Date.now() + '.html');
  await new Promise(res => {
    execFile(browser, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      '--virtual-time-budget=12000', '--dump-dom',
      'http://127.0.0.1:' + PORT + '/'
    ], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (stdout) fs.writeFileSync(dump, stdout, 'utf8');
      res();
    });
  });

  server.close();

  let bad = 0;
  const check = (n, c, x) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x ? '  ' + x : '')); if (!c) bad++; };

  if (!fs.existsSync(dump)) { console.log('FAIL: 没拿到 DOM'); process.exitCode = 1; return; }
  const dom = fs.readFileSync(dump, 'utf8');

  check('引擎已内联', /SoccerEngine/.test(dom));
  check('内置联赛都在下拉里', ['china-l1','csl','epl','laliga','seriea','bundesliga','ligue1']
    .every(k => dom.indexOf('value="' + k + '"') >= 0));
  check('存在「请选择」空选项', /<option value="">— 请选择 —<\/option>/.test(dom));
  check('默认显示引导提示', dom.indexOf('请先在上方「联赛」中选择一个联赛') >= 0);
  check('结果区默认隐藏', /id="out"[^>]*display:\s*none/.test(dom));
  check('主题按钮存在', /id="themeBtn"/.test(dom));
  check('页脚只有 GitHub', /GitHub @22ABLE22/.test(dom) && dom.indexOf('双泊松模型 + 蒙特卡洛') < 0);

  const statusErr = /id="status"[^>]*class="err"/.test(dom);
  check('无错误状态', !statusErr);

  try { fs.unlinkSync(dump); } catch (e) {}

  console.log('\n' + (bad ? bad + ' 项失败' : '全部通过'));
  if (bad) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exit(1); });
