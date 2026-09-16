import React, { useState } from 'react';
import { Sparkles, X } from 'lucide-react';

import TargetRolesInput from './OpportunityForm/TargetRolesInput';

interface RoleProfilePanelProps {
  /** The viewer's saved roles/skills profile (empty means none set). */
  profileRoles: string[];
  /**
   * Persist the profile. `null` or an empty list clears it. This is the ONLY
   * path that writes; the browse-as override below never calls it.
   */
  onSaveProfile: (roles: string[] | null) => void | Promise<void>;
  /** True while a save is in flight, to disable the controls. */
  saving?: boolean;
  /**
   * The transient "browse as..." override (client state, resets on reload).
   * null means no override, so matching falls back to the saved profile.
   */
  browseAs: string[] | null;
  /** Update the transient override. Never persisted. */
  onBrowseAsChange: (roles: string[] | null) => void;
  /** Whether the set-once prompt has been dismissed this session (per viewer). */
  promptDismissed: boolean;
  /** Dismiss the set-once prompt. */
  onDismissPrompt: () => void;
}

const PROFILE_LABEL = 'Your roles and skills';
const PROFILE_DESCRIPTION =
  'Add the roles and skills that describe you, and we will highlight studies looking for people like you. This only affects what is highlighted for you; it never changes which studies you can take part in.';
const BROWSE_AS_LABEL = 'Browse as';
const BROWSE_AS_DESCRIPTION =
  'Try a different set of roles or skills for this visit only. It changes what is highlighted now and resets when you reload; it does not change your saved profile.';

/**
 * The participant's roles/skills profile on the browse page, and the transient
 * "browse as..." override.
 *
 * Three states, never more than one at a time:
 *  - no saved profile, prompt not dismissed -> a dismissible set-once banner.
 *  - saved profile -> a summary line with Edit, plus the "browse as" affordance.
 *  - editing (either) -> the shared TargetRolesInput chip control.
 *
 * The saved profile and the override are DIFFERENT state by construction: only
 * `onSaveProfile` writes to the server, and the override drives highlighting
 * through the parent's match logic without ever touching it. That separation is
 * what guarantees the override cannot accidentally persist.
 */
const RoleProfilePanel: React.FC<RoleProfilePanelProps> = ({
  profileRoles,
  onSaveProfile,
  saving = false,
  browseAs,
  onBrowseAsChange,
  promptDismissed,
  onDismissPrompt,
}) => {
  const hasProfile = profileRoles.length > 0;

  const [editing, setEditing] = useState(false);
  const [profileDraft, setProfileDraft] = useState<string[]>(profileRoles);

  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseDraft, setBrowseDraft] = useState<string[]>(browseAs ?? []);

  const openEditor = () => {
    setProfileDraft(profileRoles);
    setEditing(true);
  };

  const saveProfile = async () => {
    await onSaveProfile(profileDraft.length > 0 ? profileDraft : null);
    setEditing(false);
  };

  const openBrowseAs = () => {
    setBrowseDraft(browseAs ?? profileRoles);
    setBrowseOpen(true);
  };

  const applyBrowseAs = () => {
    onBrowseAsChange(browseDraft.length > 0 ? browseDraft : null);
    setBrowseOpen(false);
  };

  const resetBrowseAs = () => {
    onBrowseAsChange(null);
    setBrowseDraft([]);
    setBrowseOpen(false);
  };

  // --- Editing the saved profile ---------------------------------------------
  if (editing) {
    return (
      <section className="role-profile-panel" aria-label="Your roles and skills">
        <TargetRolesInput
          value={profileDraft}
          onChange={setProfileDraft}
          label={PROFILE_LABEL}
          description={PROFILE_DESCRIPTION}
        />
        <div className="d-flex gap-2 flex-wrap">
          <button type="button" className="btn btn-primary" onClick={saveProfile} disabled={saving}>
            {saving ? 'Saving…' : 'Save profile'}
          </button>
          <button
            type="button"
            className="btn btn-outline-secondary"
            onClick={() => setEditing(false)}
            disabled={saving}
          >
            Cancel
          </button>
          {hasProfile && (
            <button
              type="button"
              className="btn btn-outline-danger ms-auto"
              onClick={async () => {
                await onSaveProfile(null);
                setEditing(false);
              }}
              disabled={saving}
            >
              Clear profile
            </button>
          )}
        </div>
      </section>
    );
  }

  // --- No profile yet: the dismissible set-once prompt ------------------------
  if (!hasProfile) {
    if (promptDismissed) {
      // Dismissing the banner must not lock a user out of the feature: with no
      // saved profile there is nowhere else on the browse page to set one, so
      // leave a quiet, persistent way back in rather than rendering nothing.
      return (
        <section className="role-profile-panel role-profile-panel--collapsed" aria-label="Set your roles and skills">
          <button type="button" className="btn btn-link role-profile-panel__set-link" onClick={openEditor}>
            <Sparkles size={15} aria-hidden="true" />
            Set your roles and skills
          </button>
        </section>
      );
    }
    return (
      <section className="role-profile-panel role-profile-panel--prompt" aria-label="Set your roles and skills">
        <div className="role-profile-panel__prompt-body">
          <Sparkles size={18} aria-hidden="true" className="role-profile-panel__prompt-icon" />
          <div>
            <p className="role-profile-panel__prompt-title">See studies for you</p>
            <p className="role-profile-panel__prompt-text">
              Add your roles and skills once and we will highlight studies looking for people like you.
            </p>
          </div>
        </div>
        <div className="role-profile-panel__prompt-actions">
          <button type="button" className="btn btn-primary" onClick={openEditor}>
            Add your roles and skills
          </button>
          <button
            type="button"
            className="btn btn-icon role-profile-panel__dismiss"
            aria-label="Dismiss"
            onClick={onDismissPrompt}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </section>
    );
  }

  // --- Saved profile: summary + edit + browse-as ------------------------------
  const browsingAs = browseAs && browseAs.length > 0;
  return (
    <section className="role-profile-panel" aria-label="Your roles and skills">
      <div className="role-profile-panel__summary">
        <span className="role-profile-panel__summary-label">Your profile:</span>{' '}
        <span className="role-profile-panel__summary-roles">{profileRoles.join(', ')}</span>
        <button type="button" className="btn btn-link role-profile-panel__edit" onClick={openEditor}>
          Edit
        </button>
      </div>

      {browsingAs && !browseOpen && (
        <p className="role-profile-panel__browsing" data-testid="browsing-as">
          Viewing as <strong>{browseAs!.join(', ')}</strong>
          <button type="button" className="btn btn-link role-profile-panel__browse-reset" onClick={resetBrowseAs}>
            Reset
          </button>
          <button type="button" className="btn btn-link" onClick={openBrowseAs}>
            Change
          </button>
        </p>
      )}

      {!browsingAs && !browseOpen && (
        <button type="button" className="btn btn-link role-profile-panel__browse-toggle" onClick={openBrowseAs}>
          Browse as someone else
        </button>
      )}

      {browseOpen && (
        <div className="role-profile-panel__browse-editor">
          <TargetRolesInput
            value={browseDraft}
            onChange={setBrowseDraft}
            label={BROWSE_AS_LABEL}
            description={BROWSE_AS_DESCRIPTION}
          />
          <div className="d-flex gap-2 flex-wrap">
            <button type="button" className="btn btn-primary" onClick={applyBrowseAs}>
              View these
            </button>
            <button type="button" className="btn btn-outline-secondary" onClick={() => setBrowseOpen(false)}>
              Cancel
            </button>
            {browsingAs && (
              <button type="button" className="btn btn-outline-secondary ms-auto" onClick={resetBrowseAs}>
                Reset to my profile
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
};

export default RoleProfilePanel;
