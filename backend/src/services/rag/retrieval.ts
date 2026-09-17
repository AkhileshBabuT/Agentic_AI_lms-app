import { pool } from '../../config/database';
import { RAG_CONFIG } from '../../config/rag';
import { EMBEDDING_CONFIG } from '../../config/constants';
import { getEmbeddingSpaceId } from '../materials/embeddingSpace';
import { assertCourseAccess, COURSE_ACCESS_SQL, Queryable } from './access';
import { CourseIdentity, EvidencePassage } from './types';
import { embedRagQuery, rerankRagTexts } from './modelInference';

export interface Candidate extends Omit<EvidencePassage, 'evidenceId'> {}
const COLUMNS = `mc.id AS "chunkId", mc.material_id AS "materialId", mc.course_id AS "courseId",
 mc.run_id AS "runId", mc.text, mc.locator, mc.token_count AS "tokenCount",
 mv.id AS "versionId", mv.original_filename AS "materialName", mir.metadata->>'coverage_warning' AS "coverageWarning"`;
const JOINS = `FROM material_chunks mc JOIN course_materials cm ON cm.id=mc.material_id AND cm.course_id=mc.course_id
 JOIN material_index_runs mir ON mir.id=mc.run_id JOIN material_versions mv ON mv.id=mir.version_id AND mv.material_id=cm.id`;
const FILTER = `mc.course_id=$1 AND cm.deleted_at IS NULL AND cm.visibility='published'
 AND cm.published_run_id=mir.id AND mir.status='published' AND mir.embedding_space_id=$4 AND ${COURSE_ACCESS_SQL}`;

export function fuseRanks(vector: Candidate[], lexical: Candidate[], k: number, limit: number): Candidate[] {
  const scores = new Map<string, { candidate: Candidate; score: number }>();
  for (const list of [vector, lexical]) list.forEach((candidate, index) => {
    const old = scores.get(candidate.chunkId);
    scores.set(candidate.chunkId, { candidate, score: (old?.score ?? 0) + 1 / (k + index + 1) });
  });
  return [...scores.values()].sort((a, b) => b.score - a.score || a.candidate.chunkId.localeCompare(b.candidate.chunkId)).slice(0, limit).map(item => item.candidate);
}

/** UTF-8 bytes are a conservative upper bound for byte/BPE tokenizers. No model-specific token count is assumed. */
export function packPassages(candidates: Candidate[], budget: number, maxPassages: number): EvidencePassage[] {
  const evidence: EvidencePassage[] = [];
  let available = budget;
  for (const candidate of candidates) {
    if (evidence.length >= maxPassages || available < 160) break;
    const headerCost = Buffer.byteLength(JSON.stringify({ evidenceId: `E${evidence.length + 1}`, filename: candidate.materialName, locator: candidate.locator }), 'utf8') + 80;
    const maxBytes = available - headerCost;
    if (maxBytes < 80) continue;
    let text = candidate.text;
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      // Slice on Unicode code points; the exact substring becomes the stored excerpt.
      let bytes = 0; text = '';
      for (const char of candidate.text) { const size = Buffer.byteLength(char, 'utf8'); if (bytes + size > maxBytes) break; text += char; bytes += size; }
    }
    if (!text.trim()) continue;
    const cost = Buffer.byteLength(text, 'utf8') + headerCost;
    evidence.push({ ...candidate, text, tokenCount: cost, evidenceId: `E${evidence.length + 1}` });
    available -= cost;
  }
  return evidence;
}

/** Optional reranking runs away from Express and is terminated on deadline; ranking failure preserves RRF order. */
export async function boundedRerank(question: string, candidates: Candidate[], timeoutMs: number, signal?: AbortSignal): Promise<Candidate[]> {
  if (candidates.length < 2 || signal?.aborted) return candidates;
  try {
    const scores = await rerankRagTexts(question, candidates.map(p => p.text), timeoutMs, signal);
    if (scores.length !== candidates.length) return candidates;
    return candidates.map((candidate, i) => ({ candidate, score: scores[i] })).sort((a, b) => b.score - a.score).map(p => p.candidate);
  } catch { return candidates; }
}

export async function retrieveCourseEvidence(identity: CourseIdentity, question: string, signal?: AbortSignal, db: Queryable = pool): Promise<EvidencePassage[]> {
  await assertCourseAccess(identity, db);
  if (signal?.aborted) throw new Error('Request cancelled');
  const embedding = await embedRagQuery(question, signal);
  if (embedding.length !== EMBEDDING_CONFIG.EMBEDDING_DIMENSION || embedding.some(n => !Number.isFinite(n))) throw new Error('Invalid query embedding');
  if (signal?.aborted) throw new Error('Request cancelled');
  const args = [identity.courseId, identity.userId, identity.role, getEmbeddingSpaceId()];
  const [vector, lexical] = await Promise.all([
    // Materialize the authorized subset to force exact distance sorting even if an ANN index exists.
    db.query(`WITH authorized AS MATERIALIZED (SELECT ${COLUMNS}, ce.embedding ${JOINS}
      JOIN chunk_embeddings ce ON ce.chunk_id=mc.id AND ce.embedding_space_id=$4 WHERE ${FILTER})
      SELECT "chunkId", "materialId", "courseId", "runId", text, locator, "tokenCount", "versionId", "materialName", "coverageWarning"
      FROM authorized ORDER BY embedding <=> $5::vector, "chunkId" LIMIT $6`, [...args, `[${embedding.join(',')}]`, RAG_CONFIG.VECTOR_CANDIDATES]),
    db.query(`SELECT ${COLUMNS} ${JOINS} WHERE ${FILTER}
      AND mc.search_vector @@ websearch_to_tsquery('english',$5)
      ORDER BY ts_rank_cd(mc.search_vector,websearch_to_tsquery('english',$5)) DESC, mc.id LIMIT $6`, [...args, question, RAG_CONFIG.LEXICAL_CANDIDATES])
  ]);
  const fused = fuseRanks(vector.rows, lexical.rows, RAG_CONFIG.FUSION_K, RAG_CONFIG.RERANK_CANDIDATES);
  const ranked = RAG_CONFIG.RERANK_ENABLED ? await boundedRerank(question, fused, RAG_CONFIG.RERANK_TIMEOUT_MS, signal) : fused;
  return packPassages(ranked, RAG_CONFIG.CONTEXT_TOKEN_BUDGET, RAG_CONFIG.MAX_PASSAGES);
}

/** Revalidate every prompted passage immediately before generation and while persisting. */
export async function verifyEvidence(identity: CourseIdentity, evidence: EvidencePassage[], db: Queryable = pool, lock = false): Promise<boolean> {
  await assertCourseAccess(identity, db, lock);
  if (!evidence.length) return true;
  const result = await db.query(`SELECT mc.id, mc.run_id, mc.text, mc.material_id, mc.course_id, mc.locator,
    mv.id AS version_id, mv.original_filename, mir.metadata->>'coverage_warning' AS coverage_warning ${JOINS}
    WHERE ${FILTER} AND mc.id=ANY($5::uuid[]) ${lock ? 'FOR SHARE OF cm, mc, mir, mv' : ''}`,
    [identity.courseId, identity.userId, identity.role, getEmbeddingSpaceId(), evidence.map(p => p.chunkId)]);
  const rows = new Map(result.rows.map(row => [row.id, row]));
  return evidence.every(p => { const row = rows.get(p.chunkId); return row && row.run_id === p.runId && row.version_id === p.versionId
    && row.material_id === p.materialId && row.course_id === p.courseId && row.original_filename === p.materialName
    && canonicalJson(row.locator) === canonicalJson(p.locator) && (row.coverage_warning ?? null) === (p.coverageWarning ?? null)
    && p.text.trim().length > 0 && row.text.startsWith(p.text); });
}

export function canonicalJson(value: unknown): string {
  const sort = (item: any): any => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value));
}
