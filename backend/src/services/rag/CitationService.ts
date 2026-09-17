import { pool } from '../../config/database';
import { generateSignedUrl } from '../../config/storage';
import { assertCourseAccess, COURSE_ACCESS_SQL, Queryable } from './access';
import { passageSource } from './evidence';
import { SourceReference, RagAccessError, EvidencePassage } from './types';

export interface AuthorizedAnswerRecord { sources: SourceReference[]; restricted: boolean }

/** Read source rows afresh: JSON on an old message is not an authorization decision. */
export async function getAuthorizedAnswerRecord(messageId: number, userId: number, role: string, db: Queryable = pool, allowReplaced = false): Promise<AuthorizedAnswerRecord> {
  const message = await db.query(`SELECT cs.course_id, ar.id AS answer_run_id FROM chat_messages msg
    JOIN chat_sessions cs ON cs.id=msg.session_id LEFT JOIN answer_runs ar ON ar.message_id=msg.id
    WHERE msg.id=$1 AND cs.student_id=$2 AND cs.status<>'deleted'
    AND (msg.is_deleted=FALSE OR ($3::boolean AND msg.sender_type='agent' AND EXISTS (
      SELECT 1 FROM chat_messages replacement WHERE replacement.session_id=msg.session_id
      AND replacement.sender_type='agent' AND replacement.message_metadata->>'regeneratedFrom'=msg.id::text
    )))`, [messageId, userId, allowReplaced]);
  if (!message.rows.length) throw new RagAccessError('This answer is unavailable');
  const { course_id: courseId, answer_run_id: answerRunId } = message.rows[0];
  await assertCourseAccess({ courseId, userId, role }, db);
  if (!answerRunId) return { sources: [], restricted: false };
  const citations = await db.query(`SELECT ac.*, mv.object_name, mv.object_generation, mir.metadata->>'coverage_warning' AS coverage_warning,
    (cm.deleted_at IS NULL AND cm.visibility='published' AND mir.status='published' AND mv.id=mir.version_id AND mc.run_id=mir.id AND cm.course_id=$1 AND ${COURSE_ACCESS_SQL}) AS accessible
    FROM answer_citations ac JOIN material_chunks mc ON mc.id=ac.chunk_id
    JOIN course_materials cm ON cm.id=ac.material_id JOIN material_index_runs mir ON mir.id=ac.run_id
    JOIN material_versions mv ON mv.id=ac.version_id WHERE ac.answer_run_id=$4 ORDER BY ac.citation_number`, [courseId, userId, role, answerRunId]);
  const restricted = citations.rows.some(row => !row.accessible);
  // Withhold the entire answer's evidence if even one supporting passage is revoked.
  return { restricted, sources: restricted ? [] : citations.rows.map(row => ({
    citationNumber: row.citation_number, evidenceId: row.evidence_id, chunkId: row.chunk_id,
    materialId: row.material_id, materialName: row.material_name, versionId: row.version_id,
    runId: row.run_id, excerpt: row.excerpt, locator: row.locator,
    sourceType: 'course_material' as const, pageNumber: row.locator?.page,
    section: row.locator?.section, url: null, relevance: null, coverageWarning: row.coverage_warning
  })) };
}

/** Call only for a saved record owned by the requester, never ordinary chat history. */
export async function getAuthorizedSavedAnswerRecord(messageId: number, userId: number, role: string, db: Queryable = pool): Promise<AuthorizedAnswerRecord> {
  return getAuthorizedAnswerRecord(messageId, userId, role, db, true);
}

export async function getAuthorizedSavedContentSources(contentId: number, userId: number, role: string): Promise<AuthorizedAnswerRecord> {
  const result = await pool.query(`SELECT course_id,content_metadata FROM agent_generated_content
    WHERE id=$1 AND student_id=$2 AND is_saved=TRUE`, [contentId, userId]);
  if (!result.rows.length) throw new RagAccessError('This saved answer is unavailable');
  const saved = result.rows[0];
  await assertCourseAccess({ courseId: saved.course_id, userId, role });
  const originalId = Number(saved.content_metadata?.originalMessageId);
  if (!Number.isSafeInteger(originalId) || originalId <= 0) return { sources: [], restricted: false };
  return getAuthorizedSavedAnswerRecord(originalId, userId, role);
}

export async function getAuthorizedAnswerSources({ messageId, userId, role }: { messageId: number; userId: number; role: string }): Promise<SourceReference[]> {
  return (await getAuthorizedAnswerRecord(messageId, userId, role)).sources;
}

export async function resolveMaterialSource(chunkId: string, userId: number, role: string): Promise<{ source: SourceReference; url: string }> {
  const result = await pool.query(`SELECT mc.id AS "chunkId", mc.material_id AS "materialId", mc.course_id AS "courseId",
    mc.run_id AS "runId", mc.text, mc.locator, mc.token_count AS "tokenCount",
    mv.id AS "versionId", mv.original_filename AS "materialName", mv.object_name, mv.object_generation, mir.metadata->>'coverage_warning' AS "coverageWarning"
    FROM material_chunks mc JOIN course_materials cm ON cm.id=mc.material_id AND cm.course_id=mc.course_id
    JOIN material_index_runs mir ON mir.id=mc.run_id JOIN material_versions mv ON mv.id=mir.version_id AND mv.material_id=cm.id
    WHERE mc.id=$1 AND cm.deleted_at IS NULL AND cm.visibility='published' AND mir.status='published' AND ${COURSE_ACCESS_SQL}`,
    [chunkId, userId, role]);
  if (!result.rows.length) throw new RagAccessError('This source is no longer available');
  const row = result.rows[0];
  await assertCourseAccess({ courseId: row.courseId, userId, role });
  const url = await generateSignedUrl(row.object_name, 5, row.object_generation);
  // Check again after asynchronous signing in case access changed during that operation.
  const stillAccessible = await pool.query(`SELECT mc.id FROM material_chunks mc JOIN course_materials cm ON cm.id=mc.material_id
    WHERE mc.id=$1 AND cm.deleted_at IS NULL AND cm.visibility='published' AND ${COURSE_ACCESS_SQL}`, [chunkId, userId, role]);
  if (!stillAccessible.rows.length) throw new RagAccessError('This source is no longer available');
  return { source: passageSource({ ...row, evidenceId: 'E1' } as EvidencePassage, 1), url };
}
