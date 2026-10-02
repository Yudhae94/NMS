/**
 * Worker NMS — reverse proxy ke origin NMS (Node + SQLite) lewat Cloudflare Tunnel.
 *
 * Semua request diteruskan ke ORIGIN_URL (server NMS di port 3000).
 * Fallback: bila origin tidak bisa dihubungi, file statis di bucket assets
 * (public/) dilayani agar halaman login tetap tampil.
 */

const CACHE_TTL = 60 * 60; // 1 jam untuk aset statis

export default {
  async fetch(request, env, ctx) {
    const origin = env.ORIGIN_URL;
    if (!origin) return text(500, 'ORIGIN_URL belum dikonfigurasi di Worker secret.');

    const url = new URL(request.url);
    const target = origin.replace(/\/+$/, '') + url.pathname + url.search;

    const upstream = new Request(target, request);

    let res;
    try {
      res = await fetch(upstream, { redirect: 'manual' });
    } catch {
      return staticFallback(request, env, 502, 'Origin NMS tidak dapat dihubungi (tunnel mati?).');
    }

    // hanya aset statis immutable yang di-cache; API & HTML selalu live
    if (request.method === 'GET' && /\.(css|js|jpg|jpeg|png|svg|webp|ico|woff2?)$/i.test(url.pathname)) {
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), request);
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
      const cloned = new Response(res.body, res);
      cloned.headers.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
      ctx.waitUntil(cache.put(cacheKey, cloned.clone()));
      return cloned;
    }

    return res;
  },
};

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
