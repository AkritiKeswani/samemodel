// Thin OpenRouter client. No SDK on purpose: the API is OpenAI-compatible,
// and keeping the raw request visible makes every routing decision explicit.

const BASE = "https://openrouter.ai/api/v1";

function headers(apiKey) {
  const key = apiKey || process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("No OpenRouter API key: set OPENROUTER_API_KEY in .env (or paste one in the UI)");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/AkritiKeswani/samemodel",
    "X-Title": "SameModel",
  };
}

/**
 * Every provider endpoint currently serving a model, with price,
 * quantization, context, supported params and recent uptime/latency.
 * modelId: "openai/gpt-oss-120b"
 */
export async function listEndpoints(modelId, apiKey) {
  const [author, ...rest] = modelId.split(":")[0].split("/");
  const res = await fetch(`${BASE}/models/${author}/${rest.join("/")}/endpoints`, { headers: headers(apiKey) });
  if (!res.ok) throw new Error(`endpoints ${modelId}: ${res.status} ${await res.text()}`);
  const { data } = await res.json();
  return data.endpoints;
}

/**
 * Streaming chat completion. Returns an async iterator of parsed SSE chunks.
 * Throws an Error with .status on non-2xx so callers can classify
 * (429 rate limit vs 5xx provider error vs 4xx bad request).
 */
export async function chatStream(body, { signal, apiKey } = {}) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!res.ok) {
    const err = new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return parseSSE(res.body);
}

async function* parseSSE(stream) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const bytes of stream) {
    buf += decoder.decode(bytes, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      // OpenRouter sends ": OPENROUTER PROCESSING" comments as keepalives.
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      const chunk = JSON.parse(data);
      // Errors that happen mid-stream arrive as a chunk with an `error` field
      // after a 200 status — they never surface as an HTTP error.
      if (chunk.error) {
        const err = new Error(`mid-stream: ${chunk.error.message || JSON.stringify(chunk.error)}`);
        err.status = chunk.error.code;
        err.midStream = true;
        throw err;
      }
      yield chunk;
    }
  }
}
