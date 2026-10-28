# 生活地圖復原 — 2026-10-28

## Current service

- New origin: https://openrice-life-map.ortw.workers.dev/liff/
- Unchanged public LINE entry: https://liff.line.me/2007974193-JJfJNq2h
- LINE Console endpoint changed from `https://random-rice.netlify.app/liff/` to the new origin and read back successfully.
- Existing Cloudflare account, renamed `ortw` subdomain; this is NOT a transfer to a company-owned account.
- Same Supabase project and tables, no schema migration, no customer/prize balance edits. Normal map analytics resume in the original user_events table.
- SDK 2.31.2 retained; map snapshot from origin/main a581b9f (2026-10-28).

## Verification

- 29 tests, source syntax check, Worker dry run passed.
- Actual Workers runtime: map/deep link/static files, 404 for missing JS/API, restaurant location/recommendation APIs, parking nearby/bbox, anonymous admin rejection verified.
- Authenticated analytics reads original Supabase successfully. Actual Hen LINE login, restaurant search, offer card, parking count/navigation displayed; corresponding app_open/map_search events read back from original DB.
- Screenshot: `/tmp/openrice-life-map-restored-20261028.png`.
- Original Netlify still returns 503 usage_exceeded, so old direct Netlify links cannot redirect until Netlify resumes.
- Phone LINE webview, precise geolocation and real booking submission remain for Hen to verify; no location permission granted or booking placed during this work.

## Parking

- Shared Cloudflare KV replaces Netlify Blobs; scheduled every two minutes (720 scheduled writes/day instead of 1440, before fallback writes), live-fetch fallback retained.
- Do not claim one-minute global freshness. Preserve original five-minute stale rejection; don't silently turn missing availability into zero.
- No paid plan upgrade performed. Monitor actual usage; free quotas are not an unlimited guarantee.

## Deliberate exclusions / remaining work

- Legacy lottery API is blocked: its GET creates filesystem users and it lacks verified LINE identity / atomic prize accounting. Do not expose it as a working migrated lottery; current map UI does not rely on it.
- Admin writes remain blocked; analytics reads work with the existing admin key. No credential values are in public assets or source.
- Favorites/theme/history are browser localStorage, origin-specific. No false claim that old favorites moved.
- Daily upstream map-data-refresh continues updating GitHub, but automatic Cloudflare deployment is NOT enabled yet. Workflow is prepared and explicitly gated off. Hen must authorize a scoped Cloudflare API token for this repository (or company Git integration); add GitHub secret CLOUDFLARE_API_TOKEN and set repository variable CLOUDFLARE_AUTODEPLOY=true, then test workflow_dispatch and workflow_run. Do not save the personal Wrangler OAuth token in GitHub.
- Until that step, `npm run deploy:cloudflare` from the authorized local login updates the site; the production snapshot remains at the last verified deployment.

## Deployment / recovery

`npm ci`, `npm test`, `npm run check`, `npm run deploy:cloudflare`.
Existing backend secrets stay in Worker encrypted secrets. `scripts/sync-cloudflare-secrets.mjs --check-only` verifies the linked original Netlify site and read-only database connection without printing credentials. Never copy LINE_CHANNEL_SECRET: this map is not the CRM webhook receiver.

Revert Worker code via Cloudflare versions if necessary. Do not point LINE back to stopped Netlify as a supposed recovery. Changing MIGRATION_MODE to validation stops analytics writes; lottery/admin writes are blocked regardless.
