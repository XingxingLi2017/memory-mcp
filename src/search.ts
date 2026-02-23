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
 * With trigram tokenizer, both CJK substrings (≥3 chars) and Latin words work directly.
 * Returns separate NEAR (precision) and OR (recall) expressions for CJK.
 */
function buildFtsQueries(raw: string): FtsQueries | null {
  const latinTokens: string[] = [];
  const latinWords = raw.match(/[A-Za-z0-9_]+/g);
  if (latinWords) latinTokens.push(...latinWords);

  // Extract CJK runs (contiguous sequences, not single chars)
  const cjkRuns = raw.match(/[\u4e00-\u9fff\u3400-\u4dbf]{3,}/g) ?? [];
  // Also extract 2-char CJK that trigram can't match, for LIKE fallback later
  const cjkShort = raw.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2}/g) ?? [];

  const allTokens = [...latinTokens, ...cjkRuns].filter(Boolean);
  if (allTokens.length === 0 && cjkShort.length === 0) return null;

  // If we only have short CJK (<3 chars), return null to trigger LIKE fallback
  if (allTokens.length === 0) return null;

  const orExpr = allTokens.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR ");
  return { nearExpr: null, orExpr };
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

export type SearchOpts = {
  maxResults?: number;
  minScore?: number;
  /** ISO 8601 timestamp — only include chunks from files modified after this time */
  after?: string;
  /** ISO 8601 timestamp — only include chunks from files modified before this time */
  before?: string;
};

/**
 * Search memory chunks using FTS5 full-text search.
 */
export function searchMemory(
  db: Database.Database,
  query: string,
  opts?: SearchOpts,
): SearchResult[] {
  const cleaned = query.trim();
  if (!cleaned) return [];

  const maxResults = opts?.maxResults ?? 6;
  const minScore = opts?.minScore ?? 0.01;

  // Build set of allowed paths based on time filters
  const allowedPaths = buildTimeFilter(db, opts?.after, opts?.before);
  const pathFilter = (r: SearchResult) => !allowedPaths || allowedPaths.has(r.path);

  if (!isFtsAvailable(db)) {
    const results = searchLike(db, cleaned, maxResults, allowedPaths);
    bumpAccessCount(db, results);
    return applyAccessBoost(db, results);
  }

  const queries = buildFtsQueries(cleaned);
  if (!queries) {
    const results = searchLike(db, cleaned, maxResults, allowedPaths);
    bumpAccessCount(db, results);
    return applyAccessBoost(db, results);
  }

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
      const nearRows = stmt.all(queries.nearExpr, maxResults * 3) as FtsRow[];
      results = nearRows.map(toResult).filter((r) => r.score >= minScore && pathFilter(r)).slice(0, maxResults);
    }

    // Step 2: OR fallback if NEAR didn't fill maxResults
    if (results.length < maxResults) {
      const orRows = stmt.all(queries.orExpr, maxResults * 3) as FtsRow[];
      const seenIds = new Set(results.map((r) => `${r.path}:${r.startLine}`));
      for (const row of orRows) {
        const key = `${row.path}:${row.start_line}`;
        if (seenIds.has(key)) continue;
        const mapped = toResult(row);
        if (mapped.score >= minScore && pathFilter(mapped)) {
          results.push(mapped);
          seenIds.add(key);
          if (results.length >= maxResults) break;
        }
      }
    }

    bumpAccessCount(db, results);
    return applyAccessBoost(db, results);
  } catch {
    const results = searchLike(db, cleaned, maxResults, allowedPaths);
    bumpAccessCount(db, results);
    return applyAccessBoost(db, results);
  }
}

/**
 * Fallback search using LIKE (when FTS5 is not available).
 */
function searchLike(
  db: Database.Database,
  query: string,
  maxResults: number,
  allowedPaths?: Set<string> | null,
): SearchResult[] {
  const escaped = query.replace(/[%_]/g, "\\$&");
  const pattern = `%${escaped}%`;
  const rows = db
    .prepare(
      `SELECT id, path, source, start_line, end_line, text
       FROM chunks
       WHERE text LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(pattern, maxResults * 3) as Array<{
    id: string;
    path: string;
    source: string;
    start_line: number;
    end_line: number;
    text: string;
  }>;

  return rows
    .filter((row) => !allowedPaths || allowedPaths.has(row.path))
    .slice(0, maxResults)
    .map((row, i) => ({
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: 1 / (1 + i),
      snippet: row.text.slice(0, SNIPPET_MAX_CHARS),
      source: row.source,
    }));
}

/**
 * Build a set of allowed paths based on time filters.
 * Returns null if no time filter is active (= allow all).
 */
function buildTimeFilter(
  db: Database.Database,
  after?: string,
  before?: string,
): Set<string> | null {
  if (!after && !before) return null;

  const conditions: string[] = [];
  const params: number[] = [];
  if (after) {
    conditions.push("mtime >= ?");
    params.push(new Date(after).getTime());
  }
  if (before) {
    conditions.push("mtime <= ?");
    params.push(new Date(before).getTime());
  }

  const rows = db
    .prepare(`SELECT path FROM files WHERE ${conditions.join(" AND ")}`)
    .all(...params) as Array<{ path: string }>;
  return new Set(rows.map((r) => r.path));
}

/**
 * Increment access_count for chunks matching search results.
 */
function bumpAccessCount(db: Database.Database, results: SearchResult[]): void {
  if (results.length === 0) return;
  try {
    const stmt = db.prepare(
      `UPDATE chunks SET access_count = access_count + 1 WHERE path = ? AND start_line = ?`,
    );
    const tx = db.transaction(() => {
      for (const r of results) {
        stmt.run(r.path, r.startLine);
      }
    });
    tx();
  } catch (err) {
    console.error("[memory-mcp] bumpAccessCount error:", err);
  }
}

/**
 * Boost scores based on access_count and re-sort.
 * Blended score = 0.85 * base_score + 0.15 * log2(1 + access_count) / 10
 * The access boost is capped so it nudges ranking without overwhelming relevance.
 */
function applyAccessBoost(db: Database.Database, results: SearchResult[]): SearchResult[] {
  if (results.length <= 1) return results;
  try {
    const stmt = db.prepare(
      `SELECT access_count FROM chunks WHERE path = ? AND start_line = ?`,
    );
    for (const r of results) {
      const row = stmt.get(r.path, r.startLine) as { access_count: number } | undefined;
      const count = row?.access_count ?? 0;
      if (count > 0) {
        const boost = Math.min(1, Math.log2(1 + count) / 10);
        r.score = 0.85 * r.score + 0.15 * boost;
      }
    }
    results.sort((a, b) => b.score - a.score);
  } catch (err) {
    console.error("[memory-mcp] applyAccessBoost error:", err);
  }
  return results;
}
