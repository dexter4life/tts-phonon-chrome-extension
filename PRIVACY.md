# Privacy Policy — Phonon Reader

Last updated: October 27, 2026

Phonon Reader is a browser extension that reads web pages aloud using a
text-to-speech model running on **your own computer** via your local
[Ollama](https://ollama.com) server.

## What the extension accesses

- **Web page content** of the page you choose to read. Text is extracted only
  when you click "Read page", "Read selection", or use the context-menu entry.
- **Your text selection**, when you explicitly ask to read a selection.

## Where your data goes

- Extracted page text is sent **only to the Ollama server running on your own
  machine** (`http://localhost:11434` by default) to generate speech audio.
- The extension has **no other network endpoints**. It does not contain
  analytics, telemetry, ads, or tracking of any kind.
- **No data is transmitted to the extension's developer or any third party.**

## What is stored

- Session state (playback phase, chunk progress) is kept in
  `chrome.storage.session`, which is cleared when the browser closes.
- Nothing is written to disk, and no browsing history is collected.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab`, `scripting` | Extract text from the page you ask to read, and show the playback widget |
| `tabs` | Find the web page tab to read when the popup or context menu is used |
| `host_permissions` (http/https) | Read pages on any site you choose; the extension is not limited to specific sites |
| `offscreen` | Play generated audio (service workers cannot play audio) |
| `contextMenus` | Add the "Read selection aloud" right-click entry |
| `storage` | Remember the current playback session state |

## Contact

Open an issue at https://github.com/dexter4life/tts-phonon-chrome-extension