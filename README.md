# Shine Desktop

A Windows desktop app built from [shineai-9mr.pages.dev](https://shineai-9mr.pages.dev/).

It loads the live Shine site inside a real window and adds only the things a
browser tab cannot do:

- **Window buttons** - minimise, maximise, close
- **Control PC** - ask Shine to operate your computer, approving every action
- **Dictation** - the site's own microphone button, made to work
- **Accounts** - local sign up / sign in, with a profile picture the AI knows

No settings panel, no setup wizard inside the app, no colour, no logo. The icon
and the window bar are plain text.

---

## Install

Two programs are produced:

| File | What it is |
| --- | --- |
| `release-setup/ShineSetup.exe` | The installer. Shows install location and options, installs Shine. |
| `release/win-unpacked/Shine.exe` | The app itself, installed by ShineSetup. |

`ShineSetup.exe` shows you where it will install and lets you tick:

- create a desktop shortcut
- create a Start Menu shortcut
- start Shine when you sign in to Windows
- open Shine when the install finishes

It registers in *Add or remove programs* and drops an `Uninstall Shine.exe`
next to the app.

### Build it

```bash
npm install
npm run release
```

`npm run build` produces the older NSIS-only installer if you just want that.

---

## The window bar

```
Shine    name    Control PC   Log   |   —  □  x
```

- **name / Sign in** - opens your account, or signs you in
- **Control PC** - the on/off switch for PC Control. Also in the tray icon.
- **Log** - everything Shine did on this PC, newest first
- **minimise / maximise / close** - plain SVG glyphs, monochrome, and they do
  not change appearance when you hover them. Close quits.

Double-click the bar to maximise. Drag it to the left or right edge to snap.
There is deliberately no full-screen button, no microphone button (the site has
one), no settings and no setup wizard.

---

## Control PC

### The loop

1. Your message is intercepted on its way to the AI provider.
2. The request is re-issued from the main process with 26 tools attached.
3. Read-only tools run immediately. Anything that writes a file, runs a command
   or changes the system opens an approval dialog.
4. You approve or deny. Results are fed back to the model, which continues.
5. After `maxSteps` steps it reports back.

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
  refused outright, and the refusal is shown to the model so it can explain
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

Enforced in `src/main/agent/guard.js`.

---

## Accounts

Accounts live only on this PC. There is no server, so there is nothing to
phish and nothing to spoof: **an account only exists once this machine created
it**, and a made-up username with any password cannot sign in.

- Passwords are stored as **scrypt** hashes with a per-account random salt and
  are never written in clear.
- Sign-in verifies the submitted password against that hash in constant time.
- A missing account and a wrong password take the same amount of time, and
  give different messages, so neither can be used to probe.
- **Forgot password** asks the recovery question you chose at sign-up, then lets
  you set a new one. A wrong answer never reveals whether the account exists.

From the account panel you can change your **name**, your **username**, your
**password**, and your **profile picture**.

### The AI knows who you are

While you are signed in, every request carries your name and username. If you
set a profile picture it is attached as an image, so the model can describe it
or answer "what is my name".

This works for **every** provider - ChatGPT, Claude, Gemini, Groq, OpenRouter,
Grok and Custom endpoints - because it is attached on the way through the main
process rather than by special-casing each API. It also works for the site's
built-in non-AI replies, because the account details are prepended to your
message while the visible message stays exactly as you typed it.

Sign out and nothing is attached.

---

## Dictation

Press the microphone button the site already has in the chat box. Shine records
the audio and posts it to a transcription endpoint - the desktop layer
intercepts that request and routes it through the main process, so it works
with OpenAI, Groq or any Custom endpoint already saved in Shine Settings,
without entering a key twice.

If the online request fails and a local Vosk model is present, Shine falls back
to offline transcription automatically. To enable that: `npm install vosk`, then
unzip a model into `Documents\Shine\models`.

---

## Local models and "Failed to fetch"

The page is served over `https://`, so the browser refuses any `http://` request
made from it, and blocks cross-origin ones. A local model on
`http://localhost:11434/v1` (Ollama, LM Studio, llama.cpp) therefore fails with
`Failed to fetch` in a browser.

Every provider request is routed through the main process instead, which has
neither restriction. Set a **Custom** provider in Shine Settings pointing at
your local endpoint and it just works.

---

## How it is put together

```
src/main/                Electron main process
  main.js                lifecycle, IPC, tray, permissions
  window.js              the frameless window + content loading/fallback
  preload.js             the only bridge between the page and the desktop layer
  store.js               PC Control and dictation settings
  powershell.js          shared PowerShell bridge
  accounts/index.js      scrypt-hashed local accounts
  profile.js             builds and attaches the signed-in user's profile
  agent/
    index.js             the tool-calling loop
    tools.js             26 tools + their JSON schemas
    executor.js          actually runs the tools (Node + PowerShell)
    approvals.js         approval requests, remember rules, activity log
    guard.js             the destructive-command blocklist
    providers.js         OpenAI / Anthropic / Gemini request adapters
  mic/stt.js             dictation engines (Whisper API + offline Vosk)

src/renderer/desktop/    injected into the page's main world
  desktop.js             window bar, accounts, approval dialog, log,
                         request routing for chat and dictation
  desktop.css            all styling

setup-app/               ShineSetup - the installer, a separate program
vendor/shine.html        snapshot of the live site, used as an offline fallback
test/                    mock provider, drivers, test suites
scripts/                 build, icon stamping, publish, screenshot
build/                   icon generator
```

### Loading the site

The window loads `https://shineai-9mr.pages.dev/` by default. If that request
fails or hangs, Shine automatically switches to the bundled copy in
`vendor/shine.html`.

To refresh the bundled snapshot:

```bash
Invoke-WebRequest https://shineai-9mr.pages.dev/ -OutFile vendor/shine.html
```

The desktop layer never patches the site's code. It hooks `window.fetch` in the
page's world, so site updates do not break it.

---

## Tests

```bash
npm test              # guard, executor, tool schemas
npm run test:accounts # signup/signin/recovery/profile injection
npm run test:mic      # dictation pipeline (needs the mock provider)
npm run test:installer # install, re-install and uninstall
npm run test:all
```

`test/mock-provider.js` is a fake OpenAI-compatible server on port 8787:

```bash
node test/mock-provider.js &
SHINE_TEST_PC=1 npm start -- --drive
```

---

## Publishing to GitHub

```powershell
.\scripts\publish-github.ps1 -RepoName shine-desktop
```

That installs the GitHub CLI if needed, signs you in, creates the repo, pushes
the source, and attaches `ShineSetup.exe` to a tagged release.

---

## Notes and limits

- API keys are stored on this machine, in the same `localStorage` the website
  uses. Nothing is sent anywhere except to the AI provider you configured.
- Accounts are local to this PC. They are not synced and there is no server.
- `type_text` and `press_keys` inject keystrokes into whatever window has
  focus, so Shine should only use them right after opening the intended window.
- Provider support for tool calling varies. OpenAI-compatible, Anthropic and
  Gemini shapes are implemented natively; if a provider rejects the `tools`
  parameter, Shine retries once using a text-based protocol.
- Offline dictation needs the optional `vosk` package.
- The activity log is local only.