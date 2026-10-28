export const AVAIL_URL = 'https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json';
const KEY = 'https://openrice-life-map.internal/parking/avail';
export function parkingStore(env, cache) {
  return {
    async read() {
      const data = env.PARKING_CACHE
        ? await env.PARKING_CACHE.get('avail', 'json')
        : await cache.match(KEY).then(r => r ? r.json() : null);
      // Match Netlify's stale limit. Never reset age when re-caching old data.
      return data?.map && Date.now() - data.at < 300000 ? data : null;
    },
    async write(map) {
      if (!Object.keys(map).length) throw new Error('Empty parking feed');
      const data = { at: Date.now(), map, count: Object.keys(map).length };
      if (env.PARKING_CACHE) await env.PARKING_CACHE.put('avail', JSON.stringify(data), { expirationTtl: 300 });
      else await cache.put(KEY, new Response(JSON.stringify(data), { headers: { 'Cache-Control': 'public, max-age=60', 'Content-Type': 'application/json' } }));
    }
  };
}
export async function refreshParking(store, fetcher = fetch) {
  const response = await fetcher(AVAIL_URL, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('Parking source unavailable');
  const data = await response.json();
  const map = {};
  for (const p of data?.data?.park || []) map[String(p.id)] = Number(p.availablecar);
  await store.write(map);
}
