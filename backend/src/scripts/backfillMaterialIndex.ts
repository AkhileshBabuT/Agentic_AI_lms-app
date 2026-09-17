import 'dotenv/config';
import { randomUUID } from 'crypto';
import { pool } from '../config/database';
import { getFileMetadata, downloadImmutableFile } from '../config/storage';
import { MATERIAL_INGESTION } from '../config/materialIngestion';
import { enqueueVersion, hashAttachment } from '../services/materials/ingestion';
import { getEmbeddingSpaceId, MATERIAL_PIPELINE_VERSION } from '../services/materials/embeddingSpace';

export function parseBackfillArgs(args: string[]) {
  const flags = new Set(['--dry-run','--resume','--check-storage']);
  const values = new Set(['--course-id','--limit','--after-id']);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if ((!flags.has(arg) && !values.has(arg)) || seen.has(arg)) throw new Error(`Invalid or duplicate argument ${arg}`);
    seen.add(arg);
    if (values.has(arg)) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid missing value for ${arg}`);
      index++;
    }
  }
  const value = (name: string) => seen.has(name) ? args[args.indexOf(name) + 1] : undefined;
  const courseId = value('--course-id') ? Number(value('--course-id')) : undefined;
  const limit = Number(value('--limit') ?? 50);
  const afterId = Number(value('--after-id') ?? 0);
  if ((courseId !== undefined && (!Number.isInteger(courseId) || courseId <= 0)) || !Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(afterId) || afterId < 0) throw new Error('Invalid course/limit/cursor');
  if (seen.has('--dry-run') && seen.has('--resume')) throw new Error('Invalid mutually exclusive dry-run/resume');
  return {dryRun: seen.has('--dry-run'), courseId, limit, resume: seen.has('--resume'), afterId, checkStorage: seen.has('--check-storage')};
}

async function main() {
  const args = parseBackfillArgs(process.argv.slice(2));
  if (!args.dryRun && !args.resume) throw new Error('Use --dry-run to inspect or --resume to enqueue a bounded batch');
  const materials = await pool.query(`SELECT cm.* FROM course_materials cm WHERE cm.deleted_at IS NULL
    AND cm.visibility='published' AND ($1::integer IS NULL OR cm.course_id=$1)
    AND NOT EXISTS (SELECT 1 FROM material_versions v JOIN material_index_runs r ON r.version_id=v.id
      WHERE v.material_id=cm.id AND r.embedding_space_id=$2 AND r.pipeline_version=$3)
    AND cm.id>$5 ORDER BY cm.id LIMIT $4`, [args.courseId ?? null, getEmbeddingSpaceId(), MATERIAL_PIPELINE_VERSION, args.limit,args.afterId]);
  console.log(JSON.stringify({dryRun: args.dryRun, courseId: args.courseId ?? 'all', count: materials.rowCount,
    materials: materials.rows.map(m => ({id: m.id, courseId: m.course_id, byteCount: Number(m.file_size), status: m.ingestion_status}))}, null, 2));
  if (args.dryRun) {
    if (args.checkStorage) {
      for (const material of materials.rows) {
        try {
          const metadata = await getFileMetadata(material.file_path);
          console.log(JSON.stringify({materialId: material.id,storage: 'available',generation: metadata.generation,byteCount: Number(metadata.size)}));
        } catch { console.log(JSON.stringify({materialId: material.id,storage: 'unavailable'})); }
      }
    }
    console.log(JSON.stringify({nextAfterId: materials.rows[materials.rows.length - 1]?.id ?? args.afterId}));
    return; // No writes/downloads, optional explicitly requested read-only metadata.
  }
  for (const material of materials.rows) {
    try {
      // Existing originals need no re-upload; pin the current physical generation.
      const metadata = await getFileMetadata(material.file_path);
      if (!metadata.generation) throw new Error('Original has no object generation');
      const generation = String(metadata.generation);
      const buffer = await downloadImmutableFile(material.file_path, generation, MATERIAL_INGESTION.maxBytes);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query('SELECT id FROM course_materials WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [material.id]);
        if (!locked.rowCount) { await client.query('ROLLBACK'); continue; }
        const version = await client.query(`INSERT INTO material_versions
          (id,material_id,object_name,object_generation,sha256,mime_type,byte_count,original_filename)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(material_id,object_name,object_generation)
          DO UPDATE SET object_name=EXCLUDED.object_name RETURNING id`,
        [randomUUID(), material.id, material.file_path, generation, hashAttachment(buffer), material.file_type || metadata.contentType || 'application/octet-stream', buffer.length, material.file_name]);
        await enqueueVersion(client, version.rows[0].id);
        await client.query('COMMIT');
        console.log(JSON.stringify({materialId: material.id, status: 'queued'}));
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    } catch {
      await pool.query(`UPDATE course_materials SET ingestion_status='failed',ingestion_error='Original attachment could not be read for backfill' WHERE id=$1 AND deleted_at IS NULL`, [material.id]);
      console.error(JSON.stringify({materialId: material.id, status: 'failed', reason: 'Original attachment unavailable'}));
    }
  }
}

if (require.main === module) main().catch((error: Error) => {
  console.error(error.message.startsWith('Invalid') || error.message.startsWith('Use') || error.message.startsWith('Unknown') ? error.message : 'Backfill stopped; inspect material status');
  process.exitCode = 1;
}).finally(() => pool.end());
