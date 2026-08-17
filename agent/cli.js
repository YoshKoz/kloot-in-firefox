#!/usr/bin/env node
'use strict';

// Interactive front end: type a goal, watch the local model drive Firefox.
//
//   node agent/cli.js                        # REPL
//   node agent/cli.js "search for X and tell me the top result"
//
// The reasoning runs entirely on this laptop against llama.cpp. Nothing leaves
// the machine except the pages the browser was asked to visit.

const readline = require('readline');
const { Agent } = require('./agent');
const { LlamaClient } = require('./llama');
const { AGENT_TOOL_NAMES } = require('../mcp/tools');

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  accent: (s) => `\x1b[38;5;173m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

const oneLine = (s, n = 150) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function render(event) {
  switch (event.type) {
    case 'ready':
      console.log(`${C.accent('model')}  ${event.model}`);
      console.log(`${C.accent('tools')}  ${event.tools.length} of ${event.discovered} exposed: ${C.dim(event.tools.join(', '))}\n`);
      break;
    case 'tool_call':
      console.log(`${C.dim(`${String(event.step).padStart(2)}.`)} ${C.bold(event.name)} ${C.dim(JSON.stringify(event.args))}`);
      break;
    case 'tool_result':
      console.log(`    ${event.isError ? C.red('!') : C.green('->')} ${C.dim(oneLine(event.text))}`);
      break;
    case 'loop_guard':
      console.log(`    ${C.red('loop')} ${C.dim(`repeated ${event.name}, nudging`)}`);
      break;
    case 'trimmed':
      console.log(`    ${C.dim(`context trimmed to ~${event.tokens} tokens`)}`);
      break;
    case 'note':
      console.log(`    ${C.dim(event.text)}`);
      break;
    case 'answer':
      console.log(`\n${C.accent('answer')} ${event.text}\n`);
      break;
    case 'server_log':
      if (process.env.KLOOT_DEBUG) console.log(C.dim(`    [mcp] ${event.line}`));
      break;
    default:
      break;
  }
}

(async () => {
  const agent = new Agent({
    llm: new LlamaClient(),
    // The full MCP surface stays available to other clients; the local model gets
    // the text-driven subset it can actually use well.
    toolFilter: process.env.KLOOT_ALL_TOOLS ? null : AGENT_TOOL_NAMES,
    onEvent: render,
  });

  console.log(C.bold('kloot local agent') + C.dim(' — reasoning on llama.cpp, acting in Firefox\n'));

  try {
    await agent.start();
  } catch (err) {
    console.error(C.red(`startup failed: ${err.message}`));
    console.error(C.dim('Is llama-server running? Set KLOOT_LLM_URL if it is not on 127.0.0.1:61093.'));
    process.exit(1);
  }

  const goal = process.argv.slice(2).join(' ').trim();
  if (goal) {
    await agent.run(goal).catch((err) => console.error(C.red(`error: ${err.message}`)));
    agent.stop();
    process.exit(0);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: C.accent('> '),
  });

  console.log(C.dim('Type a goal. Ctrl-D to quit.\n'));
  rl.prompt();

  // Goals run strictly one at a time. readline delivers every buffered line
  // immediately when input is piped rather than typed, so without a queue a
  // `printf 'a\nb\n' | cli.js` would start both tasks against the same browser.
  const queue = [];
  let running = false;
  let closed = false;

  async function drain() {
    if (running) return;
    running = true;
    while (queue.length) {
      const task = queue.shift();
      try {
        await agent.run(task);
      } catch (err) {
        console.error(C.red(`error: ${err.message}`));
      }
    }
    running = false;
    if (closed) finish();
    else rl.prompt();
  }

  function finish() {
    agent.stop();
    console.log(C.dim('bye'));
    process.exit(0);
  }

  rl.on('line', (line) => {
    const task = line.trim();
    if (!task) return rl.prompt();
    if (task === 'exit' || task === 'quit') return rl.close();
    queue.push(task);
    drain();
  });

  rl.on('close', () => {
    closed = true;
    if (!running && !queue.length) finish();
  });
})();
