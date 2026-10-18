/*
 * 线上验收：直接访问 GitHub Pages，核对本轮全部改动
 *   node tests/live-check.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SITE = 'https://22able22.github.io/soccer-probability/';
const CDP_PORT = 9391;
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
  const profile = path.join(os.tmpdir(), 'live-' + Date.now());
  const proc = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--proxy-server=http://127.0.0.1:7897',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let t = null;
  for (let i = 0; i < 60; i++) {
    try { const l = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list'); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) {}
    await sleep(300);
  }
  if (!t) { console.log('FAIL: 连不上浏览器'); proc.kill(); process.exitCode = 1; return; }

  const cdp = await CDP.connect(t.webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

  let bad = 0;
  const check = (n, c, x) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x ? '  ' + x : '')); if (!c) bad++; };

  await cdp.send('Page.navigate', { url: SITE });
  await sleep(4000);

  const title = await cdp.eval("document.title");
  check('标题为「足球计算器」', title === '足球计算器', '[' + title + ']');
  check('副标题已移除', (await cdp.eval("!!document.querySelector('header .sub')")) === false);

  const selVal = await cdp.eval("document.getElementById('leagueSel').value");
  check('默认联赛留空', selVal === '', '[' + selVal + ']');
  check('未选联赛时轮次禁用',
    (await cdp.eval("document.getElementById('roundSel').disabled")) === true);

  // 关键 bug：选联赛后立即可选轮次
  await cdp.eval(`(() => {
    const s=document.getElementById('leagueSel');
    s.value='china-l1'; s.dispatchEvent(new Event('change'));
  })()`, false);

  let ready = false;
  for (let i = 0; i < 60; i++) {
    const n = await cdp.eval("document.querySelectorAll('#roundSel option').length");
    if (n > 1) { ready = true; break; }
    await sleep(250);
  }
  check('选联赛后轮次自动可用（无需先计算）', ready);
  check('轮次下拉已启用',
    (await cdp.eval("document.getElementById('roundSel').disabled")) === false);

  await cdp.eval(`(() => {
    const r=document.getElementById('roundSel');
    r.value='20'; r.dispatchEvent(new Event('change'));
    document.getElementById('runBtn').click();
  })()`, false);
  await sleep(3000);
  const meta = await cdp.eval("document.getElementById('tableMeta').textContent");
  check('可按第20轮计算', meta.indexOf('20') >= 0, '[' + meta + ']');

  const customs = await cdp.eval(`(() => {
    const g=[...document.querySelectorAll('#leagueSel optgroup')].find(x=>x.label.indexOf('自定义')>=0);
    return g ? [...g.querySelectorAll('option')].map(o=>o.value) : [];
  })()`);
  check('线上识别自定义联赛', customs.length > 0, '[' + customs.join(',') + ']');

  if (customs.length) {
    await cdp.eval(`(() => {
      const s=document.getElementById('leagueSel');
      s.value=${JSON.stringify(customs[0])}; s.dispatchEvent(new Event('change'));
    })()`, false);
    await sleep(2000);
    await cdp.eval("document.getElementById('runBtn').click()", false);
    await sleep(2500);
    const rows = await cdp.eval("document.querySelectorAll('#probTable tbody tr').length");
    check('自定义联赛可算出概率', rows > 0, '(' + rows + ' 队)');
  }

  await cdp.eval(`(() => {
    const s=document.getElementById('leagueSel');
    s.value='epl'; s.dispatchEvent(new Event('change'));
    document.getElementById('srcSel').value='live';
    document.getElementById('srcSel').dispatchEvent(new Event('change'));
  })()`, false);
  await sleep(7000);
  await cdp.eval("document.getElementById('runBtn').click()", false);
  await sleep(4000);
  const note = await cdp.eval("document.getElementById('dataNote').textContent");
  const eplRows = await cdp.eval("document.querySelectorAll('#probTable tbody tr').length");
  check('「获取数据」可用', eplRows === 20, '(' + eplRows + ' 队)');
  check('数据来源已标注', note.indexOf('来源') >= 0, '[' + String(note).slice(0, 60) + ']');

  const seq = [await cdp.eval("document.documentElement.getAttribute('data-theme')")];
  for (let i = 0; i < 4; i++) {
    await cdp.eval("document.getElementById('themeBtn').click()", false);
    await sleep(180);
    seq.push(await cdp.eval("document.documentElement.getAttribute('data-theme')"));
  }
  check('主题循环正常',
    JSON.stringify(seq) === JSON.stringify(['auto', 'dark', 'light', 'auto', 'dark']), seq.join('→'));

  const footer = await cdp.eval("document.querySelector('footer').textContent.trim()");
  check('页脚只有 GitHub', footer.length < 40 && footer.indexOf('GitHub') >= 0, '[' + footer + ']');

  check('页面无错误',
    (await cdp.eval("document.getElementById('status').className === 'err'")) === false);

  cdp.close(); proc.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}

  console.log('\n' + (bad ? bad + ' 项失败' : '全部通过'));
  if (bad) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exit(1); });
