'use strict';

/**
 * Vision, and the plumbing a screenshot has to travel down.
 * Run with: node test/vision-tests.js
 *
 * Three things are checked here, in the order they broke:
 *
 *   1. The site moved its model from /api/chat to /api/shine/chat. The app
 *      matched only the old path, so the new one fell through to the
 *      OpenAI-shaped catch-all, was looked up for an API key, found none, and
 *      PC Control stopped firing for the default keyless setup.
 *   2. Screenshots were read off disk and then dropped: the agent captured
 *      them only on the native tool-calling path, and even there bolted the
 *      image onto whatever message happened to be last - which after a tool
 *      call is the tool result, and Anthropic rejects a request whose
 *      tool_result has been overwritten.
 *   3. Vision itself: capture, describe, and the fact that it is on the record.
 *
 * The provider bodies are asserted through callProvider with fetch stubbed,
 * so what is checked is the payload that would actually go on the wire.
 */

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const providers = require(path.join(ROOT, 'src', 'main', 'agent', 'providers.js'));

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
/* Reach into desktop.js                                              */
/* ------------------------------------------------------------------ */

/**
 * Pulls one function out of desktop.js as it is written there.
 *
 * desktop.js is a page script with no exports, so the only honest way to test
 * its URL matching is to lift the real function rather than a copy that can
 * drift away from it. `scope` supplies anything the function reads from the
 * page, such as `location`.
 */
function functionFromDesktop(name, scope) {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'desktop', 'desktop.js'), 'utf8');
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`${name} is not in desktop.js`);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        const names = scope ? Object.keys(scope) : [];
        const values = scope ? Object.values(scope) : [];
        return new Function(...names, `${src.slice(at, i + 1)}\nreturn ${name};`)(...values);
      }
    }
  }
  throw new Error(`${name} has no closing brace`);
}

/* ------------------------------------------------------------------ */
/* 1. The endpoint the site actually posts to                          */
/* ------------------------------------------------------------------ */

async function main() {

section('The site\'s own endpoint is recognised');

{
  const isSiteOwnChat = functionFromDesktop('isSiteOwnChat');
  const live = 'https://shineai-9mr.pages.dev/api/shine/chat/v1/chat/completions';

  check('the live path is the site\'s own model', isSiteOwnChat(live), live);
  check('a relative path is too', isSiteOwnChat('/api/shine/chat/v1/chat/completions'));
  check('the old path still works', isSiteOwnChat('https://example.test/api/chat'));
  check('a bare /api/shine/chat is enough', isSiteOwnChat('https://example.test/api/shine/chat'));
  check(
    'some other OpenAI endpoint is not mistaken for it',
    !isSiteOwnChat('https://api.openai.com/v1/chat/completions')
  );
  check('the site\'s own path is not left to the custom catch-all', !isSiteOwnChat('https://x.test/v1/chat/completions'));

  // siteChatEndpoint reads `location`, so it is built with one in scope.
  const siteChatEndpoint = functionFromDesktop('siteChatEndpoint', { location: { origin: 'file://' } });

  check('an absolute URL is passed through', siteChatEndpoint(live) === live);
  check(
    'a relative path resolves against the live origin',
    siteChatEndpoint('/api/shine/chat/v1/chat/completions') === 'https://shineai-9mr.pages.dev/api/shine/chat/v1/chat/completions'
  );
  // A file:// page has no origin, so this falls back to a hardcoded address.
  // That address was still /api/chat, which now answers 405 to a POST - the
  // offline fallback would have had no model at all.
  const fallback = siteChatEndpoint('/api/shine/chat/v1/chat/completions');
  check('the file:// fallback is the new endpoint, not the dead one', /\/api\/shine\/chat\//.test(fallback), fallback);
  check('the file:// fallback points at the deployed site', fallback.startsWith('https://shineai-9mr.pages.dev/'), fallback);
}

/* ------------------------------------------------------------------ */
/* 2. A screenshot reaches the model                                   */
/* ------------------------------------------------------------------ */

/** Captures what callProvider would put on the wire. */
async function captureBody(provider, messages, extra) {
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    await providers.callProvider(
      Object.assign({ provider, model: 'm', apiKey: 'sk-test', baseUrl: 'https://example.test/api/chat', messages, systemPrompt: 'sys' }, extra || {}),
      {}
    );
  } finally {
    global.fetch = realFetch;
  }
  return sent[0];
}

const SHOT = { mimeType: 'image/png', data: 'aGVsbG8=' };

/** History exactly as the agent leaves it after a screenshot tool call. */
function historyAfterScreenshot() {
  const messages = [{ role: 'user', text: 'what is on my screen' }];
  messages.push({ role: 'user', text: '' });
  messages[messages.length - 1].toolResults = [{ ok: true, tool: 'take_screenshot', output: { path: 'C:/shot.png' } }];
  messages.push({ role: 'user', text: 'Here is what the screen looks like right now.', images: [SHOT] });
  return messages;
}

function contentParts(message) {
  if (Array.isArray(message?.content)) return message.content;
  if (Array.isArray(message?.parts)) return message.parts;
  return null;
}

function hasImage(parts) {
  if (!parts) return false;
  return parts.some(
    (p) =>
      (p.type === 'image_url' && typeof p.image_url?.url === 'string' && p.image_url.url.startsWith('data:image/png;base64,')) ||
      (p.type === 'image' && p.source?.data === SHOT.data) ||
      (p.inlineData && p.inlineData.data === SHOT.data)
  );
}

section('A screenshot reaches the site\'s keyless model as an image');

{
  const body = await captureBody('shine', historyAfterScreenshot());
  const last = body.messages[body.messages.length - 1];
  const parts = contentParts(last);
  check('the picture is sent as an image part, not text', hasImage(parts), JSON.stringify(last).slice(0, 160));
  check('the picture carries a caption', parts && parts[0]?.type === 'text' && /screen/i.test(parts[0].text));
  check(
    'the tool result before it survives as plain text',
    body.messages.some((m) => typeof m.content === 'string' && m.content.includes('take_screenshot'))
  );
}

section('The other providers carry it too');

{
  const body = await captureBody('openai', historyAfterScreenshot());
  const last = body.messages[body.messages.length - 1];
  check('openai gets the image part', hasImage(contentParts(last)), JSON.stringify(last).slice(0, 160));
  check(
    'a plain message has content, because the API has never heard of {role, text}',
    body.messages.every((m) => m.role === 'system' || m.content !== undefined),
    JSON.stringify(body.messages[0]).slice(0, 120)
  );

  const claude = await captureBody('claude', historyAfterScreenshot());
  const claudeLast = claude.messages[claude.messages.length - 1];
  const claudeParts = contentParts(claudeLast);
  check('claude gets the image block', hasImage(claudeParts), JSON.stringify(claudeLast).slice(0, 160));
  check(
    'claude does not lose a tool result to the picture',
    !claude.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use') && !m.content.length)
  );

  // A picture riding on a message that already holds a tool_result has to
  // join it. Replacing that content is what Anthropic rejects.
  const withToolResult = [
    { role: 'user', text: 'click it' },
    { role: 'assistant', content: [{ type: 'text', text: 'clicking' }] },
  ];
  withToolResult.push({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }],
    images: [SHOT],
  });
  const merged = await captureBody('claude', withToolResult);
  const mergedLast = merged.messages[merged.messages.length - 1];
  const mergedParts = contentParts(mergedLast) || [];
  check('the tool_result is still in the message', mergedParts.some((b) => b.type === 'tool_result'), JSON.stringify(mergedParts).slice(0, 200));
  check('the picture joined it', hasImage(mergedParts));
}

/* ------------------------------------------------------------------ */
/* 3. Vision                                                           */
/* ------------------------------------------------------------------ */

/**
 * Loads src/main/vision.js with electron and the activity log stubbed.
 *
 * The module requires electron at load, which under plain node resolves to a
 * path string rather than the API, so the real one is swapped out for the
 * duration of the require and restored immediately after.
 */
function loadVision(overrides) {
  const stubs = Object.assign(
    {
      desktopCapturer: {
        getSources: async (opts) => {
          stubs.__requested = opts.thumbnailSize;
          const w = opts.thumbnailSize.width;
          const h = opts.thumbnailSize.height;
          return [
            {
              display_id: '1',
              thumbnail: {
                isEmpty: () => false,
                getSize: () => ({ width: w, height: h }),
                toJPEG: (q) => {
                  stubs.__quality = q;
                  return Buffer.from('jpegbytes');
                },
              },
            },
          ];
        },
      },
      screen: {
        getPrimaryDisplay: () => ({ id: 1, size: { width: 1920, height: 1080 }, scaleFactor: 1 }),
      },
      __requested: null,
      __quality: null,
    },
    (overrides && overrides.electron) || {}
  );

  const log = [];
  const approvals = { appendLog: (entry) => log.push(entry) };

  const original = Module._load;
  Module._load = function (request, parent) {
    if (request === 'electron') return stubs;
    if (request === './agent/approvals' && parent && /vision\.js$/.test(parent.filename || '')) return approvals;
    return original.apply(this, arguments);
  };

  const resolved = path.join(ROOT, 'src', 'main', 'vision.js');
  try {
    delete require.cache[resolved];
    return { vision: require(resolved), stubs, log };
  } finally {
    Module._load = original;
  }
}

section('Vision captures the screen');

{
  const { vision, stubs, log } = loadVision();
  const shot = await vision.capture();
  check('a JPEG comes back as base64', shot.data === Buffer.from('jpegbytes').toString('base64'));
  check('the capture asks for the display\'s own pixels', stubs.__requested && stubs.__requested.width === 1920, JSON.stringify(stubs.__requested));
  check('the capture asks for a JPEG', stubs.__quality > 0 && stubs.__quality <= 100, String(stubs.__quality));
  check('vision exposes the default endpoint', typeof vision.DEFAULT_ENDPOINT === 'string' && /\/api\/shine\/chat\//.test(vision.DEFAULT_ENDPOINT), vision.DEFAULT_ENDPOINT);

  // A 4K display would be a multi-megabyte payload for no extra legibility.
  const big = loadVision({
    electron: {
      screen: { getPrimaryDisplay: () => ({ id: 1, size: { width: 3840, height: 2160 }, scaleFactor: 1 }) },
    },
  });
  await big.vision.capture();
  check(
    'a display larger than the limit is scaled down',
    big.stubs.__requested && big.stubs.__requested.width === 2560 && big.stubs.__requested.height === 1440,
    JSON.stringify(big.stubs.__requested)
  );

  check('nothing is logged by a bare capture', log.length === 0, `${log.length} entries`);
}

section('Vision asks the model and puts itself on the record');

{
  const { vision, log } = loadVision();
  const realFetch = global.fetch;

  global.fetch = async (url, init) => {
    vision.__lastUrl = url;
    vision.__lastBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Two windows: a browser and a terminal.' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  let result;
  try {
    result = await vision.describe({ endpoint: 'https://example.test/api/shine/chat/v1/chat/completions' });
  } finally {
    global.fetch = realFetch;
  }

  check('the answer comes back as text', result && result.text === 'Two windows: a browser and a terminal.', JSON.stringify(result).slice(0, 160));
  check('the screenshot comes back with it', result && result.image.startsWith('data:image/jpeg;base64,'));
  check('the renderer\'s endpoint is used', vision.__lastUrl === 'https://example.test/api/shine/chat/v1/chat/completions', vision.__lastUrl);
  const parts = vision.__lastBody.messages[0].content;
  check('the request carries the image part', Array.isArray(parts) && parts.some((p) => p.type === 'image_url'), JSON.stringify(parts).slice(0, 120));
  check('and a caption telling the model what it is', Array.isArray(parts) && parts[0]?.type === 'text' && /screenshot/i.test(parts[0].text));

  check('a successful look is logged', log.length === 1 && log[0].decision === 'ran', JSON.stringify(log[0]));
  check('the log says what was done', log.length === 1 && log[0].tool === 'vision' && log[0].risk === 'read', JSON.stringify(log[0]));
}

section('Vision fails honestly');

{
  const { vision, log } = loadVision();
  const realFetch = global.fetch;

  global.fetch = async () => new Response('{"error":{"message":"model is busy"}}', { status: 503, headers: { 'Content-Type': 'application/json' } });
  let bad;
  try {
    bad = await vision.describe({ endpoint: 'https://example.test/api' });
  } finally {
    global.fetch = realFetch;
  }
  check('an HTTP error is reported, not thrown', bad && typeof bad.error === 'string' && /503/.test(bad.error), JSON.stringify(bad).slice(0, 160));
  check('the model\'s own message is passed through', bad && /model is busy/.test(bad.error));
  check('a failed look is logged as an error', log.length === 1 && log[0].decision === 'error', JSON.stringify(log[0]));
  check('the screenshot is still shown on failure', bad && bad.image.startsWith('data:image/jpeg;base64,'));

  // A capture failure has no image to show, and must not throw at the caller.
  const broken = loadVision({
    electron: {
      desktopCapturer: {
        getSources: async () => {
          throw new Error('access denied by the OS');
        },
      },
    },
  });
  const noShot = await broken.vision.describe({});
  check('a capture failure comes back as an error', noShot && /access denied/.test(noShot.error), JSON.stringify(noShot));
  check('and it is logged too', broken.log.length === 1 && broken.log[0].decision === 'error');
}

/* ------------------------------------------------------------------ */
/* 4. It is reachable from the window bar                              */
/* ------------------------------------------------------------------ */

section('Vision is on the window bar');

{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'desktop', 'desktop.js'), 'utf8');
  check('the bar has a Vision button', /textButton\('Vision'/.test(src));
  check('the button opens the dialog', /Vision\.open\(\)/.test(src));
  check('the dialog asks the main process to look', /D\.vision\.describe\(/.test(src));
  check('preload exposes the channel', fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8').includes('vision:describe'));
  check('main registers the channel', fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8').includes("ipcMain.handle('vision:describe'"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = (pkg.build && pkg.build.files) || [];
  check('vision is packed into the build', files.some((f) => String(f).startsWith('src')), JSON.stringify(files));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log(`failures:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}

}

main().catch((err) => {
  console.log(`\nTESTS CRASHED\n${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
