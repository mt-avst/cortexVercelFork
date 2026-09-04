import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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
    render(<FeedbackFooter />);

    await user.type(screen.getByLabelText('How we can improve Cortex'), 'This is broken');
    await user.click(screen.getByRole('button', { name: 'Send feedback' }));

    await waitFor(() => expect(mockSubmitFeedback).toHaveBeenCalled());

    const { category } = mockSubmitFeedback.mock.calls[0][0];
    expect(VALID_CATEGORIES).toContain(category);
  });
});
