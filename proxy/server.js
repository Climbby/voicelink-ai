import WebSocket, { WebSocketServer } from 'ws';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || '8081', 10);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-live-preview';
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const SYSTEM_PROMPT_PATH = path.join(__dirname, 'system-prompt.md');
const TASKS_PATH = path.join(__dirname, 'data', 'tasks.json');

if (!GEMINI_API_KEY) {
  console.error('error: GEMINI_API_KEY environment variable is required');
  process.exit(1);
}

// ---------- task persistence ----------

async function loadTasks() {
  try {
    const raw = await fs.readFile(TASKS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return { nextId: 1, tasks: [] };
    throw err;
  }
}

async function saveTasks(state) {
  await fs.mkdir(path.dirname(TASKS_PATH), { recursive: true });
  const tmp = TASKS_PATH + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, TASKS_PATH);
}

// ---------- system prompt ----------

async function buildSystemPrompt(tasks) {
  const base = await fs.readFile(SYSTEM_PROMPT_PATH, 'utf8');
  const tasksJson = tasks.length ? JSON.stringify(tasks, null, 2) : '(no tasks tracked yet)';
  return base.replace('{TASKS_JSON}', tasksJson);
}

// ---------- tool schemas ----------

const TOOLS = [{
  functionDeclarations: [
    {
      name: 'render_detailed_markdown',
      description: "Post a detailed markdown block to the user's screen. Use only when the user asks for a written explanation, code, list, table, or structured comparison.",
      parameters: {
        type: 'OBJECT',
        required: ['content'],
        properties: { content: { type: 'STRING', description: 'Full markdown content to render.' } }
      }
    },
    {
      name: 'add_task',
      description: "Add a task to the user's persistent task list. Use only when the user explicitly asks to track / remember / add something.",
      parameters: {
        type: 'OBJECT',
        required: ['item'],
        properties: { item: { type: 'STRING', description: 'Concise task description, no fluff.' } }
      }
    },
    {
      name: 'remove_task',
      description: "Remove a task from the user's list by ID.",
      parameters: {
        type: 'OBJECT',
        required: ['task_id'],
        properties: { task_id: { type: 'NUMBER', description: 'Integer ID of the task to remove.' } }
      }
    },
    {
      name: 'complete_task',
      description: "Mark a task complete by ID. UI shows it as strikethrough.",
      parameters: {
        type: 'OBJECT',
        required: ['task_id'],
        properties: { task_id: { type: 'NUMBER', description: 'Integer ID of the task to mark complete.' } }
      }
    },
    {
      name: 'list_tasks',
      description: 'Return the current task list. Useful for refreshing context or reading items aloud.',
      parameters: { type: 'OBJECT', properties: {} }
    }
  ]
}];

// ---------- tool handlers ----------

async function handleToolCall(state, name, args) {
  switch (name) {
    case 'render_detailed_markdown':
      return {
        ui: { type: 'render_markdown', content: args.content },
        toolResult: { ok: true }
      };
    case 'add_task': {
      const id = state.nextId++;
      state.tasks.push({ id, item: args.item, completed: false });
      await saveTasks(state);
      return {
        ui: { type: 'tasks_update', tasks: state.tasks },
        toolResult: { ok: true, id, tasks: state.tasks }
      };
    }
    case 'remove_task': {
      const before = state.tasks.length;
      state.tasks = state.tasks.filter(t => t.id !== args.task_id);
      if (state.tasks.length === before) {
        return { toolResult: { ok: false, error: `no task with id ${args.task_id}` } };
      }
      await saveTasks(state);
      return {
        ui: { type: 'tasks_update', tasks: state.tasks },
        toolResult: { ok: true, tasks: state.tasks }
      };
    }
    case 'complete_task': {
      const t = state.tasks.find(t => t.id === args.task_id);
      if (!t) return { toolResult: { ok: false, error: `no task with id ${args.task_id}` } };
      t.completed = true;
      await saveTasks(state);
      return {
        ui: { type: 'tasks_update', tasks: state.tasks },
        toolResult: { ok: true, tasks: state.tasks }
      };
    }
    case 'list_tasks':
      return { toolResult: { ok: true, tasks: state.tasks } };
    default:
      return { toolResult: { ok: false, error: `unknown tool ${name}` } };
  }
}

// ---------- WebSocket server ----------

// Load task state once at startup. Single-user app, so a shared in-memory
// reference is fine and avoids a per-connection `await` that races against
// the first browser message arriving before the handler is registered.
const state = await loadTasks();

const wss = new WebSocketServer({ port: PORT, host: '0.0.0.0' });
console.log(`voicelink-ai proxy listening on ws://0.0.0.0:${PORT}`);
console.log(`model: ${MODEL}`);

wss.on('connection', (browser, req) => {
  const addr = req.socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] browser connected from ${addr}`);

  let geminiWs = null;

  const sendBrowser = (obj) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(obj));
  };

  const closeGemini = () => {
    if (geminiWs) {
      try { geminiWs.close(); } catch {}
      geminiWs = null;
    }
  };

  browser.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch {
      console.log('  ?? unparseable browser msg:', raw.toString().slice(0, 100));
      return;
    }

    if (msg.type === 'start_session') {
      if (geminiWs) closeGemini();

      const systemPrompt = await buildSystemPrompt(state.tasks);
      geminiWs = new WebSocket(GEMINI_URL);

      geminiWs.on('open', () => {
        const setup = {
          setup: {
            model: `models/${MODEL}`,
            generationConfig: { responseModalities: ['AUDIO'] },
            systemInstruction: { parts: [{ text: systemPrompt }] },
            tools: TOOLS,
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          }
        };
        geminiWs.send(JSON.stringify(setup));
      });

      geminiWs.on('message', async (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch { return; }

        if (m.setupComplete) {
          sendBrowser({ type: 'session_ready' });
          sendBrowser({ type: 'tasks_update', tasks: state.tasks });
          return;
        }

        if (m.toolCall) {
          const responses = [];
          for (const call of m.toolCall.functionCalls || []) {
            const result = await handleToolCall(state, call.name, call.args || {});
            if (result.ui) sendBrowser(result.ui);
            responses.push({ id: call.id, name: call.name, response: result.toolResult });
          }
          if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
          }
          return;
        }

        if (m.serverContent) {
          const sc = m.serverContent;

          if (sc.modelTurn?.parts) {
            for (const part of sc.modelTurn.parts) {
              if (part.inlineData && part.inlineData.mimeType?.startsWith('audio/')) {
                sendBrowser({
                  type: 'audio',
                  mimeType: part.inlineData.mimeType,
                  data: part.inlineData.data,
                });
              }
            }
          }

          if (sc.inputTranscription?.text) {
            sendBrowser({ type: 'input_transcript', text: sc.inputTranscription.text });
          }
          if (sc.outputTranscription?.text) {
            sendBrowser({ type: 'output_transcript', text: sc.outputTranscription.text });
          }
          if (sc.interrupted) sendBrowser({ type: 'interrupted' });
          if (sc.turnComplete) sendBrowser({ type: 'turn_complete' });
        }
      });

      geminiWs.on('close', (code, reason) => {
        const reasonStr = reason?.toString() || '(no reason)';
        console.log(`  -- gemini ws closed: code=${code} reason="${reasonStr}"`);
        sendBrowser({ type: 'session_closed' });
      });

      geminiWs.on('error', (err) => {
        console.error('  !! gemini ws error:', err.message);
        sendBrowser({ type: 'error', message: `gemini: ${err.message}` });
      });

    } else if (msg.type === 'audio') {
      if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
        geminiWs.send(JSON.stringify({
          realtimeInput: {
            audio: { mimeType: 'audio/pcm;rate=16000', data: msg.data }
          }
        }));
      }

    } else if (msg.type === 'end_session') {
      closeGemini();
      sendBrowser({ type: 'session_closed' });

    } else if (msg.type === 'remove_task_manual') {
      state.tasks = state.tasks.filter(t => t.id !== msg.task_id);
      await saveTasks(state);
      sendBrowser({ type: 'tasks_update', tasks: state.tasks });

    } else if (msg.type === 'complete_task_manual') {
      const t = state.tasks.find(t => t.id === msg.task_id);
      if (t) {
        t.completed = !t.completed;
        await saveTasks(state);
        sendBrowser({ type: 'tasks_update', tasks: state.tasks });
      }
    }
  });

  browser.on('close', () => {
    console.log(`[${new Date().toISOString()}] browser disconnected (${addr})`);
    closeGemini();
  });
});
