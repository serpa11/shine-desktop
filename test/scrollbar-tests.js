'use strict';

/**
 * Shine's own scrollbar. Run with: node test/scrollbar-tests.js
 *
 * The scrollbar is drawn by the app, inside the window: the native one is
 * hidden and the rail, track and thumb are built by the Scrollbar module in
 * desktop.js. The module is evaluated here against a stub DOM so the geometry
 * - the part that decides whether the rail lands under the window bar and
 * whether the thumb travels the whole track - is checked for real.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'desktop', 'desktop.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'desktop', 'desktop.js'), 'utf8');

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

/* ------------------------------------------------------------------ */
section('Stylesheet: the native scrollbar is gone, Shine draws its own');

check('native scrollbars take no space', /::-webkit-scrollbar\s*\{[^}]*width:\s*0/.test(css), 'no width:0 rule');
check('the rail is pinned to the window', /\.shine-own-scroll\s*\{[^}]*position:\s*fixed/.test(css));
check('the rail is drawn under the window bar', /z-index:\s*2000/.test(css) && /z-index:\s*3000/.test(css));
check('the rail has a track and a thumb', /\.shine-own-scroll-track\s*\{/.test(css) && /\.shine-own-scroll-thumb\s*\{/.test(css));
check('the app keeps a scrollbar in its own panels', /\.shine-modal-body::-webkit-scrollbar-thumb/.test(css));
check('the site\'s own rail can be retired', /\.shine-own-scroll-off\s*\{[^}]*display:\s*none/.test(css));

/* ------------------------------------------------------------------ */
/* A stub DOM, just enough to run the Scrollbar module.                */

function makeElement(tag) {
  const node = {
    tagName: tag,
    className: '',
    children: [],
    style: {},
    attrs: {},
    listeners: {},
    isConnected: true,
    clientHeight: 0,
    offsetHeight: 0,
    rectTop: 0,
    setAttribute(name, value) { this.attrs[name] = value; },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); },
    dispatch(name, event) { (this.listeners[name] || []).forEach((fn) => fn(event)); },
    getBoundingClientRect() { return { top: this.rectTop, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    setPointerCapture() {},
  };
  const classes = () => node.className.split(/\s+/).filter(Boolean);
  node.classList = {
    add(name) { if (!classes().includes(name)) node.className = classes().concat(name).join(' '); },
    contains(name) { return classes().includes(name); },
  };
  return node;
}

function el(tag, attrs, children) {
  const node = makeElement(tag);
  Object.keys(attrs || {}).forEach((key) => {
    const value = attrs[key];
    if (value === null || value === undefined || value === false) return;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, String(value));
  });
  (children || []).forEach((child) => node.appendChild(child));
  return node;
}

/** The site's own window rail, which the app is expected to retire. */
function siteRail() {
  const rail = makeElement('div');
  rail.className = 'shine-own-scroll';
  rail.style.left = '1165px';
  rail.style.pointerEvents = 'none';
  return rail;
}

/**
 * Evaluate the real Scrollbar module from desktop.js against the stub DOM.
 * `scrollHeight` is the page height, `scrollY` the current offset.
 */
function boot(options) {
  const opts = Object.assign({ innerHeight: 800, innerWidth: 1180, scrollHeight: 8000, scrollY: 0, fine: true, site: true }, options);

  const windowObj = {
    innerHeight: opts.innerHeight,
    innerWidth: opts.innerWidth,
    scrollY: opts.scrollY,
    matchMedia: () => ({ matches: opts.fine }),
    addEventListener() {},
    scrollTo(_x, y) { windowObj.scrollY = y; },
    setInterval() { return 0; },
  };

  const bar = makeElement('div');
  bar.className = 'shine-titlebar';
  bar.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 38, width: 0, height: 38 });

  const body = makeElement('body');
  body.scrollHeight = opts.scrollHeight;

  const existing = opts.site ? siteRail() : null;
  if (existing) body.appendChild(existing);

  const documentObj = {
    body,
    scrollingElement: { scrollHeight: opts.scrollHeight, scrollTop: opts.scrollY },
    createElement: makeElement,
    addEventListener() {},
    querySelector(selector) {
      if (selector === '.shine-titlebar') return bar;
      if (selector === '.shine-own-scroll:not(.shine-own-scroll-main)') {
        return body.children.find((c) => c.classList.contains('shine-own-scroll') && !c.classList.contains('shine-own-scroll-main')) || null;
      }
      return null;
    },
  };

  let frame = 0;
  const sandbox = {
    window: windowObj,
    document: documentObj,
    el,
    Math,
    console,
    requestAnimationFrame(fn) { frame = fn; return 1; },
  };

  const start = js.indexOf('var Scrollbar = (function () {');
  const ret = js.indexOf('return { install: install, refresh: schedule };', start);
  const end = js.indexOf('})();', ret);
  if (start < 0 || end < 0) throw new Error('could not find the Scrollbar module in desktop.js');

  vm.createContext(sandbox);
  vm.runInContext(js.slice(start, end + 5) + '\nthis.Scrollbar = Scrollbar;', sandbox);

  const harness = {
    window: windowObj,
    document: documentObj,
    existing,
    flush() { if (frame) { const fn = frame; frame = 0; fn(); } },
  };

  sandbox.Scrollbar.install();
  harness.flush();
  harness.rail = body.children.find((c) => c.classList.contains('shine-own-scroll-main')) || null;
  return harness;
}

/* ------------------------------------------------------------------ */
section('The rail is drawn inside the window, under the bar');

{
  const h = boot();
  check('the app builds its own rail', !!h.rail, 'no .shine-own-scroll-main in the body');
  check('the site\'s rail is retired', h.existing && h.existing.classList.contains('shine-own-scroll-off'));
  check('the rail starts below the 38px window bar', Number.parseFloat(h.rail.style.top) >= 38, h.rail.style.top);
  check('the rail stops short of the bottom edge', Number.parseFloat(h.rail.style.top) + Number.parseFloat(h.rail.style.height) <= 800, `${h.rail.style.top} + ${h.rail.style.height}`);
  check('the rail is pinned to the right edge', Number.parseFloat(h.rail.style.left) <= 1180 - 8, h.rail.style.left);
  check('the rail is visible', h.rail.style.display === 'block');
}

section('The thumb covers the viewport share and travels the whole track');

{
  const h = boot();
  const railHeight = Number.parseFloat(h.rail.style.height);
  const thumbHeight = Number.parseFloat(h.rail.children[0].children[0].style.height);
  // viewport 800 of an 8000px page -> the thumb is a tenth of the track.
  check('the thumb is sized to the viewport share', Math.abs(thumbHeight - railHeight * 800 / 8000) < 0.5, `${thumbHeight} of ${railHeight}`);
  check('the thumb starts at the top', h.rail.children[0].children[0].style.transform === 'translateY(0px)', h.rail.children[0].children[0].style.transform);

  // Half way down the page, the thumb sits half way down the track.
  const mid = boot({ scrollY: 3600 });
  const midThumb = mid.rail.children[0].children[0];
  const th = Number.parseFloat(midThumb.style.height);
  const travel = Number.parseFloat(mid.rail.style.height) - th;
  check('the thumb tracks the scroll position', Math.abs(Number.parseFloat(midThumb.style.transform.replace(/[^\d.-]/g, '')) - travel / 2) < 1, midThumb.style.transform);
  check('a mid-page rail is still inside the window', Number.parseFloat(mid.rail.style.top) + Number.parseFloat(mid.rail.style.height) <= 800);
}

section('Dragging the rail scrolls the page');

{
  const h = boot();
  const rail = h.rail;
  const track = rail.children[0];
  const thumb = track.children[0];
  rail.rectTop = Number.parseFloat(rail.style.top);
  rail.clientHeight = Number.parseFloat(rail.style.height);
  thumb.offsetHeight = Number.parseFloat(thumb.style.height);

  // Grab the middle of the track (not the thumb) -> half way down the page.
  track.dispatch('pointerdown', { button: 0, pointerId: 1, clientY: rail.rectTop + rail.clientHeight / 2, stopPropagation() {}, preventDefault() {} });
  h.flush();
  check('clicking the track jumps to that point', Math.abs(h.window.scrollY - 3600) < 2, h.window.scrollY);

  // Grab the thumb and drag it to the very bottom.
  track.dispatch('pointerdown', { button: 0, pointerId: 2, clientY: rail.rectTop + thumb.offsetHeight / 2, stopPropagation() {}, preventDefault() {} });
  track.dispatch('pointermove', { pointerId: 2, clientY: rail.rectTop + rail.clientHeight, preventDefault() {} });
  h.flush();
  check('dragging to the bottom reaches the end of the page', h.window.scrollY === 7200, h.window.scrollY);

  track.dispatch('pointerup', { pointerId: 2 });
  h.flush();
  const travel = rail.clientHeight - thumb.offsetHeight;
  check('the thumb follows the drag to the end of the track', Math.abs(Number.parseFloat(thumb.style.transform.replace(/[^\d.-]/g, '')) - travel) < 1, thumb.style.transform);
}

section('Nothing to scroll, nothing to draw');

{
  const h = boot({ scrollHeight: 800 });
  check('a page that fits holds no rail', h.rail.style.display === 'none', h.rail.style.display);
}

{
  const h = boot({ fine: false });
  check('a touch pointer keeps the native scrolling', !h.rail, 'the rail was built on a coarse pointer');
}

section('The stylesheet is shipped with the injected UI');

{
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
  check('preload injects desktop.css into the page', /readAsset\('desktop\.css'\)/.test(preload));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log(`failures:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
