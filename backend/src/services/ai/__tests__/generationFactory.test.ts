import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGenerationProvider } from '../generationFactory';

afterEach(() => vi.unstubAllEnvs());

describe('generation factory explicit selection', () => {
  it.each(['mock', 'groq', 'unknown'])('never silently falls back for %s', provider => {
    vi.stubEnv('RAG_GENERATION_PROVIDER', provider);
    expect(() => getGenerationProvider()).toThrow(/not configured correctly/);
  });

  it('defaults explicitly to ARC but fails clearly before DB access for missing configuration', () => {
    vi.stubEnv('RAG_GENERATION_PROVIDER', '');
    vi.stubEnv('VT_ARC_API_KEY', '');
    expect(() => getGenerationProvider()).toThrow(/not configured correctly/);
  });
});
