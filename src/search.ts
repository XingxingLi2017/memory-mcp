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
 * FTS5 query expressions returned by buildFtsQueries.
 * - nearExpr: NEAR query for CJK phrase matching (null if no CJK multi-char)
 * - orExpr: OR query for broad recall (always present)
 */
type FtsQueries = { nearExpr: string | null; orExpr: string };

/**
 * Build FTS5 match expressions from a raw query string.
 * Returns separate NEAR (precision) and OR (recall) expressions
 * so the caller can do a two-step search: NEAR first, OR fallback.
 */
function buildFtsQueries(raw: string): FtsQueries | null {
  const latinTokens: string[] = [];
  const cjkTokens: string[] = [];
  const latinWords = raw.match(/[A-Za-z0-9_]+/g);
  if (latinWords) latinTokens.push(...latinWords);
  const cjkChars = raw.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  if (cjkChars) cjkTokens.push(...cjkChars);

  const allTokens = [...latinTokens, ...cjkTokens].map((t) => t.trim()).filter(Boolean);
  if (allTokens.length === 0) return null;

  // NEAR expression: only when multiple CJK characters present
  let nearExpr: string | null = null;
  if (cjkTokens.length > 1) {
    const quoted = cjkTokens.map((t) => `"${t.replaceAll('"', "")}"`).join(" ");
    nearExpr = `NEAR(${quoted}, 5)`;
  }

  const orExpr = allTokens.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR ");
  return { nearExpr, orExpr };
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

type FtsRow = {
  id: string;
  path: string;
  source: string;
  start_line: number;
  end_line: number;
  text: string;
  rank: number;
};

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

  const queries = buildFtsQueries(cleaned);
  if (!queries) return searchLike(db, cleaned, maxResults);

  const stmt = db.prepare(
    `SELECT id, path, source, start_line, end_line, text, rank
     FROM chunks_fts
     WHERE chunks_fts MATCH ?
     ORDER BY rank
     LIMIT ?`,
  );

  const toResult = (row: FtsRow): SearchResult => ({
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    score: bm25RankToScore(row.rank),
    snippet: row.text.slice(0, SNIPPET_MAX_CHARS),
    source: row.source,
  });

  try {
    // Step 1: NEAR query for CJK precision (if available)
    let results: SearchResult[] = [];
    if (queries.nearExpr) {
      const nearRows = stmt.all(queries.nearExpr, maxResults) as FtsRow[];
      results = nearRows.map(toResult).filter((r) => r.score >= minScore);
    }

    // Step 2: OR fallback if NEAR didn't fill maxResults
    if (results.length < maxResults) {
      const orRows = stmt.all(queries.orExpr, maxResults * 3) as FtsRow[];
      const seenIds = new Set(results.map((r) => `${r.path}:${r.startLine}`));
      for (const row of orRows) {
        const key = `${row.path}:${row.start_line}`;
        if (seenIds.has(key)) continue;
        const mapped = toResult(row);
        if (mapped.score >= minScore) {
          results.push(mapped);
          seenIds.add(key);
          if (results.length >= maxResults) break;
        }
      }
    }

    return results;
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
