import React, { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { materialSourcesAPI } from '../services/api';
import { sourceLocation } from '../types/rag';
import type { CourseSource } from '../types/rag';
import './MessageMetadata.css';

interface MessageMetadataProps { messageId: number; savedContentId?: number; metadata?: Record<string, unknown> | null }

/** Only authenticated, currently authorized source rows appear here, including for history. */
const MessageMetadata: React.FC<MessageMetadataProps> = ({ messageId, savedContentId, metadata }) => {
  const [sources, setSources] = useState<CourseSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [restricted, setRestricted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const regionId = useId();
  useEffect(() => {
    const controller = new AbortController();
    setSources([]); setLoading(true); setError(''); setRestricted(false);
    const request = savedContentId ? materialSourcesAPI.getSavedContent(savedContentId, controller.signal)
      : materialSourcesAPI.getAnswer(messageId, controller.signal);
    request.then(response => {
      if (controller.signal.aborted) return;
      setRestricted(response.data.restricted === true);
      setSources(response.data.restricted ? [] : response.data.sources || []);
    }).catch(failure => {
      if (controller.signal.aborted) return;
      const forbidden = failure.response?.status === 403 || failure.response?.status === 404;
      setError(forbidden ? 'These references are no longer available to you.' : 'References could not be loaded.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [messageId, savedContentId, refresh]);

  const status = metadata?.answerStatus;
  const currentPipeline = typeof metadata?.ragPipelineVersion === 'string';
  const coverageWarnings = [...new Set(sources.map(source => source.coverageWarning).filter((warning): warning is string => Boolean(warning)))];
  return (
    <div className="message-metadata">
      {status === 'insufficient_evidence' && <p className="answer-evidence-notice" role="status">The available course materials do not provide enough evidence to answer this question.</p>}
      {status === 'partial' && <p className="answer-evidence-notice" role="status">The course materials support part of this answer. Uncovered details are marked in the response.</p>}
      {status === 'source_unavailable' && <p className="answer-evidence-notice" role="status">This answer is unavailable because access to a supporting source has changed.</p>}
      {currentPipeline && <span className="course-only-label">Course materials only</span>}
      {coverageWarnings.map(warning => <p key={warning} className="answer-evidence-notice" role="status">{warning}</p>)}
      {loading && <p className="references-state" role="status">Loading references...</p>}
      {!loading && (error || restricted) && <div className="references-state" role="status">
        <p>{error || 'A supporting source is no longer available. References have been withheld.'}</p>
        <button type="button" className="references-refresh" onClick={() => setRefresh(value => value + 1)}>Refresh references</button>
      </div>}
      {!loading && !error && !restricted && sources.length > 0 && <>
        <button type="button" className="references-toggle" aria-expanded={expanded} aria-controls={regionId}
          onClick={() => setExpanded(value => !value)}>
          {sources.length} {sources.length === 1 ? 'reference' : 'references'} {expanded ? '−' : '+'}
        </button>
        {expanded && <div className="answer-references" id={regionId}>
          {sources.map(source => <article className="answer-reference" key={`${source.chunkId}:${source.citationNumber}`}>
            <div className="reference-heading"><span className="reference-number">[{source.citationNumber}]</span><strong>{source.materialName}</strong></div>
            <p className="reference-location">{sourceLocation(source.locator)}</p>
            <blockquote className="reference-excerpt">{source.excerpt}</blockquote>
            <Link className="reference-open" to={`/material-source/${source.chunkId}`} target="_blank" rel="noopener noreferrer">Open supporting passage</Link>
          </article>)}
          <button type="button" className="references-refresh" onClick={() => setRefresh(value => value + 1)}>Refresh references</button>
        </div>}
      </>}
      {!loading && !error && !restricted && sources.length === 0 && !currentPipeline && <p className="references-state">Document references are unavailable for this earlier answer.</p>}
    </div>
  );
};
export default MessageMetadata;
