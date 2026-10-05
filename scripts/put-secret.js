'use strict';
/**
 * Isi GitHub Actions secret untuk repo ini (encrypt RSA sesuai kunci publik repo).
 * Pakai: node scripts/put-secret.js NAMA_SEKRET "NILAI_SECRET"
 * Contoh: node scripts/put-secret.js CLOUDFLARE_ACCOUNT_ID 46a7e66eb030b0befd1af1bb01d061bd
 *         node scripts/put-secret.js CLOUDFLARE_API_TOKEN "<token>"
 */
const { execSync } = require('node:child_process');
const crypto = require('node:crypto');

const name = process.argv[2];
const value = process.argv[3];
if (!name || !value) { console.error('Pakai: node scripts/put-secret.js NAMA "NILAI"'); process.exit(1); }

function ghToken() {
  const out = execSync('echo protocol=https& echo host=github.com& echo.& git credential fill',
    { shell: 'cmd.exe', encoding: 'utf8' });
  const m = out.match(/password=(.*)/);
  if (!m) throw new Error('Credential GitHub tidak ditemukan');
  return m[1].trim();
}
function pem(pk) {
  const b64 = String(pk.key || '').replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const der = Buffer.from(b64, 'base64');
  if (der[0] !== 0x30) throw new Error('Public key repo tidak dalam format DER/PEM yang diharapkan');
  return { key: der.toString('base64').match(/.{1,64}/g).join('\n').replace(/^/, '-----BEGIN PUBLIC KEY-----\n').concat('\n-----END PUBLIC KEY-----\n') };
}
(async () => {
  const H = { Authorization: 'Bearer ' + ghToken(), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' };
  const API = 'https://api.github.com/repos/Yudhae94/NMS';
  const pk = await (await fetch(API + '/actions/secrets/public-key', { headers: H })).json();
  if (!pk || !pk.key) throw new Error('Gagal ambil public key repo');
  const normalized = /-----BEGIN/.test(pk.key) ? pk.key : pem(pk.key).key;
  const key = crypto.createPublicKey(normalized);
  const enc = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from(String(value))).toString('base64');
  const r = await fetch(API + '/actions/secrets/' + encodeURIComponent(name), {
    method: 'PUT', headers: H, body: JSON.stringify({ encrypted_value: enc, key_id: pk.key_id }),
  });
  const txt = await r.text();
  console.log(name, '-> status', r.status, r.ok ? 'OK' : txt.slice(0, 200));
  process.exit(r.ok ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });