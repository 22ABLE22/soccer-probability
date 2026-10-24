/*
 * 主题 / 默认状态 / 轮次下拉 / 自定义联赛 测试
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { findFreePort } = require('./port.js');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
let PORT = 8805, CDP_PORT = 9355;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function serve() {
  return new Promise(res => {
    const s = http.createServer((q, r) => {
      let p = new URL(q.url, 'http://x').pathname;
      if (p === '/') p = '/index.html';
      fs.readFile(path.join(DIST, p), (e, b) => {
        if (e) { r.writeHead(404); r.end('nf'); return; }
        r.writeHead(200, { 'Content-Type': p.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
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
  PORT = await findFreePort(PORT);
  CDP_PORT = await findFreePort(CDP_PORT);
  const server = await serve();
  const browser = findBrowser();
  if (!browser) { console.log('SKIP 无浏览器'); server.close(); return; }

  const profile = path.join(os.tmpdir(), 'theme-' + Date.now());
  const proc = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, 'about:blank'
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

  /* ---------- 默认状态 ---------- */
  const selVal = await cdp.eval("document.getElementById('leagueSel').value");
  check('联赛默认留空', selVal === '', '[' + selVal + ']');
  check('默认不显示结果区',
    await cdp.eval("getComputedStyle(document.getElementById('out')).display === 'none'"));

  const statusTxt = await cdp.eval("document.getElementById('status').textContent.trim()");
  check('提示用户先选联赛', statusTxt.indexOf('请先') >= 0);

  const roundDisabled0 = await cdp.eval("document.getElementById('roundSel').disabled");
  check('未选联赛时轮次下拉禁用', roundDisabled0 === true);

  /* ---------- 标题 ---------- */
  const title = await cdp.eval("document.title");
  check('页面标题为「足球计算器」', title === '足球计算器', '[' + title + ']');
  const h1 = await cdp.eval("document.querySelector('header h1').textContent.trim()");
  check('主标题为「足球计算器」', h1.indexOf('足球计算器') >= 0, '[' + h1 + ']');
  const hasSub = await cdp.eval("!!document.querySelector('header .sub')");
  check('已移除副标题', hasSub === false);

  /* ---------- 关键 bug：选联赛后立刻能选轮次 ---------- */
  await cdp.eval(`(() => {
    const s = document.getElementById('leagueSel');
    s.value = 'china-l1';
    s.dispatchEvent(new Event('change'));
  })()`, false);

  // 等待 prepareLeague 完成（轮次下拉被填充）
  let roundReady = false;
  for (let i = 0; i < 50; i++) {
    const n = await cdp.eval("document.querySelectorAll('#roundSel option').length");
    if (n > 1) { roundReady = true; break; }
    await sleep(200);
  }
  check('选联赛后轮次下拉自动填充（无需先点开始计算）', roundReady);

  const roundDisabled1 = await cdp.eval("document.getElementById('roundSel').disabled");
  check('选联赛后轮次下拉可用', roundDisabled1 === false);

  const roundOpts = await cdp.eval("[...document.querySelectorAll('#roundSel option')].map(o=>o.value)");
  check('轮次包含「全部」+ 30 轮', roundOpts.length === 31, '(' + roundOpts.length + ' 项)');

  const autoSelected = await cdp.eval("document.getElementById('roundSel').value");
  check('轮次默认选中「全部」', autoSelected === '', '[' + autoSelected + ']');

  // 选一个历史轮次后直接计算，应生效
  await cdp.eval(`(() => {
    const r = document.getElementById('roundSel');
    r.value = '20'; r.dispatchEvent(new Event('change'));
    document.getElementById('runBtn').click();
  })()`, false);
  await sleep(2500);
  const meta20 = await cdp.eval("document.getElementById('tableMeta').textContent");
  check('选第20轮后结果对应第20轮', meta20.indexOf('20') >= 0, '[' + meta20 + ']');

  /* ---------- 主题 ---------- */
  const themeSeq = [await cdp.eval("document.documentElement.getAttribute('data-theme')")];
  for (let i = 0; i < 5; i++) {
    await cdp.eval("document.getElementById('themeBtn').click()", false);
    await sleep(180);
    themeSeq.push(await cdp.eval("document.documentElement.getAttribute('data-theme')"));
  }
  check('主题循环 自动→夜间→日间→自动',
    JSON.stringify(themeSeq) === JSON.stringify(['auto', 'dark', 'light', 'auto', 'dark', 'light']),
    themeSeq.join('→'));

  await cdp.eval("document.documentElement.setAttribute('data-theme','light')", false);
  await sleep(300);
  const lightBg = await cdp.eval("getComputedStyle(document.body).backgroundColor");
  await cdp.eval("document.documentElement.setAttribute('data-theme','dark')", false);
  await sleep(300);
  const darkBg = await cdp.eval("getComputedStyle(document.body).backgroundColor");
  check('日间/夜间配色不同', lightBg !== darkBg, lightBg + ' vs ' + darkBg);

  /* ---------- 自定义联赛 ---------- */
  const customOpts = await cdp.eval(`(() => {
    const groups = [...document.querySelectorAll('#leagueSel optgroup')];
    const g = groups.find(x => x.label.indexOf('自定义') >= 0);
    return g ? [...g.querySelectorAll('option')].map(o => o.value) : [];
  })()`);
  check('自动识别 data/ 下的自定义联赛', customOpts.indexOf('sanhang-a') >= 0,
    '[' + customOpts.join(',') + ']');

  await cdp.eval(`(() => {
    const s = document.getElementById('leagueSel');
    s.value = 'sanhang-a';
    s.dispatchEvent(new Event('change'));
  })()`, false);
  let cReady = false;
  for (let i = 0; i < 50; i++) {
    const n = await cdp.eval("document.querySelectorAll('#roundSel option').length");
    if (n > 1) { cReady = true; break; }
    await sleep(200);
  }
  check('自定义联赛可加载', cReady);

  await cdp.eval("document.getElementById('runBtn').click()", false);
  await sleep(2500);
  const cRows = await cdp.eval("document.querySelectorAll('#probTable tbody tr').length");
  check('自定义联赛可算出概率', cRows === 10, '(' + cRows + ' 队)');

  const cHeads = await cdp.eval("[...document.querySelectorAll('#probTable thead th')].map(h=>h.textContent.trim()).join('|')");
  check('自定义联赛沿用其名次区间', cHeads.indexOf('晋级季后赛') >= 0 || cHeads.indexOf('降级至乙组') >= 0,
    '[' + cHeads + ']');

  const cSum = await cdp.eval(`(() => {
    const heads=[...document.querySelectorAll('#probTable thead th')].map(h=>h.textContent.trim());
    // 表头可能是「冠军」或「常规赛冠军」，按包含匹配
    const i=heads.findIndex(h=>h.indexOf('冠军')>=0);
    if(i<0) return null;
    let s=0; for(const r of document.querySelectorAll('#probTable tbody tr')) s += parseFloat(r.children[i].textContent)||0;
    return Math.round(s*10)/10;
  })()`);
  check('自定义联赛冠军概率合计=100%', Math.abs(cSum - 100) < 0.8, '(' + cSum + '%)');

  /* ---------- 页脚 ---------- */
  const footer = await cdp.eval("document.querySelector('footer').textContent.trim()");
  const footerHtml = await cdp.eval("document.querySelector('footer').innerHTML");
  check('页脚只有 GitHub', footer.length < 40 && footer.indexOf('GitHub') >= 0, '[' + footer + ']');
  check('页脚含仓库链接', footerHtml.indexOf('github.com/22ABLE22') >= 0);

  cdp.close(); proc.kill(); server.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}

  console.log('\n' + (bad ? bad + ' 项失败' : '全部通过'));
  if (bad) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exit(1); });
