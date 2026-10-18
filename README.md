# Shine Desktop

A Windows desktop app built from [shineai-9mr.pages.dev](https://shineai-9mr.pages.dev/).

It loads the Shine site inside a real window and adds only the things a
browser tab cannot do well it can accounts tho lol:

- **Control PC** - ask Shine to operate your computer, approving every action
- **Accounts** - local sign up / sign in, with a profile picture the AI knows.

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
