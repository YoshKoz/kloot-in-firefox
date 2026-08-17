'use strict';

// Minimal MCP client: spawns an MCP server as a child process and talks JSON-RPC
// 2.0 to it over stdio. Enough to discover tools and call them, which is all an
// agent loop needs.

const { spawn } = require('child_process');
const readline = require('readline');

class McpClient {
  constructor(command, args = [], { env = process.env, onLog = null } = {}) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.onLog = onLog;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.tools = [];
  }

  async start() {
    this.child = spawn(this.command, this.args, {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    readline.createInterface({ input: this.child.stdout, terminal: false }).on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    });

    // The server's diagnostics are on stderr by contract; surface them only if
    // the caller wants them, so they do not mangle the CLI output.
    readline.createInterface({ input: this.child.stderr, terminal: false }).on('line', (line) => {
      if (this.onLog) this.onLog(line);
    });

    this.child.on('exit', (code) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`MCP server exited (code ${code})`));
      }
      this.pending.clear();
    });

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'kloot-local-agent', version: '1.0.0' },
    });
    this.notify('notifications/initialized', {});

    const listed = await this.request('tools/list', {});
    this.tools = listed?.tools ?? [];
    return this.tools;
  }

  request(method, params, timeoutMs = 90000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async callTool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args ?? {} });
    const text = (result?.content ?? [])
      .map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image omitted]' : ''))
      .filter(Boolean)
      .join('\n');
    return { text, isError: Boolean(result?.isError) };
  }

  // MCP schemas are already JSON Schema, so this is a rename rather than a
  // translation.
  asOpenAiTools(filter = null) {
    return this.tools
      .filter((t) => !filter || filter.has(t.name))
      .map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
  }

  stop() {
    this.child?.kill('SIGTERM');
  }
}

module.exports = { McpClient };
