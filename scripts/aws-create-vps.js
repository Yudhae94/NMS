'use strict';
/**
 * Membuat VPS AWS Lightsail (Ubuntu 22.04) via AWS CLI.
 *
 * Lightsail lebih mudah dari EC2: tanpa VPC/AMI yang ribet,
 * sudah ada IP publik + firewall bawaan.
 *
 * Prasyarat:
 *   1. Akun AWS + AWS CLI (winget install Amazon.AWSCLI)
 *   2. aws configure  (Access Key + region)
 *
 * Pakai:
 *   node scripts/aws-create-vps.js --check
 *   node scripts/aws-create-vps.js --name nms-vps
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const AWS = process.env.AWS_CLI || 'C:/Program Files/Amazon/AWSCLIV2/aws.exe';
const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const has = (n) => args.includes(n);
const say = (m) => console.log('[lightsail] ' + m);
const die = (m) => { console.error('[lightsail] ERROR: ' + m); process.exit(1); };

if (!fs.existsSync(AWS)) die('AWS CLI tidak ditemukan di ' + AWS + '\n  Pasang: winget install Amazon.AWSCLI');

function aws(a, o = {}) {
  try {
    return execFileSync(AWS, a, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 24,
    }).trim();
  } catch (e) {
    if (o.allowFail) return '';
    die('aws ' + a.join(' ') + ' gagal:\n' + String(e.stderr || e.message).slice(0, 500));
  }
}
function awsJson(a) {
  const out = aws(a, { allowFail: true });
  if (!out) return null;
  try { return JSON.parse(out); } catch { return null; }
}

const who = awsJson(['sts', 'get-caller-identity']);
if (!who || !who.Account) {
  die('Kredensial AWS belum dikonfigurasi.\n' +
      '  Jalankan:  aws configure\n' +
      '  (butuh Access Key dari AWS Console > IAM > Security credentials)');
}
say('akun AWS: ' + who.Account);

const REGION = flag('--region', process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-southeast-1');

if (has('--check')) {
  say('region: ' + REGION);
  const inst = awsJson(['lightsail', 'get-instances', '--region', REGION]) || {};
  say('instance berjalan: ' + ((inst.instances || []).length));
  (inst.instances || []).forEach((i) =>
    say('  - ' + i.name + ' | ' + i.state.name + ' | ' + (i.publicIpAddress || '-')));
  const bnds = awsJson(['lightsail', 'get-bundles', '--region', REGION, '--output', 'json']) || {};
  say('bundle termurah: ' + ((bnds.bundles || [])[0] ? bnds.bundles[0].bundleId : 'tidak ada'));
  say('bundle di bawah $10/bln: ' +
    (bnds.bundles || []).filter((b) => parseFloat(b.price) <= 10).length + ' pilihan');
  const snaps = awsJson(['lightsail', 'get-blueprints', '--region', REGION]) || {};
  const ubuntu = (snaps.blueprints || []).find((b) => /ubuntu.*22/i.test(b.blueprintId));
  say('blueprint Ubuntu 22: ' + (ubuntu ? ubuntu.blueprintId : 'TIDAK ADA'));
// ---------- siapkan SSH key ----------
const KEY_NAME = flag('--key-name', 'nms-lightsail');
const KEY_PATH = path.join(__dirname, '..', 'deploy', 'lightsail_key.pem');

const keys = awsJson(['lightsail', 'get-key-pairs', '--region', REGION]) || [];
if (!keys.some((k) => k.name === KEY_NAME)) {
  say('membuat key pair "' + KEY_NAME + '"...');
  const r = awsJson(['lightsail', 'create-key-pair', '--key-name', KEY_NAME, '--region', REGION]);
  if (r && r.privateKey) {
    fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
    fs.writeFileSync(KEY_PATH, r.privateKey + '\n', { encoding: 'utf8', mode: 0o600 });
    say('  private key -> deploy/lightsail_key.pem (jangan di-commit)');
  } else {
    die('gagal membuat key pair');
  }
} else {
  say('key pair sudah ada: ' + KEY_NAME);
}

// ---------- parameter instance ----------
const NAME = flag('--name', 'nms-vps');
const BUNDLE = flag('--bundle', '512_0');
const ZONE = flag('--zone', REGION + 'a');
const BLUEPRINT = flag('--blueprint', 'ubuntu_22_04');
const USERDATA = flag('--userdata', null);

/** Buka hanya 80 + 443, tutup rule default "any" milik Lightsail. */
function setFirewall() {
  say('mengatur firewall: buka 22 (SSH), 80, 443 saja');
  for (const port of [80, 443]) {
    aws(['lightsail', 'put-instance-public-port', '--protocol', 'tcp',
      '--port', String(port), '--source', '0.0.0.0/0',
      '--instance-names', NAME, '--region', REGION], { allowFail: true });
  }
  for (const proto of ['tcp', 'udp']) {
    for (const port of ['65535', '0']) {
      aws(['lightsail', 'close-instance-public-port', '--protocol', proto,
        '--port', port, '--source', '0.0.0.0/0',
        '--instance-names', NAME, '--region', REGION], { allowFail: true });
    }
  }
}

(async () => {
  say('membuat instance "' + NAME + '" (' + BUNDLE + ', ' + BLUEPRINT + ') di ' + ZONE);
  const extra = USERDATA ? ['--user-data', 'file://' + path.resolve(USERDATA)] : [];
  aws(['lightsail', 'create-instances', '--instance-names', NAME,
    '--availability-zone', ZONE, '--blueprint-id', BLUEPRINT,
    '--bundle-id', BUNDLE, '--key-pair-name', KEY_NAME,
    '--region', REGION, '--wait-for-state', 'running', ...extra]);

  say('menunggu IP publik');
  let ip = null;
  for (let i = 0; i < 30 && !ip; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const d = awsJson(['lightsail', 'get-instance', '--instance-name', NAME, '--region', REGION]);
    if (d && d.publicIpAddress) ip = d.publicIpAddress;
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  if (!ip) {
    say('IP belum tersedia. Ambil dari console:');
    say('  https://console.aws.amazon.com/lightsail/home#/instances');
    process.exit(0);
  }

  setFirewall();
  say('');
  say('  VPS BERHASIL DIBUAT');
  say('  Nama   : ' + NAME);
  say('  IP     : ' + ip);
  say('  Bundle : ' + BUNDLE);
  say('');
  say('  Lanjut:');
  say('    bash deploy/deploy-vps.sh root@' + ip);
  say('    ssh -i ' + KEY_PATH + ' root@' + ip);
  say('');
  say('  INGAT: billing berjalan terus. Matikan dari console saat tidak dipakai.');
})();
  process.exit(0);
}