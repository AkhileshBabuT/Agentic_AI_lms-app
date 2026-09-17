import { beforeEach, describe, expect, it, vi } from 'vitest';

const load = vi.hoisted(() => vi.fn());
vi.mock('@xenova/transformers', () => ({ pipeline: load }));
vi.mock('fs', () => ({ default: { appendFileSync: vi.fn() } }));

describe('embedding model initialization', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
  it('shares one model load across concurrent first documents', async () => {
    let release!: (value: unknown) => void;
    load.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const { generateEmbedding } = await import('../embeddingService');
    const first = generateEmbedding('First native document');
    const second = generateEmbedding('Second native document');
    expect(load).toHaveBeenCalledTimes(1);
    release(vi.fn().mockResolvedValue({ data: new Float32Array(768).fill(0.01) }));
    expect((await Promise.all([first, second])).map(vector => vector.length)).toEqual([768, 768]);
  });
  it('retries initialization after a failed load without poisoning later jobs', async () => {
    load.mockRejectedValueOnce(new Error('model temporarily unavailable'))
      .mockResolvedValueOnce(vi.fn().mockResolvedValue({ data: new Float32Array(768).fill(0.01) }));
    const { generateEmbedding } = await import('../embeddingService');
    await expect(generateEmbedding('First native document')).rejects.toThrow('Embedding generation failed');
    expect(await generateEmbedding('Retry native document')).toHaveLength(768);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
