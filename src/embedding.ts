/**
 * Local embedding provider using node-llama-cpp + embeddinggemma-300M.
 * Lazy-loaded: model is only downloaded/loaded on first embedding request.
 * Gracefully unavailable if node-llama-cpp is not installed.
 */

const DEFAULT_MODEL = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

// Lazy-init state
let llamaInstance: unknown = null;
let embeddingModel: unknown = null;
let embeddingContext: unknown = null;
let dimensions: number | null = null;
let unavailable = false;

interface EmbeddingContext {
  getEmbeddingFor(text: string): Promise<{ vector: Float32Array }>;
  dispose(): Promise<void>;
}

async function ensureContext(): Promise<EmbeddingContext> {
  if (unavailable) throw new Error("node-llama-cpp not available");
  if (embeddingContext) return embeddingContext as EmbeddingContext;

  let nodeLlamaCpp: typeof import("node-llama-cpp");
  try {
    nodeLlamaCpp = await import("node-llama-cpp");
  } catch {
    unavailable = true;
    throw new Error("node-llama-cpp not installed — vector search disabled");
  }

  if (!llamaInstance) {
    llamaInstance = await nodeLlamaCpp.getLlama({ logLevel: nodeLlamaCpp.LlamaLogLevel.error });
  }
  if (!embeddingModel) {
    const modelPath = await nodeLlamaCpp.resolveModelFile(DEFAULT_MODEL);
    embeddingModel = await (llamaInstance as { loadModel(o: { modelPath: string }): Promise<unknown> }).loadModel({ modelPath });
  }
  if (!embeddingContext) {
    embeddingContext = await (embeddingModel as { createEmbeddingContext(): Promise<unknown> }).createEmbeddingContext();
  }
  return embeddingContext as EmbeddingContext;
}

/**
 * L2-normalize an embedding vector.
 */
function normalize(vec: number[]): number[] {
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (magnitude < 1e-10) return vec;
  return vec.map((v) => v / magnitude);
}

/**
 * Embed a single text string. Returns a normalized float32 vector.
 */
export async function embedText(text: string): Promise<number[]> {
  const ctx = await ensureContext();
  const result = await ctx.getEmbeddingFor(text);
  const vec = normalize(Array.from(result.vector));
  if (!dimensions) dimensions = vec.length;
  return vec;
}

/**
 * Embed multiple texts. Returns normalized float32 vectors.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const ctx = await ensureContext();
  const results: number[][] = [];
  for (const text of texts) {
    const result = await ctx.getEmbeddingFor(text);
    results.push(normalize(Array.from(result.vector)));
  }
  if (!dimensions && results.length > 0) dimensions = results[0]!.length;
  return results;
}

/**
 * Get the embedding dimension (768 for embeddinggemma-300M).
 * Returns null if no embedding has been computed yet.
 */
export function getEmbeddingDimensions(): number | null {
  return dimensions;
}

/**
 * Check if the embedding provider is available (model downloaded).
 * Result is cached after first successful check.
 */
let embeddingAvailableCache: boolean | null = null;
export async function isEmbeddingAvailable(): Promise<boolean> {
  if (unavailable) return false;
  if (embeddingAvailableCache !== null) return embeddingAvailableCache;
  try {
    const { resolveModelFile } = await import("node-llama-cpp");
    await resolveModelFile(DEFAULT_MODEL);
    embeddingAvailableCache = true;
    return true;
  } catch {
    embeddingAvailableCache = false;
    return false;
  }
}

/**
 * Convert a number[] to a Buffer for sqlite-vec storage.
 */
export function vectorToBuffer(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

/**
 * Convert a Buffer from sqlite-vec back to number[].
 */
export function bufferToVector(buf: Buffer): number[] {
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}
