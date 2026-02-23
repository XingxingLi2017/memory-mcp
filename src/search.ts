import type Database from "better-sqlite3";
import { isFtsAvailable } from "./db.js";

export type SearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
};

/**
 * Build an FTS5 match expression from a raw query string.
 * Tokenizes on word boundaries (latin) and individual characters (CJK).
 * Uses OR for better recall with BM25 ranking.
 */
function buildFtsQuery(raw: string): string | null {
  // Split into latin words and individual CJK characters
  const latinTokens: string[] = [];
  const cjkTokens: string[] = [];
  const latinWords = raw.match(/[A-Za-z0-9_]+/g);
  if (latinWords) latinTokens.push(...latinWords);
  // Match individual CJK characters (FTS5 unicode61 indexes them as single tokens)
  const cjkChars = raw.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  if (cjkChars) cjkTokens.push(...cjkChars);

  const allTokens = [...latinTokens, ...cjkTokens].map((t) => t.trim()).filter(Boolean);
  if (allTokens.length === 0) return null;

  // For CJK: use NEAR to keep characters close together (simulates phrase matching)
  // For latin: use OR for recall
  const parts: string[] = [];
  if (cjkTokens.length > 1) {
    const quoted = cjkTokens.map((t) => `"${t.replaceAll('"', "")}"`).join(" ");
    parts.push(`NEAR(${quoted}, 5)`);
  }
  // Add all tokens as OR fallback
  const orPart = allTokens.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR ");
  parts.push(orPart);

  // NEAR first (higher relevance), OR as fallback
  return parts.length > 1 ? `(${parts[0]}) OR (${parts[1]})` : parts[0]!;
}

/**
 * Convert BM25 rank (negative, lower = better match) to a 0–1 score.
 * FTS5 rank values are negative; more negative = better match.
 */
function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 0;
  const absRank = Math.abs(rank);
  if (absRank === 0) return 0;
  // Normalize: absRank is typically very small (1e-6 range),
  // so use log scale to spread scores between 0 and 1
  return Math.min(1, Math.max(0, 1 + Math.log10(absRank) / 10));
}

const SNIPPET_MAX_CHARS = 700;

/**
 * Search memory chunks using FTS5 full-text search.
 */
export function searchMemory(
  db: Database.Database,
  query: string,
  opts?: { maxResults?: number; minScore?: number },
): SearchResult[] {
  const cleaned = query.trim();
  if (!cleaned) return [];

  const maxResults = opts?.maxResults ?? 6;
  const minScore = opts?.minScore ?? 0.01;

  if (!isFtsAvailable(db)) {
    // Fallback: simple LIKE search
    return searchLike(db, cleaned, maxResults);
  }

  const ftsQuery = buildFtsQuery(cleaned);
  if (!ftsQuery) return searchLike(db, cleaned, maxResults);

  try {
    const rows = db
      .prepare(
        `SELECT id, path, source, start_line, end_line, text, rank
         FROM chunks_fts
         WHERE chunks_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, maxResults * 3) as Array<{
      id: string;
      path: string;
      source: string;
      start_line: number;
      end_line: number;
      text: string;
      rank: number;
    }>;

    return rows
      .map((row) => ({
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        score: bm25RankToScore(row.rank),
        snippet: row.text.slice(0, SNIPPET_MAX_CHARS),
        source: row.source,
      }))
      .filter((r) => r.score >= minScore)
      .slice(0, maxResults);
  } catch {
    return searchLike(db, cleaned, maxResults);
  }
}

/**
 * Fallback search using LIKE (when FTS5 is not available).
 */
function searchLike(
  db: Database.Database,
  query: string,
  maxResults: number,
): SearchResult[] {
  const pattern = `%${query}%`;
  const rows = db
    .prepare(
      `SELECT id, path, source, start_line, end_line, text
       FROM chunks
       WHERE text LIKE ?
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(pattern, maxResults) as Array<{
    id: string;
    path: string;
    source: string;
    start_line: number;
    end_line: number;
    text: string;
  }>;

  return rows.map((row, i) => ({
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    score: 1 / (1 + i),
    snippet: row.text.slice(0, SNIPPET_MAX_CHARS),
    source: row.source,
  }));
}
