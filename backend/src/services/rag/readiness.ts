import { pool } from '../../config/database';
import { getGenerationProvider } from '../ai/generationFactory';
import { getRagModelReadiness } from './modelInference';
import { RAG_CONFIG } from '../../config/rag';

/** Local dependency readiness; upstream credential validity is checked by the separate probe. */
export async function checkRagReadiness() {
  let database = false, generationConfigured = false;
  try {
    const query = { text: 'SELECT 1', query_timeout: 1500 };
    await pool.query(query); database = true;
  } catch { /* Return state only, never connection details. */ }
  try { getGenerationProvider(); generationConfigured = true; }
  catch { /* Missing configuration must not make grading endpoints fail to start. */ }
  const models = getRagModelReadiness();
  return { ready: RAG_CONFIG.ENABLED && database && generationConfigured && models.embedding &&
      (!RAG_CONFIG.RERANK_ENABLED || models.reranker),
    enabled: RAG_CONFIG.ENABLED, database, generationConfigured, models,
    upstreamAccess: 'not_checked' as const };
}
