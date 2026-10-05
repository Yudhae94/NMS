'use strict';
/**
 * Alat diagnostik jaringan: ping, traceroute, route print.
 * Zero dependency — execFile + sanitasi ketat (anti command-injection).
 * Semua role boleh pakai (termasuk viewer); dibatasi count/timeout + audit.
 */
const { execFile } = require('node:child_process');
const path = require('node:path');
const { pingOnce, pingStats, detectGateway, localIfaces } = (() => {
  try { return require('./speedtest'); } catch { return {}; }
})();
const netScan = require('./net-scan');

const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const IS_WIN = process.platform === 'win32';
const PING_EXE = IS_WIN ? path.join(SYS32, 'PING.EXE') : 'ping';
const TRACERT_EXE = IS_WIN ? path.join(SYS32, 'TRACERT.EXE') : 'traceroute';
const ROUTE_EXE = IS_WIN ? path.join(SYS32, 'ROUTE.EXE') : 'ip';

function cleanHost(h) {
  h = String(h || '').trim().slice(0, 253);
  if (/^[A-Za-z0-9_.\-:]{1,253}$/.test(h) && /[A-Za-z0-9]$/.test(h)) return h;
  return null;
}
function runExe(file, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout, stderr) => {
      let out = String(stdout || '') + (stderr ? '\n' + stderr : '');
      if (out.length > 12000) out = out.slice(0, 12000) + '\n... (dipotong)';
      resolve({ ok: !err, code: err ? (err.code || 1) : 0, output: out.trim().slice(0, 12000) });
    });
  });
}
async function pingTool(target, count = 4) {
  const host = cleanHost(target);
  if (!host) return { ok: false, error: 'target tidak valid (huruf/angka/titik/strip saja)' };
  const n = Math.min(10, Math.max(1, Number(count) || 4));
  const args = IS_WIN ? ['-n', String(n), host] : ['-c', String(n), '-W', '2', host];
  const r = await runExe(PING_EXE, args, 15000 + n * 2000);
  // statistik ringkas via pingOnce juga
  let stats = null;
  try {
    const samples = [];
    for (let i = 0; i < Math.min(n, 4); i++) {
      const p = await netScan.pingOnce(host, 1500);
      if (p.alive) samples.push(p.ms);
    }
    if (samples.length) {
      samples.sort((a, b) => a - b);
      stats = { sent: n, received: samples.length, loss_pct: +(((n - samples.length) / n) * 100).toFixed(1), min: +Math.min(...samples).toFixed(1), avg: +samples[Math.floor(samples.length / 2)].toFixed(1), max: +Math.max(...samples).toFixed(1) };
    }
  } catch {}
  return { ok: r.ok || !!stats, target: host, count: n, stats, output: r.output };
}
async function traceTool(target, maxHops = 20) {
  const host = cleanHost(target);
  if (!host) return { ok: false, error: 'target tidak valid' };
  const hops = Math.min(30, Math.max(1, Number(maxHops) || 20));
  const args = IS_WIN ? ['-d', '-h', String(hops), '-w', '2000', host] : ['-n', '-m', String(hops), '-w', '2', host];
  const r = await runExe(TRACERT_EXE, args, 60000);
  return { ok: true, target: host, max_hops: hops, output: r.output || '(tidak ada output)' };
}
async function routePrint() {
  const args = IS_WIN ? ['print'] : ['route', 'show'];
  const r = await runExe(ROUTE_EXE, args, 15000);
  return { ok: true, platform: process.platform, output: r.output || '(kosong)' };
}
async function activeConn() {
  const ifaces = netScan.localIfaces ? netScan.localIfaces() : [];
  let gateway = null;
  try {
    const { detectGateway } = require('./speedtest');
    gateway = await detectGateway();
  } catch {}
  const active = ifaces.filter((i) => !String(i.ip || '').startsWith('169.254.'));
  return { interfaces: ifaces, active, gateway, subnet: netScan.localSubnet ? netScan.localSubnet() : null };
}
module.exports = { pingTool, traceTool, routePrint, activeConn, cleanHost };
