'use strict';

/**
 * Checks the text-protocol parser against every tool-call shape the models
 * actually produce.
 *
 * The site's own keyless model never returns native tool_calls - it writes
 * the call as text, and it uses three different shapes for that, sometimes
 * within one session. It also invents tool names, and a reply cut short by
 * the token budget leaves the closing tag off. All of that has to parse, or
 * PC Control silently does nothing.
 *
 *   node test/text-protocol-tests.js
 */

const assert = require('assert');
const { parseTextOnly, isEmptyCompletion, SHINE } = require('../src/main/agent/providers.js');

let passed = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + label);
  } catch (err) {
    failures.push(label);
    console.log('  FAIL ' + label + '\n       ' + err.message);
  }
}

const SAMPLES = [
  {
    label: 'native syntax with named arguments',
    text: "\n<|tool_call_start|>[click(x=412, y=777, button='right')]<|tool_call_end|>",
    name: 'click',
    args: { x: 412, y: 777, button: 'right' },
  },
  {
    label: 'native syntax with no arguments',
    text: '\n<|tool_call_start|>[system_info()]<|tool_call_end|>',
    name: 'system_info',
    args: {},
  },
  {
    label: 'native syntax with a quoted Windows path',
    text: '<|tool_call_start|>[list_directory(path="C:\\Users\\name\\Documents")]<|tool_call_end|>',
    name: 'list_directory',
    args: { path: 'C:\\Users\\name\\Documents' },
  },
  {
    label: 'shine-tool tag with args',
    text: '<shine-tool>{"name":"write_file","args":{"path":"a.txt","content":"hi"}}</shine-tool>',
    name: 'write_file',
    args: { path: 'a.txt', content: 'hi' },
  },
  {
    label: 'shine-tool tag using "arguments" instead of "args"',
    text: '\n<shine-tool>{"name":"run_command","arguments":{"command":"winget list"}}</shine-tool>',
    name: 'run_command',
    args: { command: 'winget list' },
  },
  {
    label: 'bare JSON object with no tag at all',
    text: '\n{\n  "name": "execute",\n  "arguments": {\n    "command": "dir /b"\n  }\n}',
    name: 'run_command',
    args: { command: 'dir /b' },
  },
  {
    label: 'invented name "run" resolves to run_command',
    text: '<shine-tool>{"name":"run","args":{"command":"dir"}}</shine-tool>',
    name: 'run_command',
    args: { command: 'dir' },
  },
  {
    label: 'closing tag missing after a truncated reply',
    text: '<shine-tool>{"name":"run_command","args":{"command":"notepad"}}',
    name: 'run_command',
    args: { command: 'notepad' },
  },
  {
    label: 'call surrounded by prose',
    text: 'Let me look at that first.\n<shine-tool>{"name":"system_info","args":{}}</shine-tool>',
    name: 'system_info',
    args: {},
  },
];

for (const sample of SAMPLES) {
  check(sample.label, () => {
    const parsed = parseTextOnly(sample.text);
    assert.strictEqual(parsed.toolCalls.length, 1, 'expected exactly one tool call, got ' + parsed.toolCalls.length);
    const call = parsed.toolCalls[0];
    assert.strictEqual(call.name, sample.name, 'expected tool "' + sample.name + '", got "' + call.name + '"');
    assert.deepStrictEqual(call.args, sample.args, 'args mismatch: ' + JSON.stringify(call.args));
    assert.ok(call.id, 'the call needs an id');
    assert.ok(!/<shine-tool>|<\|tool_call_start\|>/.test(parsed.text), 'the call markup must be stripped from the reply text');
  });
}

check('prose with no call returns empty tool list', () => {
  const parsed = parseTextOnly('I opened Notepad for you.');
  assert.strictEqual(parsed.toolCalls.length, 0);
  assert.strictEqual(parsed.text, 'I opened Notepad for you.');
});

check('an unknown tool name is preserved rather than dropped', () => {
  const parsed = parseTextOnly('<shine-tool>{"name":"definitely_not_a_tool","args":{}}</shine-tool>');
  assert.strictEqual(parsed.toolCalls.length, 1);
  assert.strictEqual(parsed.toolCalls[0].name, 'definitely_not_a_tool');
});

check('a model name that only differs in case still resolves', () => {
  const parsed = parseTextOnly('<shine-tool>{"name":"System_Info","args":{}}</shine-tool>');
  assert.strictEqual(parsed.toolCalls[0].name, 'system_info');
});

check('an empty reply is treated as an empty completion', () => {
  assert.strictEqual(isEmptyCompletion({ message: { content: '' } }), true);
  assert.strictEqual(isEmptyCompletion({ message: { content: '   ' } }), true);
  assert.strictEqual(isEmptyCompletion(undefined), true);
  assert.strictEqual(isEmptyCompletion({ message: { content: 'done' } }), false);
});

check('a reply that carried a call is not treated as empty', () => {
  assert.strictEqual(isEmptyCompletion({ message: { content: '', tool_calls: [] } }), true);
  assert.strictEqual(isEmptyCompletion({ message: { content: '' }, finish_reason: 'length' }), true);
});

check('the keyless provider is named shine', () => {
  assert.strictEqual(SHINE, 'shine');
});

console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) process.exit(1);
