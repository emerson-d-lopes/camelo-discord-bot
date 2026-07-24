import { addConversationTurn, clearConversation, getConversation } from '../../db.js';
import { ASSISTANT_MODEL, OllamaBusyError, ollamaAvailable, ollamaChatMessages } from '../../ollama.js';

const SYSTEM =
  'You are Camelô, a friendly music-savvy bot in a Discord channel (English and Brazilian ' +
  'Portuguese). Chat naturally and keep it fairly short — this is a casual channel. You know music ' +
  'well and love talking about it: artists, genres, recommendations, what fits a mood. ' +
  'You DO have memory of this conversation: the messages above are the real history. ' +
  'When the user refers back to something said earlier ("what did I say", "my favorite X", ' +
  '"remember?"), answer directly and factually from that history — never claim you cannot store ' +
  'information and never deflect the question with a joke. Only if the answer is genuinely not in ' +
  'the history, say you do not have it. Users can also ask you to play songs — if someone clearly ' +
  'wants a specific song played, tell them to just say it (e.g. "toca <song>") since a separate ' +
  'system handles playback. Reply in the same language as the user. Messages are prefixed with the ' +
  "speaker's name; do not prefix your own reply. " +
  'IMPORTANT: keep every reply short — aim for under ~1500 characters, a few short paragraphs at ' +
  'most — so it fits in a single Discord message. If the topic is large (a long itinerary, a big ' +
  'list), give a condensed version and OFFER to expand on any part the user picks, rather than ' +
  'writing a long answer. Always end with a complete sentence — never trail off mid-thought.';

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
      model: ASSISTANT_MODEL,
      think: false,
      // Generous ceiling so the model reaches a natural end (emits its stop
      // token) instead of being chopped mid-sentence by the token limit. The
      // system prompt keeps replies short; chunking is the backstop if one
      // still overshoots Discord's 2000-char cap.
      maxTokens: 1200,
      timeoutMs: 120_000,
    });
    // The model sometimes self-prefixes ("Camelô: …") despite the system prompt.
    // Strip before storing so past turns stay clean and don't reinforce it.
    const clean = reply.replace(/^\s*camel[ôo]\s*:\s*/i, '').trim();
    addConversationTurn(channelId, 'user', userTurn);
    addConversationTurn(channelId, 'assistant', clean);
    // Return the full text — the caller splits it across Discord's 2000-char limit.
    return clean;
  } catch (err) {
    if (err instanceof OllamaBusyError)
      return 'One sec — thinking about something else. Try again in a moment.';
    console.warn('[ai] converse failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
