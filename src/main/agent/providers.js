'use strict';

/**
 * Provider adapters used by the PC Control agent loop.
 *
 * Each adapter normalises three things:
 *   - buildRequest()  -> provider-specific JSON body
 *   - parseResponse() -> { text, toolCalls[], raw }
 *   - appendToolResult(messages, toolCall, result) -> provider-specific history update
 */

const { openAiTools, anthropicTools, geminiTools, stripUnsupported, normaliseArgs, TOOL_MAP } = require('./tools');

const OPENAI_COMPATIBLE = new Set(['openai', 'groq', 'openrouter', 'grok', 'bazaarlink', 'custom']);

/**
 * Reply budget for the model that ships with the site.
 *
 * It reasons before it answers, and reasoning is billed against the same
 * max_tokens as the answer. At the site's own default of 1024 it regularly
 * returns finish_reason "length" with an empty message, which leaves the agent
 * loop with nothing to act on. 4096 leaves room for the reasoning and the call;
 * an empty reply is retried at double.
 */
const SHINE_MAX_TOKENS = 4096;

/** Bound for a POST made outside the agent loop's own deadline. */
const PROVIDER_FETCH_TIMEOUT_MS = 90000;

/**
 * The model that ships with the Shine site itself.
 *
 * Shine no longer uses API keys - the site runs its own model behind
 * /api/chat, so PC Control has to work with no key, no model name and no
 * provider chosen. The request is OpenAI-shaped and answers in the same
 * shape, but it never returns native tool_calls: it writes the call out as
 * text instead, which is why this provider always uses the text protocol.
 */
const SHINE = 'shine';

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
    case SHINE: {
      const base = String(baseUrl || '').trim();
      if (!base) throw new Error('Shine could not reach its own model: no /api/chat address was supplied.');
      return base;
    }
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
  // The site's own model takes no credentials at all.
  if (provider === SHINE) return headers;
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

/**
 * Tool names the site's own model makes up for tools that already exist.
 *
 * It is not trained on Shine's tool list, so it answers with whatever seems
 * natural - "execute" and "run" both turned up for run_command. Resolving the
 * name here saves a wasted step, and anything still unknown is reported back
 * to the model by the agent loop rather than guessed at.
 */
const TOOL_ALIASES = {
  execute: 'run_command',
  exec: 'run_command',
  run: 'run_command',
  run_cmd: 'run_command',
  runcommand: 'run_command',
  shell: 'run_command',
  powershell: 'run_command',
  command: 'run_command',
  run_terminal_command: 'run_command',
  open: 'launch_app',
  open_app: 'launch_app',
  open_application: 'launch_app',
  launch: 'launch_app',
  launch_application: 'launch_app',
  run_app: 'launch_app',
  list_files: 'list_directory',
  list_dir: 'list_directory',
  ls: 'list_directory',
  dir: 'list_directory',
  read: 'read_file',
  write: 'write_file',
  writefile: 'write_file',
  screenshot: 'take_screenshot',
  capture_screen: 'take_screenshot',
  move_mouse: 'move_cursor',
  mouse_move: 'move_cursor',
  type: 'type_text',
  clipboard_read: 'read_clipboard',
  get_clipboard: 'read_clipboard',
  processes: 'list_processes',
  windows: 'list_windows',
  search: 'search_files',
  find: 'search_files',
  power: 'system_power',
  volume: 'set_volume',
};

function resolveToolName(name) {
  const raw = String(name || '').trim();
  if (!raw) return raw;
  if (TOOL_MAP.has(raw)) return raw;
  const lower = raw.toLowerCase();
  if (TOOL_MAP.has(lower)) return lower;
  const alias = TOOL_ALIASES[lower];
  if (alias && TOOL_MAP.has(alias)) return alias;
  return raw;
}

function pushCall(calls, name, args) {
  const resolved = resolveToolName(name);
  if (!resolved) return;
  calls.push({
    id: `call_${calls.length}_${Date.now().toString(36)}`,
    name: resolved,
    args: normaliseArgs(resolved, args),
  });
}

/** Splits on a separator that is not inside quotes, braces or brackets. */
function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && i + 1 < text.length) {
        cur += text[i + 1];
        i += 1;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === sep && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function unquote(value) {
  const v = String(value).trim();
  const first = v[0];
  if ((first === '"' || first === "'") && v[v.length - 1] === first && v.length >= 2) {
    const inner = v.slice(1, -1);
    // Only the escapes a model actually writes. A Windows path like
    // C:\Users stays intact because \U is not one of these.
    return inner.replace(/\\(['"\\])/g, '$1');
  }
  return v;
}

function coerceArg(value) {
  const v = String(value).trim();
  const first = v[0];
  if (first === '"' || first === "'") return unquote(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

/** Parses `x=412, y=777, button='right'` into an argument object. */
function parseCallArgs(raw) {
  const out = {};
  for (const part of splitTopLevel(String(raw || ''), ',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    out[key] = coerceArg(part.slice(eq + 1));
  }
  return out;
}

/** Pulls a balanced JSON object out of text that has other content around it. */
function extractJsonObject(text) {
  const start = String(text).indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quote = '';
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Reads whatever shape the model used inside one call block. */
function callFromJson(calls, text) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(text).trim());
  } catch {
    const candidate = extractJsonObject(text);
    if (!candidate) return false;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      return false;
    }
  }
  if (!parsed || typeof parsed.name !== 'string') return false;
  // The model alternates between "args" and "arguments".
  const args = parsed.args ?? parsed.arguments ?? parsed.input ?? parsed.parameters ?? {};
  pushCall(calls, parsed.name, args);
  return true;
}

/**
 * Reads a tool call out of model text.
 *
 * Three shapes come back in practice, sometimes from the same model in the
 * same session, and none of them is the native tool_calls field:
 *
 *   <shine-tool>{"name":"write_file","args":{...}}</shine-tool>
 *   <|tool_call_start|>[click(x=412, y=777, button='right')]<|tool_call_end|>
 *   {"name":"execute","arguments":{"command":"..."}}
 *
 * The closing tag and the end marker are both optional - one reply came back
 * cut short by the token budget with the tag left open - so a block that never
 * closes still parses instead of being thrown away and leaving the agent with
 * nothing to act on.
 */
function parseTextOnly(text) {
  const calls = [];
  let cleaned = String(text || '');

  cleaned = cleaned.replace(/<shine-tool>\s*([\s\S]*?)(?:<\/shine-tool>|$)/g, (_, inner) => {
    callFromJson(calls, inner);
    return '';
  });

  cleaned = cleaned.replace(/<\|tool_call_start\|>\s*\[([\s\S]*?)(?:\]\s*<\|tool_call_end\|>|$)/g, (_, inner) => {
    const open = String(inner).indexOf('(');
    if (open < 0) return '';
    const name = String(inner).slice(0, open).trim();
    const tail = String(inner).slice(open + 1);
    const close = tail.lastIndexOf(')');
    pushCall(calls, name, parseCallArgs(close >= 0 ? tail.slice(0, close) : tail));
    return '';
  });

  const trimmed = cleaned.trim();
  if (!calls.length && trimmed.startsWith('{') && trimmed.endsWith('}')) {
    if (callFromJson(calls, trimmed)) cleaned = '';
  }

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
  } else if (provider === SHINE) {
    // The model that ships with the site: no key, no model name, and it never
    // answers with native tool_calls - it writes the call out as text. So the
    // reply is returned as plain text here and parsed as a tool call by the
    // text-protocol path in the agent loop, exactly like the other keyless
    // fallbacks. That also keeps history in the plain shape this provider
    // flattens, rather than the OpenAI tool_calls shape it cannot read.
    //
    // The reply budget matters: this model reasons before answering, so a
    // small max_tokens comes back as finish_reason "length" with an empty
    // message and nothing to act on. It is retried once at double before
    // giving up.
    const endpoint = endpointFor(provider, baseUrl);
    const chatHeaders = { 'Content-Type': 'application/json' };
    const buildBody = (maxTokens) => ({
      messages: [
        { role: 'system', content: `${req.systemPrompt}\n\n${TEXT_PROTOCOL}` },
        ...flattenForTextProtocol(req.messages),
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
      stream: false,
    });

    // Both attempts share one controller, so the retry cannot silently turn a
    // 90-second ceiling into 180.
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const deadline = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      let data = await postJson(endpoint, chatHeaders, buildBody(SHINE_MAX_TOKENS), { signal, provider, controller: ctrl });
      if (isEmptyCompletion(data?.choices?.[0])) {
        const retry = await postJson(endpoint, chatHeaders, buildBody(SHINE_MAX_TOKENS * 2), { signal, provider, controller: ctrl });
        if (!isEmptyCompletion(retry?.choices?.[0])) data = retry;
      }
      return parseOpenAi(data);
    } finally {
      clearTimeout(deadline);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
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
    const data = await postJson(url, headers, body, { signal, provider, controller, timer });
    if (provider === 'gemini') return parseGemini(data);
    if (provider === 'claude') return parseAnthropic(data);
    return parseOpenAi(data);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * POSTs one JSON body and returns the parsed reply.
 *
 * A caller that needs two attempts inside one deadline passes its own
 * controller: the retry then stays inside the same budget instead of quietly
 * doubling it. Without one, this bounds itself.
 */
async function postJson(url, headers, body, { signal, provider = 'shine', controller } = {}) {
  const own = !controller;
  const ctrl = controller || new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const ownTimer = own ? setTimeout(() => ctrl.abort(), PROVIDER_FETCH_TIMEOUT_MS) : null;

  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
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
    return data;
  } finally {
    if (ownTimer) clearTimeout(ownTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * True when the model spent its whole reply budget reasoning and returned
 * nothing to act on. The site's own model does this when max_tokens is tight:
 * finish_reason is "length" and content is an empty string.
 */
function isEmptyCompletion(choice) {
  if (!choice) return true;
  const msg = choice.message || {};
  const hasCall = Boolean((msg.tool_calls || []).length);
  return !hasCall && !String(msg.content || '').trim();
}

function appendToolResult(provider, messages, toolCall, result) {
  if (provider === 'gemini') return appendGeminiToolResult(messages, toolCall, result);
  if (provider === 'claude') return appendAnthropicToolResult(messages, toolCall, result);
  return appendOpenAiToolResult(messages, toolCall, result);
}

module.exports = {
  callProvider,
  appendToolResult,
  parseTextOnly,
  toPlainHistory,
  OPENAI_COMPATIBLE,
  SHINE,
  isEmptyCompletion,
  postJson,
};