'use strict';

// Installs (or reinstalls) the extension into a running Firefox over BiDi.
//
// Firefox allows a single BiDi session at a time, so this connects, installs,
// and releases the session immediately — run it before starting the bridge.
//
//   node install-extension.js [path-to-extension-dir]

const path = require('path');
const { BidiClient } = require('./bidi');
const config = require('./config');

const extPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'extension'));

(async () => {
  const bidi = new BidiClient({ host: config.bidiHost, port: config.bidiPort });
  await bidi.connect();

  // Firefox allows one BiDi session at a time and only releases it on
  // session.end, so a failed install has to hand the session back too — or the
  // next run is locked out until Firefox restarts.
  try {
    // Replace any previous copy so a stale build is never left behind.
    const existing = await bidi.command('webExtension.install', {
      extensionData: { type: 'path', path: extPath },
    }).catch(async (err) => {
      if (!/already installed|conflict/i.test(err.message)) throw err;
      return null;
    });

    if (existing?.extension) {
      console.log(`installed ${extPath} as ${existing.extension}`);
    } else {
      console.log(`extension at ${extPath} was already installed`);
    }
  } finally {
    await bidi.close().catch(() => {});
  }
})().catch((err) => {
  console.error(`install failed: ${err.message}`);
  process.exit(1);
});
