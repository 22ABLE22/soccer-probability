/*
 * 「获取最新数据」通道测试
 *   node tests/test-live-fetch.js                        # 测本地 dist
 *   node tests/test-live-fetch.js https://22able22.github.io/soccer-probability/
 *
 * 验证：在线数据通道（jsDelivr / raw）能返回合法 league JSON，
 * 且失败时页面会回退到内置快照而不是报错。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const SITE = process.argv[2] || null;
const DIST = path.resolve(__dirname, '..', 'dist');
const PORT = 8809, CDP = 9359;
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
function getJson(u) {
  return new Promise((res, rej) => {
    http.get(u, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}}); }).on('error', rej);
  });
}

async function main() {
  const server = SITE ? null : await serve();
  const url = SITE || ('http://127.0.0.1:' + PORT + '/');

  const profile = path.join(os.tmpdir(), 'livefetch-' + Date.now());
  const proc = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + CDP, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let t = null;
  for (let i = 0; i < 50; i++) {
    try { const l = await getJson('http://127.0.0.1:' + CDP + '/json/list'); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) {}
    await sleep(300);
  }

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
  console.log('测试目标: ' + url);
  await send('Page.navigate', { url });
  await sleep(3000);

  let bad = 0;
  const check = (n, c, x) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x ? '  ' + x : '')); if (!c) bad++; };

  // 1) 直接测在线通道
  const r = await ev(`(async () => {
    const t0 = performance.now();
    try {
      const L = await loadLive('china-l1', () => {});
      return { ok: true, via: L.meta && L.meta.via, teams: L.teams.length,
               matches: L.matches.length, played: L.matches.filter(m=>m.played).length,
               maxRound: L.meta && L.meta.maxRound, ms: Math.round(performance.now()-t0) };
    } catch (e) {
      return { ok: false, err: String(e && e.message ? e.message : e).slice(0, 500) };
    }
  })()`);

  if (r.ok) {
    check('在线通道可用', true, '(' + r.ms + 'ms, 通道: ' + r.via + ')');
    check('返回 16 队', r.teams === 16, '(' + r.teams + ')');
    check('返回 240 场', r.matches === 240, '(' + r.matches + ')');
    check('轮次正确', r.maxRound === 30, '(轮' + r.maxRound + ')');
  } else {
    console.log('  WARN  在线通道不可达（可能被网络限制），将验证回退行为');
    console.log('        ' + r.err.split('\n')[0]);
  }

  // 2) UI 层：选「获取最新数据」必须能出结果（在线失败则回退）
  await ev(`(() => {
    const s=document.getElementById('leagueSel');
    s.value='china-l1'; s.dispatchEvent(new Event('change'));
    document.getElementById('srcSel').value='live';
    document.getElementById('srcSel').dispatchEvent(new Event('change'));
    document.getElementById('runBtn').click();
  })()`, false);
  await sleep(9000);

  const rows = await ev("document.querySelectorAll('#probTable tbody tr').length");
  check('选「获取最新数据」后仍能出结果', rows === 16, '(' + rows + ')');

  const note = await ev("document.getElementById('dataNote').textContent");
  const noteVisible = await ev("getComputedStyle(document.getElementById('dataNote')).display !== 'none'");
  check('显示数据来源说明', noteVisible && note.indexOf('来源') >= 0, '[' + String(note).slice(0, 70) + ']');

  if (!r.ok) {
    const fellBack = String(note).indexOf('回退') >= 0;
    check('在线失败时明确标注已回退', fellBack, '[' + String(note).slice(0, 70) + ']');
  }

  const hasErr = await ev("document.getElementById('status').className === 'err'");
  check('页面没有报错', !hasErr);

  proc.kill();
  if (server) server.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}

  console.log('\n' + (bad ? bad + ' 项失败' : '全部通过'));
  if (bad) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exit(1); });
