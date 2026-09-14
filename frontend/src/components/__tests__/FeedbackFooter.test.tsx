import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

import FeedbackFooter from '../FeedbackFooter';
import { submitFeedback } from '../../api/client';

// The feedback table's CHECK constraint (backend/src/db/migrate.ts) only
// accepts 'bug' | 'feature' | 'question' | 'other'. The footer used to submit
// 'footer', which isn't in that set - every submission through this form
// failed with a 500 in production, invisibly, because nothing pinned the
// category to the set the database actually accepts.
const VALID_CATEGORIES = ['bug', 'feature', 'question', 'other'];

vi.mock('../../api/client', () => ({
  submitFeedback: vi.fn().mockResolvedValue({ success: true }),
}));

const mockSubmitFeedback = vi.mocked(submitFeedback);

describe('FeedbackFooter', () => {
  it('submits a category the feedback table actually accepts', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><FeedbackFooter /></MemoryRouter>);

    await user.type(screen.getByLabelText('How we can improve Cortex'), 'This is broken');
    await user.click(screen.getByRole('button', { name: 'Send feedback' }));

    await waitFor(() => expect(mockSubmitFeedback).toHaveBeenCalled());

    const { category } = mockSubmitFeedback.mock.calls[0][0];
    expect(VALID_CATEGORIES).toContain(category);
  });

  // Row 22 (second-pass review): /feedback has its own dedicated form: the
  // footer rendering its identical prompt underneath it offered the same
  // request twice on the one page built to collect it.
  it('renders nothing on the /feedback page', () => {
    render(
      <MemoryRouter initialEntries={['/feedback']}>
        <FeedbackFooter />
      </MemoryRouter>
    );

    expect(screen.queryByLabelText('How we can improve Cortex')).toBeNull();
  });

  it('still renders elsewhere', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <FeedbackFooter />
      </MemoryRouter>
    );

    expect(screen.getByLabelText('How we can improve Cortex')).toBeInTheDocument();
  });
});
