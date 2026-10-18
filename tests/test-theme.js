/*
 * 主题 / 默认状态 测试
 *   1. 默认联赛留空，不自动计算
 *   2. 主题按钮依次循环 自动 → 夜间 → 日间 → 自动
 *   3. data-theme 正确切换，且配色变量真的变了
 *   4. 主题持久化到 localStorage
 *   5. 页脚只有 GitHub 链接
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = 8805;
const CDP_PORT = 9355;

function serve() {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
  return new Promise(res => {
    const s = http.createServer((req, rq) => {
      let p = new URL(req.url, 'http://x').pathname;
      if (p === '/') p = '/index.html';
      fs.readFile(path.join(DIST, p), (e, b) => {
        if (e) { rq.writeHead(404); rq.end('nf'); return; }
        rq.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
        rq.end(b);
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
function getJson(u) {
  return new Promise((res, rej) => {
    http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)) } catch (e) { rej(e) } }); }).on('error', rej);
  });
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const c = new CDP(ws);
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && c.p.has(m.id)) {
        const { resolve, reject } = c.p.get(m.id); c.p.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    };
    return c;
  }
  send(m, p) { const id = ++this.id; return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method: m, params: p || {} })) }) }
  async eval(e, aw) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: aw !== false });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  close() { this.ws.close(); }
}

async function main() {
  const server = await serve();
  const browser = findBrowser();
  if (!browser) { console.log('SKIP 无浏览器'); server.close(); return; }

  const profile = path.join(os.tmpdir(), 'theme-' + Date.now());
  const proc = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 50; i++) {
    try { const l = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list'); target = l.find(t => t.type === 'page'); if (target) break; } catch (e) {}
    await sleep(300);
  }
  if (!target) { console.log('FAIL CDP'); proc.kill(); server.close(); process.exitCode = 1; return; }

  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

  let bad = 0;
  const check = (n, c, x) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x ? '  ' + x : '')); if (!c) bad++; };

  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });
  await sleep(2500);

  /* 1. 默认状态：联赛空、不自动计算 */
  const selVal = await cdp.eval("document.getElementById('leagueSel').value");
  check('联赛默认留空', selVal === '', '[' + selVal + ']');

  const outHidden = await cdp.eval("getComputedStyle(document.getElementById('out')).display === 'none'");
  check('默认不显示结果区', outHidden);

  const statusTxt = await cdp.eval("document.getElementById('status').textContent.trim()");
  check('提示用户先选联赛', statusTxt.indexOf('请先') >= 0, '[' + statusTxt.slice(0, 30) + ']');

  const rows0 = await cdp.eval("document.querySelectorAll('#probTable tbody tr').length");
  check('默认未跑模拟', rows0 === 0, '(' + rows0 + ')');

  /* 2. 主题循环 */
  const themeSeq = [];
  const initial = await cdp.eval("document.documentElement.getAttribute('data-theme')");
  themeSeq.push(initial);
  check('初始主题为 auto', initial === 'auto', '[' + initial + ']');

  for (let i = 0; i < 5; i++) {
    await cdp.eval("document.getElementById('themeBtn').click()", false);
    await sleep(180);
    themeSeq.push(await cdp.eval("document.documentElement.getAttribute('data-theme')"));
  }
  console.log('    切换序列: ' + themeSeq.join(' → '));
  const expected = ['auto', 'dark', 'light', 'auto', 'dark', 'light'];
  check('循环顺序 自动→夜间→日间→自动', JSON.stringify(themeSeq) === JSON.stringify(expected));

  /* 3. 配色真的变了（注意：必须等一帧让 CSS 重算，不能在同一 eval 里读写） */
  await cdp.eval("document.body.style.transition='none'", false);

  await cdp.eval("document.documentElement.setAttribute('data-theme','light')", false);
  await sleep(350);
  const lightBg = await cdp.eval("getComputedStyle(document.body).backgroundColor");
  const lightFg = await cdp.eval("getComputedStyle(document.body).color");

  await cdp.eval("document.documentElement.setAttribute('data-theme','dark')", false);
  await sleep(350);
  const darkBg = await cdp.eval("getComputedStyle(document.body).backgroundColor");
  const darkFg = await cdp.eval("getComputedStyle(document.body).color");

  check('日间与夜间背景色不同', lightBg !== darkBg, lightBg + ' vs ' + darkBg);
  check('日间与夜间文字色不同', lightFg !== darkFg, lightFg + ' vs ' + darkFg);
  check('日间背景更亮', lightBg > darkBg, 'light=' + lightBg + ' dark=' + darkBg);

  /* 4. 持久化：用点击按钮的方式设置，再刷新验证 */
  // 先归零到 auto，再点击两次 -> light
  await cdp.eval("localStorage.setItem('soccer-probability-theme','auto'); location.reload()", false);
  await sleep(2200);
  await cdp.eval("document.getElementById('themeBtn').click()", false);  // auto -> dark
  await sleep(250);
  await cdp.eval("document.getElementById('themeBtn').click()", false);  // dark -> light
  await sleep(250);

  const stored = await cdp.eval("localStorage.getItem('soccer-probability-theme')");
  check('主题写入 localStorage', stored === 'light', '[' + stored + ']');

  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(2200);
  const afterReload = await cdp.eval("document.documentElement.getAttribute('data-theme')");
  check('刷新后保持上次主题(light)', afterReload === 'light', '[' + afterReload + ']');

  const lblAfter = await cdp.eval("document.getElementById('themeLbl').textContent");
  check('按钮文案同步为「日间」', lblAfter === '日间', '[' + lblAfter + ']');

  /* 5. 页脚 */
  const footer = await cdp.eval("document.querySelector('footer').textContent.trim()");
  const footerHtml = await cdp.eval("document.querySelector('footer').innerHTML");
  check('页脚只保留 GitHub 字样', footer.length < 40 && footer.indexOf('GitHub') >= 0, '[' + footer + ']');
  check('页脚含仓库链接', footerHtml.indexOf('github.com/22ABLE22') >= 0);
  check('页脚不再有引擎版本冗余', footer.indexOf('引擎') < 0 && footer.indexOf('双泊松') < 0);

  /* 6. 选择联赛后能正常计算 */
  await cdp.eval(`(() => {
    const s=document.getElementById('leagueSel');
    s.value='china-l1'; s.dispatchEvent(new Event('change'));
    document.getElementById('runBtn').click();
  })()`, false);
  await sleep(2600);
  const rows1 = await cdp.eval("document.querySelectorAll('#probTable tbody tr').length");
  check('选中联赛后正常出结果', rows1 === 16, '(' + rows1 + ')');

  cdp.close(); proc.kill(); server.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}

  console.log('\n' + (bad ? bad + ' 项失败' : '全部通过'));
  if (bad) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exit(1); });
