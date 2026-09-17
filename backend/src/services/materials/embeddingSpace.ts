import { createHash } from 'crypto';
import { EMBEDDING_CONFIG } from '../../config/constants';

export const MATERIAL_PIPELINE_VERSION = 'native-v2-partial-text';
/** Changes in the document or query representation require a separate index. */
export function getEmbeddingSpaceId(): string {
  if (EMBEDDING_CONFIG.EMBEDDING_DIMENSION !== 768) {
    throw new Error('The course index requires 768-dimensional embeddings; migrate explicitly before changing it');
  }
  if (!/^[a-f0-9]{40}$/i.test(EMBEDDING_CONFIG.MODEL_REVISION)) {
    throw new Error('Course embeddings require an immutable EMBEDDING_MODEL_REVISION commit');
  }
  return `local-768-${createHash('sha256').update(JSON.stringify({
    model: EMBEDDING_CONFIG.MODEL_ID, revision: EMBEDDING_CONFIG.MODEL_REVISION,
    tokenizer: EMBEDDING_CONFIG.MODEL_ID, quantized: true, dimension: 768, pooling: 'mean', normalize: true,
    queryPrefix: EMBEDDING_CONFIG.QUERY_PREFIX,
  })).digest('hex').slice(0, 20)}`;
}
