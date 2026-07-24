import React, { useState, useRef, useEffect } from 'react';
import './ScoreExplainer.css';

const ROWS = [
  {
    name: 'Trust',
    what: 'Two independent AI verifiers (a Groq model jury) each judge whether the answer is well-supported; the score reconciles their verdicts.',
  },
  {
    name: 'Validation',
    what: 'Measures how closely the answer’s sentences match the actual course materials (semantic similarity). Low = the answer may not come from your documents.',
  },
  {
    name: 'Fact Check',
    what: 'A separate AI independently verifies each factual claim in the answer and reports accurate / inaccurate / unverifiable per claim.',
  },
];

const ScoreExplainer: React.FC = () => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div className="score-explainer" ref={ref}>
      <button
        className="score-explainer-btn"
        onClick={() => setOpen(!open)}
        aria-label="What do these scores mean?"
        title="What do these scores mean?"
      >
        i
      </button>
      {open && (
        <div className="score-explainer-popover" role="dialog" aria-label="Score explanations">
          <h4>What these scores mean</h4>
          {ROWS.map(r => (
            <div key={r.name} className="score-explainer-row">
              <strong>{r.name}</strong>
              <p>{r.what}</p>
            </div>
          ))}
          <div className="score-explainer-bands">
            <span className="band good">70–100 good</span>
            <span className="band warn">50–69 caution</span>
            <span className="band bad">0–49 unreliable</span>
          </div>
          <p className="score-explainer-flags">
            ⚠ warnings appear when the verifiers disagree with each other, or when the answer is
            weakly grounded in the course materials.
          </p>
        </div>
      )}
    </div>
  );
};

export default ScoreExplainer;
