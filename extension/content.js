// VoiceLink AI — content script for gemini.google.com
// If Gemini updates their UI and this breaks, update SELECTORS below.

const SELECTORS = {
  input: [
    'div.ql-editor[contenteditable="true"]',
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
  ],
  sendBtn: [
    'button[aria-label="Send message"]',
    'button[data-test-id="send-button"]',
    'button.send-button',
  ],
  stopBtn: [
    'button[aria-label="Stop response"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop generating response"]',
    'button[aria-label*="Stop" i]',
    'button[data-test-id="stop-button"]',
  ],
  responseBlock: 'model-response',
  // Selectors that pick ONLY the spoken reply — not the "thinking process"
  // expander, not the screen-reader-only "Gemini said" label.
  responseText: [
    'message-content .markdown',
    '.model-response-text .markdown',
    '.response-content .markdown',
    '.markdown',
  ],
};

function extractResponseText(modelResponseEl) {
  for (const sel of SELECTORS.responseText) {
    // Last match — when thinking + response both render, the actual reply
    // is the later element.
    const matches = modelResponseEl.querySelectorAll(sel);
    const el = matches[matches.length - 1];
    if (el) {
      const text = el.innerText.trim();
      if (text) return text;
    }
  }
  return '';
}

function find(selectors) {
  for (const s of selectors) {
    const el = document.querySelector(s);
    if (el) return el;
  }
  return null;
}

function typeIntoInput(text) {
  const input = find(SELECTORS.input);
  if (!input) return false;
  input.focus();

  // Select ONLY the input's contents. document.execCommand('selectAll') selects
  // the whole document if focus has shifted, which is what was happening.
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(input);
  sel.removeAllRanges();
  sel.addRange(range);

  document.execCommand('delete', false, null);
  document.execCommand('insertText', false, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

function clickSend() {
  const btn = find(SELECTORS.sendBtn);
  if (btn) { btn.click(); return true; }
  // Fallback: Enter key
  const input = find(SELECTORS.input);
  if (input) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return true;
  }
  return false;
}

function waitForResponse() {
  return new Promise((resolve) => {
    const baseline = document.querySelectorAll(SELECTORS.responseBlock).length;
    let target = null;
    let innerObs = null;
    let debounce = null;
    let lastText = '';

    function finish() {
      outerObs.disconnect();
      if (innerObs) innerObs.disconnect();
      // Prefer the targeted markdown text; fall back to full innerText only
      // if extraction found nothing.
      const text = target ? (extractResponseText(target) || target.innerText.trim()) : '';
      resolve(text);
    }

    function watchTarget() {
      innerObs = new MutationObserver(() => {
        const currentText = extractResponseText(target);
        // Only start the "looks stable" debounce once the actual response
        // text exists — ignore mutations that are just the thinking-process
        // expander rendering.
        if (!currentText) return;
        if (currentText === lastText) return;
        lastText = currentText;
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          innerObs.disconnect();
          finish();
        }, 1500);
      });
      innerObs.observe(target, { childList: true, subtree: true, characterData: true });
      // Hard ceiling per response
      setTimeout(() => { if (innerObs) { innerObs.disconnect(); finish(); } }, 90000);
    }

    const outerObs = new MutationObserver(() => {
      const blocks = document.querySelectorAll(SELECTORS.responseBlock);
      if (!target && blocks.length > baseline) {
        target = blocks[blocks.length - 1];
        watchTarget();
      }
    });

    outerObs.observe(document.body, { childList: true, subtree: true });
    // Hard ceiling for the whole wait
    setTimeout(finish, 120000);
  });
}

// ── Model switching ───────────────────────────────────────────────────
const MODEL_MATCHERS = {
  pro:       el => /\bpro\b/i.test(el.innerText) && !/lite/i.test(el.innerText),
  flash:     el => /\bflash\b/i.test(el.innerText) && !/lite/i.test(el.innerText),
  flashlite: el => /flash[\s-]?lite|fastest/i.test(el.innerText),
};

function waitForModelItems(timeoutMs = 1500) {
  return new Promise(resolve => {
    const start = Date.now();
    const check = () => [...document.querySelectorAll('[data-test-id^="bard-mode-option-"]')];
    const first = check();
    if (first.length) return resolve(first);
    const interval = setInterval(() => {
      const items = check();
      if (items.length) { clearInterval(interval); resolve(items); }
      else if (Date.now() - start > timeoutMs) { clearInterval(interval); resolve([]); }
    }, 50);
  });
}

async function switchModel(target) {
  const trigger = document.querySelector('button[data-test-id="bard-mode-menu-button"]');
  if (!trigger) {
    chrome.runtime.sendMessage({ type: 'MODEL_SWITCH_RESULT', ok: false, error: 'Model picker button not found' });
    return;
  }
  const matcher = MODEL_MATCHERS[target];
  if (!matcher) {
    chrome.runtime.sendMessage({ type: 'MODEL_SWITCH_RESULT', ok: false, error: `Unknown model key: ${target}` });
    return;
  }

  trigger.click();
  const items = await waitForModelItems();
  if (!items.length) {
    chrome.runtime.sendMessage({ type: 'MODEL_SWITCH_RESULT', ok: false, error: 'Model menu did not open' });
    return;
  }

  const match = items.find(matcher);
  if (!match) {
    trigger.click(); // close the menu we opened
    chrome.runtime.sendMessage({ type: 'MODEL_SWITCH_RESULT', ok: false, error: `No item matched "${target}"` });
    return;
  }

  match.click();
  const name = match.innerText.split('\n')[0].trim();
  chrome.runtime.sendMessage({ type: 'MODEL_SWITCH_RESULT', ok: true, name });
}

// ── STT (runs here because gemini.google.com already has mic permission) ──
let recognition = null;
let listening = false;

function startListening() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    chrome.runtime.sendMessage({ type: 'STT_ERROR', error: 'SpeechRecognition not supported in this browser' });
    return;
  }
  if (recognition) return; // already running

  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) {
        const final = t.trim();
        if (final) chrome.runtime.sendMessage({ type: 'TRANSCRIPT_FINAL', text: final });
      } else {
        interim += t;
      }
    }
    if (interim) chrome.runtime.sendMessage({ type: 'TRANSCRIPT_INTERIM', text: interim });
  };

  recognition.onerror = e => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    chrome.runtime.sendMessage({ type: 'STT_ERROR', error: e.error });
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      listening = false;
      recognition = null;
    }
  };

  recognition.onend = () => {
    if (listening) {
      try { recognition.start(); } catch (_) { /* already started */ }
    } else {
      recognition = null;
    }
  };

  listening = true;
  try {
    recognition.start();
  } catch (err) {
    chrome.runtime.sendMessage({ type: 'STT_ERROR', error: err.message });
    listening = false;
    recognition = null;
  }
}

function stopListening() {
  listening = false;
  if (recognition) {
    try { recognition.stop(); } catch (_) {}
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'START_LISTENING') {
    startListening();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'STOP_LISTENING') {
    stopListening();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'SWITCH_MODEL') {
    switchModel(msg.target);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'CHECK_CONVERSATION') {
    const hasHistory = document.querySelectorAll(SELECTORS.responseBlock).length > 0;
    sendResponse({ hasHistory });
    return;
  }

  if (msg.type === 'STOP_GENERATION') {
    const btn = find(SELECTORS.stopBtn);
    if (btn) { btn.click(); sendResponse({ ok: true }); }
    else sendResponse({ ok: false });
    return;
  }

  if (msg.type === 'SEND_TO_GEMINI') {
    (async () => {
      if (!typeIntoInput(msg.text)) {
        chrome.runtime.sendMessage({ type: 'GEMINI_ERROR', error: 'Gemini input not found — DOM may have changed' });
        return;
      }
      const responsePromise = waitForResponse();
      await new Promise(r => setTimeout(r, 150));
      if (!clickSend()) {
        chrome.runtime.sendMessage({ type: 'GEMINI_ERROR', error: 'Send button not found — DOM may have changed' });
        return;
      }
      const text = await responsePromise;
      chrome.runtime.sendMessage({ type: 'GEMINI_RESPONSE', text });
    })();
    sendResponse({ ok: true });
    return true;
  }
});
