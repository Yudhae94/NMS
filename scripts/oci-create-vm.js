'use strict';
/**
 * Membuat VM Oracle Cloud Always Free via OCI CLI.
 *
 * SKEMA SUMBER DAYA (Always Free, tidak pernah ditagih):
 *   - VM.Standard.E2.1.Micro (1/8 OCPU, 1 GB RAM) x1
 *   - VCN + subnet + internet gateway (IP publik)
 *   - Ubuntu 22.04 Canonical
 *
 * Pakai:
 *   node scripts/oci-create-vm.js --check
 *   node scripts/oci-create-vm.js --name nms-vps --ssh-key ./deploy/id_rsa.pub
 *
 * Prasyarat: python -m oci setup config (atau env OCI_CLI_*).
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const has = (n) => args.includes(n);
const say = (m) => console.log('[oci] ' + m);
const die = (m) => { console.error('[oci] ERROR: ' + m); process.exit(1); };

function oci(a) {
  return execFileSync('python', ['-m', 'oci', ...a], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 24,
  }).trim();
}
function ociJson(a) {
  try { return JSON.parse(oci(a)); } catch { return null; }
}

function cekKonfigurasi() {
  for (const d of [path.join(os.homedir(), '.oci', 'config'), path.join(os.homedir(), '.oracle', 'oci', 'config')]) {
    if (fs.existsSync(d)) return true;
  }
  return !!process.env.OCI_CLI_TENANCY;
}

if (!cekKonfigurasi()) {
  die('OCI CLI belum dikonfigurasi.\n' +
      '  Jalankan:  python -m oci setup config\n' +
      '  Data dari Oracle Console > User Settings > API Keys:\n' +
      '    - Tenancy OCID, User OCID, Fingerprint, Private key (.pem)');
}

const COMPARTMENT = process.env.OCI_CLI_TENANCY;
const REGION = flag('--region', process.env.OCI_CLI_REGION || 'ap-jakarta-1');

if (has('--check')) {
  say('region: ' + REGION);
  const shapes = ociJson(['compute', 'shape', 'list', '--compartment-id', COMPARTMENT, '--all']) || [];
  const micro = shapes.find((s) => s.shape === 'VM.Standard.E2.1.Micro');
  say('shape Always Free: ' + (micro ? 'ADA (' + micro.shape + ')' : 'TIDAK ADA'));
  const ad = ociJson(['identity', 'availability-domain', 'list', '--compartment-id', COMPARTMENT, '--all']) || [];
  say('availability domain: ' + (ad[0] ? ad[0].name : 'tidak ditemukan'));
  const imgs = ociJson(['os', 'image', 'list', '--compartment-id', COMPARTMENT, '--all',
    '--query', "data[?operatingSystem=='Canonical Ubuntu']", '--output', 'json']) || [];
  say('gambar Ubuntu LTS: ' + imgs.length + ' buah');
  process.exit(0);
}

const NAME = flag('--name', 'nms-vps');
const SSH_KEY = flag('--ssh-key', null);
const IMAGE = flag('--image', null);
const SHAPE = flag('--shape', 'VM.Standard.E2.1.Micro');

function readSshKey(p) {
  if (!p) die('--ssh-key wajib, misal: --ssh-key ./deploy/id_rsa.pub');
  if (!fs.existsSync(p)) die('public key tidak ditemukan: ' + p);
  return fs.readFileSync(p, 'utf8').trim();
}

// 1. VCN (dipakai ulang bila sudah ada)
let vcn = (ociJson(['network', 'vcn', 'list', '--compartment-id', COMPARTMENT, '--all']) || [])
  .find((v) => v.displayName === 'nms-vcn');
if (vcn) say('VCN dipakai ulang');
else {
  say('membuat VCN...');
  const r = ociJson(['network', 'vcn', 'create', '--compartment-id', COMPARTMENT,
    '--display-name', 'nms-vcn', '--cidr-block', '10.0.0.0/16', '--wait-for-state', 'AVAILABLE']);
  vcn = r && r.data;
  if (!vcn) die('gagal membuat VCN');
}

// 2. subnet
let subnet = (ociJson(['network', 'subnet', 'list', '--compartment-id', COMPARTMENT,
  '--vcn-id', vcn.id, '--all']) || []).find((s) => s.displayName === 'nms-subnet');
if (subnet) say('subnet dipakai ulang');
else {
  say('membuat internet gateway + route table + subnet...');
  const ig = ociJson(['network', 'internet-gateway', 'create', '--compartment-id', COMPARTMENT,
    '--vcn-id', vcn.id, '--display-name', 'nms-ig', '--is-enabled', 'true',
    '--wait-for-state', 'AVAILABLE']);
  const igId = ig && ig.data && ig.data.id;
  if (!igId) die('gagal membuat internet gateway');
  const rt = ociJson(['network', 'route-table', 'create', '--compartment-id', COMPARTMENT,
    '--vcn-id', vcn.id, '--display-name', 'nms-rt',
    '--route-rules', JSON.stringify([{ destination: '0.0.0.0/0', networkEntityId: igId }]),
    '--wait-for-state', 'AVAILABLE']);
  const rtId = rt && rt.data && rt.data.id;
  if (!rtId) die('gagal membuat route table');
  const s = ociJson(['network', 'subnet', 'create', '--compartment-id', COMPARTMENT,
    '--vcn-id', vcn.id, '--display-name', 'nms-subnet', '--cidr-block', '10.0.0.0/24',
    '--route-table-id', rtId, '--dns-label', 'nmssub',
    '--prohibit-public-ips-on-vnic', 'false', '--wait-for-state', 'AVAILABLE']);
  subnet = s && s.data;
  if (!subnet) die('gagal membuat subnet');
}

// 3. gambar OS
let image = IMAGE;
if (!image) {
  say('mencari Ubuntu LTS...');
  const imgs = ociJson(['os', 'image', 'list', '--compartment-id', COMPARTMENT, '--all',
    '--query', "data[?operatingSystem=='Canonical Ubuntu']", '--output', 'json']) || [];
  const pick = imgs.find((i) => /Ubuntu\s+22\.04/i.test(i.displayName || '')) || imgs[0];
  if (!pick) die('gambar Ubuntu tidak ditemukan');
  image = pick.id;
  say('  ' + pick.displayName);
}

// 4. jalankan instance
const ad = (ociJson(['identity', 'availability-domain', 'list', '--compartment-id', COMPARTMENT, '--all']) || [])[0];
if (!ad) die('availability domain tidak ditemukan');

say('menjalankan instance...');
const inst = ociJson(['compute', 'instance', 'launch', '--compartment-id', COMPARTMENT,
  '--availability-domain', ad.name, '--shape', SHAPE,
  '--source-details', JSON.stringify({ imageId: image }),
  '--display-name', NAME, '--subnet-id', subnet.id,
  '--assign-public-ip', 'true',
  '--metadata', JSON.stringify({ ssh_authorized_keys: readSshKey(SSH_KEY) }),
  '--wait-for-state', 'RUNNING']);

if (!inst || !inst.data) die('gagal membuat instance');
say('VM berhasil dibuat!');
say('  OCID : ' + inst.data.id);

const vnics = ociJson(['compute', 'instance', 'list-vnics', '--instance-id', inst.data.id]) || [];
if (vnics[0]) {
  say('  IP PUBLIK : ' + vnics[0].publicIp);
  say('');
  say('  Lanjut  ->  ssh root@' + vnics[0].publicIp);
} else {
  say('  (ambil IP dari Oracle Console)');
}