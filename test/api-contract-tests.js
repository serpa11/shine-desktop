'use strict';

/**
 * Contract check between the preload bridge and the injected UI.
 *
 * The bridge is hand-trimmed from time to time, and a method removed from it
 * while still being called from desktop.js throws inside start() - which
 * silently stops every later listener from registering, including approval
 * dialogs. This test fails loudly instead.
 *
 * Run with: node test/api-contract-tests.js
 */

const fs = require('node:fs');
const path = require('node:path');

const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
const desktopSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'desktop', 'desktop.js'), 'utf8');

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

/* ------------------------------------------------------------------ */
/* What the bridge exposes                                             */
/* ------------------------------------------------------------------ */

/** Names the bridge object literal defines, e.g. "window", "pc", "account". */
function exposedSections() {
  const body = preloadSrc.slice(preloadSrc.indexOf('exposeInMainWorld'));
  const sections = new Set();
  const re = /^\s{2}([a-zA-Z][\w]*):\s*\{/gm;
  let m;
  while ((m = re.exec(body))) sections.add(m[1]);
  return sections;
}

/** Methods declared inside a given section of the bridge. */
function exposedMethods(section) {
  const start = preloadSrc.search(new RegExp(`^\\s{2}${section}:\\s*\\{`, 'm'));
  if (start === -1) return new Set();
  // Walk braces to find the end of this section.
  let depth = 0;
  let end = start;
  for (let i = preloadSrc.indexOf('{', start); i < preloadSrc.length; i += 1) {
    if (preloadSrc[i] === '{') depth += 1;
    else if (preloadSrc[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const chunk = preloadSrc.slice(start, end);
  const methods = new Set();
  const re = /^\s{4}([a-zA-Z][\w]*):\s*\(/gm;
  let m;
  while ((m = re.exec(chunk))) methods.add(m[1]);
  return methods;
}

/* ------------------------------------------------------------------ */
/* What the UI uses                                                    */
/* ------------------------------------------------------------------ */

const calls = new Set();
const callRe = /\bD\.([a-zA-Z][\w]*)\.([a-zA-Z][\w]*)/g;
let match;
while ((match = callRe.exec(desktopSrc))) {
  calls.add(`${match[1]}.${match[2]}`);
}

console.log('\nThe bridge exposes what the UI calls');
const sections = exposedSections();
for (const call of [...calls].sort()) {
  const [section, method] = call.split('.');
  if (!sections.has(section)) {
    check(`D.${call} exists`, false, `no "${section}" section on window.shineDesktop`);
    continue;
  }
  const methods = exposedMethods(section);
  check(`D.${call} exists`, methods.has(method), `"${section}" exposes: ${[...methods].join(', ')}`);
}

console.log('\nStartup cannot be broken by a missing call');
const startBody = desktopSrc.slice(desktopSrc.indexOf('async function start()'));
check('registers listeners before making calls', /onApprovalRequest/.test(startBody) && startBody.indexOf('onApprovalRequest') < startBody.indexOf('quietly('));
check('wraps optional calls in quietly()', /quietly\(\(\) => Account\.load\(\)/.test(startBody));
check('quietly() logs instead of throwing', /function quietly\(fn\)[\s\S]{0,400}catch/.test(desktopSrc));

console.log('\nTop-level bridge functions');
// Methods sitting directly on the bridge (no section), e.g. D.quit().
const flat = new Set();
const flatRe = /^ {2}([a-zA-Z][\w]*):\s*\(/gm;
while ((match = flatRe.exec(preloadSrc))) flat.add(match[1]);

const flatCalls = new Set();
const flatCallRe = /\bD\.([a-zA-Z][\w]*)\s*\(/g;
while ((match = flatCallRe.exec(desktopSrc))) flatCalls.add(match[1]);

for (const fn of [...flatCalls].sort()) {
  check(`D.${fn} exists`, flat.has(fn), `bridge top level exposes: ${[...flat].join(', ')}`);
}
for (const fn of [...flat].sort()) {
  check(`D.${fn} is called`, flatCalls.has(fn), 'exposed but never used');
}

console.log('\nNothing adds text to what the user types');
check('no preamble is prepended to the message', !/var preamble\s*=/.test(desktopSrc));
check('the ask wrapper resolves composer text', /currentComposerText\(\)/.test(desktopSrc));
check('the ask wrapper passes through when a provider is set', /ShineStore\.ai\(\)\.activeProvider\) \{\s*return original\.apply/.test(desktopSrc));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log(`failures:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}