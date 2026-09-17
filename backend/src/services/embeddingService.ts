import { pipeline, FeatureExtractionPipeline } from '@xenova/transformers';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { EMBEDDING_CONFIG } from '../config/constants';

dotenv.config();

// File-only logging (no console output)
const LOG_PATH = path.join(__dirname, '../../api-debug.log');
function logToFile(message: string) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(LOG_PATH, `[${timestamp}] ${message}\n`);
}

// Global pipeline instance
let embeddingPipeline: FeatureExtractionPipeline | null = null;
let pipelineLoading: Promise<FeatureExtractionPipeline> | null = null;

async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (embeddingPipeline) return embeddingPipeline;
  if (!pipelineLoading) {
    logToFile(`Initializing Xenova local embedding model: ${EMBEDDING_CONFIG.MODEL_ID}`);
    pipelineLoading = pipeline('feature-extraction', EMBEDDING_CONFIG.MODEL_ID, {
      quantized: true,
      revision: EMBEDDING_CONFIG.MODEL_REVISION,
    }).then(loaded => {
      embeddingPipeline = loaded;
      return loaded;
    }).finally(() => { pipelineLoading = null; });
  }
  return pipelineLoading;
}

/**
 * Generate embedding for a single text using Xenova's bge-base-en-v1.5 model (768d)
 * @param text - The text to generate embedding for
 * @returns Array of 768 floats representing the embedding
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  try {
    if (!text || text.trim().length === 0) {
      throw new Error('Text cannot be empty');
    }

    const generator = await getPipeline();
    const result = await generator(text, {
      pooling: 'mean',
      normalize: true
    });

    const embedding = Array.from(result.data) as number[];
    if (embedding.length !== EMBEDDING_CONFIG.EMBEDDING_DIMENSION) {
      throw new Error(
        `Embedding dimension mismatch: model produced ${embedding.length}, ` +
        `config expects ${EMBEDDING_CONFIG.EMBEDDING_DIMENSION}. ` +
        `Check EMBEDDING_MODEL_ID/EMBEDDING_DIMENSION and reindex.`
      );
    }
    return embedding;
  } catch (error) {
    console.error('Error generating embedding:', error);
    throw new Error(`Embedding generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Generate embeddings for multiple texts in batch
 * @param texts - Array of texts to generate embeddings for
 * @param batchSize - Number of texts to process in parallel
 * @returns Array of embeddings (each embedding is an array of 768 floats)
 */
export async function generateEmbeddings(
  texts: string[],
  batchSize: number = 5
): Promise<number[][]> {
  if (!texts || texts.length === 0) {
    return [];
  }

  const embeddings: number[][] = [];
  const totalBatches = Math.ceil(texts.length / batchSize);

  logToFile(`Generating local embeddings for ${texts.length} texts in ${totalBatches} batches...`);

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchNumber = Math.floor(i / batchSize) + 1;

    try {
      logToFile(`Processing batch ${batchNumber}/${totalBatches} (${batch.length} items)...`);

      // Process batch in parallel
      const batchEmbeddings = await Promise.all(
        batch.map(text => generateEmbedding(text))
      );

      embeddings.push(...batchEmbeddings);
    } catch (error) {
      console.error(`Error processing batch ${batchNumber}:`, error);
      throw error;
    }
  }

  logToFile(`✓ Generated ${embeddings.length} embeddings successfully`);
  return embeddings;
}

/**
 * Simple in-memory cache for embeddings to avoid redundant API calls
 * Useful for frequently asked questions or common queries
 */
class EmbeddingCache {
  private cache: Map<string, number[]>;
  private maxSize: number;

  constructor(maxSize: number = 1000) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(text: string): number[] | undefined {
    return this.cache.get(text);
  }

  set(text: string, embedding: number[]): void {
    // Simple LRU-like behavior: remove oldest if cache is full
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(text, embedding);
  }

  has(text: string): boolean {
    return this.cache.has(text);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

// Global cache instance
const embeddingCache = new EmbeddingCache(1000);

/**
 * Generate embedding with caching
 * @param text - The text to generate embedding for
 * @param useCache - Whether to use cache (default: true)
 * @returns Array of 768 floats representing the embedding
 */
export async function generateEmbeddingCached(
  text: string,
  useCache: boolean = true
): Promise<number[]> {
  if (useCache && embeddingCache.has(text)) {
    logToFile('Cache hit for embedding');
    return embeddingCache.get(text)!;
  }

  const embedding = await generateEmbedding(text);

  if (useCache) {
    embeddingCache.set(text, embedding);
  }

  return embedding;
}

/**
 * Embed a *query* (or response sentence) for retrieval.
 * BGE bge-base-en-v1.5 requires the asymmetric query prefix; documents stay raw.
 * Uses the same cache, keyed on the prefixed text so it never collides with doc embeddings.
 */
export async function embedQuery(text: string, useCache: boolean = true): Promise<number[]> {
  const prefixed = EMBEDDING_CONFIG.QUERY_PREFIX + text;
  return generateEmbeddingCached(prefixed, useCache);
}

/**
 * Convert embedding array to PostgreSQL vector format
 * @param embedding - Array of floats
 * @returns String in PostgreSQL vector format: "[0.1,0.2,0.3,...]"
 */
export function embeddingToPostgresVector(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/**
 * Get cache statistics
 */
export function getCacheStats() {
  return {
    size: embeddingCache.size(),
    maxSize: 1000
  };
}

/**
 * Clear the embedding cache
 */
export function clearCache() {
  embeddingCache.clear();
}
