/**
 * Cloudflare Pages Function (middleware) untuk NMS Monitoring.
 *
 * Pages menyajikan aset statis (public/) langsung dari edge. Middleware ini
 * meneruskan permintaan /api/* ke server NMS (ORIGIN_URL, yaitu Cloudflare
 * Tunnel menuju server/VPS), sehingga login, dashboard, topologi, speedtest,
 * dan diagnostik tetap berfungsi.
 *
 * Bila origin mati (tunnel/VPS down), halaman statis tetap sajikan sehingga
 * pengguna melihat UI, bukan layar kosong.
 *
 * Cara pasang environment variable (ORIGIN_URL):
 *   npx wrangler pages secret put ORIGIN_URL --project-name nms
 */

const API_TTL = 4;               // cache edge sangat singkat untuk API GET
const STATIC_TTL_PLAIN = 3600;   // aset tanpa ?v= di-cache 1 jam

export const onRequest = async (context) => {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const isApi = url.pathname.startsWith('/api/');

  // ---- aset statis & HTML: biarkan Pages melayani ----
  if (!isApi) {
    let res;
    try {
      res = await next();
    } catch {
      return text(500, 'Halaman tidak dapat dimuat.');
    }
    const h = new Headers(res.headers);
    // HTML selalu fresh agar update langsung tampil; aset ?v= immutable.
    if (/\.html?$/i.test(url.pathname)) {
      h.set('Cache-Control', 'no-cache, must-revalidate');
    } else if (!url.searchParams.has('v')) {
      h.set('Cache-Control', 'public, max-age=' + STATIC_TTL_PLAIN);
    }
    return new Response(res.body, { status: res.status, headers: h });
  }

  // ---- API: proxy ke origin ----
  const origin = env.ORIGIN_URL;
  if (!origin) {
    return json(503, {
      error: 'ORIGIN_URL belum dikonfigurasi',
      hint: 'npx wrangler pages secret put ORIGIN_URL --project-name nms',
    });
  }

  const target = origin.replace(/\/+$/, '') + url.pathname + url.search;
  let res;
  try {
    res = await fetch(new Request(target, request), { redirect: 'manual' });
  } catch {
    return json(502, { error: 'Tidak dapat menghubungi server NMS (tunnel/VPS mati?)', origin });
  }

  // Origin balas 5xx (mis. 530/502/503 saat tunnel mati) -> beri JSON yang jelas.
  if (res.status >= 500) {
    return json(502, { error: 'Server NMS sedang tidak tersedia (tunnel/VPS mati?)', origin });
  }

  // Cache sangat singkat di edge supaya request kembar terpotong (realtime tetap).
  const ct = res.headers.get('Content-Type') || '';
  if (request.method === 'GET' && res.status === 200 && ct.includes('json')) {
    const h = new Headers(res.headers);
    h.set('Cache-Control', 'public, max-age=' + API_TTL);
    return new Response(res.body, { status: res.status, headers: h });
  }
  return res;
};

function text(code, msg) {
  return new Response(msg, { status: code, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

function json(code, obj) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}