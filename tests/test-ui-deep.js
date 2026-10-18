/* 深度 UI 测试：通过 CDP 注入操作，验证 what-if 与轮次回溯 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = 8802;
const CDP_PORT = 9333;

function serve() {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      let p = new URL(req.url, 'http://x').pathname;
      if (p === '/') p = '/index.html';
      fs.readFile(path.join(DIST, p), (e, b) => {
        if (e) { res.writeHead(404); res.end('nf'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
        res.end(b);
      });
    });
    s.listen(PORT, '127.0.0.1', () => resolve(s));
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

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { resolve, reject } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      }
    };
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expr, awaitPromise) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true,
      awaitPromise: awaitPromise !== false
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  }
  close() { this.ws.close(); }
}

async function main() {
  const server = await serve();
  const browser = findBrowser();
  if (!browser) { console.log('SKIP: 无浏览器'); server.close(); return; }

  const profile = path.join(os.tmpdir(), 'soccer-cdp-' + Date.now());
  const proc = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40; i++) {
    try {
      const list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch (e) {}
    await sleep(250);
  }
  if (!target) { console.log('FAIL: 连不上 CDP'); proc.kill(); server.close(); process.exitCode = 1; return; }

  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  let bad = 0;
  const check = (name, cond, extra) => {
    console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
    if (!cond) bad++;
  };

  // 1) 打开页面
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });
  await sleep(2500);

  // 联赛默认留空，先断言这一点，再主动选择
  const blankSel = await cdp.eval("document.getElementById('leagueSel').value");
  check('联赛默认留空', blankSel === '', '[' + blankSel + ']');

  await cdp.eval(`(() => {
    const s = document.getElementById('leagueSel');
    s.value = 'china-l1';
    s.dispatchEvent(new Event('change'));
    document.getElementById('runBtn').click();
  })()`, false);

  let ready = false;
  for (let i = 0; i < 40; i++) {
    ready = await cdp.eval("document.querySelectorAll('#probTable tbody tr').length > 0");
    if (ready) break;
    await sleep(300);
  }
  check('选择联赛后完成计算', ready);

  const rows0 = await cdp.eval("document.querySelectorAll('#probTable tbody tr').length");
  check('概率表行数 = 16', rows0 === 16, '(实际 ' + rows0 + ')');

  // 2) 读取某队概率
  const getP = async (team) => cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#probTable tbody tr')];
    const r = rows.find(x => x.children[1].textContent.trim() === ${JSON.stringify(team)});
    if (!r) return null;
    const cells = [...r.children].map(td => td.textContent.trim());
    return { expPts: cells[2], expPos: cells[3], title: cells[5], promo: cells[6], releg: cells[7] };
  })()`);

  const shanxi0 = await getP('陕西联合');
  check('陕西联合初始升级概率在合理区间', shanxi0 && parseFloat(shanxi0.promo) > 1 && parseFloat(shanxi0.promo) < 12,
    '(' + (shanxi0 && shanxi0.promo) + ')');

  // 3) 轮次回溯：选第 20 轮
  const roundOptions = await cdp.eval("document.querySelectorAll('#roundSel option').length");
  check('轮次下拉有选项', roundOptions > 25, '(' + roundOptions + ' 项)');

  await cdp.eval(`(() => {
    const s = document.getElementById('roundSel');
    s.value = '20';
    s.dispatchEvent(new Event('change'));
    document.getElementById('runBtn').click();
  })()`, false);
  await sleep(2500);

  const shanxi20 = await getP('陕西联合');
  check('第20轮陕西升级概率低于当前', shanxi20 && parseFloat(shanxi20.promo) < parseFloat(shanxi0.promo),
    '(第20轮 ' + (shanxi20 && shanxi20.promo) + ' vs 当前 ' + shanxi0.promo + ')');

  // 4) 回到全部
  await cdp.eval(`(() => {
    const s = document.getElementById('roundSel');
    s.value = '';
    s.dispatchEvent(new Event('change'));
    document.getElementById('runBtn').click();
  })()`, false);
  await sleep(2500);

  // 5) what-if：梅州 1-0 胜南通
  await cdp.eval("document.getElementById('addWfBtn').click()", false);
  await sleep(300);
  const wfOk = await cdp.eval("document.querySelectorAll('#whatifList .wf').length");
  check('what-if 行已添加', wfOk === 1);

  await cdp.eval(`(() => {
    const row = document.querySelector('#whatifList .wf');
    const sels = row.querySelectorAll('select');
    sels[0].value = '梅州客家'; sels[0].dispatchEvent(new Event('change'));
    sels[1].value = '南通支云'; sels[1].dispatchEvent(new Event('change'));
    const ins = row.querySelectorAll('input');
    ins[0].value = '1'; ins[0].dispatchEvent(new Event('input'));
    ins[1].value = '0'; ins[1].dispatchEvent(new Event('input'));
    document.getElementById('runBtn').click();
  })()`, false);
  await sleep(3000);

  const shanxiWf = await getP('陕西联合');
  check('what-if 后陕西概率上升', shanxiWf && parseFloat(shanxiWf.promo) > parseFloat(shanxi0.promo),
    '(' + (shanxiWf && shanxiWf.promo) + ' vs ' + shanxi0.promo + ')');

  const nantongWf = await getP('南通支云');
  check('南通概率下降', nantongWf && parseFloat(nantongWf.promo) < 81.4,
    '(' + (nantongWf && nantongWf.promo) + ')');

  // 6) 汇总仍为 100%
  const sum = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#probTable tbody tr')];
    let s = 0;
    for (const r of rows) s += parseFloat(r.children[6].textContent) || 0;
    return Math.round(s * 10) / 10;
  })()`);
  check('升级概率合计 ≈ 200%（2 个名额）', Math.abs(sum - 200) < 0.6, '(' + sum + '%)');

  const sumTitle = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#probTable tbody tr')];
    let s = 0;
    for (const r of rows) s += parseFloat(r.children[5].textContent) || 0;
    return Math.round(s * 10) / 10;
  })()`);
  check('冠军概率合计 = 100%', Math.abs(sumTitle - 100) < 0.6, '(' + sumTitle + '%)');

  cdp.close();
  proc.kill();
  server.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}

  console.log('\n' + (bad ? bad + ' 项失败' : '全部通过'));
  if (bad) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
