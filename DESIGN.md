# voicelink-ai — Design

Personal hands-free voice app for conversing with Gemini while multitasking on a primary monitor. Single-user, desktop-only.

## Architecture

```
[browser on workstation]
        |
        v  http://localhost:PORT
[vanilla JS frontend (served from workstation)]
        |
        v  ws://lxc-ip:PORT
[Node.js proxy in LXC on Proxmox]
        |
        v  wss://generativelanguage.googleapis.com/.../BidiGenerateContent
[Gemini Live API]
```

The proxy holds the Gemini API key, pipes messages between the browser and the Live API WebSocket, and manages task-list persistence. The frontend is served from the workstation as `http://localhost` so `getUserMedia` works without HTTPS (localhost is exempted by the browser).

No HTTPS, no auth, no remote access — LAN-local only.

## Tech stack

- **Backend**: Node.js + `ws` library (raw WebSocket; no SDK needed since the proxy mostly passes data through)
- **Frontend**: vanilla HTML/CSS/JS + `marked` for markdown rendering
- **Model**: `gemini-3.1-flash-live-preview` (alt: `gemini-live-2.5-flash-native-audio` for GA stable)

## Gemini Live API session config

```js
{
  responseModalities: [Modality.AUDIO],   // ONLY one modality per session is allowed
  inputAudioTranscription: {},            // populates the transcript pane (user side)
  outputAudioTranscription: {},           // populates the transcript pane (model side)
  systemInstruction: { parts: [{ text: SYSTEM_PROMPT_WITH_TASKS_INJECTED }] },
  tools: [{ functionDeclarations: [...] }] // see below
}
```

Audio formats: input = 16-bit PCM @ 16 kHz, output = 16-bit PCM @ 24 kHz (Live API defaults).

## Tool schemas

```js
const functionDeclarations = [
  {
    name: "render_detailed_markdown",
    description: "Post a detailed markdown block to the user's screen. Use only when the user asks for a written explanation, code, list, table, or structured comparison.",
    parameters: { type: "object", required: ["content"], properties: {
      content: { type: "string", description: "Full markdown content to render." }
    }}
  },
  {
    name: "add_task",
    description: "Add a task to the user's persistent task list. Use only when the user explicitly asks to track / remember / add something.",
    parameters: { type: "object", required: ["item"], properties: {
      item: { type: "string", description: "Concise task description, no fluff." }
    }}
  },
  {
    name: "remove_task",
    description: "Remove a task from the user's list by ID.",
    parameters: { type: "object", required: ["task_id"], properties: {
      task_id: { type: "number", description: "Integer ID of the task to remove." }
    }}
  },
  {
    name: "complete_task",
    description: "Mark a task complete by ID. The UI shows it as strikethrough.",
    parameters: { type: "object", required: ["task_id"], properties: {
      task_id: { type: "number", description: "Integer ID of the task to mark complete." }
    }}
  },
  {
    name: "list_tasks",
    description: "Return the current task list. Useful for refreshing context or reading items aloud.",
    parameters: { type: "object", properties: {} }
  }
];
```

Every task-tool response from the proxy includes the updated full task list so the model's view stays in sync. Tasks use stable integer IDs assigned monotonically by the proxy.

## System prompt

Stored as an editable file at `proxy/system-prompt.md`. Current contents:

```
You are Voice Link — a hands-free conversational thinking partner running on a secondary monitor while the user works on their primary monitor.

# Core style
- Speak briefly. Cap spoken responses at 1–3 sentences. The user is listening, not reading transcripts.
- Be Socratic: ask comprehension questions, surface assumptions, propose framings.
- After complex points, check understanding ("Make sense?" / "Want me to break that down?").
- Don't lecture; don't recap unless re-engaging after a silence.

# When to use the render_detailed_markdown tool
Call ONLY when the user explicitly asks for:
- a written explanation, summary, or breakdown
- code (any language)
- a list, table, or structured comparison
- "show me" / "post the" / "write it up" type requests

When you call it:
1. Speak a brief 1-sentence audio intro ("Posting the breakdown.")
2. Pass the full markdown content as the `content` argument.
Do NOT use the tool for normal conversational turns.

# Task tracking
Your current task list (with IDs) is shown below. Use the task tools when the user asks:

ADD: "add X to my list", "remember I need to...", "track this", "keep track of..." → call `add_task(item)` with a concise description (no fluff). Confirm briefly: "Added." / "Tracking that."

LIST: "what's on my list?", "what am I tracking?" → speak the items concisely from your current context (drop IDs when speaking). Use `list_tasks()` if you need to refresh.

REMOVE: "remove X", "delete X", "scratch X", "take X off" → identify the matching task ID, call `remove_task(id)`. Confirm: "Removed."

COMPLETE: "I finished X", "done with X", "mark X done", "I'm through with X" → identify the ID, call `complete_task(id)`. Confirm: "Marked done."

If multiple tasks match the user's reference, briefly ask which one before calling the tool. Don't add tasks unsolicited.

# Language
The user is bilingual EN/PT. Match the language they speak. Keep technical terms in English even when speaking Portuguese ("WebSocket", not "tomada web"; "container", not "contêiner").

# Domain context
The user is a developer/systems engineer working with Python, C++, PL/pgSQL queries, LXC containers, Proxmox, and general dev/infra work. When debugging or designing, dig into specifics — don't give generic advice.

# Re-engagement
The user multitasks heavily. If they return after silence, briefly recap where you left off before continuing.

# General
- "I don't know" / "let me think" are fine answers.
- Don't fill silence — wait for them to speak.
- Don't repeat questions back before answering — just answer.

CURRENT TASKS:
<injected at session start as JSON list of {id, item, completed}>
```

## Persistence

- **Task list**: JSON file at `proxy/data/tasks.json`. Atomic writes via write-to-temp-then-rename. Loaded into the system prompt at session start. Tool calls update the file and return the updated list to the model.
- **Conversation history**: in-session only (the live transcript pane). No cross-session persistence in MVP — defer until needed.

## UI

- **Layout**: two columns + collapsible right sidebar (Gemini's pick, justified by avoiding horizontal squash on the wide markdown pane when rendering PL/pgSQL or code)
  - **Left**: live transcript pane (scrolling; user + model speech from the transcription flags)
  - **Center**: markdown render pane (latest `render_detailed_markdown` content)
  - **Right (collapsible)**: task sidebar. Each task: checkbox (complete → strikethrough), X (remove). Collapses to a thin tab when not needed.
- **Top bar**: status indicator (idle / listening / model speaking / model thinking), mic toggle.
- **Theme**: dark, terminal-inspired.
- **Lifecycle**: always-listening with Gemini's server-side VAD. Spacebar push-to-talk as fallback if echo becomes a problem.

## File layout

```
voicelink-ai/
├── README.md                  # run instructions
├── DESIGN.md                  # this file
├── proxy/
│   ├── package.json
│   ├── server.js              # WebSocket proxy + tool-call handler + task persistence
│   ├── system-prompt.md       # system prompt as a separate editable file
│   └── data/
│       └── tasks.json         # persistent task list
└── frontend/
    ├── index.html
    ├── styles.css
    ├── app.js                 # WebSocket, state, UI wiring
    └── audio.js               # mic capture (PCM 16 kHz in) + playback queue (PCM 24 kHz out)
```

## Voice / lifecycle defaults

- **VAD**: server-side (Live API default). Hands-free always-on.
- **PTT fallback**: spacebar hold (added later if echo issues surface in testing).
- **Voice**: SDK default. Voice picker deferred.
- **Session control**: manual UI button to start/stop. Only acceptable non-voice control during normal use.
- **Languages**: EN + PT, model selects automatically based on user speech.

## Out of scope for MVP

- Cross-session conversation history (deferred — flat-file log if needed later)
- Voice-driven session management
- Voice picker
- Mobile / remote access (Tailscale, HTTPS)
- Multi-user / auth
- WebRTC frameworks (Pipecat, LiveKit) — only add if browser AEC proves insufficient

## Verification facts that shaped this design

- Live API allows only ONE `responseModalities` value per session (AUDIO or TEXT, never both) — confirmed in Google's official docs. This forces the function-calling workaround for "speak short + show long markdown".
- `gemini-3.1-flash-live-preview` is the current SDK example model name.
- Live API supports `inputAudioTranscription` and `outputAudioTranscription` config flags for live transcripts.
- Live API supports function calling natively with the same `tools` shape as regular Gemini.
- `getUserMedia` permits mic access on `http://localhost` without HTTPS.
