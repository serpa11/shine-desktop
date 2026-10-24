'use strict';

/**
 * Asks the site's own keyless model for a PC Control tool call.
 *
 * Shine no longer ships API keys - the site runs its own model behind
 * /api/chat. PC Control has to work through that same endpoint, with no key
 * and no model setting, so this probe sends the agent's real system prompt to
 * it and reports whether a usable tool call comes back.
 *
 *   node test/shine-model-probe.js
 */

const { buildSystemPrompt } = require('../src/main/agent/index.js');
const { flattenForTextProtocol } = require('../src/main/agent/providers.js');

const URL_ = process.env.SHINE_CHAT_URL || 'https://shineai-9mr.pages.dev/api/chat';

const TEXT_PROTOCOL = `You can control this PC. Instead of calling tools, write your action on its own line using exactly this format:

<shine-tool>{"name":"run_command","args":{"command":"winget list"}}</shine-tool>

Rules:
- Write plain prose for the user, and put every tool call inside <shine-tool> tags.
- Issue ONE tool call per message and wait for the result before continuing.
- The result comes back as <shine-result>...</shine-result>. Use it to decide the next step.
- When you are finished, reply with prose only and no <shine-tool> tags.`;

async function ask(label, messages, maxTokens) {
  const body = { model: 'shine', messages, max_tokens: maxTokens, temperature: 0.2, stream: false };
  const t0 = Date.now();
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const ms = Date.now() - t0;
  console.log(`\n=== ${label} ===`);
  console.log(`status ${res.status} in ${ms}ms, reply ${text.length} bytes`);
  if (!res.ok) {
    console.log('body:', text.slice(0, 500));
    return null;
  }
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {}
  const choice = data.choices && data.choices[0];
  if (!choice) {
    console.log('no choices; body:', text.slice(0, 400));
    return null;
  }
  const msg = choice.message || {};
  console.log('finish:', choice.finish_reason, '| model:', String(data.model || '').slice(-40));
  console.log('content:');
  console.log(String(msg.content || '').slice(0, 1200));
  console.log('native tool_calls:', msg.tool_calls ? JSON.stringify(msg.tool_calls).slice(0, 300) : 'none');
  return msg.content || '';
}

async function main() {
  console.log('endpoint:', URL_);

  const sys = buildSystemPrompt('The active AI provider is shine - the model built into the Shine site, needing no API key.');
  console.log('system prompt:', sys.length, 'chars (~' + Math.round(sys.length / 4) + ' tokens)');

  const messages = [
    { role: 'system', content: `${sys}\n\n${TEXT_PROTOCOL}` },
    { role: 'user', content: 'What operating system is this computer running? Use the system_info tool.' },
  ];
  console.log('total request chars:', JSON.stringify(messages).length);

  const a = await ask('full agent prompt, text protocol', messages, 2000);
  if (a) {
    const shine = /<shine-tool>\s*([\s\S]*?)\s*<\/shine-tool>/.exec(a);
    if (shine) {
      try {
        const parsed = JSON.parse(shine[1]);
        console.log('\nPARSED TOOL CALL:', JSON.stringify(parsed));
      } catch (e) {
        console.log('\nTOOL TAG FOUND BUT NOT JSON:', e.message);
        console.log(shine[1]);
      }
    } else {
      console.log('\nno <shine-tool> tag in the reply');
    }
  }

  // A second round, carrying a tool result back, which is what the loop does.
  const flat = flattenForTextProtocol([
    { role: 'user', text: 'What operating system is this computer running? Use the system_info tool.' },
    { text: '', toolCalls: [{ name: 'system_info', args: {} }] },
    {
      toolResults: [{ ok: true, output: '{"os":"Windows 11 Pro 26200","cpu":"AMD Ryzen 7 7800X3C"}' }],
    },
  ]);
  await ask('history with a tool result appended', [
    { role: 'system', content: `${sys}\n\n${TEXT_PROTOCOL}` },
    ...flat,
  ], 2000);
}

main().catch((err) => {
  console.error('probe failed:', err.message);
  process.exit(1);
});
