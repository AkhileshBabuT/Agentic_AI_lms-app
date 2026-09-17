import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../config/database', () => ({ pool: {} }));
import { renderAnswer, validateStructuredAnswer, ABSTENTION } from '../evidence';
import { answerCourseQuestion, validatePersistedSources } from '../CourseAnswerService';
import { fuseRanks, packPassages, Candidate } from '../retrieval';
import { EvidencePassage } from '../types';

const evidence: EvidencePassage[] = [{ evidenceId: 'E1', chunkId: 'a', courseId: 1, materialId: 1,
  materialName: 'Week 1.pdf', runId: 'r', versionId: 'v', text: 'Photosynthesis converts light into chemical energy.', locator: { page: 3 }, tokenCount: 50 }];
const identity = { courseId: 1, userId: 2, role: 'student', question: 'Explain photosynthesis' };
describe('server-owned evidence and answer validation', () => {
  it('rejects unknown references and unsupported blocks', () => {
    for (const value of [
      { status: 'answered', blocks: [{ text: 'Invented', evidenceIds: ['E9'] }] },
      { status: 'answered', blocks: [{ text: 'No source', evidenceIds: [] }] },
      { status: 'answered', blocks: [] },
      { status: 'partial', blocks: [{ text: 'Valid', evidenceIds: ['E1'] }] },
      { status: 'insufficient_evidence', blocks: [{ text: 'Unsupported assertion', evidenceIds: [] }] }
    ]) expect(() => validateStructuredAnswer(JSON.stringify(value), evidence)).toThrow();
  });
  it('generates numeric references and preserves exact document excerpt/page', () => {
    const value = validateStructuredAnswer(JSON.stringify({ status: 'answered', blocks: [{ text: 'Light becomes chemical energy.', evidenceIds: ['E1', 'E1'] }] }), evidence);
    const answer = renderAnswer(value, evidence);
    expect(answer.content).toBe('Light becomes chemical energy. [1]');
    expect(answer.sources).toHaveLength(1);
    expect(answer.sources[0]).toMatchObject({ excerpt: evidence[0].text, pageNumber: 3, versionId: 'v', url: null, relevance: null });
    expect(() => validatePersistedSources(answer)).not.toThrow();
    answer.sources[0].excerpt = 'A model invented excerpt';
    expect(() => validatePersistedSources(answer)).toThrow();
  });
  it('does not call generation when there is no evidence', async () => {
    const generate = vi.fn();
    const result = await answerCourseQuestion(identity, { retrieve: vi.fn().mockResolvedValue([]), verify: vi.fn().mockResolvedValue(true), provider: { generate } });
    expect(result.content).toBe(ABSTENTION);
    expect(generate).not.toHaveBeenCalled();
  });
  it('allows exactly one repair then abstains on malformed references', async () => {
    const generate = vi.fn().mockResolvedValue({ content: '{"status":"answered","blocks":[{"text":"No support","evidenceIds":["E77"]}]}', provider: 'test', model: 'test' });
    const result = await answerCourseQuestion(identity, { retrieve: vi.fn().mockResolvedValue(evidence), verify: vi.fn().mockResolvedValue(true), provider: { generate } });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('insufficient_evidence');
    expect(result.sources).toEqual([]);
  });
  it('rejects evidence revoked before generation and before a repair', async () => {
    const generate = vi.fn().mockResolvedValue({ content: '{}', provider: 'test', model: 'test' });
    await expect(answerCourseQuestion(identity, { retrieve: vi.fn().mockResolvedValue(evidence), verify: vi.fn().mockResolvedValue(false), provider: { generate } })).rejects.toMatchObject({ status: 409 });
    expect(generate).not.toHaveBeenCalled();
    await expect(answerCourseQuestion(identity, { retrieve: vi.fn().mockResolvedValue(evidence), verify: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false), provider: { generate } })).rejects.toMatchObject({ status: 409 });
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
describe('hybrid rank fusion and conservative packing', () => {
  const candidate = (chunkId: string, text = 'Evidence text'): Candidate => ({ ...evidence[0], chunkId, text });
  it('promotes lexical/vector agreement without exposing numeric scores', () => {
    expect(fuseRanks([candidate('a'), candidate('b')], [candidate('b'), candidate('c')], 60, 3).map(p => p.chunkId)).toEqual(['b', 'a', 'c']);
  });
  it('bounds multibyte context without corrupting Unicode or fabricating excerpts', () => {
    const original = '💡'.repeat(1000);
    const passages = packPassages([candidate('a', original)], 500, 8);
    expect(passages[0].tokenCount).toBeLessThanOrEqual(500);
    expect(original.startsWith(passages[0].text)).toBe(true);
    expect(passages[0].text).not.toContain('\uFFFD');
  });
});
