import test from "node:test";
import assert from "node:assert/strict";
import {
  hashText,
  buildExtraDirAliases,
  chunkMarkdown,
  chunkJson,
  chunkJsonl,
  chunkYaml,
  chunkFile,
  deriveSessionRelPath,
} from "./internal.js";

// ---------------------------------------------------------------------------
// hashText
// ---------------------------------------------------------------------------

test("hashText returns consistent SHA256 hex", () => {
  const h1 = hashText("hello world");
  const h2 = hashText("hello world");
  assert.equal(h1, h2);
  assert.equal(h1.length, 64); // SHA256 hex = 64 chars
});

test("hashText differs for different inputs", () => {
  assert.notEqual(hashText("hello"), hashText("world"));
});

// ---------------------------------------------------------------------------
// buildExtraDirAliases
// ---------------------------------------------------------------------------

test("buildExtraDirAliases handles empty array", () => {
  const result = buildExtraDirAliases([]);
  assert.equal(result.size, 0);
});

test("buildExtraDirAliases uses basename for unique dirs", () => {
  const result = buildExtraDirAliases(["/home/user/vault", "/home/user/notes"]);
  assert.equal(result.get("/home/user/vault"), "vault");
  assert.equal(result.get("/home/user/notes"), "notes");
});

test("buildExtraDirAliases disambiguates collisions", () => {
  const result = buildExtraDirAliases(["/a/vault", "/b/vault"]);
  // Both basenames are "vault" — should prepend parent
  const aliases = [...result.values()];
  assert.equal(aliases.length, 2);
  assert.notEqual(aliases[0], aliases[1]); // they must differ
});

// ---------------------------------------------------------------------------
// chunkMarkdown
// ---------------------------------------------------------------------------

test("chunkMarkdown returns single chunk for short content", () => {
  const content = "# Hello\n\nThis is a short document.";
  const chunks = chunkMarkdown(content);
  assert.ok(chunks.length >= 1);
  assert.equal(chunks[0]!.startLine, 1);
});

test("chunkMarkdown splits by headings", () => {
  const content = [
    "# Section 1",
    "Content of section 1.",
    "",
    "# Section 2",
    "Content of section 2.",
    "",
    "# Section 3",
    "Content of section 3.",
  ].join("\n");

  // With a small token size to force splitting
  const chunks = chunkMarkdown(content, { tokens: 20, overlap: 0 });
  assert.ok(chunks.length > 1, `Expected multiple chunks, got ${chunks.length}`);

  // Each chunk should have valid line numbers
  for (const c of chunks) {
    assert.ok(c.startLine >= 1);
    assert.ok(c.endLine >= c.startLine);
    assert.ok(c.text.length > 0);
    assert.ok(c.hash.length === 64);
  }
});

test("chunkMarkdown preserves line numbers", () => {
  const content = "line1\nline2\nline3\nline4\nline5";
  const chunks = chunkMarkdown(content);
  assert.equal(chunks[0]!.startLine, 1);
});

// ---------------------------------------------------------------------------
// chunkJson
// ---------------------------------------------------------------------------

test("chunkJson splits top-level object keys", () => {
  const json = JSON.stringify({ a: 1, b: 2, c: 3 }, null, 2);
  const chunks = chunkJson(json);
  assert.ok(chunks.length > 0);
});

test("chunkJson handles array", () => {
  const json = JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }], null, 2);
  const chunks = chunkJson(json);
  assert.ok(chunks.length > 0);
});

test("chunkJson handles empty object", () => {
  const chunks = chunkJson("{}");
  // Empty object may produce 0 or 1 chunks depending on implementation
  assert.ok(chunks.length <= 1);
});

test("chunkJson handles invalid JSON gracefully", () => {
  const chunks = chunkJson("not valid json at all");
  // Should fall back to single chunk or empty
  assert.ok(chunks.length <= 1);
});

// ---------------------------------------------------------------------------
// chunkJsonl
// ---------------------------------------------------------------------------

test("chunkJsonl splits by lines", () => {
  const content = '{"a":1}\n{"b":2}\n{"c":3}';
  const chunks = chunkJsonl(content);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]!.startLine, 1);
  assert.equal(chunks[1]!.startLine, 2);
  assert.equal(chunks[2]!.startLine, 3);
});

test("chunkJsonl skips empty lines", () => {
  const content = '{"a":1}\n\n{"b":2}\n';
  const chunks = chunkJsonl(content);
  assert.equal(chunks.length, 2);
});

// ---------------------------------------------------------------------------
// chunkYaml
// ---------------------------------------------------------------------------

test("chunkYaml splits by top-level keys", () => {
  const yaml = "key1: value1\nkey2: value2\nkey3:\n  nested: true";
  const chunks = chunkYaml(yaml);
  assert.ok(chunks.length > 0);
});

test("chunkYaml splits by document separators", () => {
  const yaml = "doc1: true\n---\ndoc2: true\n---\ndoc3: true";
  const chunks = chunkYaml(yaml);
  assert.ok(chunks.length >= 2, `Expected >=2 chunks, got ${chunks.length}`);
});

// ---------------------------------------------------------------------------
// chunkFile — routing by extension
// ---------------------------------------------------------------------------

test("chunkFile routes .md to chunkMarkdown", () => {
  const chunks = chunkFile("# Title\nContent", "test.md");
  assert.ok(chunks.length >= 1);
});

test("chunkFile routes .json to chunkJson", () => {
  const chunks = chunkFile('{"key": "value"}', "test.json");
  assert.ok(chunks.length >= 1);
});

test("chunkFile routes .jsonl to chunkJsonl", () => {
  const chunks = chunkFile('{"a":1}\n{"b":2}', "test.jsonl");
  assert.equal(chunks.length, 2);
});

test("chunkFile routes .yaml to chunkYaml", () => {
  const chunks = chunkFile("key: value", "test.yaml");
  assert.ok(chunks.length >= 1);
});

test("chunkFile routes .yml to chunkYaml", () => {
  const chunks = chunkFile("key: value", "test.yml");
  assert.ok(chunks.length >= 1);
});

test("chunkFile routes .txt to chunkMarkdown", () => {
  const chunks = chunkFile("plain text content", "test.txt");
  assert.ok(chunks.length >= 1);
});

// ---------------------------------------------------------------------------
// deriveSessionRelPath
// ---------------------------------------------------------------------------

test("deriveSessionRelPath extracts session relative path", () => {
  // Copilot style: .../session-state/{uuid}/events.jsonl
  const result = deriveSessionRelPath("/home/user/.copilot/session-state/abc-123/events.jsonl");
  assert.ok(result.startsWith("sessions/"));
  assert.ok(result.endsWith(".jsonl"));
});
