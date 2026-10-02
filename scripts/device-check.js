// Uji tampilan responsif via Chrome DevTools Protocol (emulasi perangkat asli).
// Dipakai hanya untuk verifikasi; bukan bagian dari aplikasi.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const ROOT = path.join(__dirname, '..');

const DEVICES = [
  { name: 'iphone-se', w: 375, h: 667, dsf: 2, mobile: true },
  { name: 'iphone-14', w: 390, h: 844, dsf: 3, mobile: true },
  { name: 'ipad-mini', w: 744, h: 1133, dsf: 2, mobile: true },
  { name: 'ipad-pro11', w: 834, h: 1194, dsf: 2, mobile: true },
];

const pages = process.argv.slice(2);
if (!pages.length) pages.push('/');

// BASE_URL bisa diarahkan ke domain Worker untuk menguji tampilan yang benar
//-benar dilayani pengguna (mis. https://nms-monitoring.<account>.workers.dev)
const BASE_URL = process.env.NMS_BASE_URL || 'http://localhost:3000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dir = path.join(ROOT, '.edge-cdp');
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch (e) { /* belum siap */ }
  }
  if (!target) throw new Error('CDP tidak terhubung');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      logs.push('CONSOLE ERROR: ' + m.params.args.map((a) => a.value || a.description).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('JS EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || ''));
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, (m) => res(m.result));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  let bad = 0;
  for (const d of DEVICES) {
    for (const p of pages) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: d.w, height: d.h, deviceScaleFactor: d.dsf,
        mobile: d.mobile, screenWidth: d.w, screenHeight: d.h,
      });
      await send('Emulation.setTouchEmulationEnabled', { enabled: d.mobile, maxTouchPoints: 5 });
      await send('Emulation.setEmitTouchEventsForMouse', { enabled: d.mobile });
      await send('Page.navigate', { url: `${BASE_URL}${p}` });
      await sleep(2600);
      const probe = `(() => {
        const vw = document.documentElement.clientWidth;
        const out = { vw, doc: document.documentElement.scrollWidth,
          body: document.body.scrollWidth, over: [], tiny: [] };
        const vh = document.documentElement.clientHeight;
        document.querySelectorAll('*').forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return;
          if (r.right > vw + 1.5 || r.left < -1.5) {
            const cs = getComputedStyle(el);
            if (cs.position === 'fixed' && cs.pointerEvents === 'none') return;
            // dekorasi latar (foto login + canvas partikel) sengaja melebar lalu di-clip
            if (el.matches('.lw-photo,.lw-veil,#lflow')) return;
            out.over.push((el.tagName + '.' + (el.className || '')).toString().slice(0, 46)
              + ' L=' + Math.round(r.left) + ' R=' + Math.round(r.right));
          }
        });
        document.querySelectorAll('button, a, input, select, summary').forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.height < 30) {
            out.tiny.push((el.tagName + ':' + (el.textContent || '').trim().slice(0, 14)) + ' h=' + Math.round(r.height));
          }
        });
        out.over = [...new Set(out.over)].slice(0, 8);
        out.tiny = [...new Set(out.tiny)].slice(0, 8);
        out.vh = vh;
        return JSON.stringify(out);
      })()`;
      const r = await send('Runtime.evaluate', { expression: probe, returnByValue: true });
      const o = JSON.parse(r.result.value);
      const hscroll = o.doc > o.vw + 1;
      const ok = !hscroll && o.over.length === 0;
      if (!ok) bad++;
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${d.name.padEnd(10)} ${String(d.w).padStart(4)}px  ${p}`);
      console.log(`     viewport=${o.vw} scrollW=${o.doc} hScroll=${hscroll}`);
      if (o.over.length) console.log('     OVERFLOW: ' + o.over.join(' | '));
      if (o.tiny.length) console.log('     kecil(<30px): ' + o.tiny.join(' | '));

      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const dir2 = path.join(ROOT, 'shots');
      fs.mkdirSync(dir2, { recursive: true });
      fs.writeFileSync(path.join(dir2, `${d.name}${p.replace(/[/?=&]/g, '_')}.png`), Buffer.from(shot.data, 'base64'));
    }
  }

  if (logs.length) console.log('\n--- JS ERRORS ---\n' + [...new Set(logs)].join('\n'));
  console.log(bad === 0 ? '\nSEMUA LAYOUT RAPIH (tanpa overflow)' : `\n${bad} layout bermasalah`);
  ws.close();
  child.kill();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
