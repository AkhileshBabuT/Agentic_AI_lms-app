/** Generation and retrieval settings, independent from grading and dormant OCR. */
function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    // Never include environment values: an accidentally pasted key must stay private.
    throw new Error(`Invalid ${name} configuration`);
  }
  return value;
}

function courseAllowlist(): number[] | undefined {
  const raw = process.env.RAG_ENABLED_COURSES;
  if (raw === undefined || raw.trim() === '*') return undefined;
  if (raw.trim() === '') return [];
  const ids = raw.split(',').map(value => Number(value.trim()));
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid RAG_ENABLED_COURSES configuration');
  return [...new Set(ids)];
}

export const RAG_CONFIG = {
  ENABLED: process.env.RAG_ENABLED !== 'false',
  COURSE_ALLOWLIST: courseAllowlist(),
  VECTOR_CANDIDATES: boundedInteger('RAG_VECTOR_CANDIDATES', 40, 1, 100),
  LEXICAL_CANDIDATES: boundedInteger('RAG_LEXICAL_CANDIDATES', 40, 1, 100),
  FUSION_K: boundedInteger('RAG_FUSION_K', 60, 1, 1000),
  RERANK_CANDIDATES: boundedInteger('RAG_RERANK_CANDIDATES', 40, 1, 100),
  MAX_PASSAGES: boundedInteger('RAG_MAX_PASSAGES', 8, 1, 20),
  CONTEXT_TOKEN_BUDGET: boundedInteger('RAG_CONTEXT_TOKEN_BUDGET', 5000, 500, 16000),
  RERANK_TIMEOUT_MS: boundedInteger('RAG_RERANK_TIMEOUT_MS', 1500, 50, 10000),
  RERANK_ENABLED: process.env.RAG_RERANK_ENABLED === 'true',
  QUESTION_MAX_CHARS: boundedInteger('RAG_QUESTION_MAX_CHARS', 8000, 100, 32000),
  EMBEDDING_TIMEOUT_MS: boundedInteger('RAG_EMBEDDING_TIMEOUT_MS', 60000, 1000, 300000),
  MODEL_QUEUE_LIMIT: boundedInteger('RAG_MODEL_QUEUE_LIMIT', 20, 1, 100),
} as const;

export interface VtArcConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  concurrency: number;
  maxQueue: number;
  maxRetries: number;
  maxOutputTokens: number;
  maxResponseBytes: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

/** Only the documented ARC gateway receives the secret; redirects are also denied. */
export function validateArcBaseUrl(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('Invalid VT_ARC_BASE_URL configuration'); }
  if (url.protocol !== 'https:' || url.hostname !== 'llm-api.arc.vt.edu' ||
      (url.port && url.port !== '443') || url.username || url.password ||
      url.search || url.hash || url.pathname.replace(/\/$/, '') !== '/api/v1') {
    throw new Error('VT_ARC_BASE_URL must be the documented HTTPS ARC inference gateway');
  }
  return 'https://llm-api.arc.vt.edu/api/v1';
}

/** Read lazily, after dotenv initialization. Presence never implies authenticated access. */
export function getVtArcConfig(): VtArcConfig {
  const apiKey = process.env.VT_ARC_API_KEY?.trim();
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('VT_ARC_API_KEY is missing or invalid');
  const model = process.env.VT_ARC_MODEL?.trim();
  if (!model || !/^[\w./:-]{1,200}$/.test(model)) {
    throw new Error('VT_ARC_MODEL must explicitly identify a verified ARC chat model');
  }
  if (/legacy-tool-calling/i.test(model)) {
    throw new Error('VT_ARC_MODEL must not enable legacy server tools for course-only RAG');
  }
  const effort = process.env.VT_ARC_REASONING_EFFORT;
  if (effort && !['low', 'medium', 'high'].includes(effort)) {
    throw new Error('Invalid VT_ARC_REASONING_EFFORT configuration');
  }
  return {
    apiKey,
    baseUrl: validateArcBaseUrl(process.env.VT_ARC_BASE_URL || 'https://llm-api.arc.vt.edu/api/v1'),
    model,
    timeoutMs: boundedInteger('VT_ARC_TIMEOUT_MS', 45000, 1000, 120000),
    concurrency: boundedInteger('VT_ARC_CONCURRENCY', 2, 1, 4),
    maxQueue: boundedInteger('VT_ARC_MAX_QUEUE', 20, 0, 100),
    maxRetries: boundedInteger('VT_ARC_MAX_RETRIES', 1, 0, 2),
    maxOutputTokens: boundedInteger('VT_ARC_MAX_OUTPUT_TOKENS', 1500, 64, 8000),
    maxResponseBytes: boundedInteger('VT_ARC_MAX_RESPONSE_BYTES', 1048576, 1024, 4194304),
    reasoningEffort: effort as VtArcConfig['reasoningEffort'],
  };
}
