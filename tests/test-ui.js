/* 无头浏览器冒烟测试：加载 dist/index.html，检查关键 DOM 是否被渲染 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function serve(port) {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      let p = new URL(req.url, 'http://x').pathname;
      if (p === '/') p = '/index.html';
      const f = path.join(DIST, p);
      fs.readFile(f, (e, b) => {
        if (e) { res.writeHead(404); res.end('nf'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
        res.end(b);
      });
    });
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

function findBrowser() {
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
  ];
  return cands.find(c => fs.existsSync(c));
}

async function main() {
  const port = 8801;
  const server = await serve(port);
  const browser = findBrowser();
  if (!browser) { console.log('SKIP: 没找到 Edge/Chrome'); server.close(); return; }

  const dump = path.join(require('os').tmpdir(), 'soccer-dom.html');
  if (fs.existsSync(dump)) fs.unlinkSync(dump);

  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=15000',
    '--dump-dom',
    'http://127.0.0.1:' + port + '/'
  ];

  await new Promise(res => {
    execFile(browser, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (stdout) fs.writeFileSync(dump, stdout, 'utf8');
      res();
    });
  });

  server.close();

  if (!fs.existsSync(dump)) { console.log('FAIL: 没拿到 DOM'); process.exitCode = 1; return; }
  const dom = fs.readFileSync(dump, 'utf8');

  const checks = [
    ['引擎已挂载', /SoccerEngine/],
    ['积分榜有数据', /广东广州豹/],
    ['概率表已渲染', /期望名次/],
    ['冠军列存在', /冠军/],
    ['升级列存在', /升级/],
    ['名次分布已渲染', /名次分布/],
    ['模型参数已渲染', /主场系数/]
  ];
  let bad = 0;
  for (const [name, re] of checks) {
    const good = re.test(dom);
    console.log((good ? '  PASS  ' : '  FAIL  ') + name);
    if (!good) bad++;
  }

  // 错误提示是 <div id="status" class="err">；成功时 status 应被隐藏
  const errBlock = /id="status"[^>]*class="err"/.test(dom);
  console.log((errBlock ? '  FAIL  ' : '  PASS  ') + '没有错误提示块');
  if (errBlock) bad++;

  // 页面脚本源码本身含 '出错了：' 字面量，所以只检查渲染出的 status 元素内容
  const statusMatch = /<div id="status"[^>]*>([\s\S]{0,200}?)<\/div>/.exec(dom);
  const statusText = statusMatch ? statusMatch[1].replace(/<[^>]+>/g, '').trim() : '';
  const hasErr = statusText.indexOf('出错了') >= 0;
  console.log((hasErr ? '  FAIL  ' : '  PASS  ') + 'status 区无错误文本' +
    (statusText ? '（当前: ' + statusText.slice(0, 40) + '）' : '（已隐藏）'));
  if (hasErr) bad++;

  // 结果容器应该显示（没有 display:none）
  const outHidden = /id="out"[^>]*style="[^"]*display:\s*none/.test(dom);
  console.log((outHidden ? '  FAIL  ' : '  PASS  ') + '结果区已显示');
  if (outHidden) bad++;
  // 概率数值检查：应有百分比
  const pcts = (dom.match(/\d+\.\d%/g) || []).length;
  console.log((pcts > 20 ? '  PASS  ' : '  FAIL  ') + '存在概率数值 (' + pcts + ' 个)');
  if (pcts <= 20) bad++;

  fs.unlinkSync(dump);
  if (bad) process.exitCode = 1;
  console.log('\n' + (bad ? bad + ' 项失败' : '全部通过'));
}

main().catch(e => { console.error(e); process.exit(1); });
