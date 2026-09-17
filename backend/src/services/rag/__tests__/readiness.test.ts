import { beforeEach, describe, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({ query: vi.fn(), provider: vi.fn(), models: vi.fn() }));
vi.mock('../../../config/database', () => ({ pool: { query: deps.query } }));
vi.mock('../../ai/generationFactory', () => ({ getGenerationProvider: deps.provider }));
vi.mock('../modelInference', () => ({ getRagModelReadiness: deps.models }));
vi.mock('../../../config/rag', () => ({ RAG_CONFIG: { ENABLED: true, RERANK_ENABLED: false } }));
import { checkRagReadiness } from '../readiness';
describe('RAG local readiness', () => {
  beforeEach(() => {
    vi.resetAllMocks(); deps.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    deps.provider.mockReturnValue({ generate: vi.fn() });
    deps.models.mockReturnValue({ embedding: true, reranker: false });
  });
  it('checks local dependencies without issuing a billable upstream request', async () => {
    const result = await checkRagReadiness();
    expect(result.ready).toBe(true); expect(result.upstreamAccess).toBe('not_checked');
    expect(deps.provider.mock.results[0].value.generate).not.toHaveBeenCalled();
  });
  it('withholds readiness until a local model has actually warmed', async () => {
    deps.models.mockReturnValue({ embedding: false, reranker: false });
    expect((await checkRagReadiness()).ready).toBe(false);
  });
  it('reports dependency failure without leaking database or credential details', async () => {
    deps.query.mockRejectedValue(new Error('sensitive connection details'));
    deps.provider.mockImplementation(() => { throw new Error('sensitive credentials'); });
    const result = await checkRagReadiness();
    expect(result.ready).toBe(false); expect(result.database).toBe(false);
    expect(result.generationConfigured).toBe(false);
    expect(JSON.stringify(result)).not.toContain('sensitive');
  });
});
