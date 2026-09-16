import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

import RoleProfilePanel from '../RoleProfilePanel';

type Overrides = Partial<React.ComponentProps<typeof RoleProfilePanel>>;

const setup = (over: Overrides = {}) => {
  const onSaveProfile = vi.fn();
  const onBrowseAsChange = vi.fn();
  const onDismissPrompt = vi.fn();
  render(
    <RoleProfilePanel
      profileRoles={[]}
      onSaveProfile={onSaveProfile}
      browseAs={null}
      onBrowseAsChange={onBrowseAsChange}
      promptDismissed={false}
      onDismissPrompt={onDismissPrompt}
      {...over}
    />
  );
  return { onSaveProfile, onBrowseAsChange, onDismissPrompt };
};

describe('RoleProfilePanel', () => {
  describe('the set-once prompt', () => {
    it('appears only when the profile is empty and not dismissed', () => {
      setup({ profileRoles: [] });
      expect(screen.getByText('See studies for you')).toBeVisible();
    });

    it('does not appear once a profile is set', () => {
      setup({ profileRoles: ['Product Manager'] });
      expect(screen.queryByText('See studies for you')).toBeNull();
      // The saved-profile summary shows instead.
      expect(screen.getByText('Product Manager')).toBeVisible();
    });

    it('does not appear when dismissed', () => {
      setup({ profileRoles: [], promptDismissed: true });
      expect(screen.queryByText('See studies for you')).toBeNull();
    });

    it('leaves a persistent "Set your roles and skills" link when dismissed, so the user is not locked out', async () => {
      const user = userEvent.setup();
      const { onSaveProfile } = setup({ profileRoles: [], promptDismissed: true });
      // The banner is gone but a quiet re-entry remains.
      expect(screen.queryByText('See studies for you')).toBeNull();
      const link = screen.getByRole('button', { name: 'Set your roles and skills' });
      expect(link).toBeVisible();

      // Clicking it opens the editor - the only way back to set a profile.
      await user.click(link);
      await user.type(screen.getByRole('combobox'), 'Designer');
      await user.click(screen.getByRole('button', { name: 'Add' }));
      await user.click(screen.getByRole('button', { name: 'Save profile' }));
      expect(onSaveProfile).toHaveBeenCalledWith(['Designer']);
    });

    it('calls onDismissPrompt when dismissed', async () => {
      const user = userEvent.setup();
      const { onDismissPrompt } = setup({ profileRoles: [] });
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(onDismissPrompt).toHaveBeenCalledTimes(1);
    });
  });

  describe('editing the saved profile', () => {
    it('persists via onSaveProfile', async () => {
      const user = userEvent.setup();
      const { onSaveProfile } = setup({ profileRoles: ['Product Manager'] });
      await user.click(screen.getByRole('button', { name: 'Edit' }));
      // Add a role through the shared chip control, then save.
      await user.type(screen.getByRole('combobox'), 'Designer');
      await user.click(screen.getByRole('button', { name: 'Add' }));
      await user.click(screen.getByRole('button', { name: 'Save profile' }));
      expect(onSaveProfile).toHaveBeenCalledWith(['Product Manager', 'Designer']);
    });
  });

  describe('the "browse as" override is transient', () => {
    it('drives onBrowseAsChange and NEVER onSaveProfile', async () => {
      const user = userEvent.setup();
      const { onSaveProfile, onBrowseAsChange } = setup({ profileRoles: ['Product Manager'] });

      await user.click(screen.getByRole('button', { name: 'Browse as someone else' }));
      // Seeded from the profile; swap it for a different role.
      await user.click(screen.getByRole('button', { name: 'Remove Product Manager' }));
      await user.type(screen.getByRole('combobox'), 'QA Engineer');
      await user.click(screen.getByRole('button', { name: 'Add' }));
      await user.click(screen.getByRole('button', { name: 'View these' }));

      expect(onBrowseAsChange).toHaveBeenCalledWith(['QA Engineer']);
      // The whole point: the override cannot write to the saved profile.
      expect(onSaveProfile).not.toHaveBeenCalled();
    });

    it('resets the override via onBrowseAsChange(null), still never saving', async () => {
      const user = userEvent.setup();
      const { onSaveProfile, onBrowseAsChange } = setup({
        profileRoles: ['Product Manager'],
        browseAs: ['Designer'],
      });

      expect(screen.getByTestId('browsing-as')).toHaveTextContent('Viewing as Designer');
      await user.click(screen.getByRole('button', { name: 'Reset' }));

      expect(onBrowseAsChange).toHaveBeenCalledWith(null);
      expect(onSaveProfile).not.toHaveBeenCalled();
    });
  });
});
