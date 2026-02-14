/**
 * Minimal markdown -> plain text conversion for tweeting.
 * Not a full markdown parser (keeps dependencies low); good enough for lore.
 */
export function markdownToTweetText(markdown: string): string {
  let s = String(markdown ?? '');

  // Normalize newlines
  s = s.replace(/\r\n/g, '\n');

  // Remove code fences but keep inner content
  s = s.replace(/```(\w+)?\n([\s\S]*?)```/g, (_m, _lang, inner) => String(inner ?? '').trim());

  // Inline code
  s = s.replace(/`([^`]+)`/g, '$1');

  // Images/links
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 $2');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 $2');

  // Headings
  s = s.replace(/^#{1,6}\s+/gm, '');

  // Bold/italic (best-effort; avoid complex nesting)
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/\*([^*\n]+)\*/g, '$1');
  s = s.replace(/_([^_\n]+)_/g, '$1');

  // Bullets
  s = s.replace(/^\s*[-*+]\s+/gm, '');

  // Extra whitespace
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.trim();

  return s;
}

export function truncateForTweet(text: string, maxChars = 280): string {
  const s = String(text ?? '').trim();
  if (s.length <= maxChars) return s;
  if (maxChars <= 1) return '…'.slice(0, maxChars);
  return `${s.slice(0, maxChars - 1).trimEnd()}…`;
}

