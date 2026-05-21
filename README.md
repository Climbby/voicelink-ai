# voicelink-ai

Hands-free voice chat with Gemini while you work on another monitor. A Chrome MV3 extension that drives `gemini.google.com` via voice — no API key, no server, uses your logged-in Pro session.

See `DESIGN.md` for the architecture.

## Requirements

- Chrome (or any Chromium-based browser with the Side Panel API + Web Speech API)
- A signed-in Gemini account at https://gemini.google.com

## Install

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` directory.
3. Open a Gemini tab (`https://gemini.google.com/app`) and click the VoiceLink AI icon to open the side panel.

## Use it

1. Click **⏺ Start** in the side panel and grant mic permission.
2. Just talk. Speech accumulates in a 20s buffer (so you can pause to think) then sends to Gemini. Replies are spoken back via the browser's TTS.
3. Say **"send it"** / **"go ahead"** to flush early, **"wait"** / **"hold on"** to pause the timer, **"scratch that"** to cancel.

### Voice commands

| Say | Effect |
|---|---|
| `add X to my list` / `remember X` | Add a local task |
| `remove X` / `delete X` | Remove a task |
| `mark X done` / `I finished X` | Complete a task |
| `what's on my list` | Read tasks aloud |
| `switch to pro` / `switch to flash` / `switch to flash lite` | Change Gemini model |
| `enable tts` / `disable tts` / `be quiet` | Toggle voice output |
| `mute me` / `stop listening` | Stop the mic |
| `switch to help mode` / `exit help` | Toggle the local help responder |

Tasks are stored in `chrome.storage.local`; manual ✓ / ✕ buttons in the side panel act as a fallback. In **help mode** commands answer locally and don't go to Gemini; commands are buffered for 20s so you have time to finish a thought.

## Tuning

- **Voice & rate**: pick from the Settings dropdown in the side panel header.
- **DOM selectors**: Gemini's markup changes occasionally. If sending or response capture breaks, update `SELECTORS` at the top of `extension/content.js`.
- **Context prompt**: edit `CONTEXT_PROMPT` at the top of `extension/sidepanel/sidepanel.js` to tune Gemini's response style (terse, plain prose, EN/PT, etc.).

## Layout

```
voicelink-ai/
├── DESIGN.md
├── README.md
└── extension/
    ├── manifest.json
    ├── background.js          — opens the side panel on icon click
    ├── content.js             — types into Gemini, watches for replies
    ├── icons/
    └── sidepanel/
        ├── sidepanel.html
        ├── sidepanel.css
        └── sidepanel.js       — STT, TTS, buffer, task & command logic
```

The earlier Live-API + Node-proxy design lives on the `main` branch; see the bottom of `DESIGN.md` for why it was replaced.
