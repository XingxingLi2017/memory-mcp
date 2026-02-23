import { cut_for_search } from "jieba-wasm";

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/**
 * Segment text for FTS5 indexing.
 * CJK text is segmented using jieba; Latin text passes through unchanged.
 * Returns space-separated tokens suitable for unicode61 FTS5 tokenizer.
 */
export function segmentText(text: string): string {
  if (!CJK_RE.test(text)) return text;
  // cut_for_search produces sub-words + compound words for best recall
  const tokens = cut_for_search(text);
  return tokens.join(" ");
}

/**
 * Segment a search query for FTS5 matching.
 * Returns individual tokens (CJK segmented, Latin as-is).
 */
export function segmentQuery(query: string): string[] {
  if (!CJK_RE.test(query)) {
    return query.match(/[A-Za-z0-9_]+/g) ?? [];
  }
  return cut_for_search(query).filter((t: string) => t.trim().length > 0);
}
