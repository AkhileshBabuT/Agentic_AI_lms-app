import { pool } from '../../config/database';
import { getEmbeddingSpaceId, MATERIAL_PIPELINE_VERSION } from './embeddingSpace';
import { enqueueVersion } from './ingestion';

/** Explicit professor retry, idempotent for active work; never mutates a published index. */
export async function retryMaterialIngestion(materialId: number, userId: number): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const material = await client.query(`SELECT m.id FROM course_materials m JOIN course_instructors i ON i.course_id=m.course_id
      WHERE m.id=$1 AND m.deleted_at IS NULL AND i.user_id=$2 FOR SHARE OF i`, [materialId,userId]);
    if (!material.rowCount) throw new Error('Material not found');
    const version = await client.query('SELECT id FROM material_versions WHERE material_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [materialId]);
    if (!version.rowCount) throw new Error('No stored version; run the original-attachment backfill or re-upload');
    let jobStatus: string | undefined;
    let run = await client.query(`SELECT r.id,r.status FROM material_index_runs r WHERE r.version_id=$1 AND r.embedding_space_id=$2 AND r.pipeline_version=$3`,
      [version.rows[0].id,getEmbeddingSpaceId(),MATERIAL_PIPELINE_VERSION]);
    if (!run.rowCount) {
      await enqueueVersion(client, version.rows[0].id);
      run = await client.query(`SELECT r.id,r.status FROM material_index_runs r WHERE r.version_id=$1 AND r.embedding_space_id=$2 AND r.pipeline_version=$3`,
        [version.rows[0].id,getEmbeddingSpaceId(),MATERIAL_PIPELINE_VERSION]);
    } else {
      // Match worker lock order: job first, then material, then run.
      const job = await client.query('SELECT id,status FROM ingestion_jobs WHERE run_id=$1 FOR UPDATE', [run.rows[0].id]);
      jobStatus = job.rows[0]?.status;
      const locked = await client.query('SELECT id FROM course_materials WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [materialId]);
      if (!locked.rowCount) throw new Error('Material not found');
      run = await client.query('SELECT id,status FROM material_index_runs WHERE id=$1 FOR UPDATE', [run.rows[0].id]);
    }
    if (run.rows[0].status === 'published') { await client.query('COMMIT'); return 'ready'; }
    if (jobStatus === 'processing') { await client.query('COMMIT'); return 'processing'; }
    if (['failed','needs_review'].includes(run.rows[0].status)) {
      await client.query(`UPDATE material_index_runs SET status='queued',error=NULL,completed_at=NULL WHERE id=$1`, [run.rows[0].id]);
      await client.query(`UPDATE ingestion_jobs SET status='queued',attempts=0,error=NULL,available_at=now(),lease_until=NULL,lease_token=NULL,lease_owner=NULL,updated_at=now()
        WHERE run_id=$1 AND status IN ('failed','needs_review')`, [run.rows[0].id]);
      await client.query(`UPDATE course_materials SET ingestion_status='queued',ingestion_error=NULL WHERE id=$1`, [materialId]);
    }
    await client.query('COMMIT');
    return run.rows[0].status === 'processing' ? 'processing' : 'queued';
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
