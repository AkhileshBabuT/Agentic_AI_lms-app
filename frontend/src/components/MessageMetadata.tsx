import React, { useEffect, useState, useRef, useCallback } from 'react';
import { chatAPI } from '../services/api';
import type {
  ResponseSource,
  TrustScore,
  FactCheckResult,
  EmotionalFilterData,
} from '../types/agenticai';
import {
  getTrustScoreColor,
  getTrustLevelLabel,
  getAccuracyScoreColor,
  getAccuracyLevelLabel,
  getVerdictColor,
  getEmotionColor,
  getEmotionEmoji,
} from '../types/agenticai';
import ScoreExplainer from './ScoreExplainer';
import './MessageMetadata.css';

const MAX_POLL_ATTEMPTS = 5;

interface MessageMetadataProps {
  messageId: number;
  metadata: any;
}

const MessageMetadata: React.FC<MessageMetadataProps> = ({ messageId, metadata }) => {
  const [sources, setSources] = useState<ResponseSource[]>([]);
  const [trustScore, setTrustScore] = useState<TrustScore | null>(null);
  const [factCheck, setFactCheck] = useState<FactCheckResult | null>(null);
  const [loadingSources, setLoadingSources] = useState(true);
  const [loadingTrust, setLoadingTrust] = useState(true);
  const [loadingFactCheck, setLoadingFactCheck] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [showFactCheck, setShowFactCheck] = useState(false);

  const trustDropdownRef = useRef<HTMLDivElement>(null);
  const sourcesDropdownRef = useRef<HTMLDivElement>(null);
  const factCheckDropdownRef = useRef<HTMLDivElement>(null);
  const cancelledRef = useRef(false);

  // Parse emotional filter data from metadata
  const emotionalFilter: EmotionalFilterData | null = metadata?.emotionalFilter || null;

  const fetchSources = useCallback(async () => {
    try {
      const response = await chatAPI.getSources(messageId);
      if (!cancelledRef.current) setSources(response.data.sources || []);
    } catch (error) {
      console.error('Error fetching sources:', error);
      if (!cancelledRef.current) setSources([]);
    } finally {
      if (!cancelledRef.current) setLoadingSources(false);
    }
  }, [messageId]);

  const fetchTrustScore = useCallback(async (attempt = 0) => {
    try {
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (cancelledRef.current) return;
      const response = await chatAPI.getTrustScore(messageId);
      if (!cancelledRef.current) setTrustScore(response.data.trustScore);
    } catch (error: any) {
      if (error.response?.status === 404 && attempt < MAX_POLL_ATTEMPTS && !cancelledRef.current) {
        setTimeout(() => {
          if (!cancelledRef.current) fetchTrustScore(attempt + 1);
        }, 3000);
        return; // Don't set loadingTrust to false yet — still polling
      }
    } finally {
      if (!cancelledRef.current) setLoadingTrust(false);
    }
  }, [messageId]);

  const fetchFactCheck = useCallback(async (attempt = 0) => {
    try {
      await new Promise(resolve => setTimeout(resolve, 3000));
      if (cancelledRef.current) return;
      const response = await chatAPI.getFactCheck(messageId);
      if (!cancelledRef.current) setFactCheck(response.data.factCheck);
    } catch (error: any) {
      if (error.response?.status === 404 && attempt < MAX_POLL_ATTEMPTS && !cancelledRef.current) {
        setTimeout(() => {
          if (!cancelledRef.current) fetchFactCheck(attempt + 1);
        }, 4000);
        return; // Don't set loadingFactCheck to false yet — still polling
      }
    } finally {
      if (!cancelledRef.current) setLoadingFactCheck(false);
    }
  }, [messageId]);

  useEffect(() => {
    cancelledRef.current = false;
    fetchSources();
    fetchTrustScore();
    fetchFactCheck();

    return () => {
      cancelledRef.current = true;
    };
  }, [messageId, fetchSources, fetchTrustScore, fetchFactCheck]);

  // Handle click outside to close dropdowns
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;

      // Close trust score dropdown if clicked outside
      if (trustDropdownRef.current && !trustDropdownRef.current.contains(event.target as Node)) {
        if (!target.closest('.trust-badge')) {
          setShowDetails(false);
        }
      }

      // Close sources dropdown if clicked outside
      if (sourcesDropdownRef.current && !sourcesDropdownRef.current.contains(event.target as Node)) {
        if (!target.closest('.sources-badge')) {
          setShowSources(false);
        }
      }

      // Close fact-check dropdown if clicked outside
      if (factCheckDropdownRef.current && !factCheckDropdownRef.current.contains(event.target as Node)) {
        if (!target.closest('.fact-check-badge')) {
          setShowFactCheck(false);
        }
      }
    };

    if (showDetails || showSources || showFactCheck) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showDetails, showSources, showFactCheck]);

  const sourcesCount = metadata?.sourcesCount || sources.length;

  return (
    <div className="message-metadata">
      {/* Quick Stats */}
      <div className="metadata-quick-stats">
        {!loadingSources && sourcesCount > 0 && (
          <button
            className="metadata-badge sources-badge"
            onClick={() => setShowSources(!showSources)}
            title="View sources"
          >
            {sourcesCount} {sourcesCount === 1 ? 'Source' : 'Sources'}
          </button>
        )}

        {loadingTrust ? (
          <span className="metadata-badge verifying-badge">
            Verifying...
          </span>
        ) : trustScore ? (
          <button
            className="metadata-badge trust-badge"
            style={{ borderColor: getTrustScoreColor(trustScore.trust_score) }}
            onClick={() => setShowDetails(!showDetails)}
            title="View verification details"
          >
            <span className="trust-icon" style={{ color: getTrustScoreColor(trustScore.trust_score) }}>
              {trustScore.trust_score >= 70 ? 'V' : trustScore.trust_score >= 50 ? '!' : 'X'}
            </span>
            Trust: {trustScore.trust_score}/100
          </button>
        ) : null}

        {/* Validation Badge (independent verifier) — only when a validation score exists */}
        {!loadingTrust && trustScore && trustScore.validation_score != null && (
          <span
            className="metadata-badge validation-badge"
            style={{ borderColor: getTrustScoreColor(trustScore.validation_score) }}
            title="Independent validation score"
          >
            <span style={{ color: getTrustScoreColor(trustScore.validation_score) }}>
              {trustScore.validation_score >= 70 ? 'V' : trustScore.validation_score >= 50 ? '!' : 'X'}
            </span>
            Validation {trustScore.validation_score}
          </span>
        )}

        {/* Emotional Indicator Badge */}
        {emotionalFilter && emotionalFilter.applied && (
          <span
            className="metadata-badge emotion-badge"
            style={{ borderColor: getEmotionColor(emotionalFilter.detectedEmotion) }}
            title={`Detected: ${emotionalFilter.detectedEmotion} (${emotionalFilter.emotionIntensity}) | Tone: ${emotionalFilter.appliedTone}`}
          >
            <span>{getEmotionEmoji(emotionalFilter.detectedEmotion)}</span>
            {emotionalFilter.detectedEmotion}
          </span>
        )}

        {/* Fact-Check Badge */}
        {loadingFactCheck ? (
          <span className="metadata-badge fact-check-loading-badge">
            Checking...
          </span>
        ) : factCheck && factCheck.status === 'completed' ? (
          <button
            className="metadata-badge fact-check-badge"
            style={{ borderColor: getAccuracyScoreColor(factCheck.overall_accuracy_score) }}
            onClick={() => setShowFactCheck(!showFactCheck)}
            title="View fact-check details"
          >
            <span style={{ color: getAccuracyScoreColor(factCheck.overall_accuracy_score) }}>
              {factCheck.overall_accuracy_score >= 70 ? 'V' : factCheck.overall_accuracy_score >= 50 ? '!' : 'X'}
            </span>
            Fact Check: {factCheck.overall_accuracy_score}/100
          </button>
        ) : null}

        <ScoreExplainer />

        {metadata?.sourceOfTruthMode && (
          <span
            className="metadata-badge"
            title={metadata.sourceOfTruthMode === 'strict'
              ? 'Answered using course materials only'
              : 'External sources (web / general knowledge) were allowed'}
          >
            {metadata.sourceOfTruthMode === 'strict' ? '📚 Course materials only' : '🌐 External allowed'}
          </span>
        )}
      </div>

      {/* Validation warnings — only when trust score is loaded and present */}
      {!loadingTrust && trustScore && (trustScore.verifiers_disagree || trustScore.low_validation_warning) && (
        <div className="metadata-validation-warnings">
          {trustScore.verifiers_disagree && (
            <span className="metadata-warning" style={{ color: '#f97316' }} title="The independent verifiers did not agree">
              ! Verifiers disagreed — extra caution
            </span>
          )}
          {trustScore.low_validation_warning && (
            <span className="metadata-warning" style={{ color: '#ef4444' }} title="Answer weakly grounded in course materials">
              ! Answer weakly grounded in course materials
            </span>
          )}
        </div>
      )}

      {/* Sources Dropdown */}
      {showSources && sources.length > 0 && (
        <div className="metadata-dropdown sources-dropdown" ref={sourcesDropdownRef}>
          <div className="dropdown-header">
            <h4>Sources Referenced</h4>
            <button className="close-btn" onClick={() => setShowSources(false)}>X</button>
          </div>
          <div className="dropdown-content">
            {sources.map((source, index) => (
              <div key={source.id} className="source-item">
                <div className="source-header">
                  <span className="source-number">{index + 1}</span>
                  <span className="source-type-badge">{source.source_type}</span>
                </div>
                <div className="source-details">
                  {source.source_type === 'course_material' ? (
                    <>
                      <div className="source-name">
                        {source.source_name}
                        {source.page_number && <span className="page-info"> (Page {source.page_number})</span>}
                      </div>
                      {source.source_excerpt && (
                        <div className="source-excerpt">"{source.source_excerpt}"</div>
                      )}
                    </>
                  ) : source.source_type === 'internet' ? (
                    <>
                      <div className="source-name">{source.source_name}</div>
                      {source.source_url && (
                        <a
                          href={source.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="source-link"
                        >
                          {source.source_url}
                        </a>
                      )}
                      {source.source_excerpt && (
                        <div className="source-excerpt">"{source.source_excerpt}"</div>
                      )}
                    </>
                  ) : (
                    <div className="source-name">{source.source_name}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Trust Score Details Dropdown */}
      {showDetails && trustScore && (
        <div className="metadata-dropdown trust-dropdown" ref={trustDropdownRef}>
          <div className="dropdown-header">
            <h4>Verification Details</h4>
            <button className="close-btn" onClick={() => setShowDetails(false)}>X</button>
          </div>
          <div className="dropdown-content">
            <div className="trust-score-display">
              <div
                className="trust-score-circle"
                style={{ borderColor: getTrustScoreColor(trustScore.trust_score) }}
              >
                <span className="score-number" style={{ color: getTrustScoreColor(trustScore.trust_score) }}>
                  {trustScore.trust_score}
                </span>
                <span className="score-label">/ 100</span>
              </div>
              <div className="trust-level-label" style={{ color: getTrustScoreColor(trustScore.trust_score) }}>
                {getTrustLevelLabel(trustScore.trust_level)}
              </div>
            </div>

            <div className="verification-section">
              <h5>Reasoning:</h5>
              <p>{trustScore.verification_reasoning}</p>
            </div>

            {trustScore.source_verification_details?.evidence_summary && (
              <div className="verification-section">
                <h5>Evidence Summary:</h5>
                <p>{trustScore.source_verification_details.evidence_summary}</p>
              </div>
            )}

            {trustScore.conflicts_detected && trustScore.conflicts_detected.length > 0 && (
              <div className="verification-section conflicts">
                <h5>Conflicts Detected:</h5>
                <ul>
                  {trustScore.conflicts_detected.map((conflict, index) => (
                    <li key={index}>{conflict}</li>
                  ))}
                </ul>
              </div>
            )}

            {trustScore.source_verification_details?.verification_details &&
              trustScore.source_verification_details.verification_details.length > 0 && (
                <div className="verification-section">
                  <h5>Source Verification:</h5>
                  {trustScore.source_verification_details.verification_details.map((detail, index) => (
                    <div key={index} className="verification-detail">
                      <div className="detail-header">
                        <strong>{detail.source}</strong>
                        <span className={`match-badge ${detail.match_quality}`}>
                          {detail.match_quality}
                        </span>
                      </div>
                      <p className="detail-evidence">{detail.evidence}</p>
                    </div>
                  ))}
                </div>
              )}

            <div className="verified-by">
              <small>Verified by: {trustScore.verified_by}</small>
              <small>at {new Date(trustScore.verification_timestamp).toLocaleString()}</small>
            </div>
          </div>
        </div>
      )}

      {/* Fact-Check Details Dropdown */}
      {showFactCheck && factCheck && factCheck.status === 'completed' && (
        <div className="metadata-dropdown fact-check-dropdown" ref={factCheckDropdownRef}>
          <div className="dropdown-header">
            <h4>Independent Fact-Check (Groq)</h4>
            <button className="close-btn" onClick={() => setShowFactCheck(false)}>X</button>
          </div>
          <div className="dropdown-content">
            {/* Score Display */}
            <div className="trust-score-display">
              <div
                className="trust-score-circle"
                style={{ borderColor: getAccuracyScoreColor(factCheck.overall_accuracy_score) }}
              >
                <span className="score-number" style={{ color: getAccuracyScoreColor(factCheck.overall_accuracy_score) }}>
                  {factCheck.overall_accuracy_score}
                </span>
                <span className="score-label">/ 100</span>
              </div>
              <div className="trust-level-label" style={{ color: getAccuracyScoreColor(factCheck.overall_accuracy_score) }}>
                {getAccuracyLevelLabel(factCheck.accuracy_level)}
              </div>
            </div>

            {/* Summary */}
            <div className="verification-section">
              <h5>Summary:</h5>
              <p>{factCheck.summary}</p>
            </div>

            {/* Claim Stats */}
            <div className="verification-section">
              <h5>Claims Analysis:</h5>
              <div className="claim-stats">
                <span className="claim-stat verified">{factCheck.verified_claims} verified</span>
                <span className="claim-stat inaccurate">{factCheck.inaccurate_claims} inaccurate</span>
                <span className="claim-stat unverifiable">{factCheck.unverifiable_claims} unverifiable</span>
              </div>
            </div>

            {/* Individual Claims */}
            {factCheck.claims_checked && factCheck.claims_checked.length > 0 && (
              <div className="verification-section">
                <h5>Claim-by-Claim:</h5>
                {factCheck.claims_checked.map((claim, index) => (
                  <div
                    key={index}
                    className="verification-detail"
                    style={{ borderLeftColor: getVerdictColor(claim.verdict) }}
                  >
                    <div className="detail-header">
                      <strong>{claim.claim.length > 100 ? claim.claim.substring(0, 100) + '...' : claim.claim}</strong>
                      <span className={`match-badge ${claim.verdict}`}>{claim.verdict.replace('_', ' ')}</span>
                    </div>
                    <p className="detail-evidence">{claim.explanation}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="verified-by">
              <small>Checked by: Groq ({factCheck.groq_model})</small>
              <small>in {factCheck.processing_time_ms}ms</small>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MessageMetadata;
