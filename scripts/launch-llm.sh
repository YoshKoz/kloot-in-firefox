#!/usr/bin/env bash
# Start a llama.cpp server for the local agent.
#
# Qwen3.5-4B at Q6_K is the model this was tuned against: it fits an RTX 2060
# with room for a 32k context, and its tool-call formatting holds up where a
# smaller quant's does not. Q4 and below are documented to emit malformed tool
# arguments, so the quant is not the place to save space here.
#
# Only needed if there is no llama.cpp service already serving this model — the
# agent finds one on :8081 or :61093 by itself. This runs on :8082 so it does not
# collide with a router on :8081, but note that only one model can be resident at
# a time on a 6GB card: stop the service first.
set -euo pipefail

MODEL="${KLOOT_LLM_MODEL_PATH:-/var/lib/llama.cpp/models/qwen3.5-4b-q6_K.gguf}"
PORT="${KLOOT_LLM_PORT:-8082}"
CTX="${KLOOT_LLM_CTX:-32768}"

if [[ ! -f "$MODEL" ]]; then
  echo "Model not found: $MODEL" >&2
  echo "Fetch it with:" >&2
  echo "  aria2c -x16 -d ~/models -o qwen3.5-4b-q6_K.gguf \\" >&2
  echo "    https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/main/Qwen_Qwen3.5-4B-Q6_K.gguf" >&2
  exit 1
fi

if ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN; then
  echo "Port $PORT is already listening — a server may already be up." >&2
  exit 1
fi

echo "serving $(basename "$MODEL") on http://127.0.0.1:$PORT (ctx $CTX)"

# --jinja is not optional: without it llama-server does not apply the model's own
# chat template, and Qwen's tool-call delimiters are never parsed back out.
# Quantised KV cache is what keeps a 32k window inside the remaining VRAM.
exec llama-server \
  --host 127.0.0.1 \
  --port "$PORT" \
  --alias qwen3.5-4b \
  --model "$MODEL" \
  --jinja \
  -ngl 99 \
  -c "$CTX" \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --flash-attn on \
  "$@"
