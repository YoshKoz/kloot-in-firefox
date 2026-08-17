'use strict';

// The reasoning loop: a local model decides, the MCP tools act, the results come
// back, repeat until the model answers or the step budget runs out.
//
// Everything here exists because the model is an 8B running in an 8k window, not
// a frontier model with room to be sloppy:
//
//   * observations are trimmed as the window fills, oldest first, so a long task
//     degrades into forgetting details rather than hard-failing on overflow
//   * an identical repeated tool call is intercepted and answered with a nudge,
//     because small models loop on a call that did not give them what they hoped
//   * `finish` is an explicit tool, so "I am done" is a parseable event rather
//     than something to infer from prose

const { LlamaClient } = require('./llama');
const { McpClient } = require('./mcp-client');
const path = require('path');

const SYSTEM_PROMPT = `You are a browser automation agent. You control a real Firefox window through tools.

Rules:
- Work in small steps. Call one tool at a time and look at the result before deciding the next one.
- To click something, pass its visible text to browser_click, like browser_click with text "Learn more". Never invent x,y coordinates.
- To search: browser_click the search box by its text, browser_type the query, then browser_press_key with "Enter".
- After a page loads or changes, use browser_get_text or browser_read_page to see what is actually there.
- browser_click tells you when the page navigated. Trust that instead of assuming.
- Do not repeat a tool call that already succeeded.
- When the task is done, call finish with the answer. Always end by calling finish.

Be brief. Do not explain what you are about to do, just call the tool.`;

const FINISH_TOOL = {
  type: 'function',
  function: {
    name: 'finish',
    description: 'Report the final answer and end the task. Call this when the goal is met, or if you cannot proceed.',
    parameters: {
      type: 'object',
      properties: { answer: { type: 'string', description: 'The answer, or an explanation of what blocked you.' } },
      required: ['answer'],
    },
  },
};

// Rough, deliberately pessimistic: better to trim early than to overflow.
const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 3.4);

function messageTokens(msg) {
  let n = estimateTokens(msg.content ?? '');
  for (const tc of msg.tool_calls ?? []) n += estimateTokens(tc.function?.arguments ?? '') + 12;
  return n + 8;
}

class Agent {
  constructor({
    llm = new LlamaClient(),
    serverPath = path.join(__dirname, '..', 'mcp', 'server.js'),
    toolFilter = null,
    maxSteps = 16,
    contextBudget = Number(process.env.KLOOT_CTX_BUDGET || 5200),
    onEvent = () => {},
  } = {}) {
    this.llm = llm;
    this.mcp = new McpClient(process.execPath, [serverPath], {
      onLog: (line) => onEvent({ type: 'server_log', line }),
    });
    this.toolFilter = toolFilter;
    this.maxSteps = maxSteps;
    this.contextBudget = contextBudget;
    this.onEvent = onEvent;
    this.tools = [];
    // Conversation persists across goals so follow-up questions keep their
    // context ("now click the first result").
    this.messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  }

  async start() {
    const discovered = await this.mcp.start();
    this.tools = [...this.mcp.asOpenAiTools(this.toolFilter), FINISH_TOOL];
    const model = await this.llm.probe();
    this.onEvent({ type: 'ready', model, tools: this.tools.map((t) => t.function.name), discovered: discovered.length });
    return this.tools;
  }

  // Drops the content of the oldest tool observations once the window fills.
  // The messages themselves stay, because an assistant tool_calls message with
  // no matching tool reply is a template error on most chat templates.
  trim() {
    let total = this.messages.reduce((n, m) => n + messageTokens(m), 0);
    if (total <= this.contextBudget) return;

    for (const msg of this.messages) {
      if (total <= this.contextBudget) break;
      if (msg.role !== 'tool' || msg._trimmed) continue;
      const before = messageTokens(msg);
      msg.content = '[earlier observation dropped to save context]';
      msg._trimmed = true;
      total -= before - messageTokens(msg);
    }
    this.onEvent({ type: 'trimmed', tokens: total });
  }

  async run(goal) {
    this.messages.push({ role: 'user', content: goal });
    const seen = new Map();

    for (let step = 1; step <= this.maxSteps; step += 1) {
      this.trim();

      const { message, finishReason } = await this.llm.chat(
        this.messages.map(({ _trimmed, ...m }) => m),
        this.tools,
      );

      const calls = message.tool_calls ?? [];

      // No tool call: either the model answered in prose, or it stalled.
      if (!calls.length) {
        const text = (message.content ?? '').trim();
        this.messages.push({ role: 'assistant', content: text });
        if (text) {
          this.onEvent({ type: 'answer', text, step, viaFinish: false });
          return { answer: text, steps: step };
        }
        this.messages.push({ role: 'user', content: 'Call a tool, or call finish with your answer.' });
        continue;
      }

      // Only the first call is honoured: sequential tool use is what the prompt
      // asks for, and parallel calls from a small model are usually a symptom of
      // it guessing rather than reading.
      const call = calls[0];
      this.messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: [call] });

      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        this.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: 'Your arguments were not valid JSON. Call the tool again with valid JSON arguments.',
        });
        continue;
      }

      if (name === 'finish') {
        const answer = String(args.answer ?? '').trim() || '(no answer given)';
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: 'done' });
        this.onEvent({ type: 'answer', text: answer, step, viaFinish: true });
        return { answer, steps: step };
      }

      this.onEvent({ type: 'tool_call', step, name, args });

      const key = `${name}:${JSON.stringify(args)}`;
      const repeats = (seen.get(key) ?? 0) + 1;
      seen.set(key, repeats);
      if (repeats > 2) {
        this.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `You have already called ${name} with these arguments ${repeats - 1} times. ` +
            'Try a different tool or different arguments, or call finish.',
        });
        this.onEvent({ type: 'loop_guard', name });
        continue;
      }

      let observation;
      try {
        observation = await this.mcp.callTool(name, args);
      } catch (err) {
        observation = { text: `tool error: ${err.message}`, isError: true };
      }

      this.messages.push({ role: 'tool', tool_call_id: call.id, content: observation.text || '(no output)' });
      this.onEvent({ type: 'tool_result', step, name, text: observation.text, isError: observation.isError });

      if (finishReason === 'length') {
        this.onEvent({ type: 'note', text: 'model output hit the token limit' });
      }
    }

    const text = `Stopped after ${this.maxSteps} steps without finishing.`;
    this.onEvent({ type: 'answer', text, step: this.maxSteps, viaFinish: false });
    return { answer: text, steps: this.maxSteps, exhausted: true };
  }

  stop() {
    this.mcp.stop();
  }
}

module.exports = { Agent, SYSTEM_PROMPT };
