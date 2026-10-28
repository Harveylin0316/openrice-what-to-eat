import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Netlify site linked in this repo only. Never print values or copy LINE secret:
// the map isn't the CRM webhook receiver and doesn't need channel credentials.
const site = JSON.parse(readFileSync('.netlify/state.json', 'utf8'));
if (site.siteId !== 'a5e4c520-e9c2-48b0-b20f-f44d7dbe522b') throw new Error('Wrong Netlify site; stopping');
const source = JSON.parse(execFileSync('netlify', ['env:list', '--context', 'production', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
// Some historical Netlify values were saved as masked strings. Derive only the
// public project hostname from the existing signed service key, then verify it.
if (source.SUPABASE_URL?.includes('***')) {
  const claims = JSON.parse(Buffer.from(source.SUPABASE_KEY.split('.')[1], 'base64url').toString());
  if (!/^[a-z]{20}$/.test(claims.ref) || claims.role !== 'service_role') throw new Error('Cannot identify original database');
  source.SUPABASE_URL = `https://${claims.ref}.supabase.co`;
}
const secrets = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_KEY', 'ADMIN_API_KEY'].map(name => {
  if (typeof source[name] !== 'string' || source[name].length < 8 || source[name].includes('***')) throw new Error(`Missing ${name}`);
  return [name, source[name]];
}));
if (new URL(secrets.SUPABASE_URL).protocol !== 'https:') throw new Error('Invalid database URL');
const check = await fetch(`${secrets.SUPABASE_URL}/rest/v1/user_events?select=id&limit=0`, {
  headers: { apikey: secrets.SUPABASE_KEY, Authorization: `Bearer ${secrets.SUPABASE_KEY}` },
  signal: AbortSignal.timeout(15000),
});
if (!check.ok) throw new Error(`Original database read verification failed (${check.status}); no data written`);
function scan(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) scan(file);
    else {
      const bytes = readFileSync(file);
      for (const key of ['SUPABASE_KEY', 'ADMIN_API_KEY']) if (bytes.includes(Buffer.from(secrets[key]))) throw new Error('Secret found in public assets; stopping');
    }
  }
}
scan('dist-cloudflare');
if (process.argv.includes('--check-only')) { console.log('Three required settings available; no backend secrets in public assets. No secrets uploaded.'); process.exit(0); }
const r = spawnSync('node_modules/.bin/wrangler', ['secret', 'bulk', '--config', 'wrangler.jsonc'], { input: JSON.stringify(secrets), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 });
if (r.status !== 0) throw new Error('Secret sync failed; provider output withheld');
console.log('Three settings securely synchronized to the map Worker only; no data migrated.');
