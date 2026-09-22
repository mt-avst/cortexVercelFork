import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { getOpportunity, updateOpportunity } from '../../api/client';
import { MODERATED_CONSENT_TEMPLATE } from '@shared/firsthand/consent-templates';

/**
 * The hydration rule the code states about itself: a moderated row WITHOUT
 * consent wording hydrates EMPTY - the default is never seeded over an
 * existing row, because a non-empty consent field is exactly what
 * buildSavePayload sends, so seeding here would make any unrelated save
 * silently add consent nobody wrote.
 *
 * This file exists because a review gate PROVED the rule was enforced by
 * nothing: mutating both hydration sites to seed the default left the whole
 * frontend suite green. The save-payload tests receive form state directly,
 * so only a test that hydrates the real form from a fetched row can see it.
 */

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false
  })
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/AdminSessionManager', () => ({
  default: () => <div>stub: session management</div>
}));

vi.mock('../../api/client', () => ({
  createOpportunity: vi.fn().mockResolvedValue({ id: 'opp-new' }),
  updateOpportunity: vi.fn().mockResolvedValue({ id: 'opp-1' }),
  getOpportunity: vi.fn(),
  getSessions: vi.fn().mockResolvedValue([]),
  getFirstHandStudies: vi.fn().mockResolvedValue([]),
  createSessions: vi.fn().mockResolvedValue([])
}));

vi.mock('../../api/firsthand-studies', () => ({
  getFirstHandStudy: vi.fn()
}));

const MODERATED_ROW = (over: Record<string, unknown> = {}) => ({
  id: 'opp-1',
  type: 'test',
  title: 'A live session already saved',
  purpose_one_liner: 'A purpose long enough to pass validation',
  description_optional: '',
  product_optional: '',
  meeting_location_optional: 'Zoom',
  status: 'draft',
  default_duration_minutes: 30,
  external_link_optional: '',
  participant_type_required: 'any',
  firsthand_study_id: null,
  can_edit: true,
  consent_text: null,
  consent_template_id: null,
  consent_template_version: null,
  ...over
});

const renderEdit = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
      <Routes>
        <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
      </Routes>
    </MemoryRouter>
  );

// D5: edit mode now opens on Study type (step 1) for every shape, including
// moderated ones - it used to open on Session Management for exactly this
// type, so the loaded signal was the sessions stub. Study type carries no
// Title field any more (that split onto Basic Info, step 2), so this walks
// there and lands on the Title field, which is the step-2-agnostic landmark:
// every other step this file visits (Consent, Session Management) is reached
// through the step nav from here.
const awaitLoaded = async () => {
  fireEvent.click(
    within(await screen.findByRole('navigation', { name: 'Form steps' })).getAllByRole(
      'button'
    )[1]
  );
  return screen.findByLabelText(/^Title/i);
};

const goToStep = (name: RegExp) => {
  const steps = screen
    .getAllByRole('button')
    .filter((button) => name.test(button.textContent ?? ''));
  expect(steps.length).toBeGreaterThan(0);
  fireEvent.click(steps[0]);
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('hydrating a moderated row never seeds consent it does not hold', () => {
  it('a row without wording hydrates an EMPTY consent field', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(MODERATED_ROW() as never);
    renderEdit();
    await awaitLoaded();

    goToStep(/Consent/);

    const textarea = await screen.findByLabelText('Consent text');
    expect((textarea as HTMLTextAreaElement).value).toBe('');
  });

  it('an unrelated save on that row sends NO consent_text, ever', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(MODERATED_ROW() as never);
    renderEdit();
    await awaitLoaded();

    // Already on Basic Info, where Title lives now, and its hydrated value is
    // the same landmark `awaitLoaded` just found - so this is only re-stated
    // for a reader, not re-navigated.
    await screen.findByDisplayValue('A live session already saved');
    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'A live session with a new title' }
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(vi.mocked(updateOpportunity)).toHaveBeenCalled();
    });

    // EVERY call, not the first: autosave may write too, and an autosave that
    // seeded consent would be the same defect on a quieter path.
    for (const call of vi.mocked(updateOpportunity).mock.calls) {
      const payload = call[1] as Record<string, unknown>;
      expect(Object.keys(payload)).not.toContain('consent_text');
      expect(payload.title).toBe('A live session with a new title');
    }
  });

  it('the control: a row WITH stored wording hydrates exactly that wording', async () => {
    // Proves the harness can see consent text at all - without this, the empty
    // assertion above would pass just as well against a consent field that
    // never renders anything.
    vi.mocked(getOpportunity).mockResolvedValue(
      MODERATED_ROW({
        consent_text: 'Wording this researcher wrote themselves.',
        consent_template_id: 'custom',
        consent_template_version: null
      }) as never
    );
    renderEdit();
    await awaitLoaded();

    goToStep(/Consent/);

    const textarea = await screen.findByLabelText('Consent text');
    expect((textarea as HTMLTextAreaElement).value).toBe(
      'Wording this researcher wrote themselves.'
    );
  });
});

/**
 * cto/AdaptaLabs#144: `hasChanges()` enumerated every other saved field and
 * omitted all three moderated-consent ones - wording, template id and
 * template version - so an author who rewrote their consent wording, or only
 * reclassified it, got no Save Changes button on the steps that render one,
 * while `dirtySignature` (which spreads the form rather than enumerating it)
 * still fired the exit warning. The survey and recorded twins of this pair
 * are covered elsewhere; this is the moderated one.
 */
describe('hasChanges sees the moderated consent fields (cto/AdaptaLabs#144)', () => {
  it('offers no Save Changes on open, and one once the wording actually changes', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      MODERATED_ROW({
        consent_text: 'Wording this researcher wrote themselves.',
        consent_template_id: 'custom',
        consent_template_version: null
      }) as never
    );
    renderEdit();
    await awaitLoaded();
    goToStep(/Consent/);

    const textarea = await screen.findByLabelText('Consent text');
    // Nothing has changed yet - opening the row must not pin the button on.
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();

    fireEvent.change(textarea, {
      target: { value: 'Wording this researcher rewrote today.' }
    });

    expect(
      await screen.findByRole('button', { name: 'Save Changes' })
    ).toBeInTheDocument();
  });

  it('offers Save Changes for a reclassify-only edit, wording unchanged', async () => {
    // Stored as `custom` despite the wording being verbatim the approved
    // template - the same starting shape the survey/recorded twins of this
    // test use.
    vi.mocked(getOpportunity).mockResolvedValue(
      MODERATED_ROW({
        consent_text: MODERATED_CONSENT_TEMPLATE.text,
        consent_template_id: 'custom',
        consent_template_version: null
      }) as never
    );
    renderEdit();
    await awaitLoaded();
    goToStep(/Consent/);

    const textarea = await screen.findByLabelText('Consent text');
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();

    // Away and back: setting a field to the value it already holds fires no
    // change event, so the round trip is what moves the classification while
    // leaving the wording exactly as it was found.
    fireEvent.change(textarea, { target: { value: 'something else' } });
    fireEvent.change(textarea, {
      target: { value: MODERATED_CONSENT_TEMPLATE.text }
    });

    expect((textarea as HTMLTextAreaElement).value).toBe(
      MODERATED_CONSENT_TEMPLATE.text
    );
    expect(
      await screen.findByRole('button', { name: 'Save Changes' })
    ).toBeInTheDocument();
  });

  /**
   * Isolates the `moderated_consent_template_id` clause from its neighbours:
   * the stored version already matches the template the wording resolves to,
   * so only the id can move. A drifted id rather than `custom`, because
   * `custom` is what the reclassify-only test above already exercises, and
   * that shape moves id and version together - it cannot tell this clause
   * apart from the version one under mutation.
   */
  it('offers Save Changes for a template-id-only reclassification', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      MODERATED_ROW({
        consent_text: MODERATED_CONSENT_TEMPLATE.text,
        consent_template_id: 'a-retired-template-id',
        consent_template_version: MODERATED_CONSENT_TEMPLATE.version
      }) as never
    );
    renderEdit();
    await awaitLoaded();
    goToStep(/Consent/);

    // Starts LOCKED: the stored id is not `custom`, so the wording renders as
    // approved text rather than as an editable field.
    fireEvent.click(screen.getByRole('button', { name: 'Customise consent wording' }));
    const textarea = await screen.findByLabelText('Consent text');
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();

    // Away and back: the field already holds this text, so setting it to the
    // same value fires no change event on its own.
    fireEvent.change(textarea, { target: { value: 'something else' } });
    fireEvent.change(textarea, {
      target: { value: MODERATED_CONSENT_TEMPLATE.text }
    });

    expect((textarea as HTMLTextAreaElement).value).toBe(
      MODERATED_CONSENT_TEMPLATE.text
    );
    expect(
      await screen.findByRole('button', { name: 'Save Changes' })
    ).toBeInTheDocument();
  });

  /**
   * Isolates the `moderated_consent_template_version` clause the same way:
   * the stored id already names the template the wording resolves to, so only
   * the version can move.
   */
  it('offers Save Changes for a template-version-only reclassification', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      MODERATED_ROW({
        consent_text: MODERATED_CONSENT_TEMPLATE.text,
        consent_template_id: MODERATED_CONSENT_TEMPLATE.id,
        consent_template_version: MODERATED_CONSENT_TEMPLATE.version + 1
      }) as never
    );
    renderEdit();
    await awaitLoaded();
    goToStep(/Consent/);

    fireEvent.click(screen.getByRole('button', { name: 'Customise consent wording' }));
    const textarea = await screen.findByLabelText('Consent text');
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();

    fireEvent.change(textarea, { target: { value: 'something else' } });
    fireEvent.change(textarea, {
      target: { value: MODERATED_CONSENT_TEMPLATE.text }
    });

    expect((textarea as HTMLTextAreaElement).value).toBe(
      MODERATED_CONSENT_TEMPLATE.text
    );
    expect(
      await screen.findByRole('button', { name: 'Save Changes' })
    ).toBeInTheDocument();
  });
});
