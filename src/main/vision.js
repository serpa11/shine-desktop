'use strict';

/**
 * Vision: point the model at the screen and let it describe what it sees.
 *
 * The capture happens here rather than in the page, because the page cannot
 * see past its own window, and because the alternative - a screen-share picker
 * every time - would be a worse version of pressing a button.
 *
 * It needs no API key. The site's own model sits behind a Cloudflare Pages
 * Function that takes an OpenAI-shaped image part, so the same keyless
 * endpoint PC Control uses answers this too. That is the only way a feature
 * like this fits an app whose whole premise is running your own models.
 */

const { desktopCapturer, screen } = require('electron');

const approvals = require('./agent/approvals');

const DEFAULT_ENDPOINT = 'https://shineai-9mr.pages.dev/api/shine/chat/v1/chat/completions';
const TIMEOUT_MS = 90000;

// Longest side kept when scaling. A full-resolution capture of a large monitor
// is a multi-megabyte payload the endpoint may refuse, and text past this size
// is not reliably readable anyway - so this is where the trade stops.
const MAX_EDGE = 2560;
const JPEG_QUALITY = 72;

const DEFAULT_PROMPT =
  'This is a screenshot of the user\'s Windows desktop. Describe what is actually visible: ' +
  'which applications and windows are open, what is on screen, and anything notable. ' +
  'Be concrete and do not invent details you cannot see. If a window is behind another, ' +
  'say what you can read of it.';

/** Native-resolution JPEG of the primary display, as base64. */
async function capture() {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  let width = Math.round(display.size.width * scale);
  let height = Math.round(display.size.height * scale);

  const longest = Math.max(width, height);
  if (longest > MAX_EDGE) {
    const factor = MAX_EDGE / longest;
    width = Math.round(width * factor);
    height = Math.round(height * factor);
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
  });

  // getSources returns one entry per display; display_id is what ties a source
  // back to the primary one, and it is empty on some platforms, so fall back
  // to the first rather than failing.
  const source =
    sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
    throw new Error('Shine could not capture your screen.');
  }

  const image = source.thumbnail;
  const size = image.getSize();
  return {
    data: image.toJPEG(JPEG_QUALITY).toString('base64'),
    width: size.width,
    height: size.height,
  };
}

/**
 * Captures the screen and asks the model what is on it.
 *
 * Resolves with `{ image, text }` or `{ error }` - never throws, because the
 * caller is a dialog that has to show something either way.
 */
async function run(payload) {
  const { endpoint, prompt } = payload || {};
  let shot;
  try {
    shot = await capture();
  } catch (err) {
    return { error: err?.message || String(err) };
  }

  const image = `data:image/jpeg;base64,${shot.data}`;
  const url = String(endpoint || '').trim() || DEFAULT_ENDPOINT;

  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: String(prompt || DEFAULT_PROMPT).slice(0, 4000) },
          { type: 'image_url', image_url: { url: image } },
        ],
      },
    ],
    max_tokens: 1200,
    temperature: 0.3,
    stream: false,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const raw = await res.text();
    if (!res.ok) {
      let detail = '';
      try {
        detail = JSON.parse(raw)?.error?.message || JSON.parse(raw)?.message || '';
      } catch {
        detail = raw.slice(0, 200);
      }
      return {
        image,
        error: `The model replied with HTTP ${res.status}${detail ? `: ${detail}` : ''}.`,
      };
    }

    let reply = raw;
    try {
      reply = JSON.parse(raw)?.choices?.[0]?.message?.content ?? raw;
    } catch {
      /* the endpoint answered with something that is not chat JSON */
    }
    reply = String(reply || '').trim();
    if (!reply) {
      return { image, error: 'The model looked at the screen but said nothing back.' };
    }
    return { image, text: reply };
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { image, error: 'The model did not answer in time. It may be busy or unreachable.' };
    }
    return { image, error: `Shine could not reach the model: ${err?.message || err}` };
  }
}

/**
 * The entry point, which only exists to put the look on the record.
 *
 * Reading someone's screen is the sort of thing an activity log is for, and
 * this happens outside PC Control entirely - so without this it would be the
 * one thing Shine did that never showed up.
 */
async function describe(payload) {
  const result = await run(payload);
  const failed = Boolean(result.error);
  try {
    approvals.appendLog({
      at: new Date().toISOString(),
      tool: 'vision',
      risk: 'read',
      summary: 'Looked at the screen and asked the model what is on it',
      decision: failed ? 'error' : 'ran',
      detail: failed ? String(result.error).slice(0, 300) : null,
    });
  } catch {
    /* a log failure must not take the answer with it */
  }
  return result;
}

module.exports = { capture, describe, DEFAULT_ENDPOINT };
