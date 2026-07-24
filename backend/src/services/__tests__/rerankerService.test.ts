import { describe, it, expect, vi } from 'vitest';

// Force model load to fail so we exercise the fail-open path deterministically.
vi.mock('@xenova/transformers', () => ({
  AutoTokenizer: { from_pretrained: vi.fn().mockRejectedValue(new Error('no model')) },
  AutoModelForSequenceClassification: { from_pretrained: vi.fn().mockRejectedValue(new Error('no model')) },
}));

import { rerank } from '../rerankerService';

describe('rerank', () => {
  it('returns items unchanged when already <= topN', async () => {
    const items = [{ t: 'a' }, { t: 'b' }];
    expect(await rerank('q', items, x => x.t, 5)).toEqual(items);
  });

  it('falls back to stage-1 order when the model fails', async () => {
    const items = [{ t: 'first' }, { t: 'second' }, { t: 'third' }];
    expect(await rerank('q', items, x => x.t, 2)).toEqual([{ t: 'first' }, { t: 'second' }]);
  });
});
