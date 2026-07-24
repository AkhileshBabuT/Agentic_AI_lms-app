import { describe, it, expect } from 'vitest';
import { EMBEDDING_CONFIG } from '../../config/constants';

describe('EMBEDDING_CONFIG', () => {
  it('defaults to bge-base with its asymmetric prefix and 768 dims', () => {
    expect(EMBEDDING_CONFIG.MODEL_ID).toBe('Xenova/bge-base-en-v1.5');
    expect(EMBEDDING_CONFIG.QUERY_PREFIX).toContain('Represent this sentence');
    expect(EMBEDDING_CONFIG.EMBEDDING_DIMENSION).toBe(768);
  });
});
