// VoiceLink AI — Side Panel

const CONTEXT_PROMPT = `You are Voice Link — a hands-free voice assistant running as a browser extension. A content script types the user's transcribed speech into this chat and reads your responses aloud via TTS.

Rules:
- Keep every response to 1–3 sentences. The user is listening, not reading.
- Be conversational, not formal. Be Socratic when it adds value.
- Match the user's language (EN or PT). Keep technical terms in English.
- The user is a developer/systems engineer: Python, C++, PostgreSQL, LXC, Proxmox.
- Don't fill silence. Don't recap unless resuming after a long pause.
- "I don't know" is a fine answer.

Acknowledge this setup with only the word: Ready.`;

// ── State ──────────────────────────────────────────────────────────────
let micActive = false;
let sessionReady = false;
let tasks = [];
let recognition = null;
let speaking = false;
let pendingSessionResolve = null;

// ── DOM ────────────────────────────────────────────────────────────────
const statusEl   = document.getElementById('status');
const micBtn     = document.getElementById('micToggle');
const messagesEl = document.getElementById('messages');
const interimEl  = document.getElementById('interim');
const taskListEl = document.getElementById('taskList');
const taskInput  = document.getElementById('taskInput');
const addTaskBtn = document.getElementById('addTaskBtn');
const clearDoneBtn = document.getElementById('clearDone');

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
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setStatus(s) {
  statusEl.textContent = s.charAt(0).toUpperCase() + s.slice(1);
  statusEl.className = `status ${s}`;
}

// ── TTS ────────────────────────────────────────────────────────────────
function speak(text) {
  return new Promise(resolve => {
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = 1.05;
    speaking = true;
    setStatus('speaking');
    utt.onend = utt.onerror = () => { speaking = false; resolve(); };
    window.speechSynthesis.speak(utt);
  });
}

// ── STT ────────────────────────────────────────────────────────────────
function startRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { addMsg('SpeechRecognition not supported.', 'system'); return; }

  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US'; // handles PT input in practice

  recognition.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        const t = e.results[i][0].transcript.trim();
        if (t) handleTranscript(t);
        interimEl.textContent = '';
      } else {
        interim += e.results[i][0].transcript;
      }
    }
    interimEl.textContent = interim;
  };

  recognition.onerror = e => {
    if (e.error === 'no-speech') return;
    addMsg(`STT error: ${e.error}`, 'system');
  };

  recognition.onend = () => {
    if (micActive) recognition.start(); // auto-restart
  };

  recognition.start();
  setStatus('listening');
}

function stopRecognition() {
  micActive = false;
  if (recognition) { recognition.stop(); recognition = null; }
  setStatus('idle');
}

// ── Core flow ──────────────────────────────────────────────────────────
async function handleTranscript(text) {
  if (speaking) return; // don't process while TTS is playing

  const cmd = detectTaskCmd(text);
  if (cmd) {
    addMsg(text, 'user');
    let reply;
    if (cmd.action === 'add')      reply = opAdd(cmd.arg);
    else if (cmd.action === 'remove')   reply = opRemove(cmd.arg);
    else if (cmd.action === 'complete') reply = opComplete(cmd.arg);
    else if (cmd.action === 'list')     reply = opList();
    addMsg(reply, 'task');
    await speak(reply);
    setStatus('listening');
    return;
  }

  addMsg(text, 'user');
  await sendToGemini(text);
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
  addMsg('Initializing session…', 'system');

  const tab = await getGeminiTab();
  if (!tab) {
    addMsg('Open gemini.google.com in the active tab first.', 'system');
    setStatus('error');
    return false;
  }

  return new Promise(resolve => {
    pendingSessionResolve = resolve;
    chrome.tabs.sendMessage(tab.id, { type: 'SEND_TO_GEMINI', text: CONTEXT_PROMPT });
  });
}

// ── Incoming messages from content script ─────────────────────────────
chrome.runtime.onMessage.addListener(async msg => {
  if (msg.type === 'GEMINI_RESPONSE') {
    if (pendingSessionResolve) {
      // This is the context-acknowledgement response
      const resolve = pendingSessionResolve;
      pendingSessionResolve = null;
      sessionReady = true;
      addMsg('Session ready', 'system');
      await speak(msg.text); // speaks "Ready."
      setStatus('listening');
      resolve(true);
      return;
    }
    addMsg(msg.text, 'gemini');
    await speak(msg.text);
    setStatus('listening');
  }

  if (msg.type === 'GEMINI_ERROR') {
    addMsg(`Error: ${msg.error}`, 'system');
    setStatus('error');
    if (pendingSessionResolve) { pendingSessionResolve(false); pendingSessionResolve = null; }
  }
});

// ── UI events ──────────────────────────────────────────────────────────
micBtn.addEventListener('click', async () => {
  if (micActive) {
    stopRecognition();
    micBtn.textContent = '⏺ Start';
    micBtn.classList.remove('active');
    return;
  }

  micActive = true;
  micBtn.textContent = '⏹ Stop';
  micBtn.classList.add('active');

  if (!sessionReady) {
    const ok = await initSession();
    if (!ok) {
      micActive = false;
      micBtn.textContent = '⏺ Start';
      micBtn.classList.remove('active');
      return;
    }
  }

  startRecognition();
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
addMsg('Open gemini.google.com, then click Start.', 'system');
