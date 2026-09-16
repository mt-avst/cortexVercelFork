import React, { useId, useState } from 'react';
import { VALIDATION } from '@shared/constants';
import { TARGET_ROLE_SUGGESTIONS } from '@shared/target-roles';

interface TargetRolesInputProps {
  /** The current chip list. */
  value: string[];
  /** Called with the next chip list on every add or remove. */
  onChange: (roles: string[]) => void;
}

/**
 * "Roles/skills wanted" - a chip input for the structured, display-only audience
 * an author advertises on an opportunity. Curated suggestions (a datalist) plus
 * free-add, with removable chips.
 *
 * Deduping and the hard caps are the server's job (targetRolesSchema); this
 * input only prevents an exact case-insensitive duplicate and stops adding past
 * the count cap, as UX rather than as the authority.
 */
const TargetRolesInput: React.FC<TargetRolesInputProps> = ({ value, onChange }) => {
  const [draft, setDraft] = useState('');
  const inputId = useId();
  const listId = useId();

  const atCapacity = value.length >= VALIDATION.TARGET_ROLES_MAX_COUNT;

  const addRole = () => {
    const trimmed = draft.trim();
    if (!trimmed || atCapacity) {
      return;
    }
    const isDuplicate = value.some(
      (role) => role.toLowerCase() === trimmed.toLowerCase()
    );
    if (!isDuplicate) {
      onChange([...value, trimmed]);
    }
    setDraft('');
  };

  const removeRole = (role: string) => {
    onChange(value.filter((existing) => existing !== role));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter adds the drafted role without submitting the surrounding form, and
    // comma is a natural chip delimiter authors reach for.
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addRole();
    }
  };

  return (
    <div className="form-group mb-3">
      <label
        htmlFor={inputId}
        className="form-label mb-2"
        style={{ fontSize: '1rem', fontWeight: '600' }}
      >
        Roles or skills wanted
      </label>
      <p className="mb-2 section-description" style={{ fontSize: '0.9rem' }}>
        Add the roles or skills you are looking for so the right people can self-select.
        This describes your audience; it does not restrict who can take part.
      </p>

      {value.length > 0 && (
        <ul
          className="list-unstyled d-flex flex-wrap gap-2 mb-2"
          aria-label="Selected roles or skills"
        >
          {value.map((role) => (
            <li key={role}>
              <span className="badge bg-light text-dark border d-inline-flex align-items-center gap-1 py-2 px-2">
                <span>{role}</span>
                <button
                  type="button"
                  className="btn-close btn-close-sm"
                  aria-label={`Remove ${role}`}
                  style={{ fontSize: '0.6rem' }}
                  onClick={() => removeRole(role)}
                />
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="d-flex gap-2">
        <input
          id={inputId}
          type="text"
          className="form-control"
          list={listId}
          value={draft}
          maxLength={VALIDATION.TARGET_ROLE_MAX_CHARS}
          disabled={atCapacity}
          placeholder={atCapacity ? 'Maximum reached' : 'e.g. Product Manager'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className="btn btn-outline-secondary"
          disabled={atCapacity || draft.trim().length === 0}
          onClick={addRole}
        >
          Add
        </button>
      </div>
      <datalist id={listId}>
        {TARGET_ROLE_SUGGESTIONS.map((suggestion) => (
          <option key={suggestion} value={suggestion} />
        ))}
      </datalist>
      <small className="text-muted">
        {atCapacity
          ? `You can add up to ${VALIDATION.TARGET_ROLES_MAX_COUNT}.`
          : 'Press Enter to add. Choose a suggestion or type your own.'}
      </small>
    </div>
  );
};

export default TargetRolesInput;
