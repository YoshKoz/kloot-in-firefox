'use strict';

// Full-stack test: installs the extension into a running Firefox over BiDi,
// waits for it to pair with the bridge, then drives real tools through it.
//
// Requires a Firefox started with --remote-debugging-port and a bridge already
// listening on KLOOT_PORT.

const WebSocket = require('ws');
const { BidiClient } = require('./bidi');

const BRIDGE_PORT = Number(process.env.KLOOT_PORT || 8799);
const BIDI_PORT = Number(process.env.KLOOT_BIDI_PORT || 9333);
const EXT_PATH = process.env.KLOOT_EXT_PATH;

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

function waitFor(ws, predicate, timeoutMs = 20000) {
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

function call(controller, tool, args) {
  const id = `t-${Number(process.hrtime.bigint() % 100000n)}-${tool}`;
  controller.send(JSON.stringify({ type: 'tool_call', tool_use_id: id, tool, args }));
  return waitFor(controller, (m) => m.type === 'tool_result' && m.tool_use_id === id);
}

function textOf(result) {
  return result?.content?.map((c) => c.text).filter(Boolean).join('\n') ?? '';
}

(async () => {
  // Controller side of the bridge.
  const controller = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/claude-code/dev_user_local`);
  controller.received = [];
  controller.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    controller.received.push(msg);
    controller.emit('msg', msg);
  });
  await new Promise((res, rej) => {
    controller.once('open', res);
    controller.once('error', rej);
  });
  controller.send(JSON.stringify({ type: 'connect', client_type: 'claude-code', dev_user_id: 'dev_user_local' }));

  // Install the extension.
  const bidi = new BidiClient({ host: '127.0.0.1', port: BIDI_PORT });
  await bidi.connect();
  const installed = await bidi.command('webExtension.install', {
    extensionData: { type: 'path', path: EXT_PATH },
  });
  check('extension installed over BiDi', Boolean(installed?.extension), `id=${installed?.extension}`);

  // It should dial the bridge on its own.
  const peer = await waitFor(controller, (m) => m.type === 'peer_connected');
  check('extension paired with bridge', Boolean(peer));

  // --- drive real tools ---
  const nav = await call(controller, 'navigate', { url: 'https://example.com' });
  check('navigate succeeded', !nav.is_error, textOf(nav).slice(0, 120).replace(/\s+/g, ' '));
  const navData = JSON.parse(textOf(nav) || '{}');
  const tabId = navData.tabId;
  check('navigate returned a tabId', typeof tabId === 'number', `tabId=${tabId}`);
  check('navigate waited for the real page', navData.url?.includes('example.com') && navData.status === 'complete',
    `url=${navData.url} status=${navData.status}`);

  const text = await call(controller, 'get_page_text', { tabId });
  check('get_page_text returned page content', /example domain/i.test(textOf(text)), textOf(text).slice(0, 80).replace(/\n/g, ' '));

  const page = await call(controller, 'read_page', { tabId, include_links: true });
  const snapshot = JSON.parse(textOf(page) || '{}');
  check('read_page returned a snapshot', snapshot.title?.length > 0, `title=${snapshot.title}`);
  check('read_page found links', Array.isArray(snapshot.links) && snapshot.links.length > 0, `${snapshot.links?.length} link(s)`);

  const ctx = await call(controller, 'tabs_context_mcp', {});
  const ctxData = JSON.parse(textOf(ctx) || '{}');
  check('tabs_context_mcp lists the owned tab', ctxData.tabs?.some((t) => t.tabId === tabId), `${ctxData.tabs?.length} tab(s)`);

  const js = await call(controller, 'javascript_tool', { tabId, code: 'document.title' });
  check('javascript_tool evaluated', /example/i.test(textOf(js)), textOf(js));

  const found = await call(controller, 'find', { tabId, query: 'more' });
  const foundData = JSON.parse(textOf(found) || '{}');
  check('find located the link', foundData.matches?.length > 0, `${foundData.matches?.length} match(es)`);

  const unknown = await call(controller, 'definitely_not_a_tool', {});
  check('unknown tool returns a clean error', unknown.is_error === true, textOf(unknown));

  const closed = await call(controller, 'tabs_close_mcp', { tabId });
  check('tabs_close_mcp closed the tab', !closed.is_error, textOf(closed));

  controller.close();
  await bidi.close();
  console.log(failures.length ? `\n${failures.length} failing check(s)` : '\nall checks passed');
  process.exit(failures.length ? 1 : 0);
})().catch(async (err) => {
  console.error('test error:', err.message);
  // Release the session so the next run is not blocked by this failure.
  try {
    const { BidiClient } = require('./bidi');
    const cleanup = new BidiClient({ host: '127.0.0.1', port: BIDI_PORT });
    await cleanup.connect().then(() => cleanup.close()).catch(() => {});
  } catch {}
  process.exit(1);
});
