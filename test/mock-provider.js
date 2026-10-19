'use strict';

/**
 * Mock OpenAI-compatible provider used to exercise the PC Control agent
 * without spending a real API key.
 *
 *   node test/mock-provider.js [port]
 *
 * Endpoints
 *   POST /v1/chat/completions   scripted tool-calling conversation
 *   POST /v1/audio/transcriptions  canned transcription
 *   GET  /__script              inspect / reset the script
 */

const http = require('node:http');

const port = Number(process.argv[2]) || 8787;

/**
 * Each entry is a step. A step may be a tool call or the final answer.
 * The server counts how many tool results the client has sent back and
 * replies with the matching step, which is exactly how a real tool-calling
 * model behaves.
 */
const DEFAULT_SCRIPT = [
  { tool: 'system_info', args: {} },
  { tool: 'list_directory', args: { path: '.' } },
  { tool: 'write_file', args: { path: 'shine-test-output.txt', content: 'Written by the Shine PC Control agent.\n' } },
  { text: 'Done. I checked this PC, looked in your home folder, and wrote **shine-test-output.txt** to your documents.' },
];

const DESTRUCTIVE_SCRIPT = [
  { tool: 'run_command', args: { command: 'Remove-Item -Recurse -Force C:\\Users\\everything' } },
  { text: 'That command is refused by the safety guard, so nothing was deleted.' },
];

const DENY_SCRIPT = [
  { tool: 'delete_path', args: { path: 'notes-to-delete.txt' } },
  { text: 'Understood, I left the file alone.' },
];

let script = DEFAULT_SCRIPT.slice();
let requests = [];

function setScript(name) {
  script = { destructive: DESTRUCTIVE_SCRIPT, deny: DENY_SCRIPT }[name] || DEFAULT_SCRIPT;
  requests = [];
  return script;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

/** How many assistant tool-call turns the client has already completed. */
function countToolResults(messages) {
  return (messages || []).filter((m) => m.role === 'tool').length;
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/__script') {
    return send(res, 200, { requests, script });
  }

  if (req.method === 'POST' && req.url === '/__script') {
    readBody(req).then((body) => send(res, 200, { script: setScript(body.name) }));
    return;
  }

  if (req.method === 'POST' && /\/chat\/completions/.test(req.url)) {
    const body = await readBody(req);
    requests.push({ url: req.url, tools: (body.tools || []).length, model: body.model, messages: (body.messages || []).length });
    process.stdout.write(`[mock] chat request #${requests.length} tools=${(body.tools || []).length} model=${body.model}\n`);

    // Reject tool calling once, so the text-protocol fallback gets exercised.
    if (body.messages?.length === 1 && process.env.MOCK_REJECT_TOOLS === '1') {
      return send(res, 400, { error: { message: 'tools are not supported by this model' } });
    }

    const done = countToolResults(body.messages);
    const step = script[Math.min(done, script.length - 1)];

    if (step.tool) {
      return send(res, 200, {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: body.model || 'mock-model',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: `call_${done}_${step.tool}`,
                  type: 'function',
                  function: { name: step.tool, arguments: JSON.stringify(step.args) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
    }

    return send(res, 200, {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model: body.model || 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content: step.text }, finish_reason: 'stop' }],
    });
  }

  if (req.method === 'POST' && /\/audio\/transcriptions/.test(req.url)) {
    await readBody(req);
    process.stdout.write('[mock] audio transcription request\n');
    return send(res, 200, { text: 'hello from the mock microphone' });
  }

  send(res, 404, { error: { message: `no mock route for ${req.method} ${req.url}` } });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[mock] listening on http://127.0.0.1:${port}/v1\n`);
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());