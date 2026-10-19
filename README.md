# Shine Desktop

A Windows desktop app built from [shineai-9mr.pages.dev](https://shineai-9mr.pages.dev/).

It loads the live Shine site inside a real window and adds exactly three
things a browser tab cannot do:

- **Window buttons** - minimise, maximise and close
- **Control PC** - ask Shine to operate your computer, approving every action
- **Dictation** - the site's own microphone button, made to work

There is no settings panel, no setup wizard and no branding. The icon and the
window bar are plain text.

---

## Install

`release/ShineSetup-1.0.0.exe` is the installer. It installs per-user (no admin
prompt), creates a desktop and Start Menu shortcut, and uninstalls cleanly.

To rebuild it:

```bash
npm install
npm run build
```

To run from source:

```bash
npm start
```

---

## How it is put together

```
src/main/                Electron main process
  main.js                lifecycle, IPC, tray, permissions
  window.js              the frameless window + content loading/fallback
  preload.js             the only bridge between the page and the desktop layer
  store.js               JSON settings (settings.json next to the app data)
  diagnostics.js         renderer introspection for development
  agent/
    index.js             the tool-calling loop
    tools.js             26 tools + their JSON schemas
    executor.js          actually runs the tools (Node + PowerShell)
    approvals.js         approval requests, remember rules, activity log
    guard.js             the destructive-command blocklist
    providers.js         OpenAI / Anthropic / Gemini request adapters
  mic/stt.js             dictation engines (Whisper API + offline Vosk)

src/renderer/desktop/    injected into the page's main world
  desktop.js             window bar, Control PC switch, approval dialog, log,
                         request routing for chat and dictation
  desktop.css            all styling

vendor/shine.html        a snapshot of the live site, used as an offline fallback
test/                    mock provider, drivers, test suites
scripts/                 icon stamping, screenshot helper
build/                   icon generator
```

### Loading the site

The window loads `https://shineai-9mr.pages.dev/` by default. If that request
fails or hangs, Shine automatically switches to the bundled copy in
`vendor/shine.html` and shows a toast explaining why. You can force the
bundled copy from **desktop settings → Load the live Shine site**.

To refresh the bundled snapshot from the live site:

```bash
Invoke-WebRequest https://shineai-9mr.pages.dev/ -OutFile vendor/shine.html
```

The desktop layer never patches the site's code. It hooks `window.fetch` in the
page's world, so if the site changes its internals the app keeps working — the
desktop features are additive.

---

## The window bar

```
Shine                                    Control PC   Log   —  []  x
```

- **Control PC** - the on/off switch for PC Control. Toggled from the tray too.
- **Log** - everything Shine did on this PC, newest first.
- **minimise / maximise / close** - close quits.

Double-click the bar to maximise. Drag it to the left or right edge to snap.

There is deliberately no full-screen button, no microphone button (the site has
one), no settings and no setup wizard.

Turn it on with **Control PC** in the window bar or from the tray icon.

## Control PC

### The loop

1. Your message is intercepted on its way to the AI provider.
2. The request is re-issued from the main process with 26 tools attached.
3. Read-only tools run immediately. Anything that writes a file, runs a command
   or changes the system opens an approval dialog in the app.
4. You approve or deny. Results are fed back to the model, which continues.
5. After `maxSteps` steps (default 8) Shine reports back.

### The tools

*Inspect* — `system_info`, `list_directory`, `search_files`, `read_file`,
`read_clipboard`, `list_processes`, `list_windows`, `take_screenshot`,
`get_volume`

*Files* — `write_file`, `create_directory`, `delete_path`, `move_path`,
`copy_path`

*Run and drive* — `run_command`, `open_path`, `open_url`, `launch_app`,
`close_app`, `kill_process`, `type_text`, `press_keys`, `focus_window`,
`set_clipboard`, `set_volume`

*System* — `system_power` (lock / sleep / restart / shutdown / sign out)

### Safety

- **Ask every time.** Nothing that changes anything runs without a dialog.
  Read-only lookups run on their own.
- **Hard blocklist.** Drive wipes, `Remove-Item -Recurse -Force`, `rm -rf`,
  registry deletion, `format`, shadow-copy deletion, Defender tampering,
  `Invoke-Expression`, piping downloads into shells, creating admin accounts —
  all refused outright, and the refusal is shown to the model so it can explain
  itself rather than retry.
- **Critical processes are never killed**, and Shine refuses to kill itself.
- **Denials are final.** The model is told not to retry or work around a denial.
  Closing the dialog counts as a denial.
- **Always allow** is opt-in per action, or as a command prefix (`winget`,
  `git status`). The blocklist still applies.
- **Emergency stop** — turning **Control PC** off mid-run aborts the loop and
  drops anything awaiting approval.
- **Audit trail** — every decision lands in `activity-log.json`, viewable under
  **Log**.

The blocklist is enforced in `src/main/agent/guard.js`.

---

## Dictation

Press the microphone button the site already has in the chat box. Shine records
the audio and posts it to a transcription endpoint - the desktop layer
intercepts that request and routes it through the main process, so it works
with OpenAI, Groq or any Custom endpoint already saved in Shine Settings,
without entering a key twice.

If the online request fails and a local Vosk model is present, Shine falls back
to offline transcription automatically. To enable that: `npm install vosk`, then
unzip a model into `Documents\Shine\models`. Nothing about your voice leaves
the machine in that mode.

The transcript is inserted into the chat box; nothing is sent until you press
send.

---

## Installer

`npm run build` produces an NSIS installer at `release/ShineSetup-1.0.0.exe`:

- per-user install (no admin prompt by default)
- Start Menu and desktop shortcuts
- proper uninstaller
- optional install-directory choice

---

## Development helpers

```bash
node test/run-tests.js          # guard, executor and schema tests
node test/mic-tests.js          # dictation tests (needs the mock provider)
node test/mock-provider.js      # fake OpenAI-compatible provider on :8787
npm start -- --drive            # drive the app through a scripted agent run
npm start -- --debug-dump       # dump renderer diagnostics to JSON
```

To exercise the agent end to end without a real key:

```bash
node test/mock-provider.js &
# in another shell:
SHINE_TEST_PC=1 npm start -- --drive
```

The driver points Shine at the mock, turns PC Control on before the window
opens, and sends a real message through the real chat path.

---

## Notes and limits

- API keys are stored in the app's own storage on this machine, in the same
  `localStorage` the website uses. Nothing is sent anywhere except to the AI
  provider you configured.
- `type_text` and `press_keys` inject keystrokes into whatever window has
  focus, so Shine should only use them right after opening the intended window.
- Provider support for tool calling varies. OpenAI-compatible, Anthropic and
  Gemini shapes are implemented natively; if a provider rejects the `tools`
  parameter, Shine retries once using a text-based protocol.
- The activity log is local only.