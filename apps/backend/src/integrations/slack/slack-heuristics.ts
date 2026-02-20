export interface DirectedAtBotInput {
  text: string;
  botUserId?: string;
  wakeWords: string[];
  isThreadReply: boolean;
}

const DIRECT_REQUEST_PATTERN = /\b(can|could|would|will|please|help)\s+you\b/i;
const SECOND_PERSON_PATTERN = /\b(can you|could you|would you|please|help|thoughts|what do you think)\b/i;

export function normalizeWakeWords(wakeWords: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const wakeWord of wakeWords) {
    const cleaned = wakeWord.trim().toLowerCase();
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }

    seen.add(cleaned);
    normalized.push(cleaned);
  }

  return normalized;
}

export function isDirectedAtBot(input: DirectedAtBotInput): boolean {
  const text = input.text.trim();
  if (!text) {
    return false;
  }

  if (input.botUserId && includesBotMention(text, input.botUserId)) {
    return true;
  }

  const lower = text.toLowerCase();
  const wakeWords = normalizeWakeWords(input.wakeWords);

  if (wakeWords.some((wakeWord) => matchesWakeWord(lower, wakeWord))) {
    return true;
  }

  if (DIRECT_REQUEST_PATTERN.test(lower)) {
    return true;
  }

  if (input.isThreadReply && text.includes("?") && SECOND_PERSON_PATTERN.test(lower)) {
    return true;
  }

  return false;
}

export function stripBotMention(text: string, botUserId?: string): string {
  if (!botUserId) {
    return text.trim();
  }

  const mentionPattern = new RegExp(`<@${escapeRegExp(botUserId)}>`, "g");
  return text.replace(mentionPattern, "").replace(/\s+/g, " ").trim();
}

function includesBotMention(text: string, botUserId: string): boolean {
  return text.includes(`<@${botUserId}>`);
}

function matchesWakeWord(text: string, wakeWord: string): boolean {
  const escapedWakeWord = escapeRegExp(wakeWord);
  const pattern = new RegExp(`(^|\\b)(hey\\s+|hi\\s+)?${escapedWakeWord}(\\b|[:!,])`, "i");
  return pattern.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
