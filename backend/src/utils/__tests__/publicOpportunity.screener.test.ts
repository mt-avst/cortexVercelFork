import { toPublicOpportunity } from '../publicOpportunity';

// A screener as it sits on the raw opportunity row, with the owner-only
// disqualifies flags a participant must never receive.
const ownerScreener = {
  questions: [
    {
      id: 'role',
      prompt: 'Which best describes your role?',
      options: [
        { id: 'eng', label: 'Engineer', disqualifies: false },
        { id: 'sales', label: 'Sales', disqualifies: true },
      ],
    },
  ],
  screenedOutMessage: 'Not a match this time',
};

const baseOpportunity = () => ({
  id: 'opp-1',
  title: 'Checkout redesign',
  status: 'published',
  owner_user_id: 'owner-1',
  owner_name: 'Owner',
  owner_email: 'owner@example.com',
  screener: JSON.parse(JSON.stringify(ownerScreener)),
});

describe('toPublicOpportunity - screener redaction', () => {
  it('strips the owner-only disqualifies flag from every option', () => {
    const publicView = toPublicOpportunity(baseOpportunity()) as {
      screener: { questions: { options: unknown[] }[] };
    };

    // The whole serialised payload must not carry the flag anywhere.
    expect(JSON.stringify(publicView)).not.toContain('disqualifies');
    expect(publicView.screener.questions[0].options[0]).toEqual({
      id: 'eng',
      label: 'Engineer',
    });
    expect(publicView.screener.questions[0].options[1]).toEqual({
      id: 'sales',
      label: 'Sales',
    });
  });

  it('keeps the existing owner-field redaction intact', () => {
    const publicView = toPublicOpportunity(baseOpportunity()) as Record<string, unknown>;
    expect(publicView.owner_user_id).toBeUndefined();
    expect(publicView.owner_name).toBeUndefined();
    expect(publicView.owner_email).toBeUndefined();
  });

  it('leaves a null screener as null and an absent one absent', () => {
    const withNull = toPublicOpportunity({ ...baseOpportunity(), screener: null }) as {
      screener: unknown;
    };
    expect(withNull.screener).toBeNull();

    const opp = baseOpportunity() as Record<string, unknown>;
    delete opp.screener;
    const withAbsent = toPublicOpportunity(opp) as Record<string, unknown>;
    expect('screener' in withAbsent).toBe(false);
  });

  it('FAILS CLOSED: withholds a screener whose shape is unexpected', () => {
    const malformed = toPublicOpportunity({
      ...baseOpportunity(),
      screener: { questions: 'not-an-array' } as unknown,
    }) as { screener: unknown };
    expect(malformed.screener).toBeUndefined();
  });
});
