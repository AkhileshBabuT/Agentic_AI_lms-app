function bounded(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
export const MATERIAL_INGESTION = {
  maxBytes: bounded('RAG_INGEST_MAX_BYTES', 50 * 1024 * 1024, 1024, 100 * 1024 * 1024),
  maxChunks: bounded('RAG_INGEST_MAX_CHUNKS', 5000, 1, 10000),
  maxPages: bounded('RAG_INGEST_MAX_PAGES', 1000, 1, 2000),
  maxExpandedBytes: bounded('RAG_INGEST_MAX_EXPANDED_BYTES', 200 * 1024 * 1024, 1024, 500 * 1024 * 1024),
  leaseSeconds: bounded('RAG_INGEST_LEASE_SECONDS', 120, 30, 600),
  heartbeatSeconds: bounded('RAG_INGEST_HEARTBEAT_SECONDS', 15, 1, 20),
  pollMs: bounded('RAG_INGEST_POLL_MS', 2000, 100, 30000),
  embeddingBatch: bounded('RAG_INGEST_EMBED_BATCH', 2, 1, 5),
  maxAttempts: bounded('RAG_INGEST_MAX_ATTEMPTS', 3, 1, 5),
  maxChunkTokens: bounded('RAG_INGEST_CHUNK_TOKENS', 450, 100, 450),
  chunkOverlapTokens: bounded('RAG_INGEST_OVERLAP_TOKENS', 64, 0, 80),
} as const;
