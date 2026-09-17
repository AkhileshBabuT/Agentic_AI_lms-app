import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { materialSourcesAPI } from '../services/api';
import { sourceLocation } from '../types/rag';
import type { SourceAccess } from '../types/rag';
import './MaterialSourceViewer.css';

/** Navigation resolves permission again; no persisted signed URL or browser JWT in URLs. */
export default function MaterialSourceViewer() {
  const { chunkId } = useParams<{ chunkId: string }>();
  const [access, setAccess] = useState<SourceAccess | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setAccess(null); setError(''); setLoading(true);
    if (!chunkId) { setError('The reference is invalid.'); setLoading(false); return; }
    materialSourcesAPI.resolve(chunkId, controller.signal).then(response => {
      if (controller.signal.aborted) return;
      const url = new URL(response.data.url);
      if (url.protocol !== 'https:') throw new Error('Unusable source URL');
      setAccess(response.data);
    }).catch(failure => {
      if (controller.signal.aborted) return;
      const unavailable = failure.response?.status === 403 || failure.response?.status === 404;
      setError(unavailable ? 'This source is no longer available to you. It may have been removed or your course access may have changed.' : 'The source could not be opened. Please try again.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [chunkId, refresh]);
  const page = access?.source.locator.page;
  const isPdf = access && (/\.pdf$/i.test(access.source.materialName) || Boolean(page));
  const fileUrl = access ? `${access.url}${Number.isSafeInteger(page) && Number(page) > 0 ? `#page=${page}` : ''}` : '';
  return <main className="material-source-viewer">
    <Link to="/ai-agent-hub" className="source-back">Back to AI hub</Link>
    {loading && <p role="status">Loading supporting source...</p>}
    {error && <div className="source-access-error" role="alert"><p>{error}</p>
      <button type="button" onClick={() => setRefresh(value => value + 1)}>Try again</button></div>}
    {access && <>
      <header className="material-source-header">
        <h1>{access.source.materialName}</h1><p>{sourceLocation(access.source.locator)}</p>
        <a href={fileUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
          {isPdf ? 'Open original document' : 'Download original document'}
        </a>
        <button type="button" onClick={() => setRefresh(value => value + 1)}>Refresh document access</button>
      </header>
      <section className="material-source-excerpt" aria-label="Supporting passage">
        <h2>Supporting passage</h2><p className="source-excerpt-help">Text extracted from the referenced document version.</p>
        {access.source.coverageWarning && <p className="source-excerpt-help" role="status">{access.source.coverageWarning}</p>}
        <blockquote>{access.source.excerpt}</blockquote>
      </section>
      {isPdf && <section className="material-source-document" aria-label="Original PDF">
        <h2>Original document</h2><p>If the PDF preview is unavailable, use the document link above. Refresh access if the link expires.</p>
        <iframe src={fileUrl} title={`${access.source.materialName}${page ? `, page ${page}` : ''}`} referrerPolicy="no-referrer" />
      </section>}
    </>}
  </main>;
}
