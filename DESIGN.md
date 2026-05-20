# VoiceLink AI — Design

Hands-free voice chat with Gemini while multitasking. Single-user, desktop Chrome.

## Architecture (current: `extension` branch)

```
Mic
 │  Web Speech API (STT, browser-native)
 ▼
Side Panel (extension page)
 │  detects task commands locally
 │  sends non-task speech via chrome.tabs.sendMessage
 ▼
Content Script (injected into gemini.google.com)
 │  types text into Gemini's input, clicks Send
 │  MutationObserver watches for response to finish
 │  sends response back via chrome.runtime.sendMessage
 ▼
Side Panel
 │  Web Speech API (TTS, browser-native)
 ▼
Speaker
```

No API key. No server. Uses the user's logged-in Gemini session (Pro subscription).  
Task list persists in `chrome.storage.local`.

## Why not the Live API?

The Gemini Live API only supports Flash-tier models (no Pro). Switching to website + extension allows use of whatever model the Pro subscription provides, with no session-duration billing limits.

## Extension file layout

```
extension/
├── manifest.json          — MV3, targets gemini.google.com
├── background.js          — opens side panel on icon click
├── content.js             — DOM interaction with Gemini
└── sidepanel/
    ├── sidepanel.html
    ├── sidepanel.css      — dark terminal theme
    └── sidepanel.js       — STT, TTS, task logic, Gemini messaging
```

## Session initialization

On first mic activation, the extension sends `CONTEXT_PROMPT` to Gemini before any user speech. Gemini acknowledges with "Ready." Subsequent messages are the user's transcribed speech, sent as-is.

## Task management

Task commands are detected locally via regex **before** sending to Gemini — no round trip needed for simple operations. Supported patterns:

| Voice | Action |
|---|---|
| "add X to my list" / "remember X" | add |
| "remove X" / "delete X" | remove |
| "mark X done" / "I finished X" | complete |
| "what's on my list" | list (spoken) |

Tasks stored in `chrome.storage.local` as `[{ id, item, done }]`.  
Manual ✓ / × buttons in the side panel as fallback.

## DOM selectors (content.js)

Gemini's UI can change. If the extension stops working, update `SELECTORS` at the top of `content.js`. Current targets:
- Input: `div.ql-editor[contenteditable="true"]` with fallbacks
- Send: `button[aria-label="Send message"]` with fallbacks
- Response: `model-response` elements

## UI

Chrome side panel (persistent alongside the Gemini tab):
- Header: status indicator + Start/Stop mic button
- Transcript pane: scrolling user ▶ / Gemini ◆ turns, live interim text
- Tasks pane: checklist with manual add/remove, "Clear done"

## Out of scope for MVP

- Cross-session conversation history
- Language toggle (Web Speech API handles EN/PT reasonably well with `lang="en-US"`)
- TTS voice picker
- Firefox support (uses Chrome side panel API)

---

## Previous architecture (archived, `main` branch)

The original design used the Gemini Live API with a Node.js proxy in an LXC container. Replaced because: Live API is Flash-only, tight session limits, requires an API key and a server. See `main` branch for that code.
