export type AnswerStatus = 'answered' | 'partial' | 'insufficient_evidence';
export interface SourceLocator { page?: number; section?: string; kind?: string; start?: number; end?: number }
export interface CourseSource {
  citationNumber: number; evidenceId: string; chunkId: string; materialId: number;
  materialName: string; versionId: string; runId: string; excerpt: string;
  locator: SourceLocator; sourceType: 'course_material';
  coverageWarning?: string | null;
}
export interface AnswerReferences { sources: CourseSource[]; restricted: boolean }
export interface SourceAccess { source: CourseSource; url: string }
export interface MaterialIndexState {
  ingestion_status?: string; ingestion_error?: string | null; ingestion_warning?: string | null; published_run_id?: string | null;
}
export function sourceLocation(locator: SourceLocator): string {
  if (Number.isSafeInteger(locator.page) && Number(locator.page) > 0) return `Page ${locator.page}`;
  return locator.section || 'Extracted passage';
}
