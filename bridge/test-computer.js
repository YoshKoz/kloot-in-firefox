'use strict';

// Verifies that the bridge serves the `computer` tool over BiDi rather than
// forwarding it to the extension, and that the input it produces is trusted.
//
// Expects: Firefox running with --remote-debugging-port, the extension already
// installed and paired, and a bridge started with BiDi enabled.

const WebSocket = require('ws');
const http = require('http');

const BRIDGE_PORT = Number(process.env.KLOOT_PORT || 8799);

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

function waitFor(ws, predicate, timeoutMs = 30000) {
  const hit = ws.received.find(predicate);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
    const on = (m) => {
      if (!predicate(m)) return;
      clearTimeout(timer);
      ws.off('msg', on);
      resolve(m);
    };
    ws.on('msg', on);
  });
}

let seq = 0;
function call(ws, tool, args) {
  const id = `c${++seq}`;
  ws.send(JSON.stringify({ type: 'tool_call', tool_use_id: id, tool, args }));
  return waitFor(ws, (m) => m.type === 'tool_result' && m.tool_use_id === id);
}

const textOf = (r) => r?.content?.map((c) => c.text).filter(Boolean).join('\n') ?? '';
const imageOf = (r) => r?.content?.find((c) => c.type === 'image');

(async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/claude-code/dev_user_local`);
  ws.received = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    ws.received.push(m);
    ws.emit('msg', m);
  });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  ws.send(JSON.stringify({ type: 'connect', client_type: 'claude-code', dev_user_id: 'dev_user_local' }));
  await waitFor(ws, (m) => m.type === 'paired' || m.type === 'waiting');

  // Firefox blocks top-level data: navigation, so the fixture is served over
  // loopback HTTP instead. The button records whether the click it received was
  // a real one.
  const html = `<html><body style="margin:0">
    <button id="b" style="position:absolute;left:40px;top:40px;width:160px;height:50px">click me</button>
    <div id="out">none</div>
    <script>
      document.getElementById('b').addEventListener('click', e => {
        document.getElementById('out').textContent = e.isTrusted ? 'trusted' : 'synthetic';
      });
    </script>
  </body></html>`;

  const fixture = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  await new Promise((res) => fixture.listen(0, '127.0.0.1', res));
  const page = `http://127.0.0.1:${fixture.address().port}/`;

  const nav = await call(ws, 'navigate', { url: page });
  if (nav.is_error) throw new Error(`navigate failed: ${textOf(nav)}`);
  const tabId = JSON.parse(textOf(nav) || '{}').tabId;
  check('navigated to the fixture page', typeof tabId === 'number', `tabId=${tabId}`);

  const shot = await call(ws, 'computer', { action: 'screenshot', tabId });
  const img = imageOf(shot);
  check('computer screenshot returned an image', Boolean(img), `${img?.source?.data?.length ?? 0} b64 chars`);

  const clicked = await call(ws, 'computer', { action: 'left_click', coordinate: [120, 65], tabId });
  check('computer click succeeded', !clicked.is_error, textOf(clicked).slice(0, 120));

  const verify = await call(ws, 'javascript_tool', { tabId, code: 'document.getElementById("out").textContent' });
  check('click was delivered as a TRUSTED event', /trusted/.test(textOf(verify)), textOf(verify));

  await call(ws, 'tabs_close_mcp', { tabId });
  ws.close();
  fixture.close();
  console.log(failures.length ? `\n${failures.length} failing check(s)` : '\nall checks passed');
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error('test error:', err.message);
  process.exit(1);
});
