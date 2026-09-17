import type { MaterialIndexState } from '../types/rag';
import './MaterialIndexStatus.css';
const states: Record<string, { label: string; detail: string }> = {
  unindexed: { label: 'Not indexed', detail: 'The file is available to download, but is not yet included in course answers.' },
  uploading: { label: 'Uploading', detail: 'The attachment is being saved before indexing.' },
  queued: { label: 'Waiting to index', detail: 'Course answers can use this attachment after indexing finishes.' },
  processing: { label: 'Indexing', detail: 'The attachment is being prepared for course answers.' },
  ready: { label: 'Available for answers', detail: 'This attachment is included in course answers.' },
  needs_review: { label: 'Review needed', detail: 'Some content could not be extracted reliably. Upload a readable text version to include all content in course answers.' },
  failed: { label: 'Indexing failed', detail: 'This attachment could not be indexed. Contact your course administrator.' },
  upload_failed: { label: 'Upload failed', detail: 'The attachment could not be saved. Retry the upload.' },
};
export default function MaterialIndexStatus({ material, showError = false }: { material: MaterialIndexState; showError?: boolean }) {
  const state = material.ingestion_status || 'unindexed';
  const info = states[state] || states.unindexed;
  const priorAvailable = state !== 'ready' && Boolean(material.published_run_id);
  return <div className={`material-index-status material-index-${state}`}>
    <span className="material-index-label">{state === 'ready' && material.ingestion_warning ? 'Available text indexed' : info.label}</span>
    <p>{info.detail}{priorAvailable ? ' The previously indexed version remains available for answers.' : ''}</p>
    {material.ingestion_warning && <p className="material-index-warning">{material.ingestion_warning}</p>}
    {showError && material.ingestion_error && <p className="material-index-error">{material.ingestion_error}</p>}
  </div>;
}
