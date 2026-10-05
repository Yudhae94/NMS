'use strict';
/**
 * Trigger ulang workflow GitHub Actions "Deploy Cloudflare Worker" lalu pantau hasilnya.
 * Token GitHub diambil dari credential helper git (host github.com) — tidak perlu env manual.
 * Pakai:  node scripts/deploy-cloudflare.js
 */
const { execSync } = require('node:child_process');

function ghToken() {
  const out = execSync('git credential fill', {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const m = out.match(/password=(.*)/);
  if (!m) throw new Error('Credential GitHub tidak ditemukan di git credential helper');
  return m[1].trim();
}
const API = 'https://api.github.com/repos/Yudhae94/NMS';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tok = ghToken();
  const H = { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json', 'User-Agent': 'redeploy' };

  // 1) trigger workflow_dispatch
  const t = await fetch(API + '/actions/workflows/deploy-worker.yml/dispatches', {
    method: 'POST', headers: H, body: JSON.stringify({ ref: 'main' }),
  });
  if (!t.ok && t.status !== 204) throw new Error('Gagal trigger workflow: ' + t.status + ' ' + (await t.text()));
  console.log('[deploy] workflow_dispatch terkirim, menunggu run baru...');

  // 2) tunggu run muncul
  let run = null;
  for (let i = 0; i < 20 && !run; i++) {
    await sleep(3000);
    const r = await fetch(API + '/actions/workflows/deploy-worker.yml/runs?per_page=3', { headers: H });
    const j = await r.json();
    run = (j.workflow_runs || []).find((x) => x.event === 'workflow_dispatch' && x.status !== 'completed')
      || (j.workflow_runs || [])[0];
    if (run && run.status === 'completed' && run.created_at < new Date(Date.now() - 60000).toISOString()) run = null;
  }
  if (!run) throw new Error('Run baru tidak ditemukan');
  console.log('[deploy] run #' + run.run_number + ' ' + run.html_url);

  // 3) poll sampai selesai
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const r = await fetch(API + '/actions/runs/' + run.id, { headers: H });
    const j = await r.json();
    if (j.status === 'completed') {
      console.log('[deploy] selesai: ' + j.conclusion.toUpperCase() + ' (' + j.html_url + ')');
      if (j.conclusion !== 'success') {
        // ambil log step yang gagal
        const jb = await (await fetch(API + '/actions/runs/' + run.id + '/jobs', { headers: H })).json();
        for (const job of jb.jobs || []) {
          for (const s of job.steps || []) {
            if (s.conclusion === 'failure') console.log('[deploy] gagal di step: ' + s.name);
          }
        }
        console.log('[deploy] pastikan secrets CLOUDFLARE_API_TOKEN & CLOUDFLARE_ACCOUNT_ID terisi di GitHub → Settings → Secrets → Actions');
      }
      process.exit(j.conclusion === 'success' ? 0 : 1);
    }
    process.stdout.write('.');
  }
  throw new Error('Timeout menunggu run selesai');
})().catch((e) => { console.error('\n[deploy] ' + e.message); process.exit(1); });
