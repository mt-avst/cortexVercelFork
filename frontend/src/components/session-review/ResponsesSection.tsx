import React from 'react';
import { FirstHandOutputStep } from '../../api/types';

const STEP_TYPE_LABELS: Record<string, string> = {
  instruction: 'Instruction',
  open_text: 'Open question',
  single_choice: 'Single choice',
  end: 'End'
};

const ResponsesSection: React.FC<{
  steps: FirstHandOutputStep[];
  /**
   * Whether this session actually has a recording to point a reviewer at. A
   * step with no stored response reads as "answered out loud in the recording"
   * ONLY when a recording exists; for an abandoned session with no recording
   * that sentence is a fabrication - the tasks come from the study definition,
   * not from anything the participant did. Row 8, a72-session-review-abandoned.
   */
  hasRecording: boolean;
}> = ({ steps, hasRecording }) => (
  <div className="cortex-analytics-card" style={{ marginBottom: '24px' }}>
    <div className="cortex-chart-header">
      <h5 className="cortex-chart-title">Responses</h5>
    </div>

    {steps.length === 0 ? (
      <div className="cortex-no-data" style={{ padding: '24px 0' }}>
        <p>No steps recorded for this session.</p>
      </div>
    ) : (
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {steps.map((step) => (
          <li
            key={step.step_id}
            style={{
              padding: '14px 0',
              borderBottom: '1px solid var(--cortex-border, rgba(255,255,255,0.04))'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '6px' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', fontVariantNumeric: 'tabular-nums' }}>
                {step.order}.
              </span>
              <span style={{ fontWeight: 500 }}>{step.prompt}</span>
              <span className="cortex-badge cortex-badge--info" style={{ fontSize: '0.65rem' }}>
                {STEP_TYPE_LABELS[step.type] ?? step.type}
              </span>
            </div>
            {step.response ? (
              <p style={{ margin: '0 0 0 26px', whiteSpace: 'pre-wrap' }}>
                {step.response.text ?? step.response.selected_option}
              </p>
            ) : hasRecording ? (
              // Nothing typed is captured any more - participants answer out
              // loud, so the recording IS the answer. A step with no stored
              // response is not missing data, whatever its type says: only
              // sessions run before that change carry one. True ONLY when there
              // is a recording to point at.
              <p style={{ margin: '0 0 0 26px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                Answered out loud - in the recording
              </p>
            ) : (
              // No stored response AND no recording: the session did not capture
              // an answer to this step. Say that, rather than pointing at a
              // recording that does not exist.
              <p style={{ margin: '0 0 0 26px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                No response recorded
              </p>
            )}
          </li>
        ))}
      </ol>
    )}
  </div>
);

export default ResponsesSection;
