const TELEGRAM_MAX_MESSAGE_LEN = 4096;

export function splitTelegramMessage(text: string, maxLen = TELEGRAM_MAX_MESSAGE_LEN): string[] {
  const normalized = text ?? "";
  if (normalized.length <= maxLen) return [normalized];

  const parts: string[] = [];
  let i = 0;
  while (i < normalized.length) {
    let end = Math.min(i + maxLen, normalized.length);
    // Try to split on a newline for readability.
    // Note: `slice(i, end)` is end-exclusive, so search from `end - 1`.
    const lastNewline = normalized.lastIndexOf("\n", end - 1);
    const minSplitAt = i + Math.floor(maxLen * 0.6);
    if (lastNewline >= minSplitAt) {
      const candidateEnd = lastNewline + 1;
      // Ensure we never exceed maxLen.
      if (candidateEnd > i && candidateEnd <= i + maxLen) {
        end = candidateEnd;
      }
    }
    parts.push(normalized.slice(i, end));
    i = end;
  }
  return parts;
}
