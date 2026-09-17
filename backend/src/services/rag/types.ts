export type AnswerStatus = 'answered' | 'partial' | 'insufficient_evidence';
export interface SourceLocator { page?: number; section?: string; kind?: string; start?: number; end?: number }
export interface EvidencePassage {
  evidenceId: string; chunkId: string; materialId: number; courseId: number;
  materialName: string; versionId: string; runId: string; text: string;
  locator: SourceLocator; tokenCount: number;
  coverageWarning?: string | null;
}
export interface SourceReference {
  citationNumber: number; evidenceId: string; chunkId: string; materialId: number;
  materialName: string; versionId: string; runId: string; excerpt: string;
  locator: SourceLocator; sourceType: 'course_material'; pageNumber?: number;
  section?: string; url: null; relevance: null;
  coverageWarning?: string | null;
}
export interface CourseAnswer {
  content: string; status: AnswerStatus; sources: SourceReference[];
  metadata: Record<string, unknown>; evidence: EvidencePassage[];
}
export interface CourseIdentity { courseId: number; userId: number; role: string }
export class RagAccessError extends Error {
  readonly status = 403;
  constructor(message = 'You do not have access to this course or source') { super(message); }
}
export class RagConflictError extends Error {
  readonly status = 409;
  constructor() { super('Course materials changed while answering. Please try again.'); }
}
