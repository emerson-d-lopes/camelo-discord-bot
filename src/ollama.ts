import { config } from './config.js';

const OLLAMA_URL = config.ollamaUrl;
export const OLLAMA_MODEL = config.ollamaModel;
// Bigger, smarter model for open conversation (better recall, less flaky) —
// the small model stays for fast intent classification.
export const ASSISTANT_MODEL = config.assistantModel;

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
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatOpts {
  format?: object;
  maxTokens?: number;
  timeoutMs?: number;
  model?: string;
  // For reasoning models (e.g. gemma4): false disables the thinking phase, which
  // would otherwise eat the whole token budget and leave `content` empty. Only
  // sent when defined — non-thinking models reject an unexpected `think` field.
  think?: boolean;
}

export async function ollamaChat(system: string, user: string, opts: ChatOpts = {}): Promise<string> {
  return ollamaChatMessages(system, [{ role: 'user', content: user }], opts);
}

/** Multi-turn chat — pass prior turns for conversational context. */
export async function ollamaChatMessages(
  system: string,
  turns: ChatTurn[],
  opts: ChatOpts = {},
): Promise<string> {
  if (inFlight >= MAX_CONCURRENT) throw new OllamaBusyError('Ollama is busy');
  inFlight++;
  try {
    return await chatInner(system, turns, opts);
  } finally {
    inFlight--;
  }
}

async function chatInner(system: string, turns: ChatTurn[], opts: ChatOpts = {}): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: opts.model ?? OLLAMA_MODEL,
      stream: false,
      messages: [{ role: 'system', content: system }, ...turns],
      ...(opts.format ? { format: opts.format } : {}),
      ...(opts.think !== undefined ? { think: opts.think } : {}),
      keep_alive: '30m',
      // Conversation wants a little variety; structured/intent calls stay at 0.
      options: { num_predict: opts.maxTokens ?? 512, temperature: opts.format ? 0 : 0.6 },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = (await res.json()) as OllamaChatResponse;
  const content = data.message?.content;
  if (!content) throw new Error('Ollama returned no content');
  return content;
}
