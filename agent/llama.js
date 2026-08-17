'use strict';

// Client for a local llama.cpp server's OpenAI-compatible chat endpoint.
//
// Tool calling is done natively: llama-server must be started with --jinja so it
// applies the model's own chat template and parses the tool-call delimiters back
// out. Without it the server falls back to a heuristic parser that does not
// recognise Qwen's format at all, and every tool call arrives as prose.

// A llama.cpp server could be anywhere; these are the two places it usually is
// on this machine — the agent's own instance from scripts/launch-llm.sh, and a
// system-wide llama.cpp.service. Whichever answers first is used, so the agent
// works without being told which is up.
const CANDIDATE_URLS = (process.env.KLOOT_LLM_URL || 'http://127.0.0.1:8081,http://127.0.0.1:61093')
  .split(',')
  .map((u) => u.trim().replace(/\/$/, ''))
  .filter(Boolean);

const DEFAULT_MODEL = process.env.KLOOT_LLM_MODEL || 'auto';

// A llama.cpp router lists every preset it knows, sorted by name, so "the first
// one" is whatever sorts first rather than the one worth using. These patterns
// pick a model known to hold up in a tool-calling loop, in descending order of
// preference; anything unmatched falls back to the first entry.
const PREFERRED = [/qwen3\.5/i, /qwen3.*instruct/i, /qwen3/i];

class LlamaClient {
  constructor({ url = null, model = DEFAULT_MODEL, temperature = 0.2 } = {}) {
    this.candidates = url ? [url.replace(/\/$/, '')] : CANDIDATE_URLS;
    this.url = this.candidates[0];
    this.model = model;
    this.temperature = temperature;
  }

  async probe() {
    const failures = [];
    for (const url of this.candidates) {
      try {
        const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const ids = (body?.data ?? []).map((m) => m.id).filter(Boolean);
        this.url = url;

        if (this.model !== 'auto' && this.model) {
          // An explicit choice is honoured, but say so when the server has never
          // heard of it rather than failing later on every request.
          if (ids.length && !ids.includes(this.model)) {
            throw new Error(`model ${this.model} not served here (has: ${ids.join(', ')})`);
          }
          return this.model;
        }

        for (const pattern of PREFERRED) {
          const hit = ids.find((id) => pattern.test(id));
          if (hit) {
            this.model = hit;
            return hit;
          }
        }
        this.model = ids[0] ?? body?.models?.[0]?.name ?? 'local';
        return this.model;
      } catch (err) {
        failures.push(`${url}: ${err.message}`);
      }
    }
    throw new Error(`no llama.cpp server responded (${failures.join('; ')})`);
  }

  async chat(messages, tools, { timeoutMs = 300000 } = {}) {
    const body = {
      model: this.model,
      messages,
      temperature: this.temperature,
      top_p: 0.9,
      max_tokens: 700,
      // Qwen3 is a hybrid reasoning model. Thinking is left on for the final
      // answer's benefit nowhere here — it costs tokens the 8k window cannot
      // spare and, on some template versions, leaks unclosed <think> tags into
      // the tool-call serialisation.
      chat_template_kwargs: { enable_thinking: false },
      ...(tools?.length && { tools, tool_choice: 'auto' }),
    };

    const res = await fetch(`${this.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`llama-server ${res.status}: ${detail.slice(0, 300)}`);
    }

    const json = await res.json();
    const choice = json?.choices?.[0];
    if (!choice) throw new Error('llama-server returned no choices');

    return {
      message: choice.message ?? {},
      finishReason: choice.finish_reason,
      usage: json.usage ?? null,
    };
  }
}

module.exports = { LlamaClient };
