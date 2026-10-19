'use strict';

/**
 * Provider adapters used by the PC Control agent loop.
 *
 * Each adapter normalises three things:
 *   - buildRequest()  -> provider-specific JSON body
 *   - parseResponse() -> { text, toolCalls[], raw }
 *   - appendToolResult(messages, toolCall, result) -> provider-specific history update
 */

const { openAiTools, anthropicTools, geminiTools, stripUnsupported, normaliseArgs } = require('./tools');

const OPENAI_COMPATIBLE = new Set(['openai', 'groq', 'openrouter', 'grok', 'bazaarlink', 'custom']);

function endpointFor(provider, baseUrl) {
  switch (provider) {
    case 'openai':
      return 'https://api.openai.com/v1/chat/completions';
    case 'groq':
      return 'https://api.groq.com/openai/v1/chat/completions';
    case 'openrouter':
      return 'https://openrouter.ai/api/v1/chat/completions';
    case 'grok':
      return 'https://api.x.ai/v1/chat/completions';
    case 'bazaarlink':
      return 'https://api.bazaarlink.ai/v1/chat/completions';
    case 'claude':
      return 'https://api.anthropic.com/v1/messages';
    case 'gemini':
      return null; // built from the model name
    case 'custom': {
      const base = String(baseUrl || '').replace(/\/+$/, '');
      if (!base) throw new Error('No base URL is configured for the custom provider.');
      return `${base}/chat/completions`;
    }
    default:
      throw new Error(`Shine PC Control does not know how to talk to the "${provider}" provider.`);
  }
}

function headersFor(provider, apiKey, authStyle, baseUrl) {
  const headers = { 'Content-Type': 'application/json' };
  switch (provider) {
    case 'claude':
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-app-access'] = 'true';
      break;
    case 'custom':
      if (authStyle === 'xapikey') headers['x-api-key'] = apiKey;
      else headers.Authorization = `Bearer ${apiKey}`;
      break;
    default:
      headers.Authorization = `Bearer ${apiKey}`;
  }
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://shineai-9mr.pages.dev/';
    headers['X-Title'] = 'Shine Desktop';
  }
  return headers;
}

/* ------------------------------------------------------------------ */
/* History normalisation                                              */
/* ------------------------------------------------------------------ */

/** -> [{ role: 'user'|'assistant', text }] */
function toPlainHistory(history) {
  return (history || [])
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: m.text.slice(0, 12000) }));
}

/* ------------------------------------------------------------------ */
/* OpenAI-compatible                                                   */
/* ------------------------------------------------------------------ */

function buildOpenAi({ model, messages, images, systemPrompt }) {
  const convo = [];
  if (systemPrompt) convo.push({ role: 'system', content: systemPrompt });
  convo.push(...messages);
  const body = { model, messages: convo, tool_choice: 'auto', tools: openAiTools(), max_tokens: 2048 };
  if (images?.length) {
    const target = convo[convo.length - 1];
    if (target && target.role === 'user') {
      target.content = [{ type: 'text', text: 'Here is what the screen looks like right now.' }];
      for (const img of images) target.content.push({ type: 'image_url', image_url: { url: img.dataUrl } });
    }
  }
  return body;
}

function parseOpenAi(data) {
  const msg = data?.choices?.[0]?.message || {};
  const toolCalls = (msg.tool_calls || []).map((tc) => ({
    id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
    name: tc.function?.name,
    args: normaliseArgs(tc.function?.name, tc.function?.arguments),
  }));
  return { text: msg.content || '', toolCalls, finish: data?.choices?.[0]?.finish_reason };
}

function appendOpenAiToolResult(messages, toolCall, result) {
  messages.push({ role: 'assistant', content: null, tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args || {}) } }] });
  messages.push({ role: 'tool', tool_call_id: toolCall.id, content: typeof result === 'string' ? result : JSON.stringify(result) });
  return messages;
}

/* ------------------------------------------------------------------ */
/* Anthropic                                                          */
/* ------------------------------------------------------------------ */

function buildAnthropic({ model, messages, images, systemPrompt }) {
  const convo = messages.map((m) => ({
    role: m.role,
    content: m.images?.length ? [{ type: 'text', text: m.text }, ...m.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.data } }))] : m.text,
  }));
  const last = convo[convo.length - 1];
  if (last?.role === 'user' && images?.length) {
    last.content = [
      { type: 'text', text: 'Here is what the screen looks like right now.' },
      ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.data } })),
    ];
  }
  const body = { model, max_tokens: 2048, messages: convo, tools: anthropicTools() };
  if (systemPrompt) body.system = systemPrompt;
  return body;
}

function parseAnthropic(data) {
  const blocks = data?.content || [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n').trim();
  const toolCalls = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, args: normaliseArgs(b.name, b.input) }));
  return { text, toolCalls, finish: data?.stop_reason };
}

function appendAnthropicToolResult(messages, toolCall, result) {
  messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: toolCall.args || {} }] });
  messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: typeof result === 'string' ? result : JSON.stringify(result) }] });
  return messages;
}

/* ------------------------------------------------------------------ */
/* Gemini                                                              */
/* ------------------------------------------------------------------ */

function buildGemini({ model, messages, images, systemPrompt }) {
  const contents = messages.map((m) => {
    const parts = [{ text: m.text }];
    if (m.images?.length) for (const i of m.images) parts.push({ inlineData: { mimeType: i.mimeType, data: i.data } });
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
  const last = contents[contents.length - 1];
  if (last?.role === 'user' && images?.length) {
    last.parts.push({ text: 'Here is what the screen looks like right now.' });
    for (const i of images) last.parts.push({ inlineData: { mimeType: i.mimeType, data: i.data } });
  }
  const body = {
    model,
    contents,
    tools: [{ functionDeclarations: geminiTools().flatMap((t) => t.functionDeclarations).map((f) => ({ ...f, parameters: stripUnsupported(f.parameters) })) }],
  };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
  return body;
}

function parseGemini(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n').trim();
  const toolCalls = parts
    .filter((p) => p.functionCall)
    .map((p) => ({
      id: p.functionCall.id || `call_${Math.random().toString(36).slice(2)}`,
      name: p.functionCall.name,
      args: normaliseArgs(p.functionCall.name, p.functionCall.args),
    }));
  return { text, toolCalls, finish: data?.candidates?.[0]?.finishReason };
}

function appendGeminiToolResult(messages, toolCall, result) {
  messages.push({ role: 'model', text: '', toolCalls: [{ name: toolCall.name, args: toolCall.args || {} }] });
  messages.push({
    role: 'user',
    text: '',
    toolResults: [{ name: toolCall.name, ok: result?.ok !== false, content: typeof result === 'string' ? result : JSON.stringify(result) }],
  });
  return messages;
}

/* ------------------------------------------------------------------ */
/* Text-only fallbacks (no tool calling)                              */
/* ------------------------------------------------------------------ */

const TEXT_PROTOCOL = `You can control this PC. Instead of calling tools, write your action on its own line using exactly this format:

<shine-tool>{"name":"run_command","args":{"command":"winget list"}}</shine-tool>

Rules:
- Write plain prose for the user, and put every tool call inside <shine-tool> tags.
- Issue ONE tool call per message and wait for the result before continuing.
- The result comes back as <shine-result>...</shine-result>. Use it to decide the next step.
- When you are finished, reply with prose only and no <shine-tool> tags.`;

function parseTextOnly(text) {
  const calls = [];
  const cleaned = String(text || '').replace(/<shine-tool>\s*([\s\S]*?)\s*<\/shine-tool>/g, (_, inner) => {
    try {
      const parsed = JSON.parse(inner);
      if (parsed && typeof parsed.name === 'string') {
        calls.push({ id: `call_${calls.length}_${Date.now().toString(36)}`, name: parsed.name, args: normaliseArgs(parsed.name, parsed.args) });
      }
    } catch {}
    return '';
  });
  return { text: cleaned.trim(), toolCalls: calls };
}

/**
 * Flatten a message history (including the synthetic tool-call / tool-result
 * turns the text protocol uses) into plain role/content pairs.
 */
function flattenForTextProtocol(messages) {
  const convo = [];
  for (const m of messages) {
    if (m.toolResults?.length) {
      convo.push({
        role: 'user',
        content: m.toolResults.map((r) => `<shine-result>${JSON.stringify(r)}</shine-result>`).join('\n'),
      });
    } else if (m.toolCalls?.length) {
      convo.push({
        role: 'assistant',
        content: m.text ? `${m.text}\n` : '',
      });
      const body = m.toolCalls.map((c) => `<shine-tool>${JSON.stringify({ name: c.name, args: c.args })}</shine-tool>`).join('\n');
      if (convo[convo.length - 1].content) convo[convo.length - 1].content += `\n${body}`;
      else convo[convo.length - 1].content = body;
    } else {
      convo.push({ role: m.role, content: m.text || '' });
    }
  }
  return convo;
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

async function callProvider(req, { signal, timeoutMs = 90000, useTools = true } = {}) {
  const { provider, model, apiKey, baseUrl, authStyle } = req;
  let url;
  let body;

  if (provider === 'gemini') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    if (!useTools) {
      const prompt = flattenForTextProtocol(req.messages)
        .map((m) => `${m.role === 'assistant' ? 'Shine' : 'User'}: ${m.content}`)
        .join('\n\n');
      body = { contents: [{ role: 'user', parts: [{ text: `${req.systemPrompt}\n\n${TEXT_PROTOCOL}\n\n${prompt}` }] }] };
    } else {
      body = buildGemini({ model, messages: req.messages, images: req.images, systemPrompt: req.systemPrompt });
    }
  } else if (provider === 'claude') {
    url = endpointFor(provider, baseUrl);
    body = useTools
      ? buildAnthropic({ model, messages: req.messages, images: req.images, systemPrompt: req.systemPrompt })
      : {
          model,
          max_tokens: 2048,
          system: `${req.systemPrompt}\n\n${TEXT_PROTOCOL}`,
          messages: flattenForTextProtocol(req.messages),
        };
  } else if (OPENAI_COMPATIBLE.has(provider)) {
    url = endpointFor(provider, baseUrl);
    if (authStyle === 'queryparam' && provider === 'custom') {
      url += `${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`;
    }
    body = useTools
      ? buildOpenAi({ model, messages: req.messages, images: req.images, systemPrompt: req.systemPrompt })
      : {
          model,
          messages: [
            { role: 'system', content: `${req.systemPrompt}\n\n${TEXT_PROTOCOL}` },
            ...flattenForTextProtocol(req.messages),
          ],
        };
  } else {
    throw new Error(`Unsupported provider "${provider}".`);
  }

  const headers = provider === 'gemini' ? { 'Content-Type': 'application/json' } : headersFor(provider, apiKey, authStyle, baseUrl);

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { rawText: text };
    }
    if (!res.ok) {
      const detail = data?.error?.message || data?.message || `HTTP ${res.status}`;
      const err = new Error(`The ${provider} request failed: ${detail}`);
      err.status = res.status;
      err.provider = provider;
      err.detail = detail;
      err.noToolsHint = /tool|function_call|tools|unsupported/i.test(String(detail));
      throw err;
    }
    if (provider === 'gemini') return parseGemini(data);
    if (provider === 'claude') return parseAnthropic(data);
    return parseOpenAi(data);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function appendToolResult(provider, messages, toolCall, result) {
  if (provider === 'gemini') return appendGeminiToolResult(messages, toolCall, result);
  if (provider === 'claude') return appendAnthropicToolResult(messages, toolCall, result);
  return appendOpenAiToolResult(messages, toolCall, result);
}

module.exports = { callProvider, appendToolResult, parseTextOnly, toPlainHistory, OPENAI_COMPATIBLE };