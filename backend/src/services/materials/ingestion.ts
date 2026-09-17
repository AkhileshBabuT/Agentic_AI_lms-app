import { createHash, randomUUID } from 'crypto';
import { pool } from '../../config/database';
import { MATERIAL_INGESTION } from '../../config/materialIngestion';
import { uploadImmutableFile, getFileMetadata, downloadImmutableFile } from '../../config/storage';
import { getEmbeddingSpaceId, MATERIAL_PIPELINE_VERSION } from './embeddingSpace';
import { validateMaterialFile } from './fileValidation';

export function hashAttachment(buffer: Buffer): string { return createHash('sha256').update(buffer).digest('hex'); }

/** Durable intent exists before the external upload; a worker reconciles crashes. */
export async function queueMaterialUpload(input: {
  courseId: number; userId: number; folderId: number | null; file: Express.Multer.File;
}): Promise<Record<string, unknown>> {
  const { file } = input;
  validateMaterialFile(file.buffer, file.originalname, file.mimetype);
  if (file.size > MATERIAL_INGESTION.maxBytes || file.buffer.length > MATERIAL_INGESTION.maxBytes) {
    throw new Error('Material exceeds the ingestion byte limit');
  }
  const versionId = randomUUID(), intentId = randomUUID();
  const objectName = `course-materials/${input.courseId}/versions/${versionId}/attachment`;
  const sha256 = hashAttachment(file.buffer);
  const client = await pool.connect();
  let material: any;
  try {
    await client.query('BEGIN');
    // Recheck membership and folder inside the transaction that creates intent.
    const course = await client.query('SELECT 1 FROM course_instructors WHERE user_id=$1 AND course_id=$2 FOR SHARE', [input.userId, input.courseId]);
    if (!course.rowCount) throw new Error('Course access changed');
    if (input.folderId) {
      const folder = await client.query('SELECT 1 FROM material_folders WHERE id=$1 AND course_id=$2 FOR SHARE', [input.folderId, input.courseId]);
      if (!folder.rowCount) throw new Error('Target folder no longer exists');
    }
    const result = await client.query(`INSERT INTO course_materials
      (course_id,file_name,file_path,file_size,file_type,uploaded_by,folder_id,ingestion_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,'uploading') RETURNING *`,
    [input.courseId, file.originalname, objectName, file.buffer.length, file.mimetype, input.userId, input.folderId]);
    material = result.rows[0];
    await client.query(`INSERT INTO material_upload_intents
      (id,material_id,version_id,object_name,expected_sha256,mime_type,byte_count,original_filename)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [intentId, material.id, versionId, objectName, sha256, file.mimetype, file.buffer.length, file.originalname]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  try {
    const generation = await uploadImmutableFile(file.buffer, objectName, file.mimetype, sha256);
    await finalizeUploadIntent(intentId, generation);
    return { ...material, ingestion_status: 'queued' };
  } catch {
    // Upload completion and DB commit can disagree; retain intent for reconciliation.
    await pool.query(`UPDATE material_upload_intents SET status='reconcile',error='Upload needs storage reconciliation',updated_at=now() WHERE id=$1 AND status!='complete'`, [intentId]);
    await pool.query(`UPDATE course_materials SET ingestion_status='upload_failed',ingestion_error='Upload needs storage reconciliation' WHERE id=$1 AND deleted_at IS NULL AND ingestion_status='uploading'`, [material.id]);
    return { ...material, ingestion_status: 'upload_failed', ingestion_error: 'Upload needs storage reconciliation' };
  }
}

export async function enqueueVersion(client: any, versionId: string): Promise<void> {
  const run = await client.query(`INSERT INTO material_index_runs(id,version_id,embedding_space_id,pipeline_version)
    VALUES($1,$2,$3,$4) ON CONFLICT(version_id,embedding_space_id,pipeline_version)
    DO UPDATE SET version_id=EXCLUDED.version_id RETURNING id,status`,
  [randomUUID(), versionId, getEmbeddingSpaceId(), MATERIAL_PIPELINE_VERSION]);
  if (run.rows[0].status !== 'queued') return;
  await client.query(`INSERT INTO ingestion_jobs(id,run_id,max_attempts) VALUES($1,$2,$3) ON CONFLICT(run_id) DO NOTHING`,
    [randomUUID(), run.rows[0].id, MATERIAL_INGESTION.maxAttempts]);
  await client.query(`UPDATE course_materials SET ingestion_status='queued',ingestion_error=NULL
    WHERE id=(SELECT material_id FROM material_versions WHERE id=$1) AND deleted_at IS NULL`, [versionId]);
}

export async function finalizeUploadIntent(intentId: string, generation: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`SELECT i.*,cm.deleted_at FROM material_upload_intents i
      JOIN course_materials cm ON cm.id=i.material_id WHERE i.id=$1 FOR UPDATE OF i,cm`, [intentId]);
    const intent = result.rows[0];
    if (!intent || intent.status === 'complete' || intent.deleted_at) { await client.query('ROLLBACK'); return; }
    await client.query(`INSERT INTO material_versions
      (id,material_id,object_name,object_generation,sha256,mime_type,byte_count,original_filename)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [intent.version_id, intent.material_id, intent.object_name, generation, intent.expected_sha256, intent.mime_type, intent.byte_count, intent.original_filename]);
    await enqueueVersion(client, intent.version_id);
    await client.query(`UPDATE material_upload_intents SET status='complete',error=NULL,updated_at=now() WHERE id=$1`, [intentId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

/** Bounded reconciliation: no deletion of an object whose DB outcome is uncertain. */
export async function reconcileUploadIntents(): Promise<number> {
  const pending = await pool.query(`SELECT i.* FROM material_upload_intents i JOIN course_materials cm ON cm.id=i.material_id
    WHERE i.status IN ('pending','reconcile') AND cm.deleted_at IS NULL
    AND i.updated_at < now()-interval '2 minutes' ORDER BY i.created_at LIMIT 10`);
  let reconciled = 0;
  for (const intent of pending.rows) {
    try {
      const metadata = await getFileMetadata(intent.object_name);
      if (!metadata.generation || Number(metadata.size) !== Number(intent.byte_count)) throw new Error('Storage mismatch');
      const buffer = await downloadImmutableFile(intent.object_name, String(metadata.generation), MATERIAL_INGESTION.maxBytes);
      if (hashAttachment(buffer) !== intent.expected_sha256) throw new Error('Storage hash mismatch');
      await finalizeUploadIntent(intent.id, String(metadata.generation));
      reconciled++;
    } catch {
      if (Date.now() - new Date(intent.created_at).getTime() > 15 * 60 * 1000) {
        await pool.query(`UPDATE material_upload_intents SET status='failed',error='Attachment upload could not be reconciled',updated_at=now() WHERE id=$1 AND status!='complete'`, [intent.id]);
        await pool.query(`UPDATE course_materials SET ingestion_status='upload_failed',ingestion_error='Attachment upload could not be reconciled' WHERE id=$1 AND deleted_at IS NULL AND ingestion_status IN ('uploading','upload_failed')`, [intent.material_id]);
      }
    }
  }
  return reconciled;
}
