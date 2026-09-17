import { AnswerStatus, CourseAnswer, EvidencePassage, SourceReference } from './types';

export const ABSTENTION = 'I could not find enough support in the available course materials to answer this question. Please ask your instructor or provide a relevant course document.';
interface AnswerBlock { text: string; evidenceIds: string[] }
export interface StructuredAnswer { status: AnswerStatus; blocks: AnswerBlock[]; missingInformation?: string }

export function validateStructuredAnswer(raw: string, evidence: EvidencePassage[]): StructuredAnswer {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(trimmed);
  if (!parsed || !['answered', 'partial', 'insufficient_evidence'].includes(parsed.status) || !Array.isArray(parsed.blocks) || parsed.blocks.length > 20) throw new Error('Invalid answer shape');
  const validIds = new Set(evidence.map(p => p.evidenceId));
  if (parsed.status === 'insufficient_evidence') {
    if (parsed.blocks.length !== 0) throw new Error('Abstention must contain no factual blocks');
    return { status: 'insufficient_evidence', blocks: [] };
  }
  if (!parsed.blocks.length) throw new Error('Supported answer requires blocks');
  let total = 0;
  const blocks = parsed.blocks.map((block: any) => {
    if (!block || typeof block.text !== 'string' || !block.text.trim() || block.text.length > 6000 || !Array.isArray(block.evidenceIds) || !block.evidenceIds.length || block.evidenceIds.length > 40) throw new Error('Every factual block requires valid evidence');
    if (block.evidenceIds.some((id: unknown) => typeof id !== 'string' || !validIds.has(id))) throw new Error('Unknown evidence ID');
    // Numeric citation labels are supplied by the server, never guessed by the model.
    if (/\[\d+\]/.test(block.text)) throw new Error('Model supplied citation labels');
    total += block.text.length;
    return { text: block.text.trim(), evidenceIds: [...new Set<string>(block.evidenceIds)] };
  });
  if (total > 15000) throw new Error('Answer too long');
  if (parsed.status === 'partial' && (typeof parsed.missingInformation !== 'string' || !parsed.missingInformation.trim() || parsed.missingInformation.length > 1500)) throw new Error('Partial answer must identify its missing support');
  return { status: parsed.status, blocks, missingInformation: parsed.status === 'partial' ? parsed.missingInformation.trim() : undefined };
}

export function passageSource(p: EvidencePassage, citationNumber: number): SourceReference {
  return { citationNumber, evidenceId: p.evidenceId, chunkId: p.chunkId, materialId: p.materialId,
    materialName: p.materialName, versionId: p.versionId, runId: p.runId, excerpt: p.text,
    locator: p.locator, sourceType: 'course_material', pageNumber: p.locator.page,
    section: p.locator.section, url: null, relevance: null, coverageWarning: p.coverageWarning };
}

export function renderAnswer(value: StructuredAnswer, evidence: EvidencePassage[], metadata: Record<string, unknown> = {}): CourseAnswer {
  if (value.status === 'insufficient_evidence') return { content: ABSTENTION, status: value.status, sources: [], evidence, metadata };
  const used: string[] = [];
  for (const block of value.blocks) for (const id of block.evidenceIds) if (!used.includes(id)) used.push(id);
  const sources = used.map((id, i) => passageSource(evidence.find(p => p.evidenceId === id)!, i + 1));
  const content = value.blocks.map(block => `${block.text} ${block.evidenceIds.map(id => `[${used.indexOf(id) + 1}]`).join(' ')}`).join('\n\n')
    + (value.status === 'partial' ? `\n\nMissing support: ${value.missingInformation}` : '');
  return { content, status: value.status, sources, evidence, metadata };
}
