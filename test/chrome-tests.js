'use strict';

/**
 * The desktop chrome has to match whatever the site paints behind it.
 * Run with: node test/chrome-tests.js
 *
 * The site now carries a custom background: a fixed, blurred media layer with
 * the page's own surfaces made translucent so it shows through. The app draws
 * a window bar, dialogs and toasts on top of the same document, so any surface
 * the app paints opaquely is a strip of background the user cannot see.
 *
 * These checks hold the app to the site's own treatment of the equivalent
 * elements, and check the site itself where the contract lives. The site is
 * reachable only online, so that part is skipped rather than failed when it
 * is not - the app-side checks always run.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'desktop', 'desktop.css'), 'utf8');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/**
 * The block of CSS for one selector, matched as a whole.
 *
 * `.shine-toast` must not find `.shine-toasts`, and `.shine-modal` must not
 * find `.shine-modal-root` - both are declared earlier in the file, and a
 * prefix match silently judges the wrong rule.
 */
function rule(selector) {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`);
  const found = re.exec(css);
  if (!found) return '';
  const open = found.index + found[0].length - 1;
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

/**
 * How much of the background a `background` declaration covers.
 *
 * `transparent` is no coverage at all and reports null, which is the point:
 * these checks are about surfaces that paint over the page.
 */
function paintAlpha(block) {
  const m = block.match(/background(?:-color)?:\s*rgba?\([^)]*,\s*([\d.]+)\s*\)/);
  if (m) return Number.parseFloat(m[1]);
  if (/background(?:-color)?:\s*#[0-9a-f]{3,8}\b/i.test(block)) return 1;
  return null;
}

/* ------------------------------------------------------------------ */
section('The window bar paints nothing over the background');

{
  const bar = rule('.shine-titlebar');
  check(
    'the bar has no background of its own',
    paintAlpha(bar) === null && /background:\s*transparent/.test(bar),
    bar.trim().replace(/\s+/g, ' ').slice(0, 90)
  );
  check('the bar does not blur what is behind it', /backdrop-filter:\s*none/.test(bar));
  check('the bar keeps its hairline so the drag area reads', /border-bottom/.test(bar));
  check('bar contents carry their own contrast', /text-shadow/.test(bar));

  const light = rule('body.shine-light .shine-titlebar');
  check('light mode does not paint the bar either', !/background:/.test(light), light.trim());
  check('light mode flips the contrast safeguard', /text-shadow/.test(light));
  check('the window glyphs are shadowed too, since text-shadow skips SVG', /\.shine-titlebar svg\s*\{[^}]*drop-shadow/.test(css.replace(/\s+/g, ' ')));
}

/* ------------------------------------------------------------------ */
section('Dialogs and toasts are translucent, not plates');

{
  const modal = rule('.shine-modal');
  const modalAlpha = paintAlpha(modal);
  check('the dialog is translucent', modalAlpha !== null && modalAlpha < 1, String(modalAlpha));
  check('the dialog blurs the background behind it', /backdrop-filter:\s*blur/.test(modal));

  const lightModal = rule('body.shine-light .shine-modal');
  const lightAlpha = paintAlpha(lightModal);
  check('the light dialog is translucent too', lightAlpha !== null && lightAlpha < 1, String(lightAlpha));

  const toast = rule('.shine-toast');
  const toastAlpha = paintAlpha(toast);
  check('the toast is translucent', toastAlpha !== null && toastAlpha < 1, String(toastAlpha));
  check('the toast blurs the background behind it', /backdrop-filter:\s*blur/.test(toast));

  const lightToast = rule('body.shine-light .shine-toast');
  const lightToastAlpha = paintAlpha(lightToast);
  check('the light toast is translucent too', lightToastAlpha !== null && lightToastAlpha < 1, String(lightToastAlpha));
}

/* ------------------------------------------------------------------ */
section('No other surface paints an opaque sheet');

{
  // Everything the app paints, judged as a whole.
  //
  // Three exemptions, each deliberate: a control the user pressed is filled on
  // purpose, the dim behind a dialog is meant to darken what is under it, and
  // a native <option> has to be opaque or the OS draws it unreadably. Dialogs
  // and toasts are exempt as floating overlays - they sit over a small area
  // and carry the same values the site gives its own overlay and dropdown.
  //
  // Everything else must let the background through. 0.5 is where a surface
  // stops reading as a window and starts reading as a lid, which is what the
  // 0.88 bar was: this net exists to catch a surface like that coming back.
  const exempt = /modal|toast|select option|aria-pressed/;
  const painted = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .map((m) => ({ selector: m[1].trim(), body: m[2] }))
    .filter((r) => !exempt.test(r.selector))
    .filter((r) => {
      const alpha = paintAlpha(r.body);
      return alpha !== null && alpha >= 0.5;
    });

  check(
    'no near-opaque sheet is left over the page',
    painted.length === 0,
    painted.map((r) => `${r.selector} (${paintAlpha(r.body)})`).join(', ')
  );
}

/* ------------------------------------------------------------------ */
section('The contract with the site');

(async () => {
  let html = null;
  try {
    const res = await fetch('https://shineai-9mr.pages.dev/', { signal: AbortSignal.timeout(20000) });
    if (res.ok) html = await res.text();
  } catch {
    html = null;
  }

  if (!html) {
    console.log('  skip the live site is unreachable from here');
  } else {
    // Whitespace-insensitive: the site minifies and reformats freely.
    const flat = html.replace(/\s+/g, '').toLowerCase();

    check('the site still ships the background stylesheet', flat.includes('id="shine-user-media-background-styles"'));
    // The element itself is created by script, so the id appears in the CSS
    // and the JS rather than as static markup.
    check('the site still references its background layer', flat.includes('shineuserbackgroundlayer'));
    check(
      'the site leaves the page transparent under a custom background',
      flat.includes('body.shine-custom-bg{isolation:isolate!important;background:transparent!important;}')
    );
    check(
      "the site's own header is transparent, which is what ours matches",
      flat.includes('background:transparent!important;background-color:transparent!important;')
    );
    check(
      'the site still keys its light mode off body.shine-light',
      flat.includes('document.body.classlist.toggle(\'shine-light\'')
    );
  }

  // The bundled copy is only a fallback for when the site cannot be reached,
  // but it should not be so far behind that it looks broken next to the app.
  const bundled = fs.readFileSync(path.join(ROOT, 'vendor', 'shine.html'), 'utf8');
  const bundledFlat = bundled.replace(/\s+/g, '').toLowerCase();
  check(
    'the bundled fallback carries the background layer too',
    bundledFlat.includes('shineuserbackgroundlayer'),
    'run node scripts/refresh-vendor.js to catch the fallback up with the site'
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`failures:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
})();
