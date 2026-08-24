import { describe, it, expect, jest } from '@jest/globals';
import nodemailer, { type Transporter } from 'nodemailer';
import { EmailService } from '../email';

/**
 * A DISPLAY NAME CANNOT ADD A RECIPIENT TO THE SMTP ENVELOPE.
 *
 * `sendEmail` built the `to:` header by interpolating a user-controlled
 * `recipient.name` straight into a string:
 *
 *   to: `${recipient.name} <${recipient.email}>`
 *
 * A name of `Ada <attacker@evil.example>, Bob` turns one recipient into two:
 * nodemailer parses the comma and the angle-brackets and delivers the booking
 * details - carrying the platform's own From address - to an attacker-chosen
 * address as well as the intended one. That is worse than the HTML-body class
 * !229 fixed, because it changes WHO receives the mail, not just what it says.
 *
 * The fix is nodemailer's own address-object form `{ name, address }`, where the
 * name is a display phrase that is encoded, never parsed for addresses.
 *
 * WHY THE ENVELOPE, NOT THE HEADER STRING. Asserting on the `to` header text
 * would pass against a name that was merely escaped in the visible header while
 * still splitting the envelope. nodemailer's `jsonTransport` does the same
 * RFC-5322 parsing the real SMTP transport does and exposes the parsed envelope
 * on `info.envelope` - the addresses that actually go on the wire. That is the
 * property under test, so that is what we read.
 */

// Built once, before any spy, so the mock below can delegate to it without
// recursing back through the spied createTransport.
const jsonTransport = nodemailer.createTransport({ jsonTransport: true });

type Options = Parameters<typeof jsonTransport.sendMail>[0];
type Info = Awaited<ReturnType<typeof jsonTransport.sendMail>>;

const SMTP = { smtpHost: 'smtp.example.com', smtpUser: 'u', smtpPass: 'p' };
const TEMPLATE = { subject: 's', html: '<p>hi</p>', text: 'hi' };

/** Send one email and hand back what nodemailer actually built from it. */
async function sendCapturing(recipient: { name: string; email: string }) {
  let info: Info | undefined;
  const spy = jest.spyOn(nodemailer, 'createTransport').mockReturnValue({
    sendMail: async (opts: Options) => (info = await jsonTransport.sendMail(opts)),
  } as unknown as Transporter);
  try {
    await new EmailService(SMTP).sendEmail(recipient, TEMPLATE);
  } finally {
    spy.mockRestore();
  }
  if (!info) throw new Error('sendMail was never called - the fixture sent nothing');
  return {
    envelope: info.envelope as { from: string; to: string[] },
    message: JSON.parse(info.message as string) as { to: Array<{ name: string; address: string }> },
  };
}

describe('email recipient envelope injection (#30)', () => {
  it('a display name cannot smuggle a second recipient into the envelope', async () => {
    const { envelope } = await sendCapturing({
      name: 'Ada <attacker@evil.example>, Bob',
      email: 'victim@example.com',
    });

    // Exactly one envelope recipient, and it is the address the caller passed -
    // not the one hidden in the display name.
    expect(envelope.to).toEqual(['victim@example.com']);
  });

  /**
   * THE CONTROL. The assertion above is "exactly one address", which passes
   * just as well if the recipient never reached the envelope at all - a mock
   * that dropped the mail, or a signature change that lost the recipient, would
   * satisfy it. This proves an ordinary send still carries the intended address
   * AND keeps the display name where it belongs, so the fix did not achieve
   * safety by simply throwing the recipient away.
   */
  it('an ordinary recipient still gets the address and keeps their name', async () => {
    const { envelope, message } = await sendCapturing({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });

    expect(envelope.to).toEqual(['ada@example.com']);
    expect(message.to[0].name).toBe('Ada Lovelace');
    expect(message.to[0].address).toBe('ada@example.com');
  });
});
