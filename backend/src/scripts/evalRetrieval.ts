/**
 * Retrieval eval harness — the gate for embedding-model migration.
 *
 * Usage (from backend/):
 *   npx ts-node src/scripts/evalRetrieval.ts --pipeline baseline
 *   npx ts-node src/scripts/evalRetrieval.ts --pipeline rerank
 *   npx ts-node src/scripts/evalRetrieval.ts --pipeline candidate --model Xenova/bge-m3
 *
 * Reports Recall@5 and MRR@5. "candidate" embeds the course's chunks in memory
 * with the given model (no DB migration needed to evaluate a new model).
 */
import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { pool } from '../config/database';
import { searchCourseMaterials } from '../services/vectorSearch';

interface EvalCase {
  question: string;
  course_id: number;
  expect_material_id?: number;
  expect_substring?: string;
}

interface RankedChunk {
  material_id: number;
  chunk_text: string;
}

const TOP_K = 5;

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function isHit(c: EvalCase, chunk: RankedChunk): boolean {
  if (c.expect_material_id != null) return chunk.material_id === c.expect_material_id;
  if (c.expect_substring) return chunk.chunk_text.toLowerCase().includes(c.expect_substring.toLowerCase());
  return false;
}

async function baselineTop(c: EvalCase, k: number): Promise<RankedChunk[]> {
  const results = await searchCourseMaterials(c.course_id, c.question, { topK: k, minSimilarity: 0 });
  return results.map(r => ({ material_id: r.material_id, chunk_text: r.chunk_text }));
}

async function rerankTop(c: EvalCase): Promise<RankedChunk[]> {
  const { rerank } = await import('../services/rerankerService');
  const stage1 = await baselineTop(c, 30);
  return rerank(c.question, stage1, x => x.chunk_text, TOP_K);
}

async function candidateTop(c: EvalCase, modelId: string, cache: Map<number, any>): Promise<RankedChunk[]> {
  const { pipeline } = await import('@xenova/transformers');
  if (!cache.has(-1)) cache.set(-1, await pipeline('feature-extraction', modelId, { quantized: true }));
  const embed = cache.get(-1);
  const toVec = async (text: string): Promise<number[]> => {
    const out = await embed(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data) as number[];
  };

  if (!cache.has(c.course_id)) {
    const rows = await pool.query(
      `SELECT cme.material_id, cme.chunk_text
       FROM course_material_embeddings cme
       JOIN course_materials cm ON cme.material_id = cm.id
       WHERE cm.course_id = $1`,
      [c.course_id]
    );
    const chunks: Array<RankedChunk & { vec: number[] }> = [];
    for (const row of rows.rows) {
      chunks.push({ material_id: row.material_id, chunk_text: row.chunk_text, vec: await toVec(row.chunk_text) });
    }
    cache.set(c.course_id, chunks);
    console.log(`  (embedded ${chunks.length} chunks for course ${c.course_id} with ${modelId})`);
  }

  const qv = await toVec(c.question); // bge-m3 needs no query prefix; if evaluating a prefix model, prepend it here
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0); // vectors are normalized
  return (cache.get(c.course_id) as Array<RankedChunk & { vec: number[] }>)
    .map(ch => ({ ...ch, score: dot(qv, ch.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K)
    .map(({ material_id, chunk_text }) => ({ material_id, chunk_text }));
}

async function main() {
  const pipelineName = argOf('--pipeline') || 'baseline';
  const modelId = argOf('--model') || 'Xenova/bge-m3';

  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../../eval/retrieval-eval.json'), 'utf8'));
  const cases: EvalCase[] = (raw.cases || []).filter((c: EvalCase) => !c.question.startsWith('EXAMPLE'));
  if (cases.length < 10) {
    console.error(`Need >=10 real eval cases, found ${cases.length}. Populate backend/eval/retrieval-eval.json first.`);
    process.exit(1);
  }

  const candidateCache = new Map<number, any>();
  let hits = 0;
  let mrrSum = 0;

  for (const c of cases) {
    const top =
      pipelineName === 'rerank' ? await rerankTop(c)
      : pipelineName === 'candidate' ? await candidateTop(c, modelId, candidateCache)
      : await baselineTop(c, TOP_K);

    const rank = top.findIndex(ch => isHit(c, ch));
    if (rank >= 0) { hits++; mrrSum += 1 / (rank + 1); }
    console.log(`${rank >= 0 ? 'HIT ' : 'MISS'} rank=${rank >= 0 ? rank + 1 : '-'}  ${c.question.slice(0, 70)}`);
  }

  console.log('\n================ RESULTS ================');
  console.log(`pipeline:  ${pipelineName}${pipelineName === 'candidate' ? ` (${modelId})` : ''}`);
  console.log(`cases:     ${cases.length}`);
  console.log(`Recall@5:  ${(hits / cases.length).toFixed(3)}`);
  console.log(`MRR@5:     ${(mrrSum / cases.length).toFixed(3)}`);
  await pool.end();
}

main();
