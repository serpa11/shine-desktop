'use strict';

const os = require('node:os');
const path = require('node:path');

const store = require('../store');
const guard = require('./guard');
const approvals = require('./approvals');
const executor = require('./executor');
const { TOOL_MAP, isReadOnly } = require('./tools');
const { callProvider, appendToolResult, parseTextOnly, toPlainHistory, OPENAI_COMPATIBLE, SHINE } = require('./providers');

const runState = {
  active: false,
  cancelled: false,
  currentRequestId: null,
  lastError: null,
  currentPlan: '',
};

// A provider that never answers used to leave the whole request hanging: the
// renderer's fetch wrapper waits on this promise, so the site's ask() never
// resolved and it sat on "processing" forever with no way out. Every provider
// call is now bounded, and the run as a whole has its own ceiling.
const PROVIDER_TIMEOUT_MS = 90000;
const RUN_TIMEOUT_MS = 6 * 60 * 1000;
const MAX_STEPS = 30;

/** A signal that aborts on timeout as well as on the caller's own signal. */
function withTimeout(external, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    runState.lastError = `The AI provider did not answer within ${Math.round(ms / 1000)} seconds.`;
    controller.abort();
  }, ms);

  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function isEnabled() {
  return store.getValue('pcControl', 'enabled', false) === true;
}

function status() {
  return {
    enabled: isEnabled(),
    running: runState.active,
    requestId: runState.currentRequestId,
    plan: runState.currentPlan,
    error: runState.lastError,
    allowlist: store.getValue('pcControl', 'allowlist', []) || [],
    maxSteps: MAX_STEPS,
    dangerMode: store.getValue('pcControl', 'dangerMode', false),
  };
}

function setEnabled(value) {
  store.setValue('pcControl', 'enabled', Boolean(value));
  if (!value) {
    runState.cancelled = true;
    approvals.rejectAll('PC Control was turned off.');
  }
  return status();
}

function cancel() {
  runState.cancelled = true;
  approvals.rejectAll('You pressed Stop, so nothing else will run.');
}

function buildSystemPrompt(extraContext = '') {
  const danger = store.getValue('pcControl', 'dangerMode', false);
  return `You are Shine, running as a desktop assistant on the user's Windows PC. You can see the whole conversation so far and you can actually operate their computer with the tools listed below.

# Environment
- Operating system: ${os.type()} ${os.release()} (${process.platform}, ${os.arch()})
- PowerShell is available for shell work. Prefer PowerShell over cmd.exe.
- The user's home folder is ${os.homedir()}.
- The user's desktop is ${path.join(os.homedir(), 'Desktop')}, downloads ${path.join(os.homedir(), 'Downloads')}, documents ${path.join(os.homedir(), 'Documents')}.
- Current time: ${new Date().toString()}

# Appearance and apps
- If the user asks to switch Windows between dark mode and light mode, call set_appearance with theme "dark", "light" or "system". The same tool turns transparency and animations on and off. It applies immediately.
- If the user names an app to open ("open spotify", "launch notepad", "run chrome"), call launch_app with the name they used. It searches the Start Menu, the App Paths registry and Program Files, so it finds programs that are not on PATH.
- If launch_app cannot find something, call find_applications to show the user what is actually installed, and offer those names rather than guessing.

# Long tasks
- You have up to ${MAX_STEPS} steps for one request. Long jobs are fine, but check progress after each step and stop if something is not going as expected.
- Prefer an application's own command line tool over clicking through its interface when one exists. vmrun.exe ships with VMware Workstation and can create a virtual machine in a single step, which is far more reliable than driving the New Virtual Machine wizard with mouse clicks.
- When you do click, screenshot before and after each click so you can see what actually happened.

# Changing Windows settings
- The user can ask for any Windows setting by name: appearance, accessibility, or experimental feature flags. Call list_windows_settings to find the exact setting name and see its current value, then change_windows_setting with that name and true or false.
- Common examples: "turn on dark mode", "switch to light mode", "turn on the narrator", "turn off telemetry", "turn off suggested apps", "make the taskbar centred".
- Never guess a setting name. Only names in the list work.

# Driving the mouse
- Use take_screenshot to see the screen, then move_cursor and click to interact. This is the only way to drive apps with no keyboard shortcut - a VMware wizard, for example.
- Click carefully: verify with another screenshot after clicking, and if something unexpected happened, tell the user rather than clicking again blindly.

# Typing commands for the user
- If the user wants to see a command rather than have Shine run it silently, use type_command. It opens a terminal and types the command out.
- To run a script file they already have, use run_script_file.

# How to work
1. Read-only tools (system_info, list_directory, read_file, list_processes, list_windows, take_screenshot, read_clipboard, get_volume, search_files, find_applications, list_windows_settings) run without a prompt.
2. Anything that writes files, runs a command, or drives the UI shows the user an approval dialog first. The user may approve or deny. A denial is final - do not try to work around it, and do not re-ask for the same action. Tell the user what you would have done and let them decide.
3. Work in small steps. After each tool result, check whether you actually achieved the goal before moving on.
4. Never claim you did something you did not do. Report the real tool output.
5. When a tool returns an error, read the error and adapt. Do not repeat the identical failing call more than once.

# Safety rules you must follow
- Never attempt to delete an entire drive, wipe the System folder, edit the registry, disable antivirus, or create admin accounts.
- Never run commands that destroy data the user did not explicitly ask you to remove.
- Before any bulk or irreversible action, explain exactly what will happen in one sentence.
- ${danger ? 'The user has enabled dangerous operations in Shine Settings. The hard blocklist is still off, but you must still be careful and explain what you are doing.' : 'Shine has a hard blocklist that will refuse destructive commands regardless of what you ask. If something is blocked, tell the user and suggest a safer alternative.'}
- Never type into a window unless you are certain that window is the intended target.
- Do not read or print private credentials, password stores, or files the user did not ask about.

# Style
Write like you are talking to a person, not writing a report. Short paragraphs. No headings unless the answer is long. Never describe a tool call in prose unless it actually happened.${extraContext ? `\n\n# Extra context from the app\n${extraContext}` : ''}`;
}

function buildMessages({ query, history }) {
  const messages = toPlainHistory(history);
  messages.push({ role: 'user', text: String(query || '').slice(0, 20000) });
  return messages;
}

/**
 * The signed-in account, so the agent answers "what is my name" and can
 * describe the profile picture just like a normal chat would.
 */
async function buildProfileText() {
  try {
    const accounts = require('../accounts');
    const account = await accounts.current();
    if (!account) return '';
    const { textForAgent } = require('../profile');
    return textForAgent(account);
  } catch {
    return '';
  }
}

/** The profile picture itself, when there is one. */
async function buildProfileImages() {
  try {
    const accounts = require('../accounts');
    const account = await accounts.current();
    if (!account?.hasAvatar) return [];
    const dataUrl = await accounts.avatarDataUrl(account, 160);
    if (!dataUrl) return [];
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
    return match ? [{ mimeType: match[1], data: match[2] }] : [];
  } catch {
    return [];
  }
}

/**
 * Main entry point. Runs the full agent loop and resolves with a final text answer.
 */
async function run(win, request, { signal } = {}) {
  if (!isEnabled()) {
    throw new Error('PC Control is turned off. Switch it on in the Shine taskbar to let Shine operate this PC.');
  }
  if (runState.active) {
    throw new Error('Shine is already working on a PC Control request.');
  }

  const provider = request.provider;
  // The model that ships with the site takes no key and no model name - Shine
  // no longer uses API keys at all - so the checks that guard every other
  // provider would block PC Control outright for the default setup.
  if (provider !== SHINE) {
    if (!request.apiKey) throw new Error(`No API key is configured for ${provider}.`);
    if (!request.model) throw new Error(`No model is selected for ${provider}.`);
  }

  runState.active = true;
  runState.cancelled = false;
  runState.lastError = null;
  runState.currentRequestId = request.requestId || `run-${Date.now()}`;
  runState.currentPlan = '';

  // A last-resort ceiling. Individual provider calls are already bounded, but
  // a chain of slow tool calls could otherwise keep the renderer waiting on a
  // promise that never settles.
  const wholeRun = withTimeout(signal, RUN_TIMEOUT_MS);
  const budget = wholeRun.signal;

  // Long enough to finish a multi-step task such as driving a wizard, and not
  // configurable: there is no settings panel, so a value left over from an
  // older build would otherwise quietly cap every task at the old limit.
  // The ceiling is what stops a confused model looping forever.
  const maxSteps = MAX_STEPS;
  const dangerMode = store.getValue('pcControl', 'dangerMode', false) === true;

  const profileImages = await buildProfileImages();
  const messages = buildMessages(request);
  const usedTools = [];
  const screenshots = [];
  const profileText = await buildProfileText();
  const systemContext = [profileText, request.systemContext || ''].filter(Boolean).join('\n\n');
  let pendingImages = [];
  // The site's own model never answers with native tool_calls, so asking it
  // for tools would only waste a step: it writes the call out as text and the
  // text-protocol path below reads it. Every other provider starts with tools
  // on and falls back if the provider rejects them.
  let useTools = provider !== SHINE;
  let finalText = '';

  try {
    for (let step = 0; step < maxSteps; step += 1) {
      if (runState.cancelled || signal?.aborted) throw new Error('Stopped by the user.');

      const bounded = withTimeout(budget, PROVIDER_TIMEOUT_MS);
      let parsed;
      try {
        parsed = await callProvider(
          {
            provider,
            model: request.model,
            apiKey: request.apiKey,
            baseUrl: request.baseUrl,
            authStyle: request.authStyle,
            systemPrompt: buildSystemPrompt(systemContext),
            messages,
            images: [...pendingImages, ...profileImages],
          },
          { signal: bounded.signal }
        );
      } catch (err) {
        if (err?.name === 'AbortError' && !runState.cancelled) {
          throw new Error(
            `The AI provider did not answer within ${Math.round(PROVIDER_TIMEOUT_MS / 1000)} seconds, so I stopped waiting. Check the base URL, model name and that the provider is reachable.`
          );
        }
        throw err;
      } finally {
        bounded.done();
      }
      pendingImages = [];

      if (!useTools) {
        const textOnly = parseTextOnly(parsed.text);
        finalText = textOnly.text;
        if (textOnly.toolCalls.length) {
          const call = textOnly.toolCalls[0];
          const outcome = await runOneTool(win, call, step, maxSteps, dangerMode);
          usedTools.push(outcome.record);
          messages.push({ role: 'user', text: '' });
          messages[messages.length - 1].toolCalls = [{ name: call.name, args: call.args }];
          messages.push({ role: 'user', text: '' });
          messages[messages.length - 1].toolResults = [outcome.payload];
          continue;
        }
        break;
      }

      if (parsed.toolCalls.length) {
        for (const call of parsed.toolCalls) {
          const outcome = await runOneTool(win, call, step, maxSteps, dangerMode);
          usedTools.push(outcome.record);
          if (outcome.payload?.ok && outcome.screenshot) {
            pendingImages = [outcome.screenshot];
            screenshots.push({ path: outcome.payload.output?.path, dataUrl: `data:image/png;base64,${outcome.screenshot.data}` });
          }
          appendToolResult(provider, messages, call, outcome.payload);
          if (runState.cancelled) throw new Error('Stopped by the user.');
        }
        continue;
      }

      finalText = parsed.text;
      if (!finalText.trim()) finalText = 'I ran the PC Control steps but did not get a final answer back from the model.';
      break;
    }

    if (!finalText) {
      const blocked = usedTools.filter((t) => t.decision === 'blocked');
      if (blocked.length && !usedTools.some((t) => t.decision === 'approved')) {
        finalText = `I did not do anything on your PC. ${blocked[0].reason}`;
      } else {
        finalText = `I reached the ${maxSteps}-step limit for this request. Here is what happened so far:\n\n${usedTools
          .map((t) => `- \`${t.tool}\`: ${t.decision}${t.detail ? ` - ${t.detail}` : ''}`)
          .join('\n')}`;
      }
    }

    return { text: finalText, toolsUsed: usedTools, steps: usedTools.length, screenshots };
  } catch (err) {
    runState.lastError = err?.message || String(err);
    if (err?.noToolsHint && useTools && OPENAI_COMPATIBLE.has(provider)) {
      // Provider rejected the tools parameter - retry once with the text protocol.
      useTools = false;
      runState.active = false;
      return run(win, request, { signal });
    }
    throw err;
  } finally {
    wholeRun.done();
    runState.active = false;
    runState.currentPlan = '';
  }
}

async function runOneTool(win, call, step, maxSteps, dangerMode) {
  const spec = TOOL_MAP.get(call.name);
  const summary = executor.summarise(call.name, call.args);
  const record = { tool: call.name, args: call.args, summary, decision: 'approved', step: step + 1 };

  if (!spec) {
    return {
      record: { ...record, decision: 'error', detail: 'unknown tool' },
      payload: { ok: false, error: `There is no tool called "${call.name}".` },
    };
  }

  const paths = ['path', 'from', 'to'].map((k) => call.args?.[k]).filter(Boolean);
  const verdict = guard.inspect({
    kind: spec.risk === 'read' ? 'read' : call.name,
    command: call.args?.command,
    target: call.args?.action || call.args?.name,
    paths,
    dangerMode,
  });

  if (verdict.blocked) {
    record.decision = 'blocked';
    record.detail = verdict.reason;
    approvals.appendLog({ at: new Date().toISOString(), tool: call.name, risk: spec.risk, summary, decision: 'blocked', reason: verdict.rule });
    return { record, payload: { ok: false, error: verdict.reason } };
  }

  if (!isReadOnly(call.name)) {
    const decision = await approvals.requestApproval(win, {
      name: call.name,
      args: call.args,
      summary,
      risk: spec.risk,
      warnings: verdict.warnings,
      step: step + 1,
      purpose: `step ${step + 1} of ${maxSteps}`,
    });

    if (!decision.approved) {
      record.decision = 'denied';
      record.detail = decision.reason;
      return {
        record,
        payload: {
          ok: false,
          error: `The user did not allow "${call.name}". ${decision.reason || ''} Do not retry this action; continue without it or ask the user what to do instead.`,
        },
      };
    }
  }

  if (runState.cancelled) throw new Error('Stopped by the user.');

  const result = await executor.execute(call.name, call.args);
  record.decision = result.ok ? 'ran' : 'error';
  if (!result.ok) record.detail = String(result.error).slice(0, 300);

  approvals.appendLog({
    at: new Date().toISOString(),
    tool: call.name,
    risk: spec.risk,
    args: { ...call.args, content: undefined, text: undefined },
    summary,
    decision: record.decision,
    detail: record.detail || null,
    step: step + 1,
  });

  // Screenshot results are forwarded to the renderer so the user sees them,
  // and optionally to the model on the next turn. The base64 never goes into
  // the tool-result text - the model gets the path and the image separately.
  let screenshot = null;
  let output = result.output;
  if (result.ok && call.name === 'take_screenshot' && output?.path) {
    try {
      const { readFile } = require('node:fs/promises');
      const buf = await readFile(output.path);
      screenshot = { mimeType: 'image/png', data: buf.toString('base64') };
    } catch {}
  }

  return {
    record,
    screenshot,
    payload: result.ok ? { ok: true, tool: call.name, output } : { ok: false, tool: call.name, error: result.error },
  };
}

module.exports = { run, status, setEnabled, cancel, isEnabled, buildSystemPrompt, runState };