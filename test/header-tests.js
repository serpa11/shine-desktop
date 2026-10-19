'use strict';

/**
 * Header handling for replayed provider requests.
 *
 * A provider request is rebuilt in the main process, and the API key travels
 * in the headers. The site builds those headers as a plain object literal:
 *
 *     const headers = { 'Content-Type': 'application/json' };
 *     headers['Authorization'] = 'Bearer ' + key;
 *
 * A plain object has no forEach, so anything that only copies headers when
 * forEach exists drops the Authorization header and every request goes out
 * unauthenticated. The mock provider now enforces auth, so this is covered
 * end to end by the driver runs; these checks pin the specific shapes.
 *
 * Run with: node test/header-tests.js
 */

const fs = require('node:fs');
const path = require('node:path');

const desktopSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'desktop', 'desktop.js'), 'utf8');
const mockSrc = fs.readFileSync(path.join(__dirname, 'mock-provider.js'), 'utf8');

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

/* Extract collectHeaders so it can be exercised for real. */
function collectHeadersFrom(src) {
  const start = src.indexOf('function collectHeaders(');
  if (start === -1) throw new Error('collectHeaders is missing from desktop.js');
  let depth = 0;
  let end = start;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(start, end)}; return collectHeaders;`)();
}

console.log('\nHeaders survive the trip to the main process');
let collectHeaders;
try {
  collectHeaders = collectHeadersFrom(desktopSrc);
} catch (err) {
  check('collectHeaders exists', false, err.message);
}

if (collectHeaders) {
  check('collectHeaders exists', true);

  // This is the exact shape the site produces, and the one that used to fail.
  const siteHeaders = { 'Content-Type': 'application/json' };
  siteHeaders['Authorization'] = 'Bearer sk-test-123';
  const plain = collectHeaders(siteHeaders);
  check('a plain object literal keeps Authorization', plain.Authorization === 'Bearer sk-test-123', JSON.stringify(plain));
  check('a plain object literal keeps Content-Type', plain['Content-Type'] === 'application/json', JSON.stringify(plain));

  check('a Headers-like object works', collectHeaders(new Map([['Authorization', 'Bearer m']])).Authorization === 'Bearer m');
  const pairs = collectHeaders([['x-api-key', 'abc']]);
  check('an array of pairs works', pairs['x-api-key'] === 'abc', JSON.stringify(pairs));
  check('null headers are safe', JSON.stringify(collectHeaders(null)) === '{}');
  check('undefined headers are safe', JSON.stringify(collectHeaders(undefined)) === '{}');
  check('empty object is safe', JSON.stringify(collectHeaders({})) === '{}');
  check('null values are dropped, not stringified', !('x' in collectHeaders({ x: null })));
}

console.log('\nThe proxy uses it');
check('proxy no longer gates on forEach', !/typeof raw\.forEach === 'function'\)\s*\{[\s\S]{0,400}headers = \{\}/.test(desktopSrc));
check(
  'proxy calls collectHeaders',
  /collectHeaders\(\s*\(rawInit && rawInit\.headers\)/.test(desktopSrc),
  'the proxy must read headers from init and from the Request itself'
);
check(
  'proxy also reads headers off the Request',
  /\(input && input\.headers\)/.test(desktopSrc),
  'when init.headers is absent the headers live on the Request'
);

console.log('\nThe mock would catch a dropped key');
check('the mock enforces auth when asked', /MOCK_REQUIRE_AUTH/.test(mockSrc));
check('the mock rejects with Invalid API Key', /Invalid API Key/.test(mockSrc));
check('the mock accepts Bearer auth', /auth === `Bearer \$\{required\}`/.test(mockSrc));
check('the mock accepts x-api-key', /xkey === required/.test(mockSrc));
check('the mock accepts a key in the URL', /urlKey &&/.test(mockSrc));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log(`failures:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
