'use strict';

// Smoke test for the BiDi layer against a Firefox started with
// --remote-debugging-port. Verifies the three things the extension cannot do:
// context enumeration, screenshots, and trusted input.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BidiClient } = require('./bidi');

const PORT = Number(process.env.KLOOT_BIDI_PORT || 9333);

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

(async () => {
  const bidi = new BidiClient({ host: '127.0.0.1', port: PORT });
  await bidi.connect();
  check('connected and session established', bidi.connected, `sessionId=${bidi.sessionId}`);

  const contexts = await bidi.contexts();
  check('browsingContext.getTree returns a context', contexts.length > 0, `${contexts.length} context(s)`);

  const context = contexts[0].context;

  // A local file:// page keeps the test hermetic — no network needed.
  // (BiDi refuses top-level navigation to data: URIs as an unsupported operation.)
  const html = `<html><body style="margin:0">
    <button id="b" style="position:absolute;left:50px;top:50px;width:120px;height:40px">click me</button>
    <input id="i" style="position:absolute;left:50px;top:120px">
    <script>
      window.clicked = false;
      document.getElementById('b').addEventListener('click', e => { window.clicked = e.isTrusted; });
    <\/script>
  </body></html>`;
  const tmpFile = path.join(os.tmpdir(), `kloot-bidi-test-${process.pid}.html`);
  fs.writeFileSync(tmpFile, html);
  const page = `file://${tmpFile}`;

  await bidi.navigate(context, page);
  check('navigate completed', true);

  const shot = await bidi.screenshot(context);
  check('captureScreenshot returns PNG data', typeof shot === 'string' && shot.length > 1000, `${shot.length} b64 chars`);

  // The whole point of debugging mode: isTrusted must be true.
  await bidi.click(context, 110, 70);
  const clicked = await bidi.evaluate(context, 'window.clicked');
  check('click produced a TRUSTED event', clicked?.result?.value === true, `isTrusted=${clicked?.result?.value}`);

  await bidi.click(context, 110, 130); // focus the input
  await bidi.typeText(context, 'hello kloot');
  const typed = await bidi.evaluate(context, 'document.getElementById("i").value');
  check('typeText entered text', typed?.result?.value === 'hello kloot', `value=${JSON.stringify(typed?.result?.value)}`);

  await bidi.pressKey(context, 'Control+a');
  check('key chord accepted', true);

  await bidi.close();
  fs.unlinkSync(tmpFile);
  console.log(failures.length ? `\n${failures.length} failing check(s)` : '\nall checks passed');
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error('BiDi test error:', err.message);
  process.exit(1);
});
