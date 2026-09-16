import React, { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { VALIDATION } from '@shared/constants';

import TargetRolesInput from '../TargetRolesInput';

/**
 * A small stateful harness so the chip list behaves as it does in the form:
 * the component is controlled, so the test owns the value and applies onChange.
 */
const Harness: React.FC<{ initial?: string[] }> = ({ initial = [] }) => {
  const [roles, setRoles] = useState<string[]>(initial);
  return <TargetRolesInput value={roles} onChange={setRoles} />;
};

const input = () => screen.getByLabelText('Roles or skills wanted');

describe('TargetRolesInput', () => {
  it('adds a typed role as a chip on Enter', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(input(), 'Product Manager{Enter}');

    const chips = screen.getByRole('list', { name: 'Selected roles or skills' });
    expect(within(chips).getByText('Product Manager')).toBeVisible();
  });

  it('adds via the Add button too', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(input(), 'Designer');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByText('Designer')).toBeVisible();
  });

  it('adds a role on a comma too', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(input(), 'Jira admin,');

    expect(screen.getByText('Jira admin')).toBeVisible();
    // The comma is consumed as the delimiter, not left in the input.
    expect(input()).toHaveValue('');
  });

  it('removes a chip', async () => {
    const user = userEvent.setup();
    render(<Harness initial={['Product Manager']} />);

    await user.click(screen.getByRole('button', { name: 'Remove Product Manager' }));

    expect(screen.queryByText('Product Manager')).toBeNull();
  });

  it('does not add an exact case-insensitive duplicate', async () => {
    const user = userEvent.setup();
    render(<Harness initial={['Jira admin']} />);

    await user.type(input(), 'jira admin{Enter}');

    expect(screen.getAllByText(/jira admin/i)).toHaveLength(1);
  });

  it('trims whitespace before adding', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(input(), '   Team Lead   {Enter}');

    expect(screen.getByText('Team Lead')).toBeVisible();
  });

  it('stops adding once the count cap is reached', async () => {
    const user = userEvent.setup();
    const full = Array.from({ length: VALIDATION.TARGET_ROLES_MAX_COUNT }, (_, i) => `Role ${i}`);
    render(<Harness initial={full} />);

    // The input and Add button are disabled at capacity.
    expect(input()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    // Removing one frees a slot again.
    await user.click(screen.getByRole('button', { name: 'Remove Role 0' }));
    expect(input()).toBeEnabled();
  });
});
