#!/usr/bin/env node
/*!
 * 本地服务器：静态文件 + 抓取代理
 *
 *   node bin/serve.js [--port 8787] [--root dist]
 *
 * 为什么需要它：
 *   浏览器的 fetch 受同源策略限制，无法直接请求 dongqiudi.com（无 CORS 头）。
 *   本服务把 /api/league?league=xxx 转发到抓取器，再以同源 JSON 返回。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { fetchLeague, LEAGUES } = require('../src/fetch.js');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find(a => a.startsWith('--' + name + '='));
  return eq ? eq.split('=')[1] : def;
}

const PORT = Number(arg('port', process.env.PORT || 8787));
const ROOT = path.resolve(__dirname, '..', arg('root', 'dist'));
const CACHE_TTL = Number(arg('ttl', 60000));   // 1 分钟

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const cache = new Map();   // key -> {at, body}

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function apiLeague(q, res) {
  const leagueKey = q.get('league');
  const cid = q.get('cid');
  if (!leagueKey && !cid) return send(res, 400, JSON.stringify({ error: 'need league or cid' }));

  const key = leagueKey || ('cid:' + cid);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    return send(res, 200, hit.body);
  }

  try {
    const data = await fetchLeague({
      league: leagueKey || undefined,
      cid: cid ? Number(cid) : undefined,
      season: q.get('season') || ''
    });
    const body = JSON.stringify(data);
    cache.set(key, { at: Date.now(), body });
    send(res, 200, body);
    console.log('[api] ' + key + ' ok (' + (body.length / 1024).toFixed(0) + ' KB)');
  } catch (e) {
    console.error('[api] ' + key + ' failed: ' + e.message);
    send(res, 502, JSON.stringify({ error: e.message }));
  }
}

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(ROOT, rel);
  // 防目录穿越
  if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden', 'text/plain');

  fs.readFile(file, (err, buf) => {
    if (err) {
      // 单页应用回退
      if (!path.extname(rel)) {
        return fs.readFile(path.join(ROOT, 'index.html'), (e2, b2) => {
          if (e2) return send(res, 404, 'not found', 'text/plain');
          send(res, 200, b2, MIME['.html']);
        });
      }
      return send(res, 404, 'not found: ' + rel, 'text/plain');
    }
    send(res, 200, buf, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    return res.end();
  }

  if (u.pathname === '/api/leagues') {
    return send(res, 200, JSON.stringify({
      leagues: Object.keys(LEAGUES).map(k => Object.assign({ key: k }, LEAGUES[k]))
    }));
  }
  if (u.pathname === '/api/league') return apiLeague(u.searchParams, res);

  serveStatic(u.pathname, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('soccer-probability 已启动');
  console.log('  界面   http://127.0.0.1:' + PORT + '/');
  console.log('  代理   http://127.0.0.1:' + PORT + '/api/league?league=china-l1');
  console.log('  根目录 ' + ROOT);
  console.log('  Ctrl+C 停止');
});
