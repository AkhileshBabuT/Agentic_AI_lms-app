import type { Queryable } from '../rag/access';

/** Called inside the existing root-only permanent course-deletion transaction.
 * Ordinary material deletion stays soft, preserving historical citations.
 */
export async function purgeCourseIndex(db: Queryable, courseId: number): Promise<void> {
  await db.query('DELETE FROM answer_runs WHERE course_id=$1', [courseId]);
  await db.query(`DELETE FROM ingestion_jobs j USING material_index_runs r,material_versions v,course_materials m
    WHERE j.run_id=r.id AND r.version_id=v.id AND v.material_id=m.id AND m.course_id=$1`, [courseId]);
  await db.query(`DELETE FROM material_upload_intents i USING course_materials m
    WHERE i.material_id=m.id AND m.course_id=$1`, [courseId]);
  await db.query('UPDATE course_materials SET published_run_id=NULL WHERE course_id=$1', [courseId]);
  await db.query(`DELETE FROM chunk_embeddings e USING material_chunks c
    WHERE e.chunk_id=c.id AND c.course_id=$1`, [courseId]);
  await db.query('DELETE FROM material_chunks WHERE course_id=$1', [courseId]);
  await db.query(`DELETE FROM material_pages p USING material_index_runs r,material_versions v,course_materials m
    WHERE p.run_id=r.id AND r.version_id=v.id AND v.material_id=m.id AND m.course_id=$1`, [courseId]);
  await db.query(`DELETE FROM material_index_runs r USING material_versions v,course_materials m
    WHERE r.version_id=v.id AND v.material_id=m.id AND m.course_id=$1`, [courseId]);
  await db.query(`DELETE FROM material_versions v USING course_materials m
    WHERE v.material_id=m.id AND m.course_id=$1`, [courseId]);
}
