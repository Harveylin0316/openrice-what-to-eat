import { cpSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Build from canonical sources, not ignored Netlify outputs. No source mutations,
// network regeneration or secrets in assets. Reuse committed, dated data snapshots.
const out = 'dist-cloudflare';
mkdirSync(out, { recursive: true });
for (const [src, dest] of [['frontend/web', ''], ['frontend/liff', 'liff'], ['frontend/shared', 'shared'], ['frontend/shared', 'liff/shared'], ['frontend/admin', 'admin']]) {
  if (!existsSync(src)) continue;
  cpSync(src, path.join(out, dest), { recursive: true, filter: p => !p.includes('/shared/shared') && !(src === 'frontend/web' && /^frontend\/web\/(liff|admin|shared)(\/|$)/.test(p)) });
}
function manifest(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const rel = path.join(prefix, e.name), file = path.join(dir, e.name);
    return e.isDirectory() ? manifest(file, rel) : [{ path: '/' + rel, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }];
  });
}
const version = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
writeFileSync(path.join(out, 'migration-build.json'), JSON.stringify({ version, builtAt: new Date().toISOString(), files: manifest(out).filter(f => f.path !== '/migration-build.json') }, null, 2));
console.log('Cloudflare assets built from canonical sources; original LIFF ID and SDK retained.');
