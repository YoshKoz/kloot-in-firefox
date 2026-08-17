'use strict';

// End-to-end check of the relay: a fake controller and a fake browser connect,
// exchange a tool_call/tool_result pair, and observe the pairing notifications.
// Run with:  KLOOT_PORT=8799 KLOOT_BIDI=0 node test-relay.js

const WebSocket = require('ws');

const PORT = Number(process.env.KLOOT_PORT || 8799);
const URL_BASE = `ws://127.0.0.1:${PORT}`;

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

function open(path, connectFrame) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_BASE + path);
    ws.received = [];
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      ws.received.push(msg);
      ws.emit('msg', msg);
    });
    ws.once('open', () => {
      ws.send(JSON.stringify(connectFrame));
      resolve(ws);
    });
    ws.once('error', reject);
  });
}

function waitFor(ws, predicate, timeoutMs = 3000) {
  const existing = ws.received.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
    const onMsg = (msg) => {
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.off('msg', onMsg);
      resolve(msg);
    };
    ws.on('msg', onMsg);
  });
}

(async () => {
  // 1. Controller connects first and should be told to wait.
  const controller = await open('/claude-code/dev_user_local', {
    type: 'connect',
    client_type: 'claude-code',
    dev_user_id: 'dev_user_local',
  });
  const first = await waitFor(controller, (m) => m.type === 'waiting' || m.type === 'paired');
  check('controller alone gets "waiting"', first.type === 'waiting', `got ${first.type}`);

  // 2. Browser connects; both sides should learn about each other.
  const browser = await open('/firefox/dev_user_local', {
    type: 'connect',
    client_type: 'firefox-extension',
    dev_user_id: 'dev_user_local',
  });
  const paired = await waitFor(browser, (m) => m.type === 'paired');
  check('browser joining gets "paired"', paired.type === 'paired');

  const peerUp = await waitFor(controller, (m) => m.type === 'peer_connected');
  check('controller notified of peer_connected', Boolean(peerUp));

  // 3. A tool_call must reach the browser unchanged.
  controller.send(
    JSON.stringify({
      type: 'tool_call',
      tool_use_id: 'call-1',
      tool: 'navigate',
      args: { url: 'https://example.com' },
    }),
  );
  const forwarded = await waitFor(browser, (m) => m.type === 'tool_call');
  check('tool_call reaches browser', forwarded.tool === 'navigate' && forwarded.tool_use_id === 'call-1');
  check('tool_call args preserved', forwarded.args?.url === 'https://example.com');

  // 4. The reply must travel back to the controller.
  browser.send(
    JSON.stringify({
      type: 'tool_result',
      tool_use_id: 'call-1',
      content: [{ type: 'text', text: 'navigated' }],
    }),
  );
  const result = await waitFor(controller, (m) => m.type === 'tool_result');
  check('tool_result returns to controller', result.tool_use_id === 'call-1');
  check('tool_result content intact', result.content?.[0]?.text === 'navigated');

  // 5. Keepalive.
  controller.send(JSON.stringify({ type: 'ping' }));
  const pong = await waitFor(controller, (m) => m.type === 'pong');
  check('ping answered with pong', Boolean(pong));

  // 6. Losing the browser must surface an error rather than hanging forever.
  browser.close();
  await waitFor(controller, (m) => m.type === 'peer_disconnected');
  check('controller notified of peer_disconnected', true);

  controller.send(
    JSON.stringify({ type: 'tool_call', tool_use_id: 'call-2', tool: 'navigate', args: { url: 'https://example.com' } }),
  );
  const errored = await waitFor(controller, (m) => m.type === 'tool_result' && m.tool_use_id === 'call-2');
  check('tool_call without browser returns an error', errored.is_error === true, errored.content?.[0]?.text);

  controller.close();
  console.log(failures.length ? `\n${failures.length} failing check(s)` : '\nall checks passed');
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error('test harness error:', err.message);
  process.exit(1);
});
