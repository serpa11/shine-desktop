'use strict';

/**
 * Finds which tool-call syntax the site's keyless model actually obeys.
 *
 * The model answered with its own native <|tool_call_start|>... format rather
 * than the <shine-tool> JSON the agent prompt asks for, so PC Control has to
 * parse whatever it really writes. This probes several phrasings and prints
 * the raw replies side by side.
 *
 *   node test/shine-model-syntax.js
 */

const { buildSystemPrompt } = require('../src/main/agent/index.js');

const URL_ = process.env.SHINE_CHAT_URL || 'https://shineai-9mr.pages.dev/api/chat';

async function ask(label, system, user, maxTokens) {
  const body = {
    model: 'shine',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens || 1500,
    temperature: 0.2,
    stream: false,
  };
  const t0 = Date.now();
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {}
  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  console.log(`\n=== ${label} ===  (${res.status}, ${Date.now() - t0}ms, finish=${data.choices && data.choices[0] && data.choices[0].finish_reason})`);
  console.log(String(msg.content || text).slice(0, 1000));
  return msg.content || '';
}

async function main() {
  const sys = buildSystemPrompt('The active AI provider is shine.');
  const TEXT = `You can control this PC. Instead of calling tools, write your action on its own line using exactly this format:

<shine-tool>{"name":"run_command","args":{"command":"winget list"}}</shine-tool>

Rules:
- Write plain prose for the user, and put every tool call inside <shine-tool> tags.
- Issue ONE tool call per message and wait for the result before continuing.
- The result comes back as <shine-result>...</shine-result>. Use it to decide the next step.
- When you are finished, reply with prose only and no <shine-tool> tags.`;

  await ask(
    'A. real prompt, simple read-only call',
    `${sys}\n\n${TEXT}`,
    'What operating system is this computer running? Use the system_info tool.'
  );

  await ask(
    'B. real prompt, multi-argument call',
    `${sys}\n\n${TEXT}`,
    'Double-click at x=412 y=777 with the right mouse button. Use the click tool.'
  );

  await ask(
    'C. real prompt, command with quoting',
    `${sys}\n\n${TEXT}`,
    'Run this command: winget list --id VMware.Workstation. Use run_command.'
  );

  await ask(
    'D. short prompt, JSON format spelled out',
    'You control a Windows PC. Call exactly one tool per reply. Reply with ONLY this and nothing else:\n<shine-tool>{"name":"click","args":{"x":10,"y":20,"button":"left"}}</shine-tool>',
    'Click at 10,20.'
  );

  await ask(
    'E. does it keep to one call per turn?',
    `${sys}\n\n${TEXT}`,
    'Open Notepad and then also list the files in C:\\Users\\name\\Downloads.'
  );
}

main().catch((err) => {
  console.error('probe failed:', err.message);
  process.exit(1);
});
