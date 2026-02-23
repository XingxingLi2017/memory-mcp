import type Database from "better-sqlite3";
import { isFtsAvailable, isVecAvailable } from "./db.js";
import { segmentQuery } from "./segment.js";
import { embedText, vectorToBuffer } from "./embedding.js";

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
 * Uses jieba segmentation for CJK, word splitting for Latin.
 * Returns null if no valid tokens found (caller should use LIKE fallback).
 */
function buildFtsQuery(raw: string): string | null {
  const tokens = segmentQuery(raw).filter((t) => t.trim().length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR ");
}

/**
 * Convert BM25 rank (negative, lower = better match) to a 0–1 score.
 * FTS5 rank values are negative; more negative = better match.
 */
function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 0;
  const absRank = Math.abs(rank);
  if (absRank === 0) return 0;
  return Math.min(1, Math.max(0, 1 + Math.log10(absRank) / 10));
}

const SNIPPET_MAX_CHARS = 700;

/** Rough chars-to-tokens ratio (conservative for mixed CJK/Latin) */
const CHARS_PER_TOKEN = 3;
/** Estimated tokens per result for JSON metadata (path, score, lines, etc.) */
const METADATA_TOKENS = 30;
/** Default token budget per search */
const DEFAULT_TOKEN_MAX = 4096;

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
  /** Maximum total tokens to return (controls snippet truncation). Default: 2048 */
  tokenMax?: number;
  /** ISO 8601 timestamp — only include chunks from files modified after this time */
  after?: string;
  /** ISO 8601 timestamp — only include chunks from files modified before this time */
  before?: string;
};

/**
 * Search memory chunks using hybrid search (BM25 + vector similarity).
 * Falls back to FTS-only or LIKE if vector search is unavailable.
 */
export async function searchMemory(
  db: Database.Database,
  query: string,
  opts?: SearchOpts,
): Promise<SearchResult[]> {
  const cleaned = query.trim();
  if (!cleaned) return [];

  const tokenMax = opts?.tokenMax ?? DEFAULT_TOKEN_MAX;
  const maxResults = opts?.maxResults ?? Math.min(20, Math.max(1, Math.floor(tokenMax / (200 + METADATA_TOKENS))));
  const minScore = opts?.minScore ?? 0.01;
  // Dynamic snippet size based on token budget
  const snippetTokens = Math.max(50, Math.floor((tokenMax - METADATA_TOKENS * maxResults) / maxResults));
  const snippetMaxChars = Math.min(SNIPPET_MAX_CHARS, snippetTokens * CHARS_PER_TOKEN);

  const allowedPaths = buildTimeFilter(db, opts?.after, opts?.before);
  const pathFilter = (r: SearchResult) => !allowedPaths || allowedPaths.has(r.path);

  const ftsOk = isFtsAvailable(db);
  const vecOk = isVecAvailable(db);

  // FTS search
  let ftsResults: SearchResult[] = [];
  if (ftsOk) {
    const ftsQuery = buildFtsQuery(cleaned);
    if (ftsQuery) {
      try {
        const rows = db
          .prepare(
            `SELECT f.id, f.path, f.source, f.start_line, f.end_line, c.text, f.rank
             FROM chunks_fts f
             JOIN chunks c ON c.id = f.id
             WHERE chunks_fts MATCH ?
             ORDER BY f.rank
             LIMIT ?`,
          )
          .all(ftsQuery, maxResults * 3) as FtsRow[];
        ftsResults = rows
          .map((row) => ({
            path: row.path,
            startLine: row.start_line,
            endLine: row.end_line,
            score: bm25RankToScore(row.rank),
            snippet: row.text.slice(0, snippetMaxChars),
            source: row.source,
          }))
          .filter((r) => r.score >= minScore && pathFilter(r));
      } catch {}
    }
  }

  // Vector search
  let vecResults: SearchResult[] = [];
  if (vecOk) {
    try {
      const queryVec = await embedText(cleaned);
      const queryBuf = vectorToBuffer(queryVec);
      const vecRows = db
        .prepare(
          `SELECT v.id, v.distance, c.path, c.source, c.start_line, c.end_line, c.text
           FROM chunks_vec v
           JOIN chunks c ON c.id = v.id
           WHERE embedding MATCH ?
           ORDER BY distance
           LIMIT ?`,
        )
        .all(queryBuf, maxResults * 3) as Array<{
        id: string;
        distance: number;
        path: string;
        source: string;
        start_line: number;
        end_line: number;
        text: string;
      }>;
      vecResults = vecRows
        .map((row) => ({
          path: row.path,
          startLine: row.start_line,
          endLine: row.end_line,
          score: 1 - row.distance, // cosine distance → similarity
          snippet: row.text.slice(0, snippetMaxChars),
          source: row.source,
        }))
        .filter((r) => r.score >= minScore && pathFilter(r));
    } catch (err) {
      console.error("[memory-mcp] vector search error:", err);
    }
  }

  // Hybrid merge or single-source
  let results: SearchResult[];
  if (ftsResults.length > 0 && vecResults.length > 0) {
    results = mergeHybrid(ftsResults, vecResults, 0.5, 0.5);
  } else if (vecResults.length > 0) {
    results = vecResults;
  } else if (ftsResults.length > 0) {
    results = ftsResults;
  } else {
    results = searchLike(db, cleaned, maxResults, snippetMaxChars, allowedPaths);
  }

  results = results.slice(0, maxResults);
  bumpAccessCount(db, results);
  return applyAccessBoost(db, results);
}

/**
 * Min-max normalize scores to 0-1 range.
 * NOTE: mutates results in-place for efficiency.
 */
function normalizeScores(results: SearchResult[]): void {
  if (results.length === 0) return;
  if (results.length === 1) {
    results[0]!.score = 1.0;
    return;
  }
  const scores = results.map((r) => r.score);
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  if (max === min) {
    for (const r of results) r.score = 1.0;
    return;
  }
  for (const r of results) {
    r.score = (r.score - min) / (max - min);
  }
}

/**
 * Merge FTS and vector search results with weighted scoring.
 * Normalizes both score sets to 0-1 before combining.
 * score = α * bm25_score + β * vector_score
 */
function mergeHybrid(
  ftsResults: SearchResult[],
  vecResults: SearchResult[],
  ftsWeight: number,
  vecWeight: number,
): SearchResult[] {
  // Normalize each set independently so scales are comparable
  normalizeScores(ftsResults);
  normalizeScores(vecResults);

  const byKey = new Map<string, { ftsScore: number; vecScore: number; result: SearchResult }>();

  for (const r of ftsResults) {
    const key = `${r.path}:${r.startLine}`;
    byKey.set(key, { ftsScore: r.score, vecScore: 0, result: r });
  }
  for (const r of vecResults) {
    const key = `${r.path}:${r.startLine}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.vecScore = r.score;
    } else {
      byKey.set(key, { ftsScore: 0, vecScore: r.score, result: r });
    }
  }

  return Array.from(byKey.values())
    .map(({ ftsScore, vecScore, result }) => ({
      ...result,
      score: ftsWeight * ftsScore + vecWeight * vecScore,
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Fallback search using LIKE (when FTS5 is not available).
 */
function searchLike(
  db: Database.Database,
  query: string,
  maxResults: number,
  snippetMaxChars: number,
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
      snippet: row.text.slice(0, snippetMaxChars),
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
