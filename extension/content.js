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
  responseBlock: 'model-response',
};

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
  // execCommand is deprecated but still works in Chromium for contenteditable
  document.execCommand('selectAll', false, null);
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
    let debounce = null;

    function finish() {
      outerObs.disconnect();
      resolve(target ? target.innerText.trim() : '');
    }

    function watchTarget() {
      const innerObs = new MutationObserver(() => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          innerObs.disconnect();
          finish();
        }, 1500);
      });
      innerObs.observe(target, { childList: true, subtree: true, characterData: true });
      // Hard ceiling per response
      setTimeout(() => { innerObs.disconnect(); finish(); }, 90000);
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true });
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
