import restaurants from '../netlify/functions/restaurants.js';
import parking from '../netlify/functions/parking.js';
import admin from '../netlify/functions/admin.js';
import track from '../netlify/functions/track.js';
import { parkingStore, refreshParking } from './parking-store.mjs';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
export async function handle(request, env, ctx, cache = caches.default) {
  const url = new URL(request.url), p = url.pathname;
  if (p === '/healthz') return json({ ok: true, service: 'openrice-life-map', mode: env.MIGRATION_MODE, parkingCache: env.PARKING_CACHE ? 'shared' : 'edge-fallback' });
  // This legacy endpoint can create users even on GET and lacks verified LINE
  // identity. Do not silently migrate it into an active prize-writing service.
  if (/^\/api\/lottery(?:\/|$)/.test(p)) return json({ error: '抽獎功能尚待 LINE 身分與獎品流程驗收；目前不扣次數、不發獎。' }, 503);
  if (p.startsWith('/api/')) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) return json({ error: 'Cross-origin request rejected' }, 403);
      if (env.MIGRATION_MODE !== 'live') return json({ error: '新站驗證中，尚未寫入正式資料' }, 503);
    }
    if (p.startsWith('/api/admin') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return json({ error: '管理寫入尚未開放' }, 503);
    if (Number(request.headers.get('Content-Length') || 0) > 16384) return json({ error: 'payload too large' }, 413);
    const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.text();
    if (body?.length > 16384) return json({ error: 'payload too large' }, 413);
    const event = { httpMethod: request.method, path: p, queryStringParameters: Object.fromEntries(url.searchParams), headers: Object.fromEntries(request.headers), body };
    const handler = /^\/api\/restaurants(?:\/|$)/.test(p) ? restaurants.handler
      : /^\/api\/parking(?:\/|$)/.test(p) ? parking.handler
      : /^\/api\/admin(?:\/|$)/.test(p) ? admin.handler
      : p === '/api/track' ? track.handler : null;
    if (!handler) return json({ error: 'Not found' }, 404);
    if ((p.startsWith('/api/admin/') || p === '/api/track') && (!env.SUPABASE_URL || !env.SUPABASE_KEY)) return json({ error: '資料連線尚未設定' }, 503);
    try {
      const r = await handler(event, { parkingStore: parkingStore(env, cache) });
      const headers = new Headers(r.headers);
      if (p.startsWith('/api/admin') || p === '/api/track') headers.set('Cache-Control', 'no-store');
      return new Response(request.method === 'HEAD' || r.statusCode === 204 ? null : r.body, { status: r.statusCode, headers });
    } catch {
      return json({ error: '服務暫時無法完成，請稍後重試' }, 500);
    }
  }
  if (p.startsWith('/.netlify/')) return json({ error: 'Not found' }, 404);
  if (['/', '/index', '/index.html'].includes(p)) {
    url.pathname = '/liff/';
    return Response.redirect(url, 302);
  }
  if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
  let response = await env.ASSETS.fetch(request);
  // Only navigation paths get SPA fallback. Missing JS/JSON must stay 404.
  if (response.status === 404 && p.startsWith('/liff/') && !/\.[a-z0-9]+$/i.test(p)) {
    const index = new URL('/liff/index.html', url);
    response = await env.ASSETS.fetch(new Request(index, request));
  }
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  if (p.startsWith('/liff/')) headers.set('Cache-Control', p.startsWith('/liff/vendor/') ? 'public, max-age=31536000, immutable' : p.startsWith('/liff/data/') ? 'public, max-age=300' : 'public, max-age=0, must-revalidate');
  return new Response(response.body, { status: response.status, headers });
}
export default {
  fetch: handle,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(refreshParking(parkingStore(env, caches.default)).catch(() => console.error('Parking refresh unavailable; live fallback retained')));
  }
};
