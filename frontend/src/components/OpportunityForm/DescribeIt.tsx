import React, { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import {
  draftOpportunityFromBrief,
  getAiDraftingAvailable,
  type DraftedOpportunity
} from '../../api/client';

/**
 * D13 - the "Describe it" front-door AI panel (docs/AI-STUDY-DRAFTING-SPEC.md).
 *
 * W6 built the dormant shell in StudyTypePicker.tsx: the prompt, the label,
 * the reassurance copy, and an inert "Suggest a type" button. This component
 * is what W9 wires behind it - StudyTypePicker mounts it in place of that
 * shell and passes through the researcher's current type/delivery choice as
 * hints.
 *
 * Three states the researcher can see, and one they cannot:
 *  - HIDDEN: renders null. This is the state with no key/flag configured (the
 *    beta today), discovered once at mount via `/api/health`'s `aiDrafting`
 *    field, and also reached if a draft call itself ever answers 503 - no
 *    error, no broken UI, just the plain type picker underneath.
 *  - IDLE / REVIEWING: the live panel - a textarea, a working Suggest button,
 *    and once a draft comes back, a review list the researcher can Apply or
 *    Discard. Nothing is saved at any point in this flow.
 *  - INERT (fallback): a draft call failed for a reason OTHER than the
 *    capability being off (429, 422, timeout, 5xx) - the panel falls back to
 *    the same look as the ORIGINAL dormant shell, plus one line saying what
 *    happened, so the researcher can still fill in the form by hand.
 */

type DeliveryMode = 'native' | 'external';

export interface DescribeItProps {
  /** The researcher's current choice on the picker, sent as hints - the model may still override an UNSET type, but a hint always wins. */
  hints?: { type?: string; delivery_mode?: DeliveryMode };
  /** Called with the validated draft when the researcher clicks Apply. Applies to (unsaved) form state only - never calls the save endpoint. */
  onApply: (draft: DraftedOpportunity) => void;
}

const MIN_BRIEF_LENGTH = 20;
const MAX_BRIEF_LENGTH = 8000;

/** A drafted field name, in the words a researcher would use for it. */
const FIELD_LABELS: Record<string, string> = {
  type: 'Study type',
  delivery_mode: 'Where participants answer',
  title: 'Title',
  purpose_one_liner: 'Purpose',
  description_optional: 'Description',
  product_optional: 'Product',
  participant_type_required: 'Who can take part',
  participant_type_specific_details: 'Eligibility details',
  default_duration_minutes: 'Duration',
  external_link_optional: 'External link',
  consent_text: 'Consent',
  inline_study: 'Task list',
  inline_survey: 'Questions'
};

const fieldLabel = (name: string): string => FIELD_LABELS[name] ?? name;

const DescribeIt: React.FC<DescribeItProps> = ({ hints, onApply }) => {
  const [available, setAvailable] = useState<'checking' | 'yes' | 'no'>('checking');
  const [brief, setBrief] = useState('');
  const [phase, setPhase] = useState<'idle' | 'loading' | 'reviewing' | 'inert'>('idle');
  const [result, setResult] = useState<{
    draft: DraftedOpportunity;
    assumptions: string[];
    gaps: string[];
    filled: string[];
  } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAiDraftingAvailable().then((yes) => {
      if (!cancelled) {
        setAvailable(yes ? 'yes' : 'no');
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (available !== 'yes') {
    return null;
  }

  const briefTooShort = brief.trim().length < MIN_BRIEF_LENGTH;
  const briefTooLong = brief.length > MAX_BRIEF_LENGTH;

  const handleSuggest = async () => {
    setPhase('loading');
    setErrorMessage(null);
    try {
      const response = await draftOpportunityFromBrief(brief.trim(), hints);
      setResult(response);
      setPhase('reviewing');
    } catch (error: unknown) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 503) {
        // Discovered only now (the capability flipped off mid-session, or the
        // health check briefly disagreed with the endpoint) - hide entirely,
        // the same as if the initial check had already said so.
        setAvailable('no');
        return;
      }
      setPhase('inert');
      setErrorMessage(
        status === 429
          ? 'Too many draft requests just now. Wait a minute, or fill in the fields directly below.'
          : status === 422
            ? "That brief didn't produce a usable draft. Try adding more detail, or fill in the fields directly below."
            : 'AI drafting is unavailable right now. Fill in the fields directly below.'
      );
    }
  };

  const handleApply = () => {
    if (result) {
      onApply(result.draft);
    }
    setPhase('idle');
    setResult(null);
  };

  const handleDiscard = () => {
    setPhase('idle');
    setResult(null);
  };

  return (
    <div
      className="form-section mb-3 p-3"
      data-testid="front-door-ai-prompt"
      // cto/AdaptaLabs#141: --fs-border is never defined anywhere in src, so
      // this always rendered the #d0d0d0 fallback in both themes.
      // --border-card is the theme-aware token already used for this kind
      // of plain section/card border elsewhere (ConsentStep, admin-feedback.css).
      style={{ border: '1px solid var(--border-card)', borderRadius: '4px' }}
    >
      <label
        htmlFor="ai_study_prompt"
        className="form-label mb-1 d-flex align-items-center gap-2"
        style={{ fontSize: '1rem', fontWeight: '600' }}
      >
        <Sparkles size={16} aria-hidden="true" />
        What do you want to find out?
      </label>
      <textarea
        id="ai_study_prompt"
        className="form-control"
        rows={2}
        style={{ fontSize: '0.95rem' }}
        placeholder="e.g. Do first-time admins understand the new board view well enough to set one up without help?"
        value={brief}
        disabled={phase === 'loading' || phase === 'reviewing'}
        onChange={(event) => setBrief(event.target.value)}
      />

      {briefTooLong && (
        <p className="form-text mt-1 mb-0 text-danger" style={{ fontSize: '0.8rem' }}>
          That is too long to draft from - keep it under {MAX_BRIEF_LENGTH.toLocaleString()} characters.
        </p>
      )}

      {phase !== 'reviewing' && (
        <div className="mt-2">
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm"
            disabled={phase === 'loading' || phase === 'inert' || briefTooShort || briefTooLong}
            onClick={handleSuggest}
          >
            {phase === 'loading' ? 'Drafting…' : 'Suggest a type'}
          </button>
        </div>
      )}

      {phase === 'inert' && errorMessage && (
        <p className="form-text mt-2 mb-0 text-danger" role="alert" style={{ fontSize: '0.8rem' }}>
          {errorMessage}
        </p>
      )}

      {phase !== 'reviewing' && phase !== 'inert' && (
        <p className="form-text mt-2 mb-0" style={{ fontSize: '0.8rem' }}>
          Nothing here is saved, and typing creates no draft. Suggest a type to see a draft
          below - you still choose.
        </p>
      )}

      {phase === 'reviewing' && result && (
        <div className="mt-3" data-testid="ai-draft-review">
          {result.filled.length > 0 && (
            <div className="mb-2">
              <p className="mb-1" style={{ fontSize: '0.85rem', fontWeight: '600' }}>
                Filled in from your brief
              </p>
              <ul className="mb-0" style={{ fontSize: '0.85rem' }}>
                {result.filled.map((name) => (
                  <li key={name}>{fieldLabel(name)}</li>
                ))}
              </ul>
            </div>
          )}

          {result.assumptions.length > 0 && (
            <div className="mb-2">
              <p className="mb-1" style={{ fontSize: '0.85rem', fontWeight: '600' }}>
                Assumed
              </p>
              <ul className="mb-0" style={{ fontSize: '0.85rem' }}>
                {result.assumptions.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </div>
          )}

          {result.gaps.length > 0 && (
            <div className="mb-2">
              <p className="mb-1" style={{ fontSize: '0.85rem', fontWeight: '600' }}>
                Left for you to fill in
              </p>
              <ul className="mb-0" style={{ fontSize: '0.85rem' }}>
                {result.gaps.map((line, index) => (
                  <li key={index} style={{ textDecoration: 'underline dotted' }}>
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="d-flex gap-2 mt-2">
            <button type="button" className="btn btn-primary btn-sm" onClick={handleApply}>
              Apply to form
            </button>
            <button type="button" className="btn btn-outline-secondary btn-sm" onClick={handleDiscard}>
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default DescribeIt;
