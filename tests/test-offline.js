/*
 * 离线测试：确认 dist/index.html 在 file:// 协议下可用
 *   - 数据已内联（不依赖网络）
 *   - 默认联赛留空、只显示提示
 *   - 选择联赛后能算出结果
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const { findFreePort } = require('./port.js');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
let CDP_PORT = 9361;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findBrowser() {
  return [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'
  ].find(c => fs.existsSync(c));
}
function getJson(u) {
  return new Promise((res, rej) => {
    http.get(u, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}}); }).on('error', rej);
  });
}

async function main() {
  CDP_PORT = await findFreePort(CDP_PORT);
  const browser = findBrowser();
  if (!browser) { console.log('SKIP: 无浏览器'); return; }

  const index = path.join(DIST, 'index.html');
  if (!fs.existsSync(index)) {
    console.log('FAIL: dist/index.html 不存在，先运行 node bin/build.js');
    process.exitCode = 1; return;
  }

  let bad = 0;
  const check = (n, c, x) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x ? '  ' + x : '')); if (!c) bad++; };

  // 静态检查：数据是否内联
  const html = fs.readFileSync(index, 'utf8');
  check('数据已内联到 index.html', /window\.SOCCER_DATA\s*=\s*\{/.test(html));
  check('引擎已内联', /SoccerEngine/.test(html));

  const profile = path.join(os.tmpdir(), 'offline-' + Date.now());
  const fileUrl = 'file:///' + index.replace(/\\/g, '/');
  const proc = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let t = null;
  for (let i = 0; i < 50; i++) {
    try { const l = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list'); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) {}
    await sleep(300);
  }
  if (!t) { console.log('  FAIL 无法启动浏览器'); proc.kill(); process.exitCode = 1; return; }

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { const { resolve } = p.get(m.id); p.delete(m.id); resolve(m.result); } };
  const send = (m2, params) => new Promise(res => { const i = ++id; p.set(i, { resolve: res }); ws.send(JSON.stringify({ id: i, method: m2, params: params || {} })); });
  const ev = async (x, aw) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: aw !== false });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result && r.result.value;
  };

  await send('Page.enable');
  await send('Page.navigate', { url: fileUrl });
  await sleep(2500);

  // 默认状态
  const selVal = await ev("document.getElementById('leagueSel').value");
  check('file:// 下默认联赛留空', selVal === '', '[' + selVal + ']');

  const statusTxt = await ev("document.getElementById('status').textContent");
  check('file:// 下显示引导提示', statusTxt.indexOf('请先') >= 0);

  // 选择联赛并计算
  await ev(`(() => {
    const s=document.getElementById('leagueSel');
    s.value='china-l1'; s.dispatchEvent(new Event('change'));
    document.getElementById('runBtn').click();
  })()`, false);
  await sleep(2800);

  const rows = await ev("document.querySelectorAll('#probTable tbody tr').length");
  check('file:// 下能算出结果', rows === 16, '(' + rows + ')');

  const hasTeam = await ev("[...document.querySelectorAll('#probTable tbody tr')].some(r=>r.textContent.indexOf('陕西联合')>=0)");
  check('结果含正确球队', hasTeam);

  const pcts = await ev("(document.body.innerText.match(/\\d+\\.\\d%/g)||[]).length");
  check('存在概率数值', pcts > 20, '(' + pcts + ')');

  const notErr = await ev("document.getElementById('status').className !== 'err'");
  check('file:// 下无错误', notErr);

  // 离线模式下不应尝试外网：把网络禁用后再算一次
  await send('Network.enable');
  await send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0
  });
  await ev(`(() => {
    document.getElementById('srcSel').value='bundled';
    document.getElementById('srcSel').dispatchEvent(new Event('change'));
    document.getElementById('runBtn').click();
  })()`, false);
  await sleep(2500);
  const rows2 = await ev("document.querySelectorAll('#probTable tbody tr').length");
  check('断网后仍能计算（内置快照）', rows2 === 16, '(' + rows2 + ')');

  ws.close(); proc.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}

  console.log('\n' + (bad ? bad + ' 项失败' : '全部通过'));
  if (bad) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exit(1); });
