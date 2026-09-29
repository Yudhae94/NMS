'use strict';
/**
 * CLI discovery kanal WiFi 2.4 GHz & 5 GHz (memakai lib/wifi.js).
 * Pakai: node scripts/wifi-scan.js [--json] [--no-save] [--band=2.4|5]
 *   --json     cetak JSON penuh (untuk dipakai tool lain)
 *   --no-save  jangan simpan hasil ke database (default: disimpan)
 */
const { scanWifi, analyze, saveScan } = require('../lib/wifi');

function bars(pct) {
  const n = Math.round((Number(pct) || 0) / 20);
  return '█'.repeat(n) + '░'.repeat(Math.max(0, 5 - n));
}
function chTable(band) {
  const rows = band.channels.filter((c) => c.count > 0 || (band.band === '2.4' && [1, 6, 11].includes(c.channel)));
  if (!rows.length) return `  (tidak ada AP di band ${band.label})`;
  return rows.map((c) => '  ' + String(c.channel).padStart(3) + ' | ' + String(c.freq_mhz).padStart(4) + ' MHz | ' +
    String(c.count).padStart(2) + ' AP | ' + String((c.strongest || 0) + '%').padStart(4) + ' | ' + c.status.padEnd(6) + ' | ' +
    (c.dfs ? 'DFS' : '   ').padEnd(3) + ' | interferensi ' + String(c.interference).padStart(5) + (c.recommended ? '  <- REKOMENDASI' : '')).join('\n');
}

(async () => {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const noSave = args.includes('--no-save');
  const bandFilter = (args.find((a) => a.startsWith('--band=')) || '').split('=')[1];
  const scan = await scanWifi();
  const full = { ...scan, ...analyze(scan.networks, scan.connected) };
  if (scan.ok && !noSave) saveScan(full);

  if (asJson) { console.log(JSON.stringify(full, null, 2)); return; }
  console.log(`Platform   : ${full.platform} (${full.source || '-'})`);
  console.log(`Adapter    : ${full.adapter || '-'}`);
  if (full.connected) {
    const c = full.connected;
    console.log(`Terhubung  : ${c.ssid} @ ${c.channel ? c.channel + ' (' + c.band + ' GHz)' : '-'} • ${c.radio_type || '-'} • ${c.signal ?? '-'}% (${c.rssi ?? '-'} dBm)`);
  }
  console.log(`Hasil      : ${full.counts.total} AP — 2.4 GHz ${full.counts.b24}, 5 GHz ${full.counts.b5}` + (full.reason ? ` (${full.reason})` : ''));
  for (const key of ['2.4', '5', '6']) {
    const b = full.bands[key];
    if (!b || (bandFilter && b.band !== bandFilter)) continue;
    console.log(`\n== Band ${b.label} • ${b.aps} AP • kondisi ${b.congestion}` + (b.dfs_aps ? ` • ${b.dfs_aps} AP di kanal DFS (radar)` : ''));
    if (b.recommend) console.log(`   Kanal terbaik: ${b.recommend.channel} (${b.recommend.freq_mhz} MHz) — skor ${b.recommend.score} — ${b.recommend.reason}`);
    console.log('   ch  | freq     | AP   | sig  | status | dfs | keterangan');
    console.log(chTable(b));
  }
  console.log('\nAP terdeteksi:');
  for (const n of full.networks) {
    console.log('  ' + bars(n.signal) + ` ${String(n.signal ?? '-').padStart(3)}% ` +
      `${n.band} GHz ch${String(n.channel || '-').padStart(3)} ${n.ssid} (${n.bssid}) ${n.security} ${n.radio_type || ''}${n.active ? ' [TERHUBUNG]' : ''}`);
  }
})().catch((e) => { console.error('wifi-scan gagal:', e.message); process.exit(1); });
