/**
 * Application-wide constants and configuration values
 * Centralized location for all magic numbers and configurable parameters
 */

// =====================================================
// VECTOR SEARCH CONFIGURATION
// =====================================================
export const VECTOR_SEARCH = {
  /** Default number of chunks to retrieve */
  DEFAULT_TOP_K: 20,

  /** Maximum number of chunks allowed */
  MAX_TOP_K: 100,

  /** Minimum similarity threshold (0-1) for considering a chunk relevant */
  MIN_SIMILARITY: 0.5,

  /** Higher minimum similarity for more precise searches */
  HIGH_PRECISION_SIMILARITY: 0.7,
} as const;

// =====================================================
// DOCUMENT PROCESSING CONFIGURATION
// =====================================================
export const DOCUMENT_PROCESSING = {
  /** Target words per chunk for document splitting */
  CHUNK_SIZE_WORDS: 300,

  /** Word overlap between consecutive chunks */
  CHUNK_OVERLAP_WORDS: 150,

  /** Maximum chunk size in words */
  MAX_CHUNK_SIZE_WORDS: 500,

  /** Minimum chunk size in words */
  MIN_CHUNK_SIZE_WORDS: 50,
} as const;

// =====================================================
// OCR SIDECAR CONFIGURATION (Unlimited-OCR)
// =====================================================
export const OCR_CONFIG = {
  /** OCR is used only when a sidecar URL is configured (and not force-disabled) */
  ENABLED: !!process.env.OCR_SIDECAR_URL && process.env.OCR_ENABLED !== 'false',

  /** Base URL of the FastAPI OCR sidecar */
  SIDECAR_URL: process.env.OCR_SIDECAR_URL || 'http://localhost:8100',

  /** PDFs averaging fewer words per page than this are treated as scanned -> OCR */
  MIN_WORDS_PER_PAGE: 40,

  /** Whole-document OCR timeout (large scanned decks are slow) */
  TIMEOUT_MS: 300_000,

  /** Groq vision model used for images when the sidecar is down (verify against console.groq.com/docs/models) */
  GROQ_VISION_FALLBACK_MODEL: process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
} as const;

// =====================================================
// AGENT CONFIGURATION
// =====================================================
export const AGENT_CONFIG = {
  /** Number of materials to search for chatbot context (recall for ranking + fallback) */
  CHATBOT_SEARCH_LIMIT: 30,

  /** Max retrieved chunks actually injected into the chatbot prompt (token budget) */
  CHATBOT_PROMPT_MAX_CHUNKS: 6,

  /** Max characters per chunk excerpt injected into the prompt */
  CHATBOT_PROMPT_MAX_CHARS_PER_CHUNK: 600,

  /** Maximum content length for verification (characters) */
  VERIFICATION_MAX_CONTENT_LENGTH: 20000, // Increased from 15000

  /** Web crawl timeout in milliseconds */
  WEB_CRAWL_TIMEOUT_MS: 15000, // Increased from 10000

  /** Maximum web search results to fetch */
  WEB_SEARCH_MAX_RESULTS: 5,

  /** Maximum content to fetch from web pages */
  WEB_CONTENT_MAX_LENGTH: 5000,
} as const;

// =====================================================
// EMBEDDING SERVICE CONFIGURATION
// =====================================================
export const EMBEDDING_CONFIG = {
  /** Local transformers.js embedding model (a change requires a full reindex — see reindexEmbeddings.ts) */
  MODEL_ID: process.env.EMBEDDING_MODEL_ID || 'Xenova/bge-base-en-v1.5',

  /** Asymmetric query prefix. bge-base-en-v1.5 requires it; bge-m3 uses '' (set via env on migration). */
  QUERY_PREFIX: process.env.EMBEDDING_QUERY_PREFIX
    ?? 'Represent this sentence for searching relevant passages: ',

  /** Must match both the model output and the pgvector column dimension */
  EMBEDDING_DIMENSION: parseInt(process.env.EMBEDDING_DIMENSION || '768', 10),

  /** Batch size for embedding generation */
  BATCH_SIZE: 5,

  /** Delay between batches in milliseconds */
  BATCH_DELAY_MS: 500,

  /** Maximum cache size for in-memory embedding cache */
  CACHE_MAX_SIZE: 1000,
} as const;

// =====================================================
// AI SERVICE CONFIGURATION
// =====================================================
export const AI_SERVICE = {
  /** Default temperature for AI responses (lower = more factual, higher = more creative) */
  DEFAULT_TEMPERATURE: 0.3,

  /** Default max tokens for responses */
  DEFAULT_MAX_TOKENS: 2048,

  /** Minimum confidence score to not require review */
  MIN_CONFIDENCE_NO_REVIEW: 0.6,

  /** Confidence threshold for uncertain responses */
  LOW_CONFIDENCE_THRESHOLD: 0.5,

  /** Maximum retries for API calls */
  MAX_RETRIES: 2,

  /** Initial retry delay in milliseconds */
  INITIAL_RETRY_DELAY_MS: 2000,

  /** Maximum retry delay in milliseconds */
  MAX_RETRY_DELAY_MS: 10000,

  /** Backoff multiplier for exponential backoff */
  RETRY_BACKOFF_MULTIPLIER: 2,
} as const;

// =====================================================
// PAGINATION CONFIGURATION
// =====================================================
export const PAGINATION = {
  /** Default page size for list endpoints */
  DEFAULT_PAGE_SIZE: 20,

  /** Maximum page size allowed */
  MAX_PAGE_SIZE: 100,

  /** Default page number */
  DEFAULT_PAGE: 1,
} as const;

// =====================================================
// AUTHENTICATION CONFIGURATION
// =====================================================
export const AUTH = {
  /** JWT token expiration time */
  JWT_EXPIRATION: '7d',

  /** Bcrypt salt rounds for password hashing */
  BCRYPT_SALT_ROUNDS: 10,

  /** Minimum password length */
  MIN_PASSWORD_LENGTH: 8,
} as const;

// =====================================================
// FILE UPLOAD CONFIGURATION
// =====================================================
export const FILE_UPLOAD = {
  /** Maximum file size in bytes (50MB) */
  MAX_FILE_SIZE: 50 * 1024 * 1024,

  /** Allowed MIME types for course materials */
  ALLOWED_COURSE_MATERIAL_TYPES: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'text/plain',
    'text/markdown',
  ],

  /** Allowed MIME types for assignment submissions */
  ALLOWED_SUBMISSION_TYPES: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'text/plain',
    'image/png',
    'image/jpeg',
    'application/zip',
  ],
} as const;

// =====================================================
// DATABASE CONFIGURATION
// =====================================================
export const DATABASE = {
  /** Connection pool size */
  POOL_SIZE: 20,

  /** Connection timeout in milliseconds */
  CONNECTION_TIMEOUT_MS: 10000,

  /** Idle connection timeout in milliseconds */
  IDLE_TIMEOUT_MS: 30000,
} as const;

// =====================================================
// LOGGING CONFIGURATION
// =====================================================
export const LOGGING = {
  /** Log levels */
  LEVELS: {
    ERROR: 'error',
    WARN: 'warn',
    INFO: 'info',
    DEBUG: 'debug',
  } as const,

  /** Default log level */
  DEFAULT_LEVEL: 'info',

  /** Enable console logging */
  ENABLE_CONSOLE: true,

  /** Enable file logging */
  ENABLE_FILE: true,

  /** Log file path */
  FILE_PATH: './logs/app.log',
} as const;

// =====================================================
// TRUST SCORE THRESHOLDS
// =====================================================
export const TRUST_SCORE = {
  /** Trust score thresholds */
  HIGHEST: 90,
  HIGH: 70,
  MEDIUM: 50,
  LOWER: 30,

  /** Minimum trust score to display without warning */
  MIN_ACCEPTABLE: 70,
} as const;

// =====================================================
// EMOTIONAL FILTER CONFIGURATION (Groq)
// =====================================================
export const EMOTIONAL_FILTER_CONFIG = {
  /** Enable emotional filtering globally */
  ENABLED: process.env.EMOTIONAL_FILTER_ENABLED !== 'false',

  /** Groq model to use for emotional analysis (fast models recommended) */
  MODEL: process.env.GROQ_EVAL_MODEL || process.env.GROQ_MODEL || 'llama-3.1-8b-instant',

  /** Maximum conversation history messages to analyze */
  MAX_HISTORY_MESSAGES: 10,

  /** Emotions that trigger adjustment */
  TRIGGER_EMOTIONS: ['frustrated', 'confused', 'anxious', 'discouraged', 'overwhelmed'] as const,

  /** Minimum intensity to trigger adjustment for trigger emotions */
  MIN_TRIGGER_INTENSITY: 'moderate' as const,

  /** Maximum tokens for emotional analysis */
  ANALYSIS_MAX_TOKENS: 500,

  /** Maximum tokens for response adjustment */
  ADJUSTMENT_MAX_TOKENS: 2048,

  /** Temperature for emotional analysis (lower = more consistent) */
  ANALYSIS_TEMPERATURE: 0.3,

  /** Temperature for response adjustment */
  ADJUSTMENT_TEMPERATURE: 0.4,
} as const;

// =====================================================
// FACT-CHECK CONFIGURATION (Groq - Independent Verification)
// =====================================================
export const FACT_CHECK_CONFIG = {
  /** Enable fact-checking globally */
  ENABLED: process.env.FACT_CHECK_ENABLED !== 'false',

  /** Groq model to use for fact-checking */
  MODEL: process.env.GROQ_EVAL_MODEL || process.env.GROQ_MODEL || 'llama-3.1-8b-instant',

  /** Temperature for fact-checking (lower = more consistent) */
  TEMPERATURE: 0.2,

  /** Maximum tokens for fact-check response */
  MAX_TOKENS: 1000,

  /** Maximum conversation history entries to include */
  MAX_HISTORY_ENTRIES: 6,

  /** Max chars of source content per document fed to the fact-checker.
   * Was effectively 800 (double-truncated), which only ever showed the head of a
   * document (e.g. slide-master boilerplate) and produced false "inaccurate" verdicts.
   * ponytail: still head-truncation; for docs larger than this, fetch the cited chunks instead. */
  MAX_SOURCE_CHARS: 12000,
} as const;

// =====================================================
// CHAIN-OF-VERIFICATION (CoVe) CONFIGURATION
// =====================================================
export const COVE_CONFIG = {
  /** Enable Chain-of-Verification globally */
  ENABLED: process.env.COVE_ENABLED === 'true',

  /** Only verify responses with confidence below this threshold */
  CONFIDENCE_THRESHOLD: parseFloat(process.env.COVE_CONFIDENCE_THRESHOLD || '0.7'),

  /** Minimum confidence improvement to use revised response */
  MIN_CONFIDENCE_IMPROVEMENT: 0.05,

  /** Number of verification questions to generate */
  VERIFICATION_QUESTIONS_COUNT: 3,

  /** Agent types that should always use CoVe (if empty, all agents can use it) */
  ENABLED_FOR_AGENTS: [] as string[],

  /** Agent types that should never use CoVe */
  DISABLED_FOR_AGENTS: [] as string[],
} as const;

// =====================================================
// SCORING CONFIGURATION (Validation + Trust)
// =====================================================
export const SCORING = {
  /** Two-model Groq jury for the trust score */
  TRUST_MODEL_A: process.env.TRUST_MODEL_A || 'qwen/qwen3-32b',
  TRUST_MODEL_B: process.env.TRUST_MODEL_B || 'llama-3.3-70b-versatile',

  /** If |scoreA - scoreB| > this, verifiers "disagree": take min + flag */
  JURY_DISAGREEMENT_THRESHOLD: 30,

  /** Calibration anchors: raw cosine -> calibrated 0-100. Piecewise-linear between anchors. */
  COSINE_ANCHORS: [
    { cosine: 0.30, score: 10 },
    { cosine: 0.50, score: 50 },
    { cosine: 0.65, score: 75 },
    { cosine: 0.75, score: 90 },
    { cosine: 0.85, score: 100 },
  ] as Array<{ cosine: number; score: number }>,

  /** Validation below this caps/warns on a high trust score (the low-validation guard) */
  LOW_VALIDATION_GUARD: 40,

  /** Max sentences from a response to embed for validation (cost cap) */
  MAX_RESPONSE_SENTENCES: 25,

  /** Sentences shorter than this (chars) are ignored for validation */
  MIN_SENTENCE_CHARS: 25,

  /** Neutral validation score when there are no sentences to ground (don't penalize) */
  NEUTRAL_VALIDATION_SCORE: 50,
} as const;

// =====================================================
// HELPER FUNCTIONS
// =====================================================

/**
 * Get environment variable value with type safety
 */
export function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (!value && !defaultValue) {
    throw new Error(`Required environment variable ${key} is not set`);
  }
  return value || defaultValue || '';
}

/**
 * Get numeric environment variable
 */
export function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    console.warn(`Invalid number for ${key}, using default: ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

/**
 * Get boolean environment variable
 */
export function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
}
