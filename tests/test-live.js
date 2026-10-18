/* 线上验收：真实访问 GitHub Pages，切换联赛并核对结果 */
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const SITE = process.argv[2] || 'https://22able22.github.io/soccer-probability/';
const PROXY = 'http://127.0.0.1:7897';
const CDP_PORT = 9344;

function findBrowser() {
  return [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'
  ].find(c => require('fs').existsSync(c));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function getJson(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}}); }).on('error', rej);
  });
}
class CDP {
  constructor(ws){ this.ws=ws; this.id=0; this.p=new Map(); }
  static async connect(u){
    const ws=new WebSocket(u);
    await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej});
    const c=new CDP(ws);
    ws.onmessage=ev=>{const m=JSON.parse(ev.data); if(m.id&&c.p.has(m.id)){const{resolve,reject}=c.p.get(m.id);c.p.delete(m.id);m.error?reject(new Error(m.error.message)):resolve(m.result);}};
    return c;
  }
  send(method,params){ const id=++this.id; return new Promise((resolve,reject)=>{this.p.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params:params||{}}))}) }
  async eval(expr, awaitPromise){
    const r=await this.send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:awaitPromise!==false});
    if(r.exceptionDetails) throw new Error(r.exceptionDetails.text+' '+(r.exceptionDetails.exception&&JSON.stringify(r.exceptionDetails.exception)));
    return r.result.value;
  }
  close(){ this.ws.close(); }
}

async function main(){
  const browser=findBrowser();
  if(!browser){ console.log('SKIP 无浏览器'); return; }
  const profile=path.join(os.tmpdir(),'live-'+Date.now());
  const proc=spawn(browser,[
    '--headless=new','--disable-gpu','--no-sandbox',
    '--proxy-server='+PROXY,
    '--remote-debugging-port='+CDP_PORT,
    '--user-data-dir='+profile,'about:blank'
  ],{stdio:'ignore'});

  let target=null;
  for(let i=0;i<50;i++){
    try{ const l=await getJson('http://127.0.0.1:'+CDP_PORT+'/json/list'); target=l.find(t=>t.type==='page'); if(target)break; }catch(e){}
    await sleep(300);
  }
  if(!target){ console.log('FAIL 连不上 CDP'); proc.kill(); process.exitCode=1; return; }

  const cdp=await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

  let bad=0;
  const check=(n,c,x)=>{ console.log((c?'  PASS  ':'  FAIL  ')+n+(x?'  '+x:'')); if(!c)bad++; };

  await cdp.send('Page.navigate',{url:SITE});
  await sleep(4000);

  let ok=false;
  for(let i=0;i<50;i++){
    ok = await cdp.eval("document.querySelectorAll('#probTable tbody tr').length > 0");
    if(ok) break;
    await sleep(400);
  }
  check('线上页面完成首次计算', ok);

  const opts = await cdp.eval("[...document.querySelectorAll('#leagueSel option')].map(o=>o.value)");
  const expected = ['china-l1','csl','epl','laliga','seriea','bundesliga','ligue1'];
  check('联赛下拉含七大联赛', expected.every(k=>opts.includes(k)), '('+opts.join(',')+')');

  // 逐个联赛切换并核对
  const probes = [
    { key:'epl',        team:'曼城',     file:'英超' },
    { key:'laliga',     team:'皇家马德里', file:'西甲' },
    { key:'seriea',     team:'国际米兰',  file:'意甲' },
    { key:'bundesliga', team:'拜仁慕尼黑', file:'德甲' },
    { key:'ligue1',     team:'巴黎圣日耳曼', file:'法甲' },
    { key:'csl',        team:'成都蓉城',  file:'中超' },
    { key:'china-l1',   team:'广东广州豹', file:'中甲' }
  ];

  for(const p of probes){
    await cdp.eval(`(() => {
      const s=document.getElementById('leagueSel');
      s.value=${JSON.stringify(p.key)};
      s.dispatchEvent(new Event('change'));
      document.getElementById('runBtn').click();
    })()`, false);
    await sleep(2600);

    const found = await cdp.eval(`(() => {
      const rows=[...document.querySelectorAll('#probTable tbody tr')];
      const r=rows.find(x=>x.children[1].textContent.trim()===${JSON.stringify(p.team)});
      if(!r) return null;
      return { title: r.children[5].textContent.trim(), n: rows.length };
    })()`);
    check(p.file+' 可计算（队名 '+p.team+' 命中）', !!found,
      found ? '(共 '+found.n+' 队)' : '');

    const sumTitle = await cdp.eval(`(() => {
      const rows=[...document.querySelectorAll('#probTable tbody tr')];
      let s=0; for(const r of rows) s += parseFloat(r.children[5].textContent)||0;
      return Math.round(s*10)/10;
    })()`);
    check(p.file+' 冠军概率合计=100%', Math.abs(sumTitle-100)<0.8, '('+sumTitle+'%)');
  }

  cdp.close(); proc.kill();
  try{ require('fs').rmSync(profile,{recursive:true,force:true}); }catch(e){}
  console.log('\n'+(bad?bad+' 项失败':'全部通过'));
  if(bad) process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exit(1)});
