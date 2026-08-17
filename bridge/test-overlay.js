'use strict';

// Verifies the visual overlay: that it draws what it should, that it never
// interferes with the trusted input it is decorating, that it stays invisible to
// the page-reading tools, and that the extension and the bridge share one
// overlay instead of stacking two.
//
// Expects: Firefox with --remote-debugging-port, the extension installed and
// paired, and a bridge listening on KLOOT_PORT with BiDi up.

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
  const id = `o${++seq}`;
  ws.send(JSON.stringify({ type: 'tool_call', tool_use_id: id, tool, args }));
  return waitFor(ws, (m) => m.type === 'tool_result' && m.tool_use_id === id);
}

const textOf = (r) => r?.content?.map((c) => c.text).filter(Boolean).join('\n') ?? '';

const ROOT = 'document.getElementById("__kloot_overlay_root")';
const SHADOW = `${ROOT}.shadowRoot`;

// The overlay lives in the DOM, so it can be inspected from the extension's
// isolated world even though the bridge built it in the page's main world.
// That is the whole point of using an open shadow root and a shared host id.
async function probe(ws, tabId, expr) {
  const res = await call(ws, 'javascript_tool', { tabId, code: `return (${expr})` });
  if (res.is_error) throw new Error(`probe failed: ${textOf(res)}`);
  try {
    return JSON.parse(textOf(res));
  } catch {
    return textOf(res);
  }
}

const BUTTON = { x: 40, y: 40, width: 160, height: 50 };

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

  // Served over loopback HTTP because Firefox refuses top-level data: URLs.
  const html = `<html><body style="margin:0">
    <button id="b" style="position:absolute;left:${BUTTON.x}px;top:${BUTTON.y}px;width:${BUTTON.width}px;height:${BUTTON.height}px">click me</button>
    <input id="i" style="position:absolute;left:40px;top:120px">
    <input id="pw" type="password" style="position:absolute;left:40px;top:160px">
    <div id="out" style="position:absolute;top:220px">none</div>
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

  // --- installed by the extension on navigate ---
  check('overlay installed after navigate', await probe(ws, tabId, `!!${ROOT}`));
  check('banner is showing', await probe(ws, tabId, `${ROOT}.dataset.banner === "1" && !${SHADOW}.getElementById("banner").hidden`));
  check('control frame is showing', await probe(ws, tabId, `!${SHADOW}.getElementById("frame").hidden`));

  // --- it must stay out of the page-reading tools ---
  const pageText = textOf(await call(ws, 'get_page_text', { tabId }));
  check('overlay text absent from get_page_text', !/controlling/i.test(pageText), `${pageText.replace(/\s+/g, ' ').slice(0, 60)}`);

  const snapshot = JSON.parse(textOf(await call(ws, 'read_page', { tabId })) || '{}');
  check('read_page sees only the page button', snapshot.buttons?.length === 1 && /click me/.test(snapshot.buttons[0].text),
    `${snapshot.buttons?.length} button(s)`);
  check('read_page sees only the page fields', snapshot.forms?.length === 0, `${snapshot.forms?.length} form(s)`);

  // --- find boxes every match ---
  const found = JSON.parse(textOf(await call(ws, 'find', { tabId, query: 'click' })) || '{}');
  check('find still returns matches', found.matches?.length === 1, `${found.matches?.length} match(es)`);
  check('find does not leak rects into the result', found.matches?.[0]?.rect === undefined);
  const findBoxes = await probe(ws, tabId, `[...${SHADOW}.getElementById("boxes").children].map(b => b.textContent)`);
  check('find drew a numbered box per match', Array.isArray(findBoxes) && findBoxes.length === 1 && /^1\. button/.test(findBoxes[0]),
    JSON.stringify(findBoxes));

  // --- a trusted click, decorated ---
  const cx = BUTTON.x + BUTTON.width / 2;
  const cy = BUTTON.y + BUTTON.height / 2;
  const clicked = await call(ws, 'computer', { action: 'left_click', coordinate: [cx, cy], tabId });
  check('decorated click succeeded', !clicked.is_error, textOf(clicked).slice(0, 80));

  // The critical one: pointer-events must not have eaten the real event.
  const trusted = await probe(ws, tabId, 'document.getElementById("out").textContent');
  check('click still landed as a TRUSTED event', /trusted/.test(String(trusted)), String(trusted));

  const cursor = await probe(
    ws,
    tabId,
    `({ shown: !${SHADOW}.getElementById("cursor").hidden, x: Number(${ROOT}.dataset.cursorX), y: Number(${ROOT}.dataset.cursorY) })`,
  );
  check('cursor is visible at the click point', cursor.shown && cursor.x === cx && cursor.y === cy, JSON.stringify(cursor));

  const box = await probe(
    ws,
    tabId,
    `(() => { const b = ${SHADOW}.getElementById("boxes").firstElementChild;
      return b && { left: b.style.left, top: b.style.top, width: b.style.width, height: b.style.height, label: b.textContent }; })()`,
  );
  check('target box traced the button', box && box.left === `${BUTTON.x}px` && box.top === `${BUTTON.y}px`
    && box.width === `${BUTTON.width}px` && box.height === `${BUTTON.height}px`, JSON.stringify(box));
  check('target box is labelled with the element', /button/.test(box?.label ?? ''), box?.label);

  // --- one overlay, not one per world ---
  const roots = await probe(ws, tabId, 'document.querySelectorAll("#__kloot_overlay_root").length');
  check('extension and bridge share a single overlay', roots === 1, `${roots} root(s)`);

  // --- typing and keys are shown ---
  await call(ws, 'computer', { action: 'type', text: 'hello kloot', tabId });
  const bubble = await probe(
    ws,
    tabId,
    `({ hidden: ${SHADOW}.getElementById("bubble").hidden, text: ${SHADOW}.getElementById("bubble").textContent })`,
  );
  check('typing bubble shows the text', !bubble.hidden && /hello kloot/.test(bubble.text), JSON.stringify(bubble));
  check('cursor kept its place while typing', (await probe(ws, tabId, `Number(${ROOT}.dataset.cursorX)`)) === cx);

  await call(ws, 'computer', { action: 'key', text: 'Control+a', tabId });
  const keyBubble = await probe(ws, tabId, `${SHADOW}.getElementById("bubble").textContent`);
  check('key bubble shows the chord', /Control\+a/.test(String(keyBubble)), String(keyBubble));

  // --- passwords are never echoed ---
  await call(ws, 'form_input', { tabId, selector: '#pw', value: 'hunter2' });
  const pwBubble = await probe(ws, tabId, `${SHADOW}.getElementById("bubble").textContent`);
  check('password value is masked in the bubble', !/hunter2/.test(String(pwBubble)) && /•/.test(String(pwBubble)), String(pwBubble));

  // --- survives a navigation, cursor included ---
  await call(ws, 'navigate', { url: page, tabId });
  await call(ws, 'computer', { action: 'screenshot', tabId });
  const after = await probe(
    ws,
    tabId,
    `({ installed: !!${ROOT}, x: Number(${ROOT}.dataset.cursorX), y: Number(${ROOT}.dataset.cursorY),
        shown: !${SHADOW}.getElementById("cursor").hidden })`,
  );
  check('overlay reinstalled itself after navigation', after.installed);
  check('cursor came back at the same point', after.shown && after.x === cx && after.y === cy, JSON.stringify(after));

  // --- runtime switch ---
  const off = await call(ws, 'overlay', { action: 'off', tabId });
  check('overlay off reports disabled', /"enabled": false/.test(textOf(off)), textOf(off).replace(/\s+/g, ' ').slice(0, 60));
  check('overlay off removed the nodes', (await probe(ws, tabId, `!!${ROOT}`)) === false);

  await call(ws, 'computer', { action: 'left_click', coordinate: [cx, cy], tabId });
  check('actions still work with the overlay off', (await probe(ws, tabId, `!!${ROOT}`)) === false);

  const on = await call(ws, 'overlay', { action: 'on', tabId });
  check('overlay on reports enabled', /"enabled": true/.test(textOf(on)), textOf(on).replace(/\s+/g, ' ').slice(0, 60));
  check('overlay on rebuilt the nodes', await probe(ws, tabId, `!!${ROOT}`));

  // The status payload has to be plain JSON, not BiDi's tagged value tree.
  const status = JSON.parse(textOf(await call(ws, 'overlay', { action: 'status', tabId })) || '{}');
  check('status reports readable page state', status.page?.installed === true && status.page?.version === '1',
    JSON.stringify(status.page));

  await call(ws, 'tabs_close_mcp', { tabId });
  ws.close();
  fixture.close();
  console.log(failures.length ? `\n${failures.length} failing check(s)` : '\nall checks passed');
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error('test error:', err.message);
  process.exit(1);
});
