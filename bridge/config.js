'use strict';

// Central configuration. Everything is overridable by environment variable so
// the bridge can be moved off the default port when something else owns it.
module.exports = {
  // Claude Code hardcodes ws://localhost:8765 when LOCAL_BRIDGE=1, so this must
  // stay 8765 for it to connect. It is configurable only for testing.
  port: Number(process.env.KLOOT_PORT || 8765),
  host: process.env.KLOOT_HOST || '127.0.0.1',

  // Firefox's WebDriver BiDi endpoint, enabled by --remote-debugging-port.
  bidiPort: Number(process.env.KLOOT_BIDI_PORT || 9222),
  bidiHost: process.env.KLOOT_BIDI_HOST || '127.0.0.1',
  // Set to "0" to run DOM-only, without trusted input.
  bidiEnabled: process.env.KLOOT_BIDI !== '0',

  // On-page visual feedback: the pointer, click ripple and target box. Costs a
  // script evaluation plus roughly 2 x overlayDelayMs per action, so it is worth
  // switching off for unattended runs.
  overlay: process.env.KLOOT_OVERLAY !== '0',
  // The "Claude is controlling this tab" pill and frame, separately switchable
  // because it is the one part that permanently covers page pixels.
  overlayBanner: process.env.KLOOT_OVERLAY_BANNER !== '0',
  // How long to let an effect render before delivering the real input. Below
  // ~80ms the ripple is not on screen yet when the screenshot is taken.
  overlayDelayMs: Number(process.env.KLOOT_OVERLAY_DELAY ?? 150),

  verbose: process.env.KLOOT_VERBOSE === '1',
};
