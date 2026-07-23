import { addConversationTurn, clearConversation, getConversation } from '../../db.js';
import { OllamaBusyError, ollamaAvailable, ollamaChatMessages } from '../../ollama.js';

const SYSTEM =
  'You are Camelô, a friendly music-bot hanging out in a Discord channel (English and Brazilian ' +
  'Portuguese). Chat naturally and keep it fairly short — this is a casual channel. You know music ' +
  'well and love talking about it: artists, genres, recommendations, what fits a mood. Users can also ' +
  'ask you to play songs — if someone clearly wants a specific song played, tell them to just say it ' +
  '(e.g. "toca <song>") since a separate system handles playback. Reply in the same language as the ' +
  "user. Messages are prefixed with the speaker's name; do not prefix your own reply.";

/** Plain-text ways to wipe the channel's memory. */
const CLEAR_RE =
  /^(forget( it| everything| this| the conversation| our (chat|conversation))?|clear (the )?(context|conversation|chat|memory)|reset( the)?( conversation| chat| context)?|new conversation|start over|wipe (the )?(memory|context|chat)|esquece(r)?( tudo| isso| a conversa)?|limpa(r)?( a conversa| o (chat|contexto|hist[oó]rico))?|nova conversa|reseta(r)?|apaga(r)? (tudo|a conversa))[.!]*$/i;

export function isClearPhrase(text: string): boolean {
  return CLEAR_RE.test(text.trim());
}

export function forgetChannel(channelId: string): number {
  return clearConversation(channelId);
}

/**
 * Reply to a message with per-channel conversational memory. Returns the reply
 * text, or null when the local model is unavailable. Stores both turns so the
 * conversation continues until cleared.
 */
export async function converse(channelId: string, speaker: string, text: string): Promise<string | null> {
  if (!(await ollamaAvailable())) return null;
  const history = getConversation(channelId);
  const userTurn = `${speaker}: ${text}`.slice(0, 1500);
  try {
    const reply = await ollamaChatMessages(SYSTEM, [...history, { role: 'user', content: userTurn }], {
      maxTokens: 400,
      timeoutMs: 60_000,
    });
    addConversationTurn(channelId, 'user', userTurn);
    addConversationTurn(channelId, 'assistant', reply);
    return reply.slice(0, 1900);
  } catch (err) {
    if (err instanceof OllamaBusyError)
      return 'One sec — thinking about something else. Try again in a moment.';
    console.warn('[ai] converse failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
