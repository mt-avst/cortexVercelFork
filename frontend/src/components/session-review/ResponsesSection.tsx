import React from 'react';
import { FirstHandOutputStep } from '../../api/types';

const STEP_TYPE_LABELS: Record<string, string> = {
  instruction: 'Instruction',
  open_text: 'Open question',
  single_choice: 'Single choice',
  end: 'End'
};

const ResponsesSection: React.FC<{ steps: FirstHandOutputStep[] }> = ({ steps }) => (
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
            ) : (
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
