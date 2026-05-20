import { createAudioPipeline } from './audio.js';

// --- config -----------------------------------------------------------
// Change PROXY_HOST to your LXC's LAN IP if the proxy isn't on this host.
// Leave as 'auto' to use the same host the page is served from (works for same-machine setups).
const PROXY_HOST = 'auto'; // e.g. '192.168.1.42'
const PROXY_PORT = 8081;

const proxyHost = PROXY_HOST === 'auto' ? (location.hostname || 'localhost') : PROXY_HOST;
const PROXY_URL = `ws://${proxyHost}:${PROXY_PORT}`;

// --- elements ---------------------------------------------------------
const $ = (id) => document.getElementById(id);
const statusDot = $('status-dot');
const statusText = $('status-text');
const micToggle = $('mic-toggle');
const tasksToggle = $('tasks-toggle');
const taskSidebar = $('task-sidebar');
const transcriptEl = $('transcript');
const markdownEl = $('markdown');
const taskListEl = $('task-list');
const taskCountEl = $('task-count');

// --- state ------------------------------------------------------------
let ws = null;
let audio = null;
let sessionActive = false;
let currentTurn = null;
let lastSpeaker = null;
let speakingTimer = null;

// --- ui helpers -------------------------------------------------------

function setStatus(state, label) {
  statusDot.className = `dot ${state}`;
  statusText.textContent = label;
}

function appendTurnText(speaker, text) {
  if (lastSpeaker !== speaker) {
    currentTurn = document.createElement('div');
    currentTurn.className = `turn ${speaker}`;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = speaker === 'user' ? 'you' : 'ai';
    const t = document.createElement('span');
    t.className = 'text';
    currentTurn.appendChild(who);
    currentTurn.appendChild(t);
    transcriptEl.appendChild(currentTurn);
    lastSpeaker = speaker;
  }
  currentTurn.querySelector('.text').textContent += text;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function renderTasks(tasks) {
  taskListEl.innerHTML = '';
  taskCountEl.textContent = tasks.length ? `${tasks.length}` : '';

  if (!tasks.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '(no tasks)';
    taskListEl.appendChild(empty);
    return;
  }

  for (const t of tasks) {
    const li = document.createElement('li');
    if (t.completed) li.classList.add('completed');

    const id = document.createElement('span');
    id.className = 'id';
    id.textContent = `#${t.id}`;

    const item = document.createElement('span');
    item.className = 'item';
    item.textContent = t.item;

    const check = document.createElement('button');
    check.className = 'check';
    check.textContent = t.completed ? '↶' : '✓';
    check.title = t.completed ? 'mark incomplete' : 'mark complete';
    check.onclick = () => sendMessage({ type: 'complete_task_manual', task_id: t.id });

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = '✕';
    remove.title = 'remove';
    remove.onclick = () => sendMessage({ type: 'remove_task_manual', task_id: t.id });

    li.appendChild(id);
    li.appendChild(item);
    li.appendChild(check);
    li.appendChild(remove);
    taskListEl.appendChild(li);
  }
}

function sendMessage(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// --- session ----------------------------------------------------------

async function startSession() {
  if (sessionActive) return;
  setStatus('connecting', 'connecting...');
  micToggle.disabled = true;

  ws = new WebSocket(PROXY_URL);

  ws.addEventListener('open', () => {
    sendMessage({ type: 'start_session' });
  });

  ws.addEventListener('message', async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    await handleProxyMessage(msg);
  });

  ws.addEventListener('close', () => {
    if (sessionActive) stopSession();
    micToggle.disabled = false;
  });

  ws.addEventListener('error', () => {
    setStatus('error', 'connection error');
    micToggle.disabled = false;
  });
}

async function handleProxyMessage(msg) {
  switch (msg.type) {
    case 'session_ready':
      sessionActive = true;
      micToggle.disabled = false;
      micToggle.textContent = 'Stop session';
      micToggle.classList.remove('primary');
      micToggle.classList.add('active');

      try {
        audio = await createAudioPipeline({
          onMicChunk: (base64) => sendMessage({ type: 'audio', data: base64 })
        });
        setStatus('listening', 'listening');
      } catch (err) {
        setStatus('error', `mic: ${err.message}`);
        stopSession();
      }
      break;

    case 'audio':
      setStatus('speaking', 'speaking');
      audio?.playChunk(msg.data);
      clearTimeout(speakingTimer);
      speakingTimer = setTimeout(() => setStatus('listening', 'listening'), 800);
      break;

    case 'input_transcript':
      appendTurnText('user', msg.text);
      break;

    case 'output_transcript':
      appendTurnText('model', msg.text);
      break;

    case 'render_markdown':
      markdownEl.innerHTML = marked.parse(msg.content);
      markdownEl.scrollTop = 0;
      break;

    case 'tasks_update':
      renderTasks(msg.tasks);
      break;

    case 'turn_complete':
      clearTimeout(speakingTimer);
      setStatus('listening', 'listening');
      break;

    case 'interrupted':
      audio?.stopPlayback();
      clearTimeout(speakingTimer);
      setStatus('listening', 'listening');
      break;

    case 'session_closed':
      stopSession();
      break;

    case 'error':
      setStatus('error', msg.message || 'error');
      break;
  }
}

function stopSession() {
  if (audio) {
    audio.stop();
    audio = null;
  }
  if (ws) {
    if (ws.readyState === WebSocket.OPEN) {
      sendMessage({ type: 'end_session' });
      ws.close();
    }
    ws = null;
  }
  sessionActive = false;
  setStatus('idle', 'idle');
  micToggle.textContent = 'Start session';
  micToggle.classList.add('primary');
  micToggle.classList.remove('active');
  lastSpeaker = null;
  currentTurn = null;
}

micToggle.addEventListener('click', () => {
  if (sessionActive) stopSession();
  else startSession();
});

tasksToggle.addEventListener('click', () => {
  taskSidebar.classList.toggle('collapsed');
});

setStatus('idle', 'idle');
