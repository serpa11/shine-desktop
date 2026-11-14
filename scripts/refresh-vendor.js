'use strict';

/**
 * Refresh the bundled offline fallback from the live site.
 *
 *   node scripts/refresh-vendor.js
 *
 * The app prefers https://shineai-9mr.pages.dev/ and only falls back to
 * vendor/shine.html when it cannot be reached, so that copy drifts out of
 * date the moment the site changes - which is how the background update
 * reached the site and not the fallback.
 *
 * It refuses to write a snapshot that would not load on its own: the page
 * has to have a body, and it may not depend on files a saved copy would not
 * carry. Remote CDN scripts are fine, because the current copy has them too.
 */

const fs = require('node:fs');
const path = require('node:path');

const LIVE = 'https://shineai-9mr.pages.dev/';
const OUT = path.join(__dirname, '..', 'vendor', 'shine.html');

function externalHosts(html) {
  const hosts = new Set();
  const re = /(?:src|href)\s*=\s*["'](https?:\/\/[^/"']+)/gi;
  let m;
  while ((m = re.exec(html))) hosts.add(m[1]);
  return [...hosts].sort();
}

function relativeRefs(html) {
  const out = new Set();
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html))) {
    const u = m[1].trim();
    if (/^(https?:)?\/\//i.test(u)) continue;
    if (/^(data|blob|mailto|javascript|about):/i.test(u)) continue;
    if (u.startsWith('#') || u.includes('${')) continue;
    out.add(u);
  }
  return [...out];
}

(async () => {
  const before = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const res = await fetch(LIVE, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`the live site returned ${res.status}`);
  const html = await res.text();

  if (!/<\/body>/i.test(html)) throw new Error('the live page has no body to render');

  const missing = relativeRefs(html);
  if (missing.length) {
    throw new Error(`the live page needs files a saved copy would not carry: ${missing.join(', ')}`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html);

  const was = externalHosts(before);
  const now = externalHosts(html);
  const added = now.filter((h) => !was.includes(h));

  console.log(`vendor/shine.html  ${before.length} -> ${html.length} bytes`);
  console.log(`remote scripts:     ${now.length} host(s)${added.length ? `, new: ${added.join(', ')}` : ', unchanged'}`);
  console.log(`background layer:   ${/shineUserBackgroundLayer/i.test(html) ? 'present' : 'MISSING'}`);
})();
