'use strict';

/**
 * Profile context.
 *
 * Builds a short description of the signed-in account and, when they have set
 * a profile picture, the image itself, then attaches both to whatever provider
 * request is on its way out. Because this happens on the way through the main
 * process it works for every provider - OpenAI, Claude, Gemini, Groq,
 * OpenRouter, Grok and any custom endpoint - without each one needing special
 * configuration.
 */

const accounts = require('./accounts');

/**
 * The text block every model sees.
 * Deliberately plain and explicit so a model can answer "what is my name"
 * or "what does my profile picture show" without guessing.
 */
function profileText(account, extra) {
  const lines = [
    'The person you are talking to is signed in to Shine on their own computer.',
    `  username: ${account.username}`,
    `  name: ${account.displayName || account.username}`,
  ];
  if (account.hasAvatar) {
    lines.push('  profile picture: attached to this message as an image.');
  } else {
    lines.push('  profile picture: none set.');
  }
  lines.push('Use their name when it is natural to do so. If they ask who they are, what their name is, or what their profile picture shows, answer from the details above.');
  if (extra) lines.push('', extra);
  return lines.join('\n');
}

/**
 * Collect the signed-in account plus avatar as a data URL.
 * @returns {Promise<{account:object, text:string, avatar:object|null}|null>}
 */
async function build() {
  const account = await accounts.current();
  if (!account) return null;

  const dataUrl = await accounts.avatarDataUrl(account, 160);
  let avatar = null;
  if (dataUrl) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
    if (match) avatar = { mimeType: match[1], data: match[2], dataUrl };
  }

  return { account, text: profileText(account), avatar };
}

/** Minimal text helper so the agent can reuse the same wording. */
function textForAgent(account) {
  return profileText(account, 'You also have the file, screenshot, window and process tools.');
}

function isImageBody(body) {
  const content = body?.messages?.[body.messages.length - 1]?.content;
  return Array.isArray(content);
}

/**
 * Attach the profile to a provider request body in place.
 * @param {string} provider
 * @param {object} body
 * @param {{text:string, avatar:object|null}} ctx
 */
function apply(provider, body, ctx) {
  if (!body || !ctx || !ctx.text) return false;
  if (!body || typeof body !== 'object') return false;

  if (provider === 'gemini') {
    const system = { parts: [{ text: ctx.text }] };
    body.systemInstruction = body.systemInstruction
      ? { parts: [...(body.systemInstruction.parts || []), { text: ctx.text }] }
      : system;

    if (ctx.avatar && Array.isArray(body.contents) && body.contents.length) {
      const last = body.contents[body.contents.length - 1];
      if (last.role !== 'user') return true;
      last.parts = [...(last.parts || []), { inlineData: { mimeType: ctx.avatar.mimeType, data: ctx.avatar.data } }];
    }
    return true;
  }

  if (provider === 'claude') {
    body.system = body.system ? `${body.system}\n\n${ctx.text}` : ctx.text;

    if (ctx.avatar && Array.isArray(body.messages) && body.messages.length) {
      const last = body.messages[body.messages.length - 1];
      if (last.role !== 'user') return true;
      const parts = Array.isArray(last.content) ? [...last.content] : [{ type: 'text', text: last.content || '' }];
      parts.push({ type: 'image', source: { type: 'base64', media_type: ctx.avatar.mimeType, data: ctx.avatar.data } });
      last.content = parts;
    }
    return true;
  }

  // OpenAI-compatible: OpenAI, Groq, OpenRouter, Grok, Bazaarlink, Custom.
  if (!Array.isArray(body.messages)) return false;

  const systemEntry = { role: 'system', content: ctx.text };
  const alreadyThere = body.messages.some((m) => m.role === 'system');
  if (alreadyThere) {
    const first = body.messages.find((m) => m.role === 'system');
    first.content = `${first.content || ''}\n\n${ctx.text}`;
  } else {
    body.messages.unshift(systemEntry);
  }

  if (ctx.avatar && body.messages.length) {
    let last = body.messages[body.messages.length - 1];
    if (last.role !== 'user') {
      last = { role: 'user', content: 'Please describe the profile picture attached to this message.' };
      body.messages.push(last);
    }
    if (isImageBody(body)) {
      last.content.push({ type: 'image_url', image_url: { url: ctx.avatar.dataUrl } });
    } else {
      last.content = [
        { type: 'text', text: String(last.content || 'Please describe the profile picture attached to this message.') },
        { type: 'image_url', image_url: { url: ctx.avatar.dataUrl } },
      ];
    }
  }

  return true;
}

module.exports = { build, apply, profileText, textForAgent };