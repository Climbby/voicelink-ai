# voicelink-ai

Personal hands-free voice app for talking to Gemini while you work on another monitor. Single-user, desktop-only.

See `DESIGN.md` for the full design doc.

## Setup

### 1. Proxy (runs in your LXC container on Proxmox)

In the LXC container with Node.js (≥18):

```bash
cd proxy
npm install
cp .env.example .env
# edit .env, set GEMINI_API_KEY
node --env-file=.env server.js
```

Default port: `8081` (set `PORT` in `.env` to change). The proxy holds the Gemini API key, opens a WebSocket to the Live API per browser session, and persists the task list at `proxy/data/tasks.json`.

### 2. Frontend (runs on your workstation)

Any static server works. `getUserMedia` requires HTTPS *or* `localhost` — serving from your workstation as localhost satisfies that without certs.

```bash
# Python
cd frontend
python3 -m http.server 3000

# or Node
npx serve frontend -p 3000
```

Open `http://localhost:3000`.

If the proxy is on a different machine (the typical LXC case), edit `PROXY_HOST` near the top of `frontend/app.js`:

```js
const PROXY_HOST = '192.168.1.42'; // your LXC's LAN IP
```

### 3. Use it

1. Click **Start session**, grant mic permission.
2. Just talk — Gemini responds via voice.
3. When you want depth: *"show me the breakdown"*, *"post the code"* — Gemini renders markdown in the center pane.
4. To track things: *"add X to my list"*, *"remember I need to Y"* — they appear in the right sidebar.
5. Voice-clear too: *"remove X"*, *"I finished Y"*. Manual ✓ / ✕ buttons work as fallback.

## Files

```
voicelink-ai/
├── DESIGN.md
├── README.md
├── proxy/
│   ├── package.json
│   ├── server.js
│   ├── system-prompt.md       # edit to tune behavior, restart proxy
│   ├── .env.example
│   └── data/tasks.json        # auto-created on first add
└── frontend/
    ├── index.html
    ├── styles.css
    ├── app.js
    └── audio.js               # mic capture + playback queue
```

## Tuning

- **System prompt**: edit `proxy/system-prompt.md`, restart the proxy.
- **Model**: set `GEMINI_MODEL=gemini-live-2.5-flash-native-audio` (GA) in `.env` if the preview model misbehaves.
- **Echo/feedback**: use headphones. Browser AEC is on by default.
- **PCM resampling**: `frontend/audio.js` does naive decimation — fine for voice. If audio quality is poor on a 44.1 kHz device, switch to a proper resampler.
