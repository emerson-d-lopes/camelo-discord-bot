const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';

let available: boolean | null = null;
let lastCheck = 0;
const CHECK_TTL_MS = 60_000;

/** Is a local Ollama server reachable? Cached for a minute. */
export async function ollamaAvailable(): Promise<boolean> {
  const now = Date.now();
  if (available !== null && now - lastCheck < CHECK_TTL_MS) return available;
  lastCheck = now;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2_000) });
    available = res.ok;
  } catch {
    available = false;
  }
  return available;
}

interface OllamaChatResponse {
  message?: { content?: string };
}

export class OllamaBusyError extends Error {}

// Cap concurrent inference so message spam can't pile up GPU/CPU work.
const MAX_CONCURRENT = 2;
let inFlight = 0;

/** Current and max concurrent Ollama calls, for monitoring. */
export function ollamaStats(): { inFlight: number; max: number } {
  return { inFlight, max: MAX_CONCURRENT };
}

/**
 * One-shot chat completion against local Ollama. `format` takes a JSON schema
 * for structured output. Throws on failure — callers decide the fallback.
 */
export async function ollamaChat(
  system: string,
  user: string,
  opts: { format?: object; maxTokens?: number; timeoutMs?: number } = {},
): Promise<string> {
  if (inFlight >= MAX_CONCURRENT) throw new OllamaBusyError('Ollama is busy');
  inFlight++;
  try {
    return await chatInner(system, user, opts);
  } finally {
    inFlight--;
  }
}

async function chatInner(
  system: string,
  user: string,
  opts: { format?: object; maxTokens?: number; timeoutMs?: number } = {},
): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      ...(opts.format ? { format: opts.format } : {}),
      keep_alive: '30m',
      options: { num_predict: opts.maxTokens ?? 512, temperature: 0 },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = (await res.json()) as OllamaChatResponse;
  const content = data.message?.content;
  if (!content) throw new Error('Ollama returned no content');
  return content;
}
