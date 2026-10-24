'use strict';

/**
 * Prints raw, untruncated replies so the parser can be matched to reality.
 *
 * The model writes two different tool syntaxes and one reply came back with
 * an unterminated tag, so the exact bytes matter more than a pretty preview.
 *
 *   node test/shine-model-raw.js
 */

const { buildSystemPrompt } = require('../src/main/agent/index.js');

const URL_ = process.env.SHINE_CHAT_URL || 'https://shineai-9mr.pages.dev/api/chat';

async function ask(label, system, user) {
  const body = {
    model: 'shine',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: 1500,
    temperature: 0.2,
    stream: false,
  };
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
  const choice = data.choices && data.choices[0];
  const content = (choice && choice.message && choice.message.content) || '';
  console.log(`\n=== ${label} ===`);
  console.log('finish:', choice && choice.finish_reason, '| content chars:', content.length);
  console.log(JSON.stringify(content));
  return content;
}

async function main() {
  const sys = buildSystemPrompt('The active AI provider is shine.');
  const TEXT = `You can control this PC. Instead of calling tools, write your action on its own line using exactly this format:

<shine-tool>{"name":"run_command","args":{"command":"winget list"}}</shine-tool>

Rules:
- Put every tool call inside <shine-tool> tags.
- Issue ONE tool call per message and wait for the result before continuing.
- Results come back as <shine-result>...</shine-result>.
- When you are finished, reply with prose only and no <shine-tool> tags.`;

  // The reply that looked unterminated.
  await ask(
    'E again - two requests in one turn',
    `${sys}\n\n${TEXT}`,
    'Open Notepad and then also list the files in C:\\Users\\name\\Downloads.'
  );

  // Native syntax with several arguments, to learn its argument grammar.
  await ask(
    'native format, several args',
    'You control a Windows PC. Use the tool call format <|tool_call_start|>[tool_name(arg=value)]<|tool_call_end|>.',
    'Double-click at x=412 y=777 with button "right". Call click.'
  );

  // Does it ever emit both formats in one reply?
  await ask(
    'two turns, follow-up',
    `${sys}\n\n${TEXT}`,
    'Read the clipboard.'
  );
}

main().catch((err) => {
  console.error('probe failed:', err.message);
  process.exit(1);
});
