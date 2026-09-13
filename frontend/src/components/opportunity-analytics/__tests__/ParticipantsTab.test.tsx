import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import ParticipantsTab, { bookingStatusLabel, BOOKING_STATUS_RANK } from '../ParticipantsTab';
import { buildArtifactsController } from './artifactsControllerStub';
import { OpportunityBookingRow, ResearcherNotesResponse } from '../../../api/types';

function buildBooking(overrides: Partial<OpportunityBookingRow> = {}): OpportunityBookingRow {
  return {
    id: 'b1',
    user_id: 'user-1',
    session_id: 's1',
    status: 'booked',
    completion_status: 'pending',
    session_start_time: '2026-09-01T10:00:00.000Z',
    session_end_time: '2026-09-01T11:00:00.000Z',
    participant_name: 'Jane Doe',
    participant_email: 'jane@example.com',
    business_unit: 'Ops',
    role_title: 'Analyst',
    researcher_notes: null,
    researcher_notes_updated_at: null,
    consent_accepted_at: null,
    created_at: '2026-08-27T09:00:00.000Z',
    updated_at: '2026-08-27T09:00:00.000Z',
    ...overrides
  };
}


const noopSave = async (): Promise<ResearcherNotesResponse> => ({
  researcher_notes: null,
  researcher_notes_updated_at: null
});

/**
 * Drafts are owned by the PAGE, not by the component - the page survives its
 * own loading states and the component does not. This harness stands in for
 * that owner so the component can be exercised on its own.
 */
const Harness: React.FC<Partial<React.ComponentProps<typeof ParticipantsTab>> & {
  bookings: OpportunityBookingRow[];
}> = ({ bookings, ...overrides }) => {
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  return (
    <ParticipantsTab
      bookings={bookings}
      loading={false}
      error=""
      onRefresh={() => undefined}
      onSaveNotes={noopSave}
      drafts={drafts}
      onDraftsChange={setDrafts}
      artifacts={buildArtifactsController()}
      {...overrides}
    />
  );
};

const renderTab = (
  bookings: OpportunityBookingRow[],
  overrides: Partial<React.ComponentProps<typeof ParticipantsTab>> = {}
) => render(<Harness bookings={bookings} {...overrides} />);

describe('bookingStatusLabel', () => {
  it.each([
    [{ status: 'cancelled', completion_status: 'pending' }, 'Cancelled'],
    [{ status: 'cancelled', completion_status: 'approved' }, 'Cancelled'],
    [{ status: 'booked', completion_status: 'completed' }, 'Awaiting approval'],
    [{ status: 'booked', completion_status: 'approved' }, 'Completed'],
    [{ status: 'booked', completion_status: 'rejected' }, 'Rejected'],
    [{ status: 'booked', completion_status: 'pending' }, 'Booked'],
    [{ status: 'booked', completion_status: null }, 'Booked']
  ])('labels %j as %s', (booking, expected) => {
    expect(bookingStatusLabel(booking)).toBe(expected);
  });
});

describe('the artefacts column (#79 step 3)', () => {
  it('renders collapsed by default and expands to the artefact section on click', async () => {
    const user = userEvent.setup();
    renderTab([buildBooking()]);

    expect(screen.queryByText('Session artefacts')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Artefacts' }));
    expect(screen.getByText('Session artefacts')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Hide/ }));
    expect(screen.queryByText('Session artefacts')).not.toBeInTheDocument();
  });

  it('points aria-controls at the panel it actually expands', async () => {
    const user = userEvent.setup();
    renderTab([buildBooking()]);

    const toggle = screen.getByRole('button', { name: 'Artefacts' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const controlled = toggle.getAttribute('aria-controls')!;

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(controlled);
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain('Session artefacts');
  });

  it('shows the loaded artefact count on the toggle', () => {
    renderTab([buildBooking()], {
      artifacts: buildArtifactsController({
        artifactsByBooking: {
          b1: [
            {
              id: 'a1',
              booking_id: 'b1',
              kind: 'recording',
              file_name: 'call.webm',
              mime_type: 'video/webm',
              file_size_bytes: 1024,
              uploaded_by: null,
              uploaded_by_name: null,
              uploaded_at: null,
              consent_attested_by: null,
              consent_attested_at: null,
              consent_attestation_reason: null
            }
          ]
        }
      })
    });

    expect(screen.getByRole('button', { name: 'Artefacts (1)' })).toBeInTheDocument();
  });
});

describe('ParticipantsTab', () => {
  it('renders the empty state when nobody has booked', () => {
    renderTab([]);

    expect(screen.getByText('Nobody has booked a session yet.')).toBeInTheDocument();
  });

  it('renders the error INSTEAD of the empty state - a 403 is not "no bookings"', () => {
    renderTab([], { error: 'Only the opportunity owner can view its participants' });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Only the opportunity owner can view its participants'
    );
    expect(screen.queryByText('Nobody has booked a session yet.')).not.toBeInTheDocument();
  });

  it('renders each booking with participant identity, slot and status', () => {
    renderTab([
      buildBooking(),
      buildBooking({
        id: 'b2',
        participant_name: 'Sam Smith',
        participant_email: 'sam@example.com',
        status: 'cancelled'
      })
    ]);

    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();
    expect(screen.getAllByText('Analyst, Ops')).toHaveLength(2);
    expect(screen.getByText('Booked')).toBeInTheDocument();
    expect(screen.getByText('Sam Smith')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });

  it('shows the stored note and its updated time', () => {
    renderTab([
      buildBooking({
        researcher_notes: 'struggled with the export step',
        researcher_notes_updated_at: '2026-08-27T10:00:00.000Z'
      })
    ]);

    expect(screen.getByLabelText('Researcher notes for Jane Doe')).toHaveValue(
      'struggled with the export step'
    );
    expect(screen.getByText(/^Updated /)).toBeInTheDocument();
  });

  it('disables Save until the note is edited, then saves the draft and shows the server timestamp', async () => {
    const user = userEvent.setup();
    const onSaveNotes = vi.fn(async (_bookingId: string, notes: string) => ({
      researcher_notes: notes,
      researcher_notes_updated_at: '2026-08-27T12:34:00.000Z'
    }));
    renderTab([buildBooking()], { onSaveNotes });

    const saveButton = screen.getByRole('button', { name: 'Save note' });
    expect(saveButton).toBeDisabled();

    await user.type(screen.getByLabelText('Researcher notes for Jane Doe'), 'good session');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(saveButton).toBeEnabled();

    await user.click(saveButton);

    expect(onSaveNotes).toHaveBeenCalledWith('b1', 'good session');
    expect(await screen.findByText(/^Updated /)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save note' })).toBeDisabled();
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('keeps the draft and says so when the save fails', async () => {
    const user = userEvent.setup();
    const onSaveNotes = vi.fn(async () => {
      throw new Error('network down');
    });
    renderTab([buildBooking()], { onSaveNotes });

    await user.type(screen.getByLabelText('Researcher notes for Jane Doe'), 'do not lose me');
    await user.click(screen.getByRole('button', { name: 'Save note' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save this note');
    expect(screen.getByLabelText('Researcher notes for Jane Doe')).toHaveValue('do not lose me');
    expect(screen.getByRole('button', { name: 'Save note' })).toBeEnabled();
  });

  it('keeps text typed WHILE a save is in flight, and does not report it saved', async () => {
    // The defect a refute gate demonstrated: `handleSave` captured the draft
    // at click time and cleared it unconditionally on success, so anything
    // typed between the click and the response was discarded - and the UI
    // then showed "Updated ..." with the Save button disabled, a positive
    // confirmation over lost text. Same family as the D2 autosave loss, on
    // the one field this whole feature exists to store.
    const user = userEvent.setup();
    let resolveSave: (value: ResearcherNotesResponse) => void = () => undefined;
    const onSaveNotes = vi.fn(
      () =>
        new Promise<ResearcherNotesResponse>((resolve) => {
          resolveSave = resolve;
        })
    );
    renderTab([buildBooking()], { onSaveNotes });

    const textarea = screen.getByLabelText('Researcher notes for Jane Doe');
    await user.type(textarea, 'first half');
    await user.click(screen.getByRole('button', { name: 'Save note' }));

    // Still typing while the request is in flight.
    await user.type(textarea, ' and the rest');

    resolveSave({
      researcher_notes: 'first half',
      researcher_notes_updated_at: '2026-08-27T12:00:00.000Z'
    });

    // The newer text survives, and the row still reads as unsaved, because
    // what is on screen is NOT what the server stored.
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument();
    expect(textarea).toHaveValue('first half and the rest');
    expect(screen.getByRole('button', { name: 'Save note' })).toBeEnabled();
  });

  it('shows a co-owner\'s note when the roster is refreshed after a local save', async () => {
    // Reachable only because #79 made the roster owner-OR-superadmin, so two
    // people can write the same booking's note. Local state that shadows the
    // prop forever would show this researcher their own stale text.
    const user = userEvent.setup();
    const onSaveNotes = vi.fn(async (_id: string, notes: string) => ({
      researcher_notes: notes,
      researcher_notes_updated_at: '2026-08-27T12:00:00.000Z'
    }));
    const { rerender } = renderTab([buildBooking()], { onSaveNotes });

    await user.type(screen.getByLabelText('Researcher notes for Jane Doe'), 'my note');
    await user.click(screen.getByRole('button', { name: 'Save note' }));
    expect(await screen.findByText(/^Updated /)).toBeInTheDocument();

    // A Refresh brings back a newer row written by the co-owner.
    rerender(
      <Harness
        bookings={[
          buildBooking({
            researcher_notes: 'CO-OWNER EDIT',
            researcher_notes_updated_at: '2026-08-27T13:00:00.000Z'
          })
        ]}
        onSaveNotes={onSaveNotes}
      />
    );

    expect(screen.getByLabelText('Researcher notes for Jane Doe')).toHaveValue('CO-OWNER EDIT');
  });

  it('refuses an over-length note rather than silently truncating the paste', async () => {
    // The backend's stated policy is refuse-never-truncate, on the grounds
    // that a truncated note is a note the researcher believes they kept and
    // did not. A browser `maxLength` does exactly that on paste, with no
    // message - so the cap is enforced by refusing to save, and said out loud.
    const user = userEvent.setup();
    const onSaveNotes = vi.fn(noopSave);
    renderTab([buildBooking({ researcher_notes: 'x'.repeat(20000) })], { onSaveNotes });

    const textarea = screen.getByLabelText('Researcher notes for Jane Doe');
    expect(textarea).not.toHaveAttribute('maxlength');

    await user.type(textarea, 'yy');

    expect(screen.getByText('2 characters over the 20000 limit')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save note' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Save note' }));
    expect(onSaveNotes).not.toHaveBeenCalled();
  });

  it('clears a failed save message as soon as the researcher retypes', async () => {
    const user = userEvent.setup();
    const onSaveNotes = vi.fn(async () => {
      throw new Error('network down');
    });
    renderTab([buildBooking()], { onSaveNotes });

    await user.type(screen.getByLabelText('Researcher notes for Jane Doe'), 'attempt');
    await user.click(screen.getByRole('button', { name: 'Save note' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Researcher notes for Jane Doe'), '!');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not re-enable one row\'s in-flight save when another row finishes', async () => {
    const user = userEvent.setup();
    const resolvers: Array<(value: ResearcherNotesResponse) => void> = [];
    const onSaveNotes = vi.fn(
      () =>
        new Promise<ResearcherNotesResponse>((resolve) => {
          resolvers.push(resolve);
        })
    );
    renderTab([buildBooking(), buildBooking({ id: 'b2', participant_name: 'Sam Smith' })], {
      onSaveNotes
    });

    await user.type(screen.getByLabelText('Researcher notes for Jane Doe'), 'jane note');
    await user.click(screen.getAllByRole('button', { name: 'Save note' })[0]);
    await user.type(screen.getByLabelText('Researcher notes for Sam Smith'), 'sam note');
    await user.click(screen.getAllByRole('button', { name: /Save note|Saving/ })[1]);

    // Sam's save lands first; Jane's is still in flight and must stay locked.
    resolvers[1]({ researcher_notes: 'sam note', researcher_notes_updated_at: null });

    await screen.findByText('Unsaved changes');
    expect(screen.getAllByRole('button', { name: /Save note|Saving/ })[0]).toBeDisabled();
  });

  it('pins the ceiling at 20000 characters, as a literal', () => {
    // 20000 the NUMBER, not the constant: a cap asserted via the constant
    // cannot see the constant change (rules/common/testing.md). The backend
    // pins the same literal in bookings.researcher-notes.test.ts, so the two
    // sides cannot drift apart without one of them failing by name.
    renderTab([buildBooking({ researcher_notes: 'x'.repeat(20001) })]);

    expect(screen.getByText('1 characters over the 20000 limit')).toBeInTheDocument();
  });
});

describe('ParticipantsTab column sorting (DA-23)', () => {
  // Deliberately picked so the prop order, name order and status-rank order
  // all disagree - a test that reuses one ordering for two sort modes
  // cannot tell them apart.
  const threeBookings = (): OpportunityBookingRow[] => [
    buildBooking({ id: 'b-zoe', participant_name: 'Zoe', status: 'booked', completion_status: 'pending' }),
    buildBooking({ id: 'b-amy', participant_name: 'Amy', status: 'cancelled', completion_status: 'pending' }),
    buildBooking({ id: 'b-mike', participant_name: 'Mike', status: 'booked', completion_status: 'completed' })
  ];

  const rowOrder = (): string[] =>
    screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent ?? '');

  const namesIn = (rows: string[], names: string[]): string[] =>
    rows.map((rowText) => names.find((name) => rowText.includes(name)) ?? '');

  it('CONTROL: defaults to the roster order handed down by the page, unclicked', () => {
    renderTab(threeBookings());

    expect(namesIn(rowOrder(), ['Zoe', 'Amy', 'Mike'])).toEqual(['Zoe', 'Amy', 'Mike']);
    expect(screen.getByRole('columnheader', { name: 'Status' })).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByRole('columnheader', { name: 'Participant' })).toHaveAttribute(
      'aria-sort',
      'none'
    );
  });

  it('sorts by Status rank ascending on first click, descending on second', async () => {
    const user = userEvent.setup();
    renderTab(threeBookings());

    const statusHeader = screen.getByRole('button', { name: 'Status' });
    await user.click(statusHeader);

    // Booked(0) < Awaiting approval(1) < Cancelled(4)
    expect(namesIn(rowOrder(), ['Zoe', 'Amy', 'Mike'])).toEqual(['Zoe', 'Mike', 'Amy']);
    expect(screen.getByRole('columnheader', { name: 'Status' })).toHaveAttribute(
      'aria-sort',
      'ascending'
    );

    await user.click(statusHeader);

    expect(namesIn(rowOrder(), ['Zoe', 'Amy', 'Mike'])).toEqual(['Amy', 'Mike', 'Zoe']);
    expect(screen.getByRole('columnheader', { name: 'Status' })).toHaveAttribute(
      'aria-sort',
      'descending'
    );
  });

  it('sorts by Participant name ascending on first click, descending on second', async () => {
    const user = userEvent.setup();
    renderTab(threeBookings());

    const participantHeader = screen.getByRole('button', { name: 'Participant' });
    await user.click(participantHeader);

    expect(namesIn(rowOrder(), ['Zoe', 'Amy', 'Mike'])).toEqual(['Amy', 'Mike', 'Zoe']);
    expect(screen.getByRole('columnheader', { name: 'Participant' })).toHaveAttribute(
      'aria-sort',
      'ascending'
    );

    await user.click(participantHeader);

    expect(namesIn(rowOrder(), ['Zoe', 'Amy', 'Mike'])).toEqual(['Zoe', 'Mike', 'Amy']);
    expect(screen.getByRole('columnheader', { name: 'Participant' })).toHaveAttribute(
      'aria-sort',
      'descending'
    );
  });
});

describe('BOOKING_STATUS_RANK drift guard (DA-23)', () => {
  // Every label bookingStatusLabel can actually produce, driven THROUGH the
  // function itself rather than a second hardcoded string list - a rename in
  // bookingStatusLabel fails this test by name too, not just an added label.
  // There is no shared union type to pin this against the way SessionsTab
  // pins STATUS_RANK on SessionEvent['event_type']; this test is the
  // equivalent guard for a derived string with no declared type.
  it.each([
    [{ status: 'cancelled', completion_status: 'pending' }, 'Cancelled'],
    [{ status: 'booked', completion_status: 'completed' }, 'Awaiting approval'],
    [{ status: 'booked', completion_status: 'approved' }, 'Completed'],
    [{ status: 'booked', completion_status: 'rejected' }, 'Rejected'],
    [{ status: 'booked', completion_status: 'pending' }, 'Booked']
  ])('has a numeric BOOKING_STATUS_RANK entry for the %j label', (booking, expectedLabel) => {
    const label = bookingStatusLabel(booking);
    expect(label).toBe(expectedLabel);
    expect(typeof BOOKING_STATUS_RANK[label]).toBe('number');
  });

  it('has exactly the five ranks bookingStatusLabel can produce - no fewer, no stale extras', () => {
    expect(Object.keys(BOOKING_STATUS_RANK).sort()).toEqual(
      ['Awaiting approval', 'Booked', 'Cancelled', 'Completed', 'Rejected']
    );
  });

  it('gives every table header scope="col" (row 12; a role query cannot see this)', () => {
    const { container } = renderTab([buildBooking()]);
    const headers = [...container.querySelectorAll('th')];
    expect(headers.length).toBeGreaterThan(0);
    for (const th of headers) {
      expect(th.getAttribute('scope')).toBe('col');
    }
  });
});
