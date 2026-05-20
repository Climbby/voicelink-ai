import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8081');

ws.on('open', () => {
  console.log('[client] connected to proxy');
  const msg = JSON.stringify({ type: 'start_session' });
  ws.send(msg);
  console.log('[client] sent:', msg);
});

ws.on('message', (data) => {
  console.log('[client] recv:', data.toString().slice(0, 300));
});

ws.on('close', (code, reason) => {
  console.log(`[client] closed: code=${code} reason="${reason?.toString() || ''}"`);
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('[client] error:', err.message);
});

setTimeout(() => {
  console.log('[client] timeout, closing');
  ws.close();
}, 15000);
