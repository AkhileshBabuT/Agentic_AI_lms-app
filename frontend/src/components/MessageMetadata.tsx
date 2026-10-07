import React, { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { materialSourcesAPI } from '../services/api';
import { sourceLocation } from '../types/rag';
import type { CourseSource } from '../types/rag';
import { Drawer } from './ui';
import './MessageMetadata.css';

interface MessageMetadataProps { messageId: number; savedContentId?: number; metadata?: Record<string, unknown> | null;
  authorizedSources?: CourseSource[] }

/** Only authenticated, currently authorized source rows appear here, including for history. */
const MessageMetadata: React.FC<MessageMetadataProps> = ({ messageId, savedContentId, metadata, authorizedSources }) => {
  const [sources, setSources] = useState<CourseSource[]>(authorizedSources ?? []);
  const [loading, setLoading] = useState(authorizedSources === undefined);
  const [error, setError] = useState('');
  const [restricted, setRestricted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const regionId = useId();
  useEffect(() => {
    const controller = new AbortController();
    if (authorizedSources !== undefined && refresh === 0 && !savedContentId) {
      setSources(authorizedSources);
      setRestricted(metadata?.answerStatus === 'source_unavailable');
      setError(''); setLoading(false);
      return () => controller.abort();
    }
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
  }, [messageId, savedContentId, refresh, authorizedSources, metadata?.answerStatus]);

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
        <div className="reference-chips" aria-label="Cited sources">
          {sources.map(source => <button type="button" className="reference-chip" key={`${source.chunkId}:${source.citationNumber}`}
            onClick={() => setExpanded(true)} aria-label={`Source ${source.citationNumber}: ${source.materialName}`}>
            [{source.citationNumber}]
          </button>)}
        </div>
        <button type="button" className="references-toggle" aria-expanded={expanded} aria-controls={regionId}
          onClick={() => setExpanded(value => !value)}>
          {sources.length} {sources.length === 1 ? 'reference' : 'references'} {expanded ? '−' : '+'}
        </button>
        <Drawer open={expanded} onClose={() => setExpanded(false)} title="Supporting course sources">
          <div className="answer-references" id={regionId}>
          {sources.map(source => <article className="answer-reference" key={`${source.chunkId}:${source.citationNumber}`}>
            <div className="reference-heading"><span className="reference-number">[{source.citationNumber}]</span><strong>{source.materialName}</strong></div>
            <p className="reference-location">{sourceLocation(source.locator)}</p>
            <blockquote className="reference-excerpt">{source.excerpt}</blockquote>
            {source.coverageWarning && <p className="answer-evidence-notice">{source.coverageWarning}</p>}
            <Link className="reference-open" to={`/material-source/${source.chunkId}`} target="_blank" rel="noopener noreferrer">Open supporting passage</Link>
          </article>)}
          <button type="button" className="references-refresh" onClick={() => setRefresh(value => value + 1)}>Refresh references</button>
          </div>
        </Drawer>
      </>}
      {!loading && !error && !restricted && sources.length === 0 && !currentPipeline && <p className="references-state">Document references are unavailable for this earlier answer.</p>}
    </div>
  );
};
export default MessageMetadata;
