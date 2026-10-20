/* 测试公用：自动挑选未被占用、也不在系统保留区间内的端口 */
'use strict';

const net = require('net');
const { execSync } = require('child_process');

let cachedExcluded = null;

/** 读取 Windows 的 TCP 端口保留区间（非 Windows 返回空） */
function excludedRanges() {
  if (cachedExcluded) return cachedExcluded;
  cachedExcluded = [];
  if (process.platform !== 'win32') return cachedExcluded;
  try {
    const out = execSync('netsh int ipv4 show excludedportrange protocol=tcp', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    });
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s*\*?\s*$/.exec(line);
      if (m) cachedExcluded.push([Number(m[1]), Number(m[2])]);
    }
  } catch (e) { /* 忽略，靠 bind 探测兜底 */ }
  return cachedExcluded;
}

function isExcluded(port) {
  return excludedRanges().some(([a, b]) => port >= a && port <= b);
}

function canBind(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * 找一个可用端口。
 * @param {number} start 起始端口（会向上找）
 */
async function findFreePort(start) {
  for (let p = start; p < start + 400; p++) {
    if (isExcluded(p)) continue;
    if (await canBind(p)) return p;
  }
  // 极端情况：交给系统分配
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

module.exports = { findFreePort, isExcluded, excludedRanges };
