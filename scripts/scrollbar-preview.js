'use strict';

/**
 * Render the shipped scrollbar in a page you can actually look at.
 *
 *   node scripts/scrollbar-preview.js   ->  scratch/scrollbar-preview.html
 *
 * The page is the bundled copy of the site with the app's own stylesheet and
 * the app's own Scrollbar module injected, which is exactly what the desktop
 * window does at runtime. Open it in a browser to see the rail Shine draws,
 * or point a screenshot at it.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'scratch');

// --small swaps the bundled site for a plain tall page, which loads instantly
// and is all you need to look at the rail itself.
const small = process.argv.includes('--small');

const site = small
  ? `<!doctype html><html><head><meta charset="utf-8"><title>Shine scrollbar</title>
     <style>body{margin:0;background:#0b0b0b;color:#ddd;font:14px/1.7 system-ui,sans-serif;padding:24px}
     section{height:900px;border-bottom:1px solid #222}</style></head>
     <body>${'<section>scroll</section>'.repeat(12)}</body></html>`
  : fs.readFileSync(path.join(ROOT, 'vendor', 'shine.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'desktop', 'desktop.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'desktop', 'desktop.js'), 'utf8');

/** The `el` helper the module builds its DOM with. */
const elStart = js.indexOf('function el(tag, attrs, children) {');
const elEnd = js.indexOf('function escapeHtml(');
if (elStart < 0 || elEnd < 0) throw new Error('could not find the el() helper in desktop.js');
const elSource = js.slice(elStart, elEnd).trim();

/** The Scrollbar module itself, verbatim. */
const modStart = js.indexOf('var Scrollbar = (function () {');
const ret = js.indexOf('return { install: install, refresh: schedule };', modStart);
const modEnd = js.indexOf('})();', ret);
if (modStart < 0 || modEnd < 0) throw new Error('could not find the Scrollbar module in desktop.js');
const modSource = js.slice(modStart, modEnd + 5);

const injected = `<style id="shine-desktop-style">${css}</style>
<script>
${elSource}

${modSource}

try { Scrollbar.install(); } catch (err) { console.error('scrollbar preview failed:', err); }
</script>`;

// The site closes its body before the end of the file, so the injection goes
// in front of the first </body> it finds - the same place the preload lands.
const at = site.toLowerCase().indexOf('</body>');
if (at < 0) throw new Error('the bundled site has no </body> tag to inject before');

fs.mkdirSync(OUT, { recursive: true });
const out = path.join(OUT, 'scrollbar-preview.html');
fs.writeFileSync(out, site.slice(0, at) + injected + site.slice(at));
console.log(out);
