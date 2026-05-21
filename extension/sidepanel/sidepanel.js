// VoiceLink AI — Side Panel

const CONTEXT_PROMPT = `From now on, follow these rules for every response in this conversation. Keep every response to 1-3 sentences — your replies will be spoken aloud, not read. Be conversational, not formal; be Socratic when it adds value. Match the user's language (EN or PT) but keep technical terms in English. The user is a developer/systems engineer working with Python, C++, PostgreSQL, LXC, and Proxmox. Don't fill silence; don't recap unless resuming after a long pause. "I don't know" is a fine answer. No markdown, no bullet lists, no headings — plain prose only. Acknowledge with only the word: Ready.`;

// ── State ──────────────────────────────────────────────────────────────
let micActive = false;
let tasks = [];
let speaking = false;
let pendingSessionResolve = null;
let suppressNextSpeak = false;
let mode = 'gemini'; // 'gemini' | 'help'
let ttsVoiceURI = null;
let ttsRate = 1.05;

// ── DOM ────────────────────────────────────────────────────────────────
const statusEl   = document.getElementById('status');
const micBtn     = document.getElementById('micToggle');
const hushBtn    = document.getElementById('hushBtn');
const transcriptEl = document.getElementById('transcript');
const messagesEl = document.getElementById('messages');
const interimEl  = document.getElementById('interim');
const taskListEl = document.getElementById('taskList');
const taskInput  = document.getElementById('taskInput');
const addTaskBtn = document.getElementById('addTaskBtn');
const clearDoneBtn = document.getElementById('clearDone');
const modeGeminiBtn = document.getElementById('modeGemini');
const modeHelpBtn   = document.getElementById('modeHelp');
const voiceSelect   = document.getElementById('voiceSelect');
const rateSlider    = document.getElementById('rateSlider');
const rateValue     = document.getElementById('rateValue');

// ── Task command patterns ──────────────────────────────────────────────
// Detected locally before anything is sent to Gemini.
const TASK_CMDS = [
  {
    re: /^(?:add|track|remember(?:\s+to)?|note|don'?t\s+forget(?:\s+to)?)\s+(.+?)(?:\s+(?:to|on)\s+(?:my\s+)?(?:list|tasks?))?\.?$/i,
    action: 'add',
  },
  {
    re: /^(?:remove|delete|scratch|drop|take\s+off)\s+(.+?)(?:\s+(?:from|off)\s+(?:my\s+)?(?:list|tasks?))?\.?$/i,
    action: 'remove',
  },
  {
    re: /^(?:mark\s+)?(.+?)\s+(?:as\s+)?(?:done|complete|finished)\.?$/i,
    action: 'complete',
  },
  {
    re: /^(?:I(?:'m|\s+am)?\s+done\s+with|I\s+finished|completed?)\s+(.+?)\.?$/i,
    action: 'complete',
  },
  {
    re: /^(?:what(?:'s|\s+is)\s+on\s+(?:my\s+)?(?:list|tasks?)|(?:read|show|list)\s+(?:my\s+)?(?:list|tasks?)|what\s+am\s+I\s+tracking)\??$/i,
    action: 'list',
  },
];

function detectTaskCmd(text) {
  for (const { re, action } of TASK_CMDS) {
    const m = text.match(re);
    if (m) return { action, arg: m[1]?.trim() };
  }
  return null;
}

// ── TTS toggle commands ────────────────────────────────────────────────
const TTS_ON_RE  = /^(?:(?:turn\s+on|enable|start)\s+(?:tts|voice|speech|speaking)|speak\s+(?:responses|replies|to me)|voice\s+on|unmute)[.!?]?$/i;
const TTS_OFF_RE = /^(?:(?:turn\s+off|disable|stop)\s+(?:tts|voice|speech|speaking)|stop\s+speaking|be\s+quiet|quiet\s+mode|voice\s+off|silence(?:\s+gemini)?)[.!?]?$/i;

function detectTtsCmd(text) {
  if (TTS_ON_RE.test(text))  return 'on';
  if (TTS_OFF_RE.test(text)) return 'off';
  return null;
}

// ── Mute-me (stop the mic via voice) ───────────────────────────────────
const MUTE_ME_RE = /^(?:mute\s*(?:me|mic|microphone|myself)?|stop\s+listening|pause\s+(?:listening|the\s+mic|mic)|stop\s+the\s+mic|cala\s*-?\s*te)[.!?]?$/i;

// ── Mode switch ────────────────────────────────────────────────────────
const MODE_GEMINI_RE = /^(?:(?:switch|change|go)\s+(?:to\s+)?gemini(?:\s+mode)?|gemini\s+mode|exit\s+help)[.!?]?$/i;
const MODE_HELP_RE   = /^(?:(?:switch|change|go)\s+(?:to\s+)?(?:help|instructions?)(?:\s+mode)?|help\s+mode|instructions?\s+mode|show\s+help)[.!?]?$/i;

function detectModeCmd(text) {
  if (MODE_GEMINI_RE.test(text)) return 'gemini';
  if (MODE_HELP_RE.test(text))   return 'help';
  return null;
}

// ── Help responder ─────────────────────────────────────────────────────
// Local Q&A about the extension's commands. Used while in 'help' mode.
const HELP_TOPICS = {
  tasks:  `Tasks: say "add buy milk" to add, "remove buy milk" to remove, "mark X done" to complete, or "what's on my list" to read them out. They run instantly and don't go to Gemini.`,
  models: `Models: "switch to pro", "switch to flash", or "switch to flash lite". The verb is required so normal speech doesn't trigger it.`,
  tts:    `TTS: "enable tts" to turn voice on, "disable tts" or "be quiet" to turn it off. Pick a voice and rate in Settings above.`,
  buffer: `Buffer: speak naturally; chunks accumulate for 20 seconds of silence then send. Say "send it" or "go ahead" to flush early; "wait" or "hold on" to pause the timer; "stop" or "scratch that" to cancel.`,
  mute:   `Mute: say "mute me" or "stop listening" to turn the mic off. Click ⏺ Start in the side panel to turn it back on.`,
  modes:  `Modes: "switch to help mode" answers questions about commands locally; "switch to gemini mode" or "exit help" goes back to talking to Gemini.`,
  list:   `Categories: tasks, models, tts, buffer, mute, modes. Say "help" plus a category, e.g. "help models".`,
};

function answerHelp(text) {
  const t = text.toLowerCase();
  if (/\b(mute|stop\s+listening|pause\s+(?:mic|listening))/.test(t)) return HELP_TOPICS.mute;
  if (/\b(task|to-?do|reminder)/.test(t))                            return HELP_TOPICS.tasks;
  if (/\b(model|switch\s+to\s+(?:pro|flash))/.test(t))               return HELP_TOPICS.models;
  if (/\b(tts|voice|speech|speak)/.test(t))                          return HELP_TOPICS.tts;
  if (/\b(buffer|send|flush|hold|wait|cancel|scratch)/.test(t))      return HELP_TOPICS.buffer;
  if (/\b(mode|instructions|help\s+mode)/.test(t))                   return HELP_TOPICS.modes;
  if (/\b(what|which|list|all)\b.*\bcommand/.test(t) ||
      /^(help|commands?|what\s+can\s+i\s+say)/.test(t))              return HELP_TOPICS.list;
  return `Not sure — try "help tasks", "help models", "help tts", "help buffer", "help mute", or "help modes".`;
}

// ── Model switch commands ──────────────────────────────────────────────
// Requires a switch verb to avoid false positives ("tell me about Flash").
const MODEL_VERB_RE = /\b(switch(?:\s+to)?|change(?:\s+to)?|use|go(?:\s+to)?|set\s+(?:the\s+)?model(?:\s+to)?)\b/i;

function detectModelCmd(text) {
  const t = text.trim();
  if (!MODEL_VERB_RE.test(t)) return null;
  if (/\bflash[\s-]*lite\b|\bfastest\b|\blite\b/i.test(t)) return 'flashlite';
  if (/\bflash\b/i.test(t)) return 'flash';
  if (/\bpro\b/i.test(t)) return 'pro';
  return null;
}

// ── Storage ────────────────────────────────────────────────────────────
async function loadTasks() {
  const { tasks: stored } = await chrome.storage.local.get('tasks');
  tasks = stored || [];
  renderTasks();
}

async function saveTasks() {
  await chrome.storage.local.set({ tasks });
}

function nextId() {
  return tasks.length ? Math.max(...tasks.map(t => t.id)) + 1 : 1;
}

// ── Task operations ────────────────────────────────────────────────────
function opAdd(item) {
  tasks.push({ id: nextId(), item, done: false });
  saveTasks(); renderTasks();
  return `Added: ${item}.`;
}

function opRemove(arg) {
  const i = tasks.findIndex(t => t.item.toLowerCase().includes(arg.toLowerCase()));
  if (i === -1) return `Couldn't find "${arg}" on your list.`;
  const name = tasks.splice(i, 1)[0].item;
  saveTasks(); renderTasks();
  return `Removed: ${name}.`;
}

function opComplete(arg) {
  const t = tasks.find(t => t.item.toLowerCase().includes(arg.toLowerCase()));
  if (!t) return `Couldn't find "${arg}" on your list.`;
  t.done = true;
  saveTasks(); renderTasks();
  return `Done: ${t.item}.`;
}

function opList() {
  const active = tasks.filter(t => !t.done);
  if (!active.length) return 'Your list is empty.';
  return 'On your list: ' + active.map(t => t.item).join(', ') + '.';
}

// ── Render ─────────────────────────────────────────────────────────────
function renderTasks() {
  taskListEl.innerHTML = '';
  tasks.forEach(t => {
    const li = document.createElement('li');
    li.dataset.id = t.id;
    li.innerHTML = `
      <input type="checkbox" ${t.done ? 'checked' : ''} />
      <span class="task-text ${t.done ? 'done' : ''}">${esc(t.item)}</span>
      <button class="remove" title="Remove">×</button>
    `;
    taskListEl.appendChild(li);
  });
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function addMsg(text, type) {
  const d = document.createElement('div');
  d.className = `msg ${type}`;
  d.textContent = text;
  messagesEl.appendChild(d);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function setStatus(s) {
  statusEl.textContent = s.charAt(0).toUpperCase() + s.slice(1);
  statusEl.className = `status ${s}`;
}

// ── TTS ────────────────────────────────────────────────────────────────
// Toggled via voice command ("enable tts" / "disable tts"). Starts off.
let ttsEnabled = false;

function getSelectedVoice() {
  if (!ttsVoiceURI) return null;
  return window.speechSynthesis.getVoices().find(v => v.voiceURI === ttsVoiceURI) || null;
}

async function speak(text) {
  if (!ttsEnabled) return;
  return new Promise(resolve => {
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = ttsRate;
    const v = getSelectedVoice();
    if (v) { utt.voice = v; utt.lang = v.lang; }
    speaking = true;
    setStatus('speaking');
    utt.onend = utt.onerror = () => {
      speaking = false;
      if (micActive) setStatus('listening');
      resolve();
    };
    window.speechSynthesis.speak(utt);
  });
}

function interruptTTS() {
  if (!speaking) return;
  window.speechSynthesis.cancel();
  speaking = false;
  if (micActive) setStatus('listening');
}

function populateVoices() {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return; // wait for voiceschanged
  voiceSelect.innerHTML = '<option value="">System default</option>';
  // Group local voices first, then remote.
  const sorted = [...voices].sort((a, b) => {
    if (a.localService !== b.localService) return a.localService ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const v of sorted) {
    const opt = document.createElement('option');
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})${v.localService ? '' : ' ☁'}`;
    voiceSelect.appendChild(opt);
  }
  if (ttsVoiceURI) voiceSelect.value = ttsVoiceURI;
}

// ── STT control (recognition itself lives in content.js) ──────────────
async function sendToContent(msg) {
  const tab = await getGeminiTab();
  if (!tab) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
    return true;
  } catch (_) {
    return false;
  }
}

async function queryContent(msg) {
  const tab = await getGeminiTab();
  if (!tab) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (_) {
    return null;
  }
}

async function startRecognition() {
  const ok = await sendToContent({ type: 'START_LISTENING' });
  if (!ok) {
    addMsg('Open gemini.google.com in the active tab first.', 'system');
    return false;
  }
  setStatus('listening');
  return true;
}

async function stopRecognition() {
  micActive = false;
  clearSendTimer();
  buffer = [];
  holding = false;
  interimEl.textContent = '';
  await sendToContent({ type: 'STOP_LISTENING' });
  setStatus('idle');
}

// ── Buffer mode ────────────────────────────────────────────────────────
// Recognized chunks accumulate; we flush either after a silence window or
// on an explicit voice command.
const BUFFER_SILENCE_MS = 20000;

// Whole-utterance triggers (the chunk is ONLY the trigger).
const FLUSH_RE  = /^(?:okay,?\s*(?:send|go)|send(?:\s*it)?|go\s*ahead|that'?s\s*it|done|manda|vai|envia)[.!?]?$/i;
const HOLD_RE   = /^(?:wait|hold\s*on|let\s*me\s*think|one\s*(?:sec|second|moment)|give\s*me\s*a\s*(?:sec|second|moment)|espera|p[eé]ra|um\s*momento)[.!?]?$/i;
const CANCEL_RE = /^(?:scratch\s*that|never\s*mind|nevermind|cancel|forget\s*it|forget\s*that|stop|drop\s*it|skip\s*it|esquece|deixa)[.!?]?$/i;

// Trailing triggers (chunk ends with a trigger; preceding text is payload).
const TRAILING_FLUSH_RE  = /[\s,.;:!?-]*\b(?:okay,?\s*(?:send|go)|send(?:\s*it)?|go\s*ahead|manda|vai|envia)[.!?]?\s*$/i;
const TRAILING_HOLD_RE   = /[\s,.;:!?-]*\b(?:wait|hold\s*on|let\s*me\s*think|espera)[.!?]?\s*$/i;
const TRAILING_CANCEL_RE = /[\s,.;:!?-]*\b(?:scratch\s*that|never\s*mind|nevermind|cancel(?:\s*that)?|forget\s*(?:it|that)|drop\s*it|skip\s*it|stop|esquece|deixa)[.!?]?\s*$/i;

let buffer = [];
let sendTimer = null;
let holding = false;

function clearSendTimer() {
  if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
}

function scheduleFlush() {
  clearSendTimer();
  holding = false;
  sendTimer = setTimeout(flushBuffer, BUFFER_SILENCE_MS);
  renderBuffer();
}

function renderBuffer() {
  if (buffer.length === 0) { interimEl.textContent = ''; return; }
  const preview = buffer.join(' ');
  const label = holding ? '⏸' : (sendTimer ? '…' : '·');
  interimEl.textContent = `${label} ${preview}`;
}

async function flushBuffer() {
  clearSendTimer();
  holding = false;
  if (!buffer.length) { renderBuffer(); return; }
  const text = buffer.join(' ').trim();
  buffer = [];
  renderBuffer();
  if (!text) return;
  addMsg(text, 'user');
  if (mode === 'help') {
    // In help mode, deferred commands (task/TTS/model) get a chance to run
    // here too — we suppressed their immediate dispatch so the user has time
    // to finish their thought. Anything else is a help-topic question.
    const tts = detectTtsCmd(text);
    if (tts) {
      if (tts === 'on') {
        ttsEnabled = true;
        addMsg('TTS on.', 'task');
        await speak('Voice on.');
      } else {
        ttsEnabled = false;
        window.speechSynthesis.cancel();
        addMsg('TTS off.', 'task');
      }
      return;
    }
    const modelTarget = detectModelCmd(text);
    if (modelTarget) {
      await sendToContent({ type: 'SWITCH_MODEL', target: modelTarget });
      return;
    }
    const cmd = detectTaskCmd(text);
    if (cmd) {
      let reply;
      if (cmd.action === 'add')           reply = opAdd(cmd.arg);
      else if (cmd.action === 'remove')   reply = opRemove(cmd.arg);
      else if (cmd.action === 'complete') reply = opComplete(cmd.arg);
      else if (cmd.action === 'list')     reply = opList();
      addMsg(reply, 'task');
      await speak(reply);
      return;
    }
    const reply = answerHelp(text);
    addMsg(reply, 'task');
    await speak(reply);
  } else {
    await sendToGemini(text);
  }
}

// ── Core flow ──────────────────────────────────────────────────────────
async function handleTranscript(rawText) {
  if (speaking) return;

  const text = rawText.trim();
  if (!text) return;

  // Mute the mic (voice equivalent of clicking ⏹ Stop).
  if (MUTE_ME_RE.test(text)) {
    addMsg(text, 'user');
    addMsg('Muted. Click Start to resume.', 'task');
    micBtn.textContent = '⏺ Start';
    micBtn.classList.remove('active');
    await stopRecognition();
    return;
  }

  // Mode switch (Gemini ↔ Help) runs immediately.
  const modeTarget = detectModeCmd(text);
  if (modeTarget) {
    clearSendTimer();
    buffer = [];
    renderBuffer();
    addMsg(text, 'user');
    setMode(modeTarget);
    return;
  }

  // In help mode, deferred commands fall through to the buffer so the user
  // has time to finish their thought; flushBuffer dispatches them on flush.
  if (mode !== 'help') {

  // TTS toggle runs immediately and bypasses the buffer.
  const tts = detectTtsCmd(text);
  if (tts) {
    clearSendTimer();
    buffer = [];
    renderBuffer();
    addMsg(text, 'user');
    if (tts === 'on') {
      ttsEnabled = true;
      addMsg('TTS on.', 'task');
      await speak('Voice on.'); // first thing you hear once enabled
    } else {
      ttsEnabled = false;
      window.speechSynthesis.cancel(); // cut off anything in flight
      addMsg('TTS off.', 'task');
    }
    return;
  }

  // Model switch runs immediately and bypasses the buffer.
  const modelTarget = detectModelCmd(text);
  if (modelTarget) {
    clearSendTimer();
    buffer = [];
    renderBuffer();
    addMsg(text, 'user');
    await sendToContent({ type: 'SWITCH_MODEL', target: modelTarget });
    return;
  }

  // Task commands run immediately and bypass the buffer.
  const cmd = detectTaskCmd(text);
  if (cmd) {
    clearSendTimer();
    buffer = [];
    renderBuffer();
    addMsg(text, 'user');
    let reply;
    if (cmd.action === 'add')      reply = opAdd(cmd.arg);
    else if (cmd.action === 'remove')   reply = opRemove(cmd.arg);
    else if (cmd.action === 'complete') reply = opComplete(cmd.arg);
    else if (cmd.action === 'list')     reply = opList();
    addMsg(reply, 'task');
    await speak(reply); // no-op while TTS_ENABLED=false
    return;
  }

  } // end of: if (mode !== 'help')

  // Whole-utterance buffer commands.
  if (CANCEL_RE.test(text)) {
    if (buffer.length || sendTimer) addMsg('(buffer cleared)', 'system');
    clearSendTimer();
    buffer = [];
    holding = false;
    renderBuffer();
    return;
  }
  if (HOLD_RE.test(text)) {
    clearSendTimer();
    holding = true;
    addMsg('(holding — keep going, or say "send")', 'system');
    renderBuffer();
    return;
  }
  if (FLUSH_RE.test(text)) {
    await flushBuffer();
    return;
  }

  // Trailing-trigger parsing: e.g. "what's the weather, okay send"
  // Check cancel first — it's the natural correction pattern ("…actually no, cancel").
  const cancelMatch = text.match(TRAILING_CANCEL_RE);
  if (cancelMatch) {
    if (buffer.length || sendTimer) addMsg('(buffer cleared)', 'system');
    clearSendTimer();
    buffer = [];
    holding = false;
    renderBuffer();
    return;
  }

  let payload = text;
  let trailingFlush = false;
  let trailingHold = false;

  const flushMatch = payload.match(TRAILING_FLUSH_RE);
  if (flushMatch) {
    payload = payload.slice(0, flushMatch.index).trim();
    trailingFlush = true;
  } else {
    const holdMatch = payload.match(TRAILING_HOLD_RE);
    if (holdMatch) {
      payload = payload.slice(0, holdMatch.index).trim();
      trailingHold = true;
    }
  }

  if (payload) buffer.push(payload);

  if (trailingFlush) {
    await flushBuffer();
  } else if (trailingHold) {
    clearSendTimer();
    holding = true;
    addMsg('(holding — keep going, or say "send")', 'system');
    renderBuffer();
  } else if (!holding) {
    scheduleFlush();
  } else {
    renderBuffer(); // still holding; just show updated buffer
  }
}

async function getGeminiTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes('gemini.google.com')) return null;
  return tab;
}

async function sendToGemini(text) {
  setStatus('sending');
  const tab = await getGeminiTab();
  if (!tab) {
    addMsg('Open gemini.google.com in the active tab first.', 'system');
    setStatus('error');
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: 'SEND_TO_GEMINI', text });
}

async function initSession() {
  setStatus('sending');

  const tab = await getGeminiTab();
  if (!tab) {
    addMsg('Open gemini.google.com in the active tab first.', 'system');
    setStatus('error');
    return false;
  }

  // If the chat already has turns, don't reinject the context prompt — it
  // would land mid-conversation and Gemini would reply "Ready." into the
  // ongoing thread.
  const existing = await queryContent({ type: 'CHECK_CONVERSATION' });
  if (existing?.hasHistory) {
    addMsg('Resumed existing chat.', 'system');
    setStatus(micActive ? 'listening' : 'idle');
    return true;
  }

  addMsg('Initializing session…', 'system');
  return new Promise(resolve => {
    pendingSessionResolve = resolve;
    chrome.tabs.sendMessage(tab.id, { type: 'SEND_TO_GEMINI', text: CONTEXT_PROMPT });
  });
}

// ── Incoming messages from content script ─────────────────────────────
chrome.runtime.onMessage.addListener(async msg => {
  if (msg.type === 'TRANSCRIPT_INTERIM') {
    if (speaking) interruptTTS();
    const prefix = buffer.length ? `${buffer.join(' ')} | ` : '';
    interimEl.textContent = prefix + msg.text;
    return;
  }

  if (msg.type === 'TRANSCRIPT_FINAL') {
    if (speaking) interruptTTS();
    await handleTranscript(msg.text); // renderBuffer() runs inside
    return;
  }

  if (msg.type === 'MODEL_SWITCH_RESULT') {
    if (msg.ok) addMsg(`Switched to ${msg.name}.`, 'task');
    else addMsg(`Model switch failed: ${msg.error}`, 'system');
    return;
  }

  if (msg.type === 'STT_ERROR') {
    addMsg(`STT error: ${msg.error}`, 'system');
    if (msg.error === 'not-allowed' || msg.error === 'service-not-allowed') {
      micActive = false;
      micBtn.textContent = '⏺ Start';
      micBtn.classList.remove('active');
      setStatus('error');
    }
    return;
  }

  if (msg.type === 'GEMINI_RESPONSE') {
    if (pendingSessionResolve) {
      const resolve = pendingSessionResolve;
      pendingSessionResolve = null;
      addMsg('Session ready', 'system');
      await speak(msg.text); // speaks "Ready."
      resolve(true);
      return;
    }
    addMsg(msg.text, 'gemini');
    if (suppressNextSpeak) {
      suppressNextSpeak = false;
      setStatus(micActive ? 'listening' : 'idle');
      return;
    }
    await speak(msg.text);
  }

  if (msg.type === 'GEMINI_ERROR') {
    addMsg(`Error: ${msg.error}`, 'system');
    setStatus('error');
    if (pendingSessionResolve) { pendingSessionResolve(false); pendingSessionResolve = null; }
  }
});

// ── Mode ───────────────────────────────────────────────────────────────
function updateModeUI() {
  modeGeminiBtn.classList.toggle('active', mode === 'gemini');
  modeHelpBtn.classList.toggle('active', mode === 'help');
}

async function setMode(newMode) {
  if (newMode === mode) {
    addMsg(`Already in ${newMode} mode.`, 'system');
    return;
  }
  mode = newMode;
  updateModeUI();
  chrome.storage.local.set({ mode });

  if (mode === 'help') {
    addMsg('Help mode. Ask things like "help tasks" or "what can I say".', 'task');
    await speak('Help mode.');
    return;
  }

  addMsg('Gemini mode.', 'task');
  if (micActive) {
    const ok = await initSession();
    if (!ok) return;
  }
  await speak('Gemini mode.');
}

modeGeminiBtn.addEventListener('click', () => setMode('gemini'));
modeHelpBtn.addEventListener('click', () => setMode('help'));

// ── Settings (voice + rate) ────────────────────────────────────────────
voiceSelect.addEventListener('change', () => {
  ttsVoiceURI = voiceSelect.value || null;
  chrome.storage.local.set({ ttsVoiceURI });
});

rateSlider.addEventListener('input', () => {
  ttsRate = parseFloat(rateSlider.value);
  rateValue.textContent = ttsRate.toFixed(2);
});
rateSlider.addEventListener('change', () => {
  chrome.storage.local.set({ ttsRate });
});

// ── UI events ──────────────────────────────────────────────────────────
micBtn.addEventListener('click', async () => {
  if (micActive) {
    await stopRecognition();
    micBtn.textContent = '⏺ Start';
    micBtn.classList.remove('active');
    return;
  }

  micActive = true;
  micBtn.textContent = '⏹ Stop';
  micBtn.classList.add('active');

  // Only init the Gemini session if we'll actually be talking to it.
  // initSession() inspects the Gemini DOM and skips CONTEXT_PROMPT if the
  // chat already has turns.
  if (mode === 'gemini') {
    const ok = await initSession();
    if (!ok) {
      micActive = false;
      micBtn.textContent = '⏺ Start';
      micBtn.classList.remove('active');
      return;
    }
  }

  const started = await startRecognition();
  if (!started) {
    micActive = false;
    micBtn.textContent = '⏺ Start';
    micBtn.classList.remove('active');
  }
});

// Hush: cut off the current Gemini reply.
// - Cancels any in-flight TTS.
// - Suppresses speaking the next reply if it's still being generated.
// - Asks Gemini's tab to click its own stop-generating button (best effort).
hushBtn.addEventListener('click', async () => {
  if (speaking) interruptTTS();
  suppressNextSpeak = true;
  await sendToContent({ type: 'STOP_GENERATION' });
});

taskListEl.addEventListener('change', e => {
  if (e.target.type !== 'checkbox') return;
  const id = Number(e.target.closest('li').dataset.id);
  const t = tasks.find(t => t.id === id);
  if (t) { t.done = e.target.checked; saveTasks(); renderTasks(); }
});

taskListEl.addEventListener('click', e => {
  if (!e.target.classList.contains('remove')) return;
  const id = Number(e.target.closest('li').dataset.id);
  tasks = tasks.filter(t => t.id !== id);
  saveTasks(); renderTasks();
});

function addTaskFromInput() {
  const val = taskInput.value.trim();
  if (!val) return;
  opAdd(val);
  taskInput.value = '';
}

addTaskBtn.addEventListener('click', addTaskFromInput);
taskInput.addEventListener('keydown', e => { if (e.key === 'Enter') addTaskFromInput(); });

clearDoneBtn.addEventListener('click', () => {
  tasks = tasks.filter(t => !t.done);
  saveTasks(); renderTasks();
});

// ── Init ───────────────────────────────────────────────────────────────
loadTasks();

window.speechSynthesis.onvoiceschanged = populateVoices;
populateVoices(); // also try immediately — sometimes voices are ready already

(async () => {
  const stored = await chrome.storage.local.get(['ttsVoiceURI', 'ttsRate', 'mode']);
  if (stored.ttsVoiceURI) { ttsVoiceURI = stored.ttsVoiceURI; voiceSelect.value = ttsVoiceURI; }
  if (typeof stored.ttsRate === 'number') {
    ttsRate = stored.ttsRate;
    rateSlider.value = ttsRate;
    rateValue.textContent = ttsRate.toFixed(2);
  }
  if (stored.mode === 'help' || stored.mode === 'gemini') {
    mode = stored.mode;
    updateModeUI();
  }
})();

addMsg('Open gemini.google.com, then click Start.', 'system');
