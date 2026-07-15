import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import TranscriptSection from '../TranscriptSection';
import { FirstHandTranscript } from '../../../api/types';

const transcript: FirstHandTranscript = {
  body: 'Full transcript text.',
  created_at: '2026-07-15T10:14:35.000Z',
  source: 'prototype_generated',
  segments: [
    {
      id: 'seg_1',
      step_id: 'step_1',
      speaker: 'system',
      speaker_label: 'Moderator',
      text: 'How did you find the checkout?',
      timestamp: '2026-07-15T10:04:00.000Z'
    },
    {
      id: 'seg_2',
      step_id: 'step_1',
      speaker: 'participant',
      speaker_label: 'Jane Doe',
      text: 'It was straightforward.',
      timestamp: '2026-07-15T10:05:00.000Z'
    }
  ]
};

describe('TranscriptSection', () => {
  it('renders transcript segments with speaker labels', () => {
    render(
      <TranscriptSection
        transcript={transcript}
        transcriptStatus="complete"
        transcriptFailureMessage={null}
        onRefresh={() => undefined}
      />
    );

    expect(screen.getByText('Moderator')).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('It was straightforward.')).toBeInTheDocument();
  });

  it.each(['queued', 'processing'] as const)(
    'shows the pending state with a working refresh button when %s',
    (status) => {
      const onRefresh = vi.fn();
      render(
        <TranscriptSection
          transcript={null}
          transcriptStatus={status}
          transcriptFailureMessage={null}
          onRefresh={onRefresh}
        />
      );

      expect(screen.getByText('Transcript is still being processed.')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      expect(onRefresh).toHaveBeenCalledTimes(1);
    }
  );

  it('shows the failure message when generation failed', () => {
    render(
      <TranscriptSection
        transcript={null}
        transcriptStatus="failed"
        transcriptFailureMessage="Transcription service unavailable"
        onRefresh={() => undefined}
      />
    );

    expect(screen.getByText('Transcript generation failed.')).toBeInTheDocument();
    expect(screen.getByText('Transcription service unavailable')).toBeInTheDocument();
  });

  it('shows the not-requested state', () => {
    render(
      <TranscriptSection
        transcript={null}
        transcriptStatus="not_requested"
        transcriptFailureMessage={null}
        onRefresh={() => undefined}
      />
    );

    expect(screen.getByText('No transcript was requested for this session.')).toBeInTheDocument();
  });
});
