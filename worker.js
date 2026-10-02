/**
 * Worker NMS — reverse proxy ke origin NMS (Node + SQLite) lewat Cloudflare Tunnel.
 *
 * Semua request API diteruskan ke ORIGIN_URL (server NMS di port 3000).
 *
 * Optimalisasi (agar cepat saat diakses online):
 *  1. Aset statis (css/js/img/font) dilayani LANGSUNG dari edge Cloudflare,
 *     tidak melalui tunnel. Hemat ~300-500 ms per aset.
 *  2. API GET di-cache sangat singkat di edge, dengan kunci yang menyertakan
 *     hash token — jadi antar-pengguna tidak pernah berbagi cache.
 *  3. HTML selalu live agar update langsung tampil.
 *  4. Fallback: bila origin tidak bisa dihubungi, file statis di bucket assets
 *     (public/) tetap dilayani agar halaman login tidak blank.
 */

const ASSET_TTL_IMMUTABLE = 31536000; // 1 tahun — aset berversi ?v=
const ASSET_TTL_PLAIN = 3600; // 1 jam — aset tanpa versi
const HTML_TTL = 0; // HTML selalu cek origin agar update langsung tampil
const API_TTL = 4; // detik — memangkas request kembar, tetap terbasa realtime

const STATIC_RE = /\.(css|js|mjs|jpg|jpeg|png|svg|webp|avif|gif|ico|woff2?|ttf|map)$/i;

export default {
  async fetch(request, env, ctx) {
    const origin = env.ORIGIN_URL;
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith('/api/');

    // ---- 1. Aset statis: dari edge, bukan lewat tunnel ----
    if (request.method === 'GET' && !isApi && STATIC_RE.test(url.pathname)) {
      const res = await serveAsset(env, request, url);
      if (res) return res;
      return staticFallback(request, env, 502, 'Aset tidak ditemukan di edge.');
    }

    if (!origin) return text(500, 'ORIGIN_URL belum dikonfigurasi di Worker secret.');

    const target = origin.replace(/\/+$/, '') + url.pathname + url.search;

    // ---- 2. API GET: micro-cache edge dengan kunci per-token ----
    if (request.method === 'GET' && isApi) {
      const key = await apiCacheKey(url, request);
      const cache = caches.default;
      const hit = await cache.match(key);
      if (hit) {
        const fresh = new Response(hit.body, hit);
        fresh.headers.set('X-NMS-Cache', 'HIT');
        return fresh;
      }
      let res;
      try {
        res = await fetch(new Request(target, request), { redirect: 'manual' });
      } catch {
        return staticFallback(request, env, 502, 'Origin NMS tidak dapat dihubungi (tunnel mati?).');
      }
      // hanya 200 + JSON yang di-cache; 401/403/5xx diteruskan apa adanya
      const ct = res.headers.get('Content-Type') || '';
      if (res.status === 200 && ct.includes('json')) {
        const cached = new Response(res.body, res);
        cached.headers.set('Cache-Control', `public, max-age=${API_TTL}`);
        cached.headers.set('X-NMS-Cache', 'MISS');
        ctx.waitUntil(cache.put(key, cached.clone()));
        return cached;
      }
      return res;
    }

    // ---- 3. HTML & sisanya: selalu live ----
    let res;
    try {
      res = await fetch(new Request(target, request), { redirect: 'manual' });
    } catch {
      return staticFallback(request, env, 502, 'Origin NMS tidak dapat dihubungi (tunnel mati?).');
    }

    if (request.method === 'GET' && !isApi && /\.html?$/i.test(url.pathname)) {
      const out = new Response(res.body, res);
      out.headers.set('Cache-Control', `public, max-age=${HTML_TTL}, must-revalidate`);
      return out;
    }
    return res;
  },
};

/** Layani aset dari binding ASSETS dengan header cache yang tepat. */
async function serveAsset(env, request, url) {
  if (!env.ASSETS) return null;
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(url.pathname, url), request));
    if (!res || res.status >= 400) return null;
    const versioned = url.searchParams.has('v');
    const headers = new Headers(res.headers);
    headers.set(
      'Cache-Control',
      versioned
        ? `public, max-age=${ASSET_TTL_IMMUTABLE}, immutable`
        : `public, max-age=${ASSET_TTL_PLAIN}`
    );
    headers.set('X-NMS-Served', 'edge');
    return new Response(res.body, { status: res.status, headers });
  } catch {
    return null;
  }
}

/**
 * Kunci cache API = URL + hash SHA-256 dari header Authorization.
 * Hash memastikan dua pengguna berbeda tidak pernah berbagi entri cache,
 * dan token asli tidak pernah tersimpan di cache.
 */
async function apiCacheKey(url, request) {
  const auth = request.headers.get('Authorization') || '';
  let tag = 'anon';
  if (auth) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(auth));
    tag = Array.from(new Uint8Array(buf).slice(0, 12))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return new Request(`https://nms.cache/api/${tag}${url.pathname}${url.search}`, {
    method: 'GET',
  });
}

function text(code, msg) {
  return new Response(msg, {
    status: code,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

async function staticFallback(request, env, code, note) {
  const path = new URL(request.url).pathname;
  let asset = path === '/' ? '/index.html' : path;
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(asset, request.url), request));
    if (res && res.status < 400) {
      const headers = new Headers(res.headers);
      headers.set('X-NMS-Origin', 'fallback-static');
      headers.set('X-NMS-Note', note);
      return new Response(res.body, { status: res.status, headers });
    }
  } catch { /* abaikan, lanjut pesan teks */ }
  return text(code, `${code} — ${note}`);
}
